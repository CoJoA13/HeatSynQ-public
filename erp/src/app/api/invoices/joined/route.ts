import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { joinInvoicePrints } from "@/server/invoices";

/**
 * POST /api/invoices/joined — the Invoicing list's Print as one PDF (#1057): the stored invoice and
 * credit prints the body names (`{ documentIds }`, in order), joined into one PDF and answered as a
 * download. A pure read: it stores and audits nothing (the prints it joins were each filed by their
 * own selected print). A POST only because the body carries the list of ids, which a whole register
 * would push past a URL's length. Gated on `invoicing.view`, the documents' own area
 * (`AREA_FOR_KIND`): every page in it is one the caller may already download alone.
 */
export const POST = handle(async (req) => {
  mustCan(requireUser(), "invoicing", "view");
  const pdf = await joinInvoicePrints(await req.json());
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="invoices.pdf"' },
  });
});
