import { CORS_HEADERS, preflight } from "@/lib/cors";
import { rateLimited } from "@/lib/rate-limit";
import { loadSite } from "@/lib/store";
import { executeTool, ToolInputError } from "@/lib/tools";

export const OPTIONS = preflight;

export async function POST(req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  const limited = rateLimited(req);
  if (limited) return limited;
  const { siteId } = await params;
  const { toolName, input } = (await req.json()) as { toolName: string; input?: Record<string, unknown> };
  const site = await loadSite(siteId);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404, headers: CORS_HEADERS });
  const tool = site.tools.find((t) => t.name === toolName);
  if (!tool) return Response.json({ error: "Tool not found" }, { status: 404, headers: CORS_HEADERS });
  const started = Date.now();
  try {
    const { status, ok, result } = await executeTool(tool, input ?? {});
    return Response.json({ status, ok, result, durationMs: Date.now() - started }, { headers: CORS_HEADERS });
  } catch (err) {
    const status = err instanceof ToolInputError ? 400 : 502;
    return Response.json({ error: (err as Error).message }, { status, headers: CORS_HEADERS });
  }
}
