import { createHash, timingSafeEqual } from "node:crypto";
import { DEMO_MODE, PASSWORD_REQUIRED } from "./demo";
import { rateLimited } from "./rate-limit";

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Guards routes that spend Meta API credit. Returns a response when the request is refused. */
export function requireAccess(req: Request): Response | null {
  if (!DEMO_MODE) return null;
  const limited = rateLimited(req, "paid", 6);
  if (limited) return limited;
  if (!PASSWORD_REQUIRED) return null;
  const expected = process.env.ACCESS_PASSWORD;
  if (!expected) {
    return Response.json({ error: "Compile and chat are not configured on this site." }, { status: 403 });
  }
  const given = req.headers.get("x-access-password") ?? "";
  if (!timingSafeEqual(digest(given), digest(expected))) {
    return Response.json({ error: "Wrong password." }, { status: 401 });
  }
  return null;
}
