import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const token = process.env.HEALTH_MONITOR_TOKEN ?? "";
  // A distinct, random 32-byte hex credential. Unconfigured installations expose no new read.
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers });
  }
  const supplied = request.headers.get("authorization") ?? "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(digest(supplied), digest(`Bearer ${token}`))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  }

  try {
    // Defer DB/backup module initialization until AFTER authorization (practice-mode has an
    // eager identity read). Cookies, query parameters and request bodies never authorize this.
    const { readOperationsHealth } = await import("@/server/operations-health");
    const { ok, db, backups } = await readOperationsHealth();
    return NextResponse.json({ ok, db, backups }, { status: ok ? 200 : 503, headers });
  } catch {
    return NextResponse.json({ ok: false, db: false, backups: "unknown" }, { status: 503, headers });
  }
}
