import { CORS_HEADERS, preflight } from "@/lib/cors";
import { rateLimited } from "@/lib/rate-limit";
import { loadSite } from "@/lib/store";
import { executeTool, toJsonSchema, ToolInputError } from "@/lib/tools";
import type { CompiledTool } from "@/lib/types";

type JsonRpcRequest = { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: unknown };

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

export async function POST(req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  const limited = rateLimited(req);
  if (limited) return limited;
  const { siteId } = await params;
  const site = await loadSite(siteId);
  if (!site) return new Response("site not found", { status: 404, headers: CORS_HEADERS });
  let body: JsonRpcRequest | JsonRpcRequest[];
  try {
    body = (await req.json()) as JsonRpcRequest | JsonRpcRequest[];
  } catch {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  const requests = Array.isArray(body) ? body : [body];
  const replies = (await Promise.all(requests.map((r) => handle(r, site.tools)))).filter(Boolean);
  if (replies.length === 0) return new Response(null, { status: 202, headers: CORS_HEADERS });
  return Response.json(Array.isArray(body) ? replies : replies[0], { headers: CORS_HEADERS });
}

async function handle(req: JsonRpcRequest, tools: CompiledTool[]) {
  if (req.id === undefined || req.id === null) return null;
  const id = req.id;
  const reply = (result: unknown) => ({ jsonrpc: "2.0" as const, id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0" as const, id, error: { code, message } });
  try {
    switch (req.method) {
      case "initialize": {
        const requested = (req.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? "";
        return reply({
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "webmcp-bridge", version: "0.2.0" },
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: toJsonSchema(t) })),
        });
      case "tools/call": {
        const call = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
        const tool = tools.find((t) => t.name === call?.name);
        if (!tool) return fail(-32602, `Unknown tool: ${call?.name}`);
        try {
          const res = await executeTool(tool, call?.arguments ?? {});
          const text = typeof res.result === "string" ? res.result : JSON.stringify(res.result);
          return reply({ content: [{ type: "text", text }], isError: !res.ok });
        } catch (err) {
          if (err instanceof ToolInputError) {
            return reply({ content: [{ type: "text", text: err.message }], isError: true });
          }
          throw err;
        }
      }
      default:
        return fail(-32601, `Method not found: ${req.method}`);
    }
  } catch (err) {
    return fail(-32000, (err as Error).message);
  }
}

export const OPTIONS = preflight;

/** This server does not offer a standalone SSE stream, which MCP clients accept as a 405. */
export async function GET() {
  return new Response("Method Not Allowed", { status: 405, headers: { ...CORS_HEADERS, allow: "POST, OPTIONS" } });
}
