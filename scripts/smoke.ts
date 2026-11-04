/** PAID: makes 5 real Meta API requests. Refuses to run without --confirm. */
import { chromium } from "playwright";
import path from "node:path";

if (!process.argv.includes("--confirm")) {
  console.error("This spends real Meta API credit. Re-run with --confirm.");
  process.exit(1);
}

async function main() {
  const { recentLocalUsage, samSegment, sparkChat, sparkJson, usageSummary, SPARK_MODEL } = await import("../lib/meta");
  const before = (await usageSummary()).spentUsd;

  const models = await fetch(`${process.env.META_API_BASE ?? "https://api.meta.ai/v1"}/models`, {
    headers: { authorization: `Bearer ${process.env.MODEL_API_KEY}` },
  });
  console.log("GET /models:", models.status);
  if (models.ok) {
    const json = (await models.json()) as { data?: Array<{ id: string }> };
    console.log("  ", json.data?.map((m) => m.id).join(", "));
  }

  const text = await sparkChat({ purpose: "smoke", messages: [{ role: "user", content: "Reply with the single word: ready" }] });
  console.log(`1. ${SPARK_MODEL} text:`, text.message.content);

  const tool = await sparkChat({
    purpose: "smoke",
    messages: [{ role: "user", content: "Add 2 and 3 using the tool." }],
    tools: [{
      type: "function",
      function: {
        name: "add",
        description: "Add two numbers",
        parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false },
      },
    }],
  });
  console.log("2. tool call:", JSON.stringify(tool.message.tool_calls?.[0]?.function));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`file://${path.resolve("public/demo/seats.html")}`);
  const url = `data:image/png;base64,${(await page.screenshot()).toString("base64")}`;
  const truthCount = ((await page.evaluate("window.__seatTruth()")) as unknown[]).length;
  await browser.close();

  const vision = await sparkChat({
    purpose: "smoke",
    messages: [{ role: "user", content: [
      { type: "text", text: "In one sentence: what is this page, and what does each colour mean?" },
      { type: "image_url", image_url: { url } },
    ] }],
  });
  console.log("3. vision:", vision.message.content);

  const structured = await sparkJson<{ ok: boolean }>({
    purpose: "smoke",
    schema: { name: "check", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } },
    messages: [{ role: "user", content: "Return ok as true." }],
  });
  console.log("4. structured output:", JSON.stringify(structured.data));

  const sam = await samSegment({ purpose: "smoke", phrase: "seat", imageDataUrl: url });
  console.log(`5. SAM 3.1: ${sam.boxes.length} boxes for "seat" (the page has ${truthCount} seats)`);
  console.log("   first boxes:", JSON.stringify(sam.boxes.slice(0, 3)));

  const after = await usageSummary();
  console.log(`\nSpent on this run: $${(after.spentUsd - before).toFixed(4)}`);
  console.log(JSON.stringify(recentLocalUsage(5).map((e) => ({ model: e.model, in: e.inputTokens, out: e.outputTokens, usd: Number(e.costUsd.toFixed(5)), ms: e.durationMs })), null, 1));
}

main().catch((err) => {
  console.error(String(err.message ?? err));
  process.exit(1);
});
