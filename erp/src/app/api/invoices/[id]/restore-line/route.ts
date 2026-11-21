import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { restoreRemovedLine } from "@/server/invoices";
import { invoiceResponse } from "../../response";

// POST /api/invoices/[id]/restore-line — takes one computed line (`identity`), or every line the
// list shows (`identities`, Restore all), off a draft's removed lines (#594), so the next
// Recalculate bills them again. It changes what that Recalculate bills, so it carries
// Recalculate's own `invoicing.edit` + `change_prices` gate.
export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "invoicing", "edit");
  mustDo(user, "change_prices");
  const detail = await restoreRemovedLine((await params).id, await req.json());
  return invoiceResponse(detail);
});
