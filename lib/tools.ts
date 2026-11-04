import type { Page } from "playwright";
import { PNG } from "pngjs";
import { launchBrowser } from "./browser";
import { DEMO_MODE } from "./demo";
import { assertPublicUrl, guardRequests } from "./url-guard";
import type { CompiledTool, Json, NetworkTool, PixelItem, PixelTool } from "./types";

export class ToolInputError extends Error {}

export function toJsonSchema(tool: CompiledTool) {
  if (tool.kind === "pixel") {
    if (tool.action === "list") {
      return { type: "object", properties: {}, required: [] as string[], additionalProperties: false };
    }
    return {
      type: "object",
      properties: {
        label: {
          type: "string",
          description: `${tool.itemNoun} label, for example ${tool.items[0]?.label ?? "A1"}`,
        },
      },
      required: ["label"],
      additionalProperties: false,
    };
  }
  const properties: Record<string, { type?: string; description?: string }> = {};
  const required: string[] = [];
  for (const param of tool.params.filter((p) => p.exposed)) {
    properties[param.name] = {
      ...(param.type === "json" ? {} : { type: param.type }),
      description: param.description,
    };
    if (param.required) required.push(param.name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

export type ToolResult = { status: number; ok: boolean; result: unknown; rawText: string };

export async function executeTool(
  tool: CompiledTool,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  return tool.kind === "network" ? callNetworkTool(tool, input) : callPixelTool(tool, input);
}

function pick(value: unknown, dotted: string): unknown {
  if (!dotted) return value;
  return dotted.split(".").reduce<unknown>((current, key) => {
    return current && typeof current === "object"
      ? (current as Record<string, unknown>)[key]
      : undefined;
  }, value);
}

function project(value: unknown, fields: string[]): unknown {
  if (Array.isArray(value)) return value.slice(0, 20).map((row) => project(row, fields));
  if (!fields.length || !value || typeof value !== "object") return value;
  return Object.fromEntries(fields.map((field) => [field, pick(value, field) ?? null]));
}

async function callNetworkTool(
  tool: NetworkTool,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const url = new URL(tool.urlTemplate);
  const body: Record<string, Json> = {};
  for (const param of tool.params) {
    const provided = param.exposed ? input[param.name] : undefined;
    const missing = provided === undefined || provided === null || provided === "";
    if (missing && param.exposed && param.required) {
      throw new ToolInputError(`Missing required input: ${param.name}`);
    }
    const value = (missing ? param.value : provided) as Json;
    if (value === undefined || value === null) continue;
    if (param.in === "query") {
      url.searchParams.set(param.name, typeof value === "object" ? JSON.stringify(value) : String(value));
    } else {
      body[param.name] = value;
    }
  }
  const init: RequestInit = {
    method: tool.method,
    headers: { ...tool.headers, "user-agent": "WebMCP-Bridge/0.2" },
    signal: AbortSignal.timeout(20_000),
  };
  if (tool.bodyFormat === "json") init.body = JSON.stringify(body);
  if (tool.bodyFormat === "form") {
    init.body = new URLSearchParams(
      Object.entries(body).map(([k, v]): [string, string] => [k, String(v)]),
    ).toString();
  }
  await assertPublicUrl(url.toString());
  // Hosted tools do not follow redirects, which could lead to an address that was not checked.
  const res = await fetch(url, DEMO_MODE ? { ...init, redirect: "error" } : init);
  const rawText = await res.text();
  let parsed: unknown = rawText;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    /* non-JSON response stays as text */
  }
  return {
    status: res.status,
    ok: res.ok,
    rawText,
    result: res.ok ? project(pick(parsed, tool.resultPath), tool.resultFields) : parsed,
  };
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace("#", "").slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function samplePixel(png: PNG, x: number, y: number): [number, number, number] {
  const i = (Math.round(y) * png.width + Math.round(x)) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}

export function nearestState(hex: string, states: Array<{ name: string; hex: string }>): string {
  const [r, g, b] = hexToRgb(hex);
  let best = "unknown";
  let bestDistance = Infinity;
  for (const state of states) {
    const [sr, sg, sb] = hexToRgb(state.hex);
    const distance = (r - sr) ** 2 + (g - sg) ** 2 + (b - sb) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = state.name;
    }
  }
  return best;
}

export const center = (item: PixelItem) => ({ x: item.x + item.w / 2, y: item.y + item.h / 2 });

async function readStates(page: Page, tool: PixelTool) {
  const png = PNG.sync.read(await page.screenshot());
  return tool.items.map((item) => {
    const { x, y } = center(item);
    const hex = rgbToHex(samplePixel(png, x, y));
    return { label: item.label, hex, state: nearestState(hex, tool.states) };
  });
}

/** Saved demo tools store a path, because the deployed site's address is only known at run time. */
function resolvePageUrl(pageUrl: string): string {
  if (!pageUrl.startsWith("/")) return pageUrl;
  const base =
    process.env.DEMO_BASE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "");
  if (!base) throw new Error("No base URL is configured for this saved tool.");
  return `${base}${pageUrl}`;
}

/** Runs on pixels with no model call: open the page, read colours, click coordinates. */
async function callPixelTool(tool: PixelTool, input: Record<string, unknown>): Promise<ToolResult> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: tool.viewport });
    await guardRequests(page);
    await page.goto(resolvePageUrl(tool.pageUrl), { waitUntil: "load", timeout: 20_000 });
    await page.waitForTimeout(200);
    const before = await readStates(page, tool);
    if (tool.action === "list") {
      const available = before.filter((s) => s.state === tool.availableState).map((s) => s.label);
      const result = { available, availableCount: available.length, total: before.length };
      return { status: 200, ok: true, result, rawText: JSON.stringify(result) };
    }
    const label = String(input.label ?? "").toUpperCase();
    const item = tool.items.find((i) => i.label.toUpperCase() === label);
    if (!item) throw new ToolInputError(`Unknown ${tool.itemNoun}: ${label}`);
    const current = before.find((s) => s.label === item.label);
    if (current?.state !== tool.availableState) {
      const result = { selected: false, label: item.label, reason: `${tool.itemNoun} is ${current?.state}` };
      return { status: 200, ok: true, result, rawText: JSON.stringify(result) };
    }
    const { x, y } = center(item);
    await page.mouse.click(x, y);
    await page.waitForTimeout(150);
    const after = (await readStates(page, tool)).find((s) => s.label === item.label);
    const changed = after?.hex !== current.hex;
    const result = {
      selected: changed,
      label: item.label,
      note: changed
        ? "Selection confirmed from the page's pixels. Nothing was booked or paid for."
        : "The click did not change the page.",
    };
    return { status: 200, ok: changed, result, rawText: JSON.stringify(result) };
  } finally {
    await browser.close().catch(() => {});
  }
}
