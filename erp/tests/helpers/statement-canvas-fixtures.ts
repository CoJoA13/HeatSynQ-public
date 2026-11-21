import { STATEMENT_CONTRACT, STATEMENT_ROW_FLOOR } from "@/lib/template-contracts/statement";
import { defaultTableColumns } from "@/lib/template-canvas";
import { CANVAS_GRID, type CanvasAnchor, type CanvasBox, type CanvasItem, type CanvasLayout } from "@/lib/template-contracts/canvas";
import { layoutOf } from "./canvas-fixtures";
import type { StatementData } from "@/server/pdf/statement";

type Over<K extends CanvasItem["kind"]> = Partial<Extract<CanvasItem, { kind: K }>>;

/** A statement field item, page-top at the left margin, 200 × 12, unless `over` says otherwise. */
export function statementField(key: string, over: Over<"field"> = {}): Extract<CanvasItem, { kind: "field" }> {
  return {
    id: `field-${key}`, kind: "field", key, label: null,
    box: { x: 24, y: 24, w: 200, h: 12 }, anchor: { kind: "page-top" }, repeat: false,
    style: { size: 10, bold: false, align: "left" }, ...over,
  };
}

export type StatementTable = "bill_to" | "open_items" | "aging" | "finance_charge" | "total";
const STACK: StatementTable[] = ["bill_to", "open_items", "aging", "finance_charge", "total"];

/** The identity row (`standardStatementLayout`): the customer (72..84, repeated) at x 85.5, clear of
 *  the "(continued)" box (x 24 to 84), and the statement date (86..98) at x 64 (the flow's 40 pt
 *  indent), each ending at 326, 12 pt (the flow's column gap) short of the Remit To box at x 338, 250
 *  wide, 72 to 139.5 (67.5 pt: its 13 pt label, the 10 pt company name and two 10 pt address lines,
 *  with the box's own margins and rules, which the flow lays out 63.99 pt tall in Roboto, rounded up
 *  to the grid). The height holds for the Standard's Roboto only: the flow lays the box out 70.31 pt
 *  tall in Roboto Mono, past 67.5, so a printed canvas in another family (PR 2) measures it again
 *  before reusing this box. */
const CUSTOMER: CanvasBox = { x: 85.5, y: 72, w: 240.5, h: 12 };
const STATEMENT_DATE: CanvasBox = { x: 64, y: 86, w: 262, h: 12 };
const REMIT_TO: CanvasBox = { x: 338, y: 72, w: 250, h: 67.5 };
const REMIT_BOTTOM = REMIT_TO.y + REMIT_TO.h; // 139.5

/** The standard stack's drawn boxes. The Bill To from the statement date's bottom (98) to the Remit To
 *  box's bottom (139.5), 41.5 pt, taller than STATEMENT_FIRST_TABLE_ROOM (32), at x 64, 262 wide,
 *  beside the box; a case that needs a floor-tall Bill To passes `box.h` through `over`. The four
 *  blocks below at x 24, 564 wide and STATEMENT_ROW_FLOOR (F) tall, each top two grid steps under the
 *  bottom of the block before it (the open items' under the Bill To's, 139.5 + 9 = 148.5). With F = 13
 *  the tops are 98, 148.5, 170.5, 192.5 and 214.5, and the total ends at 227.5. */
function stackBoxes(): Record<StatementTable, CanvasBox> {
  const boxes = {} as Record<StatementTable, CanvasBox>;
  const billTop = STATEMENT_DATE.y + STATEMENT_DATE.h;
  boxes.bill_to = { x: STATEMENT_DATE.x, y: billTop, w: STATEMENT_DATE.w, h: REMIT_BOTTOM - billTop };
  let top = REMIT_BOTTOM + 2 * CANVAS_GRID;
  for (const key of STACK.slice(1)) {
    boxes[key] = { x: 24, y: top, w: 564, h: STATEMENT_ROW_FLOOR };
    top += STATEMENT_ROW_FLOOR + 2 * CANVAS_GRID;
  }
  return boxes;
}

/** A statement block at its slot in the standard stack (`stackBoxes`), anchored below the block before
 *  it (the Bill To page-top), its columns the contract's (`defaultTableColumns`, never a literal: the
 *  rows blocks' rows, the aging's seven columns, none for the Bill To). */
export function statementTable(key: StatementTable, over: Over<"table"> = {}): Extract<CanvasItem, { kind: "table" }> {
  const i = STACK.indexOf(key);
  const anchor: CanvasAnchor = i === 0 ? { kind: "page-top" } : { kind: "below-table", table: STACK[i - 1] };
  return {
    id: `table-${key}`, kind: "table", key, heading: null, columns: defaultTableColumns(STATEMENT_CONTRACT, key),
    box: { ...stackBoxes()[key] }, anchor, repeat: false, ...over,
  };
}

/**
 * The statement's standard arrangement, all inside the usable area (24..588 across, 24..768 down),
 * passing every canvas rule and warning of nothing with no measure and the page line off, the finance
 * and total blocks at least their STATEMENT_LEAST_WIDTHS entry wide, and no two drawn boxes
 * overlapping. Page-top: the title (24..48, the heading size, bold, centred) and the company name
 * (50..68, 15, bold, centred) across the content; the customer (72..84 at x 85.5, 240.5 wide,
 * repeated on every page), so it ends 14 pt above the Bill To's top (98), more than one grid step,
 * and lies clear of "(continued)" at the repeat band's bottom-left (x 24..84, 74..84) and of the
 * Remit To box; the statement date (86..98) at x 64, 262 wide; the Remit To box (72..139.5) at x 338,
 * 250 wide. The Bill To (98..139.5, x 64..326) beside the box, holding its height, and the four blocks
 * below (`stackBoxes`). No band.
 *
 * The no-overlap proof runs through `canvasWarnings`, which skips block pairs; rule 5 (the stacking
 * rule) refuses any two blocks overlapping in y, so the blocks are judged by stacking.
 */
export function standardStatementLayout(): CanvasLayout {
  const across = { x: 24, w: 564 };
  const header: CanvasItem[] = [
    statementField("title", {
      box: { ...across, y: 24, h: 24 }, style: { size: STATEMENT_CONTRACT.fonts.headingSize, bold: true, align: "center" },
    }),
    statementField("company_name", { box: { ...across, y: 50, h: 18 }, style: { size: 15, bold: true, align: "center" } }),
  ];
  const identity: CanvasItem[] = [
    statementField("customer", { box: { ...CUSTOMER }, repeat: true }),
    statementField("statement_date", { box: { ...STATEMENT_DATE } }),
    statementField("remit_to", { box: { ...REMIT_TO } }),
  ];
  return layoutOf([...header, ...identity, ...STACK.map((key) => statementTable(key))]);
}

/** The statement the flow's goldens print, a copy of tests/statement-pdf.test.ts's `sampleData`
 *  (that file keeps its own, the invoice's `sampleInvoice` precedent): a three-line bill-to, one
 *  open invoice and one open credit, an aging row with an unapplied credit, no finance charge.
 *  `overrides` replace whole keys. */
export function sampleStatement(overrides: Partial<StatementData> = {}): StatementData {
  return {
    asOf: "2026-08-08",
    company: {
      name: "Example Heat Treating - Alabama, LLC",
      address: "100 Example Way\nAnniston AL 36207", phone: "256-555-0100",
    },
    remitTo: {
      name: "Example Heat Treating - Alabama, LLC",
      lines: ["100 Example Way", "Anniston AL 36207"],
    },
    customer: {
      code: "C100", name: "Demo Foundry - Columbus LLC",
      billTo: ["Demo Foundry - Columbus LLC", "500 Example Street", "Columbus GA 31902-0096"],
    },
    openItems: [
      { documentNumber: "7 - 92026", date: "2026-06-29", dueDate: "2026-06-29", kind: "INVOICE", original: 1000, open: 400 },
      { documentNumber: "1000", date: "2026-07-19", dueDate: null, kind: "CREDIT", original: -200, open: -200 },
    ],
    aging: {
      customerId: "cust-1", customerCode: "C100", customerName: "Demo Foundry - Columbus LLC",
      current: 0, d1_30: 0, d31_60: 400, d61_90: 0, d90_plus: 0, unapplied: 200, net: 200,
    },
    financeCharge: null,
    totalDue: 200,
    ...overrides,
  };
}

/**
 * The statement the ruled-paper cases (tests/statement-canvas.test.ts) and the seed's golden
 * (tests/statement-canvas-seed.test.ts)
 * print: R14's name line ("Accounts Payable") stacked over `sampleStatement`'s three-line bill-to,
 * so the customer's name prints on the Customer line and again in the Bill To block; two open
 * invoices; an open credit and an on-account payment, each with no due date and negative money;
 * an aging row with every bucket and Unapplied non-zero (owner ruling 8), its Net the buckets less
 * Unapplied and Total Due that Net (#162: the finance charge is excluded); and a finance charge of
 * 12.34. Every amount and date but Total Due, which is Net and prints its figure, differs from every
 * other, so a case can find each other one by its text alone (Net + 12.34 is printed by nothing). `overrides` replace whole keys.
 */
export function richStatement(overrides: Partial<StatementData> = {}): StatementData {
  const base = sampleStatement();
  const aging = {
    ...base.aging,
    current: 1000, d1_30: 250.5, d31_60: 400, d61_90: 75.25, d90_plus: 1200, unapplied: 550,
    net: 1000 + 250.5 + 400 + 75.25 + 1200 - 550,
  };
  return {
    ...base,
    customer: { ...base.customer, billTo: ["Accounts Payable", ...base.customer.billTo] },
    openItems: [
      { documentNumber: "7 - 92026", date: "2026-03-02", dueDate: "2026-04-01", kind: "INVOICE", original: 1840, open: 1450.75 },
      { documentNumber: "7 - 92031", date: "2026-07-10", dueDate: "2026-08-09", kind: "INVOICE", original: 2412.5, open: 1475 },
      { documentNumber: "1000", date: "2026-07-19", dueDate: null, kind: "CREDIT", original: -200, open: -125.5 },
      { documentNumber: "CHK 4417", date: "2026-07-25", dueDate: null, kind: "PAYMENT", original: -500, open: -424.5 },
    ],
    aging,
    financeCharge: 12.34,
    totalDue: aging.net,
    ...overrides,
  };
}
