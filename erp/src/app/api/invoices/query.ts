// Not a route — the shippers/query.ts precedent: GET /api/invoices, its Excel export and the
// register PDF (#592) must agree on exactly what a given query string means, so the parse lives
// here once.
import { HttpError } from "@/server/http";
import type { InvoiceFilter } from "@/server/invoices";
import { INVOICE_PRINTED, INVOICE_STATUSES } from "@/lib/invoice-constants";

/** An absent param and a blank one both mean "not set" — the orders/query.ts `orUndefined`
 *  precedent, duplicated rather than imported (the shippers/query.ts precedent: not worth the
 *  cross-tree coupling for a four-line helper). */
function orUndefined(value: string | null): string | undefined {
  return value === null || value === "" ? undefined : value;
}

const STATUS_VALUES = new Set<string>(INVOICE_STATUSES);

/** Rejects an unrecognized status as a field-anchored 400 naming it (the orders/query.ts
 *  `parseStatus` precedent) rather than handing Prisma a value its enum has never heard of, which
 *  throws a status-less `PrismaClientValidationError` there — a bare 500 instead of a clean 400. */
function parseStatus(url: URL): InvoiceFilter["status"] {
  const raw = orUndefined(url.searchParams.get("status"));
  if (raw === undefined) return undefined;
  if (!STATUS_VALUES.has(raw)) throw new HttpError(400, `Unknown invoice status "${raw}"`);
  return raw as InvoiceFilter["status"];
}

const PRINTED_VALUES = new Set<string>(INVOICE_PRINTED);

/** The Printed filter (PR 6): "1" or "0", any other value a field-anchored 400 (the `parseStatus`
 *  shape). The list, the Excel and the register PDF share it through this one parse. */
function parsePrinted(url: URL): InvoiceFilter["printed"] {
  const raw = orUndefined(url.searchParams.get("printed"));
  if (raw === undefined) return undefined;
  if (!PRINTED_VALUES.has(raw)) throw new HttpError(400, `Unknown printed filter "${raw}"`);
  return raw as InvoiceFilter["printed"];
}

/** Turns the invoicing list's query string into the `InvoiceFilter` shape `listInvoices` expects.
 *  `from`/`to` pass through unvalidated on purpose — `listInvoices` already turns a malformed date
 *  into its own field-anchored 400 via `parseDate`, so re-checking here would just be a second
 *  copy of a rule the service already owns (the shippers/query.ts precedent). */
export function parseInvoiceFilter(url: URL): InvoiceFilter {
  return {
    customerId: orUndefined(url.searchParams.get("customerId")),
    status: parseStatus(url),
    from: orUndefined(url.searchParams.get("from")),
    to: orUndefined(url.searchParams.get("to")),
    printed: parsePrinted(url),
  };
}

/** `?candidates=1` switches GET /api/invoices from the invoice list to the ready-to-invoice
 *  worklist (`listInvoiceCandidates`) — the same query string, two different reads, so the route
 *  needs one place that decides which. */
export function isCandidatesQuery(url: URL): boolean {
  return url.searchParams.get("candidates") === "1";
}

/** `?selected=1` switches POST /api/invoices/[id]/print to the Invoicing list's Print selected
 *  (#591, `printSelectedInvoice`): the same route, a second gate and two refusals, so the route
 *  needs one place that decides which. */
export function isSelectedPrintQuery(url: URL): boolean {
  return url.searchParams.get("selected") === "1";
}
