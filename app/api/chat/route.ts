import { runChat } from "@/lib/chat";
import { requireAccess } from "@/lib/access";

export async function POST(req: Request) {
  const refused = requireAccess(req);
  if (refused) return refused;
  const { siteId, messages } = (await req.json()) as {
    siteId?: string;
    messages?: Array<{ role: "user" | "assistant"; content: string }>;
  };
  if (!siteId || !messages?.length) {
    return Response.json({ error: "siteId and messages are required" }, { status: 400 });
  }
  const endpoint = new URL(`/api/mcp/${encodeURIComponent(siteId)}`, req.url).toString();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      try {
        await runChat({ endpoint, history: messages, emit: send });
      } catch (err) {
        send({ type: "error", message: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" } });
}
