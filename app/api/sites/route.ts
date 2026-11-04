import { listSites, toPublicRecord } from "@/lib/store";


export async function GET() {
  const sites = await listSites();
  return Response.json({ sites: sites.map(toPublicRecord) });
}
