import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { pendingReversals } from "@/server/gl-export";

// GET /api/receivables/close/[id]/reversals — how many already-exported events the period's next
// Export to GL would reverse, read just before it so the Close screen can ask first (owner ruling
// R25, #705). The export's own gates: only the caller who can export is asked.
export const GET = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "receivables", "edit");
  mustDo(user, "run_qbo_export");
  const { id } = await params;
  return NextResponse.json(await pendingReversals(id));
});
