/**
 * The bill of lading — THE multi-order document (design spec §10.2, owner rulings §3.19/§3.20):
 * one per shipment, listing every order number on the truck, its own lazily-allocated
 * `bolNumber`, and the straight-bill-of-lading form completed by hand where the sample leaves
 * blanks. PURE by construction, the traveler.ts contract: `BolData` in, a plain-JSON pdfmake
 * definition out — no I/O, no clock, nothing that would not survive `JSON.parse(JSON.stringify())`
 * (asserted in tests/bol.test.ts). The reads live in shippers.ts (`readBolData`), the bytes in
 * render.ts.
 *
 * A CONFIG-CONSUMER since Phase 7 Task 10 (P7 spec §5.4). The ELEVEN UDSBL legal form constants
 * that used to live in this file are the `BOL` contract's TEXT BLOCKS now
 * (src/lib/template-contracts/bol.ts, defaults transcribed verbatim, quirks intact — "here
 * under", "(I) … (2)", "Comerce"): spec §8's "edited in place" — the template designer is the
 * legal text's editing path, and the builder renders `config.textBlocks`, never a literal of its
 * own. At that conversion the default config reproduced the paper exactly (the golden gate,
 * tests/bol.test.ts, which it left untouched).
 *
 * **THE DATE KNOB HAS NO TRAP HERE** (the ticket's two-date-styles rule, generalized: map the
 * knob to exactly the slots the contract's default reproduces). This builder was grepped for
 * every date call before the knob was mapped — `bolDate` had exactly ONE call site, the
 * ship-from line — so the contract's single knob (default "MMM - DD - YYYY", the sample's own
 * style) maps to the paper's single date slot directly.
 *
 * Layout mirrors the owner's `docs/samples/Bill of Lading Sample.pdf`, which IS the contract
 * (spec §3.1). Deviations are individually commented; there are no silent ones:
 *  - `Delivering Carrier`, `Car or Vehicle Initials`, `Received $`, `Charges Advanced` and every
 *    signature line print as blank rules for hand completion, exactly as on the sample (§10.2).
 *    One spelling exception, on the spec's own explicit wording: §10.2 writes "Car or Vehicle
 *    Initials", so the contract's default label uses that spelling over the sample's.
 *  - in the sections layout (a null `config.layout`) everything is flow-laid; no `absolutePosition`
 *    anywhere (the Task 18 review's tear-off lesson — a pinned block collides with flow content on a
 *    long form). The canvas branch (`buildCanvasBolDefinition`, src/server/bol-canvas.ts) prints its
 *    page-top items at `absolutePosition` (design 2026-11-09 §5.2): there the drawn layout is the form.
 *  - the small inline form glue (parenthetical captions, "RECEIVED $", "Agent or Cashier",
 *    signature-rule captions, the "at"/"From" connectives) is the form's own furniture — rendered
 *    by the builder, not a contract knob (the contract's own header comment).
 *  - the weight cell prints the shipment's gross, or its net when it has no gross, with "lb",
 *    and under it in small type the word that says which. A shipment whose net cannot be worked
 *    out prints an empty cell. The sample prints one bare figure there. Owner answers 1, 6 and 8
 *    of 2026-10-11 and ruling W15 (the weights design §13).
 */
import type { Column, Content, TableCell } from "pdfmake/interfaces";
import { BOL_COLLECT_BOX, LAYOUT, type RenderableDefinition } from "./render";
import { inBoxFlowSection } from "./flow-tables";
import type { ItemContent } from "./canvas-sheet";
import { mark } from "./canvas-nodes";
import { buildCanvasBolDefinition, firstBolItemContent } from "../bol-canvas";
import { lb } from "./printed-weight";
import { BOL_CONTRACT, BOL_FREIGHT_DESCRIPTION_SECOND_LINE, DEFAULT_CONFIG } from "../../lib/template-contracts/bol";
import {
  completeSections,
  type FontsConfig, type FormatsConfig, type LogoPlacement, type SectionConfig,
  type TemplateConfig,
} from "../../lib/template-contracts/types";
import { shipmentWeightTotals } from "../../lib/net-weight";
import { NET_WEIGHT } from "../../lib/weight-terms";

// ---------------------------------------------------------------------------------------------
// BolData — the builder's whole input. Plain data: no Decimals, no Dates, no Prisma rows.
// ---------------------------------------------------------------------------------------------

export type BolCompany = { name: string; address: string };
export type BolParty = { name: string; street: string; city: string; state: string; zip: string };
/** One order's part of the shipment, as the calculation reads it. `tareEach` is the shipment row's own. */
export type BolOrderWeights = { lineWeights: number[]; containers: { count: number; tareEach: number | null }[] };
export type BolData = {
  company: BolCompany;
  bolNumber: number;                   // Shipper.bolNumber, allocated at first print (§3.19)
  proNumber: string;
  scacCode: string;
  carrierName: string;
  shipDate: string;                    // "yyyy-mm-dd"
  consignee: BolParty;                 // the shipment's ship-to address (§3's closing note)
  orderNumbers: number[];              // every order on the shipment, ticket print order (§3.20)
  poNumbers: string[];                 // the orders' POs — "Consignee's Ref/PO No."
  packageCount: number | null;
  freightDescription: string;
  /** One entry for each order on the shipment, in ticket print order. `freightBlock` works the
   *  weight cell out from them. */
  orders: BolOrderWeights[];
  freightClass: string;
  freightTerms: "PREPAID" | "COLLECT";
};

// ---------------------------------------------------------------------------------------------
// Formatting. Pure, config-driven (P7 spec §5.4's per-file formatting helpers), locale pinned
// (the traveler's own rule) so output never tracks the server's.
// ---------------------------------------------------------------------------------------------

/** Thousands-separated per the knob, at most 2 decimals, trailing zeros dropped — "11,415". */
function makeNum(formats: FormatsConfig): (value: number) => string {
  const useGrouping = formats.thousandsSeparator !== false;
  return (value) => value.toLocaleString("en-US", { maximumFractionDigits: 2, useGrouping });
}

const MONTHS_FULL = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The ship-from line's date, driven by the contract's ONE date knob (default "MMM - DD - YYYY" —
 * the sample's own "Jul - 06 - 2026"). The paper's ONLY date slot — see the header comment's
 * no-trap note. Pure string work — parsing to a Date would drag a timezone into a date-only
 * value (src/lib/business-days.ts's whole point).
 */
function makeBolDate(formats: FormatsConfig): (iso: string) => string {
  const format = formats.dateFormat ?? "MMM - DD - YYYY";
  return (iso) => {
    const [y, m, d] = iso.split("-");
    switch (format) {
      case "M/D/YYYY": return `${Number(m)}/${Number(d)}/${y}`;
      case "MM/DD/YYYY": return `${m}/${d}/${y}`;
      case "YYYY-MM-DD": return iso;
      case "MMMM D, YYYY": return `${MONTHS_FULL[Number(m) - 1]} ${Number(d)}, ${y}`;
      default: return `${MONTHS_ABBR[Number(m) - 1]} - ${d} - ${y}`; // "MMM - DD - YYYY"
    }
  };
}

/** LETTER (612pt) minus the 24pt margins. */
const CONTENT_WIDTH = 564;

/** Every fixed width the flow prints with (points); the canvas families and the profile's
 *  `leastWidths` (src/lib/template-contracts/bol.ts, held here by tests/bol-canvas.test.ts) read it.
 *  The form's furniture keeps its own literals: the sidebar's 160 pt rules and the declared-value
 *  "Per" row belong to no field family. The header's column gap is `BOL_HEADER_GAP`, beside it. */
export const BOL_WIDTHS = {
  headerRight: 250, formLabel: 110, formRule: 130, formGap: 4,
  carrierInset: 60, carrierRule: 260,
  shipFromDate: 100, shipFromWord: 30, shipFromName: 180, shipFromGap: 6,
  consignedLabel: 70, consignedRule: 180, rowGap: 4,
  destinationLabel: 70, destinationRule: 150, stateLabel: 16, stateRule: 40, zipLabel: 18, zipRule: 60,
  trvLabel: 55,
  deliveringLabel: 80, deliveringRule: 150, initialsLabel: 105, initialsRule: 90, vehicleNoLabel: 22, vehicleNoRule: 55,
  sidebar: 170, sidebarGap: 8,
  signLabel: 60, signGap: 6, shipperRule: 160, agentRule: 200, poAddressLabel: 165, poAddressRule: 300,
} as const;
const W = BOL_WIDTHS;
/** The gap between the header's columns (`headerBlock`): the left slot, a centre logo's column when
 *  one prints, and the 250 pt right slot. The canvas seed reads it for the left slot's width. */
export const BOL_HEADER_GAP = 12;

/** The flow's two rule weights: the header's heavy rule and every other rule's light one. */
export const BOL_RULE_WEIGHTS = { heavy: 1.2, light: 0.8 } as const;
/** The bottom section's declared-value "Per" row: an empty 200 pt column, "Per" in 30 and its
 *  write-in rule 160 long (the form's furniture, which the canvas seed places as a Text and a Line). */
export const BOL_PER_ROW = { offset: 200, word: 30, rule: 160 } as const;
/** The form's furniture words the canvas seed places as Text items, stated once for the flow and the
 *  seed: the delivery caption, its footnote and the declared-value "Per". */
export const BOL_FURNITURE_TEXT = {
  delivery_caption: "Delivery Address *",
  delivery_footnote: "* To be filled in only when shipper desires and governing tariffs provide for delivery thereof.",
  per: "Per",
} as const;

/** A form label's type: its size, its weight and, where the flow sets one, its alignment. */
export type LabelStyle = { fontSize: number; bold: boolean; alignment?: "left" | "center" | "right" };
/** The flow's form-rule label: 7.5 pt bold. */
const FORM_LABEL: LabelStyle = { fontSize: 7.5, bold: true };
/** The header's "Original - Not Negotiable": 9 pt bold. */
const ORIGINAL_LABEL: LabelStyle = { fontSize: 9, bold: true };
/** The two wordings the flow prints at a literal size: the shipper's certification (6 pt bold) and
 *  the declared-value statement (7 pt bold). */
const CERTIFIES: LabelStyle = { fontSize: 6, bold: true };
const DECLARED_VALUE: LabelStyle = { fontSize: 7, bold: true };
/** The furniture's type: the delivery caption (6 pt), its footnote (5 pt, set right) and "Per" (6.5 pt bold). */
const DELIVERY_CAPTION: LabelStyle = { fontSize: 6, bold: false };
const DELIVERY_FOOTNOTE: LabelStyle = { fontSize: 5, bold: false, alignment: "right" };
const PER_WORD: LabelStyle = { fontSize: 6.5, bold: true };
/** The ship-from line's default type: 8.5 pt, its three plain columns regular. */
const SHIP_FROM: LabelStyle = { fontSize: 8.5, bold: false };

/** A style's pdfmake keys, `alignment` only where the style sets one (a definition carries no
 *  undefined key). */
const styled = (s: LabelStyle): { bold: boolean; fontSize: number; alignment?: LabelStyle["alignment"] } =>
  ({ bold: s.bold, fontSize: s.fontSize, ...(s.alignment !== undefined ? { alignment: s.alignment } : {}) });

const line = (width: number): Content =>
  ({ canvas: [{ type: "line", x1: 0, y1: 0, x2: width, y2: 0, lineWidth: BOL_RULE_WEIGHTS.light }] });

const fullRule = (margin: [number, number, number, number], lineWidth: number = BOL_RULE_WEIGHTS.heavy): Content =>
  ({ canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth }], margin });

/** A form field: bold label left, the value sitting on its own rule right. */
function labeledRule(
  label: string, value: string, labelWidth: number, valueWidth: number, labelStyle: LabelStyle = FORM_LABEL,
): Content {
  return {
    columns: [
      { width: labelWidth, text: label, ...styled(labelStyle) },
      { width: valueWidth, stack: [{ text: value === "" ? " " : value, fontSize: 8, alignment: "center" }, line(valueWidth)] },
    ],
    columnGap: W.formGap,
    margin: [0, 0, 0, 3],
  };
}

/** A value on its rule: the value (a blank prints one space) at its size and alignment, or, for a
 *  blank write-in rule (`value` null), one bare space; the rule under it `ruleWidth` long, the
 *  column `columnWidth` wide. */
function ruledValue(
  value: string | null, columnWidth: number | "*", ruleWidth: number,
  valueSize?: number, valueAlign?: "left" | "center",
): Column {
  const text: Content = value === null
    ? { text: " " }
    : {
      text: value === "" ? " " : value,
      ...(valueSize !== undefined ? { fontSize: valueSize } : {}),
      ...(valueAlign !== undefined ? { alignment: valueAlign } : {}),
    };
  return { width: columnWidth, stack: [text, line(ruleWidth)] };
}

/** A label column beside a value on a rule (or a blank write-in rule: `value` null), the two
 *  columns the flow's consignee, destination, delivering-carrier and signature rows are made of. */
function ruledPair(p: {
  label: string; labelWidth: number; labelStyle: LabelStyle; value: string | null;
  valueSize?: number; valueAlign?: "left" | "center"; columnWidth: number | "*"; ruleWidth: number;
}): Column[] {
  return [
    { width: p.labelWidth, text: p.label, ...styled(p.labelStyle) },
    ruledValue(p.value, p.columnWidth, p.ruleWidth, p.valueSize, p.valueAlign),
  ];
}

const head = (text: string): TableCell => ({ text, bold: true, alignment: "center", fontSize: 6.5 });

// ---------------------------------------------------------------------------------------------
// The config lens (P7 spec §5.4) — the ticket's `sectionView`, single contract. The builder
// ASSUMES a complete config (`validateConfig`'s §5.3 backfill guarantees every entry exists);
// only the two null-means-contract-default knobs a complete config still carries resolve here.
//
// THE §5.6 BELT, both halves plus a third: the flag half (`visible || !hideable` /
// `visible || !removable`) is the traveler's expression verbatim — NOTHING on this contract is
// locked, so it forces nothing and a config may hide anything; the omission half is
// `completeSections` in `buildBolDefinition` below, so a raw config that OMITS an entry still
// renders it; and the TEXT-BLOCK half is `TEXT_DEFAULTS` — a raw config omitting a text-block
// key renders the contract's transcription, never the string "undefined" (a validated config
// always carries all eleven keys; this is the belt's rationale applied to the one config surface
// completeSections does not cover).
// ---------------------------------------------------------------------------------------------

const CONTRACT_SECTIONS = new Map(BOL_CONTRACT.sections.map((s) =>
  [s.key, { section: s, fields: new Map(s.fields.map((f) => [f.key, f])) }] as const));

const TEXT_DEFAULTS = new Map(BOL_CONTRACT.textBlocks.map((t) => [t.key, t.defaultText]));

/** A text block's printed wording: the config's, else the contract's (the belt's text half). The one
 *  statement of it, the canvas reaching it through `BOL_FLOW.textOf`. */
function textOf(textBlocks: Record<string, string>): (key: string) => string {
  return (key) => textBlocks[key] ?? TEXT_DEFAULTS.get(key)!;
}

export type FieldView = { visible: boolean; label: string; width: number | "*" };
export type SectionView = {
  visible: boolean;
  /** Field keys in config (= display) order; per-field visibility still applies at use. */
  order: string[];
  field: (key: string) => FieldView;
};

function sectionView(sc: SectionConfig): SectionView {
  const cs = CONTRACT_SECTIONS.get(sc.key);
  // Unknown keys were refused by the validator before any config could be stored; a miss here
  // is a caller bug, not a config state.
  if (cs === undefined) throw new Error(`Unknown BOL template section "${sc.key}"`);
  const byKey = new Map(sc.fields.map((f) => [f.key, f]));
  return {
    visible: sc.visible || !cs.section.hideable, // the belt, section half (nothing locked here)
    order: sc.fields.map((f) => f.key),
    field: (key) => {
      const cf = cs.fields.get(key);
      if (cf === undefined) throw new Error(`Unknown BOL template field "${sc.key}.${key}"`);
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
export type Ctx = {
  fonts: FontsConfig;
  num: (value: number) => string;
  /** The date knob's only consumer — the ship-from line, the paper's single date slot. */
  bolDate: (iso: string) => string;
  /** A text block's config text — the omission belt's text half (see the lens comment). */
  text: (key: string) => string;
  sections: Map<string, SectionView>;
  /** Present only when the resolved version carries logo BYTES and the config PLACES them
   *  (spec §6.3) — either alone renders today's text-only header. */
  logo: { placement: LogoPlacement; width: number; dataUri: string } | null;
  /** The canvas seed's layout pass (`buildBolDefinition`'s `seedIds`): when true the flow marks the
   *  pieces a canvas item stands for (`BOL_SEED_IDS`). Absent on every print and preview, which
   *  render exactly the nodes they rendered before. */
  seed?: boolean;
  /** The seed's placeholder (`seedPlaceholders`): the header prints the PO list as one blank line
   *  whatever the shipment's POs, so the Consignee's ref/PO block is seeded one line tall (design
   *  2026-11-09 §5.3), and the TRV line prints its list the same way, so the TRV block is too (owner
   *  ruling of 2026-11-15 on #943, "One line, like PO"). Absent on every print. */
  seedPlaceholders?: boolean;
};

/**
 * The ids the bill of lading's canvas seed reads back from one layout of today's paper (design
 * 2026-11-09 §5.3), the shape of the ticket's `TICKET_SEED_IDS`: emitted only under `seedIds`, and
 * never on a TEXT node (pdfmake refuses two text nodes sharing an id in one document and makes a
 * named destination of a text id). A piece's id is on a wrapper stack around it or on a column's
 * stack, and its `end` mark follows it inside that wrapper, BEFORE any bottom margin (the margin is
 * moved onto the wrapper), so a piece's box is its content alone: a form rule's box is its line and
 * not the 3 pt under it. The PO list is a form rule inside the header's right column, so it is a
 * piece (`piece("consignee_ref")`); the two section blocks (`trv`, `freight`) carry a `start` and a
 * `sectionEnd` mark inside a top-level stack holding the block's vertical margins, so both marks
 * stand at the block's content and both are exact (that stack is breakable). The section keys and
 * the piece keys never meet.
 */
export const BOL_SEED_IDS = {
  piece: (key: string) => `seed:${key}`,
  end: (key: string) => `seed:end:${key}`,
  start: (section: string) => `seed:start:${section}`,
  sectionEnd: (section: string) => `seed:end:${section}`,
} as const;

type Margin4 = [number, number, number, number];
type WithId<T> = T & { id: string };

/** A node's margin as four figures (this flow states every margin as four). */
function marginOf(node: object): Margin4 {
  const margin = (node as { margin?: unknown }).margin;
  return Array.isArray(margin) && margin.length === 4 ? margin as Margin4 : [0, 0, 0, 0];
}

/** A piece wrapped for the seed: its id on a stack around it, its vertical margins moved onto that
 *  stack and its end mark after it inside them, so the end mark reports the piece's bottom and not
 *  its margin's (the ticket's `seedBlock` move; it lays out the same). With no seed, the piece
 *  itself, unchanged. */
function seedPiece(ctx: Ctx, key: string, node: Content): Content {
  if (!ctx.seed) return node;
  const [l, t, r, b] = marginOf(node as object);
  return {
    id: BOL_SEED_IDS.piece(key),
    stack: [{ ...(node as object), margin: [l, 0, r, 0] } as Content, mark(BOL_SEED_IDS.end(key))],
    margin: [0, t, 0, b],
  } as WithId<Content>;
}

/** A column holding one text node, wrapped for the seed: its width stays on the column, its vertical
 *  margins move onto it, and the text moves into its stack under the id with the end mark after it.
 *  With no seed, the column unchanged. */
function seedColumn(ctx: Ctx, key: string, column: Column): Column {
  if (!ctx.seed) return column;
  const { width, ...text } = column as unknown as Record<string, unknown> & { width: number | "*" };
  const [l, t, r, b] = marginOf(text);
  return {
    width, id: BOL_SEED_IDS.piece(key), margin: [0, t, 0, b],
    stack: [{ ...text, margin: [l, 0, r, 0] }, mark(BOL_SEED_IDS.end(key))],
  } as unknown as Column;
}

/** A column that is already a stack (a value on its rule, the carrier's name over its rule), marked
 *  for the seed: the id on the column and the end mark last in its stack, after the rule, so the
 *  piece's top is its value's and its end the rule's. With no seed, the column unchanged. */
function seedStack(ctx: Ctx, key: string, column: Column): Column {
  if (!ctx.seed) return column;
  const c = column as unknown as { stack: Content[] };
  return { ...(column as object), id: BOL_SEED_IDS.piece(key), stack: [...c.stack, mark(BOL_SEED_IDS.end(key))] } as unknown as Column;
}

/** The piece key of a ruled pair's label column (`seedPair`); a colon, so it never meets a section's
 *  or another piece's key. */
export const pairLabelKey = (key: string) => `${key}:label`;

/** A ruled pair (`ruledPair`'s label column and value column) marked for the seed: the value column
 *  under the field's key (`seedStack`), whose left the seed reads the pair's from, less the flow's
 *  label column and gap, and the label column under `pairLabelKey` (`seedColumn`), so the pair's
 *  height is the taller of the two (a write-in's 8 pt label passes its blank value's base size). */
function seedPair(ctx: Ctx, key: string, pair: Column[]): Column[] {
  if (!ctx.seed) return pair;
  return [seedColumn(ctx, pairLabelKey(key), pair[0]), seedStack(ctx, key, pair[1])];
}

/** A section block under the seed: one top-level stack holding the block's vertical margins, its
 *  `start` mark, the block with its vertical margins moved off and its `sectionEnd` mark, so the two
 *  marks stand at the block's own top and bottom (a canvas block is drawn with its margins zeroed).
 *  With no seed, the block itself, unchanged. */
function seedSection(ctx: Ctx, section: string, block: Content): Content {
  if (!ctx.seed) return block;
  const [l, t, r, b] = marginOf(block as object);
  return {
    stack: [
      mark(BOL_SEED_IDS.start(section)),
      { ...(block as object), margin: [l, 0, r, 0] } as Content,
      mark(BOL_SEED_IDS.sectionEnd(section)),
    ],
    margin: [0, t, 0, b],
  };
}

/** This section's visible column-field keys, in config order — what the freight table turns
 *  into its `widths` and its per-row cells. */
function columnKeys(v: SectionView, sectionKey: string): string[] {
  const cs = CONTRACT_SECTIONS.get(sectionKey)!;
  return v.order.filter((k) => cs.fields.get(k)?.column !== undefined && v.field(k).visible);
}

// ---------------------------------------------------------------------------------------------
// Blocks, top to bottom in sample order. Each returns Content[] — empty means "nothing left to
// draw" (every configurable piece hidden) and the block drops from the stack. Inter-block rules
// are each block's own closing glue: they hide, and travel, with their section.
// ---------------------------------------------------------------------------------------------

/**
 * Header: two structural slots hand-laid on the sample — "Original - Not Negotiable" + the title
 * left, the four labeled form rules right (250pt). Config field ORDER applies WITHIN each slot;
 * a field never migrates between slots (the traveler's documented mapping decision). The
 * original-label's and title's labels ARE their printed text, so a label override renames them.
 *
 * A placed logo (spec §6.3) joins the TOP of its slot's stack at its configured width; the
 * sample header has no center slot, so a header-center logo materializes a middle column between
 * the two structural slots — only a placed logo changes the structure (golden: no logo → today's
 * two-column header, byte-for-byte).
 */
function headerBlock(ctx: Ctx, d: BolData): Content[] {
  const v = ctx.sections.get("header")!;
  const pick = (keys: string[]): string[] =>
    v.order.filter((k) => keys.includes(k) && v.field(k).visible);

  const left: Content[] = [];
  for (const key of pick(["original_label", "title"])) {
    if (key === "original_label") left.push(seedPiece(ctx, key, { text: v.field(key).label, bold: ORIGINAL_LABEL.bold, fontSize: ORIGINAL_LABEL.fontSize }));
    else left.push(seedPiece(ctx, key, { text: v.field(key).label, bold: true, fontSize: ctx.fonts.headingSize, margin: [0, 4, 0, 0] }));
  }

  const valueFor = (key: string): string => {
    switch (key) {
      case "pro_number": return d.proNumber;
      case "bol_number": return String(d.bolNumber);
      // The seed's placeholder: one blank line, whatever the shipment's POs (design §5.3).
      case "consignee_ref": return ctx.seedPlaceholders ? "" : poList(d);
      default: return d.scacCode; // scac_code
    }
  };
  const right: Content[] = pick(["pro_number", "bol_number", "consignee_ref", "scac_code"])
    .map((key) => seedPiece(ctx, key, labeledRule(v.field(key).label, valueFor(key), W.formLabel, W.formRule)));

  let center: Content[] | null = null;
  if (ctx.logo !== null) {
    const image: Content = { image: ctx.logo.dataUri, width: ctx.logo.width };
    // Under the seed the image carries its id (an image is no text node) and an end mark follows it.
    const nodes: Content[] = ctx.seed
      ? [{ ...(image as object), id: BOL_SEED_IDS.piece("logo") } as Content, mark(BOL_SEED_IDS.end("logo"))]
      : [image];
    if (ctx.logo.placement === "header-left") left.unshift(...nodes);
    else if (ctx.logo.placement === "header-right") right.unshift(...nodes);
    else center = nodes;
  }
  if (left.length + right.length === 0 && center === null) return [];

  const columns: Column[] = [{ width: "*", stack: left }];
  if (center !== null) columns.push({ width: ctx.logo!.width, stack: center });
  columns.push({ width: W.headerRight, stack: right });

  return [
    { columns, columnGap: BOL_HEADER_GAP, margin: [0, 0, 0, 4] },
    seedPiece(ctx, "header_rule", fullRule([0, 0, 0, 3])),
  ];
}

/** The carrier's name over its rule, the caption beneath (the `carrier_name` field's label —
 *  default "(Name of Carrier)") — blank rule when the shipment has no carrier (the sample's own
 *  hand-completed style; a customer-owned truck has none). */
function carrierBlock(ctx: Ctx, d: BolData): Content[] {
  const v = ctx.sections.get("carrier")!;
  if (!v.field("carrier_name").visible) return [];
  return [{
    columns: [
      { width: W.carrierInset, text: "" },
      seedStack(ctx, "carrier_name", carrierStack(d.carrierName, v.field("carrier_name").label, W.carrierRule, CARRIER_NAME)),
      { width: "*", text: "" },
    ],
    margin: [0, 0, 0, 4],
  }];
}

/** The flow's carrier name: 10 pt bold, centred over its rule. */
const CARRIER_NAME: LabelStyle = { fontSize: 10, bold: true, alignment: "center" };

/** The carrier's name (a blank prints one space) over a rule `width` long, the caption beneath,
 *  in a column that wide (`BOL_FLOW` hands it on as `Content`). */
function carrierStack(name: string, caption: string, width: number, nameStyle: LabelStyle): Column {
  return {
    width,
    stack: [
      { text: name === "" ? " " : name, ...styled(nameStyle) },
      line(width),
      { text: caption, fontSize: 6.5, alignment: "center", margin: [0, 1, 0, 0] },
    ],
  };
}

/** "at <ship-from> <date> From <company>" — ship-from is the company settings (spec §10.2). A
 *  value-only composite field (the contract's `ship_from`, defaultLabel "") — the "at"/"From"
 *  connectives are the form's own wording, so a label override has nothing to replace (the
 *  traveler's decision 4). The ONE place the date knob lands. The date is bold always; `bold` sets
 *  the other three columns (the flow's are regular), all four at `size`. */
function shipFromLine(ctx: Ctx, d: BolData, size = SHIP_FROM.fontSize, bold = SHIP_FROM.bold): Content {
  const weight = bold ? { bold: true } : {};
  return {
    columns: [
      { width: "*", text: `at ${d.company.address}`, fontSize: size, ...weight },
      { width: W.shipFromDate, text: ctx.bolDate(d.shipDate), bold: true, fontSize: size, alignment: "center" },
      { width: W.shipFromWord, text: "From", fontSize: size, ...weight },
      { width: W.shipFromName, text: d.company.name, fontSize: size, ...weight },
    ],
    columnGap: W.shipFromGap,
    margin: [0, 2, 0, 2],
  };
}

/** The legal preamble: the received clause, the ship-from line, the property clause, the shipper
 *  certification — three text blocks around one composite data line, in the sample's fixed
 *  order (text blocks are not reorderable elements; only the `ship_from` field can hide). The
 *  5.5pt clauses print at the config's `smallSize` role; the 6pt certification keeps its own
 *  literal — the knob maps to exactly the slots the contract's default (5.5) reproduces. */
function receivedBlock(ctx: Ctx, d: BolData): Content[] {
  const v = ctx.sections.get("received")!;
  const out: Content[] = [
    seedPiece(ctx, "bol_received_text", { text: ctx.text("bol_received_text"), fontSize: ctx.fonts.smallSize, margin: [0, 0, 0, 2] }),
  ];
  if (v.field("ship_from").visible) out.push(seedPiece(ctx, "ship_from", shipFromLine(ctx, d)));
  out.push(seedPiece(ctx, "bol_property_text", { text: ctx.text("bol_property_text"), fontSize: ctx.fonts.smallSize, margin: [0, 0, 0, 2] }));
  out.push(seedPiece(ctx, "bol_certifies_text", { text: ctx.text("bol_certifies_text"), fontSize: CERTIFIES.fontSize, bold: CERTIFIES.bold, margin: [8, 0, 0, 2] }));
  out.push(seedPiece(ctx, "preamble_rule", fullRule([0, 0, 0, 4], BOL_RULE_WEIGHTS.light)));
  return out;
}

/** The two consignee rows: the ship-to name and street, each on a `consignedRule` rule, the
 *  caption beside the first in `captionWidth` (the flow's `consignedBlock` passes `"*"`). */
function consigneeRows(label: string, labelStyle: LabelStyle, d: BolData, captionWidth: number | "*"): Content[] {
  return [
    {
      columns: [
        ...ruledPair({
          label, labelWidth: W.consignedLabel, labelStyle, value: d.consignee.name, valueSize: 9,
          columnWidth: W.consignedRule, ruleWidth: W.consignedRule,
        }),
        { width: captionWidth, text: "(Mail or street address of consign - For purposes of notification only.)", fontSize: 5.5, margin: [8, 2, 0, 0] },
      ],
      columnGap: W.rowGap,
    },
    {
      columns: [
        { width: W.consignedLabel, text: "" },
        ruledValue(d.consignee.street, W.consignedRule, W.consignedRule, 9),
        { width: captionWidth, text: "" },
      ],
      columnGap: W.rowGap,
      margin: [0, 3, 0, 0],
    },
  ];
}

/** The flow's consignee and destination labels: 9 pt bold. */
const CONSIGNEE_LABEL: LabelStyle = { fontSize: 9, bold: true };

/** Consigned to / Destination, from the ship-to address — how a third-party consignee like the
 *  sample's "Example Coating" is expressed (spec §10.2, §3's closing note). Hand-laid: each field
 *  keeps the sample's fixed position and drops its label+rule pair when hidden (config order
 *  does not rearrange within this block); the captions are furniture riding with their rows. */
function consignedBlock(ctx: Ctx, d: BolData): Content[] {
  const v = ctx.sections.get("consigned")!;
  const f = v.field;
  const rows: Content[] = [];

  if (f("consigned_to").visible) {
    const consignee = consigneeRows(f("consigned_to").label, CONSIGNEE_LABEL, d, "*");
    // Under the seed the two rows are one piece, as the canvas prints them as one item.
    if (ctx.seed) rows.push(seedPiece(ctx, "consigned_to", { stack: consignee }));
    else rows.push(...consignee);
  }

  const destPairs: Column[] = [];
  if (f("destination").visible) {
    destPairs.push(...seedPair(ctx, "destination", ruledPair({
      label: f("destination").label, labelWidth: W.destinationLabel, labelStyle: CONSIGNEE_LABEL,
      value: d.consignee.city, valueSize: 9, columnWidth: W.destinationRule, ruleWidth: W.destinationRule,
    })));
  }
  if (f("destination_state").visible) {
    destPairs.push(...seedPair(ctx, "destination_state", ruledPair({
      label: f("destination_state").label, labelWidth: W.stateLabel, labelStyle: FORM_LABEL,
      value: d.consignee.state, valueSize: 9, valueAlign: "center", columnWidth: W.stateRule, ruleWidth: W.stateRule,
    })));
  }
  if (f("destination_zip").visible) {
    destPairs.push(...seedPair(ctx, "destination_zip", ruledPair({
      label: f("destination_zip").label, labelWidth: W.zipLabel, labelStyle: FORM_LABEL,
      value: d.consignee.zip, valueSize: 9, valueAlign: "center", columnWidth: W.zipRule, ruleWidth: W.zipRule,
    })));
  }
  if (destPairs.length > 0) {
    rows.push({
      columns: [
        ...destPairs,
        seedColumn(ctx, "delivery_caption", { width: "*", text: BOL_FURNITURE_TEXT.delivery_caption, fontSize: DELIVERY_CAPTION.fontSize, margin: [8, 2, 0, 0] }),
      ],
      columnGap: W.rowGap,
      margin: [0, 3, 0, 0],
    });
    rows.push(seedPiece(ctx, "delivery_footnote", {
      text: BOL_FURNITURE_TEXT.delivery_footnote, fontSize: DELIVERY_FOOTNOTE.fontSize, alignment: DELIVERY_FOOTNOTE.alignment, margin: [0, 2, 0, 0],
    }));
  }

  if (rows.length === 0) return [];
  return [{ stack: rows, margin: [0, 2, 0, 4] }];
}

/** The PO list as the flow prints it: every non-blank PO, comma-joined (the one statement of it). */
function poList(d: BolData): string {
  return d.poNumbers.filter((p) => p !== "").join(", ");
}

/** TRV NO. and every order number on the shipment, the §3.20 point of the whole document: the
 *  TRV line's list node, null when the field is hidden. The numbers are joined by a comma and a
 *  zero-width space (U+200B), a break point that prints nothing (#943, owner ruling (b) of
 *  2026-11-13): digits joined by a bare comma are one token pdfmake cannot break, so a long list ran
 *  past the right margin on the flow and broke mid-number on a canvas, where now it wraps after a
 *  comma inside its column and pushes what follows down. A one-line list prints at the width and
 *  look it had (the face lays U+200B out at zero advance), though it is drawn one run per number. */
function trvListNode(ctx: Ctx, d: BolData): Content | null {
  const v = ctx.sections.get("trv")!;
  if (!v.field("trv_no").visible) return null;
  return {
    columns: [
      { width: W.trvLabel, text: v.field("trv_no").label, bold: true, fontSize: 9.5 },
      // The seed's placeholder: one blank line, whatever the shipment's orders (#943, owner 2026-11-15).
      { width: "*", text: ctx.seedPlaceholders ? " " : d.orderNumbers.join(",\u200B"), bold: true, fontSize: 9.5 },
    ],
    margin: [0, 2, 0, 4],
  };
}

/** The TRV line: its list node and the rule under it. */
function trvLine(ctx: Ctx, d: BolData): Content[] {
  const node = trvListNode(ctx, d);
  return node === null ? [] : [seedSection(ctx, "trv", node), seedPiece(ctx, "trv_rule", fullRule([0, 0, 0, 3], BOL_RULE_WEIGHTS.light))];
}

/** The delivering-carrier row's labels: 8 pt bold, the second and third set right. */
const DELIVERING_LABEL: LabelStyle = { fontSize: 8, bold: true };
const DELIVERING_LABEL_RIGHT: LabelStyle = { fontSize: 8, bold: true, alignment: "right" };

/** Delivering Carrier / Car or Vehicle Initials / No. — blank rules for hand completion. Each
 *  field's label+rule pair drops when hidden; the sample's fixed left-to-right order holds. */
function deliveringCarrierLine(ctx: Ctx): Content[] {
  const v = ctx.sections.get("delivering_carrier")!;
  const f = v.field;
  const cols: Column[] = [];
  if (f("delivering_carrier").visible) {
    cols.push(...seedPair(ctx, "delivering_carrier", ruledPair({
      label: f("delivering_carrier").label, labelWidth: W.deliveringLabel, labelStyle: DELIVERING_LABEL,
      value: null, columnWidth: W.deliveringRule, ruleWidth: W.deliveringRule,
    })));
  }
  if (f("vehicle_initials").visible) {
    cols.push(...seedPair(ctx, "vehicle_initials", ruledPair({
      label: f("vehicle_initials").label, labelWidth: W.initialsLabel, labelStyle: DELIVERING_LABEL_RIGHT,
      value: null, columnWidth: W.initialsRule, ruleWidth: W.initialsRule,
    })));
  }
  if (f("vehicle_no").visible) {
    cols.push(...seedPair(ctx, "vehicle_no", ruledPair({
      label: f("vehicle_no").label, labelWidth: W.vehicleNoLabel, labelStyle: DELIVERING_LABEL_RIGHT,
      value: null, columnWidth: "*", ruleWidth: W.vehicleNoRule,
    })));
  }
  if (cols.length === 0) return [];
  return [{ columns: cols, columnGap: W.rowGap, margin: [0, 2, 0, 6] }];
}

/** The freight table (columns per config — order, labels, widths) beside the Section 7 /
 *  prepaid-collect sidebar. The sidebar's paragraphs are the section's text blocks; its one
 *  data-driven mark, the collect checkbox, is the `collect_checkbox` field — hiding it drops
 *  the box AND its explanatory caption (the caption exists only to explain the box).
 *
 *  The weight cell is one weight for the whole shipment, with its unit. It has three outcomes,
 *  and `shipmentWeightTotals` is the one statement of the rule behind them. The shipment's gross
 *  when it has one. Else its net: an order on it has no gross, or every order has one and the
 *  figures added up pass that leaf's ceiling. Else an empty cell, when no net can be worked out
 *  either. The small line under a figure says which it is. Its two words are this builder's own
 *  and no template label, so a retyped heading changes neither. */
function freightBlock(ctx: Ctx, d: BolData): Content[] {
  const { num } = ctx;
  const v = ctx.sections.get("freight")!;
  const cols = columnKeys(v, "freight");

  const headFor = (key: string): TableCell => key === "freight_description"
    // The description's header cell stacks the sample's second line under the label — the
    // contract's own note: one column, two header lines.
    ? { stack: [{ text: v.field(key).label, bold: true, alignment: "center", fontSize: 6.5 }, { text: BOL_FREIGHT_DESCRIPTION_SECOND_LINE, bold: true, alignment: "center", fontSize: 6.5 }] }
    : head(v.field(key).label);
  const cellFor = (key: string): TableCell => {
    switch (key) {
      case "package_count": return { text: d.packageCount === null ? "" : num(d.packageCount), alignment: "center", fontSize: 9 };
      case "freight_description": return { text: d.freightDescription, fontSize: 9 };
      case "freight_weight": {
        const totals = shipmentWeightTotals(d.orders);
        const cents = totals.grossCents ?? totals.netCents;
        // A net that cannot be worked out prints nothing: no figure, no unit and no word.
        if (cents === null) return { text: "" };
        return {
          alignment: "right",
          stack: [
            { text: lb(num(cents / 100)), fontSize: 9 },
            { text: totals.grossCents !== null ? "Gross weight" : NET_WEIGHT, fontSize: 6.5, color: "#444444" },
          ],
        };
      }
      case "freight_class": return { text: d.freightClass, alignment: "center", fontSize: 9 };
      default: return { text: "" }; // check_column — hand-completed
    }
  };
  const freightTable: Content | null = cols.length === 0 ? null : {
    table: {
      headerRows: 1,
      widths: cols.map((k) => v.field(k).width),
      body: [cols.map(headFor), cols.map(cellFor)],
    },
    layout: LAYOUT.boxed,
  };

  const smallRule = (margin: [number, number, number, number]): Content =>
    ({ canvas: [{ type: "line", x1: 0, y1: 0, x2: 160, y2: 0, lineWidth: 0.8 }], margin });

  const sidebarStack: Content[] = [
    { text: ctx.text("bol_section_7_text"), fontSize: 6 },
    { text: ctx.text("bol_no_delivery_text"), fontSize: 6, margin: [0, 6, 0, 0] },
    smallRule([0, 14, 0, 1]),
    { text: "(Signature of consignor)", fontSize: 5.5, alignment: "center" },
  ];
  if (v.field("collect_checkbox").visible) {
    sidebarStack.push({ text: "Freight charges are PREPAID unless marked collect.", fontSize: 6, margin: [0, 8, 0, 2] });
    sidebarStack.push({
      columns: [
        { width: "*", text: v.field("collect_checkbox").label, bold: true, fontSize: 6.5, margin: [0, 2, 0, 0] },
        {
          width: BOL_COLLECT_BOX.column,
          // The one data-driven mark on the whole form (spec §10.2's "prepaid/collect block
          // driven by freightTerms"): an X in the box for COLLECT, an empty box for PREPAID. The
          // layout fits the box to this column (#557).
          table: { widths: [BOL_COLLECT_BOX.cell], body: [[{ text: d.freightTerms === "COLLECT" ? "X" : "", alignment: "center", fontSize: 7, bold: true }]] },
          layout: LAYOUT.collectBox,
        },
      ],
      margin: [0, 0, 0, 6],
    });
  }
  sidebarStack.push(
    smallRule([0, 8, 0, 1]),
    { text: "RECEIVED $", fontSize: 6.5, bold: true },
    { text: "to apply in prepayment of the charges on the property described hereon.", fontSize: 6, margin: [0, 2, 0, 0] },
    smallRule([0, 12, 0, 1]),
    { text: "Agent or Cashier", fontSize: 5.5, alignment: "center" },
    smallRule([0, 8, 0, 1]),
    { text: "Per", fontSize: 6.5 },
    { text: "(The signature here acknowledges only the amount prepaid.)", fontSize: 6, margin: [0, 2, 0, 0] },
    { text: "Charges Advanced:", fontSize: 6.5, bold: true, margin: [0, 8, 0, 0] },
    smallRule([0, 8, 0, 1]),
    { text: "$", fontSize: 6.5 },
    { text: ctx.text("bol_imprint_text"), fontSize: 6, margin: [0, 8, 0, 0] },
  );

  return [{
    columns: [
      { width: "*", stack: freightTable === null ? [] : [freightTable] },
      { width: W.sidebar, stack: [{ stack: sidebarStack }] },
    ],
    columnGap: W.sidebarGap,
    margin: [0, 0, 0, 10],
  }];
}

/** The bottom note stack: value declaration, liability limitation, fibre boxes (five text
 *  blocks), and the hand-signed Shipper/Agent/post-office lines. A hidden signature half leaves
 *  its slot holding position (the ticket parties' treatment); the PO-address line drops whole.
 *  The 5.5pt notes print at `smallSize`; the 7pt declared-value statement keeps its literal. */
function bottomBlock(ctx: Ctx): Content[] {
  const v = ctx.sections.get("bottom")!;
  const f = v.field;
  const stack: Content[] = [
    seedPiece(ctx, "bol_water_note", { text: ctx.text("bol_water_note"), fontSize: ctx.fonts.smallSize }),
    seedPiece(ctx, "bol_value_note", { text: ctx.text("bol_value_note"), fontSize: ctx.fonts.smallSize, margin: [0, 2, 0, 0] }),
    seedPiece(ctx, "bol_declared_value_text", { text: ctx.text("bol_declared_value_text"), bold: DECLARED_VALUE.bold, fontSize: DECLARED_VALUE.fontSize, margin: [0, 3, 0, 0] }),
    {
      columns: [
        { width: BOL_PER_ROW.offset, text: "" },
        seedColumn(ctx, "per", { width: BOL_PER_ROW.word, text: BOL_FURNITURE_TEXT.per, bold: PER_WORD.bold, fontSize: PER_WORD.fontSize }),
        seedStack(ctx, "per_rule", { width: BOL_PER_ROW.rule, stack: [{ text: " " }, line(BOL_PER_ROW.rule)] }),
        { width: "*", text: "" },
      ],
      margin: [0, 1, 0, 2],
    },
    seedPiece(ctx, "bol_liability_note", { text: ctx.text("bol_liability_note"), fontSize: ctx.fonts.smallSize }),
    seedPiece(ctx, "liability_rule", fullRule([0, 4, 0, 2], BOL_RULE_WEIGHTS.light)),
    seedPiece(ctx, "bol_fibre_note", { text: ctx.text("bol_fibre_note"), bold: true, fontSize: ctx.fonts.smallSize }),
    seedPiece(ctx, "fibre_rule", fullRule([0, 2, 0, 8], BOL_RULE_WEIGHTS.light)),
  ];
  if (f("shipper_per").visible || f("agent_per").visible) {
    stack.push({
      columns: [
        ...(f("shipper_per").visible
          ? seedPair(ctx, "shipper_per", ruledPair({
            label: f("shipper_per").label, labelWidth: W.signLabel, labelStyle: FORM_LABEL,
            value: null, columnWidth: W.shipperRule, ruleWidth: W.shipperRule,
          }))
          : [{ width: W.signLabel, text: "" }, { width: W.shipperRule, text: "" }] as Column[]),
        ...(f("agent_per").visible
          ? seedPair(ctx, "agent_per", ruledPair({
            label: f("agent_per").label, labelWidth: W.signLabel, labelStyle: { ...FORM_LABEL, alignment: "right" },
            value: null, columnWidth: "*", ruleWidth: W.agentRule,
          }))
          : [{ width: W.signLabel, text: "" }, { width: "*", text: "" }] as Column[]),
      ],
      columnGap: W.signGap,
      margin: [0, 6, 0, 8],
    });
  }
  if (f("po_address").visible) {
    stack.push({
      columns: seedPair(ctx, "po_address", ruledPair({
        label: f("po_address").label, labelWidth: W.poAddressLabel, labelStyle: FORM_LABEL,
        value: null, columnWidth: "*", ruleWidth: W.poAddressRule,
      })),
      columnGap: W.rowGap,
    });
  }
  return [{ stack }];
}

/** One config section key → its renderer. Empty array means "nothing left to draw" — the block
 *  drops from the stack, like a hidden section. An unknown key renders nothing: the validator
 *  refused it before any config stored it. */
function renderSection(key: string, ctx: Ctx, d: BolData): Content[] {
  switch (key) {
    case "header": return headerBlock(ctx, d);
    case "carrier": return carrierBlock(ctx, d);
    case "received": return receivedBlock(ctx, d);
    case "consigned": return consignedBlock(ctx, d);
    case "trv": return trvLine(ctx, d);
    case "delivering_carrier": return deliveringCarrierLine(ctx);
    // The canvas prints `freightBlock` too, so its seed marks are put on here, in the flow alone.
    case "freight": return freightBlock(ctx, d).map((block) => seedSection(ctx, "freight", block));
    case "bottom": return bottomBlock(ctx);
    default: return [];
  }
}

/** The continuation band's margin reserve: one 11pt identity line plus the small "(continued)"
 *  line under a 10pt offset — 40 clears the body (the ticket's CONTINUATION_TOP_MARGIN, sized
 *  for a text-only band). Only an OVERFLOWING BOL pays it (render.ts's two-pass); a one-page BOL
 *  keeps today's 24pt top margin untouched. */
const CONTINUATION_TOP_MARGIN = 40;
/** Bottom margin when a template turns the `pageFooter` knob on: the footer draws in the bottom
 *  margin and needs ≥ ~28pt — 44 is the quote's own value, the house precedent. The knob
 *  defaults OFF, so the default paper keeps its 24pt (golden). */
const FOOTER_BOTTOM_MARGIN = 44;

/**
 * The BOL's identity band — what a BOL overflowing LETTER repeats on its continuation pages. The
 * BOL genuinely overflows: the TRV/PO lists grow with the shipment's order count, which the live
 * path does not bound (`createShipper`'s orders array is min(1) with no max) — ~80 orders pushes
 * the paper to a second page (probed empirically, Task 10). Its identity is its `bolNumber`
 * (§3.19 — the BOL's one number of its own). Rendered REGARDLESS of the config's visibility
 * flags (the ticket band's identity treatment — identity on paper is locked, not configurable),
 * though the `bol_number` label override still carries through. The `[24, 10, 24, 0]` margin
 * aligns the band with the page's 24pt side margins: pdfmake header content spans the full page
 * width (the footer spec's own convention).
 */
function continuationHeader(ctx: Ctx, d: BolData): Content {
  const v = ctx.sections.get("header")!;
  return {
    stack: [
      { text: `${v.field("bol_number").label} ${d.bolNumber}`, bold: true, fontSize: 11 },
      { text: "(continued)", italics: true, fontSize: ctx.fonts.smallSize },
    ],
    margin: [24, 10, 24, 0],
  };
}

// ---------------------------------------------------------------------------------------------
// The builder (spec §10.2, P7 spec §5.4). PURE — data and config in, JSON out.
// ---------------------------------------------------------------------------------------------

/**
 * `config` is a **backfilled** `TemplateConfig` (what `resolveTemplateForPrint` returns) and
 * DEFAULTS to the contract's own `DEFAULT_CONFIG` — the complete canonical constant the seeded
 * "Standard" template stores — so a config-less call renders exactly today's paper (the
 * golden-compat gate, tests/bol.test.ts). `logoDataUri` is the traveler's deliberate extra
 * parameter: the logo bytes belong to the resolved template version, not to the shipment data.
 *
 * ONE definition — the BOL is single-document paper (one per shipment, §3.19), so there is no
 * sheet-group plural here: `renderPdf` consumes the `RenderableDefinition` directly, its
 * `continuationHeaderSpec` covering the genuine many-order overflow (see `continuationHeader`)
 * and `config.pageFooter` (default OFF — golden) adding the page-number footer.
 *
 * It branches once on `config.layout` (design 2026-11-09 §5.1): a layout prints the canvas
 * (`buildCanvasBolDefinition`, src/server/bol-canvas.ts), handed the flow's own builders
 * (`BOL_FLOW`), one definition in one pass with no `overflowTopMargin`; a null layout is every
 * stored config's and renders exactly what it rendered before.
 *
 * `options` is the canvas seed's (`seedBolLayout`, src/server/bol-canvas-seed.ts), read by the flow
 * alone: `seedIds` marks the flow's pieces with the `BOL_SEED_IDS` the seed reads back from one
 * layout, and `seedPlaceholders` prints the PO list as one blank line. A print and a preview pass
 * none and render exactly the nodes they rendered before.
 */
export function buildBolDefinition(
  input: BolData,
  config: TemplateConfig = DEFAULT_CONFIG,
  logoDataUri?: string,
  options: { seedIds?: boolean; seedPlaceholders?: boolean } = {},
): RenderableDefinition {
  if (config.layout !== null) {
    return buildCanvasBolDefinition(input, config, config.layout, BOL_FLOW, logoDataUri);
  }
  // The §5.6 belt's OMISSION half: views resolve over `completeSections`, never
  // `config.sections` raw, so a raw config omitting an entry cannot drop it.
  const sectionConfigs = completeSections(BOL_CONTRACT, config.sections);
  const sections = new Map(sectionConfigs.map((sc) => [sc.key, sectionView(sc)] as const));
  const ctx: Ctx = {
    fonts: config.fonts,
    num: makeNum(config.formats),
    bolDate: makeBolDate(config.formats),
    text: textOf(config.textBlocks),
    sections,
    logo: config.logo !== null && logoDataUri !== undefined
      ? { placement: config.logo.placement, width: config.logo.width, dataUri: logoDataUri }
      : null,
    ...(options.seedIds === true ? { seed: true } : {}),
    ...(options.seedPlaceholders === true ? { seedPlaceholders: true } : {}),
  };

  const content: Content[] = [];
  // Stack order IS the config's section order; hidden sections are omitted (nothing on this
  // contract is locked, so the belt forces none of them back).
  for (const sc of sectionConfigs) {
    if (!sections.get(sc.key)!.visible) continue;
    content.push(...inBoxFlowSection("BOL", sc.key, renderSection(sc.key, ctx, input)));
  }

  return {
    pageSize: "LETTER",
    pageMargins: [24, 24, 24, config.pageFooter ? FOOTER_BOTTOM_MARGIN : 24],
    defaultStyle: { font: config.fonts.family, fontSize: config.fonts.baseSize },
    // No `info.creationDate`, no clock anywhere — two prints of the same shipment must not differ
    // for no reason (the traveler's purity rule).
    content,
    continuationHeaderSpec: {
      content: continuationHeader(ctx, input),
      overflowTopMargin: CONTINUATION_TOP_MARGIN,
    },
    ...(config.pageFooter ? { pageFooterSpec: { kind: "pageNofM" as const } } : {}),
  };
}

/**
 * The flow's own type for a piece the canvas seed places (`seedBolLayout`, design 2026-11-09 §4.2's
 * seeded styles): a field item's label style, a text block's wording style or a static Text's,
 * read from the styles the flow prints with, so the seed states none of its own. The wordings at the
 * template's sizes take `fonts` (the title at the heading size; the clauses and notes at the small
 * size, the fibre note bold). Null for a key the seed places no styled item for.
 */
export function bolSeedStyle(key: string, fonts: FontsConfig): { size: number; bold: boolean; align: "left" | "center" | "right" } | null {
  const of = (s: LabelStyle) => ({ size: s.fontSize, bold: s.bold, align: s.alignment ?? "left" });
  switch (key) {
    case "original_label": return of(ORIGINAL_LABEL);
    case "title": return { size: fonts.headingSize, bold: true, align: "left" };
    case "pro_number":
    case "bol_number":
    case "scac_code":
    case "destination_state":
    case "destination_zip":
    case "shipper_per":
    case "po_address": return of(FORM_LABEL);
    case "agent_per": return of({ ...FORM_LABEL, alignment: "right" });
    case "carrier_name": return of(CARRIER_NAME);
    case "ship_from": return of(SHIP_FROM);
    case "consigned_to":
    case "destination": return of(CONSIGNEE_LABEL);
    case "delivering_carrier": return of(DELIVERING_LABEL);
    case "vehicle_initials":
    case "vehicle_no": return of(DELIVERING_LABEL_RIGHT);
    case "bol_received_text":
    case "bol_property_text":
    case "bol_water_note":
    case "bol_value_note":
    case "bol_liability_note": return { size: fonts.smallSize, bold: false, align: "left" };
    case "bol_fibre_note": return { size: fonts.smallSize, bold: true, align: "left" };
    case "bol_certifies_text": return of(CERTIFIES);
    case "bol_declared_value_text": return of(DECLARED_VALUE);
    case "delivery_caption": return of(DELIVERY_CAPTION);
    case "delivery_footnote": return of(DELIVERY_FOOTNOTE);
    case "per": return of(PER_WORD);
    default: return null;
  }
}

/** The flow's own builders, handed to the canvas path (`src/server/bol-canvas.ts`), which imports
 *  only types from this file: it prints each field and block exactly as the flow does, with no
 *  import cycle (the traveler's `CANVAS_FLOW`, the ticket's `TICKET_FLOW`). */
export type BolFlowBuilders = {
  /** `BOL_WIDTHS`, handed on with the builders so the canvas reads the flow's widths with no value
   *  import from this file (the ticket's `RECEIVED_BY_RULE` precedent). */
  widths: typeof BOL_WIDTHS;
  sectionView: (sc: SectionConfig) => SectionView;
  makeNum: (f: FormatsConfig) => (v: number) => string;
  makeBolDate: (f: FormatsConfig) => (iso: string) => string;
  /** The ctx's `text`: a text block's wording, the config's else the contract's. */
  textOf: (textBlocks: Record<string, string>) => (key: string) => string;
  labeledRule: (label: string, value: string, labelWidth: number, valueWidth: number, labelStyle?: LabelStyle) => Content;
  /** A label column beside a value on a rule (or a blank write-in rule: `value` null), the two
   *  columns the flow's consignee, destination, delivering-carrier and signature rows are made of. */
  ruledPair: (p: {
    label: string; labelWidth: number; labelStyle: LabelStyle; value: string | null;
    valueSize?: number; valueAlign?: "left" | "center"; columnWidth: number | "*"; ruleWidth: number;
  }) => Column[];
  carrierStack: (name: string, caption: string, width: number, nameStyle: LabelStyle) => Content;
  /** The ship-from line: four columns at `size`, the date bold always, `bold` on the other three. */
  shipFromLine: (ctx: Ctx, d: BolData, size?: number, bold?: boolean) => Content;
  /** The two consignee rows (the ship-to name and street, each on a `consignedRule` rule, the caption
   *  beside the first in `captionWidth`), the flow's `consignedBlock` calling it with `"*"`. */
  consigneeRows: (label: string, labelStyle: LabelStyle, d: BolData, captionWidth: number | "*") => Content[];
  /** The PO list as the flow prints it: every non-blank PO, comma-joined (the one statement of it). */
  poList: (d: BolData) => string;
  /** The TRV line's list node, null when the field is hidden. */
  trvListNode: (ctx: Ctx, d: BolData) => Content | null;
  freightBlock: (ctx: Ctx, d: BolData) => Content[];
};

export const BOL_FLOW: BolFlowBuilders = {
  widths: BOL_WIDTHS, sectionView, makeNum, makeBolDate, textOf, labeledRule, ruledPair, carrierStack, shipFromLine,
  consigneeRows, poList, trvListNode, freightBlock,
};

/**
 * The canvas item node of the bill of lading, for the template preview's alone layouts
 * (`aloneLayouts`, `pdf/canvas-sheet.ts`): the closure its sheet is assembled with, built over the
 * same ctx and the flow's own builders (`BOL_FLOW`). Only a canvas config has one. It lives here,
 * beside `BOL_FLOW`, as the ticket's `ticketCanvasItemContent` lives in shipping-ticket.ts: the
 * canvas module cannot reach the flow's builders but through a parameter.
 */
export function bolCanvasItemContent(input: BolData, config: TemplateConfig, logoDataUri?: string): ItemContent {
  if (config.layout === null) throw new Error("bolCanvasItemContent needs a canvas config.");
  return firstBolItemContent(input, config, config.layout, BOL_FLOW, logoDataUri);
}
