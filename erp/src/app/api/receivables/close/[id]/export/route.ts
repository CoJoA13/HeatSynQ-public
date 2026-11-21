import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { exportClose } from "@/server/gl-export";

// POST /api/receivables/close/[id]/export — emit the per-event GL-export delta batch for a CLOSED
// period (spec §4.3). Gated on the dangerous `run_qbo_export` special on top of `receivables.edit`;
// the service owns every rule (readiness refusal, the delta, the Serializable write). The answer is
// the batch's identity and size (#707): the file and the per-event postings stay on the server,
// where the Close screen's batch list and the file route read them.
export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "receivables", "edit");
  mustDo(user, "run_qbo_export");
  const { id } = await params;
  const batch = await exportClose(id);
  return NextResponse.json({ batchId: batch.batchId, exportNumber: batch.exportNumber, periodEnd: batch.periodEnd, postingCount: batch.postings.length });
});
