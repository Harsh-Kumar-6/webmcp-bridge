import { z } from "zod";
import { sparkJson } from "./meta";
import { executeTool } from "./tools";
import type { CapturedRequest, Json, NetworkTool, ToolParam, ToolTest } from "./types";

const SECRET = /(key|token|secret|auth|session|csrf|password|signature|cookie)/i;
const NOISE = /(isalive|healthz?|\bping\b|telemetry|beacon|metrics|analytics|\brum\b|csp-report|favicon|manifest)/i;
const READ_METHODS = new Set(["GET", "POST"]);

export type Candidate = CapturedRequest & { variedParams: string[]; score: number };

function bodyOf(req: CapturedRequest): { format: NetworkTool["bodyFormat"]; fields: Record<string, Json> } {
  if (req.method === "GET" || !req.postData) return { format: "none", fields: {} };
  try {
    const parsed = JSON.parse(req.postData);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { format: "json", fields: parsed };
  } catch {
    /* not JSON, so try a form body */
  }
  if (req.requestContentType.includes("form")) {
    return { format: "form", fields: Object.fromEntries(new URLSearchParams(req.postData)) };
  }
  return { format: "none", fields: {} };
}

const paramsOf = (req: CapturedRequest): Record<string, Json> => ({
  ...Object.fromEntries(new URL(req.url).searchParams),
  ...bodyOf(req).fields,
});

/** Text of a request with URL encoding removed, for checking whether it carries an input. */
export function requestText(req: CapturedRequest): string {
  const url = new URL(req.url);
  const query = [...url.searchParams.values()].join(" ");
  return `${url.pathname} ${query} ${req.postData ?? ""}`;
}

/** Plain-code filter: Spark only ever sees successful JSON calls that are not page noise. */
export function findCandidates(captured: CapturedRequest[], typed: string[]): Candidate[] {
  const groups = new Map<string, CapturedRequest[]>();
  for (const req of captured) {
    const url = new URL(req.url);
    if (req.status < 200 || req.status >= 300) continue;
    if (!req.responseContentType.includes("json")) continue;
    if (!READ_METHODS.has(req.method)) continue;
    if (NOISE.test(url.pathname) || NOISE.test(url.hostname)) continue;
    const key = `${req.method} ${url.origin}${url.pathname}`;
    groups.set(key, [...(groups.get(key) ?? []), req]);
  }
  const candidates: Candidate[] = [];
  for (const samples of groups.values()) {
    const all = samples.map(paramsOf);
    const names = new Set(all.flatMap((p) => Object.keys(p)));
    const variedParams = [...names].filter(
      (n) => new Set(all.map((p) => JSON.stringify(p[n]))).size > 1,
    );
    const best =
      [...samples].reverse().find((s) => typed.some((t) => requestText(s).includes(t))) ??
      samples[samples.length - 1];
    const carriesInput = typed.some((t) => requestText(best).includes(t));
    const score = (carriesInput ? 30 : 0) + variedParams.length * 5 + Math.min(names.size, 10);
    candidates.push({ ...best, variedParams, score });
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, 8);
}

const redact = (params: Record<string, Json>) =>
  Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, SECRET.test(k) ? "<redacted>" : v]),
  );

const AuthorSchema = z.object({
  tools: z.array(
    z.object({
      candidate: z.number().int(),
      readOnly: z.boolean(),
      name: z.string(),
      description: z.string(),
      inputs: z.array(
        z.object({ param: z.string(), description: z.string(), required: z.boolean() }),
      ),
      resultPath: z.string(),
      resultFields: z.array(z.string()),
      tests: z.array(
        z.object({
          label: z.string(),
          inputs: z.array(z.object({ param: z.string(), value: z.string() })),
          expectMinResults: z.number().int(),
          expectText: z.string(),
        }),
      ),
    }),
  ),
});

const jsonSchema = (() => {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(AuthorSchema) as Record<string, unknown>;
  return schema;
})();

const SYSTEM = `You turn network calls captured from a website into tools for AI agents.
Pick only the calls that serve the goal. Ignore tracking, configuration and page chrome.
For each tool:
- name: snake_case verb and noun describing the action, such as search_stories.
- description: what an agent gets from it, written for an agent choosing a tool.
- inputs: only params a caller would really change. Leave everything else out, so it stays fixed. Never expose credentials or internal settings.
- readOnly: true only if the call changes nothing on the server.
- resultPath: dot path to the main data in the response, or "" for the whole response.
- resultFields: the few fields an agent needs. Use dot paths relative to each row.
- tests: at least two tests with clearly different inputs. expectMinResults is the smallest row count a correct answer has. expectText is text a correct response must contain, or "".
If no call serves the goal, return an empty tools list.`;

function coerce(value: string, sample: Json): Json {
  if (typeof sample === "number" && value !== "" && !Number.isNaN(Number(value))) return Number(value);
  if (typeof sample === "boolean") return value === "true";
  return value;
}

function typeOf(value: Json): ToolParam["type"] {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return typeof value === "string" ? "string" : "json";
}

function countResults(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  return result === undefined || result === null ? 0 : 1;
}

/** Spark proposes tools; only tools whose tests pass in plain code are shipped. */
export async function authorTools(opts: {
  goal: string;
  candidates: Candidate[];
  log: (line: string) => void;
}): Promise<{ tools: NetworkTool[]; costUsd: number }> {
  const { goal, candidates, log } = opts;
  if (candidates.length === 0) return { tools: [], costUsd: 0 };

  const described = candidates.map((c, index) => ({
    candidate: index,
    method: c.method,
    url: new URL(c.url).origin + new URL(c.url).pathname,
    params: redact(paramsOf(c)),
    paramsThatChangedBetweenRuns: c.variedParams,
    responseSample: c.responseBodySample.slice(0, 1200),
  }));

  const { data, costUsd } = await sparkJson<z.infer<typeof AuthorSchema>>({
    purpose: "author",
    schema: { name: "author", schema: jsonSchema },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `Goal: ${goal}\n\nCaptured calls:\n${JSON.stringify(described, null, 1)}` },
    ],
  });
  const proposal = AuthorSchema.parse(data);

  const tools: NetworkTool[] = [];
  const taken = new Set<string>();
  for (const spec of proposal.tools) {
    const cand = candidates[spec.candidate];
    const name = spec.name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 48);
    if (!cand || !name || taken.has(name)) {
      log(`  rejected "${spec.name}": invalid candidate or duplicate name`);
      continue;
    }
    if (!spec.readOnly) {
      log(`  rejected ${name}: it may change data, and this build only ships read-only tools`);
      continue;
    }
    const url = new URL(cand.url);
    const body = bodyOf(cand);
    const capturedNames = new Set([...url.searchParams.keys(), ...Object.keys(body.fields)]);
    const inputs = new Map(
      spec.inputs
        .filter((i) => capturedNames.has(i.param) && !SECRET.test(i.param))
        .map((i) => [i.param, i]),
    );
    if (spec.inputs.length > 0 && inputs.size === 0) {
      log(`  rejected ${name}: none of its inputs exist in the captured call, or they are credentials`);
      continue;
    }
    const toParam = (paramName: string, value: Json, location: ToolParam["in"]): ToolParam => {
      const input = inputs.get(paramName);
      return {
        name: paramName,
        type: typeOf(value),
        in: location,
        exposed: Boolean(input),
        required: input?.required ?? false,
        description: input?.description,
        value,
      };
    };
    const tool: NetworkTool = {
      kind: "network",
      name,
      description: spec.description,
      method: cand.method,
      urlTemplate: url.origin + url.pathname,
      bodyFormat: body.format,
      headers: Object.fromEntries(
        Object.entries(cand.headers).filter(([k]) =>
          ["accept", "accept-language", "content-type", "x-requested-with"].includes(k.toLowerCase()),
        ),
      ),
      params: [
        ...[...url.searchParams].map(([k, v]) => toParam(k, v, "query")),
        ...Object.entries(body.fields).map(([k, v]) => toParam(k, v, "body")),
      ],
      resultPath: spec.resultPath,
      resultFields: spec.resultFields,
      tests: [],
      lastVerified: new Date().toISOString(),
    };

    if (spec.tests.length < 2 && inputs.size > 0) {
      log(`  rejected ${name}: needs two tests with different inputs`);
      continue;
    }
    const outputs: string[] = [];
    for (const test of spec.tests) {
      const input: Record<string, Json> = {};
      for (const { param, value } of test.inputs) {
        const known = tool.params.find((p) => p.name === param && p.exposed);
        if (known) input[param] = coerce(value, known.value);
      }
      tool.tests.push(await runTest(tool, test, input, outputs));
    }
    const distinct = new Set(outputs).size === outputs.length;
    if (inputs.size > 0 && !distinct) {
      tool.tests.push({
        label: "different inputs change the result",
        input: {},
        ok: false,
        note: "Two different inputs returned the same data, so the input has no effect.",
        durationMs: 0,
      });
    }
    const passed = tool.tests.length > 0 && tool.tests.every((t) => t.ok);
    log(`  ${passed ? "shipped" : "rejected"} ${name}: ${tool.tests.filter((t) => t.ok).length}/${tool.tests.length} tests passed`);
    if (passed) {
      tools.push(tool);
      taken.add(name);
    }
  }
  return { tools, costUsd };
}

async function runTest(
  tool: NetworkTool,
  test: { label: string; expectMinResults: number; expectText: string },
  input: Record<string, Json>,
  outputs: string[],
): Promise<ToolTest> {
  const started = Date.now();
  const finish = (ok: boolean, note: string): ToolTest => ({
    label: test.label,
    input,
    ok,
    note,
    durationMs: Date.now() - started,
  });
  try {
    const res = await executeTool(tool, input);
    if (!res.ok) return finish(false, `HTTP ${res.status}`);
    outputs.push(JSON.stringify(res.result));
    const count = countResults(res.result);
    if (count < test.expectMinResults) return finish(false, `${count} results, expected at least ${test.expectMinResults}`);
    if (test.expectText && !res.rawText.toLowerCase().includes(test.expectText.toLowerCase())) {
      return finish(false, `response does not contain "${test.expectText}"`);
    }
    return finish(true, `${count} result(s)`);
  } catch (err) {
    return finish(false, (err as Error).message);
  }
}
