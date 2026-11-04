import { sparkChat, type ChatMessage, type ChatTool } from "./meta";

const MAX_ROUNDS = 5;
const MAX_RESULT_CHARS = 8000;

export type ChatEvent =
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; text: string; isError: boolean; durationMs: number }
  | { type: "text"; text: string }
  | { type: "usage"; costUsd: number; modelCalls: number };

type RpcResult = {
  tools?: Array<{ name: string; description: string; inputSchema: unknown }>;
  content?: Array<{ text?: string }>;
  isError?: boolean;
};

async function rpc(endpoint: string, method: string, params?: unknown): Promise<RpcResult> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: RpcResult; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result ?? {};
}

/** Spark runs the conversation only. Every tool call goes through the site's MCP endpoint. */
export async function runChat(opts: {
  endpoint: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  emit: (event: ChatEvent) => void;
}) {
  const { endpoint, history, emit } = opts;
  const listed = await rpc(endpoint, "tools/list");
  const tools: ChatTool[] = (listed.tools ?? []).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You help people use a website through its tools. Call a tool whenever the answer depends on the site. Answer only from tool results, and say so plainly if a tool fails or returns nothing. Be brief.",
    },
    ...history,
  ];
  let costUsd = 0;
  let modelCalls = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { message, costUsd: cost } = await sparkChat({
      purpose: "chat",
      messages,
      tools: tools.length ? tools : undefined,
    });
    costUsd += cost;
    modelCalls += 1;
    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      emit({ type: "text", text: typeof message.content === "string" ? message.content : "" });
      break;
    }
    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      let text: string;
      let isError = false;
      const started = Date.now();
      try {
        args = JSON.parse(call.function.arguments || "{}");
        emit({ type: "tool_call", name: call.function.name, args });
        const result = await rpc(endpoint, "tools/call", { name: call.function.name, arguments: args });
        text = result.content?.map((c) => c.text ?? "").join("") ?? "";
        isError = result.isError === true;
      } catch (err) {
        text = `Tool error: ${(err as Error).message}`;
        isError = true;
      }
      const trimmed = text.slice(0, MAX_RESULT_CHARS);
      emit({ type: "tool_result", name: call.function.name, text: trimmed, isError, durationMs: Date.now() - started });
      messages.push({ role: "tool", tool_call_id: call.id, content: trimmed });
    }
    if (round === MAX_ROUNDS - 1) emit({ type: "text", text: "I stopped after 5 rounds without a final answer." });
  }
  emit({ type: "usage", costUsd, modelCalls });
}
