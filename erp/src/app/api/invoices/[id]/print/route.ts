import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { printInvoice, printSelectedInvoice } from "@/server/invoices";
import { getDocumentMeta, resolveDocumentFilename } from "@/server/documents";
import { fileCustomerCopy } from "@/server/customer-folders";
import { isSelectedPrintQuery } from "../../query";

/**
 * Renders, archives and streams the invoice/credit (P5A spec §9's `POST /api/invoices/[id]/print`,
 * §10). Gated on `invoicing.view`, deliberately (the cert/traveler/shipping-ticket print
 * precedent): a print changes nothing about the invoice beyond the audited archive of its own
 * output and, for a finalized one, its copy in the customer's Invoice folder (#588, which adds no
 * permission: the owner's approved default 588-15), so it is a read of the document — an explicit
 * POST so §12's "reads never mutate" holds.
 *
 * `?selected=1` is the Invoicing list's Print selected (#591, `printSelectedInvoice`), which needs
 * `invoicing.create` beside `view` (owner ruling 591-3) and refuses a row that is not finalized or
 * has printed since it was finalized. Its answer is the single print's, its copy in the folder too.
 */
export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "invoicing", "view");
  const selected = isSelectedPrintQuery(new URL(req.url));
  // BOTH grants in selected mode, the `receivables/statements/divisions` shape: `create` because a
  // Print selected run archives a document for every ticked row, and `view` above because the
  // answer is the document itself. Permissions resolve independently, so `create` without `view`
  // is reachable, and the line above refuses it.
  if (selected) mustCan(user, "invoicing", "create");
  const { id } = await params;

  const printed = await (selected ? printSelectedInvoice(id) : printInvoice(id));
  // The friendly filename (`Invoice-92026.pdf` / `Credit-1000.pdf`, `invoiceFileName`'s) needs the
  // invoice's order / credit number, which this route does not carry — resolve it off the stored
  // row's METADATA (`getDocumentMeta`, never the bytes: the PDF is already in hand as
  // `printed.pdf`, and `getDocument` would pull the whole file back out of the database per print
  // and per Print selected row to learn a number), the download route's own
  // `resolveDocumentFilename` doctrine (which reads the invoice, never re-renders). Read before the
  // copy below (#588), so a read that fails (a database error is a 500) fails the request before
  // anything is filed in the customer's folder.
  const filename = await resolveDocumentFilename(await getDocumentMeta(printed.documentId));
  // #588: a finalized print's copy in the customer's folder. It runs here, after the print has
  // committed, never inside its claim (the copy can wait up to 10 seconds on the share), and it
  // never fails the print: `fileCustomerCopy` never rejects, and a copy that did not land is one
  // sentence for the page. `warning` is null for a draft (`filing` null), the practice copy, an
  // install with no share, a filed copy and a print older than one already filed.
  // tests/print-route-copy-order.test.ts pins where it runs.
  const { warning } = await fileCustomerCopy(printed.filing, printed.pdf);
  return new NextResponse(new Uint8Array(printed.pdf), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${filename}"`,
      // The stored row this response came from (the traveler/cert route's rule).
      "x-document-id": printed.documentId,
      // The body is the PDF bytes, so the sentence travels as a URI-encoded JSON array in a header,
      // the shipping print's shape (src/app/api/shippers/[id]/print/route.ts): a header value must
      // be ISO-8859-1-safe and the sentence carries an em dash.
      ...(warning !== null ? { "x-print-warnings": encodeURIComponent(JSON.stringify([warning])) } : {}),
    },
  });
});
