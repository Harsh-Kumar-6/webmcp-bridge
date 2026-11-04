import { loadSite, toPublicRecord } from "@/lib/store";


export async function GET(_req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const site = await loadSite(siteId);
  if (!site) return new Response("not found", { status: 404 });
  return Response.json(toPublicRecord(site));
}
