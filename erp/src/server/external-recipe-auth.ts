import { createHash, timingSafeEqual } from "node:crypto";

export type ExternalAccess = { ok: true } | { ok: false; status: 401 | 404 | 429; retryAfter?: number };

// One installation credential, one bounded process-local record. Rejected supplied tokens
// never allocate records, and a rotated configured credential starts a fresh allowance.
let window: { credentialDigest: string; startedAt: number; count: number } | undefined;
const digest = (value: string) => createHash("sha256").update(value).digest();

export function authorizeExternalRecipeRead(request: Request, nowMs = Date.now()): ExternalAccess {
  const token = process.env.LOADSYNQ_API_TOKEN ?? "";
  if (!/^[a-f0-9]{64}$/i.test(token)) return { ok: false, status: 404 };
  const expected = digest(`Bearer ${token}`);
  const supplied = digest(request.headers.get("authorization") ?? "");
  if (!timingSafeEqual(supplied, expected)) return { ok: false, status: 401 };

  const credentialDigest = expected.toString("hex");
  if (!window || window.credentialDigest !== credentialDigest || nowMs >= window.startedAt + 60_000) {
    window = { credentialDigest, startedAt: nowMs, count: 0 };
  }
  if (window.count >= 60) {
    return { ok: false, status: 429, retryAfter: Math.ceil((window.startedAt + 60_000 - nowMs) / 1000) };
  }
  window.count++;
  return { ok: true };
}
