/**
 * PAID: compiled tools vs Spark clicking screenshots on the same tasks.
 * At most 5 tasks x 15 steps = 75 Spark requests. Refuses to run without --confirm.
 * Correct answers come from the page itself, not from either agent.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import type { ChatTool } from "../lib/meta";
import type { CompiledTool } from "../lib/types";

if (!process.argv.includes("--confirm")) {
  console.error("This spends real Meta API credit. Re-run with --confirm.");
  process.exit(1);
}

const BASE = process.env.BENCH_ORIGIN ?? "http://localhost:3000";
const SEATS = `${BASE}/demo/seats.html`;
const MAX_STEPS = 15;

const fn = (name: string, description: string, properties: object, required: string[]): ChatTool => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
});
const AGENT_TOOLS = [
  fn("click_xy", "Click at pixel coordinates in the screenshot.", { x: { type: "number" }, y: { type: "number" } }, ["x", "y"]),
  fn("type_text", "Type text at the current focus, optionally pressing Enter.", { text: { type: "string" }, enter: { type: "boolean" } }, ["text", "enter"]),
  fn("scroll", "Scroll down one screen.", {}, []),
  fn("finish", "Give your final answer.", { answer: { type: "string" } }, ["answer"]),
];

async function screenshotAgent(page: Page, task: string) {
  const { sparkChat } = await import("../lib/meta");
  const history: string[] = [];
  const started = Date.now();
  let usd = 0;
  for (let step = 1; step <= MAX_STEPS; step++) {
    const shot = await page.screenshot({ type: "jpeg", quality: 60 });
    const { message, costUsd } = await sparkChat({
      purpose: "benchmark-baseline",
      tools: AGENT_TOOLS,
      messages: [
        { role: "system", content: "You operate a browser by looking at screenshots of a 1280x800 window. Call exactly one tool each turn. Call finish when you have the answer." },
        { role: "user", content: [
          { type: "text", text: `Task: ${task}\nActions so far:\n${history.join("\n") || "(none)"}` },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${shot.toString("base64")}` } },
        ] },
      ],
    });
    usd += costUsd;
    const call = message.tool_calls?.[0];
    if (!call) {
      // Meta's docs say a reply may be plain text, so a text reply counts as the agent's answer.
      console.log(`   step ${step}: answered in text: ${String(message.content).slice(0, 120)}`);
      return { answer: String(message.content ?? ""), steps: step, usd, seconds: (Date.now() - started) / 1000 };
    }
    const args = JSON.parse(call.function.arguments || "{}") as Record<string, never>;
    if (call.function.name === "finish") {
      return { answer: String(args.answer), steps: step, usd, seconds: (Date.now() - started) / 1000 };
    }
    if (call.function.name === "click_xy") await page.mouse.click(args.x, args.y);
    if (call.function.name === "type_text") {
      await page.keyboard.type(String(args.text));
      if (args.enter) await page.keyboard.press("Enter");
    }
    if (call.function.name === "scroll") await page.mouse.wheel(0, 700);
    await page.waitForTimeout(800);
    history.push(`${step}. ${call.function.name} ${call.function.arguments}`);
    console.log(`   step ${step}: ${call.function.name} ${call.function.arguments} -> ${page.url()}${message.content ? ` | said: ${String(message.content).slice(0, 120)}` : ""}`);
    if (process.env.BENCH_SHOTS) await page.screenshot({ path: `${process.env.BENCH_SHOTS}/agent-step-${step}.png` });
  }
  return { answer: "", steps: MAX_STEPS, usd, seconds: (Date.now() - started) / 1000 };
}

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

async function main() {
  const { loadSite } = await import("../lib/store");
  const { executeTool } = await import("../lib/tools");
  const hn = await loadSite("hn-algolia-com");
  const seats = await loadSite("localhost-demo-seats");
  if (!hn?.tools.length || !seats?.tools.length) {
    throw new Error("Compile Hacker News and the seat map in the UI first.");
  }
  const hnTool = hn.tools[0];
  if (hnTool.kind !== "network") throw new Error("Expected a network tool for Hacker News.");
  const inputName = hnTool.params.find((p) => p.exposed)?.name;
  if (!inputName) throw new Error("The Hacker News tool has no input.");
  const listTool = seats.tools.find((t) => t.kind === "pixel" && t.action === "list");
  const clickTool = seats.tools.find((t) => t.kind === "pixel" && t.action === "click");
  if (!listTool || !clickTool) throw new Error("Seat tools are missing.");

  const browser = await chromium.launch();
  const rows = [];
  const open = async (url: string) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);
    return page;
  };
  const timed = async (tool: CompiledTool, input: Record<string, unknown>) => {
    const started = Date.now();
    const res = await executeTool(tool, input);
    return { res, seconds: (Date.now() - started) / 1000 };
  };

  const queries = process.env.BENCH_ONLY ? [process.env.BENCH_ONLY] : ["rust", "postgres", "webassembly"];
  for (const query of queries) {
    const truthPage = await open(`https://hn.algolia.com/?q=${query}`);
    const truthTitle = normalize((await truthPage.locator(".Story_title a").first().innerText()) ?? "");
    await truthPage.close();
    const compiled = await timed(hnTool, { [inputName]: query });
    const compiledOk = normalize(JSON.stringify(compiled.res.result)).includes(truthTitle);
    const page = await open("https://hn.algolia.com/");
    const baseline = await screenshotAgent(page, `Search this site for "${query}" and report the title of the top result.`);
    await page.close();
    rows.push({
      task: `Top Hacker News story for "${query}"`,
      compiled: { ok: compiledOk, seconds: compiled.seconds, usd: 0 },
      baseline: { ok: normalize(baseline.answer).includes(truthTitle), seconds: baseline.seconds, usd: baseline.usd, steps: baseline.steps },
    });
    console.log(JSON.stringify(rows.at(-1)));
  }
  if (process.env.BENCH_ONLY) {
    await browser.close();
    return;
  }

  const truthPage = await open(SEATS);
  const truth = (await truthPage.evaluate("window.__seatTruth()")) as Array<{ label: string; state: string }>;
  await truthPage.close();
  const free = truth.filter((s) => s.state === "free").map((s) => s.label).sort();
  const seatKey = JSON.stringify(free);

  const compiledList = await timed(listTool, {});
  const listPage = await open(SEATS);
  const listBaseline = await screenshotAgent(listPage, "List the label of every free (green) seat. Rows are lettered A to F from the top and columns are numbered from 1 on the left. Answer with labels such as A1, A2.");
  await listPage.close();
  rows.push({
    task: "List every free seat on a canvas map",
    compiled: {
      ok: JSON.stringify([...(compiledList.res.result as { available: string[] }).available].sort()) === seatKey,
      seconds: compiledList.seconds,
      usd: 0,
    },
    baseline: {
      ok: JSON.stringify([...new Set(listBaseline.answer.toUpperCase().match(/\b[A-F]\d{1,2}\b/g) ?? [])].sort()) === seatKey,
      seconds: listBaseline.seconds,
      usd: listBaseline.usd,
      steps: listBaseline.steps,
    },
  });
  console.log(JSON.stringify(rows.at(-1)));

  const target = free[Math.floor(free.length / 2)];
  const compiledClick = await timed(clickTool, { label: target });
  const clickPage = await open(SEATS);
  const clickBaseline = await screenshotAgent(clickPage, `Select seat ${target}. Rows are lettered A to F from the top and columns are numbered from 1 on the left. Then finish.`);
  const after = (await clickPage.evaluate("window.__seatTruth()")) as Array<{ label: string; state: string }>;
  await clickPage.close();
  rows.push({
    task: `Select seat ${target} on a canvas map`,
    compiled: { ok: (compiledClick.res.result as { selected: boolean }).selected, seconds: compiledClick.seconds, usd: 0 },
    baseline: {
      ok: after.filter((s) => s.state === "selected").map((s) => s.label).join() === target,
      seconds: clickBaseline.seconds,
      usd: clickBaseline.usd,
      steps: clickBaseline.steps,
    },
  });
  console.log(JSON.stringify(rows.at(-1)));
  await browser.close();

  fs.writeFileSync(
    path.join(process.cwd(), ".webmcp-data", "benchmark.result"),
    JSON.stringify({ runAt: new Date().toISOString(), rows }, null, 2),
  );
  console.log("Saved benchmark results.");
}

main().catch((err) => {
  console.error(String(err.message ?? err));
  process.exit(1);
});
