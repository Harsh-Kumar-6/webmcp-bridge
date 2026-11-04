/**
 * A local stand-in for the Meta Model API, for free testing. It never calls the real API.
 * It follows the documented request and response shapes, so it proves our plumbing, not model quality.
 */
import http from "node:http";

const seatBoxes = () => {
  const boxes: string[] = [];
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 10; c++) {
      const x = 90 + 150 + c * 84;
      const y = 170 + r * 84;
      boxes.push(`<|box;x1=${x};y1=${y};x2=${x + 58};y2=${y + 58};w=1280;h=800|>`);
    }
  }
  boxes.push("<|box;x1=0;y1=0;x2=1280;y2=800;w=1280;h=800|>");
  boxes.push("<|box;x1=420;y1=682;x2=440;y2=702;w=1280;h=800|>");
  return `<0f>${boxes.map((b, i) => `${i}, ${b}, <|mask;x=0;y=0;data=2,2,~ab|c|>`).join(", ")}`;
};

type Body = {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function: { name: string; parameters: { properties?: Record<string, unknown> } } }>;
  response_format?: { json_schema: { name: string } };
};

const usage = { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } };
const toolCall = (name: string, args: unknown) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: `call_${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

function explorerReply(text: string) {
  const elements = [...text.matchAll(/\[(\d+)\] (\w+)(?:\((\w+)\))? "([^"]*)"/g)];
  const input = elements.find((e) => e[2] === "input" && e[3] !== "password");
  const buy = elements.find((e) => /buy/i.test(e[4]));
  if (buy && !text.includes("click button") && !text.includes("blocked")) {
    return toolCall("click", { ref: Number(buy[1]) });
  }
  const typedTimes = (text.match(/type_text/g) ?? []).length;
  if (input && typedTimes === 0) return toolCall("type_text", { ref: Number(input[1]), text: "rust", submit: true });
  if (input && typedTimes === 1) return toolCall("type_text", { ref: Number(input[1]), text: "python", submit: true });
  return toolCall("finish", { reached: true, summary: "Ran the search twice." });
}

function authorReply(text: string) {
  const params = /\\"q\\"/.test(text) ? "q" : "query";
  const tests = [
    { label: "first", inputs: [{ param: params, value: "rust" }], expectMinResults: 1, expectText: "" },
    { label: "second", inputs: [{ param: params, value: "python" }], expectMinResults: 1, expectText: "" },
  ];
  const base = { candidate: 0, resultPath: "hits", resultFields: ["title"] };
  return {
    tools: [
      {
        ...base,
        readOnly: true,
        name: "search_items",
        description: "Search items by keyword.",
        inputs: [
          { param: params, description: "Search text", required: true },
          { param: "api_key", description: "Should be stripped by code", required: false },
        ],
        tests,
      },
      {
        ...base,
        readOnly: false,
        name: "write_item",
        description: "Should be rejected: not read-only.",
        inputs: [{ param: params, description: "x", required: true }],
        tests,
      },
      {
        ...base,
        readOnly: true,
        name: "ignored_input",
        description: "Should be rejected: its input changes nothing.",
        inputs: [{ param: "noop", description: "x", required: true }],
        tests: [
          { label: "a", inputs: [{ param: "noop", value: "1" }], expectMinResults: 1, expectText: "" },
          { label: "b", inputs: [{ param: "noop", value: "2" }], expectMinResults: 1, expectText: "" },
        ],
      },
    ],
  };
}

const PIXEL_PLAN = {
  samPrompts: ["seat", "rounded square"],
  itemNoun: "seat",
  states: [
    { name: "free", hex: "#30a060" },
    { name: "taken", hex: "#cccccc" },
    { name: "selected", hex: "#e08030" },
  ],
  availableState: "free",
  toolSubject: "seats",
  description: "A theatre seat map.",
};

function chatReply(body: Body) {
  const last = body.messages[body.messages.length - 1];
  if (last.role === "tool") return { role: "assistant", content: `Mock answer from tool: ${String(last.content).slice(0, 80)}` };
  const tool = body.tools?.[0]?.function;
  if (!tool) return { role: "assistant", content: "No tools." };
  const props = Object.keys(tool.parameters.properties ?? {});
  return toolCall(tool.name, Object.fromEntries(props.map((p) => [p, p === "label" ? "A1" : "rust"])));
}

export function startMock(port: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const send = (json: unknown) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(json));
      };
      if (req.headers.authorization !== "Bearer mock-key") {
        res.statusCode = 401;
        return send({ error: "mock expects the mock key" });
      }
      const body = JSON.parse(raw || "{}") as Body;
      if (req.url === "/responses") {
        return send({ output: [{ type: "message", content: [{ type: "output_text", text: seatBoxes() }] }] });
      }
      const text = JSON.stringify(body.messages.at(-1)?.content ?? "");
      const schema = body.response_format?.json_schema.name;
      let message: unknown;
      if (schema === "author") message = { role: "assistant", content: JSON.stringify(authorReply(text)) };
      else if (schema === "pixel_plan") message = { role: "assistant", content: JSON.stringify(PIXEL_PLAN) };
      else if (body.tools?.some((t) => t.function.name === "finish")) {
        const firstPart = (body.messages.at(-1)?.content as Array<{ text?: string }>)[0]?.text ?? "";
        message = explorerReply(firstPart);
      } else message = chatReply(body);
      send({ choices: [{ message }], usage });
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1]?.endsWith("mock-meta.ts")) {
  const port = Number(process.argv[2] ?? 4010);
  void startMock(port).then(() => console.log(`Mock Meta API on http://127.0.0.1:${port}`));
}
