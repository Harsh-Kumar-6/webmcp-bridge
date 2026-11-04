import fs from "node:fs";
import path from "node:path";
import { blobList, blobWrite, hasBlobStore } from "./blob-store";

/** Thin client for the Meta Model API with a usage ledger and a spending stop. */

const PRICES = {
  sparkInput: 1.25 / 1e6,
  sparkCached: 0.15 / 1e6,
  sparkOutput: 4.25 / 1e6,
  samImage: 2.5 / 1000,
};

export const SPARK_MODEL = process.env.META_SPARK_MODEL ?? "muse-spark-1.3";
export const SAM_MODEL = process.env.META_SAM_MODEL ?? "sam-3.1";
export const BUDGET_USD = Number(process.env.META_BUDGET_USD ?? 15);

const base = () => process.env.META_API_BASE ?? "https://api.meta.ai/v1";
const ledgerPath = () =>
  process.env.META_USAGE_FILE ?? path.join(process.cwd(), ".webmcp-data", "usage.jsonl");

export type UsageEntry = {
  at: string;
  purpose: string;
  model: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  images: number;
  costUsd: number;
  durationMs: number;
};

export class BudgetError extends Error {}
export class MetaApiError extends Error {}

function readLocalUsage(): UsageEntry[] {
  try {
    return fs
      .readFileSync(ledgerPath(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as UsageEntry);
  } catch {
    return [];
  }
}

const USAGE_PREFIX = "usage/";

/** Each hosted entry is its own blob, with its cost in the name, so totals need only a listing. */
async function readBlobTotals(): Promise<{ requests: number; spentUsd: number }> {
  const paths = await blobList(USAGE_PREFIX);
  const spentUsd = paths.reduce((sum, p) => sum + Number(p.split("/")[1]?.split("_")[1] ?? 0) / 1e7, 0);
  return { requests: paths.length, spentUsd };
}

export async function usageSummary() {
  if (hasBlobStore()) return { ...(await readBlobTotals()), budgetUsd: BUDGET_USD };
  const entries = readLocalUsage();
  return {
    requests: entries.length,
    spentUsd: entries.reduce((sum, e) => sum + e.costUsd, 0),
    budgetUsd: BUDGET_USD,
  };
}

/** Recent local entries, for scripts. */
export const recentLocalUsage = (count: number) => readLocalUsage().slice(-count);

async function record(entry: UsageEntry) {
  if (hasBlobStore()) {
    const id = `${Date.now()}_${Math.round(entry.costUsd * 1e7)}_${crypto.randomUUID()}`;
    await blobWrite(`${USAGE_PREFIX}${id}.json`, JSON.stringify(entry));
    return;
  }
  fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
  fs.appendFileSync(ledgerPath(), JSON.stringify(entry) + "\n");
}

async function preflight(): Promise<string> {
  const key = process.env.MODEL_API_KEY;
  if (!key) throw new MetaApiError("MODEL_API_KEY is not set. Add it to .env.local and restart.");
  const { spentUsd: spent } = await usageSummary();
  if (spent >= BUDGET_USD) {
    throw new BudgetError(`Spending stop reached: $${spent.toFixed(2)} of $${BUDGET_USD}.`);
  }
  return key;
}

async function post(pathname: string, key: string, body: unknown): Promise<unknown> {
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${base()}${pathname}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    if (res.ok) return res.json();
    lastError = `${res.status}: ${(await res.text()).slice(0, 500)}`;
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new MetaApiError(`Meta API ${pathname} failed with ${lastError}`);
}

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content:
    | string
    | null
    | Array<
        { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
      >;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatTool = {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
};

/**
 * Spark sometimes writes a tool call as markup in its text instead of using tool_calls.
 * This recovers those calls, and only accepts names of tools that were offered.
 */
export function recoverToolCalls(text: string, allowed: string[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const invoke of text.matchAll(/<[\w-]*:?invoke name="(?:default\.)?([\w-]+)">([\s\S]*?)<\/[\w-]*:?invoke>/g)) {
    if (!allowed.includes(invoke[1])) continue;
    const args: Record<string, unknown> = {};
    for (const param of invoke[2].matchAll(/<[\w-]*:?parameter name="([\w-]+)">([\s\S]*?)<\/[\w-]*:?parameter>/g)) {
      try {
        args[param[1]] = JSON.parse(param[2]);
      } catch {
        args[param[1]] = param[2];
      }
    }
    calls.push({
      id: `recovered_${calls.length}`,
      type: "function",
      function: { name: invoke[1], arguments: JSON.stringify(args) },
    });
  }
  return calls;
}

export async function sparkChat(opts: {
  purpose: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  schema?: { name: string; schema: unknown };
  effort?: "minimal" | "low" | "medium" | "high";
}): Promise<{ message: ChatMessage; costUsd: number }> {
  const key = await preflight();
  const started = Date.now();
  const body: Record<string, unknown> = {
    model: SPARK_MODEL,
    messages: opts.messages,
    reasoning_effort: opts.effort ?? "low",
  };
  if (opts.tools) {
    body.tools = opts.tools;
    body.parallel_tool_calls = false;
  }
  if (opts.schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: opts.schema.name, schema: opts.schema.schema, strict: true },
    };
  }
  const json = (await post("/chat/completions", key, body)) as {
    choices?: Array<{ message: ChatMessage }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };
  const message = json.choices?.[0]?.message;
  if (!message) throw new MetaApiError("Meta API returned no message.");
  if (opts.tools && !message.tool_calls?.length && typeof message.content === "string") {
    const recovered = recoverToolCalls(message.content, opts.tools.map((t) => t.function.name));
    if (recovered.length > 0) {
      message.tool_calls = recovered;
      message.content = null;
    }
  }
  const inputTokens = json.usage?.prompt_tokens ?? 0;
  const cachedTokens = json.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const outputTokens = json.usage?.completion_tokens ?? 0;
  const costUsd =
    (inputTokens - cachedTokens) * PRICES.sparkInput +
    cachedTokens * PRICES.sparkCached +
    outputTokens * PRICES.sparkOutput;
  await record({
    at: new Date().toISOString(),
    purpose: opts.purpose,
    model: SPARK_MODEL,
    inputTokens,
    cachedTokens,
    outputTokens,
    images: 0,
    costUsd,
    durationMs: Date.now() - started,
  });
  return { message, costUsd };
}

/** Asks Spark for JSON that matches a schema and parses the reply. */
export async function sparkJson<T>(opts: {
  purpose: string;
  messages: ChatMessage[];
  schema: { name: string; schema: unknown };
  effort?: "minimal" | "low" | "medium" | "high";
}): Promise<{ data: T; costUsd: number }> {
  const { message, costUsd } = await sparkChat(opts);
  if (typeof message.content !== "string") throw new MetaApiError("Spark returned no JSON text.");
  try {
    return { data: JSON.parse(message.content) as T, costUsd };
  } catch {
    throw new MetaApiError(`Spark returned invalid JSON: ${message.content.slice(0, 200)}`);
  }
}

export type SamBox = { x1: number; y1: number; x2: number; y2: number };

/** Reads boxes from SAM's documented text format. Masks are not needed by this app. */
export function parseSamOutput(text: string): SamBox[] {
  const boxes: SamBox[] = [];
  for (const match of text.matchAll(/<\|box;([^|]*)\|>/g)) {
    const fields = Object.fromEntries(
      match[1].split(";").map((part) => part.split("=") as [string, string]),
    );
    const box = {
      x1: Number(fields.x1),
      y1: Number(fields.y1),
      x2: Number(fields.x2),
      y2: Number(fields.y2),
    };
    if (Object.values(box).every(Number.isFinite)) boxes.push(box);
  }
  return boxes;
}

export async function samSegment(opts: {
  purpose: string;
  phrase: string;
  imageDataUrl: string;
}): Promise<{ boxes: SamBox[]; costUsd: number; rawText: string; rawResponse: unknown }> {
  const key = await preflight();
  const started = Date.now();
  const json = (await post("/responses", key, {
    model: SAM_MODEL,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: opts.phrase },
          { type: "input_image", image_url: opts.imageDataUrl },
        ],
      },
    ],
    stream: false,
  })) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  };
  const text =
    json.output_text ??
    (json.output ?? [])
      .flatMap((item) => item.content ?? [])
      .map((part) => part.text ?? "")
      .join("");
  await record({
    at: new Date().toISOString(),
    purpose: opts.purpose,
    model: SAM_MODEL,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    images: 1,
    costUsd: PRICES.samImage,
    durationMs: Date.now() - started,
  });
  return { boxes: parseSamOutput(text), costUsd: PRICES.samImage, rawText: text, rawResponse: json };
}
