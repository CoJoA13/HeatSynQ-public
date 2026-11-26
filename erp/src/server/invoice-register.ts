// #592: the Invoice register PDF's text. The register's rows, the applied filter, the filter's
// customer and the moment it was made become `InvoiceRegisterData`, every cell the string it prints,
// and the file's name. The builder (`pdf/invoice-register.ts`) only lays that text out, and the read
// is `listInvoiceRegisterForPdf` (invoices.ts).
//
// Cells read as the screen shows them (owner ruling, plan Amendment 6): Kind and Status by their
// labels, dates MM/DD/YYYY, money with grouping and two decimals. Money and dates on paper are each
// document's own (the posting register keeps its own `money`), so these are this file's, never
// src/lib/format.ts's, which is for screens. Finalized, Printed and the Made line are date and time
// in plant time (`PLANT_TIME_ZONE`, the build stamp's zone), whatever zone the server runs in. A
// line break inside a cell prints as a space (`oneLine`, src/lib/line-break.ts), as the screen shows
// it: every character of the #522 line-break set, by R15 of the 2026-10-22 review (#672).
//
// Value imports are of src/lib/ leaves and the plant clock (`plant-clock.ts`, which the container
// tags read too, #743) only, and the service types are imported as types, so the file loads with no
// database (tests/invoice-register-pdf.test.ts loads it in a child process to fix
// the process's time zone).
import type { InvoiceFilter, InvoiceRegisterForPdf, InvoiceRegisterRow } from "./invoices";
import type { InvoiceRegisterData, InvoiceRegisterPrintedRow } from "./pdf/invoice-register";
import { INVOICE_KIND_LABELS, INVOICE_STATUS_LABELS } from "../lib/invoice-constants";
import { parseDateOnly } from "../lib/business-days";
import { registerSummary, summaryLabel } from "../lib/invoice-register-summary";
import { civil, plantDateTime, plantClock } from "./plant-clock";
import { oneLine } from "../lib/line-break";

/** The filter's customer, as the filter line names it. */
export type RegisterCustomer = NonNullable<InvoiceRegisterForPdf["customer"]>;

// Each cell and the filter line's customer go through `oneLine` (src/lib/line-break.ts): every run
// of white space that holds a line break prints as one space, as the screen shows it (owner,
// 2026-10-21, plan Amendment 17; the whole #522 set since R15, #672). The builder keeps every row
// whole across a page break (Amendment 16), and pdfmake prints a row taller than a page on no page
// at all, so a line break never adds a line here: a row wraps only by width. An invoice number
// prefix of absurd length is the one way left to a row that tall (a residual).

/** `1,250.00`, `-157.50`, and `0.00` for zero: a $0 invoice and an empty register's sum both print
 *  (Amendment 9), so unlike the posting register's `money` this has no blank for zero. */
const money = (n: number): string => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The ISO instant a register row carries, on the plant's clock; "" for none. */
const stamped = (iso: string | null): string => (iso === null ? "" : plantDateTime(new Date(iso)));

function printedRow(r: InvoiceRegisterRow): InvoiceRegisterPrintedRow {
  const row: InvoiceRegisterPrintedRow = {
    documentNumber: r.documentNumber,
    kind: INVOICE_KIND_LABELS[r.kind],
    orderNumber: String(r.orderNumber),
    customerCode: r.customerCode,
    customerName: r.customerName,
    invoiceDate: civil(parseDateOnly(r.invoiceDate)),
    status: INVOICE_STATUS_LABELS[r.status],
    total: money(r.total),
    finalized: stamped(r.finalizedAt),
    printed: stamped(r.printedAt),
  };
  // Every cell, so a cell added later has its line breaks printed as spaces too.
  for (const key of Object.keys(row) as (keyof InvoiceRegisterPrintedRow)[]) row[key] = oneLine(row[key]);
  return row;
}

/** The applied filter under the title (Amendment 7), its three parts joined by three spaces, and a
 *  fourth, "Printed: …", only when the Printed filter is set (the UX redesign PR 6, owner
 *  2026-10-31), and a last, "Balance: Open", only when the Balance filter is (#1057), so a register
 *  with neither keeps its approved line. The dates are the filter's PARSED
 *  dates (`parseDateOnly` trims), so the caller has the read answer a malformed date's 400 before
 *  this formats one; a blank date is none, as the list's `where` reads it. */
function filterLine(filter: InvoiceFilter, customer: RegisterCustomer | null): string {
  const from = filter.from ? civil(parseDateOnly(filter.from)) : null;
  const to = filter.to ? civil(parseDateOnly(filter.to)) : null;
  const dates = from !== null && to !== null ? `${from} – ${to}`
    : from !== null ? `from ${from}`
      : to !== null ? `through ${to}`
        : "Any date";
  return [
    customer === null ? "Customer: All customers" : `Customer: ${oneLine(customer.code)} · ${oneLine(customer.name)}`,
    filter.status === undefined ? "Status: All statuses" : `Status: ${INVOICE_STATUS_LABELS[filter.status]}`,
    `Invoice date: ${dates}`,
    ...(filter.printed === undefined ? [] : [`Printed: ${filter.printed === "1" ? "Printed" : "Not printed"}`]),
    ...(filter.balance === undefined ? [] : ["Balance: Open"]),
  ].join("   ");
}

/**
 * The register's text and its file's name. `now` is read once by the caller, so the Made line and
 * the file's plant date name the same moment. The summary is `registerSummary`'s and its words
 * `summaryLabel`'s (src/lib/invoice-register-summary.ts), the Excel's own, so the same rows give
 * the same total in both files.
 */
export function invoiceRegisterPdfData(input: {
  rows: InvoiceRegisterRow[]; filter: InvoiceFilter; customer: RegisterCustomer | null; now: Date;
}): { data: InvoiceRegisterData; fileName: string } {
  const summary = registerSummary(input.rows);
  const made = plantClock(input.now);
  return {
    data: {
      filterLine: filterLine(input.filter, input.customer),
      madeLine: `Made ${made.date}, ${made.time}`,
      rows: input.rows.map(printedRow),
      summaryLabel: summaryLabel(summary.count),
      summaryTotal: money(summary.total),
    },
    fileName: `invoice-register-${made.isoDate}.pdf`,
  };
}
