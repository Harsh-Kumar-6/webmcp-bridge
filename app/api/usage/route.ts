import { connection } from "next/server";
import { usageSummary } from "@/lib/meta";

export async function GET() {
  // The ledger changes between requests, so this must never be prerendered.
  await connection();
  return Response.json(await usageSummary());
}
