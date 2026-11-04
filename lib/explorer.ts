import type { Page } from "playwright";
import { sparkChat, type ChatTool } from "./meta";
import type { ExploreStep } from "./types";

const SNAPSHOT_SCRIPT = `(() => {
  const selector = 'a,button,input,select,textarea,summary,[role=button],[role=link],[role=searchbox],[role=tab],[onclick]';
  const out = [];
  let ref = 0;
  for (const el of document.querySelectorAll(selector)) {
    const box = el.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if (ref >= 70) break;
    ref += 1;
    el.setAttribute('data-wmcp-ref', String(ref));
    const type = el.getAttribute('type') || '';
    const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
      (el.innerText || '').trim().slice(0, 60) || el.getAttribute('name') || el.getAttribute('title') || '';
    out.push({ ref, tag: el.tagName.toLowerCase(), type, label,
      value: type === 'password' ? '' : String(el.value || '').slice(0, 40) });
  }
  return { title: document.title, url: location.href, elements: out,
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 1500),
    captcha: !!document.querySelector('iframe[src*="captcha"],[class*="captcha" i],[id*="captcha" i]') };
})()`;

type Snapshot = {
  title: string;
  url: string;
  text: string;
  captcha: boolean;
  elements: Array<{ ref: number; tag: string; type: string; label: string; value: string }>;
};

/** Blocked in code, whatever the model asks for. */
const IRREVERSIBLE =
  /\b(pay|payment|buy|purchase|checkout|check out|place order|delete|remove account|unsubscribe|transfer|donate|sign ?up|register|log ?in|sign ?in)\b/i;

const fn = (name: string, description: string, properties: object, required: string[]): ChatTool => ({
  type: "function",
  function: {
    name,
    description,
    parameters: { type: "object", properties, required, additionalProperties: false },
  },
});

const TOOLS: ChatTool[] = [
  fn("click", "Click an element by its ref.", { ref: { type: "integer" } }, ["ref"]),
  fn(
    "type_text",
    "Type into an input by ref. Set submit to true to press Enter afterwards.",
    { ref: { type: "integer" }, text: { type: "string" }, submit: { type: "boolean" } },
    ["ref", "text", "submit"],
  ),
  fn(
    "select_option",
    "Choose an option in a select element by ref.",
    { ref: { type: "integer" }, value: { type: "string" } },
    ["ref", "value"],
  ),
  fn("scroll", "Scroll the page down one screen.", {}, []),
  fn(
    "finish",
    "Stop exploring. Set reached to true only if the goal action actually ran.",
    { reached: { type: "boolean" }, summary: { type: "string" } },
    ["reached", "summary"],
  ),
];

const SYSTEM = `You explore a website once so its actions can be compiled into reusable tools.
Perform the user's goal with realistic sample inputs so that the page sends its real requests.
When the goal takes an input, perform it twice with clearly different inputs, then call finish.
Call exactly one tool per turn. Use only refs from the current page state.
Never log in, sign up, pay, buy, delete anything, submit personal details or solve a captcha.
If the goal requires one of those, call finish with reached set to false.`;

export type ExploreResult = { reached: boolean; summary: string; typed: string[]; costUsd: number };

export async function explore(opts: {
  page: Page;
  goal: string;
  maxSteps: number;
  /** Plain-code check that the action already ran, so no further model calls are spent. */
  isDone?: (typed: string[]) => boolean;
  log: (line: string) => void;
  onStep: (step: ExploreStep) => void;
}): Promise<ExploreResult> {
  const { page, goal, maxSteps, isDone, log, onStep } = opts;
  const history: string[] = [];
  const typed: string[] = [];
  let costUsd = 0;
  let textOnlyReplies = 0;

  for (let step = 1; step <= maxSteps; step++) {
    if (isDone?.(typed)) {
      return { reached: true, summary: "The action ran with two different inputs.", typed, costUsd };
    }
    const snapshot = (await page.evaluate(SNAPSHOT_SCRIPT)) as Snapshot;
    if (snapshot.captcha) {
      log("Captcha detected. Stopping: captchas are left to the person.");
      return { reached: false, summary: "Stopped at a captcha.", typed, costUsd };
    }
    const shot = await page.screenshot({ type: "jpeg", quality: 55 });
    const dataUrl = `data:image/jpeg;base64,${shot.toString("base64")}`;
    const elements = snapshot.elements
      .map((e) => `[${e.ref}] ${e.tag}${e.type ? `(${e.type})` : ""} "${e.label}"${e.value ? ` value="${e.value}"` : ""}`)
      .join("\n");

    const { message, costUsd: cost } = await sparkChat({
      purpose: "explore",
      tools: TOOLS,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Goal: ${goal}
Step ${step} of ${maxSteps}.
Actions so far:
${history.join("\n") || "(none)"}

Current page: ${snapshot.title} (${snapshot.url})
Interactive elements:
${elements || "(none found)"}

Page text:
${snapshot.text}`,
            },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    });
    costUsd += cost;

    const call = message.tool_calls?.[0];
    if (!call) {
      history.push(`${step}. You replied without calling a tool. Call a tool.`);
      if (++textOnlyReplies >= 2) {
        return { reached: false, summary: "Spark stopped calling tools.", typed, costUsd };
      }
      continue;
    }
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      history.push(`${step}. Tool arguments were not valid JSON.`);
      continue;
    }
    const name = call.function.name;
    const screenshot = dataUrl;

    if (name === "finish") {
      const summary = String(args.summary ?? "");
      onStep({ step, action: "finish", detail: summary, outcome: args.reached ? "reached" : "not reached", screenshot });
      return { reached: args.reached === true, summary, typed, costUsd };
    }

    const element = snapshot.elements.find((e) => e.ref === Number(args.ref));
    const detail = name === "scroll" ? "down" : `${element?.tag ?? "?"} "${element?.label ?? args.ref}"${args.text ? ` ← "${args.text}"` : ""}`;
    let outcome = "ok";
    try {
      outcome = await perform(page, name, args, element, typed);
    } catch (err) {
      outcome = `failed: ${(err as Error).message.split("\n")[0].slice(0, 120)}`;
    }
    history.push(`${step}. ${name} ${detail}: ${outcome}`);
    log(`  step ${step}: ${name} ${detail} (${outcome})`);
    onStep({ step, action: name, detail, outcome, screenshot });
  }
  return { reached: false, summary: `Stopped after ${maxSteps} steps.`, typed, costUsd };
}

async function perform(
  page: Page,
  name: string,
  args: Record<string, unknown>,
  element: Snapshot["elements"][number] | undefined,
  typed: string[],
): Promise<string> {
  if (name === "scroll") {
    await page.mouse.wheel(0, 700);
    await page.waitForTimeout(400);
    return "ok";
  }
  if (!element) return `blocked: no element with ref ${String(args.ref)}`;
  if (element.type === "password") return "blocked: password fields are never filled";
  if (name === "click" && IRREVERSIBLE.test(element.label)) {
    return `blocked: "${element.label}" looks irreversible or needs an account`;
  }
  const locator = page.locator(`[data-wmcp-ref="${element.ref}"]`).first();
  if (name === "click") await locator.click({ timeout: 4000 });
  else if (name === "select_option") await locator.selectOption(String(args.value), { timeout: 4000 });
  else if (name === "type_text") {
    const text = String(args.text ?? "");
    await locator.fill(text, { timeout: 4000 });
    typed.push(text);
    if (args.submit === true) await locator.press("Enter", { timeout: 4000 });
  } else return `blocked: unknown tool ${name}`;
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
  return "ok";
}
