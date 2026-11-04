import { launchBrowser } from "./browser";
import { authorTools, findCandidates, requestText } from "./author";
import { explore } from "./explorer";
import { compilePixelTools, LARGE_CANVAS_SCRIPT } from "./pixel";
import { SCHEMA_VERSION } from "./types";
import { assertPublicUrl, guardRequests } from "./url-guard";
import type { CapturedRequest, CompileRecord, CompiledTool, ExploreStep } from "./types";

const RESPONSE_SAMPLE_BYTES = 4000;
const MAX_STEPS = 12;

export function toSiteId(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`
    .replace(/\.html?$/i, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

export async function compile(
  url: string,
  goal: string,
  log: (line: string) => void,
  onStep: (step: ExploreStep) => void = () => {},
): Promise<CompileRecord> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs can be compiled.");
  }
  await assertPublicUrl(url);
  const steps: CompileRecord["steps"] = [];
  const captured: CapturedRequest[] = [];
  let tools: CompiledTool[] = [];
  let costUsd = 0;

  log("Opening the site in a real browser");
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await guardRequests(context);
    const page = await context.newPage();
    page.on("response", async (resp) => {
      const req = resp.request();
      const kind = req.resourceType();
      if (kind !== "xhr" && kind !== "fetch") return;
      const responseContentType = resp.headers()["content-type"] ?? "";
      let responseBodySample = "";
      try {
        responseBodySample = (await resp.body()).subarray(0, RESPONSE_SAMPLE_BYTES).toString("utf8");
      } catch {
        /* the body may no longer be available after navigation */
      }
      const headers = { ...req.headers() };
      delete headers.cookie;
      delete headers.authorization;
      captured.push({
        url: resp.url(),
        method: req.method(),
        postData: req.postData(),
        requestContentType: headers["content-type"] ?? "",
        headers,
        status: resp.status(),
        responseContentType,
        responseBodySample,
        durationMs: 0,
      });
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

    if (await page.evaluate(LARGE_CANVAS_SCRIPT)) {
      log("The main content is a canvas, so this site uses the pixel path");
      const pixel = await compilePixelTools({ page, url, goal, log });
      tools = pixel.tools;
      costUsd += pixel.costUsd;
    } else {
      log("Spark is exploring the site toward your goal");
      const result = await explore({
        page,
        goal,
        maxSteps: MAX_STEPS,
        isDone: (typed) => {
          const distinct = [...new Set(typed)];
          return (
            distinct.length >= 2 &&
            distinct.every((text) =>
              captured.some((r) => r.responseContentType.includes("json") && requestText(r).includes(text)),
            )
          );
        },
        log,
        onStep: (step) => {
          const { screenshot: _screenshot, ...rest } = step;
          steps.push(rest);
          onStep(step);
        },
      });
      costUsd += result.costUsd;
      log(`Exploration ${result.reached ? "reached the goal" : "did not reach the goal"}: ${result.summary}`);

      const candidates = findCandidates(captured, result.typed);
      log(`Captured ${captured.length} request(s), ${candidates.length} possible tool endpoint(s)`);
      if (candidates.length > 0) {
        log("Spark is writing tools and tests. Plain code decides which ones ship");
        const authored = await authorTools({ goal, candidates, log });
        tools = authored.tools;
        costUsd += authored.costUsd;
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  log(`Done: ${tools.length} verified tool(s), $${costUsd.toFixed(4)} in Meta API usage`);
  return {
    schemaVersion: SCHEMA_VERSION,
    siteId: toSiteId(url),
    url,
    goal,
    createdAt: new Date().toISOString(),
    logs: [],
    steps,
    costUsd,
    tools,
  };
}
