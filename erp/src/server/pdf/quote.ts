/**
 * The quotation (Phase 6 design spec §6, ruling 12). PURE by construction, the traveler.ts
 * contract: `QuotePdfData` + a validated `TemplateConfig` in, a plain-JSON pdfmake definition out —
 * no I/O, no clock, nothing that would not survive `JSON.parse(JSON.stringify())` (asserted in
 * tests/quote-pdf.test.ts). The reads (and the engine-computed indicative amounts) live in
 * quotes.ts (`readQuotePdfData`), the bytes in render.ts.
 *
 * A CONFIG-CONSUMER since Phase 7 Task 14 (P7 spec §5.4) — the LAST of the eight, the invoice's
 * exact lens (`sectionView` over `completeSections`, the §5.6 belt in both halves):
 * sections/fields/labels/widths/fonts/formats/logo render from a validated config, and the default
 * config reproduces today's paper exactly (the golden gate, tests/quote-pdf.test.ts, untouched).
 *
 * **THE FOOTER CALLBACK IS RETIRED (spec §6.1).** Phase 6 sanctioned the quote's hand-written
 * `footer` page callback as the one code-not-data carve-out — "Page: N of M" on every page, the
 * count the pure-JSON documents had to deviate away. Task 14 replaces it with the declarative
 * `pageFooterSpec { kind: "pageNofM", label: "Page:" }` that render.ts turns into the byte-for-byte
 * same footer line, so the quote builder JOINS the JSON-round-trip purity test its siblings had —
 * the definition is now plain JSON. The quote alone defaults `pageFooter` TRUE (the contract's own
 * default), because golden compatibility means reproducing the page line the builder already prints.
 *
 * **THE TWO-MONEY-PRECISIONS TRAP** (Task 2 review carry, the headline of this conversion): the
 * quote prints money at TWO precisions against ONE `priceDecimals` knob — `money()` at 2dp on the
 * setup charge, minimum charge and each row's indicative extended amount, versus `money4()` at up
 * to `priceDecimals` (default 4) on the unit and break prices. `priceDecimals` maps to the money4
 * calls ONLY; the 2dp `money()` calls never move (a sub-cent setup charge changing at the golden
 * gate is the failure this split exists to prevent — quote prices are Decimal(12,4), and rounding a
 * unit price to cents would misstate the agreement, but a $2.00 setup is a $2.00 setup).
 *
 * The two standing texts (`introText`/`liabilityText`) bind through the DATA SEAM (the cert's
 * `cert_statement` shape, not the BOL's config-literal shape): quotes.ts already reads them into
 * `QuotePdfData`, so they are caller data, not builder literals — `printQuote` injects the resolved
 * config's `quote_intro_text`/`quote_liability_text` at that seam (spec §8: the template owns the
 * standing text; the `Setting` is retired in Task 14). The builder still renders `input.introText`/
 * `input.liabilityText` — one source per fact, the pure-builder golden test intact.
 *
 * A config whose `layout` is a canvas prints the canvas instead, on the print path and in the
 * preview (since quote canvas PR 2, design 2026-11-12 §4.4): `buildQuoteDefinition` branches once to
 * `buildCanvasQuoteDefinition` (src/server/quote-canvas.ts), handed this flow's own builders
 * (`QUOTE_FLOW`), so a canvas prints the same blocks from the same `QuotePdfData`; a null layout
 * prints the flow below, exactly as before the canvas lane.
 *
 * Layout mirrors the owner's `docs/samples/Quote_Sample_Form.jpeg`, which IS the contract
 * (ruling 12; the sample is VS's stock vendor form — the LAYOUT is the target, its demo content
 * is not). Deviations are individually commented; there are no silent ones:
 *  - the header logo is Phase 7's (spec §6.3) — off by default (the owner supplied none): a config
 *    that places one joins the centered header stack (center) or a side column (left/right).
 *  - **price details print the 5A vocabulary, not the sample's VS labels** (spec §6): "Setup
 *    charge: $X Plus / Price per <unit>: $Y Or / Minimum charge: $Z" replaces "Furnace Charge" /
 *    "Flat rate charge of" — same arrangement, this system's own price-row terms.
 *  - **no vendor "Fax:" / customer "Your Fax No.:" lines** — no fax field exists anywhere in
 *    this model (settings or contact); do not invent fields (the invoice's and cert's identical
 *    deviation).
 *  - the sample's "Supervisor" / "Example Purchasing Department" lines are the VS contact's title/department
 *    — fields this model does not carry; the Attn block prints contact name, customer name and
 *    the bill-to address (spec §6's own transcription).
 *  - the signature block is flow-laid with a top margin, never `absolutePosition` (the Phase 4
 *    tear-off collision lesson) — on a long quote it follows the content instead of overprinting.
 *  - the fourth heading is the contract's built-in "Net weight / Price", which was
 *    "Total Lbs / Price" until owner ruling W14 of 2026-10-09. A line's each weight and net weight
 *    print with their unit, and so does a price break's threshold on an operation priced per lb:
 *    "1,000 lb or more:" (owner ruling W15 of the same day). A break in pieces stays bare. The
 *    unit comes from `lb` of ./printed-weight. A blank weight prints no unit.
 */
import type { Column, Content, TableCell } from "pdfmake/interfaces";
import { LAYOUT, type RenderableDefinition } from "./render";
import { inBoxFlowSection } from "./flow-tables";
import type { ItemContent } from "./canvas-sheet";
import { mark } from "./canvas-nodes";
import { lb } from "./printed-weight";
import { buildCanvasQuoteDefinition, firstQuoteItemContent } from "../quote-canvas";
import { QUOTE_CONTRACT, DEFAULT_CONFIG } from "../../lib/template-contracts/quote";
import type { CanvasTextStyle } from "../../lib/template-contracts/canvas";
import type { QuotePdfSurcharge } from "../quote-surcharges";
import {
  completeSections,
  type FontsConfig, type FormatsConfig, type LogoPlacement, type SectionConfig,
  type TemplateConfig,
} from "../../lib/template-contracts/types";

// ---------------------------------------------------------------------------------------------
// QuotePdfData — the builder's whole input. Plain data: no Decimals, no Dates, no Prisma rows.
// `amount` per price row is the ENGINE's indicative extended amount (quotes.ts feeds priceOrder a
// synthetic line from quotedQty + each-weight); null = omitted (unlimited / qty or weight
// unknown) — the builder never computes money, it prints what it is handed.
// ---------------------------------------------------------------------------------------------

export type QuoteCompany = { name: string; address: string; phone: string };
export type QuotePdfBreak = { threshold: number; price: number };
export type QuotePdfPriceRow = {
  stepName: string;
  notes: string;                       // the sample's per-row "Quote Notes" line
  setupCharge: number | null;
  unitPrice: number | null;
  minimumCharge: number | null;
  pricePerLabel: string;               // PRICE_PER_LABELS — "Each", "Per lb", "Lot (flat)", …
  pricedPerLb: boolean;                // the row's price is per lb, so its break thresholds are weights
  breaks: QuotePdfBreak[];
  amount: number | null;
};
export type QuotePdfLine = {
  quotedQty: number | null;
  quotedUnlimited: boolean;
  partNumber: string;
  partName: string;
  partDescription: string;
  eachWeight: number | null;
  totalLbs: number | null;             // qty × each-weight when both known
  surcharges: QuotePdfSurcharge[];     // the estimate rows under the line's operations (#948)
  material: string;
  prices: QuotePdfPriceRow[];
};
export type QuotePdfData = {
  company: QuoteCompany;
  quoteNumber: number;
  effectiveDate: string;               // "yyyy-mm-dd"
  expiryDate: string;
  termsName: string;                   // the customer's terms name; "" prints a blank value
  rfqNumber: string;
  attn: string;                        // the picked contact's name; "" omits the Attn line
  customerPhone: string;               // the picked contact's phone; "" omits the line
  billTo: string[];                    // the bill-to row's name when it stacks, the customer name, the address lines (party-address.ts, R14)
  introText: string;                   // quote_intro_text, bound at printQuote's data seam
  lines: QuotePdfLine[];
  endingStatementText: string;         // the quote's picked ending statement (ruling 13); "" omits
  notes: string;                       // the quote's printable notes (spec §4.1 — never internalNotes)
  liabilityText: string;               // quote_liability_text, bound at the data seam; "" omits
  signer: { name: string; title: string };  // quotedBy displayName + User.title (ruling 14)
};

// ---------------------------------------------------------------------------------------------
// Formatting. Pure, config-driven (P7 spec §5.4), locale pinned (the traveler's own rule) so output
// never tracks the server's.
// ---------------------------------------------------------------------------------------------

/** Money with a leading "$" and exactly TWO decimals — "$102.00". Grouping rides the
 *  `thousandsSeparator` knob; the two decimals are FIXED (setup/minimum/indicative amounts are
 *  already-cent quantities), so `priceDecimals` deliberately does NOT reach this formatter — the
 *  two-money-precisions trap (see the file comment). The default reproduces today's `money()`
 *  byte-for-byte. */
function makeMoney(formats: FormatsConfig): (value: number) => string {
  const useGrouping = formats.thousandsSeparator !== false;
  return (value) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping })}`;
}

/** A unit/break price: at least two decimals, up to the `priceDecimals` knob's value (default 4)
 *  — "$0.15" stays "$0.15", "$0.0550" prints "$0.055". Quote prices are Decimal(12, 4) and a
 *  4-decimal price rounded to cents would misstate the agreement (unlike an invoice's already-billed
 *  amount). This is the SOLE consumer of `priceDecimals`; the default (4) reproduces today's
 *  `money4()` byte-for-byte. */
function makeMoney4(formats: FormatsConfig): (value: number) => string {
  const decimals = formats.priceDecimals ?? 4;
  const useGrouping = formats.thousandsSeparator !== false;
  return (value) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: decimals, useGrouping })}`;
}

/** A weight, always two decimals, no "$" — "1,000.00". Grouping rides the knob; the decimals are
 *  DATA PRECISION, not the price knob. */
function makeWeight(formats: FormatsConfig): (value: number) => string {
  const useGrouping = formats.thousandsSeparator !== false;
  return (value) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping });
}

/** A quantity, integer, thousands-grouped per the knob — "100", "1,440". */
function makeQty(formats: FormatsConfig): (value: number) => string {
  const useGrouping = formats.thousandsSeparator !== false;
  return (value) => value.toLocaleString("en-US", { maximumFractionDigits: 0, useGrouping });
}

/** A break threshold: grouped per the knob, at most 2 decimals (pieces, or pounds on an LB row). */
function makeNum(formats: FormatsConfig): (value: number) => string {
  const useGrouping = formats.thousandsSeparator !== false;
  return (value) => value.toLocaleString("en-US", { maximumFractionDigits: 2, useGrouping });
}

const MONTHS_FULL = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A date, driven by the contract's ONE date knob (default "MM/DD/YYYY" — the sample's zero-padded
 * "06/30/2018" style, the old `paddedDate`). Both date slots — Effective and Expires — print
 * through this SAME renderer, so the single knob maps directly with no two-styles trap (grep-verified:
 * `paddedDate` was the sole date function). Pure string work — parsing to a Date would drag a
 * timezone into a date-only value.
 */
function makeDate(formats: FormatsConfig): (iso: string) => string {
  const format = formats.dateFormat ?? "MM/DD/YYYY";
  return (iso) => {
    const [y, m, d] = iso.split("-");
    switch (format) {
      case "M/D/YYYY": return `${Number(m)}/${Number(d)}/${y}`;
      case "YYYY-MM-DD": return iso;
      case "MMMM D, YYYY": return `${MONTHS_FULL[Number(m) - 1]} ${Number(d)}, ${y}`;
      case "MMM - DD - YYYY": return `${MONTHS_ABBR[Number(m) - 1]} - ${d} - ${y}`;
      default: return `${m}/${d}/${y}`; // "MM/DD/YYYY" — the sample's own
    }
  };
}

// ---------------------------------------------------------------------------------------------
// The config lens (P7 spec §5.4) — the invoice's `sectionView`, applied to the quote's blocks. The
// builder ASSUMES a complete config (`validateConfig`'s §5.3 backfill guarantees every entry
// exists); only the null-means-contract-default knobs a complete config still carries resolve here.
//
// THE §5.6 BELT, both halves: the flag half (`visible || !hideable` / `visible || !removable`) is
// the invoice's expression verbatim — NOTHING on this contract is locked, so it forces nothing and a
// config may hide anything; the omission half is `completeSections` in `buildQuoteDefinition` below,
// so a raw config that OMITS an entry still renders it. The quote's two text blocks bind at the DATA
// SEAM (see the file comment), so there is no config-literal text half here.
// ---------------------------------------------------------------------------------------------

const CONTRACT_SECTIONS = new Map(QUOTE_CONTRACT.sections.map((s) =>
  [s.key, { section: s, fields: new Map(s.fields.map((f) => [f.key, f])) }] as const));

type FieldView = { visible: boolean; label: string; width: number | "*" };
/** One section of a complete config seen through the contract: the §5.6 belt's flag half applied. */
export type QuoteSectionView = {
  visible: boolean;
  /** Field keys in config (= display) order; per-field visibility still applies at use. */
  order: string[];
  field: (key: string) => FieldView;
};
type SectionView = QuoteSectionView;

function sectionView(sc: SectionConfig): SectionView {
  const cs = CONTRACT_SECTIONS.get(sc.key);
  // Unknown keys were refused by the validator before any config could be stored; a miss here is a
  // caller bug, not a config state.
  if (cs === undefined) throw new Error(`Unknown QUOTE template section "${sc.key}"`);
  const byKey = new Map(sc.fields.map((f) => [f.key, f]));
  return {
    visible: sc.visible || !cs.section.hideable, // the belt, section half (nothing locked here)
    order: sc.fields.map((f) => f.key),
    field: (key) => {
      const cf = cs.fields.get(key);
      if (cf === undefined) throw new Error(`Unknown QUOTE template field "${sc.key}.${key}"`);
      const fc = byKey.get(key);
      return {
        visible: (fc?.visible ?? true) || !cf.removable, // the belt, field half
        label: fc?.label ?? cf.defaultLabel,
        width: fc?.width ?? cf.column?.defaultWidth ?? "*",
      };
    },
  };
}

/** The four data columns the sample's boxed header strip names — the line grid and every price row
 *  align to these same widths, defined ONCE by the `column_header` section (the invoice's shape). */
type Slot = "qty" | "info" | "each" | "amt";
const COLUMN_FIELD: Record<string, Slot> = {
  col_qty: "qty", col_info: "info", col_each_weight: "each", col_amount: "amt",
};
/** The strip header cell alignment per slot (qty/info left, each/amt right — the sample's own). */
const HEADER_ALIGN: Record<Slot, "left" | "right"> = { qty: "left", info: "left", each: "right", amt: "right" };

type GridCol = { slot: Slot; width: number | "*"; label: string };

/** Everything a section renderer needs, threaded once instead of parameter-by-parameter. */
export type QuoteCtx = {
  fonts: FontsConfig;
  money: (value: number) => string;
  money4: (value: number) => string;
  weight: (value: number) => string;
  qty: (value: number) => string;
  num: (value: number) => string;
  date: (iso: string) => string;
  sections: Map<string, SectionView>;
  /** The numeric width of the qty column (0 when hidden) — the Material line and PRICE heading
   *  indent under the identity column read it, so a col_qty width override flows through. */
  qtyW: number;
  /** Present only when the resolved version carries logo BYTES and the config PLACES them
   *  (spec §6.3) — either alone renders today's text-only header. */
  logo: { placement: LogoPlacement; width: number; dataUri: string } | null;
  /** The canvas seed's layout pass (`buildQuoteDefinition`'s `seedIds`, since quote canvas PR 2): when
   *  set the flow marks the pieces and blocks a canvas item stands for (`QUOTE_SEED_IDS`). Absent on
   *  every print and preview, and on every ctx `ctxOf` builds (the canvas's included), which render
   *  exactly the nodes they rendered before. */
  seed?: true;
};
type Ctx = QuoteCtx;

/** Every fixed width the flow prints with (points). `QUOTE_FLOW` carries it for parity with
 *  `INVOICE_FLOW` and `STATEMENT_FLOW`, but the quote's canvas (src/server/quote-canvas.ts) reads none
 *  of it; the seed (src/server/quote-canvas-seed.ts) imports it directly (since quote canvas PR 2). The
 *  profile's `QUOTE_LEAST_WIDTHS` (src/lib/template-contracts/quote.ts) is held to it by
 *  tests/quote-canvas.test.ts. The content width, LETTER (612 pt) less the 24 pt side margins, as
 *  invoice.ts and statement.ts state theirs; the header's two side columns and the gap between its
 *  three; the parties' left-stack inset, their gap and the quote fields' column; the grid's gap
 *  between columns and the information cell's own left margin (which the Material line and the PRICE
 *  heading indent by too, past the quantity column); and the closing's gap and its signature column,
 *  whose rule runs the column's width. */
export const QUOTE_WIDTHS = {
  content: 564, headerSide: 170, headerGap: 8,
  partiesIndent: 16, partiesGap: 12, quoteFields: 220,
  gridGap: 6, infoIndent: 6,
  closingGap: 12, signature: 230,
} as const;
const W = QUOTE_WIDTHS;

/** The flow's vertical page constants: the 44 pt bottom margin (the page line's room, kept whether or
 *  not the line prints) and the continuation pages' 40 pt top margin. */
export const QUOTE_PAGE = { bottomMargin: 44, overflowTopMargin: 40 } as const;

/** The `column_header` section's visible column fields, in config order, with resolved widths and
 *  labels — the grid every line/price row aligns to. */
function gridColumns(ctx: Ctx): GridCol[] {
  const v = ctx.sections.get("column_header")!;
  return v.order
    .filter((k) => k in COLUMN_FIELD && v.field(k).visible)
    .map((k) => ({ slot: COLUMN_FIELD[k], width: v.field(k).width, label: v.field(k).label }));
}

const head = (text: string, align: "left" | "right"): TableCell => ({ text, bold: true, fontSize: 9, alignment: align });

/**
 * The ids the quote's canvas seed reads back from one layout of its stand-in (design 2026-11-12
 * §5.3, since quote canvas PR 2), the statement's `STATEMENT_SEED_IDS` shape: emitted only under
 * `seedIds`, and never on a TEXT node (pdfmake refuses two text nodes sharing an id in one document
 * and makes a named destination of a text id). A piece's id is on a wrapper stack around it
 * (`seedPiece`), its `end` mark after it inside that wrapper, BEFORE its bottom margin (moved onto
 * the wrapper), so a piece's box is its line alone: `title`, `company_name` (its 2 pt top moved onto
 * the wrapper) and `company_address` (ONE wrapper over all its lines) in the centre stack,
 * `quote_number` in the right column; the logo's id is on its image, its end mark after it, in
 * whichever column it prints. `parties`, `intro`, `column_header` and `closing` are one-node
 * sections, their marks inside the node's own vertical margins, which move onto an outer stack
 * (`seedSection`); `lines` is several-node and `liability` the per-key exception, both marked by
 * top-level siblings around their nodes (`seedSiblings`), so the lines' start mark lies ABOVE the
 * first grid row's 2 pt and the liability's ABOVE its kept 10 pt (design §5.2). A visible section
 * whose builder answers nothing still emits its two marks, as top-level siblings, so the seed has a
 * block to seed at the row floor. The block keys and the piece keys never meet (`end(key)` and
 * `sectionEnd(section)` spell one namespace).
 */
export const QUOTE_SEED_IDS = {
  piece: (key: string) => `seed:${key}`,
  end: (key: string) => `seed:end:${key}`,
  start: (section: string) => `seed:start:${section}`,
  sectionEnd: (section: string) => `seed:end:${section}`,
} as const;
const SEED = QUOTE_SEED_IDS;

type Margin4 = [number, number, number, number];

/** A node's margin as four figures (this flow states every margin it seeds as four, or none). */
function marginOf(node: object): Margin4 {
  const margin = (node as { margin?: unknown }).margin;
  return Array.isArray(margin) && margin.length === 4 ? margin as Margin4 : [0, 0, 0, 0];
}

/** A piece wrapped for the seed: its id on a stack around it, its vertical margins moved onto that
 *  stack and its end mark after it inside them, so the end mark reports the piece's bottom and not
 *  its margin's (the statement's `seedPiece`; it lays out the same). With no seed, the piece itself,
 *  unchanged. */
function seedPiece(ctx: Ctx, key: string, node: Content): Content {
  if (!ctx.seed) return node;
  const [l, t, r, b] = marginOf(node as object);
  return {
    id: SEED.piece(key),
    stack: [{ ...(node as object), margin: [l, 0, r, 0] } as Content, mark(SEED.end(key))],
    margin: [0, t, 0, b],
  } as Content;
}

/** A one-node section under the seed (`parties`, `intro`, `column_header`, `closing`; the
 *  statement's `seedSection`): one stack holding the node's vertical margins, its `start` mark, the
 *  node with its vertical margins moved off and its `sectionEnd` mark, so the two marks stand at the
 *  node's own top and bottom (a canvas block is drawn with that node's vertical margins zeroed). A
 *  section that answers no node emits its two marks alone, as top-level siblings. A section that
 *  answers more than one node is refused by name under the seed, never cut to its first: the seed
 *  would drop a node the flow prints. With no seed, the nodes unchanged, and nothing refused. */
function seedSection(ctx: Ctx, section: string, nodes: Content[]): Content[] {
  if (!ctx.seed) return nodes;
  if (nodes.length > 1) throw new Error(`A quote one-node section answers one node; ${section} answered ${nodes.length}.`);
  if (nodes.length === 0) return [mark(SEED.start(section)), mark(SEED.sectionEnd(section))];
  const [node] = nodes;
  const [l, t, r, b] = marginOf(node as object);
  return [{
    stack: [mark(SEED.start(section)), { ...(node as object), margin: [l, 0, r, 0] } as Content, mark(SEED.sectionEnd(section))],
    margin: [0, t, 0, b],
  }];
}

/** A section marked by top-level siblings under the seed: its `start` and `sectionEnd` marks around
 *  its own nodes, whose margins stay as the flow builds them, so every margin lies inside the two
 *  marks (the zero-size marks add no height). `lines` is several-node (the invoice's shape), so its
 *  start mark lies above the first grid row's 2 pt. `liability` is design §5.2's per-key exception to
 *  `seedSection`: the canvas keeps its node's 10 pt top margin inside its block (`blockChildren`,
 *  src/server/quote-canvas.ts), so the block's drawn top is ABOVE that margin; under `seedSection`
 *  the start mark would land 10 pt lower and the seed would draw the liability 10 pt below the
 *  flow's. With blank wording, the two marks alone. With no seed, the nodes unchanged. */
function seedSiblings(ctx: Ctx, section: string, nodes: Content[]): Content[] {
  if (!ctx.seed) return nodes;
  return [mark(SEED.start(section)), ...nodes, mark(SEED.sectionEnd(section))];
}

// ---------------------------------------------------------------------------------------------
// Blocks, top to bottom in sample order. Each returns Content[] — empty means "nothing left to
// draw" and the block drops from the stack.
// ---------------------------------------------------------------------------------------------

/**
 * The centered "Quotation" title over the company block, with "Quotation Number: N" to its right —
 * the sample's header. The 170pt left spacer balances the 170pt number column so the title truly
 * centers (the cert headerBlock's own trick). A placed logo (spec §6.3) unshifts into the centered
 * stack (header-center), replaces the left spacer (header-left) or unshifts into the number column
 * (header-right); no logo → today's plain three-column layout, byte-for-byte.
 */
function headerBlock(ctx: Ctx, d: QuotePdfData): Content[] {
  const v = ctx.sections.get("header")!;
  const center: Content[] = [];
  for (const key of v.order.filter((k) => ["title", "company_name", "company_address"].includes(k) && v.field(k).visible)) {
    if (key === "title") {
      center.push(seedPiece(ctx, key, { text: v.field("title").label, bold: true, fontSize: ctx.fonts.headingSize, alignment: "center" }));
    } else if (key === "company_name") {
      center.push(seedPiece(ctx, key, { text: d.company.name, bold: true, fontSize: 13, alignment: "center", margin: [0, 2, 0, 0] }));
    } else {
      const lines: Content[] = addressLines(d).map((line) => ({ text: line, fontSize: 10, alignment: "center" }));
      // Under the seed the address's lines take ONE wrapper (one item stands for them all); a blank
      // address prints no line and gives no piece, as the flow prints nothing there. With no seed,
      // each line a child of the centre stack, as before the canvas lane.
      if (!ctx.seed) center.push(...lines);
      else if (lines.length > 0) center.push(seedPiece(ctx, key, { stack: lines }));
    }
  }

  const showNumber = v.field("quote_number").visible;
  const number = numberText(v.field("quote_number").label, d);
  const numberNode: Content = seedPiece(ctx, "quote_number", { text: number, fontSize: 11 });

  // Under the seed the image carries its id (an image is no text node) and an end mark follows it.
  const logoNodes: Content[] | null = ctx.logo === null ? null
    : ctx.seed
      ? [{ image: ctx.logo.dataUri, width: ctx.logo.width, id: SEED.piece("logo") } as Content, mark(SEED.end("logo"))]
      : [{ image: ctx.logo.dataUri, width: ctx.logo.width }];
  if (logoNodes !== null && ctx.logo!.placement === "header-center") center.unshift(...logoNodes);

  const leftColumn: Column = logoNodes !== null && ctx.logo!.placement === "header-left"
    ? { width: W.headerSide, stack: logoNodes }
    : { width: W.headerSide, text: "" };

  // Default (no header-right logo): the number is a single text node, byte-identical to today's
  // `{ width: 170, text: [...], fontSize: 11 }`. A header-right logo stacks over it. Under the seed
  // the number is its piece's wrapper, in a stack of the column's width.
  const rightColumn: Column = logoNodes !== null && ctx.logo!.placement === "header-right"
    ? { width: W.headerSide, stack: [...logoNodes, ...(showNumber ? [numberNode] : [])] }
    : (showNumber
        ? (ctx.seed ? { width: W.headerSide, stack: [numberNode] } : { width: W.headerSide, text: number, fontSize: 11 })
        : { width: W.headerSide, text: "" });

  return [{ columns: [leftColumn, { width: "*", stack: center }, rightColumn], columnGap: W.headerGap, margin: [0, 0, 0, 10] }];
}

/** The company address's non-blank lines, trimmed, as the header prints them (one centred line each). */
function addressLines(d: QuotePdfData): string[] {
  return d.company.address.split("\n").filter((l) => l.trim() !== "").map((l) => l.trim());
}

/** The header's number line: the `quote_number` label, bold with its one space, then the number. */
function numberText(label: string, d: QuotePdfData): (string | { text: string; bold: boolean })[] {
  return [{ text: `${label} `, bold: true }, String(d.quoteNumber)];
}

/** A bold label with a regular value — the sample's "Effective: 06/30/2018" line shape.
 *  `topMargin` separates the sample's own line groups (RFQ and phone sit apart). */
const labelled = (label: string, value: string, topMargin: number): Content =>
  ({ text: [{ text: label, bold: true }, value], fontSize: 9.5, margin: [0, topMargin, 0, 0] });

/** The info column's fields → their value + sample top-margin. Each field carries its OWN margin
 *  (unlike the invoice's position rule — the sample's RFQ and phone sit apart from the block above). */
const INFO_TOP_MARGIN: Record<string, number> = {
  company_phone: 1, effective: 1, expires: 1, terms: 1, rfq_number: 8, customer_phone: 8,
};

/** The Attn block left (contact name when picked, then customer name + bill-to address — the
 *  invoice's address resolution), the info block right (company phone, Effective / Expires On /
 *  Terms, "Your R.F.Q. Number", the contact's phone where the model has one — no fax lines: no
 *  fax field exists, see the file comment). */
function partiesBlock(ctx: Ctx, d: QuotePdfData): Content[] {
  const v = ctx.sections.get("parties")!;
  const attnLines: Content[] = [];
  for (const key of v.order.filter((k) => ["attn", "bill_to"].includes(k) && v.field(k).visible)) {
    if (key === "attn") {
      if (d.attn !== "") attnLines.push({ text: [{ text: `${v.field("attn").label} `, bold: true }, d.attn], fontSize: 10 });
    } else {
      for (const line of d.billTo) attnLines.push({ text: line, fontSize: 10 });
    }
  }

  const value: Record<string, string> = {
    company_phone: d.company.phone, effective: ctx.date(d.effectiveDate), expires: ctx.date(d.expiryDate),
    terms: d.termsName, rfq_number: d.rfqNumber, customer_phone: d.customerPhone,
  };
  const infoLines: Content[] = [];
  for (const key of v.order.filter((k) => k in INFO_TOP_MARGIN && v.field(k).visible)) {
    // Phone lines omit when the model carries no value (the sample's own optional-line rule); the
    // rest keep the label with a blank value (the cert's keep-the-label rule).
    if ((key === "company_phone" || key === "customer_phone") && value[key] === "") continue;
    infoLines.push(labelled(`${v.field(key).label} `, value[key], INFO_TOP_MARGIN[key]));
  }

  if (attnLines.length === 0 && infoLines.length === 0) return [];
  return [{
    columns: [
      { width: "*", stack: attnLines, margin: [W.partiesIndent, 10, 0, 0] },
      { width: W.quoteFields, stack: infoLines },
    ],
    columnGap: W.partiesGap,
    margin: [0, 0, 0, 8],
  }];
}

/** The intro line — renders the `quote_intro_text` block (data seam), byte-identical to today's
 *  unconditional line. No fields of its own (the shipper-liability text-block shape). */
function introBlock(d: QuotePdfData): Content[] {
  return [{ text: d.introText, fontSize: 9.5, margin: [0, 2, 0, 4] }];
}

/** The one boxed strip naming the visible data columns — the sample's header row over the lines. */
function columnHeaderStrip(ctx: Ctx): Content[] {
  const cols = gridColumns(ctx);
  if (cols.length === 0) return [];
  return [{
    table: { widths: cols.map((c) => c.width), body: [cols.map((c) => head(c.label, HEADER_ALIGN[c.slot]))] },
    layout: LAYOUT.boxed,
    margin: [0, 0, 0, 4],
  }];
}

/** The quantity cell: the quoted qty, "Unlimited", or blank (ruling 9 — informational). */
function qtyCell(ctx: Ctx, line: QuotePdfLine): string {
  if (line.quotedUnlimited) return "Unlimited";
  return line.quotedQty === null ? "" : ctx.qty(line.quotedQty);
}

/** One line's grid row (qty | stacked identity | each weight | net weight), aligned to the column
 *  grid. Each value drops (blank cell / empty stack) when its `lines`-section field is hidden. The
 *  two weights print with their unit, through `lb`; a blank one prints no unit. */
function lineGridRow(ctx: Ctx, line: QuotePdfLine): Content {
  const v = ctx.sections.get("lines")!;
  const cell = (c: GridCol): Column => {
    switch (c.slot) {
      case "qty": return { width: c.width, text: v.field("line_qty").visible ? qtyCell(ctx, line) : "", fontSize: 9, alignment: "right" };
      case "info": return {
        width: c.width,
        stack: v.field("line_part").visible
          ? [line.partNumber, line.partName, line.partDescription].filter((t) => t !== "").map((text): Content => ({ text, fontSize: 9 }))
          : [],
        margin: [W.infoIndent, 0, 0, 0],
      };
      case "each": return { width: c.width, text: lb(v.field("line_each_weight").visible && line.eachWeight !== null ? ctx.weight(line.eachWeight) : ""), fontSize: 9, alignment: "right" };
      default: return { width: c.width, text: lb(v.field("line_total_lbs").visible && line.totalLbs !== null ? ctx.weight(line.totalLbs) : ""), fontSize: 9, alignment: "right" };
    }
  };
  return { columns: gridColumns(ctx).map(cell), columnGap: W.gridGap, margin: [0, 2, 0, 0] };
}

/** The centered "Setup charge:  $2.00   Plus" detail lines beneath a price row — the sample's
 *  arrangement in 5A vocabulary (spec §6). "Plus" trails the setup only when a visible price or
 *  minimum follows it; "Or" trails the per-unit price only when a visible minimum follows (the
 *  invoice's showOr shape, re-ordered to the sample's setup-first stack). */
function priceDetailLine(label: string, value: string, trailer: "" | "Plus" | "Or"): Content {
  return {
    text: `${label}  ${value}${trailer === "" ? "" : `   ${trailer}`}`,
    fontSize: 9, alignment: "center", margin: [0, 1, 0, 0],
  };
}

/** One price row: step name (+ its notes) left, the engine's indicative amount right (grid-aligned),
 *  the price details and any break rows centered beneath. */
function priceRow(ctx: Ctx, row: QuotePdfPriceRow): Content[] {
  const v = ctx.sections.get("lines")!;
  const opCell = (c: GridCol): Column => {
    if (c.slot === "info") return {
      width: c.width,
      stack: [
        ...(v.field("step_name").visible ? [{ text: row.stepName, bold: true, fontSize: 9 } satisfies Content] : []),
        ...(v.field("step_notes").visible && row.notes !== "" ? [{ text: row.notes, fontSize: 8.5, margin: [0, 1, 0, 0] } satisfies Content] : []),
      ],
      margin: [W.infoIndent, 0, 0, 0],
    };
    if (c.slot === "amt") return { width: c.width, text: v.field("price_amount").visible && row.amount !== null ? ctx.money(row.amount) : "", fontSize: 9, alignment: "right" };
    return { width: c.width, text: "" };
  };
  const out: Content[] = [{ columns: gridColumns(ctx).map(opCell), columnGap: W.gridGap, margin: [0, 4, 0, 0] }];

  const hasPrice = v.field("price_per").visible && row.unitPrice !== null;
  const hasMin = v.field("minimum_charge").visible && row.minimumCharge !== null;
  if (v.field("setup_charge").visible && row.setupCharge !== null) {
    out.push(priceDetailLine(v.field("setup_charge").label, ctx.money(row.setupCharge), hasPrice || hasMin ? "Plus" : ""));
  }
  if (v.field("price_per").visible && row.unitPrice !== null) {
    out.push(priceDetailLine(`${v.field("price_per").label} ${row.pricePerLabel}:`, ctx.money4(row.unitPrice), hasMin ? "Or" : ""));
  }
  if (v.field("minimum_charge").visible && row.minimumCharge !== null) {
    out.push(priceDetailLine(v.field("minimum_charge").label, ctx.money(row.minimumCharge), ""));
  }
  // Break rows, when present (ruling 2): threshold in the row's own basis unit (pieces, or pounds
  // on an LB row — the engine's breakBasis rule), price at the money4 precision. A threshold in
  // pounds is a printed weight, so it takes its unit through `lb` (owner ruling W15): "1,000 lb
  // or more:". A threshold in pieces stays bare.
  if (v.field("breaks").visible) {
    for (const brk of row.breaks) {
      out.push(priceDetailLine(`${row.pricedPerLb ? lb(ctx.num(brk.threshold)) : ctx.num(brk.threshold)} ${v.field("breaks").label}`, ctx.money4(brk.price), ""));
    }
  }
  return out;
}

/** One surcharge estimate row (#948, spec §5.7): "<name> <rate> <label>[:]" left, the estimated
 *  amount right, on the price row's grid. The amount slot is blank for an unpriceable estimate
 *  (null) and while the indicative amount field is hidden; the colon rides only a printed figure. */
function surchargeRow(ctx: Ctx, s: QuotePdfSurcharge): Content {
  const v = ctx.sections.get("lines")!;
  const showAmount = v.field("price_amount").visible && s.amount !== null;
  const text = [s.name, s.rateText, v.field("surcharge_estimate").label].filter(Boolean).join(" ");
  const cell = (c: GridCol): Column => {
    if (c.slot === "info") return { width: c.width, text: showAmount ? `${text}:` : text, fontSize: 9, margin: [W.infoIndent, 0, 0, 0] };
    if (c.slot === "amt") return { width: c.width, text: showAmount ? ctx.money(s.amount as number) : "", fontSize: 9, alignment: "right" };
    return { width: c.width, text: "" };
  };
  return { columns: gridColumns(ctx).map(cell), columnGap: W.gridGap, margin: [0, 4, 0, 0] };
}

/** One quote line's whole body: the grid row, Material, then its underlined PRICE section. */
function lineBlock(ctx: Ctx, line: QuotePdfLine): Content[] {
  const v = ctx.sections.get("lines")!;
  const out: Content[] = [lineGridRow(ctx, line)];
  // "Material: X" beneath the identity, indented under the sample's own placement. The label is
  // SUPPRESSED when the value is blank (owner ruling 8, 2026-08-12 demo — #100 item 9): a part
  // with no material assigned, or a free-text line with no materialText, must not print a bare
  // "Material:". Value-based suppression, deliberately NOT a config knob — the template
  // contract is untouched, so the §5.3 three-copy drift guard is unaffected.
  if (v.field("material").visible && line.material !== "") {
    out.push({
      text: [{ text: `${v.field("material").label} `, bold: true }, line.material],
      fontSize: 9, margin: [ctx.qtyW + W.infoIndent, 6, 0, 0],
    });
  }
  if (line.prices.length > 0) {
    if (v.field("price_heading").visible) {
      out.push({ text: v.field("price_heading").label, bold: true, decoration: "underline", fontSize: 9, margin: [ctx.qtyW + W.infoIndent, 8, 0, 2] });
    }
    for (const row of line.prices) out.push(...priceRow(ctx, row));
    if (v.field("surcharge_estimate").visible) {
      for (const s of line.surcharges) out.push(surchargeRow(ctx, s));
    }
  }
  return out;
}

/** The whole `lines` section: every quote line's body, in order. */
function linesBlock(ctx: Ctx, d: QuotePdfData): Content[] {
  return d.lines.flatMap((line) => lineBlock(ctx, line));
}

/** The closing block: ending statement + quote notes left, the signature block right (rule,
 *  quotedBy's name, title — blank title prints nothing, ruling 14). */
function closingBlock(ctx: Ctx, d: QuotePdfData): Content[] {
  const v = ctx.sections.get("closing")!;
  const leftLines: Content[] = [];
  for (const key of v.order.filter((k) => ["ending_statement", "quote_notes"].includes(k) && v.field(k).visible)) {
    if (key === "ending_statement") {
      if (d.endingStatementText !== "") leftLines.push({ text: d.endingStatementText, fontSize: 9.5 });
    } else if (d.notes !== "") {
      leftLines.push({ text: d.notes, fontSize: 9.5, margin: [0, 6, 0, 0] });
    }
  }

  const signature: Content = {
    stack: [
      { canvas: [{ type: "line", x1: 0, y1: 0, x2: W.signature, y2: 0, lineWidth: 1 }] },
      ...(v.field("signer_name").visible ? [{ text: d.signer.name, fontSize: 10, margin: [4, 3, 0, 0] } satisfies Content] : []),
      ...(v.field("signer_title").visible && d.signer.title !== "" ? [{ text: d.signer.title, fontSize: 10, margin: [4, 1, 0, 0] } satisfies Content] : []),
    ],
    margin: [0, 10, 0, 0],
  };
  return [{
    columns: [
      { width: "*", stack: leftLines },
      { width: W.signature, stack: [signature] },
    ],
    columnGap: W.closingGap,
    margin: [0, 18, 0, 0],
  }];
}

/** The liability fine print full-width beneath the closing (the sample's own bottom strip);
 *  renders the `quote_liability_text` block (data seam), omitting the strip when blank. */
function liabilityBlock(d: QuotePdfData): Content[] {
  return d.liabilityText === "" ? [] : [{ text: d.liabilityText, fontSize: 6.5, margin: [0, 10, 0, 0] }];
}

/**
 * The quote's identity band — what a quote overflowing LETTER repeats on its continuation pages. A
 * real quote genuinely overflows: its lines are unbounded (createQuote requires min 1, no max) and
 * each is TALL (grid row + Material + a PRICE section of several detail lines). Its identity is the
 * quote number under the `quote_number` field's own label. Rendered REGARDLESS of the config's
 * visibility flags (the invoice/BOL/cert band's identity treatment — identity on paper is locked,
 * not configurable), though the `quote_number` label override carries.
 * The flow's alone, and unchanged by the canvas: a canvas quote prints none of this band. Its repeat
 * band, on the same continuation seam, holds the items its layout marks to repeat (the seed flags the
 * `quote_number` item where it stands page-top and ends a grid step or more above the first block,
 * design 2026-11-12 call 2), with
 * "(continued)" at the band's bottom-left (`assembleCanvasSheet`, src/server/pdf/canvas-sheet.ts).
 */
const CONTINUATION_TOP_MARGIN = QUOTE_PAGE.overflowTopMargin;
function continuationHeader(ctx: Ctx, d: QuotePdfData): Content {
  const v = ctx.sections.get("header")!;
  return {
    stack: [
      { text: `${v.field("quote_number").label} ${d.quoteNumber}`, bold: true, fontSize: 11 },
      { text: "(continued)", italics: true, fontSize: ctx.fonts.smallSize },
    ],
    margin: [24, 10, 24, 0],
  };
}

/** One config section key → its renderer. An unknown key renders nothing: the validator refused it
 *  before any config stored it. */
function renderSection(key: string, ctx: Ctx, d: QuotePdfData): Content[] {
  // Under the seed each block section is marked by its kind (design 2026-11-12 §5.3, since quote
  // canvas PR 2): the one-node sections through `seedSection`, the lines and the liability through
  // `seedSiblings`; with no seed both answer the nodes unchanged. The header's pieces are marked
  // inside `headerBlock`.
  switch (key) {
    case "header": return headerBlock(ctx, d);
    case "parties": return seedSection(ctx, key, partiesBlock(ctx, d));
    case "intro": return seedSection(ctx, key, introBlock(d));
    case "column_header": return seedSection(ctx, key, columnHeaderStrip(ctx));
    // Several-node: every node's margins as the flow builds them, inside the two marks.
    case "lines": return seedSiblings(ctx, key, linesBlock(ctx, d));
    case "closing": return seedSection(ctx, key, closingBlock(ctx, d));
    // The per-key exception (design §5.2): the start mark above the kept 10 pt (`seedSiblings`).
    case "liability": return seedSiblings(ctx, key, liabilityBlock(d));
    default: return [];
  }
}

/** Today's ctx over a section list: the lens, the formatters and the `qtyW` arithmetic, read from the
 *  list's `column_header` section (the flow hands it every section; the canvas's lens, since quote
 *  canvas PR 2, hands it the grid the lines print under). A `"*"` quantity column indents by its
 *  52 pt default; a hidden one by nothing. */
function ctxOf(config: TemplateConfig, sectionConfigs: SectionConfig[], logo: Ctx["logo"]): Ctx {
  const sections = new Map(sectionConfigs.map((sc) => [sc.key, sectionView(sc)] as const));
  const qtyV = sections.get("column_header")!.field("col_qty");
  const qtyW = qtyV.visible && typeof qtyV.width === "number" ? qtyV.width : (qtyV.visible ? 52 : 0);
  return {
    fonts: config.fonts,
    money: makeMoney(config.formats),
    money4: makeMoney4(config.formats),
    weight: makeWeight(config.formats),
    qty: makeQty(config.formats),
    num: makeNum(config.formats),
    date: makeDate(config.formats),
    sections,
    qtyW,
    logo,
  };
}

// ---------------------------------------------------------------------------------------------
// The built-in default quotation template (spec §6, P7 spec §5.4). PURE — data and config in, JSON
// out; the footer is now the declarative `pageFooterSpec` (retired from the Phase 6 callback).
// ---------------------------------------------------------------------------------------------

/**
 * `config` is a **backfilled** `TemplateConfig` (what `resolveTemplateForPrint` returns) and DEFAULTS
 * to the contract's own `DEFAULT_CONFIG` — so a config-less call renders exactly today's paper (the
 * golden-compat gate, tests/quote-pdf.test.ts). `logoDataUri` is the invoice's deliberate extra
 * parameter: the logo bytes belong to the resolved template version, not to the quote data. The
 * bottom margin is 44 unconditionally (the quote has always carried the page line): the `pageFooter`
 * knob (default TRUE — the quote alone) does not change the margin, only whether the page line prints.
 *
 * It branches once on `config.layout` (design 2026-11-12 §4.4, since quote canvas PR 2): a layout
 * prints the canvas (`buildCanvasQuoteDefinition`, src/server/quote-canvas.ts), handed the flow's own
 * builders (`QUOTE_FLOW`); a null layout prints the flow below, exactly as before the canvas lane.
 *
 * `seedIds` (since quote canvas PR 2) is the canvas seed's layout pass alone: the flow marks the
 * pieces and blocks a canvas item stands for (`QUOTE_SEED_IDS`) and lays out exactly as it does
 * without them. Every print and preview leaves it off, and the canvas branch ignores it.
 */
export function buildQuoteDefinition(
  input: QuotePdfData,
  config: TemplateConfig = DEFAULT_CONFIG,
  logoDataUri?: string,
  options: { seedIds?: boolean } = {},
): RenderableDefinition {
  if (config.layout !== null) return buildCanvasQuoteDefinition(input, config, config.layout, QUOTE_FLOW, logoDataUri);
  // The §5.6 belt's OMISSION half: views resolve over `completeSections`, never `config.sections`
  // raw, so a raw config omitting an entry cannot drop it.
  const sectionConfigs = completeSections(QUOTE_CONTRACT, config.sections);
  const ctx: Ctx = {
    ...ctxOf(config, sectionConfigs, config.logo !== null && logoDataUri !== undefined
      ? { placement: config.logo.placement, width: config.logo.width, dataUri: logoDataUri }
      : null),
    ...(options.seedIds === true ? { seed: true as const } : {}),
  };
  const sections = ctx.sections;

  const content: Content[] = [];
  // Stack order IS the config's section order; hidden sections are omitted (nothing on this contract
  // is locked, so the belt forces none back).
  for (const sc of sectionConfigs) {
    if (!sections.get(sc.key)!.visible) continue;
    content.push(...inBoxFlowSection("QUOTE", sc.key, renderSection(sc.key, ctx, input)));
  }

  return {
    pageSize: "LETTER",
    pageMargins: [24, 24, 24, QUOTE_PAGE.bottomMargin],
    defaultStyle: { font: config.fonts.family, fontSize: config.fonts.baseSize },
    // No `info.creationDate`, no clock anywhere — every date on the paper is data (the traveler's
    // purity rule). The `pageFooter` knob (spec §6.1) turns the real per-page "Page: N of M" line on
    // via render.ts's pageNofM callback (label "Page:" reproduces the retired Phase 6 footer exactly);
    // OFF prints no footer. The quote alone defaults TRUE — golden compatibility with the line it
    // already prints.
    ...(config.pageFooter ? { pageFooterSpec: { kind: "pageNofM" as const, label: "Page:" } } : {}),
    content,
    continuationHeaderSpec: {
      content: continuationHeader(ctx, input),
      overflowTopMargin: CONTINUATION_TOP_MARGIN,
    },
  };
}

/** The flow's own builders, for the canvas path (src/server/quote-canvas.ts, since quote canvas PR 2),
 *  which imports only types from this file: it prints each block exactly as the flow does, with no
 *  import cycle (the invoice's `INVOICE_FLOW`, the statement's `STATEMENT_FLOW`). No header node is
 *  exposed: a canvas item prints the title's label, the company name, the address lines and the number
 *  at its own style, from the header fields' text below. */
export type QuoteFlowBuilders = {
  /** `QUOTE_WIDTHS`, carried for parity with `INVOICE_FLOW` and `STATEMENT_FLOW`. The quote's canvas
   *  reads none of it; the seed imports `QUOTE_WIDTHS` directly, and only the identity pin in
   *  tests/quote-canvas.test.ts reads this field. */
  widths: typeof QUOTE_WIDTHS;
  sectionView: (sc: SectionConfig) => QuoteSectionView;
  /** Today's ctx over a section list: the lens, the formatters and the `qtyW` arithmetic, read from
   *  the list's `column_header` section (the canvas's lens hands it the grid's). */
  ctxOf: (config: TemplateConfig, sectionConfigs: SectionConfig[], logo: QuoteCtx["logo"]) => QuoteCtx;
  /** The company address's non-blank lines, trimmed, as the header prints them. */
  addressLines: (d: QuotePdfData) => string[];
  /** The header's number line: `[{ text: "<label> ", bold: true }, "<number>"]`. */
  numberText: (label: string, d: QuotePdfData) => (string | { text: string; bold: boolean })[];
  partiesBlock: (ctx: QuoteCtx, d: QuotePdfData) => Content[];
  introBlock: (d: QuotePdfData) => Content[];
  columnHeaderStrip: (ctx: QuoteCtx) => Content[];
  linesBlock: (ctx: QuoteCtx, d: QuotePdfData) => Content[];
  closingBlock: (ctx: QuoteCtx, d: QuotePdfData) => Content[];
  liabilityBlock: (d: QuotePdfData) => Content[];
};

export const QUOTE_FLOW: QuoteFlowBuilders = {
  widths: QUOTE_WIDTHS, sectionView, ctxOf, addressLines, numberText,
  partiesBlock, introBlock, columnHeaderStrip, linesBlock, closingBlock, liabilityBlock,
};

/** The item node a canvas quote's sheet is assembled with (src/server/quote-canvas.ts's
 *  `firstQuoteItemContent`, handed the flow's builders), for the preview's alone layouts. */
export function quoteCanvasItemContent(input: QuotePdfData, config: TemplateConfig, logoDataUri?: string): ItemContent {
  if (config.layout === null) throw new Error("quoteCanvasItemContent needs a canvas config.");
  return firstQuoteItemContent(input, config, config.layout, QUOTE_FLOW, logoDataUri);
}

/** A seeded field item's style (since quote canvas PR 2): the flow's own size, weight and alignment
 *  for that key (design 2026-11-12 §5.3), so the item prints its text as the flow prints it; null
 *  for a key the seed places no field for (the parties' and the grid's rows are a block's). The
 *  number's label prints bold inside its text, as the flow's does; the style is the line's own,
 *  regular. */
export function quoteSeedStyle(key: string, fonts: FontsConfig): CanvasTextStyle | null {
  switch (key) {
    case "title": return { size: fonts.headingSize, bold: true, align: "center" };
    case "company_name": return { size: 13, bold: true, align: "center" };
    case "company_address": return { size: 10, bold: false, align: "center" };
    case "quote_number": return { size: 11, bold: false, align: "left" };
    default: return null;
  }
}
