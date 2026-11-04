import { CORS_HEADERS } from "./cors";
import { DEMO_MODE } from "./demo";

const WINDOW_MS = 60_000;
const hits = new Map<string, { start: number; count: number }>();

/**
 * Best-effort limit on hosted requests. Counts are per server instance,
 * so this slows abuse rather than guaranteeing a hard cap.
 */
export function rateLimited(req: Request, bucket = "tools", maxCalls = 30): Response | null {
  if (!DEMO_MODE) return null;
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  if (hits.size > 5000) hits.clear();
  const entry = hits.get(key);
  if (!entry || now - entry.start > WINDOW_MS) {
    hits.set(key, { start: now, count: 1 });
    return null;
  }
  entry.count += 1;
  if (entry.count <= maxCalls) return null;
  return Response.json(
    { error: "Too many requests. Try again in a minute." },
    { status: 429, headers: { ...CORS_HEADERS, "retry-after": "60" } },
  );
}
