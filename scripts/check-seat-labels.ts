/** Free: compares the compiled seat tool's labels and positions with the page's answer key. */
import { chromium } from "playwright";
async function main() {
  const { loadSite } = await import("../lib/store");
  const site = await loadSite("localhost-demo-seats");
  const tool = site?.tools.find((t) => t.kind === "pixel");
  if (!tool || tool.kind !== "pixel") throw new Error("Compile the seat map first.");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: tool.viewport });
  await page.goto(tool.pageUrl);
  const truth = (await page.evaluate("window.__seatTruth()")) as Array<{ label: string; x1: number; y1: number; x2: number; y2: number }>;
  await browser.close();
  let right = 0;
  for (const item of tool.items) {
    const seat = truth.find((t) => t.label === item.label);
    const cx = item.x + item.w / 2, cy = item.y + item.h / 2;
    if (seat && cx >= seat.x1 && cx <= seat.x2 && cy >= seat.y1 && cy <= seat.y2) right++;
    else console.log(`WRONG ${item.label} at ${cx},${cy}`);
  }
  console.log(`${right}/${truth.length} seats correctly labelled (${tool.items.length} found)`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
