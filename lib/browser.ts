import type { Browser } from "playwright";

/**
 * Uses Playwright's Chromium locally and a serverless build of Chromium on Vercel.
 * Playwright loads on first use, so tools that need no browser never depend on it.
 */
export async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright");
  if (!process.env.VERCEL) return chromium.launch({ headless: true });
  const { default: serverless } = await import("@sparticuz/chromium");
  return chromium.launch({
    headless: true,
    args: serverless.args,
    executablePath: await serverless.executablePath(),
  });
}
