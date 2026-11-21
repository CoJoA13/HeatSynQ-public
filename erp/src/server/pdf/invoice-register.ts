/**
 * The Invoice register PDF (#592): the Invoicing list's Export to PDF. PURE by construction, the
 * posting register's contract (`pdf/posting-register.ts`): `InvoiceRegisterData` in, a plain-JSON
 * pdfmake definition out, no I/O and no clock. Every cell arrives as the text it prints: turning
 * the register's rows, the filter and the clock into that text is the caller's, and the bytes are
 * `render.ts`'s.
 *
 * `InvoiceRegisterData` is owned HERE (the posting register's precedent), so this file imports
 * nothing from the service layer.
 *
 * Internal paper, a download only (owner ruling 592-2): nothing stores it, so it has no template
 * type. Its layout is fixed: the one the owner approved on the draft render of 2026-10-21 (plan
 * Amendment 8). Landscape letter; the title, the filter line and the Made line; the Excel's ten
 * columns (Amendment 4), ruled, with the header row repeated at the top of every page; a blank row,
 * then the summary row, its words across the first seven columns and the sum under Total
 * (Amendment 5); `Page N of M` at each page's foot. With no rows the table holds one row reading
 * `No invoices` centred across the ten columns, then the blank row and the summary (Amendments 9, 13
 * and 15). A row never splits across a page break (`dontBreakRows`, owner, 2026-10-21, Amendment 16):
 * one the page's foot would cut moves whole to the next page. pdfmake prints a row taller than a page
 * on no page at all, so the mapping prints a line break inside a cell as a space (Amendment 17; every
 * character of the #522 set since R15, #672, `oneLine` in src/lib/line-break.ts) and a row wraps only
 * by width; an invoice number prefix of absurd length is the one way left to a row that tall (a
 * residual).
 *
 * No `LAYOUT.steps` table, no keep-together id and no measured-row id: the first two send a definition
 * through `prepareTravelerLayout`, which measures a named page size as portrait letter, and a
 * measured-row id (`MEASURED_ROWS`) through `fitMeasuredRows`, which refuses a landscape page.
 */
import type { TableCell } from "pdfmake/interfaces";
import { LAYOUT, type RenderableDefinition } from "./render";

// ---------------------------------------------------------------------------------------------
// InvoiceRegisterData: the builder's whole input. Strings only, each the cell's printed text.
// ---------------------------------------------------------------------------------------------

/** One register row as it prints, in the Excel's column order. A blank cell is "". */
export type InvoiceRegisterPrintedRow = {
  documentNumber: string;
  kind: string;
  orderNumber: string;
  customerCode: string;
  customerName: string;
  invoiceDate: string;
  status: string;
  total: string;
  finalized: string;
  printed: string;
};

export type InvoiceRegisterData = {
  /** The applied filter, under the title. */
  filterLine: string;
  /** When the register was made, under the filter line. */
  madeLine: string;
  rows: InvoiceRegisterPrintedRow[];
  /** The summary row's words under Document No, and its sum under Total. */
  summaryLabel: string;
  summaryTotal: string;
};

const COLUMNS = 10;
/** The summary row's words span the columns before Total. */
const BEFORE_TOTAL = 7;

const head = (text: string, alignment?: "right"): TableCell => ({ text, bold: true, ...(alignment ? { alignment } : {}) });
/** `count` empty cells: the placeholders a span covers, or a row with nothing in it. */
const blanks = (count: number): TableCell[] => Array.from({ length: count }, () => "");

export function buildInvoiceRegister(d: InvoiceRegisterData): RenderableDefinition {
  const body: TableCell[][] = [[
    head("Document No"), head("Kind"), head("Order No"), head("Customer Code"), head("Customer Name"),
    head("Invoice Date"), head("Status"), head("Total", "right"), head("Finalized"), head("Printed"),
  ]];
  for (const r of d.rows) {
    body.push([
      r.documentNumber, r.kind, r.orderNumber, r.customerCode, r.customerName,
      r.invoiceDate, r.status, { text: r.total, alignment: "right" }, r.finalized, r.printed,
    ]);
  }
  // Centred, as the screen's empty row is (owner, 2026-10-21).
  if (d.rows.length === 0) {
    body.push([{ text: "No invoices", colSpan: COLUMNS, alignment: "center" }, ...blanks(COLUMNS - 1)]);
  }
  body.push(blanks(COLUMNS));
  body.push([
    { text: d.summaryLabel, bold: true, colSpan: BEFORE_TOTAL }, ...blanks(BEFORE_TOTAL - 1),
    { text: d.summaryTotal, bold: true, alignment: "right" }, ...blanks(COLUMNS - BEFORE_TOTAL - 1),
  ]);
  return {
    pageSize: "LETTER",
    pageOrientation: "landscape",
    pageMargins: [24, 24, 24, 40],
    defaultStyle: { font: "Roboto", fontSize: 8.5 },
    content: [
      { text: "Invoice register", bold: true, fontSize: 13 },
      { text: d.filterLine, margin: [0, 2, 0, 0] },
      { text: d.madeLine, margin: [0, 2, 0, 8], color: "#444444" },
      {
        table: {
          headerRows: 1, dontBreakRows: true,
          widths: ["auto", "auto", "auto", "auto", "*", "auto", "auto", "auto", "auto", "auto"], body,
        },
        layout: LAYOUT.ruled,
      },
    ],
    pageFooterSpec: { kind: "pageNofM" },
  };
}
