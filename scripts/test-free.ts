/** End-to-end tests against the local mock. Makes no real Meta API calls and costs nothing. */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium } from "playwright";
import { startMock } from "./mock-meta";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "webmcp-free-"));
process.env.META_API_BASE = "http://127.0.0.1:4010";
process.env.MODEL_API_KEY = "mock-key";
process.env.WEBMCP_DATA_DIR = tmp;
process.env.META_USAGE_FILE = path.join(tmp, "usage.jsonl");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

const SEARCH_PAGE = `<!doctype html><title>Demo shop</title><h1>Demo search</h1>
<button onclick="document.title='bought'">Buy now</button>
<input id="q" placeholder="Search" type="search"><input type="password" name="pw"><ul id="out"></ul>
<script>
fetch('/metrics',{method:'POST'});
document.getElementById('q').addEventListener('keydown',async(e)=>{ if(e.key!=='Enter')return;
  const r=await fetch('/api/search?api_key=pk_demo&noop=1&q='+encodeURIComponent(e.target.value));
  const j=await r.json(); document.getElementById('out').innerHTML=j.hits.map(h=>'<li>'+h.title+'</li>').join('');});
</script>`;

const site = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/api/search") {
    res.setHeader("content-type", "application/json");
    if (url.searchParams.get("api_key") !== "pk_demo") {
      res.statusCode = 401;
      return res.end("{}");
    }
    const q = url.searchParams.get("q") ?? "";
    return res.end(JSON.stringify({ total: 2, hits: [{ title: `${q} one`, secretField: "x" }, { title: `${q} two`, secretField: "x" }] }));
  }
  if (url.pathname === "/metrics") {
    res.setHeader("content-type", "application/json");
    return res.end("{}");
  }
  if (url.pathname === "/seats.html") {
    res.setHeader("content-type", "text/html");
    return res.end(fs.readFileSync("public/demo/seats.html"));
  }
  res.setHeader("content-type", "text/html");
  res.end(SEARCH_PAGE);
});

async function main() {
  const mock = await startMock(4010);
  await new Promise<void>((r) => site.listen(4011, "127.0.0.1", () => r()));

  const { parseSamOutput, sparkChat, BudgetError, usageSummary } = await import("../lib/meta");
  const { compile } = await import("../lib/compiler");
  const { saveSite } = await import("../lib/store");
  const { executeTool, toJsonSchema } = await import("../lib/tools");
  const { runChat } = await import("../lib/chat");
  const mcpRoute = await import("../app/api/mcp/[siteId]/route");
  const callRoute = await import("../app/api/sites/[siteId]/call/route");
  const webmcpRoute = await import("../app/api/webmcp/[siteId]/route");

  // SAM parsing, using the format in Meta's docs, with a mask payload containing tricky characters.
  const boxes = parseSamOutput("<0f>0, <|box;x1=1;y1=2;x2=3;y2=4;w=9;h=9;c=0.9|>, <|mask;x=0;y=0;data=2,2,~a|b!|>");
  check("SAM boxes parse from the documented format", boxes.length === 1 && boxes[0].x2 === 3);

  const { recoverToolCalls } = await import("../lib/meta");
  const leaked = '<atem:function_calls><atem:invoke name="default.finish"><atem:parameter name="answer">Top title</atem:parameter><atem:parameter name="n">3</atem:parameter></atem:invoke></atem:function_calls>';
  const recovered = recoverToolCalls(leaked, ["finish"]);
  check("tool call written as text is recovered", recovered[0]?.function.name === "finish" && JSON.parse(recovered[0].function.arguments).answer === "Top title" && JSON.parse(recovered[0].function.arguments).n === 3);
  check("recovered calls are limited to offered tools", recoverToolCalls(leaked, ["click"]).length === 0);

  const { isPrivateAddress } = await import("../lib/url-guard");
  check("private addresses are recognised", ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.0.1", "172.16.0.9", "::1", "fd00::1", "::ffff:10.0.0.1"].every(isPrivateAddress));
  check("public addresses are allowed", !["8.8.8.8", "172.32.0.1", "2606:4700::1"].some(isPrivateAddress));

  // A missed item must not shift the labels after it.
  const { labelGrid, mergeBoxes } = await import("../lib/pixel");
  const cell = (r: number, c: number) => ({ x1: c * 100, y1: r * 100, x2: c * 100 + 50, y2: r * 100 + 50 });
  const partial = [cell(0, 0), cell(0, 2), cell(1, 0), cell(1, 1), cell(1, 2)];
  const grid = labelGrid(partial);
  check("missing item leaves other labels unchanged", grid.items.find((i) => i.x === 200 && i.y === 0)?.label === "A3");
  check("grid size counts the missing position", grid.rows * grid.cols === 6 && grid.items.length === 5);
  check("second prompt fills gaps without duplicates", mergeBoxes(partial, [cell(0, 1), cell(0, 2)]).length === 6);

  // Network path.
  const logs: string[] = [];
  const steps: Array<{ action: string; outcome: string }> = [];
  const searchRecord = await compile("http://127.0.0.1:4011/", "search items", (l) => logs.push(l), (s) => steps.push(s));
  await saveSite(searchRecord);
  const names = searchRecord.tools.map((t) => t.name);
  console.log(logs.map((l) => `      ${l}`).join("\n"));
  check("explorer ran the search twice", steps.filter((s) => s.action === "type_text").length === 2);
  check("code blocked the Buy button", steps.some((s) => s.outcome.startsWith("blocked")));
  check("good tool shipped", names.includes("search_items"), names.join(", "));
  check("non-read-only tool rejected", !names.includes("write_item"));
  check("tool whose input changes nothing rejected", !names.includes("ignored_input"));
  const tool = searchRecord.tools.find((t) => t.name === "search_items");
  if (!tool || tool.kind !== "network") throw new Error("search_items missing");
  const schema = toJsonSchema(tool) as { properties: Record<string, unknown> };
  check("API key hidden from agents", !("api_key" in schema.properties), Object.keys(schema.properties).join(","));
  check("only the search input is exposed", Object.keys(schema.properties).join() === "q");
  const called = await executeTool(tool, { q: "golang" });
  check("tool call uses new input and fixed key", JSON.stringify(called.result).includes("golang one"));
  check("results reduced to chosen fields", !JSON.stringify(called.result).includes("secretField"));
  let missing = false;
  await executeTool(tool, {}).catch(() => (missing = true));
  check("missing required input is refused", missing);

  // Pixel path.
  const seatsUrl = "http://127.0.0.1:4011/seats.html";
  const seatLogs: string[] = [];
  const seatRecord = await compile(seatsUrl, "find free seats and select one", (l) => seatLogs.push(l));
  await saveSite(seatRecord);
  check("canvas page took the pixel path", seatLogs.some((l) => l.includes("pixel path")));
  check("two pixel tools shipped", seatRecord.tools.length === 2, seatRecord.tools.map((t) => t.name).join(", "));
  const listTool = seatRecord.tools.find((t) => t.kind === "pixel" && t.action === "list");
  const clickTool = seatRecord.tools.find((t) => t.kind === "pixel" && t.action === "click");
  if (!listTool || !clickTool) throw new Error("pixel tools missing");
  check("each tool keeps its own test results", listTool.tests.length === 1 && clickTool.tests.length === 1);
  const browser = await chromium.launch();
  const truthPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await truthPage.goto(seatsUrl);
  const truth = (await truthPage.evaluate("window.__seatTruth()")) as Array<{ label: string; state: string; x1: number; y1: number }>;
  const expected = truth.filter((s) => s.state === "free").map((s) => s.label).sort();
  const listed = (await executeTool(listTool, {})).result as { available: string[] };
  check("free seats match the page's answer key", JSON.stringify([...listed.available].sort()) === JSON.stringify(expected), `${listed.available.length} free`);
  const picked = (await executeTool(clickTool, { label: expected[0] })).result as { selected: boolean };
  check("selecting a free seat changes the page", picked.selected === true);
  const takenLabel = truth.find((s) => s.state === "taken")!.label;
  const refused = (await executeTool(clickTool, { label: takenLabel })).result as { selected: boolean };
  check("selecting a taken seat is refused", refused.selected === false, takenLabel);

  // MCP and WebMCP over real HTTP, with the same route handlers Next serves.
  const api = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url ?? "/", "http://127.0.0.1:4012");
    const request = new Request(url, { method: req.method, headers: req.headers as HeadersInit, body: raw || undefined });
    const match = url.pathname.match(/^\/api\/(mcp|webmcp|sites)\/([^/]+)/);
    const params = Promise.resolve({ siteId: match?.[2] ?? "" });
    let response: Response;
    if (req.method === "OPTIONS") response = await callRoute.OPTIONS();
    else if (match?.[1] === "mcp") response = req.method === "POST" ? await mcpRoute.POST(request, { params }) : await mcpRoute.GET();
    else if (match?.[1] === "webmcp") response = await webmcpRoute.GET(request, { params });
    else response = await callRoute.POST(request, { params });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  });
  await new Promise<void>((r) => api.listen(4012, "127.0.0.1", () => r()));
  const endpoint = `http://127.0.0.1:4012/api/mcp/${searchRecord.siteId}`;
  const client = new Client({ name: "free-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
  const listedTools = await client.listTools();
  check("official MCP client lists tools", listedTools.tools.some((t) => t.name === "search_items"));
  const mcpCall = await client.callTool({ name: "search_items", arguments: { q: "zig" } });
  check("official MCP client calls a tool", JSON.stringify(mcpCall.content).includes("zig one"));
  await client.close();

  const page = await browser.newPage();
  await page.addInitScript(() => {
    (navigator as unknown as { modelContext: unknown }).modelContext = {
      tools: {} as Record<string, unknown>,
      registerTool(tool: { name: string }) {
        (this as unknown as { tools: Record<string, unknown> }).tools[tool.name] = tool;
      },
    };
  });
  await page.goto("http://127.0.0.1:4011/");
  await page.addScriptTag({ url: `http://127.0.0.1:4012/api/webmcp/${searchRecord.siteId}` });
  const webmcp = (await page.evaluate(
    `navigator.modelContext.tools.search_items.execute({ q: 'elixir' })`,
  )) as { content: Array<{ text: string }> };
  check("WebMCP script works from another origin", webmcp.content[0].text.includes("elixir one"));
  await browser.close();

  // Chat goes through MCP.
  const events: Array<{ type: string; text?: string }> = [];
  await runChat({ endpoint, history: [{ role: "user", content: "find rust" }], emit: (e) => events.push(e) });
  check("chat calls a tool through MCP", events.some((e) => e.type === "tool_call"));
  check("chat answers from the tool result", events.some((e) => e.type === "text" && e.text?.includes("rust one")));

  // Ledger and spending stop.
  const summary = await usageSummary();
  check("every model call is logged with a cost", summary.requests > 0 && summary.spentUsd > 0, `${summary.requests} mock requests`);
  fs.appendFileSync(process.env.META_USAGE_FILE!, JSON.stringify({ costUsd: 999 }) + "\n");
  let stopped = false;
  await sparkChat({ purpose: "test", messages: [{ role: "user", content: "hi" }] }).catch((e) => (stopped = e instanceof BudgetError));
  check("spending stop blocks further calls", stopped);

  mock.close();
  site.close();
  api.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : "\nAll free tests passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
