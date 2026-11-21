import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { invoiceStepSuggestions } from "@/server/invoice-step-suggestions";

// GET /api/invoices/[id]/step-suggestions (#587): the steps an operation line's description box
// offers, per order line, then every live active step code. Visible to anyone with invoicing view
// (ruling 587-9); a pure read.
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "invoicing", "view");
  return NextResponse.json(await invoiceStepSuggestions((await params).id));
});
