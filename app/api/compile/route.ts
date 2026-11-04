import { compile } from "@/lib/compiler";
import { requireAccess } from "@/lib/access";
import { saveSite, toPublicRecord } from "@/lib/store";
import type { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  const refused = requireAccess(req);
  if (refused) return refused;
  const { url, goal } = (await req.json()) as { url?: string; goal?: string };
  if (!url || !goal) return Response.json({ error: "url and goal are required" }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      const logs: string[] = [];
      try {
        const record = await compile(
          url,
          goal,
          (line) => {
            logs.push(line);
            send({ type: "log", line });
          },
          (step) => send({ type: "step", step }),
        );
        record.logs = logs;
        await saveSite(record);
        send({ type: "done", record: toPublicRecord(record) });
      } catch (err) {
        send({ type: "error", message: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" } });
}
