/**
 * The invoice/credit template contract (spec §5.3), derived from `src/server/pdf/invoice.ts`'s
 * `buildInvoiceDefinition` — sections are the builder's stacked blocks in stack order, fields
 * are its printed labels and data-bound slots. ONE contract covers both kinds (spec §4.1:
 * `INVOICE` covers credits): the builder is kind-agnostic — "Invoice"/"Credit" is DATA (`title`,
 * off the row's own kind), so the title field here is value-only and a credit's paper differs
 * only in its number and signs.
 *
 * FROZEN COLUMNS ONLY (the frozen-paper rule, spec §5.3): every field maps onto
 * `InvoicePdfData`, which is built exclusively from the invoice row's frozen snapshot columns
 * plus the two sanctioned live identity reads (company / remit-to — spec §4.2: identity, not
 * layout). The contract-vs-`InvoicePdfData` walk in tests/template-contracts.test.ts pins the
 * mapping — a field with no frozen source cannot land.
 *
 * This contract is `negativeStyle`'s first real declarer (ruling 3): a credit's negative
 * amounts are what the knob formats. Today's value is `SIGN_AFTER_SYMBOL` — the 5A ruling's
 * "$-937.44", the sign between the "$" and the digits.
 *
 * Its canvas profile (`INVOICE_CANVAS`, design 2026-11-10 §4.1) was admitted in PR 1 of its lane ahead
 * of its paper; PR 3 put the docType in `CANVAS_PRINTS` (template-contracts/index.ts), so a layout is
 * accepted, printed and previewed, and a draft offers Design on a canvas.
 */
import { PRICE_SOURCE_LABELS } from "../invoice-constants";
import { defaultConfig, type CanvasProfile, type TemplateConfig, type TemplateContract } from "./types";
import { CANVAS_GRID } from "./canvas";
import { NET_WEIGHT } from "../weight-terms";

/** The invoice canvas's floors (design 2026-11-10 §4.1), measured by tests/invoice-templates.test.ts
 *  ("the invoice's canvas floors") on the flow's own nodes at the Standard's base size, each block's
 *  nodes counted by the wrapper rule (design §5.2: a one-node block's own margins zeroed, a
 *  several-node block's kept): INVOICE_ROW_FLOOR is one 9 pt line (the order strip's row, a part row
 *  and the PRICE heading, the least of the six blocks' one-line heights), the least across the four
 *  font families, rounded DOWN (a least height a block drawn one measured line tall meets);
 *  INVOICE_FIRST_TABLE_ROOM is the largest of the six blocks' rooms (the PRICE heading and one
 *  operation row with no detail line), in Roboto, rounded UP (room needed). */
export const INVOICE_ROW_FLOOR = 9;
export const INVOICE_FIRST_TABLE_ROOM = 35;

/** Each rows block's fixed parts at the contract's default grid plus one grid step (design 2026-11-10
 *  §4.1, call 11, its figures moved by the controller's answer 2 and the owner's ruling of 2026-11-10):
 *  the addresses' two "*" columns share the width equally, so each keeps the first one's 40 pt indent
 *  and a step, with the 12 pt gap between them (2 × (40 + 4.5) + 12 = 101, the owner's); the parts'
 *  and prices' fixed columns 52 + 66 + 84, the three 6 pt gaps between the four columns and the
 *  information cell's own 6 pt left margin inside its "*" column (230.5); the totals' 200 pt label,
 *  84 pt amount and two 6 pt gaps (300.5); the order strip's indent (52 + 6) and #590's 60 pt floor,
 *  counted as its fixed part (122.5). A literal in PR 1; PR 2 holds it to src/server/pdf/invoice.ts's
 *  exported widths. Since #971 (design §6.1, the controller's call C2) rule 4 reads the parts' and
 *  prices' least width from the column headers' own columns in the layout (`leastWidth`, through the
 *  profile's `gridGap` and `gridMargin`), so a column typed wider raises it; their 230.5 here is that
 *  figure at the contract's columns, read where no layout is handed. */
/** The order strip's indent past the column headers' Quantity column (the builder's
 *  `INVOICE_WIDTHS.stripIndentGap`) and the measured row's floor its fields need (render.ts'
 *  `MEASURED_ROW_FLOOR`), both held to the builder's constants by tests/invoice-canvas.test.ts. With a
 *  layout, the strip's least width follows the Quantity column's width (#971: `gridIndent`); its
 *  122.5 below is that figure at the contract's 52. */
export const INVOICE_STRIP_INDENT = { column: "col_qty", gap: 6, floor: 60 } as const;

/** The price block's PRICE heading, printed past the column headers' Quantity column by the strip's
 *  indent (the builder's `INVOICE_WIDTHS.stripIndentGap`, held to it by tests/invoice-canvas.test.ts)
 *  as a line of its own, outside the grid's columns. With a layout, the block's least width is at
 *  least that column's shown width, the indent and one grid step (#971, Codex review: the heading
 *  otherwise starts past a block drawn only as wide as its shown columns), no floor of its own. */
export const INVOICE_PRICE_INDENT = { column: "col_qty", gap: 6, floor: 0 } as const;

/** The totals' amount column at the grid's right edge (the column headers' Amount column, as the
 *  builder's `totalsBlock` reads it) and their fixed parts beside it: the 200 pt label and the two
 *  6 pt gaps (the builder's `INVOICE_WIDTHS.totalsLabel` and `totalsGap`, held to them by
 *  tests/invoice-canvas.test.ts). With a layout, the totals' least width follows a typed Amount
 *  column (#971); their 300.5 below is that figure at the contract's 84. */
export const INVOICE_TOTALS_EDGE = { column: "col_amount", fixed: 200 + 2 * 6 } as const;

export const INVOICE_LEAST_WIDTHS: Record<string, number> = {
  parties: 2 * (40 + CANVAS_GRID) + 12,
  order_strip: 122.5,
  parts: 230.5,
  price: 230.5,
  totals: 300.5,
};

/** The invoice's canvas profile (design 2026-11-10 §4.1): six blocks, in the flow's order (the
 *  addresses, a rows block; the column headers, a boxed column table whose four fields name the
 *  contract table "columns", `columnTable`; the order strip, the part rows, the price block and the
 *  totals, rows blocks printing under the column headers' grid, the order strip reading its left
 *  edge and the totals its right, `grid` and `gridEdge`, the part rows and the price block printing
 *  6 pt between their columns, `gridGap`, and the information cell's 6 pt margin, `gridMargin`, the
 *  builder's), nothing required, no barcode; every row of
 *  a block is never a field item, the Remit To box prints in a border, and no field prints on a rule.
 *  Its paper prints (`CANVAS_PRINTS`, template-contracts/index.ts). */
export const INVOICE_CANVAS: CanvasProfile = {
  paper: "invoice",
  tables: [
    { key: "parties", keyed: "section", heading: null, rows: true, printed: null },
    { key: "column_header", keyed: "section", heading: null, rows: false, printed: { kind: "boxed", copies: 1, head: { size: "base" } }, columnTable: "columns" },
    {
      key: "order_strip", keyed: "section", heading: null, rows: true, printed: null, grid: "column_header", gridEdge: "left",
      gridIndent: INVOICE_STRIP_INDENT,
    },
    { key: "parts", keyed: "section", heading: null, rows: true, printed: null, grid: "column_header", gridGap: 6, gridMargin: 6 },
    {
      key: "price", keyed: "section", heading: null, rows: true, printed: null, grid: "column_header", gridGap: 6, gridMargin: 6,
      gridIndent: INVOICE_PRICE_INDENT,
    },
    {
      key: "totals", keyed: "section", heading: null, rows: true, printed: null, grid: "column_header", gridEdge: "right",
      gridEdgeColumn: INVOICE_TOTALS_EDGE,
    },
  ],
  required: [],
  barcode: false,
  notFields: [
    "bill_to", "ship_to",
    "our_order_no", "your_po", "material", "process", "parts_heading",
    "part_qty", "part_identity", "part_each_weight", "part_total_weight",
    "price_heading", "price_description", "price_amount", "quote_source", "price_per", "minimum_charge", "setup_charge",
    "subtotal", "surcharge_rows", "charge_rows", "cert_row", "freight_row", "tax_row", "total",
  ],
  boxedFields: ["remit_to"],
  ruledFields: [],
  leastWidths: INVOICE_LEAST_WIDTHS,
  rowFloor: INVOICE_ROW_FLOOR,
  firstTableRoom: INVOICE_FIRST_TABLE_ROOM,
};

export const INVOICE_CONTRACT: TemplateContract = {
  docType: "INVOICE",
  name: "Invoice / credit",
  sections: [
    {
      // headerBlock — the big title over the company name, both centered. The title is DATA
      // (the row's kind), so its field is value-only.
      key: "header", name: "Header", hideable: true, reorderable: true,
      fields: [
        { key: "title", name: "Document title", defaultLabel: "", removable: true },
        { key: "company_name", name: "Company name", defaultLabel: "", removable: true },
      ],
    },
    {
      // identityBlock — Invoice No. / Invoice Date / Terms left (NO Page No. — the builder's
      // recorded 5A deviation), the boxed Remit To blob right. The builder's trailing
      // label-value spacing ("Invoice No.:  ") is alignment glue, not label content.
      key: "identity", name: "Invoice identity", hideable: true, reorderable: true,
      fields: [
        { key: "invoice_no", name: "Invoice number", defaultLabel: "Invoice No.:", removable: true },
        { key: "invoice_date", name: "Invoice date", defaultLabel: "Invoice Date:", removable: true },
        { key: "terms", name: "Terms", defaultLabel: "Terms:", removable: true },
        { key: "remit_to", name: "Remit-to box", defaultLabel: "Remit To", removable: true },
      ],
    },
    {
      // partiesBlock — the two frozen snapshot address stacks; "Billto:"/"Shipto:" are the
      // sample's own spellings.
      key: "parties", name: "Bill to / ship to", hideable: true, reorderable: true,
      fields: [
        { key: "bill_to", name: "Bill-to address", defaultLabel: "Billto:", removable: true },
        { key: "ship_to", name: "Ship-to address", defaultLabel: "Shipto:", removable: true },
      ],
    },
    {
      // columnHeaderStrip — the one boxed strip naming the four data columns, widths
      // [52, "*", 66, 84]. Everything beneath (order strip, parts, prices, totals) is free-flow
      // text the builder aligns to these same widths, so THESE columns carry the width knobs and
      // the body fields below are value-only.
      key: "column_header", name: "Column headers", hideable: true, reorderable: true,
      fields: [
        {
          key: "col_qty", name: "Quantity column", defaultLabel: "Quantity", removable: true,
          column: { table: "columns", defaultWidth: 52 },
        },
        {
          key: "col_info", name: "Information column",
          defaultLabel: "Order Information / Part No. / Description / Pricing Information",
          removable: true, column: { table: "columns", defaultWidth: "*" },
        },
        {
          key: "col_each_weight", name: "Each weight column", defaultLabel: "Each weight",
          removable: true, column: { table: "columns", defaultWidth: 66 },
        },
        {
          key: "col_amount", name: "Amount column", defaultLabel: "Net weight / Price",
          removable: true, column: { table: "columns", defaultWidth: 84 },
        },
      ],
    },
    {
      // orderStrip — Our Order #, Your PO #, Material and Process on one line, in that order
      // whatever order the fields are kept in (owner ruling of 2026-10-20, #590), then the
      // underlined PARTS heading. Where a field's share of the line would be under 60 points (a
      // Quantity column set very wide), the shown fields print one to a line instead, and a line
      // break in one of the four values or their typed labels prints as one space (the owner's
      // amendment of 2026-10-21: `MEASURED_ROW_FLOOR` in src/server/pdf/render.ts,
      // `lineBreaksAsSpaces` in src/lib/line-break.ts).
      key: "order_strip", name: "Order strip", hideable: true, reorderable: true,
      fields: [
        { key: "our_order_no", name: "Order number", defaultLabel: "Our Order #:", removable: true },
        { key: "your_po", name: "Customer PO", defaultLabel: "Your PO #:", removable: true },
        { key: "material", name: "Material", defaultLabel: "Material:", removable: true },
        // Ruling 4's invoice half binds `part.processName` into the EXISTING processNames
        // snapshot at create time (spec §5.7) — the contract just declares the printed slot.
        { key: "process", name: "Process", defaultLabel: "Process:", removable: true },
        { key: "parts_heading", name: "Parts heading", defaultLabel: "PARTS", removable: true },
      ],
    },
    {
      // partsRows — one free-flow row per part under the strip's columns (value-only; the
      // widths live on column_header, see above).
      key: "parts", name: "Part rows", hideable: true, reorderable: true,
      fields: [
        { key: "part_qty", name: "Part quantity", defaultLabel: "", removable: true },
        { key: "part_identity", name: "Part identity", defaultLabel: "", removable: true },
        { key: "part_each_weight", name: "Each weight", defaultLabel: "", removable: true },
        { key: "part_total_weight", name: NET_WEIGHT, defaultLabel: "", removable: true },
      ],
    },
    {
      // priceBlock — the underlined PRICE heading, per-operation description + amount, the
      // centered detail lines beneath ("Price per <unit>:" is composed label + unit glue), and
      // the Phase 6 "Quote #N" source line (frozen `sourceQuoteNumber`; label root "Quote"). The
      // operations print grouped by their part line, in the PARTS list's order, those that lost
      // their part last, with a rule after each group that printed something (owner ruling of
      // 2026-10-20, #589). The builder does that for every template: no field, knob or default
      // here turns it on or off (589-2, no switch).
      key: "price", name: "Price block", hideable: true, reorderable: true,
      fields: [
        { key: "price_heading", name: "Price heading", defaultLabel: "PRICE", removable: true },
        { key: "price_description", name: "Operation name", defaultLabel: "", removable: true },
        { key: "price_amount", name: "Billed amount", defaultLabel: "", removable: true },
        {
          // The label root is PRICE_SOURCE_LABELS.QUOTE (invoice-constants.ts, client-safe) —
          // the aging-labels anti-drift rule: the builder prints from the same constant, so
          // contract and paper cannot drift (Task 2 review carry).
          key: "quote_source", name: "Quote source line",
          defaultLabel: PRICE_SOURCE_LABELS.QUOTE, removable: true,
        },
        { key: "price_per", name: "Per-unit price", defaultLabel: "Price per", removable: true },
        {
          key: "minimum_charge", name: "Minimum charge", defaultLabel: "Minimum Charge:",
          removable: true,
        },
        { key: "setup_charge", name: "Setup charge", defaultLabel: "Setup Charge:", removable: true },
      ],
    },
    {
      // totalsBlock — Sub Total, the named per-line rows (their descriptions are frozen line
      // data), the bold Total Amount Due.
      key: "totals", name: "Totals", hideable: true, reorderable: true,
      fields: [
        { key: "subtotal", name: "Subtotal", defaultLabel: "Sub Total Amount:", removable: true },
        { key: "surcharge_rows", name: "Surcharge lines", defaultLabel: "", removable: true },
        { key: "charge_rows", name: "Charge lines", defaultLabel: "", removable: true },
        { key: "cert_row", name: "Certification line", defaultLabel: "", removable: true },
        { key: "freight_row", name: "Freight line", defaultLabel: "", removable: true },
        { key: "tax_row", name: "Sales-tax line", defaultLabel: "", removable: true },
        { key: "total", name: "Total due", defaultLabel: "Total Amount Due:", removable: true },
      ],
    },
    {
      // footerBlock — the static per-page strip: address left, the sample's own "Contact:
      // Accounts Receivable" center (a pure label — no data behind it), phone right.
      key: "footer", name: "Page footer strip", hideable: true, reorderable: true,
      fields: [
        { key: "footer_address", name: "Company address", defaultLabel: "", removable: true },
        {
          key: "footer_contact", name: "Contact line",
          defaultLabel: "Contact: Accounts Receivable", removable: true,
        },
        { key: "footer_phone", name: "Company phone", defaultLabel: "Phone:", removable: true },
      ],
    },
  ],
  textBlocks: [], // the invoice carries no standing paragraph — its texts are all data or labels
  // `money()` prints "$937.44" / "$-937.44" (SIGN_AFTER_SYMBOL, 2 decimals, grouped thousands);
  // `longDate` prints "July 29, 2026" — "MMMM D, YYYY" is the fixed set's token for that long
  // FULL-month style (the Task 1 DATE_FORMATS note; Task 12 maps token → rendering).
  formats: {
    negativeStyle: "SIGN_AFTER_SYMBOL", priceDecimals: 2, thousandsSeparator: true,
    dateFormat: "MMMM D, YYYY",
  },
  // Today's builder: defaultStyle 9pt; the title (20pt) is the heading; 7.5pt is the footer
  // strip's fine print.
  fonts: { family: "Roboto", baseSize: 9, headingSize: 20, smallSize: 7.5 },
  canvas: INVOICE_CANVAS,
};

export const DEFAULT_CONFIG: TemplateConfig = defaultConfig(INVOICE_CONTRACT);
