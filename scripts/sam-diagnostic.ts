/** PAID: 6 SAM 3.1 calls at $0.0025 each. Compares results with the page's real seat positions. */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

if (!process.argv.includes("--confirm")) {
  console.error("This spends real Meta API credit. Re-run with --confirm.");
  process.exit(1);
}
const OUT = process.env.DIAG_OUT ?? ".";
const RUNS = [
  ["squares", "?style=squares", ["seat", "green square", "rounded square"]],
  ["chairs", "", ["seat", "chair", "green seat"]],
] as const;

async function main() {
  const { samSegment } = await import("../lib/meta");
  const browser = await chromium.launch();
  for (const [style, query, prompts] of RUNS) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`file://${path.resolve("public/demo/seats.html")}${query}`);
    const png = await page.screenshot({ path: path.join(OUT, `diag-${style}.png`) });
    const truth = (await page.evaluate("window.__seatTruth()")) as Array<{ x1: number; y1: number; x2: number; y2: number; state: string }>;
    await page.close();
    for (const prompt of prompts) {
      const res = await samSegment({ purpose: "sam-diagnostic", phrase: prompt, imageDataUrl: `data:image/png;base64,${png.toString("base64")}` });
      const name = `diag-${style}-${prompt.replace(/\s+/g, "-")}`;
      fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(res.rawResponse, null, 1));
      // A seat counts as found when a box's centre lands on it.
      const found = truth.filter((t) => res.boxes.some((b) => {
        const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
        return cx >= t.x1 && cx <= t.x2 && cy >= t.y1 && cy <= t.y2;
      }));
      console.log(`${style.padEnd(8)} "${prompt}": ${res.boxes.length} boxes, ${found.length}/${truth.length} seats matched (free ${found.filter((t) => t.state === "free").length}/${truth.filter((t) => t.state === "free").length})`);
      console.log(`   raw text ${res.rawText.length} chars: ${res.rawText.slice(0, 160).replace(/\n/g, " ")}`);
      if (!res.rawText) console.log(`   raw response: ${JSON.stringify(res.rawResponse).slice(0, 500)}`);
    }
  }
  await browser.close();
}
main().catch((err) => { console.error(String(err.message ?? err)); process.exit(1); });
