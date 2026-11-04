import fs from "node:fs/promises";
import path from "node:path";
import { DEMO_MODE } from "@/lib/demo";

export async function GET() {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), DEMO_MODE ? "demo-data" : ".webmcp-data", "benchmark.result"), "utf8");
    return new Response(raw, { headers: { "content-type": "application/json" } });
  } catch {
    return Response.json(null);
  }
}
