import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listInvoiceRegisterForPdf } from "@/server/invoices";
import { invoiceRegisterPdfData } from "@/server/invoice-register";
import { buildInvoiceRegister } from "@/server/pdf/invoice-register";
import { renderPdf } from "@/server/pdf/render";
import { parseInvoiceFilter } from "../query";

// GET /api/invoices/register: the Invoicing list's Export to PDF, the Invoice register (#592). It
// exports what the Excel (`../export/route.ts`) exports: the same permission, the same filter parse
// (`parseInvoiceFilter`) and the same rows, `listInvoices`' read with the filter's customer added
// for the line under the title (`listInvoiceRegisterForPdf`, which alone refuses an id that names
// no customer). The text is `invoiceRegisterPdfData`'s, read off one `now`, and the layout
// `buildInvoiceRegister`'s.
//
// A pure read (spec §12, reports never mutate): no claim, no audit, no stored document. The
// register is internal paper, a download only (owner ruling 592-2), so spec §8's "every outgoing
// document stored" does not reach it and nothing records what a past register showed. No limit on
// its size (owner, 2026-10-21, plan Amendment 14): like the Excel, any filter exports, and a very
// large unfiltered register holds the app for a few seconds while it renders.
export const GET = handle(async (req) => {
  mustCan(requireUser(), "invoicing", "view");
  const filter = parseInvoiceFilter(new URL(req.url));
  const { rows, customer } = await listInvoiceRegisterForPdf(filter);
  const { data, fileName } = invoiceRegisterPdfData({ rows, filter, customer, now: new Date() });
  const pdf = await renderPdf(buildInvoiceRegister(data));
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${fileName}"`,
    },
  });
});
