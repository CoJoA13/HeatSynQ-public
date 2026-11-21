/**
 * The quotation's template contract (spec §5.3), derived from `src/server/pdf/quote.ts`'s
 * `buildQuoteDefinition` — sections are the builder's stacked blocks in stack order, fields are
 * its printed labels and data-bound slots.
 *
 * TWO defaults set this contract apart from its seven siblings, both because golden
 * compatibility means reproducing what the quote's builder ALREADY prints:
 *  - `pageFooter` defaults TRUE (the contract-level default, alone among the eight): the
 *    builder's footer callback prints "Page: N of M" today — Phase 6's sanctioned carve-out,
 *    which §6.1's declarative primitive replaces in Task 14.
 *  - `priceDecimals` defaults 4 where the invoice's is 2: unit and break prices print `money4`
 *    ("$0.055") — ruling Q7's accepted deviation, now an editable default. Quote prices are
 *    Decimal(12,4) and rounding them to cents would misstate the agreement.
 *
 * Unlike the invoice, no negative money ever prints on a quote, so `negativeStyle` is off this
 * surface entirely (the Task 1 knob-surface rule).
 *
 * Its canvas profile (`QUOTE_CANVAS`, design 2026-11-12 §4.1) was admitted in PR 1 of its lane ahead
 * of its paper; its paper prints since PR 2 (the docType is in `CANVAS_PRINTS`,
 * template-contracts/index.ts): a layout is accepted, a draft offers Design on a canvas, the seed
 * (`seedQuoteLayout`, src/server/quote-canvas-seed.ts) and the canvas preview
 * (`renderQuoteCanvasPreview`, src/server/template-preview.ts) run, and `printQuote` prints it.
 */
import { defaultConfig, type CanvasProfile, type TemplateConfig, type TemplateContract } from "./types";
import { CANVAS_GRID } from "./canvas";
import { NET_WEIGHT } from "../weight-terms";

/**
 * The two standing texts' code defaults, copied VERBATIM from `src/server/settings.ts`
 * (`quote_intro_text` / `quote_liability_text`) — copied, not imported: importing the server
 * module would drag Prisma into the client bundle (the SESSION_COOKIE keep-in-sync-by-hand
 * rule). The settings retire into template content in Task 14; until then the literals must
 * match. The liability block SHIPS EMPTY — the owner keys the shop's limited-liability wording,
 * and the builder omits the strip entirely when the text is "".
 */
const QUOTE_INTRO_TEXT_DEFAULT = "We are pleased to provide you with the following quotation:";
const QUOTE_LIABILITY_TEXT_DEFAULT = "";

/** The quote canvas's floors (design 2026-11-12 §4.1), measured by tests/quote-canvas-floors.test.ts
 *  on the flow's own nodes at the Standard's base size, each block's nodes counted by the wrapper rule
 *  (design §5.2: a one-node block's own margins zeroed, the several-node lines' and the liability's
 *  kept). A block's room is its first line of print (no quote block has a heading): the parties' first
 *  line (the left column's 10 pt inset and one line, beside the right column's first line and its
 *  1 pt); the intro's one line; the column headers' strip; the lines block's first grid row, its 2 pt
 *  kept and its stacked identity cut to its first line (design §4.1's first line of print; plan
 *  2026-11-12-quote-canvas-pr-1-profile's Departure 9; a line's Material, PRICE heading and price rows
 *  are later rows of the block); the closing's first line (the ending statement beside the signature's
 *  10 pt inset, rule and name); and the liability's line with its kept 10 pt, its start mark above
 *  that margin. QUOTE_ROW_FLOOR is the least of the six blocks' one-line heights (the intro's line in
 *  Liberation Serif), the least across the four font families, rounded DOWN (a least height a block
 *  drawn one measured line tall meets); QUOTE_FIRST_TABLE_ROOM is the largest of the six blocks' rooms
 *  (the closing's first line), in Roboto, rounded UP (room needed). Roboto's room stands for every
 *  family (the owner's 2026-11-12 ruling), although in Roboto Mono two blocks measure more than this
 *  room: the column headers' strip, which wraps (29.3 pt), and the closing's first line (26.19 pt). */
export const QUOTE_ROW_FLOOR = 10;
export const QUOTE_FIRST_TABLE_ROOM = 25;

/** The lines' Material line and PRICE heading, printed past the column headers' Quantity column by
 *  the information cell's margin (the builder's `ctx.qtyW + QUOTE_WIDTHS.infoIndent`, held to it by
 *  tests/quote-canvas.test.ts) as lines of their own, outside the grid's columns. With a layout, the
 *  lines' least width is at least that column's shown width, the indent and one grid step (#971,
 *  Codex review: they otherwise start past a block drawn only as wide as its shown columns), no
 *  floor of its own. */
export const QUOTE_LINES_INDENT = { column: "col_qty", gap: 6, floor: 0 } as const;

/** Each rows block's fixed parts plus one grid step (design 2026-11-12 §4.1, call 9): the parties'
 *  16 pt left inset, 12 pt gap and 220 pt quote fields (252.5); the lines' 52 + 66 + 84 fixed
 *  columns, the three 6 pt gaps and the information cell's own 6 pt left margin (230.5, the
 *  invoice's parts and prices figure); the closing's 12 pt gap and 230 pt signature column
 *  (246.5). The intro and the liability wrap at any width; the column headers take rule 9's 202.
 *  Literals, held to src/server/pdf/quote.ts's QUOTE_WIDTHS and the contract's column defaults by
 *  tests/quote-canvas.test.ts (since quote canvas PR 2). Since #971 (design §6.1, the controller's
 *  call C2) rule 4 reads the lines' least width from the column headers' own columns in the layout
 *  (`leastWidth`, through the profile's `gridGap` and `gridMargin`), so a column typed wider raises
 *  it; the lines' 230.5 here is that figure at the contract's columns, read where no layout is
 *  handed. */
export const QUOTE_LEAST_WIDTHS: Record<string, number> = {
  parties: 16 + 12 + 220 + CANVAS_GRID,
  lines: 52 + 66 + 84 + 3 * 6 + 6 + CANVAS_GRID,
  closing: 12 + 230 + CANVAS_GRID,
};

/** The quotation's canvas profile (design 2026-11-12 §4.1): six blocks, in the flow's order (the
 *  parties, a rows block; the intro, a list printing the quote_intro_text wording inside it,
 *  `textBlocks`; the column headers, a boxed column table whose four fields name the contract table
 *  "columns", `columnTable`; the lines, a rows block printing under the column headers' grid, 6 pt
 *  between its columns and the information cell's 6 pt margin, the builder's, `grid`, `gridGap` and
 *  `gridMargin`; the closing, a rows block; the
 *  liability, a list printing the quote_liability_text wording), nothing required, no barcode; every
 *  row of a block is never a field item, so the header's four fields are the canvas's, and no field
 *  prints in a border or on a rule. Its paper prints since PR 2 of its lane (`CANVAS_PRINTS`,
 *  template-contracts/index.ts). */
export const QUOTE_CANVAS: CanvasProfile = {
  paper: "quote",
  tables: [
    { key: "parties", keyed: "section", heading: null, rows: true, printed: null },
    { key: "intro", keyed: "section", heading: null, rows: false, printed: null, textBlocks: ["quote_intro_text"] },
    { key: "column_header", keyed: "section", heading: null, rows: false, printed: { kind: "boxed", copies: 1, head: { size: 9 } }, columnTable: "columns" },
    {
      key: "lines", keyed: "section", heading: null, rows: true, printed: null, grid: "column_header", gridGap: 6, gridMargin: 6,
      gridIndent: QUOTE_LINES_INDENT,
    },
    { key: "closing", keyed: "section", heading: null, rows: true, printed: null },
    { key: "liability", keyed: "section", heading: null, rows: false, printed: null, textBlocks: ["quote_liability_text"] },
  ],
  required: [],
  barcode: false,
  notFields: [
    "attn", "bill_to", "company_phone", "effective", "expires", "terms", "rfq_number", "customer_phone",
    "line_qty", "line_part", "line_each_weight", "line_total_lbs", "material", "price_heading", "step_name",
    "step_notes", "price_amount", "setup_charge", "price_per", "minimum_charge", "breaks", "surcharge_estimate",
    "ending_statement", "quote_notes", "signer_name", "signer_title",
  ],
  boxedFields: [],
  ruledFields: [],
  leastWidths: QUOTE_LEAST_WIDTHS,
  rowFloor: QUOTE_ROW_FLOOR,
  firstTableRoom: QUOTE_FIRST_TABLE_ROOM,
};

export const QUOTE_CONTRACT: TemplateContract = {
  docType: "QUOTE",
  name: "Quotation",
  sections: [
    {
      // headerBlock — the centered "Quotation" title over the company block, the quotation
      // number right.
      key: "header", name: "Header", hideable: true, reorderable: true,
      fields: [
        { key: "title", name: "Document title", defaultLabel: "Quotation", removable: true },
        { key: "company_name", name: "Company name", defaultLabel: "", removable: true },
        { key: "company_address", name: "Company address", defaultLabel: "", removable: true },
        {
          key: "quote_number", name: "Quotation number", defaultLabel: "Quotation Number:",
          removable: true,
        },
      ],
    },
    {
      // partiesBlock — the Attn/bill-to stack left, the info column right (phone, dates, terms,
      // RFQ, the contact's phone).
      key: "parties", name: "Attention / quote fields", hideable: true, reorderable: true,
      fields: [
        { key: "attn", name: "Attention line", defaultLabel: "Attn:", removable: true },
        { key: "bill_to", name: "Bill-to address", defaultLabel: "", removable: true },
        { key: "company_phone", name: "Company phone", defaultLabel: "Phone:", removable: true },
        { key: "effective", name: "Effective date", defaultLabel: "Effective:", removable: true },
        { key: "expires", name: "Expiry date", defaultLabel: "Expires On:", removable: true },
        { key: "terms", name: "Terms", defaultLabel: "Terms:", removable: true },
        {
          key: "rfq_number", name: "RFQ number", defaultLabel: "Your R.F.Q. Number:",
          removable: true,
        },
        {
          key: "customer_phone", name: "Customer phone", defaultLabel: "Your Phone No.:",
          removable: true,
        },
      ],
    },
    {
      // The intro line — renders the quote_intro_text text block; no fields of its own (the
      // shipper liability precedent).
      key: "intro", name: "Intro line", hideable: true, reorderable: true, fields: [],
    },
    {
      // columnHeaderStrip — the one boxed strip naming the four data columns, widths
      // [52, "*", 66, 84]; the line/price rows beneath are free-flow text aligned to these same
      // widths, so THESE columns carry the width knobs (the invoice's shape).
      key: "column_header", name: "Column headers", hideable: true, reorderable: true,
      fields: [
        {
          key: "col_qty", name: "Quantity column", defaultLabel: "Quantity", removable: true,
          column: { table: "columns", defaultWidth: 52 },
        },
        {
          key: "col_info", name: "Information column",
          defaultLabel: "Part No. / Description / Pricing Information", removable: true,
          column: { table: "columns", defaultWidth: "*" },
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
      // lineBlock — ONE section: the grid row, Material and the PRICE rows interleave PER LINE
      // (unlike the invoice's document-level parts-then-prices split), so they cannot be two
      // independently ordered sections. All value slots are free-flow (widths live on
      // column_header). "Price per <unit>:" and "<n> or more:" are composed label + glue.
      key: "lines", name: "Quote lines and prices", hideable: true, reorderable: true,
      fields: [
        { key: "line_qty", name: "Quoted quantity", defaultLabel: "", removable: true },
        { key: "line_part", name: "Part identity", defaultLabel: "", removable: true },
        { key: "line_each_weight", name: "Each weight", defaultLabel: "", removable: true },
        { key: "line_total_lbs", name: NET_WEIGHT, defaultLabel: "", removable: true },
        { key: "material", name: "Material", defaultLabel: "Material:", removable: true },
        { key: "price_heading", name: "Price heading", defaultLabel: "PRICE", removable: true },
        { key: "step_name", name: "Operation name", defaultLabel: "", removable: true },
        { key: "step_notes", name: "Quote notes line", defaultLabel: "", removable: true },
        { key: "price_amount", name: "Indicative amount", defaultLabel: "", removable: true },
        // The quote's builder prints these LOWERCASE ("Setup charge:") where the invoice's are
        // title-case — preserved exactly, per document.
        { key: "setup_charge", name: "Setup charge", defaultLabel: "Setup charge:", removable: true },
        { key: "price_per", name: "Per-unit price", defaultLabel: "Price per", removable: true },
        {
          key: "minimum_charge", name: "Minimum charge", defaultLabel: "Minimum charge:",
          removable: true,
        },
        { key: "breaks", name: "Quantity breaks", defaultLabel: "or more:", removable: true },
        // After the seed (#948): one estimate row per surcharge beneath the line's last price row.
        // A new removable non-column field in an existing section — backfilled visible.
        { key: "surcharge_estimate", name: "Surcharge estimate", defaultLabel: "(estimate)", removable: true },
      ],
    },
    {
      // footerContent — ending statement + printable notes left, the signature block right
      // (rule, quotedBy's name, title — ruling 14).
      key: "closing", name: "Closing and signature", hideable: true, reorderable: true,
      fields: [
        { key: "ending_statement", name: "Ending statement", defaultLabel: "", removable: true },
        { key: "quote_notes", name: "Quote notes", defaultLabel: "", removable: true },
        { key: "signer_name", name: "Signer name", defaultLabel: "", removable: true },
        { key: "signer_title", name: "Signer title", defaultLabel: "", removable: true },
      ],
    },
    {
      // The liability fine print — renders the quote_liability_text text block full-width
      // beneath the closing; no fields of its own.
      key: "liability", name: "Liability text", hideable: true, reorderable: true, fields: [],
    },
  ],
  textBlocks: [
    { key: "quote_intro_text", name: "Intro line", defaultText: QUOTE_INTRO_TEXT_DEFAULT },
    {
      key: "quote_liability_text", name: "Liability text",
      defaultText: QUOTE_LIABILITY_TEXT_DEFAULT,
    },
  ],
  // `money4` prints unit/break prices at up to 4 decimals (the priceDecimals default — see the
  // file comment); `num()`/`qty()` group thousands; every printed date is `paddedDate`
  // ("06/30/2018"). No negative money ever prints, so negativeStyle is off this surface.
  formats: { priceDecimals: 4, thousandsSeparator: true, dateFormat: "MM/DD/YYYY" },
  // Today's builder: defaultStyle 9pt; "Quotation" (20pt) is the heading; 6.5pt is the liability
  // fine print.
  fonts: { family: "Roboto", baseSize: 9, headingSize: 20, smallSize: 6.5 },
  // The builder's footer callback prints "Page: N of M" today — the one contract whose default
  // reproduces a page footer (see the file comment).
  pageFooter: true,
  canvas: QUOTE_CANVAS,
};

export const DEFAULT_CONFIG: TemplateConfig = defaultConfig(QUOTE_CONTRACT);
