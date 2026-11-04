/** Drives the real UI in a browser against the mock Meta API. Costs nothing. */
import { chromium } from "playwright";
const BASE = process.env.UI_BASE ?? "http://127.0.0.1:3100";
const OUT = process.env.UI_OUT ?? ".";
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${OUT}/ui-1-empty.png`, fullPage: true });

  await page.getByRole("button", { name: "Canvas seat map" }).click();
  await page.getByRole("button", { name: "Compile", exact: true }).click();
  await page.getByRole("heading", { name: /Verified tools/ }).waitFor({ timeout: 90000 });
  check("seat map compiles in the UI", await page.getByText("get_available_seats").isVisible());
  await page.getByRole("button", { name: "Call without a model" }).first().click();
  await page.getByText(/Answered in \d+ ms/).first().waitFor({ timeout: 30000 });
  check("direct tool call shows a readable result", await page.getByText(/\d+ of \d+ available/).first().isVisible());
  await page.getByRole("button", { name: "Which seats are available?" }).click();
  await page.getByText(/Mock answer from tool/).waitFor({ timeout: 30000 });
  check("chat shows a tool call and an answer", await page.getByText(/get_available_seats\(/).isVisible());
  await page.screenshot({ path: `${OUT}/ui-2-seats.png`, fullPage: true });

  await page.getByRole("button", { name: "Hacker News" }).click();
  await page.getByRole("button", { name: "Compile", exact: true }).click();
  await page.locator("img[alt='Latest page the explorer saw']").waitFor({ timeout: 60000 });
  check("explorer screenshot appears live", true);
  await page.screenshot({ path: `${OUT}/ui-3-exploring.png`, fullPage: true });
  await page.getByRole("heading", { name: /Verified tools/ }).waitFor({ timeout: 120000 });
  await page.getByText(/^Done:/).waitFor({ timeout: 120000 });
  const trace = await page.locator(".h-56[aria-live=polite]").first().innerText();
  console.log(trace.split("\n").map((l) => `      ${l}`).join("\n"));
  await page.screenshot({ path: `${OUT}/ui-4-hn.png`, fullPage: true });

  await page.getByRole("button", { name: "Call without a model" }).first().click();
  await page.locator("table").first().waitFor({ timeout: 30000 });
  check("search results show as a table", (await page.locator("table").first().innerText()).length > 20);
  await page.screenshot({ path: `${OUT}/ui-4-hn.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate("document.documentElement.scrollWidth - innerWidth");
  check("no sideways scroll at phone width", Number(overflow) <= 0, `${overflow}px`);
  await page.screenshot({ path: `${OUT}/ui-5-phone.png`, fullPage: true });
  check("no browser console errors", errors.length === 0, errors.slice(0, 3).join(" | ").slice(0, 300));
  await browser.close();
  console.log(failures ? `${failures} FAILED` : "UI checks passed.");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
