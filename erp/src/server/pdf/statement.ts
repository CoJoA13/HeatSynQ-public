/**
 * The open-item customer statement (P5B design spec §8). PURE by construction, the invoice/cert
 * contract: `StatementData` + a validated `TemplateConfig` in, a plain-JSON pdfmake definition out —
 * no I/O, no clock, nothing that would not survive `JSON.parse(JSON.stringify())` (asserted in
 * tests/statement-pdf.test.ts). The reads live in `statements.ts` (`buildStatement`), the bytes in
 * `render.ts`.
 *
 * A CONFIG-CONSUMER since Phase 7 Task 13 (P7 spec §5.4) — the invoice/BOL/cert lens (`sectionView`
 * over `completeSections`, the §5.6 belt in both halves): sections/fields/labels/widths/fonts/
 * formats/logo render from a validated config, and the default config reproduces today's paper
 * exactly (the golden gate, tests/statement-pdf.test.ts, untouched).
 *
 * **THE STATEMENT IS A FULLY-LIVE REBUILD — the THIRD snapshot posture, and the OPPOSITE of the
 * invoice.** An invoice is frozen paper (its identity/pricing columns read UNCONDITIONALLY, never
 * re-joined); a shipper/cert live-joins with a snapshot fallback. A statement is neither: it is
 * rebuilt fresh from live A/R every time it is printed (`statements.ts` reads the live open items,
 * the live default BILL_TO address, the point-in-time aging), and it is reprintable identically only
 * because printing ARCHIVES its OUTPUT, not because its input is frozen — a data change between two
 * prints shows in the second. This builder is pure `StatementData` → definition; the live-read
 * discipline is `statements.ts`'s, and this config-consumer conversion adds no frozen-column
 * constraint of its own.
 *
 * Unlike the invoice/cert/traveler templates, there is no owner-supplied sample to mirror — a
 * statement is a document type this phase INTRODUCES (spec §8). The layout below is this project's
 * own built-in default: a centered title over the company name, a customer + remit-to header, the
 * open-item table, the five-bucket aging strip with its own Unapplied column (owner ruling 8 — never
 * folded into a bucket) and Net, an optional finance-charge line, and the total due.
 *
 * A config whose `layout` is a canvas prints the canvas instead, on every path a statement prints
 * through (statement canvas PR 2, design 2026-11-11 §4.4): `buildStatementDefinition` branches once to
 * `buildCanvasStatementDefinition` (src/server/statement-canvas.ts), handed this flow's own builders
 * (`STATEMENT_FLOW`), so a canvas prints the same blocks from the same `StatementData`; a null layout
 * prints the flow below, exactly as before the canvas lane.
 *
 * `StatementData` is owned HERE (the `InvoicePdfData` pdf-module-owns-its-input-type precedent) so
 * this file imports nothing from the service layer and the dependency stays one-directional
 * (`statements.ts` imports `buildStatementDefinition` and re-exports this type — never the reverse).
 */
import type { Column, Content, ContentTable, TableCell } from "pdfmake/interfaces";
import { LAYOUT, type RenderableDefinition } from "./render";
import { inBoxFlowSection } from "./flow-tables";
import type { ItemContent } from "./canvas-sheet";
import { mark, spacer } from "./canvas-nodes";
import { buildCanvasStatementDefinition, firstStatementItemContent } from "../statement-canvas";
import { STATEMENT_CONTRACT, DEFAULT_CONFIG } from "../../lib/template-contracts/statement";
import {
  completeSections,
  type FontsConfig, type FormatsConfig, type LogoPlacement, type SectionConfig,
  type TemplateConfig,
} from "../../lib/template-contracts/types";
import type { CanvasTextStyle } from "../../lib/template-contracts/canvas";
import type { AgingRow } from "../aging";
import type { InvoiceCompany, InvoiceRemitTo } from "./invoice";

// ---------------------------------------------------------------------------------------------
// StatementData — the builder's whole input. Plain data: no Decimals, no Dates, no Prisma rows.
// `customer.billTo` is read LIVE off the customer's current default BILL_TO address (statements.ts)
// — unlike an invoice's frozen snapshot, a statement is rebuilt fresh every print, so these are the
// current address, not paper raised once. Its lines are `party-address.ts`'s (R14, #671): the row's
// name above the customer's, which the Customer line above the block carries too.
// ---------------------------------------------------------------------------------------------

export type StatementOpenItem = {
  documentNumber: string; date: string; dueDate: string | null; kind: "INVOICE" | "CREDIT" | "PAYMENT";
  original: number; open: number;
};

export type StatementData = {
  asOf: string;
  company: InvoiceCompany;
  remitTo: InvoiceRemitTo;
  customer: { code: string; name: string; billTo: string[] };
  openItems: StatementOpenItem[];
  aging: AgingRow;
  financeCharge: number | null;
  totalDue: number;
};

// ---------------------------------------------------------------------------------------------
// Formatting. Pure, config-driven (P7 spec §5.4), locale pinned (the invoice's own rule) so output
// never tracks the server's.
// ---------------------------------------------------------------------------------------------

/** Money with a leading "$", `priceDecimals` decimals and `thousandsSeparator` grouping. The
 *  `negativeStyle` knob formats the statement's negative money (a credit or on-account PAYMENT row's
 *  Open amount, a net-negative aging bucket): `SIGN_AFTER_SYMBOL` (default) is today's "$-200.00";
 *  `LEADING_MINUS` is "-$200.00"; `PARENTHESES` is "($200.00)". The default knobs reproduce today's
 *  `money()` byte-for-byte (the makeMoney the invoice contract declares — copied, its own precedent). */
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

const MONTHS_FULL = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A date, driven by the contract's ONE date knob (default "MMMM D, YYYY" — the statement's own
 * "July 29, 2026" long-FULL-month style, shared with the invoice). Both date slots — the Statement
 * Date and each open item's Date/Due Date — print through the SAME renderer (`longDate` was the sole
 * date function), so the single knob maps directly with no two-styles trap. Pure string work —
 * parsing to a Date would drag a timezone into a date-only value.
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
      default: return `${MONTHS_FULL[Number(m) - 1]} ${Number(d)}, ${y}`; // "MMMM D, YYYY" — today's
    }
  };
}

// ---------------------------------------------------------------------------------------------
// The config lens (P7 spec §5.4) — the invoice/BOL/cert `sectionView`, applied to the statement's
// blocks. The builder ASSUMES a complete config (`validateConfig`'s §5.3 backfill guarantees every
// entry exists); only the null-means-contract-default knobs a complete config still carries resolve.
//
// THE §5.6 BELT, both halves: the flag half (`visible || !hideable` / `visible || !removable`) is the
// invoice's expression verbatim — NOTHING on this contract is locked, so it forces nothing and a
// config may hide anything; the omission half is `completeSections` in `buildStatementDefinition`
// below, so a raw config that OMITS an entry still renders it. The statement carries no text blocks
// (its texts are all data or labels), so the BOL's third, text-block half is absent here.
// ---------------------------------------------------------------------------------------------

const CONTRACT_SECTIONS = new Map(STATEMENT_CONTRACT.sections.map((s) =>
  [s.key, { section: s, fields: new Map(s.fields.map((f) => [f.key, f])) }] as const));

type FieldView = { visible: boolean; label: string; width: number | "*" };
/** One section of a complete config seen through the contract: the §5.6 belt's flag half applied. */
export type StatementSectionView = {
  visible: boolean;
  /** Field keys in config (= display) order; per-field visibility still applies at use. */
  order: string[];
  field: (key: string) => FieldView;
};

type SectionView = StatementSectionView;

function sectionView(sc: SectionConfig): SectionView {
  const cs = CONTRACT_SECTIONS.get(sc.key);
  // Unknown keys were refused by the validator before any config could be stored; a miss here is a
  // caller bug, not a config state.
  if (cs === undefined) throw new Error(`Unknown STATEMENT template section "${sc.key}"`);
  const byKey = new Map(sc.fields.map((f) => [f.key, f]));
  return {
    visible: sc.visible || !cs.section.hideable, // the belt, section half (nothing locked here)
    order: sc.fields.map((f) => f.key),
    field: (key) => {
      const cf = cs.fields.get(key);
      if (cf === undefined) throw new Error(`Unknown STATEMENT template field "${sc.key}.${key}"`);
      const fc = byKey.get(key);
      return {
        visible: (fc?.visible ?? true) || !cf.removable, // the belt, field half
        label: fc?.label ?? cf.defaultLabel,
        width: fc?.width ?? cf.column?.defaultWidth ?? "*",
      };
    },
  };
}

/** Everything a section renderer needs, threaded once instead of parameter-by-parameter. */
export type StatementCtx = {
  fonts: FontsConfig;
  money: (value: number) => string;
  date: (iso: string) => string;
  sections: Map<string, SectionView>;
  /** Present only when the resolved version carries logo BYTES and the config PLACES them
   *  (spec §6.3) — either alone renders today's text-only header. */
  logo: { placement: LogoPlacement; width: number; dataUri: string } | null;
  /** The canvas seed's layout pass (`buildStatementDefinition`'s `seedIds`): when true the flow marks
   *  the pieces and blocks a canvas item stands for (`STATEMENT_SEED_IDS`). Absent on every print and
   *  preview, and on every ctx `ctxOf` builds (the canvas's included), which render exactly the nodes
   *  they rendered before. */
  seed?: boolean;
};
type Ctx = StatementCtx;

/** Every fixed width the flow prints with (points), handed to the canvas through `STATEMENT_FLOW`
 *  (statement canvas PR 2); the profile's `STATEMENT_LEAST_WIDTHS` and `boxedFields` (src/lib/template-contracts/statement.ts)
 *  are held to it by tests/statement-canvas.test.ts. The content width, LETTER (612 pt) less the 24 pt
 *  side margins, as invoice.ts and cert.ts state theirs; the identity's left-stack indent, its gap to
 *  the Remit To column and that column's width; `totalLine`'s label and amount columns and the gap
 *  between its columns; and the header's gap beside a side logo. */
export const STATEMENT_WIDTHS = {
  content: 564, identityIndent: 40, identityGap: 12, remitTo: 250,
  totalsLabel: 200, totalsAmount: 100, totalsGap: 6, headerLogoGap: 8,
} as const;
const W = STATEMENT_WIDTHS;

/** The flow's vertical page constants: the 40 pt bottom margin and the continuation pages' 40 pt top
 *  margin. */
export const STATEMENT_PAGE = { bottomMargin: 40, overflowTopMargin: 40 } as const;

/** The fields a canvas prints in a border at the item's box: the Remit To box, boxed on the flow's
 *  paper. The profile's `boxedFields` is held to it by tests/statement-canvas.test.ts. */
export const STATEMENT_BOXED_FIELDS = ["remit_to"] as const;

const head = (text: string, align: "left" | "right"): TableCell => ({ text, bold: true, fontSize: 9, alignment: align });

/**
 * The ids the statement's canvas seed reads back from one layout of its stand-in (design 2026-11-11
 * §5.3), the invoice's `INVOICE_SEED_IDS` shape: emitted only under `seedIds`, and never on a TEXT
 * node (pdfmake refuses two text nodes sharing an id in one document and makes a named destination
 * of a text id). A piece's id is on a wrapper stack around it (`seedPiece`), its `end` mark after it
 * inside that wrapper, BEFORE its bottom margin (moved onto the wrapper), so a piece's box is its
 * line alone; the logo's id is on its image; the Remit To box's wrapper keeps its column's width and
 * opens with a zero-size spacer, so it reports the box's own corner and not its first cell's
 * (`seedBox`). The Bill To, a field-keyed block inside the identity's left stack, carries a `start`
 * mark before its label (so the label's 6 pt top margin lies below the mark, inside the block) and a
 * `sectionEnd` mark after its last line; the left stack ends with `leftColumnEnd`, and the identity
 * opens with `identityStart`, a top-level sibling before its `columns` node. `open_items`, `aging`
 * and `total` are one-node sections, their marks inside the node's own vertical margins, which move
 * onto an outer stack (`seedSection`); `finance_charge` is the per-key exception (`seedSiblings`):
 * its marks are top-level siblings around its node, whose kept 2 pt top margin then lies inside
 * them (design §5.2). A visible section whose builder answers nothing still emits its two marks, as
 * top-level siblings, so the seed has a block to seed at the row floor. The block keys and the piece
 * keys never meet (`end(key)` and `sectionEnd(section)` spell one namespace).
 */
export const STATEMENT_SEED_IDS = {
  piece: (key: string) => `seed:${key}`,
  end: (key: string) => `seed:end:${key}`,
  start: (section: string) => `seed:start:${section}`,
  sectionEnd: (section: string) => `seed:end:${section}`,
  /** The identity's left stack's bottom (after its last shown field). */
  leftColumnEnd: "seed:end:identity-left",
  /** A top-level mark before the identity's `columns` node: the anchor in force here is the Remit To's (the Calls). */
  identityStart: "seed:start:identity",
} as const;
const SEED = STATEMENT_SEED_IDS;

type Margin4 = [number, number, number, number];

/** A node's margin as four figures (this flow states every margin it seeds as four, or none). */
function marginOf(node: object): Margin4 {
  const margin = (node as { margin?: unknown }).margin;
  return Array.isArray(margin) && margin.length === 4 ? margin as Margin4 : [0, 0, 0, 0];
}

/** A piece wrapped for the seed: its id on a stack around it, its vertical margins moved onto that
 *  stack and its end mark after it inside them, so the end mark reports the piece's bottom and not
 *  its margin's (the invoice's `seedPiece`; it lays out the same). With no seed, the piece itself,
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

/** The Remit To column wrapped for the seed (the invoice's `seedBox`): the column's width stays on
 *  the wrapper (without it the wrapper would lay the box out at a "*" width), a zero-size spacer
 *  first, so the wrapper reports the box's own top-left corner (pdfmake gives a stack its first
 *  child's first position, and a table's is its first cell's text, inside the border, the padding
 *  and the cell's margin), then the box and its end mark. With no seed, the column unchanged. */
function seedBox(ctx: Ctx, key: string, width: number, box: ContentTable): Column {
  if (!ctx.seed) return { width, ...box };
  return { width, id: SEED.piece(key), stack: [spacer(0), box, mark(SEED.end(key))] } as unknown as Column;
}

/** A one-node section under the seed (`open_items`, `aging`, `total`; the invoice's `seedSection`):
 *  one stack holding the node's vertical margins, its `start` mark, the node with its vertical
 *  margins moved off and its `sectionEnd` mark, so the two marks stand at the node's own top and
 *  bottom (a canvas block is drawn with that node's vertical margins zeroed). A section that answers
 *  no node emits its two marks alone, as top-level siblings. A section that answers more than one
 *  node is refused by name under the seed, never cut to its first: the seed would drop a node the
 *  flow prints. With no seed, the nodes unchanged, and nothing refused. */
function seedSection(ctx: Ctx, section: string, nodes: Content[]): Content[] {
  if (!ctx.seed) return nodes;
  if (nodes.length > 1) throw new Error(`A statement one-node section answers one node; ${section} answered ${nodes.length}.`);
  if (nodes.length === 0) return [mark(SEED.start(section)), mark(SEED.sectionEnd(section))];
  const [node] = nodes;
  const [l, t, r, b] = marginOf(node as object);
  return [{
    stack: [mark(SEED.start(section)), { ...(node as object), margin: [l, 0, r, 0] } as Content, mark(SEED.sectionEnd(section))],
    margin: [0, t, 0, b],
  }];
}

/** The finance block under the seed: design §5.2's per-key exception to `seedSection`. The canvas
 *  keeps the finance line's 2 pt top margin inside its block (`blockChildren`,
 *  src/server/statement-canvas.ts), so the block's drawn top is ABOVE that margin, the aging's 10 pt
 *  under the aging. Its `start` and `sectionEnd` marks are therefore top-level siblings around the
 *  node, whose margins stay as the flow builds them: the start mark lands above the kept 2 pt. Under
 *  `seedSection` the start mark would land 2 pt lower, the seed would draw the aging-to-finance
 *  distance as 12, and every unassessed print (no finance charge) would put Total Due 2 pt below the
 *  flow's. With no finance line, the two marks alone. With no seed, the nodes unchanged. */
function seedSiblings(ctx: Ctx, section: string, nodes: Content[]): Content[] {
  if (!ctx.seed) return nodes;
  return [mark(SEED.start(section)), ...nodes, mark(SEED.sectionEnd(section))];
}

// ---------------------------------------------------------------------------------------------
// Blocks, top to bottom. Each returns Content[] — empty means "nothing left to draw" and the block
// drops from the stack.
// ---------------------------------------------------------------------------------------------

/**
 * The centered "Statement" title over the company name. Unlike the invoice, the title here is a
 * LABEL (nothing kind-varies it), so its printed text is the config's `title` label (default
 * "Statement") at `headingSize`; the company name is value-only (prints `d.company.name`). A placed
 * logo (spec §6.3) unshifts into the centered stack (header-center) or rides a side column
 * (header-left/header-right); no logo → today's plain centered stack, byte-for-byte.
 */
function headerBlock(ctx: Ctx, d: StatementData): Content[] {
  const v = ctx.sections.get("header")!;
  const center: Content[] = [];
  for (const key of v.order.filter((k) => (k === "title" || k === "company_name") && v.field(k).visible)) {
    if (key === "title") center.push(seedPiece(ctx, key, { text: v.field("title").label, bold: true, fontSize: ctx.fonts.headingSize, alignment: "center" }));
    else center.push(seedPiece(ctx, key, { text: d.company.name, bold: true, fontSize: 15, alignment: "center", margin: [0, 2, 0, 6] }));
  }

  // Under the seed the image carries its id (an image is no text node) and an end mark follows it.
  const logoNodes: Content[] | null = ctx.logo === null ? null
    : ctx.seed
      ? [{ image: ctx.logo.dataUri, width: ctx.logo.width, id: SEED.piece("logo") } as Content, mark(SEED.end("logo"))]
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
const IDENTITY_GLUE: Readonly<Record<"customer" | "statement_date", string>> = {
  customer: " ", statement_date: " ",
};

/** An identity line's value: `${code} — ${name}` for the customer, the statement date through
 *  `ctx.date`. */
function identityValue(key: "customer" | "statement_date", ctx: Ctx, d: StatementData): string {
  return key === "customer" ? `${d.customer.code} — ${d.customer.name}` : ctx.date(d.asOf);
}

/** The Bill To: its label (9 pt, underlined, 6 pt above), then each live bill-to line at 10 pt. */
function billToStack(label: string, d: StatementData): Content[] {
  return [
    { text: label, fontSize: 9, decoration: "underline", margin: [0, 6, 0, 0] },
    ...d.customer.billTo.map((line): Content => ({ text: line, fontSize: 10 })),
  ];
}

/** The Remit To box: a one-cell boxed table holding its label at `labelStyle`, the remit-to name at
 *  10 bold and each address line at 10. No width: the flow places it in its `remitTo` column, the
 *  canvas in the item's box. */
function remitToBox(label: string, labelStyle: { fontSize: number; bold: boolean }, d: StatementData): ContentTable {
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

/** The customer / statement-date / live bill-to column left, the boxed Remit To block right — the
 *  invoice identity block's shape, with "Customer" + "Statement Date" in place of "Invoice No." +
 *  "Invoice Date". The label-value spacing is a single trailing space of alignment glue
 *  (`IDENTITY_GLUE`; the contract's `defaultLabel` carries none); a label override replaces the
 *  label, the glue stays. Each left field carries its OWN sample margin (unlike the invoice's
 *  homogeneous position-based rule — the statement's identity lines are heterogeneous: a plain line,
 *  a spaced line, and an underlined address block). */
function identityBlock(ctx: Ctx, d: StatementData): Content[] {
  const v = ctx.sections.get("identity")!;
  const leftStack: Content[] = [];
  for (const key of v.order.filter((k) => (k === "customer" || k === "statement_date" || k === "bill_to") && v.field(k).visible)) {
    if (key === "customer") {
      leftStack.push(seedPiece(ctx, key, { text: [{ text: `${v.field("customer").label}${IDENTITY_GLUE.customer}`, bold: true }, identityValue("customer", ctx, d)], fontSize: 10 }));
    } else if (key === "statement_date") {
      leftStack.push(seedPiece(ctx, key, {
        text: [{ text: `${v.field("statement_date").label}${IDENTITY_GLUE.statement_date}`, bold: true }, identityValue("statement_date", ctx, d)],
        fontSize: 10, margin: [0, 2, 0, 0],
      }));
    } else {
      // Under the seed the Bill To's start mark stands before its label, so the label's 6 pt top
      // margin lies below the mark (inside the block, as the canvas prints it), and its end mark after
      // its last line.
      const stack = billToStack(v.field("bill_to").label, d);
      leftStack.push(...(ctx.seed ? [mark(SEED.start("bill_to")), ...stack, mark(SEED.sectionEnd("bill_to"))] : stack));
    }
  }

  const cols: Column[] = [];
  // Decided from the shown fields alone: the left stack's closing mark is added only to a stack that
  // exists, so the seed never makes a left column the flow does not print.
  if (leftStack.length > 0) {
    cols.push({ width: "*", stack: ctx.seed ? [...leftStack, mark(SEED.leftColumnEnd)] : leftStack, margin: [W.identityIndent, 0, 0, 0] });
  }
  if (v.field("remit_to").visible) {
    cols.push(seedBox(ctx, "remit_to", W.remitTo, remitToBox(v.field("remit_to").label, { fontSize: 13, bold: true }, d)));
  }
  // Under the seed the identity opens with a top-level mark whenever its section is visible (the
  // Remit To alone included, and every field hidden too: a zero-size mark lays out nothing).
  const opening: Content[] = ctx.seed ? [mark(SEED.identityStart)] : [];
  if (cols.length === 0) return opening;
  return [...opening, { columns: cols, columnGap: W.identityGap, margin: [0, 0, 0, 10] }];
}

/** Document #/Date/Due Date/Original/Open — one row per open item (spec §8). These fields carry no
 *  column knob (the contract's own choice — the widths are the builder's hand-laid
 *  ["auto","auto","auto","*","*"]), so a template gets label/visibility/order over them; hiding a
 *  field drops its whole column. A CREDIT or on-account PAYMENT row's "Due Date" cell prints blank
 *  (neither carries one — `dueDate: null`), never a fabricated date. */
const OPEN_ITEM_WIDTH: Record<string, number | "auto" | "*"> = {
  document_no: "auto", date: "auto", due_date: "auto", original: "*", open: "*",
};
const OPEN_ITEM_ALIGN: Record<string, "left" | "right"> = {
  document_no: "left", date: "left", due_date: "left", original: "right", open: "right",
};
function openItemValue(key: string, item: StatementOpenItem, ctx: Ctx): string {
  switch (key) {
    case "document_no": return item.documentNumber;
    case "date": return ctx.date(item.date);
    case "due_date": return item.dueDate ? ctx.date(item.dueDate) : "";
    case "original": return ctx.money(item.original);
    default: return ctx.money(item.open); // "open"
  }
}
function openItemsTable(ctx: Ctx, d: StatementData): Content[] {
  const v = ctx.sections.get("open_items")!;
  const cols = v.order.filter((k) => k in OPEN_ITEM_WIDTH && v.field(k).visible);
  if (cols.length === 0) return [];
  const body: TableCell[][] = [cols.map((k) => head(v.field(k).label, OPEN_ITEM_ALIGN[k]))];
  for (const item of d.openItems) {
    body.push(cols.map((k): TableCell => (
      OPEN_ITEM_ALIGN[k] === "right"
        ? { text: openItemValue(k, item, ctx), fontSize: 9, alignment: "right" }
        : { text: openItemValue(k, item, ctx), fontSize: 9 })));
  }
  return [{
    table: { headerRows: 1, widths: cols.map((k) => OPEN_ITEM_WIDTH[k]), body },
    layout: LAYOUT.boxed,
    margin: [0, 0, 0, 10],
  }];
}

/** The five aging buckets plus the separate Unapplied column and Net (owner ruling 8: unapplied
 *  credit/on-account is never folded into a bucket) — off the SAME `AgingRow` `aging.ts` computes
 *  for the report (spec §6: "one pure aging function serves both"). These fields DO carry a column
 *  knob (defaultWidth "*"), so a template may re-width them within the aging table's budget. */
const AGING_DATA: Record<string, Exclude<keyof AgingRow, "customerId" | "customerCode" | "customerName" | "isFamilyTotal">> = {
  aging_current: "current", aging_1_30: "d1_30", aging_31_60: "d31_60", aging_61_90: "d61_90",
  aging_90_plus: "d90_plus", aging_unapplied: "unapplied", aging_net: "net",
};
function agingStrip(ctx: Ctx, d: StatementData): Content[] {
  const v = ctx.sections.get("aging")!;
  const cols = v.order.filter((k) => k in AGING_DATA && v.field(k).visible);
  if (cols.length === 0) return [];
  const headRow: TableCell[] = cols.map((k) => head(v.field(k).label, "right"));
  const valueRow: TableCell[] = cols.map((k): TableCell => (
    k === "aging_net"
      ? { text: ctx.money(d.aging[AGING_DATA[k]]), bold: true, fontSize: 9, alignment: "right" }
      : { text: ctx.money(d.aging[AGING_DATA[k]]), fontSize: 9, alignment: "right" }));
  return [{
    table: { headerRows: 1, widths: cols.map((k) => v.field(k).width), body: [headRow, valueRow] },
    layout: LAYOUT.boxed,
    margin: [0, 0, 0, 10],
  }];
}

/** A right-aligned "label  amount" line — the invoice totals-block precedent. */
function totalLine(label: string, value: string, opts: { bold?: boolean; big?: boolean } = {}): Content {
  const fontSize = opts.big ? 13 : 10;
  return {
    columns: [
      { width: "*", text: "" },
      { width: W.totalsLabel, text: label, bold: opts.bold ?? false, fontSize, alignment: "right" },
      { width: W.totalsAmount, text: value, bold: opts.bold ?? false, fontSize, alignment: "right" },
    ],
    columnGap: W.totalsGap,
    margin: [0, opts.big ? 6 : 2, 0, 0],
  };
}

/**
 * The finance-charge line prints ONLY when the run assessed one (spec §8) — `null` means either the
 * run didn't opt in, or nothing non-exempt was past due; either way, no line. Gated on its own
 * field's visibility on top.
 *
 * #162: it is INFORMATIONAL (owner ruling 2026-08-19) — `d.totalDue` is `aging.net` and excludes it,
 * nothing is posted, nothing ages. This block deliberately renders it in the CONFIG's section order,
 * which by default is directly above Total Due; the honesty lives in the LABEL the contract supplies
 * ("Finance Charge (not billed, not in total):"), never in a re-order — a stored config keeps its
 * own order, so a re-order would fix the default template and miss every published one, while the
 * label re-resolves for all of them (#103). Do not "fix" it by moving the section.
 */
function financeChargeBlock(ctx: Ctx, d: StatementData): Content[] {
  const v = ctx.sections.get("finance_charge")!;
  if (d.financeCharge === null || !v.field("finance_charge").visible) return [];
  return [totalLine(v.field("finance_charge").label, ctx.money(d.financeCharge))];
}

/** The bold Total Due line — buckets − unapplied = the net owed (`aging.net`). */
function totalDueBlock(ctx: Ctx, d: StatementData): Content[] {
  const v = ctx.sections.get("total")!;
  if (!v.field("total_due").visible) return [];
  return [totalLine(v.field("total_due").label, ctx.money(d.totalDue), { bold: true, big: true })];
}

/**
 * The statement's identity band — what a statement overflowing LETTER repeats on its continuation
 * pages. A real statement genuinely overflows: the open items are unbounded (a customer can carry
 * any number of open finalized invoices/credits/on-account payments), and ~34 rows fill a page
 * (probed empirically, Task 13). Its identity is the customer under the `customer` field's own
 * label. Rendered REGARDLESS of the config's visibility flags (the invoice/BOL/cert band's identity
 * treatment — identity on paper is locked, not configurable), though the `customer` label override
 * carries. The aging strip and Total Due are separate content blocks flowing AFTER the open-item
 * table (which repeats its own header row on continuation pages), so they land on the last page.
 * The flow's alone: a canvas statement prints none of this band. Its repeat band, on the same
 * continuation seam, holds the items its layout marks to repeat, with "(continued)" at the band's
 * bottom-left (`assembleCanvasSheet`, src/server/pdf/canvas-sheet.ts; design 2026-11-11 §5.2).
 */
const CONTINUATION_TOP_MARGIN = STATEMENT_PAGE.overflowTopMargin;
function continuationHeader(ctx: Ctx, d: StatementData): Content {
  const v = ctx.sections.get("identity")!;
  return {
    stack: [
      { text: `${v.field("customer").label} ${d.customer.code} — ${d.customer.name}`, bold: true, fontSize: 11 },
      { text: "(continued)", italics: true, fontSize: ctx.fonts.smallSize },
    ],
    margin: [24, 10, 24, 0],
  };
}

/** One config section key → its renderer. An unknown key renders nothing: the validator refused it
 *  before any config stored it. Under the seed each block section is marked by its kind (design
 *  2026-11-11 §5.3): the one-node sections through `seedSection`, the finance block through
 *  `seedSiblings`; with no seed both answer the nodes unchanged. The header's and identity's pieces
 *  are marked inside their builders. */
function renderSection(key: string, ctx: Ctx, d: StatementData): Content[] {
  switch (key) {
    case "header": return headerBlock(ctx, d);
    case "identity": return identityBlock(ctx, d);
    case "open_items": return seedSection(ctx, key, openItemsTable(ctx, d));
    case "aging": return seedSection(ctx, key, agingStrip(ctx, d));
    // The per-key exception (design §5.2): the start mark above the kept 2 pt (`seedSiblings`).
    case "finance_charge": return seedSiblings(ctx, key, financeChargeBlock(ctx, d));
    case "total": return seedSection(ctx, key, totalDueBlock(ctx, d));
    default: return [];
  }
}

/** The ctx of a section list: each section through the lens and the formatters from the config's
 *  formats. `logo` is null unless the resolved version carries bytes and the config places them. */
function ctxOf(config: TemplateConfig, sectionConfigs: SectionConfig[], logo: Ctx["logo"]): Ctx {
  return {
    fonts: config.fonts,
    money: makeMoney(config.formats),
    date: makeLongDate(config.formats),
    sections: new Map(sectionConfigs.map((sc) => [sc.key, sectionView(sc)] as const)),
    logo,
  };
}

// ---------------------------------------------------------------------------------------------
// The built-in default statement template (spec §8, P7 spec §5.4). PURE — data and config in, JSON
// out.
// ---------------------------------------------------------------------------------------------

/**
 * `config` is a **backfilled** `TemplateConfig` (what `resolveTemplateForPrint` returns) and DEFAULTS
 * to the contract's own `DEFAULT_CONFIG` — so a config-less call renders exactly today's paper (the
 * golden-compat gate, tests/statement-pdf.test.ts). `logoDataUri` is the invoice's deliberate extra
 * parameter: the logo bytes belong to the resolved template version, not to the statement data. The
 * statement carries no per-page footer strip, so the `pageFooter` knob (default OFF) adds a bare
 * "Page N of M" line when on and nothing otherwise (byte-identical default); the bottom margin stays
 * 40 unconditionally, today's.
 *
 * It branches once on `config.layout` (design 2026-11-11 §4.4): a layout prints the canvas
 * (`buildCanvasStatementDefinition`, src/server/statement-canvas.ts), handed the flow's own builders
 * (`STATEMENT_FLOW`); a null layout prints the flow below, exactly as before the canvas lane.
 *
 * `seedIds` is the canvas seed's layout pass alone (`seedStatementLayout`,
 * src/server/statement-canvas-seed.ts): the flow marks the pieces and blocks a canvas item stands for
 * (`STATEMENT_SEED_IDS`) and lays out exactly as it does without them. Every print and preview leaves
 * it off, and the canvas branch ignores it.
 */
export function buildStatementDefinition(
  input: StatementData,
  config: TemplateConfig = DEFAULT_CONFIG,
  logoDataUri?: string,
  options: { seedIds?: boolean } = {},
): RenderableDefinition {
  if (config.layout !== null) return buildCanvasStatementDefinition(input, config, config.layout, STATEMENT_FLOW, logoDataUri);
  // The §5.6 belt's OMISSION half: views resolve over `completeSections`, never `config.sections`
  // raw, so a raw config omitting an entry cannot drop it.
  const sectionConfigs = completeSections(STATEMENT_CONTRACT, config.sections);
  const ctx: Ctx = {
    ...ctxOf(config, sectionConfigs, config.logo !== null && logoDataUri !== undefined
      ? { placement: config.logo.placement, width: config.logo.width, dataUri: logoDataUri }
      : null),
    ...(options.seedIds === true ? { seed: true } : {}),
  };
  const sections = ctx.sections;

  const content: Content[] = [];
  // Stack order IS the config's section order; hidden sections are omitted (nothing on this contract
  // is locked, so the belt forces none back).
  for (const sc of sectionConfigs) {
    if (!sections.get(sc.key)!.visible) continue;
    content.push(...inBoxFlowSection("STATEMENT", sc.key, renderSection(sc.key, ctx, input)));
  }

  return {
    pageSize: "LETTER",
    pageMargins: [24, 24, 24, STATEMENT_PAGE.bottomMargin],
    defaultStyle: { font: config.fonts.family, fontSize: config.fonts.baseSize },
    // The statement has no static per-page strip (unlike the invoice/cert), so the `pageFooter` knob
    // (spec §6.1) is a bare page line: OFF (default — golden) prints no footer at all; ON prints the
    // real per-page "Page N of M" via render.ts's pageNofM callback.
    ...(config.pageFooter ? { pageFooterSpec: { kind: "pageNofM" as const } } : {}),
    content,
    continuationHeaderSpec: {
      content: continuationHeader(ctx, input),
      overflowTopMargin: CONTINUATION_TOP_MARGIN,
    },
  };
}

/** The flow's own builders, for the canvas path (src/server/statement-canvas.ts, since statement
 *  canvas PR 2), which imports only types from this file: it prints each field and block exactly as
 *  the flow does, with no import cycle (the traveler's
 *  `CANVAS_FLOW`, the ticket's `TICKET_FLOW`, the bill of lading's `BOL_FLOW`, the certification's
 *  `CERT_FLOW`, the invoice's `INVOICE_FLOW`). No header node and no `totalLine` is exposed: a canvas
 *  item prints the title's label and the company name at its own style, and the totals print through
 *  `financeChargeBlock` and `totalDueBlock`, which build `totalLine` here. */
export type StatementFlowBuilders = {
  /** `STATEMENT_WIDTHS`, handed on with the builders so the canvas reads the flow's widths with no
   *  value import from this file. */
  widths: typeof STATEMENT_WIDTHS;
  /** The keys a canvas prints in a border at the item's box (`STATEMENT_BOXED_FIELDS`). */
  boxedFields: readonly string[];
  sectionView: (sc: SectionConfig) => StatementSectionView;
  /** Today's ctx over a section list (the canvas's lens hands it the blocks' sections). */
  ctxOf: (config: TemplateConfig, sectionConfigs: SectionConfig[], logo: StatementCtx["logo"]) => StatementCtx;
  makeMoney: (f: FormatsConfig) => (v: number) => string;
  makeLongDate: (f: FormatsConfig) => (iso: string) => string;
  /** The one-space glue after an identity label. */
  identityGlue: Readonly<Record<"customer" | "statement_date", string>>;
  /** `${code} — ${name}`, and the statement date through ctx.date. */
  identityValue: (key: "customer" | "statement_date", ctx: StatementCtx, d: StatementData) => string;
  /** The Bill To's label (9 pt, underlined, 6 pt above), then each billTo line at 10 pt. */
  billToStack: (label: string, d: StatementData) => Content[];
  /** The Remit To box's one-cell boxed table, no width; the flow places it in its 250 pt column. */
  remitToBox: (label: string, labelStyle: { fontSize: number; bold: boolean }, d: StatementData) => ContentTable;
  openItemsTable: (ctx: StatementCtx, d: StatementData) => Content[];
  agingStrip: (ctx: StatementCtx, d: StatementData) => Content[];
  financeChargeBlock: (ctx: StatementCtx, d: StatementData) => Content[];
  totalDueBlock: (ctx: StatementCtx, d: StatementData) => Content[];
};

export const STATEMENT_FLOW: StatementFlowBuilders = {
  widths: STATEMENT_WIDTHS, boxedFields: STATEMENT_BOXED_FIELDS, sectionView, ctxOf, makeMoney, makeLongDate,
  identityGlue: IDENTITY_GLUE, identityValue, billToStack, remitToBox,
  openItemsTable, agingStrip, financeChargeBlock, totalDueBlock,
};

/** A seeded field item's style: the flow's own size, weight and alignment for that key (design
 *  2026-11-11 §5.3), so the item prints its text as the flow prints it; null for a key the seed
 *  places no field for (the Bill To is a block, the aging's columns are a block's). The identity
 *  lines' labels print bold inside their text, as the flow's do; the style is the line's own,
 *  regular. */
export function statementSeedStyle(key: string, fonts: FontsConfig): CanvasTextStyle | null {
  switch (key) {
    case "title": return { size: fonts.headingSize, bold: true, align: "center" };
    case "company_name": return { size: 15, bold: true, align: "center" };
    case "customer":
    case "statement_date": return { size: 10, bold: false, align: "left" };
    case "remit_to": return { size: 13, bold: true, align: "left" };
    default: return null;
  }
}

/** The item node a canvas statement's sheet is assembled with (src/server/statement-canvas.ts's
 *  `firstStatementItemContent`, handed the flow's builders), for the preview's alone layouts. */
export function statementCanvasItemContent(input: StatementData, config: TemplateConfig, logoDataUri?: string): ItemContent {
  if (config.layout === null) throw new Error("statementCanvasItemContent needs a canvas config.");
  return firstStatementItemContent(input, config, config.layout, STATEMENT_FLOW, logoDataUri);
}
