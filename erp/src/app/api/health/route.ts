import { NextResponse } from "next/server";
import { prisma } from "@/server/db";

// A wedged query must not acquire a new pooled connection on every Docker probe. Callers bound
// their HTTP wait; sharing the in-flight read bounds outstanding readiness work in this process.
let pending: Promise<boolean> | undefined;
function databaseReady(): Promise<boolean> {
  return pending ??= Promise.resolve(prisma.$queryRaw`SELECT 1`)
    .then(() => true, () => false)
    .finally(() => { pending = undefined; });
}

export async function GET() {
  const ok = await databaseReady();
  return NextResponse.json({ ok, db: ok }, {
    status: ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
