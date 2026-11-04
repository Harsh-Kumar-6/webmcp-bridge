import type { Page } from "playwright";
import { PNG } from "pngjs";
import { z } from "zod";
import { samSegment, sparkJson, type SamBox } from "./meta";
import { center, executeTool, nearestState, rgbToHex, samplePixel } from "./tools";
import type { PixelItem, PixelTool, ToolTest } from "./types";

export const LARGE_CANVAS_SCRIPT = `(() => {
  const area = innerWidth * innerHeight;
  return [...document.querySelectorAll('canvas')].some((c) => {
    const b = c.getBoundingClientRect();
    return b.width * b.height >= area * 0.25;
  });
})()`;

const PlanSchema = z.object({
  samPrompts: z.array(z.string()),
  itemNoun: z.string(),
  states: z.array(z.object({ name: z.string(), hex: z.string() })),
  availableState: z.string(),
  toolSubject: z.string(),
  description: z.string(),
});

const planSchema = (() => {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(PlanSchema) as Record<string, unknown>;
  return schema;
})();

/** Keeps same-sized boxes, so a legend swatch or a large background box is dropped. */
export function filterBoxes(boxes: SamBox[]): SamBox[] {
  const area = (b: SamBox) => (b.x2 - b.x1) * (b.y2 - b.y1);
  const sorted = boxes.map(area).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return boxes.filter((b) => area(b) >= median * 0.5 && area(b) <= median * 1.6);
}

const centreX = (b: SamBox) => (b.x1 + b.x2) / 2;
const centreY = (b: SamBox) => (b.y1 + b.y2) / 2;

/** Groups values into bands, so a missing item cannot shift the items after it. */
function bands(values: number[], tolerance: number): number[] {
  const out: number[][] = [];
  for (const value of [...values].sort((a, b) => a - b)) {
    const band = out[out.length - 1];
    if (band && value - band[band.length - 1] <= tolerance) band.push(value);
    else out.push([value]);
  }
  return out.map((band) => band.reduce((sum, v) => sum + v, 0) / band.length);
}

const nearestIndex = (value: number, centres: number[]) =>
  centres.reduce((best, c, i) => (Math.abs(c - value) < Math.abs(centres[best] - value) ? i : best), 0);

/** Names boxes by grid position: rows A, B, C and columns 1, 2, 3. */
export function labelGrid(boxes: SamBox[]): { items: PixelItem[]; rows: number; cols: number } {
  if (boxes.length === 0) return { items: [], rows: 0, cols: 0 };
  const size = Math.min(...boxes.map((b) => Math.min(b.x2 - b.x1, b.y2 - b.y1)));
  const rows = bands(boxes.map(centreY), size / 2);
  const cols = bands(boxes.map(centreX), size / 2);
  const items = boxes
    .map((b) => {
      const r = nearestIndex(centreY(b), rows);
      const c = nearestIndex(centreX(b), cols);
      return { r, c, label: `${String.fromCharCode(65 + r)}${c + 1}`, x: b.x1, y: b.y1, w: b.x2 - b.x1, h: b.y2 - b.y1 };
    })
    .sort((a, b) => a.r - b.r || a.c - b.c)
    .map(({ r: _r, c: _c, ...item }) => item);
  return { items, rows: rows.length, cols: cols.length };
}

/** Adds boxes from a new prompt, ignoring any that overlap a box already found. */
export function mergeBoxes(existing: SamBox[], incoming: SamBox[]): SamBox[] {
  const merged = [...existing];
  for (const box of incoming) {
    const seen = merged.some(
      (b) => centreX(box) >= b.x1 && centreX(box) <= b.x2 && centreY(box) >= b.y1 && centreY(box) <= b.y2,
    );
    if (!seen) merged.push(box);
  }
  return merged;
}

export async function compilePixelTools(opts: {
  page: Page;
  url: string;
  goal: string;
  log: (line: string) => void;
}): Promise<{ tools: PixelTool[]; costUsd: number }> {
  const { page, url, goal, log } = opts;
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  const shot = await page.screenshot();
  const dataUrl = `data:image/png;base64,${shot.toString("base64")}`;

  log("  Spark is reading the canvas: what the items are and what each colour means");
  const { data, costUsd: planCost } = await sparkJson<z.infer<typeof PlanSchema>>({
    purpose: "pixel-plan",
    schema: { name: "pixel_plan", schema: planSchema },
    messages: [
      {
        role: "system",
        content: `This page draws its controls only as pixels. Plan how to find and read them.
samPrompts: two or three short noun phrases for a segmentation model, best first, each matching every copy of one repeated control. Describe what it looks like, such as "seat" then "rounded square".
itemNoun: the singular name of that control.
states: every state in the legend, with its fill colour as hex.
availableState: the state name that means an agent can act on it.
toolSubject: plural snake_case subject, such as seats.
description: one sentence on what this page offers.`,
      },
      {
        role: "user",
        content: [
          { type: "text", text: `Goal: ${goal}` },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  });
  const plan = PlanSchema.parse(data);

  let costUsd = planCost;
  let found: SamBox[] = [];
  let items: PixelItem[] = [];
  const prompts = [...new Set([...plan.samPrompts.slice(0, 3), plan.itemNoun.toLowerCase()])];
  for (const phrase of prompts) {
    log(`  SAM 3.1 is segmenting "${phrase}"`);
    const { boxes, costUsd: samCost } = await samSegment({
      purpose: "pixel-segment",
      phrase,
      imageDataUrl: dataUrl,
    });
    costUsd += samCost;
    found = mergeBoxes(found, boxes);
    const grid = labelGrid(filterBoxes(found));
    items = grid.items;
    log(`  ${boxes.length} region(s) for this prompt. Grid so far: ${items.length} of ${grid.rows * grid.cols} positions`);
    if (items.length >= 2 && items.length === grid.rows * grid.cols) break;
  }
  if (items.length < 2) return { tools: [], costUsd };

  // Spark's hex values are estimates, so states are calibrated to colours measured on the page.
  const png = PNG.sync.read(shot);
  const measured = new Map<string, string>();
  for (const item of items) {
    const { x, y } = center(item);
    const hex = rgbToHex(samplePixel(png, x, y));
    const state = nearestState(hex, plan.states);
    if (!measured.has(state)) measured.set(state, hex);
  }
  const states = plan.states.map((s) => ({ name: s.name, hex: measured.get(s.name) ?? s.hex }));
  if (!measured.has(plan.availableState)) {
    log(`  No item matched the "${plan.availableState}" colour, so no tools were shipped`);
    return { tools: [], costUsd };
  }

  const subject = plan.toolSubject.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  const noun = plan.itemNoun.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  const shared = {
    kind: "pixel" as const,
    pageUrl: url,
    viewport,
    itemNoun: plan.itemNoun,
    items,
    states,
    availableState: plan.availableState,
    lastVerified: new Date().toISOString(),
  };
  const list: PixelTool = {
    ...shared,
    tests: [] as ToolTest[],
    action: "list",
    name: `get_available_${subject}`,
    description: `List every ${plan.availableState} ${plan.itemNoun}. ${plan.description}`,
  };
  const click: PixelTool = {
    ...shared,
    tests: [] as ToolTest[],
    action: "click",
    name: `select_${noun}`,
    description: `Select one ${plan.availableState} ${plan.itemNoun} on the page and confirm it changed. This does not book or pay for anything.`,
  };

  // Tests run in plain code against the real page, with no model involved.
  let started = Date.now();
  const listed = await executeTool(list, {});
  const result = listed.result as { available: string[]; total: number };
  list.tests.push({
    label: "reads every item and finds available ones",
    input: {},
    ok: result.total === items.length && result.available.length > 0,
    note: `${result.available.length} of ${result.total} available`,
    durationMs: Date.now() - started,
  });
  const first = result.available[0];
  started = Date.now();
  const selected = first ? await executeTool(click, { label: first }) : null;
  click.tests.push({
    label: "clicking an available item changes its pixels",
    input: { label: first ?? "" },
    ok: selected?.ok === true,
    note: selected?.ok ? `${first} changed colour after the click` : "no change after the click",
    durationMs: Date.now() - started,
  });
  const tools = [list, click].filter((t) => t.tests.every((x) => x.ok));
  log(`  shipped ${tools.length} of 2 pixel tools`);
  return { tools, costUsd };
}
