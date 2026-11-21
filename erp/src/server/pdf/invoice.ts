/**
 * The invoice / credit (P5A design spec §10). PURE by construction, the traveler.ts contract:
 * `InvoicePdfData` + a validated `TemplateConfig` in, a plain-JSON pdfmake definition out — no I/O,
 * no clock, nothing that would not survive `JSON.parse(JSON.stringify())` (asserted in
 * tests/invoice-pdf.test.ts). The reads live in invoices.ts (`readInvoicePdfData`), the bytes in
 * render.ts.
 *
 * A CONFIG-CONSUMER since Phase 7 Task 12 (P7 spec §5.4) — the BOL/cert lens (`sectionView` over
 * `completeSections`, the §5.6 belt in both halves): sections/fields/labels/widths/fonts/formats/
 * logo render from a validated config. At the conversion the default config reproduced the earlier
 * paper exactly (the golden gate, tests/invoice-pdf.test.ts). Owner rulings have changed that paper
 * since, each recorded in the deviation list below: the heading and the weights' unit (W14, W15),
 * the order strip on one line (#590) and a rule after each part's prices (#589).
 *
 * **THE FROZEN-PAPER RULE IS THE DEFINING CONSTRAINT** (CLAUDE.md; ruling 24's refinement). This is
 * the OPPOSITE snapshot rule from the cert/shipper: `InvoicePdfData` is built exclusively from the
 * invoice row's FROZEN snapshot columns (invoices.ts's `readInvoicePdfData`), read UNCONDITIONALLY —
 * never re-joined to a live customer address, part name, or re-priced amount. The config controls
 * placement/labels/widths/fonts/formats/logo over that frozen data; a template edit changes future
 * invoices' layout, never a raised invoice's numbers. This builder introduces NO live re-join — it
 * maps config over the frozen data it is handed, and there is no live-join-first-with-fallback
 * branch (a draft edit replaces the whole line array — §5.5 — so there is nothing to fall back to).
 *
 * ONE contract, one builder, BOTH kinds (spec §4.1: `INVOICE` covers credits). The builder is
 * kind-agnostic — "Invoice"/"Credit" is DATA (`title`, off the row's own kind), the credit's
 * negative amounts are what the `negativeStyle` knob formats (ruling 3), and a credit's paper
 * differs only in its number and signs.
 *
 * Layout mirrors the original Visual Shop invoice the owner delivered as the layout contract (the
 * Phase 4 design's §3.1), private material kept outside Git. `docs/samples/Invoice Sample.pdf` is
 * its fictional replacement, an example of an invoice's fields that does not show this layout (no
 * Remit To box, no order strip, no "Contact:" footer); "the sample" in this file's comments names
 * the original. Deviations from the original are individually commented; there are no silent ones:
 *  - the header logo is Phase 7's (spec §6.3) — off by default (the owner supplied none): a config
 *    that places one joins the centered header stack (center) or a side column (left/right).
 *  - no "Page N of M" by default — a page count is not knowable to a pure-JSON definition, and a
 *    hard-coded "1 of 1" would lie the moment a long invoice wraps (the ticket's/cert's identical
 *    deviation, spec §10, owner ping #1). The `pageFooter` knob (spec §6.1) turns the real per-page
 *    count on when a template wants it.
 *  - **`Process:` prints the create-time `processNames` snapshot** (spec §5.7, ruling 4): the lead
 *    part's `processName` when non-blank, else its priced operations comma-joined — snapshotted at
 *    create in invoices.ts, read here from the frozen column. The builder just prints the string.
 *  - the footer's "Contact: Accounts Receivable" is the original's own static strip; the trailing
 *    empty "Fax:" label has no field behind it in this model — not printed (the cert's precedent).
 *  - the original's stray "1" beside "Remit To" and "9827" beside "Shipto" are Visual Shop's
 *    internal row ids (the ticket's ruling on the same artifact) — not printed.
 *  - the fourth heading is the contract's built-in "Net weight / Price", which was
 *    "Total Wt / Price" until owner ruling W14 of 2026-10-09, and a part row's each weight and net
 *    weight print with their unit, "21.00 lb" and "3,024.00 lb" (owner ruling W15 of the same
 *    day). The unit comes from `lb` of ./printed-weight. A blank weight prints no unit. The
 *    figures are the invoice's frozen columns, as before.
 *  - the order strip prints Our Order #, Your PO #, Material and Process on ONE line, by owner
 *    ruling of 2026-10-20 (#590), where the original prints them on two, and one field to a line
 *    where the line is too narrow to share it (the owner's amendment of 2026-10-21). Every invoice
 *    and credit-memo template prints it so from its next print, with no switch; `orderStrip` says
 *    how.
 *  - the prices print grouped by their part line, in the PARTS list's order, those that lost their
 *    part last, with a thin rule after each group, by owner ruling of 2026-10-20 (#589), where this
 *    builder printed every price as one list from Phase 5A on. The original it was built to, the
 *    owner's order 92026 of one part and one priced operation, prints no line above Sub Total; how
 *    the original prints several parts' prices is not recorded. Every invoice and credit-memo
 *    template prints them so from its next print, with no switch; `priceBlock` says how.
 */
import type { Column, Content, ContentTable, TableCell } from "pdfmake/interfaces";
import { LAYOUT, type RenderableDefinition } from "./render";
import { inBoxFlowSection } from "./flow-tables";
import type { ItemContent } from "./canvas-sheet";
import { mark, spacer } from "./canvas-nodes";
import { buildCanvasInvoiceDefinition, firstInvoiceItemContent } from "../invoice-canvas";
import { lb } from "./printed-weight";
import { lineBreaksAsSpaces } from "../../lib/line-break";
import { INVOICE_CONTRACT, DEFAULT_CONFIG } from "../../lib/template-contracts/invoice";
import type { CanvasTextStyle } from "../../lib/template-contracts/canvas";
import {
  completeSections,
  type FontsConfig, type FormatsConfig, type LogoPlacement, type SectionConfig,
  type TemplateConfig,
} from "../../lib/template-contracts/types";

// ---------------------------------------------------------------------------------------------
// InvoicePdfData — the builder's whole input. Plain data: no Decimals, no Dates, no Prisma rows.
// `billTo`/`shipTo` are the FROZEN snapshot lines (Invoice.billTo/shipTo, split on newline): an
// invoice is frozen paper (invoices.ts's `toLineDetail` rule), so these are what was billed, never
// a live re-read of the customer's current address; since R14 (#671) a `billTo` written at create
// may open with the bill-to row's name above the customer's, and earlier invoices keep their lines.
// `remitTo` is the plant's own remit address,
// read live from company settings (it is not frozen per-invoice) — see `invoicePrintSettings`.
// The contract maps its fields ONLY onto these frozen columns — do not widen it.
// ---------------------------------------------------------------------------------------------

export type InvoiceCompany = { name: string; address: string; phone: string };
export type InvoiceRemitTo = { name: string; lines: string[] };
export type InvoicePart = {
  qty: number | null; partNumber: string; partName: string; partDescription: string;
  eachWeight: number | null; totalWeight: number | null;
};
/** One priced operation: its name and billed amount, with the per-unit price and the minimum /
 *  setup shown beneath, a row of spec §10's PRICE grid as its amendment of 2026-10-21 has it: the
 *  grid prints the rows grouped by their part (`partIndex`), with a rule after each group (#589,
 *  owner ruling of 2026-10-20; `priceBlock`), where this builder printed them as one list. A
 *  null `unitPrice`/`minimumCharge`/`setupCharge` prints no line for that detail rather than a
 *  fabricated "$0.00". `sourceQuoteNumber` is the Phase 6 tier-1 source (quoting spec §5.3, off
 *  `InvoiceLine.sourceQuoteNumber`'s FROZEN column): when set, "Quote #N" prints beneath the
 *  operation — §7.5's "every line names its source". Absent/null (every part-priced or manual
 *  line) prints nothing, keeping those rows byte-identical to the approved 5A sample. */
export type InvoicePriceRow = {
  description: string; pricePerLabel: string;
  unitPrice: number | null; minimumCharge: number | null; setupCharge: number | null;
  sourceQuoteNumber?: number | null;
  amount: number;
  /** The index in `InvoicePdfData.parts` of the PART line this operation's saved `parentLineId`
   *  names (#589, owner ruling of 2026-10-20): its tie, never its position on the invoice nor its
   *  order line. `null` when the parent is null, names no line of this invoice, or names a line that
   *  is not a PART line (an operation, a charge, itself): such a price has lost its part. One level,
   *  never a walk up a chain of parents. Required, so every producer and fixture states it. */
  partIndex: number | null;
};
/** A named money line — one surcharge/charge, or the single cert/freight/tax row. */
export type InvoiceAmountRow = { description: string; amount: number };
export type InvoicePdfData = {
  company: InvoiceCompany;
  remitTo: InvoiceRemitTo;
  billTo: string[];
  shipTo: string[];
  title: string;                       // "Invoice" or "Credit" — the invoice row's own kind
  documentNumber: string;              // "7 - 92026", or the bare credit number for a CREDIT
  invoiceDate: string;                 // "yyyy-mm-dd" — formatted to the sample's long style below
  termsName: string;
  orderNumber: number;
  poNumber: string;
  materialName: string;
  processNames: string;
  parts: InvoicePart[];
  priceRows: InvoicePriceRow[];
  subtotal: number;
  surchargeRows: InvoiceAmountRow[];
  chargeRows: InvoiceAmountRow[];
  certRow: InvoiceAmountRow | null;
  freightRow: InvoiceAmountRow | null;
  taxRow: InvoiceAmountRow | null;
  total: number;
};

// ---------------------------------------------------------------------------------------------
// Formatting. Pure, config-driven (P7 spec §5.4), locale pinned (the traveler's own rule) so output
// never tracks the server's.
// ---------------------------------------------------------------------------------------------

/** Money with a leading "$", `priceDecimals` decimals and `thousandsSeparator` grouping. The
 *  `negativeStyle` knob (ruling 3 — the invoice contract is its first real declarer) formats a
 *  credit's negative amounts: `SIGN_AFTER_SYMBOL` (default) is today's "$-937.44" — the sign between
 *  the "$" and the digits so magnitude and sign both read at a glance; `LEADING_MINUS` is "-$937.44";
 *  `PARENTHESES` is "($937.44)". The default knobs reproduce today's `money()` byte-for-byte. */
function makeMoney(formats: FormatsConfig): (value: number) => string {
  const decimals = formats.priceDecimals ?? 2;
  const useGrouping = formats.thousandsSeparator !== false;
  const style = formats.negativeStyle ?? "SIGN_AFTER_SYMBOL";
  return (value) => {
    const magnitude = Math.abs(value).toLocaleString("en-US", {
      minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping,
    });
    if (value >= 0) return `$${magnitude}`;
    switch (style) {
      case "LEADING_MINUS": return `-$${magnitude}`;
      case "PARENTHESES": return `($${magnitude})`;
      default: return `$-${magnitude}`; // SIGN_AFTER_SYMBOL — today's
    }
  };
}

/** A weight, always two decimals, no "$" — the sample's "3,024.00" / "21.00" style. Grouping rides
 *  the `thousandsSeparator` knob; the decimals are DATA PRECISION, not the price knob. */
function makeWeight(formats: FormatsConfig): (value: number) => string {
  const useGrouping = formats.thousandsSeparator !== false;
  return (value) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping });
}

/** A quantity, integer, thousands-grouped per the knob — "144", "1,440". */
function makeQty(formats: FormatsConfig): (value: number) => string {
  const useGrouping = formats.thousandsSeparator !== false;
  return (value) => value.toLocaleString("en-US", { maximumFractionDigits: 0, useGrouping });
}

const MONTHS_FULL = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The Invoice Date, driven by the contract's ONE date knob (default "MMMM D, YYYY" — the sample's
 * own "July 29, 2026" long-FULL-month style). The paper's ONLY date slot (grep-verified: `longDate`
 * was the sole date renderer, one call site). Pure string work — parsing to a Date would drag a
 * timezone into a date-only value (src/lib/business-days.ts's whole point).
 */
function makeLongDate(formats: FormatsConfig): (iso: string) => string {
  const format = formats.dateFormat ?? "MMMM D, YYYY";
  return (iso) => {
    const [y, m, d] = iso.split("-");
    switch (format) {
      case "M/D/YYYY": return `${Number(m)}/${Number(d)}/${y}`;
      case "MM/DD/YYYY": return `${m}/${d}/${y}`;
      case "YYYY-MM-DD": return iso;
      case "MMM - DD - YYYY": return `${MONTHS_ABBR[Number(m) - 1]} - ${d} - ${y}`;
      default: return `${MONTHS_FULL[Number(m) - 1]} ${Number(d)}, ${y}`; // "MMMM D, YYYY" — the sample's
    }
  };
}

// ---------------------------------------------------------------------------------------------
// The config lens (P7 spec §5.4) — the BOL/cert `sectionView`, applied to the invoice's blocks. The
// builder ASSUMES a complete config (`validateConfig`'s §5.3 backfill guarantees every entry
// exists); only the null-means-contract-default knobs a complete config still carries resolve here.
//
// THE §5.6 BELT, both halves: the flag half (`visible || !hideable` / `visible || !removable`) is
// the BOL's expression verbatim — NOTHING on this contract is locked, so it forces nothing and a
// config may hide anything; the omission half is `completeSections` in `buildInvoiceDefinition`
// below, so a raw config that OMITS an entry still renders it. The invoice carries no text blocks
// (its texts are all data or labels), so the BOL's third, text-block half is absent here.
// ---------------------------------------------------------------------------------------------

const CONTRACT_SECTIONS = new Map(INVOICE_CONTRACT.sections.map((s) =>
  [s.key, { section: s, fields: new Map(s.fields.map((f) => [f.key, f])) }] as const));

type FieldView = { visible: boolean; label: string; width: number | "*" };
/** One section of a complete config seen through the contract: the §5.6 belt's flag half applied. */
export type InvoiceSectionView = {
  visible: boolean;
  /** Field keys in config (= display) order; per-field visibility still applies at use. */
  order: string[];
  field: (key: string) => FieldView;
};

type SectionView = InvoiceSectionView;

function sectionView(sc: SectionConfig): SectionView {
  const cs = CONTRACT_SECTIONS.get(sc.key);
  // Unknown keys were refused by the validator before any config could be stored; a miss here
  // is a caller bug, not a config state.
  if (cs === undefined) throw new Error(`Unknown INVOICE template section "${sc.key}"`);
  const byKey = new Map(sc.fields.map((f) => [f.key, f]));
  return {
    visible: sc.visible || !cs.section.hideable, // the belt, section half (nothing locked here)
    order: sc.fields.map((f) => f.key),
    field: (key) => {
      const cf = cs.fields.get(key);
      if (cf === undefined) throw new Error(`Unknown INVOICE template field "${sc.key}.${key}"`);
      const fc = byKey.get(key);
      return {
        visible: (fc?.visible ?? true) || !cf.removable, // the belt, field half
        label: fc?.label ?? cf.defaultLabel,
        width: fc?.width ?? cf.column?.defaultWidth ?? "*",
      };
    },
  };
}

/** The four data columns the sample's boxed header strip names — every body block (parts, prices,
 *  totals) aligns to these same widths, defined ONCE by the `column_header` section. */
type Slot = "qty" | "info" | "each" | "amt";
const COLUMN_FIELD: Record<string, Slot> = {
  col_qty: "qty", col_info: "info", col_each_weight: "each", col_amount: "amt",
};
/** The strip header cell alignment per slot (qty/info left, each/amt right — the sample's own). */
const HEADER_ALIGN: Record<Slot, "left" | "right"> = { qty: "left", info: "left", each: "right", amt: "right" };

type GridCol = { slot: Slot; width: number | "*"; label: string };

/** Everything a section renderer needs, threaded once instead of parameter-by-parameter. */
export type InvoiceCtx = {
  fonts: FontsConfig;
  money: (value: number) => string;
  weight: (value: number) => string;
  qty: (value: number) => string;
  date: (iso: string) => string;
  sections: Map<string, SectionView>;
  /** The numeric widths of the qty/each/amt columns (0 when that column is hidden) — the body
   *  blocks' spacers and indents read these so a width override flows through the whole page. */
  slotW: { qty: number; each: number; amt: number };
  /** Present only when the resolved version carries logo BYTES and the config PLACES them
   *  (spec §6.3) — either alone renders today's text-only header. */
  logo: { placement: LogoPlacement; width: number; dataUri: string } | null;
  /** Where the price block draws each rule after a group (`priceRule`): a canvas price block's
   *  inner stack starts at its drawn x, so its rules start at the left margin less that x and run
   *  the content width, back to the margin (design 2026-11-10 §5.2). The flow's ctx carries none: its rules run
   *  from 0 across `INVOICE_WIDTHS.content`. */
  priceRule?: { x1: number; length: number };
  /** The canvas seed's layout pass (`buildInvoiceDefinition`'s `seedIds`): when true the flow marks
   *  the pieces and blocks a canvas item stands for (`INVOICE_SEED_IDS`). Absent on every print and
   *  preview, and on every ctx `ctxOf` builds for the canvas, which render exactly the nodes they
   *  rendered before. */
  seed?: boolean;
};
type Ctx = InvoiceCtx;

/** The `column_header` section's visible column fields, in config order, with resolved widths and
 *  labels — the grid every body block aligns to. */
function gridColumns(ctx: Ctx): GridCol[] {
  const v = ctx.sections.get("column_header")!;
  return v.order
    .filter((k) => k in COLUMN_FIELD && v.field(k).visible)
    .map((k) => ({ slot: COLUMN_FIELD[k], width: v.field(k).width, label: v.field(k).label }));
}

const head = (text: string, align: "left" | "right"): TableCell => ({ text, bold: true, alignment: align });

/** Every fixed width the flow prints with (points); the canvas reads it through `INVOICE_FLOW`, and
 *  the profile's `INVOICE_LEAST_WIDTHS` and `boxedFields` (src/lib/template-contracts/invoice.ts) are
 *  held to it by tests/invoice-canvas.test.ts. The grid's fixed columns at the contract's defaults
 *  (`qty`, `each`, `amt`, the `slotW` fallbacks and the totals' amount fallback), the gap between
 *  the grid's columns and the information cell's own left margin; the order strip's indent past the
 *  Quantity column (the PARTS and PRICE headings take the same indent) and the gap between its
 *  fields; the addresses' first-column indent and their gap; the identity lines' indent, their gap
 *  to the Remit To column and that column's width; the totals' label column and gap; the header's
 *  gap beside a side logo; the footer strip's contact and phone columns; and the content width,
 *  LETTER (612 pt) less the 24 pt side margins, as cert.ts, bol.ts and shipping-ticket.ts state
 *  theirs. */
export const INVOICE_WIDTHS = {
  qty: 52, each: 66, amt: 84, gridGap: 6, infoMargin: 6,
  stripIndentGap: 6, stripGap: 12,
  partiesIndent: 40, partiesGap: 12,
  identityIndent: 40, identityGap: 12, remitTo: 250,
  totalsLabel: 200, totalsGap: 6,
  headerLogoGap: 8, footerContact: 180, footerPhone: 140, content: 564,
} as const;
const W = INVOICE_WIDTHS;

/** The flow's vertical page constants: the 44 pt bottom margin the company strip prints in, the
 *  strip's 6 pt inset below the body, and the continuation pages' 40 pt top margin. */
export const INVOICE_PAGE = { bottomMargin: 44, stripInset: 6, overflowTopMargin: 40 } as const;

/** The fields a canvas prints in a border at the item's box: the Remit To box, boxed on the flow's
 *  paper. The profile's `boxedFields` is held to it by tests/invoice-canvas.test.ts. */
export const INVOICE_BOXED_FIELDS = ["remit_to"] as const;

/** The rule after each part's prices (#589): its thickness, and the space above and below it, in
 *  points, as the owner ruled at the paper look of 2026-10-21 ("As shown"). Below the rule, the
 *  next price's row adds its own 3 points. */
const PRICE_RULE_WIDTH = 0.5;
const PRICE_RULE_ABOVE = 4;
const PRICE_RULE_BELOW = 1;

/** Every node `priceRule` has made, so `buildInvoiceDefinition` can tell a rule that ends the content
 *  by the node itself, never by its shape: another canvas line on the page would not be one. */
const priceRules = new WeakSet<object>();

/** A new rule node on each call: a canvas line from margin to margin, across the content width and
 *  never sized from the grid's columns, a top-level node of the flow's page, or inside a canvas price
 *  block's inner stack, offset back to the margin (design 2026-11-10 §5.2): the line runs from `x1` to
 *  `x1 + length`, and a block drawn at x hands `x1` as the left margin less x (24 − x; pdfmake
 *  strokes a line drawn from a negative x where it is drawn, past its block's edges: in the one canvas
 *  block shape, tests/invoice-canvas.test.ts, "a price block drawn at x 120, 300 wide strokes every
 *  rule from the left margin to the right one" and its neighbours; tests/render-primitives.test.ts's "a
 *  canvas line drawn from a negative x" cases build the margined stack #969 retired). New each time,
 *  never one node placed at several places: pdfmake moves a canvas line's own points in place as it
 *  lays the line out (`addVector` in its ElementWriter), and the page item it adds holds that same
 *  line, so one node laid out at three places draws all three times at one place, its own point moved
 *  by the sum of the three offsets. render.ts lays out a JSON copy of an invoice's content, in which
 *  such a node is three nodes, but the builder does not lean on that. `below` is the space under it:
 *  the owner's `PRICE_RULE_BELOW`, or 0 for the rule that ends the content (`buildInvoiceDefinition`). */
const priceRule = (below: number = PRICE_RULE_BELOW, x1: number = 0, length: number = W.content): Content => {
  const node: Content = {
    canvas: [{ type: "line", x1, y1: 0, x2: x1 + length, y2: 0, lineWidth: PRICE_RULE_WIDTH }],
    margin: [0, PRICE_RULE_ABOVE, 0, below],
  };
  priceRules.add(node);
  return node;
};

/** Whether `node` is a rule `priceRule` made: read from the `priceRules` set, never from its shape. */
const isPriceRule = (node: unknown): boolean => typeof node === "object" && node !== null && priceRules.has(node);

/**
 * The ids the invoice's canvas seed reads back from one layout of its stand-in (design 2026-11-10
 * §5.3), the certification's `CERT_SEED_IDS` shape: emitted only under `seedIds`, and never on a
 * TEXT node (pdfmake refuses two text nodes sharing an id in one document and makes a named
 * destination of a text id). A piece's id is on a wrapper stack around it (`seedPiece`), its `end`
 * mark after it inside that wrapper, BEFORE its bottom margin (moved onto the wrapper), so a piece's
 * box is its line alone; the logo's id is on its image; the Remit To box's wrapper keeps its
 * column's width and opens with a zero-size spacer, so it reports the box's own corner and not its
 * first cell's (`seedBox`). A block carries a `start` and a `sectionEnd` mark. A one-node section
 * (`parties`, `column_header`) takes the certification's one-node shape, its marks inside its node's
 * own vertical margins, which move onto an outer stack (`seedSection`). A several-node section
 * (`order_strip`, `parts`, `price`, `totals`) is NOT the certification's `seedSeveral` wrapper: its
 * two marks are TOP-LEVEL siblings around the section's own nodes (`seedSiblings`), so the order
 * strip's measured row stays an item of the top-level content array, where `fitMeasuredRows`
 * measures it, and the price block's rules stay top-level nodes the end-of-content belt can reach. A
 * visible section whose builder answers nothing still emits its two marks, as top-level siblings
 * (never an id-less stack), so the seed has a block to seed at the row floor. The block keys and
 * the piece keys never meet.
 */
export const INVOICE_SEED_IDS = {
  piece: (key: string) => `seed:${key}`,
  end: (key: string) => `seed:end:${key}`,
  start: (section: string) => `seed:start:${section}`,
  sectionEnd: (section: string) => `seed:end:${section}`,
} as const;

/** Every mark the seed has made, so the end-of-content belt tells a seed mark by the node itself,
 *  never by its shape (the `priceRules` rule). */
const seedMarks = new WeakSet<object>();

/** A seed mark (`mark`, src/server/pdf/canvas-nodes.ts), remembered in `seedMarks`. */
function seedMark(id: string): Content {
  const node = mark(id);
  seedMarks.add(node as object);
  return node;
}

/** Whether a top-level node is a seed mark, or a stack holding seed marks alone: either adds no
 *  height and prints nothing, so the end-of-content belt passes over it. */
function marksOnly(node: unknown): boolean {
  if (typeof node !== "object" || node === null) return false;
  if (seedMarks.has(node)) return true;
  const stack = (node as { stack?: unknown }).stack;
  return Array.isArray(stack) && stack.length > 0 && stack.every((n) => typeof n === "object" && n !== null && seedMarks.has(n));
}

type Margin4 = [number, number, number, number];

/** A node's margin as four figures (this flow states every margin it seeds as four, or none). */
function marginOf(node: object): Margin4 {
  const margin = (node as { margin?: unknown }).margin;
  return Array.isArray(margin) && margin.length === 4 ? margin as Margin4 : [0, 0, 0, 0];
}

/** A piece wrapped for the seed: its id on a stack around it, its vertical margins moved onto that
 *  stack and its end mark after it inside them, so the end mark reports the piece's bottom and not
 *  its margin's (the certification's `seedPiece`; it lays out the same). With no seed, the piece
 *  itself, unchanged. */
function seedPiece(ctx: Ctx, key: string, node: Content): Content {
  if (!ctx.seed) return node;
  const [l, t, r, b] = marginOf(node as object);
  return {
    id: INVOICE_SEED_IDS.piece(key),
    stack: [{ ...(node as object), margin: [l, 0, r, 0] } as Content, seedMark(INVOICE_SEED_IDS.end(key))],
    margin: [0, t, 0, b],
  } as Content;
}

/** The Remit To column wrapped for the seed: the column's width stays on the wrapper (the flow places
 *  the box in a `remitTo`-wide column; without the width the wrapper would lay the box out at a "*"
 *  width), a zero-size spacer first, so the wrapper reports the box's own top-left corner (pdfmake
 *  gives a stack its first child's first position, and a table's is its first cell's text, inside
 *  the border, the padding and the cell's margin), then the box and its end mark. With no seed, the
 *  column unchanged. */
function seedBox(ctx: Ctx, key: string, width: number, box: ContentTable): Column {
  if (!ctx.seed) return { width, ...box };
  return { width, id: INVOICE_SEED_IDS.piece(key), stack: [spacer(0), box, seedMark(INVOICE_SEED_IDS.end(key))] } as unknown as Column;
}

/** A one-node section under the seed (`parties`, `column_header`): one stack holding the node's
 *  vertical margins, its `start` mark, the node with its vertical margins moved off and its
 *  `sectionEnd` mark, so the two marks stand at the node's own top and bottom (a canvas block is
 *  drawn with that node's vertical margins zeroed). A section that answers no node emits its two
 *  marks alone, as top-level siblings, not the certification's id-less stack. A section that answers
 *  more than one node is refused by name under the seed (the bill of lading's `tableBlock` refusal),
 *  never cut to its first: the seed would drop a node the flow prints. With no seed, the nodes
 *  unchanged, and nothing refused, so no print reaches the refusal. Exported for its test. */
export function seedSection(ctx: Ctx, section: string, nodes: Content[]): Content[] {
  if (!ctx.seed) return nodes;
  if (nodes.length > 1) throw new Error(`An invoice one-node section answers one node; ${section} answered ${nodes.length}.`);
  if (nodes.length === 0) return [seedMark(INVOICE_SEED_IDS.start(section)), seedMark(INVOICE_SEED_IDS.sectionEnd(section))];
  const [node] = nodes;
  const [l, t, r, b] = marginOf(node as object);
  return [{
    stack: [
      seedMark(INVOICE_SEED_IDS.start(section)),
      { ...(node as object), margin: [l, 0, r, 0] } as Content,
      seedMark(INVOICE_SEED_IDS.sectionEnd(section)),
    ],
    margin: [0, t, 0, b],
  }];
}

/** A several-node section under the seed (`order_strip`, `parts`, `price`, `totals`): its `start`
 *  and `sectionEnd` marks pushed as top-level siblings around its own nodes, never a wrapper, every
 *  margin inside the two (the zero-size marks add no height), so the order strip's measured row and
 *  the price block's last rule stay top-level nodes. With no seed, the nodes unchanged. */
function seedSiblings(ctx: Ctx, section: string, nodes: Content[]): Content[] {
  if (!ctx.seed) return nodes;
  return [seedMark(INVOICE_SEED_IDS.start(section)), ...nodes, seedMark(INVOICE_SEED_IDS.sectionEnd(section))];
}

// ---------------------------------------------------------------------------------------------
// Blocks, top to bottom in sample order. Each returns Content[] — empty means "nothing left to
// draw" and the block drops from the stack. The `footer` section is pulled OUT of the content flow
// into the page-margin strip (below), so it has no renderer here.
// ---------------------------------------------------------------------------------------------

/**
 * The big title (DATA — the row's kind) over the company name, both centered — the sample's header.
 * The title and company name are value-only (their labels are ""), so the printed text is the data,
 * not a label; the title carries `headingSize`. A placed logo (spec §6.3) unshifts into the centered
 * stack (header-center) or rides a side column (header-left/header-right); no logo → today's plain
 * centered stack, byte-for-byte.
 */
function headerBlock(ctx: Ctx, d: InvoicePdfData): Content[] {
  const v = ctx.sections.get("header")!;
  const center: Content[] = [];
  for (const key of v.order.filter((k) => (k === "title" || k === "company_name") && v.field(k).visible)) {
    if (key === "title") center.push(seedPiece(ctx, key, { text: d.title, bold: true, fontSize: ctx.fonts.headingSize, alignment: "center" }));
    else center.push(seedPiece(ctx, key, { text: d.company.name, bold: true, fontSize: 15, alignment: "center", margin: [0, 2, 0, 6] }));
  }

  // Under the seed the image carries its id (an image is no text node) and an end mark follows it.
  const logoNodes: Content[] | null = ctx.logo === null ? null
    : ctx.seed
      ? [{ image: ctx.logo.dataUri, width: ctx.logo.width, id: INVOICE_SEED_IDS.piece("logo") } as Content, seedMark(INVOICE_SEED_IDS.end("logo"))]
      : [{ image: ctx.logo.dataUri, width: ctx.logo.width }];
  if (logoNodes !== null && ctx.logo!.placement === "header-center") center.unshift(...logoNodes);
  const placedSide = logoNodes !== null && (ctx.logo!.placement === "header-left" || ctx.logo!.placement === "header-right");
  if (center.length === 0 && !placedSide) return [];
  if (!placedSide) return [{ stack: center }]; // no logo, or header-center → today's stack shape

  const logoCol: Column = { width: ctx.logo!.width, stack: logoNodes! };
  const centerCol: Column = { width: "*", stack: center };
  return [{ columns: ctx.logo!.placement === "header-left" ? [logoCol, centerCol] : [centerCol, logoCol], columnGap: W.headerLogoGap }];
}

/** The trailing label-value spacing of each identity line (alignment glue, not label text). */
const IDENTITY_GLUE: Readonly<Record<"invoice_no" | "invoice_date" | "terms", string>> = {
  invoice_no: "  ", invoice_date: " ", terms: " ",
};

/** The Remit To box: a one-cell boxed table holding its label at `labelStyle`, the remit-to name at
 *  10 bold and each address line at 10. No width: the flow places it in its `remitTo` column, the
 *  canvas in the item's box. */
function remitToBox(label: string, labelStyle: { fontSize: number; bold: boolean }, d: InvoicePdfData): ContentTable {
  return {
    table: {
      widths: ["*"],
      body: [[{
        stack: [
          { text: label, ...labelStyle },
          { text: d.remitTo.name, bold: true, fontSize: 10, margin: [0, 2, 0, 0] },
          ...d.remitTo.lines.map((line): Content => ({ text: line, fontSize: 10 })),
        ],
        margin: [4, 2, 4, 4],
      }]],
    },
    layout: LAYOUT.boxed,
  };
}

/** The identity column (Invoice No. / Invoice Date / Terms — NO Page No., the sample's recorded
 *  deviation) left; the boxed Remit To block right. The trailing label-value spacing is alignment
 *  glue (the contract's `defaultLabel` carries no trailing spaces); a label override replaces the
 *  label, the glue stays. */
function identityBlock(ctx: Ctx, d: InvoicePdfData): Content[] {
  const v = ctx.sections.get("identity")!;
  const GLUE: Record<string, string> = IDENTITY_GLUE;
  const VALUE: Record<string, string> = { invoice_no: d.documentNumber, invoice_date: ctx.date(d.invoiceDate), terms: d.termsName };

  const lines: Content[] = [];
  for (const key of v.order.filter((k) => k in GLUE && v.field(k).visible)) {
    lines.push(seedPiece(ctx, key, {
      text: [{ text: `${v.field(key).label}${GLUE[key]}`, bold: true }, VALUE[key]],
      fontSize: 10, ...(lines.length === 0 ? {} : { margin: [0, 2, 0, 0] }),
    }));
  }

  const cols: Column[] = [];
  if (lines.length > 0) cols.push({ width: "*", stack: lines, margin: [W.identityIndent, 0, 0, 0] });
  if (v.field("remit_to").visible) {
    cols.push(seedBox(ctx, "remit_to", W.remitTo, remitToBox(v.field("remit_to").label, { fontSize: 13, bold: true }, d)));
  }
  if (cols.length === 0) return [];
  return [{ columns: cols, columnGap: W.identityGap, margin: [0, 0, 0, 8] }];
}

/** A labelled multi-line address block ("Billto:" / "Shipto:") — the config label over each line
 *  straight off the frozen snapshot. */
function addressLines(label: string, lines: string[]): Content[] {
  return [
    { text: label, fontSize: 9, decoration: "underline" },
    ...lines.map((line, i): Content => ({ text: line, fontSize: 10, ...(i === 0 ? { margin: [0, 2, 0, 0] } : {}) })),
  ];
}

/** The two frozen snapshot address stacks. The first VISIBLE column carries the 40pt indent that
 *  aligns the block under the Quantity column; each field drops its column when hidden. */
function partiesBlock(ctx: Ctx, d: InvoicePdfData): Content[] {
  const v = ctx.sections.get("parties")!;
  const DATA: Record<string, string[]> = { bill_to: d.billTo, ship_to: d.shipTo };
  const cols: Column[] = [];
  for (const key of v.order.filter((k) => k in DATA && v.field(k).visible)) {
    cols.push({ width: "*", stack: addressLines(v.field(key).label, DATA[key]), ...(cols.length === 0 ? { margin: [W.partiesIndent, 0, 0, 0] } : {}) });
  }
  if (cols.length === 0) return [];
  return [{ columns: cols, columnGap: W.partiesGap, margin: [0, 4, 0, 6] }];
}

/** The one boxed strip naming the visible data columns (spec §10's header row) — the grid every
 *  body block below aligns to. Everything beneath it is free-flow text the builder aligns to these
 *  same widths (the sample rules only this strip). */
function columnHeaderStrip(ctx: Ctx): Content[] {
  const cols = gridColumns(ctx);
  if (cols.length === 0) return [];
  return [{
    table: { widths: cols.map((c) => c.width), body: [cols.map((c) => head(c.label, HEADER_ALIGN[c.slot]))] },
    layout: LAYOUT.boxed,
    margin: [0, 0, 0, 4],
  }];
}

/** The order strip above the parts rows: Our Order #, Your PO #, Material and Process on ONE line
 *  (owner ruling of 2026-10-20, #590), then the underlined "PARTS" heading. Both are indented past
 *  the Quantity column to sit under "Order Information", and both are top-level nodes of the flow; on
 *  a canvas both are children of the order strip block's inner stack (src/server/invoice-canvas.ts),
 *  which render.ts measures the row inside (`fitMeasuredRows`).
 *
 *  The four fields print in that fixed order, whatever order a template keeps them in, each its
 *  label in bold and then its value; a hidden field drops its pair, and a blank value keeps its
 *  label. A line break inside a value or a typed label prints as one space, a CR LF pair as one
 *  (`lineBreaksAsSpaces`, src/lib/line-break.ts; the owner's amendment of 2026-10-21): a field that fits
 *  its share is drawn under `noWrap`, where pdfkit drew the pieces either side of a break end to
 *  end. The PARTS heading is not on the row, and its label prints as typed. Each field is an
 *  `auto` column sized to its text. The row goes out under the id
 *  `invoice-order-strip`, by which render.ts measures each field and fits the row to the line
 *  (`fitMeasuredRows`): a field keeps its own width up to an equal share of the line, and only a
 *  longer one wraps inside its share, Process as much as any. pdfmake's own sizing would squeeze
 *  every field instead. Process still takes what is left whenever it is the one long field: the
 *  equal share of a row with one field longer than its share is what the other fields leave. Where
 *  a field's share would be under 60 points (a template's Quantity column set very wide), render.ts
 *  prints the four stacked instead, one to a line under the same indent, each wrapping across the
 *  strip's whole width (`MEASURED_ROW_FLOOR`; the owner's amendment of 2026-10-21).
 *
 *  Process is not a `*` column, which would take what is left by itself. A capped column is
 *  fixed-width, so a word wider than it breaks at its edge (the #518 finding); a `*` column widens to
 *  its longest word instead, and a 250-character Process with no space in it printed as one run
 *  from the column's start past the margin (invoice-pdf.test.ts holds it broken). The template
 *  editor's printed-width checks do not cover the strip: its fields are data, fitted at print. (The
 *  totals lines, once its precedent as a measured residual by owner answer (11) of 2026-10-16, are
 *  refused at save since the owner's ruling of 2026-11-17, #991, where the Amount column would push
 *  them past the page: `printedBudgetProblems`.) */
function orderStrip(ctx: Ctx, d: InvoicePdfData): Content[] {
  const v = ctx.sections.get("order_strip")!;
  const out: Content[] = [];

  const FIELDS: [key: string, value: string][] = [
    ["our_order_no", `${d.orderNumber}`], ["your_po", d.poNumber], ["material", d.materialName], ["process", d.processNames],
  ];
  const columns: Column[] = FIELDS.filter(([key]) => v.field(key).visible).map(([key, value]): Column => ({
    width: "auto",
    text: [{ text: `${lineBreaksAsSpaces(v.field(key).label)} `, bold: true }, lineBreaksAsSpaces(value)],
    fontSize: 9,
  }));
  if (columns.length > 0) {
    // pdfmake's columns type has no `id`; render.ts finds the row by it (traveler.ts's precedent).
    out.push({ id: "invoice-order-strip", columns, columnGap: W.stripGap, margin: [ctx.slotW.qty + W.stripIndentGap, 0, 0, 0] } as Content & { id: string });
  }

  if (v.field("parts_heading").visible) {
    out.push({
      text: v.field("parts_heading").label, bold: true, decoration: "underline", fontSize: 9, margin: [ctx.slotW.qty + W.stripIndentGap, 4, 0, 2],
    });
  }
  return out;
}

/** One free-flow row per part, aligned to the grid: Quantity, the stacked Part No. / Name /
 *  Description, Each weight, Net weight. Each value drops (blank cell) when its `parts`-section field
 *  is hidden; the column itself (width) is owned by `column_header`. The two weights print with
 *  their unit, through `lb`; a blank one prints no unit. */
function partsRows(ctx: Ctx, d: InvoicePdfData): Content[] {
  const v = ctx.sections.get("parts")!;
  const cols = gridColumns(ctx);
  if (cols.length === 0) return [];
  const cell = (c: GridCol, p: InvoicePart): Column => {
    switch (c.slot) {
      case "qty": return { width: c.width, text: v.field("part_qty").visible && p.qty !== null ? ctx.qty(p.qty) : "", fontSize: 9, alignment: "right" };
      case "info": return {
        width: c.width,
        stack: v.field("part_identity").visible
          ? [p.partNumber, p.partName, p.partDescription].filter((t) => t !== "").map((text): Content => ({ text, fontSize: 9 }))
          : [],
        margin: [W.infoMargin, 0, 0, 0],
      };
      case "each": return { width: c.width, text: lb(v.field("part_each_weight").visible && p.eachWeight !== null ? ctx.weight(p.eachWeight) : ""), fontSize: 9, alignment: "right" };
      default: return { width: c.width, text: lb(v.field("part_total_weight").visible && p.totalWeight !== null ? ctx.weight(p.totalWeight) : ""), fontSize: 9, alignment: "right" };
    }
  };
  return d.parts.map((p): Content => ({ columns: cols.map((c) => cell(c, p)), columnGap: W.gridGap, margin: [0, 2, 0, 0] }));
}

/** The centered "Price per Each:  $6.51   Or" / "Minimum Charge:  $600.00" detail lines beneath an
 *  operation. "Or" trails the per-unit price only when a minimum follows it (the sample's shape). */
function priceDetailLine(label: string, value: string, showOr: boolean): Content {
  return { text: `${label}  ${value}${showOr ? "   Or" : ""}`, fontSize: 9, alignment: "center", margin: [0, 1, 0, 0] };
}

/** The PRICE block: the underlined heading once, then the operations grouped by their part, a rule
 *  after each group (owner ruling of 2026-10-20, #589). The groups follow the PARTS list's order,
 *  each holding the operations whose `partIndex` names that part, in their own order; the operations
 *  that lost their part (a `partIndex` that is null, out of range or not a whole number) come last,
 *  as a group of their own. A part with no prices has no group, and no group is named. Each
 *  operation prints as before: its name and billed amount (grid-aligned like the parts rows), with
 *  the quote source, per-unit price, minimum and setup beneath.
 *
 *  A rule (`priceRule`) follows a group only when the group printed something. A group can print
 *  nothing: with every column heading hidden no operation row is drawn, and a row whose detail lines
 *  are hidden or null (a needs-price row's) draws nothing more. So two rules never sit together, and
 *  no prices print no rule. In the Standard section order the last rule sits above Sub Total; `price`
 *  and `totals` are reorderable, so in another order it sits above whatever follows, or ends the
 *  content, where `buildInvoiceDefinition` gives it no space below. Nothing keeps a group together
 *  across a page break (589-5). */
function priceBlock(ctx: Ctx, d: InvoicePdfData): Content[] {
  const v = ctx.sections.get("price")!;
  const cols = gridColumns(ctx);
  const out: Content[] = [];
  if (v.field("price_heading").visible) {
    out.push({ text: v.field("price_heading").label, bold: true, decoration: "underline", fontSize: 9, margin: [ctx.slotW.qty + W.stripIndentGap, 8, 0, 2] });
  }
  const opCell = (c: GridCol, pr: InvoicePriceRow): Column => {
    if (c.slot === "info") return { width: c.width, text: v.field("price_description").visible ? pr.description : "", fontSize: 9, margin: [W.infoMargin, 0, 0, 0] };
    if (c.slot === "amt") return { width: c.width, text: v.field("price_amount").visible ? ctx.money(pr.amount) : "", fontSize: 9, alignment: "right" };
    return { width: c.width, text: "" };
  };
  const printRow = (pr: InvoicePriceRow): void => {
    if (cols.length > 0) out.push({ columns: cols.map((c) => opCell(c, pr)), columnGap: W.gridGap, margin: [0, 3, 0, 0] });
    // The tier-1 source line (quoting spec §5.3): a quote-priced operation names its agreement —
    // "Quote #1006", the frozen number the data carries; the label root is the config's `quote_source`
    // (default PRICE_SOURCE_LABELS.QUOTE). Rows without a quote number print no source line.
    if (v.field("quote_source").visible && pr.sourceQuoteNumber !== null && pr.sourceQuoteNumber !== undefined) {
      out.push({ text: `${v.field("quote_source").label} #${pr.sourceQuoteNumber}`, fontSize: 9, alignment: "center", margin: [0, 1, 0, 0] });
    }
    if (v.field("price_per").visible && pr.unitPrice !== null) {
      out.push(priceDetailLine(`${v.field("price_per").label} ${pr.pricePerLabel}:`, ctx.money(pr.unitPrice),
        v.field("minimum_charge").visible && pr.minimumCharge !== null));
    }
    if (v.field("minimum_charge").visible && pr.minimumCharge !== null) out.push(priceDetailLine(v.field("minimum_charge").label, ctx.money(pr.minimumCharge), false));
    if (v.field("setup_charge").visible && pr.setupCharge !== null) out.push(priceDetailLine(v.field("setup_charge").label, ctx.money(pr.setupCharge), false));
  };
  const hasPart = (i: number | null): boolean => i !== null && Number.isInteger(i) && i >= 0 && i < d.parts.length;
  const groups: InvoicePriceRow[][] = [
    ...d.parts.map((_, i) => d.priceRows.filter((pr) => pr.partIndex === i)),
    d.priceRows.filter((pr) => !hasPart(pr.partIndex)),
  ];
  for (const group of groups) {
    const before = out.length;
    group.forEach(printRow);
    if (out.length > before) {
      out.push(priceRule(PRICE_RULE_BELOW, ctx.priceRule?.x1 ?? 0, ctx.priceRule?.length ?? W.content));
    }
  }
  return out;
}

/** A right-aligned "label  amount" totals line, its amount under the grid's amount column. */
function totalLine(amtW: number, label: string, value: string, opts: { bold?: boolean; big?: boolean } = {}): Content {
  const fontSize = opts.big ? 13 : 10;
  return {
    columns: [
      { width: "*", text: "" },
      { width: W.totalsLabel, text: label, bold: opts.bold ?? false, fontSize, alignment: "right" },
      { width: amtW, text: value, bold: opts.bold ?? false, fontSize, alignment: "right" },
    ],
    columnGap: W.totalsGap,
    margin: [0, opts.big ? 6 : 2, 0, 0],
  };
}

/** Sub Total, one named line per surcharge/charge/cert/freight/tax (their descriptions are frozen
 *  line data), then the bold Total Amount Due. Each row gates on its `totals`-section field. */
function totalsBlock(ctx: Ctx, d: InvoicePdfData): Content[] {
  const v = ctx.sections.get("totals")!;
  const amtW = ctx.slotW.amt || W.amt; // the amount column's width (fall back to the sample's 84)
  const out: Content[] = [];
  if (v.field("subtotal").visible) out.push(totalLine(amtW, v.field("subtotal").label, ctx.money(d.subtotal), { bold: true }));
  if (v.field("surcharge_rows").visible) for (const s of d.surchargeRows) out.push(totalLine(amtW, s.description, ctx.money(s.amount)));
  if (v.field("charge_rows").visible) for (const c of d.chargeRows) out.push(totalLine(amtW, c.description, ctx.money(c.amount)));
  if (v.field("cert_row").visible && d.certRow) out.push(totalLine(amtW, d.certRow.description, ctx.money(d.certRow.amount)));
  if (v.field("freight_row").visible && d.freightRow) out.push(totalLine(amtW, d.freightRow.description, ctx.money(d.freightRow.amount)));
  if (v.field("tax_row").visible && d.taxRow) out.push(totalLine(amtW, d.taxRow.description, ctx.money(d.taxRow.amount)));
  if (v.field("total").visible) out.push(totalLine(amtW, v.field("total").label, ctx.money(d.total), { bold: true, big: true }));
  return out;
}

/** The text of one footer strip cell: the company address, the contact line's label alone (no data
 *  behind it), or the phone's label and the company phone. The flow's strip and the canvas's band
 *  items print these same strings. */
function footerText(key: "footer_address" | "footer_contact" | "footer_phone", label: string, d: InvoicePdfData): string {
  switch (key) {
    case "footer_address": return d.company.address;
    case "footer_contact": return label;
    default: return `${label} ${d.company.phone}`;
  }
}

/** The page footer strip: company address left, the sample's own static "Contact: Accounts
 *  Receivable" center (a pure label — no data behind it), phone right, at the config's `smallSize`.
 *  Returns null when the footer section or all its fields are hidden. This is a PAGE-MARGIN strip,
 *  not a content-flow section: it renders in the footer slot regardless of its position in the
 *  config's section order, and rides the pageNofM footer's `above` slot when `pageFooter` is on. */
function footerStrip(ctx: Ctx, d: InvoicePdfData): Content | null {
  const v = ctx.sections.get("footer")!;
  if (!v.visible) return null;
  const cols: Column[] = [];
  const small = ctx.fonts.smallSize;
  if (v.field("footer_address").visible) cols.push({ width: "*", text: footerText("footer_address", v.field("footer_address").label, d), fontSize: small });
  if (v.field("footer_contact").visible) {
    cols.push({ width: W.footerContact, text: footerText("footer_contact", v.field("footer_contact").label, d), fontSize: small, alignment: "center" });
  }
  if (v.field("footer_phone").visible) {
    cols.push({ width: W.footerPhone, text: footerText("footer_phone", v.field("footer_phone").label, d), fontSize: small, alignment: "right" });
  }
  if (cols.length === 0) return null;
  return { columns: cols, margin: [24, INVOICE_PAGE.stripInset, 24, 0] };
}

/**
 * The invoice's identity band — what an invoice overflowing LETTER repeats on its continuation
 * pages. A real invoice genuinely overflows: the parts are the order's lines (unbounded — min(1),
 * no max, orders.ts) and the priced operations grow with them (probed empirically, Task 12: ~15
 * parts → 2 pages). Its identity is the invoice number under the `invoice_no` field's own label.
 * Rendered REGARDLESS of the config's visibility flags (the BOL/cert band's identity treatment —
 * identity on paper is locked, not configurable), though the `invoice_no` label override carries.
 */
const CONTINUATION_TOP_MARGIN = INVOICE_PAGE.overflowTopMargin;
function continuationHeader(ctx: Ctx, d: InvoicePdfData): Content {
  const v = ctx.sections.get("identity")!;
  return {
    stack: [
      { text: `${v.field("invoice_no").label} ${d.documentNumber}`, bold: true, fontSize: 11 },
      { text: "(continued)", italics: true, fontSize: ctx.fonts.smallSize },
    ],
    margin: [24, 10, 24, 0],
  };
}

/** One config section key → its renderer. The `footer` section is handled separately (the strip),
 *  so it renders nothing in the content flow. An unknown key renders nothing: the validator refused
 *  it before any config stored it. Under the seed each block section is marked by its kind (design
 *  2026-11-10 §5.3): one-node (`seedSection`) or several-node, by top-level sibling marks
 *  (`seedSiblings`); with no seed both answer the nodes unchanged. The header's and identity's
 *  pieces are marked inside their builders. */
function renderSection(key: string, ctx: Ctx, d: InvoicePdfData): Content[] {
  switch (key) {
    case "header": return headerBlock(ctx, d);
    case "identity": return identityBlock(ctx, d);
    case "parties": return seedSection(ctx, key, partiesBlock(ctx, d));
    case "column_header": return seedSection(ctx, key, columnHeaderStrip(ctx));
    case "order_strip": return seedSiblings(ctx, key, orderStrip(ctx, d));
    case "parts": return seedSiblings(ctx, key, partsRows(ctx, d));
    case "price": return seedSiblings(ctx, key, priceBlock(ctx, d));
    case "totals": return seedSiblings(ctx, key, totalsBlock(ctx, d));
    default: return []; // footer (the page-margin strip) and any unknown key
  }
}

/** The ctx of a section list: each section through the lens, the formatters from the config's
 *  formats, and the grid's fixed widths (`slotW`) from the `column_header` section's view, a hidden
 *  column reserving none (the validator's budget model). `logo` is null unless the resolved version
 *  carries bytes and the config places them. */
function ctxOf(config: TemplateConfig, sectionConfigs: SectionConfig[], logo: Ctx["logo"]): Ctx {
  const sections = new Map(sectionConfigs.map((sc) => [sc.key, sectionView(sc)] as const));
  const colV = sections.get("column_header")!;
  const slotNum = (key: string, dflt: number): number => {
    const fv = colV.field(key);
    if (!fv.visible) return 0; // a hidden column reserves no width — the validator's budget model
    return typeof fv.width === "number" ? fv.width : dflt;
  };
  return {
    fonts: config.fonts,
    money: makeMoney(config.formats),
    weight: makeWeight(config.formats),
    qty: makeQty(config.formats),
    date: makeLongDate(config.formats),
    sections,
    slotW: { qty: slotNum("col_qty", W.qty), each: slotNum("col_each_weight", W.each), amt: slotNum("col_amount", W.amt) },
    logo,
  };
}

// ---------------------------------------------------------------------------------------------
// The built-in default invoice/credit template (spec §10, P7 spec §5.4). PURE — data and config
// in, JSON out.
// ---------------------------------------------------------------------------------------------

/**
 * `config` is a **backfilled** `TemplateConfig` (what `resolveTemplateForPrint` returns) and
 * DEFAULTS to the contract's own `DEFAULT_CONFIG` — so a config-less call prints the contract's
 * default paper, the one tests/invoice-pdf.test.ts holds. `logoDataUri` is the traveler's
 * deliberate extra parameter: the logo bytes belong to the resolved template version, not to the
 * invoice data. The bottom margin is 44 unconditionally (the invoice has always carried a per-page
 * company strip): the `pageFooter` knob does not change the margin, only where the strip and the
 * page count go.
 *
 * It branches once on `config.layout` (design 2026-11-10 §5.1): a layout prints the canvas
 * (`buildCanvasInvoiceDefinition`, src/server/invoice-canvas.ts), handed the flow's own builders
 * (`INVOICE_FLOW`); a null layout prints the flow below, exactly as before the canvas lane.
 *
 * `seedIds` is the canvas seed's layout pass alone (`seedInvoiceLayout`,
 * src/server/invoice-canvas-seed.ts): the flow marks the pieces and blocks a canvas item stands for
 * (`INVOICE_SEED_IDS`) and lays out exactly as it does without them. Every print and preview leaves
 * it off, and the canvas branch ignores it.
 */
export function buildInvoiceDefinition(
  input: InvoicePdfData,
  config: TemplateConfig = DEFAULT_CONFIG,
  logoDataUri?: string,
  options: { seedIds?: boolean } = {},
): RenderableDefinition {
  if (config.layout !== null) return buildCanvasInvoiceDefinition(input, config, config.layout, INVOICE_FLOW, logoDataUri);
  // The §5.6 belt's OMISSION half: views resolve over `completeSections`, never `config.sections`
  // raw, so a raw config omitting an entry cannot drop it.
  const sectionConfigs = completeSections(INVOICE_CONTRACT, config.sections);
  const ctx: Ctx = {
    ...ctxOf(config, sectionConfigs, config.logo !== null && logoDataUri !== undefined
      ? { placement: config.logo.placement, width: config.logo.width, dataUri: logoDataUri }
      : null),
    ...(options.seedIds === true ? { seed: true } : {}),
  };
  const sections = ctx.sections;

  const content: Content[] = [];
  // Stack order IS the config's section order; hidden sections are omitted (nothing on this
  // contract is locked, so the belt forces none back). The footer section never enters the content
  // flow — it is the page-margin strip below.
  for (const sc of sectionConfigs) {
    if (sc.key === "footer") continue;
    if (!sections.get(sc.key)!.visible) continue;
    content.push(...inBoxFlowSection("INVOICE", sc.key, renderSection(sc.key, ctx, input)));
  }
  // A price rule that ends the content (Totals hidden, every Totals field hidden or with nothing to
  // print, or PRICE ordered after Totals) has no space below it (the owner's answer of 2026-10-21,
  // #589). pdfmake starts a new page when a node's bottom margin does not fit what is left of the
  // page (`LayoutBuilder.js`, pdfmake 0.3.11, ~:381-390), so a last group ending 4 to 5 points above
  // the page foot drew its rule and then printed a blank last page for the rule's 1 point. A new
  // node takes the last one's place; every other rule keeps its space. Ending under 4 points above
  // the foot, the rule can still print alone on a new last page: its top margin does not fit either.
  // The last node is the last that prints: under the seed a block's marks follow its nodes (and an
  // emptied section's marks may follow the price block), so the belt passes over every top-level
  // seed mark and every stack of seed marks alone (`marksOnly`) and replaces the rule where it stands.
  // With no seed there is none, and the last node is `content.at(-1)`.
  let last = content.length - 1;
  while (last >= 0 && marksOnly(content[last])) last--;
  if (last >= 0 && isPriceRule(content[last])) content[last] = priceRule(0);

  const strip = footerStrip(ctx, input);
  return {
    pageSize: "LETTER",
    pageMargins: [24, 24, 24, INVOICE_PAGE.bottomMargin],
    defaultStyle: { font: config.fonts.family, fontSize: config.fonts.baseSize },
    // No `info.creationDate`, no clock anywhere — the print DATE is not even printed; the invoice
    // date is data (`invoiceDate`), so the builder itself stays deterministic (the traveler's rule).
    //
    // The `pageFooter` knob (spec §6.1) and the static company strip cannot both own pdfmake's one
    // `footer` slot (render.ts refuses two). Knob OFF (default — golden): the strip is a plain static
    // `footer`, exactly today. Knob ON: the strip rides the pageNofM footer's `above` slot, stacked
    // over the page line by render.ts's one callback (the reason `above` exists).
    ...(config.pageFooter
      ? { pageFooterSpec: { kind: "pageNofM" as const, ...(strip !== null ? { above: strip } : {}) } }
      : (strip !== null ? { footer: strip } : {})),
    content,
    continuationHeaderSpec: {
      content: continuationHeader(ctx, input),
      overflowTopMargin: CONTINUATION_TOP_MARGIN,
    },
  };
}

/** The flow's own builders, handed to the canvas path (`src/server/invoice-canvas.ts`), which imports
 *  only types from this file: it prints each field and block exactly as the flow does, with no
 *  import cycle (the traveler's `CANVAS_FLOW`, the ticket's `TICKET_FLOW`, the bill of lading's
 *  `BOL_FLOW`, the certification's `CERT_FLOW`). */
export type InvoiceFlowBuilders = {
  /** `INVOICE_WIDTHS`, handed on with the builders so the canvas reads the flow's widths with no
   *  value import from this file. */
  widths: typeof INVOICE_WIDTHS;
  /** The keys a canvas prints in a border at the item's box (`INVOICE_BOXED_FIELDS`). */
  boxedFields: readonly string[];
  /** The text of one footer strip cell, as `footerStrip` builds it: the company address, the
   *  contact label alone, or `${label} ${d.company.phone}`. */
  footerText: (key: "footer_address" | "footer_contact" | "footer_phone", label: string, d: InvoicePdfData) => string;
  sectionView: (sc: SectionConfig) => InvoiceSectionView;
  /** The flow's ctx arithmetic (`slotW` from the `column_header` section's view) over a section list. */
  ctxOf: (config: TemplateConfig, sectionConfigs: SectionConfig[], logo: InvoiceCtx["logo"]) => InvoiceCtx;
  makeMoney: (f: FormatsConfig) => (v: number) => string;
  makeLongDate: (f: FormatsConfig) => (iso: string) => string;
  identityGlue: Readonly<Record<"invoice_no" | "invoice_date" | "terms", string>>;
  /** The Remit To box's one-cell boxed table, no width: its label at `labelStyle`, the remit-to name
   *  at 10 bold, each address line at 10. The flow places it in its `remitTo` column. */
  remitToBox: (label: string, labelStyle: { fontSize: number; bold: boolean }, d: InvoicePdfData) => Content;
  partiesBlock: (ctx: InvoiceCtx, d: InvoicePdfData) => Content[];
  columnHeaderStrip: (ctx: InvoiceCtx) => Content[];
  orderStrip: (ctx: InvoiceCtx, d: InvoicePdfData) => Content[];
  partsRows: (ctx: InvoiceCtx, d: InvoicePdfData) => Content[];
  priceBlock: (ctx: InvoiceCtx, d: InvoicePdfData) => Content[];
  totalsBlock: (ctx: InvoiceCtx, d: InvoicePdfData) => Content[];
  /** A new rule node (`below` the space under it, the line from `x1` to `x1 + length`), as the price
   *  block draws after each group; the canvas's end-of-block belt makes one with 0 below. */
  priceRule: (below?: number, x1?: number, length?: number) => Content;
  /** Whether a node is a rule `priceRule` made, by the node itself, never its shape. */
  isPriceRule: (node: unknown) => boolean;
};

export const INVOICE_FLOW: InvoiceFlowBuilders = {
  widths: INVOICE_WIDTHS, boxedFields: INVOICE_BOXED_FIELDS, footerText, sectionView, ctxOf, makeMoney, makeLongDate,
  identityGlue: IDENTITY_GLUE, remitToBox, partiesBlock, columnHeaderStrip, orderStrip, partsRows, priceBlock, totalsBlock,
  priceRule, isPriceRule,
};

/** A seeded field item's style: the flow's own size, weight and alignment for that key (design
 *  2026-11-10 §5.3), so the item prints its text as the flow prints it; null for a key the seed
 *  places no field for. The identity lines' labels print bold inside their text, as the flow's do;
 *  the style is the line's own, regular. */
export function invoiceSeedStyle(key: string, fonts: FontsConfig): CanvasTextStyle | null {
  switch (key) {
    case "title": return { size: fonts.headingSize, bold: true, align: "center" };
    case "company_name": return { size: 15, bold: true, align: "center" };
    case "invoice_no":
    case "invoice_date":
    case "terms": return { size: 10, bold: false, align: "left" };
    case "remit_to": return { size: 13, bold: true, align: "left" };
    case "footer_address": return { size: fonts.smallSize, bold: false, align: "left" };
    case "footer_contact": return { size: fonts.smallSize, bold: false, align: "center" };
    case "footer_phone": return { size: fonts.smallSize, bold: false, align: "right" };
    default: return null;
  }
}

/** The item node a canvas invoice's sheet is assembled with (src/server/invoice-canvas.ts's
 *  `firstInvoiceItemContent`, handed the flow's builders), for the preview's alone layouts. */
export function invoiceCanvasItemContent(input: InvoicePdfData, config: TemplateConfig, logoDataUri?: string): ItemContent {
  if (config.layout === null) throw new Error("invoiceCanvasItemContent needs a canvas config.");
  return firstInvoiceItemContent(input, config, config.layout, INVOICE_FLOW, logoDataUri);
}
