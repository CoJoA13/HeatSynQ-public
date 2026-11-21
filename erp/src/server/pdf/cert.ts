/**
 * The certification (design spec §10.3, owner rulings §3.11/§3.19/§3.21). PURE by construction,
 * the traveler.ts contract: `CertPdfData` + a validated `TemplateConfig` in, a plain-JSON pdfmake
 * definition out — no I/O, no clock, nothing that would not survive `JSON.parse(JSON.stringify())`
 * (asserted in tests/cert-pdf.test.ts). The reads live in certs.ts (`readCertPdfData`), the bytes
 * in render.ts.
 *
 * A CONFIG-CONSUMER since Phase 7 Task 11 (P7 spec §5.4) — the BOL's exact lens (`sectionView`
 * over `completeSections`, the §5.6 belt in both halves): sections/fields/labels/widths/fonts/
 * formats render from a validated config, and the default config reproduces today's paper exactly
 * (the golden gate, tests/cert-pdf.test.ts, untouched). Two deliberate departures from the BOL:
 *
 *  - **`cert_statement` binds through the DATA SEAM, not `config.textBlocks`** (the TICKET's
 *    liability-text shape, not the BOL's form-constant shape). certs.ts ALREADY reads the Setting
 *    into `CertPdfData.statement`, so the statement is caller data, not a builder literal — binding
 *    the builder to config would create two sources for one fact and break the pure-builder golden
 *    test. `printCert` injects `config.textBlocks.cert_statement` at that seam instead; the
 *    `statement` section here is a text-block section with no fields of its own, and the builder
 *    renders `input.statement` verbatim.
 *  - **§3.21 is enforced by the INPUT TYPE, and the config cannot widen it.** `CertPdfData` carries
 *    no min, no max, no pass/fail, no override and no per-reading structure — only bare reading
 *    values under a line naming the specification and scale. A config can only REARRANGE what the
 *    data layer collects; the cert's data layer deliberately never collects those, so no field
 *    below can bind one. Likewise `internalNotes` has no field here at all (spec §7.4 / §10.3's
 *    "Never internalNotes"; §5.6: "not in the contract at all — nothing to lock").
 *
 * **THE DATE KNOB HAS NO STYLE TRAP HERE** (the ticket's two-date-styles rule, generalized: map the
 * knob to exactly the slots the contract's default reproduces). This builder was grepped for every
 * date call before the knob was mapped — `certDate` renders the Date and Entry Date header slots,
 * BOTH the sample's MM/DD/YYYY style — so the contract's single knob maps to those two same-style
 * slots directly, no second style to trap.
 *
 * Layout mirrors the owner's `docs/samples/Certification Sample.pdf`, which IS the contract
 * (spec §3.1). Deviations are individually commented; there are no silent ones:
 *  - the top-left logo is Phase 7's (spec §6.3) — the sample's own logo area, off by default (the
 *    owner supplied none): a config that places one fills the header's 100pt left spacer.
 *  - no "Page: 1 of 1" by default — a page count is not knowable to a pure JSON definition, and a
 *    hard-coded "1 of 1" would lie the moment a long cert wraps; the `pageFooter` knob (spec §6.1)
 *    turns the real per-page count on when a template wants it.
 *  - the sample's stray "93753" beside the address is Visual Shop's internal row id (the ticket's
 *    own ruling on the same artifact) — not printed.
 *  - the footer prints the company address and phone; the sample's trailing empty "Fax:" label has
 *    no field behind it in this model (there is no fax setting) — not printed (do not invent
 *    fields, the ticket's "Temper Only" precedent).
 *  - the signature block is flow-laid with a top margin, never `absolutePosition` (the Task 18
 *    review's tear-off collision lesson) — on a long cert it follows the content instead of
 *    overprinting it. Its RENDERING SEMANTICS (§3.11 — image over the rule, or the typed name when
 *    no image is on file) stay the builder's own and are BYTE-IDENTICAL to pre-conversion under
 *    the default config (pinned through the definition and rendered bytes, tests/cert-templates).
 *    The canvas branch (`buildCanvasCertDefinition`, src/server/cert-canvas.ts) keeps that rule by
 *    construction: its blocks, the signature among them, flow, and only its detached items (the
 *    page-top items, the repeated items and the page-bottom band's items) and the "(continued)" box
 *    take `absolutePosition` (design 2026-11-10 §5.2; the sheet's `pageTopNode` and `placedNode`,
 *    src/server/pdf/canvas-sheet.ts). An item anchored below a block rides that block's float
 *    region at `relativePosition`.
 *  - the weight column's heading is the contract's built-in "Net weight", which was "Pounds"
 *    until owner ruling W14 of 2026-10-09, and each weight under it prints with its unit,
 *    "4,128 lb" (owner ruling W15 of the same day). The unit comes from `lb` of
 *    ./printed-weight. A row with no weight prints a blank cell and no unit.
 */
import type { Column, Content, TableCell } from "pdfmake/interfaces";
import { LAYOUT, type RenderableDefinition } from "./render";
import { inBoxFlowSection } from "./flow-tables";
import type { ItemContent } from "./canvas-sheet";
import { mark } from "./canvas-nodes";
import { buildCanvasCertDefinition, firstCertItemContent } from "../cert-canvas";
import { lb } from "./printed-weight";
import { CERT_CONTRACT, DEFAULT_CONFIG } from "../../lib/template-contracts/cert";
import type { CanvasTextStyle } from "../../lib/template-contracts/canvas";
import {
  completeSections,
  type FontsConfig, type FormatsConfig, type LogoPlacement, type SectionConfig,
  type TemplateConfig,
} from "../../lib/template-contracts/types";

// ---------------------------------------------------------------------------------------------
// CertPdfData — the builder's whole input. Plain data: no Decimals, no Dates, no Prisma rows.
// ---------------------------------------------------------------------------------------------

export type CertCompany = { name: string; address: string; phone: string };
/** `attn` is the bill-to row's name stacked above the customer's (R14, #671), "" when the row has
 *  none or it repeats the customer's. */
export type CertParty = { attn: string; name: string; street: string; city: string; state: string; zip: string };
/** `qty`/`pounds` nullable: a LOAD-scope cert against a load whose split left qty/weight blank
 *  prints a blank cell, never an invented zero. */
export type CertPartRow = { qty: number | null; partNumber: string; partName: string; partDescription: string; pounds: number | null };
/** One §10.3 requirement block: the line naming the specification and scale, then bare values. */
export type CertRequirementBlock = {
  /** Frozen line identity (ruling 24) — consumed only when the cert spans more than one part
   *  (ruling 27): a single-part cert renders heading-free, identical to the §3.21 sample.
   *  `lineIdentity` is the never-reused grouping key (!57 review — the seed-line cuid, or the
   *  composite fallback for rows released before the backfill). */
  lineIdentity: string; linePosition: number; partNumber: string; partName: string;
  specification: string; scale: string; readings: number[];
};
export type CertSerialBlock = { partNumber: string; serials: { serial: string; description: string }[] };
/** §3.11: the PRINTING user's signature image above their typed name/title/company — or the name
 *  typed over the rule when no image is on file. `title` prints only when non-empty: the sample
 *  shows one ("Production Manager") but this system's User record carries no title field, so the
 *  collector passes "" and the line is omitted rather than fabricated. */
export type CertSigner = { name: string; title: string; company: string; signatureDataUri: string | null };
export type CertPdfData = {
  company: CertCompany;
  orderLabel: string;                  // "92036-3" for shipment scope, "92036" otherwise (§10.3)
  printDate: string;                   // "yyyy-mm-dd" — the day this print happened
  entryDate: string;                   // the order's received date
  to: CertParty;
  poNumber: string;
  packingListNo: number | null;        // the shipment's shipperNumber where one applies
  material: string;                    // the lead part's material
  parts: CertPartRow[];
  statement: string;                   // the `cert_statement` block, bound at printCert's data seam
  requirements: CertRequirementBlock[];
  serialBlocks: CertSerialBlock[];
  freeform: string;
  signer: CertSigner;
};

// ---------------------------------------------------------------------------------------------
// Formatting. Pure, config-driven (P7 spec §5.4's per-file formatting helpers), locale pinned
// (the traveler's own rule) so output never tracks the server's.
// ---------------------------------------------------------------------------------------------

/** Thousands-separated per the knob, at most 2 decimals — "4,128", "192". */
function makeNum(formats: FormatsConfig): (value: number) => string {
  const useGrouping = formats.thousandsSeparator !== false;
  return (value) => value.toLocaleString("en-US", { maximumFractionDigits: 2, useGrouping });
}

/** A reading value, at least one decimal (the sample's "30.0", "25.6" style) and at most the
 *  column's own four ("28.1234" survives untouched). DATA PRECISION, not a knob (the cert contract
 *  carries no price-decimals surface) — a pure literal function, never config-driven. */
function reading(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 4 });
}

const MONTHS_FULL = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The header's Date / Entry Date, driven by the contract's ONE date knob (default "MM/DD/YYYY" —
 * the sample's own zero-padded style). The paper's ONLY date slots, BOTH this same style — see the
 * header comment's no-trap note. Pure string work — parsing to a Date would drag a timezone into a
 * date-only value (src/lib/business-days.ts's whole point).
 */
function makeCertDate(formats: FormatsConfig): (iso: string) => string {
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

/** The packing list number zero-padded to six digits — the sample prints "092826" (the ticket's
 *  own rule); blank (never "000000") when the cert has no shipment. */
function packingListNo(n: number | null): string {
  return n === null ? "" : String(n).padStart(6, "0");
}

const head = (text: string): TableCell => ({ text, bold: true, alignment: "center" });

/** LETTER (612pt) minus the 24pt margins. */
const CONTENT_WIDTH = 564;

/** Every fixed width the flow prints with (points); the canvas reads it, and the profile's
 *  `CERT_LEAST_WIDTHS` (src/lib/template-contracts/cert.ts) is held to it by tests/cert-canvas.test.ts.
 *  The header's left slot (`headerLeft`) is the 100 pt spacer an unplaced logo leaves; the To
 *  block's city, state and zip columns (`toCity`, `toState`, `toZip`); the parties' right column and
 *  its gap; the signature column and its rule (`signature`) and the box its image is fitted to
 *  (`signatureFit` × `signatureFitHeight`); the footer strip's phone column. */
export const CERT_WIDTHS = {
  headerLeft: 100, headerRight: 165, headerGap: 8,
  toCity: 120, toState: 40, toZip: 60,
  partiesRight: 240, partiesGap: 10,
  signature: 250, signatureFit: 220, signatureFitHeight: 45,
  footerPhone: 200,
} as const;
const W = CERT_WIDTHS;

/** The flow's vertical constants the seed places the strip and the header with: the page's 44 pt
 *  bottom margin, the strip's 6 pt inset below the body, and the 6 pt under the header. */
export const CERT_PAGE = { bottomMargin: 44, stripInset: 6, headerBottom: 6 } as const;

const rule = (margin: [number, number, number, number], lineWidth = 1.5): Content =>
  ({ canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth }], margin });

/** Splits `values` into rows of three — the sample's own three-across readings grid. */
function chunk3<T>(values: T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < values.length; i += 3) rows.push(values.slice(i, i + 3));
  return rows;
}

// ---------------------------------------------------------------------------------------------
// The config lens (P7 spec §5.4) — the BOL's `sectionView`, applied to the cert's blocks. The
// builder ASSUMES a complete config (`validateConfig`'s §5.3 backfill guarantees every entry
// exists); only the null-means-contract-default knobs a complete config still carries resolve here.
//
// THE §5.6 BELT, both halves: the flag half (`visible || !hideable` / `visible || !removable`) is
// the BOL's expression verbatim — NOTHING on this contract is locked, so it forces nothing and a
// config may hide anything; the omission half is `completeSections` in `buildCertDefinition` below,
// so a raw config that OMITS an entry still renders it. (The BOL's third, text-block half is absent
// here: the cert's one text block, `cert_statement`, binds at the DATA SEAM, not through the
// builder — see the file comment.)
// ---------------------------------------------------------------------------------------------

const CONTRACT_SECTIONS = new Map(CERT_CONTRACT.sections.map((s) =>
  [s.key, { section: s, fields: new Map(s.fields.map((f) => [f.key, f])) }] as const));

type FieldView = { visible: boolean; label: string; width: number | "*" };
export type CertSectionView = {
  visible: boolean;
  /** Field keys in config (= display) order; per-field visibility still applies at use. */
  order: string[];
  field: (key: string) => FieldView;
};

function sectionView(sc: SectionConfig): CertSectionView {
  const cs = CONTRACT_SECTIONS.get(sc.key);
  // Unknown keys were refused by the validator before any config could be stored; a miss here
  // is a caller bug, not a config state.
  if (cs === undefined) throw new Error(`Unknown CERT template section "${sc.key}"`);
  const byKey = new Map(sc.fields.map((f) => [f.key, f]));
  return {
    visible: sc.visible || !cs.section.hideable, // the belt, section half (nothing locked here)
    order: sc.fields.map((f) => f.key),
    field: (key) => {
      const cf = cs.fields.get(key);
      if (cf === undefined) throw new Error(`Unknown CERT template field "${sc.key}.${key}"`);
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
export type CertCtx = {
  fonts: FontsConfig;
  num: (value: number) => string;
  /** The date knob's two consumers — the Date and Entry Date header slots (same style). */
  date: (iso: string) => string;
  sections: Map<string, CertSectionView>;
  /** Present only when the resolved version carries logo BYTES and the config PLACES them
   *  (spec §6.3) — either alone renders today's text-only header. */
  logo: { placement: LogoPlacement; width: number; dataUri: string } | null;
  /** The canvas seed's layout pass (`buildCertDefinition`'s `seedIds`): when true the flow marks the
   *  pieces and blocks a canvas item stands for (`CERT_SEED_IDS`). Absent on every print and
   *  preview, which render exactly the nodes they rendered before. */
  seed?: boolean;
};

/**
 * The ids the certification's canvas seed reads back from one layout of its stand-in (design
 * 2026-11-10 §5.3), the bill of lading's `BOL_SEED_IDS` shape: emitted only under `seedIds`, and
 * never on a TEXT node (pdfmake refuses two text nodes sharing an id in one document and makes a
 * named destination of a text id). A piece's id is on a wrapper stack around it (`seedPiece`), its
 * `end` mark after it inside that wrapper, BEFORE its bottom margin (moved onto the wrapper), so a
 * piece's box is its line alone; the logo's id is on its image. A block carries a `start` and a
 * `sectionEnd` mark: a one-node section (`to`, inside its column; `parts`, `statement`, `freeform`,
 * `signature`) inside its node's own vertical margins, which move onto an outer stack
 * (`seedSection`), so those margins lie between blocks; a several-node section (`requirements`,
 * `serials`) around all its nodes, every margin inside (`seedSeveral`). A visible section whose
 * builder answers nothing still emits its two marks, so the seed has a block to seed at the row
 * floor. The block keys and the piece keys never meet.
 */
export const CERT_SEED_IDS = {
  piece: (key: string) => `seed:${key}`,
  end: (key: string) => `seed:end:${key}`,
  start: (section: string) => `seed:start:${section}`,
  sectionEnd: (section: string) => `seed:end:${section}`,
} as const;

type Margin4 = [number, number, number, number];

/** A node's margin as four figures (this flow states every margin as four, or none). */
function marginOf(node: object): Margin4 {
  const margin = (node as { margin?: unknown }).margin;
  return Array.isArray(margin) && margin.length === 4 ? margin as Margin4 : [0, 0, 0, 0];
}

/** A piece wrapped for the seed: its id on a stack around it, its vertical margins moved onto that
 *  stack and its end mark after it inside them, so the end mark reports the piece's bottom and not
 *  its margin's (the bill of lading's `seedPiece`; it lays out the same). With no seed, the piece
 *  itself, unchanged. */
function seedPiece(ctx: CertCtx, key: string, node: Content): Content {
  if (!ctx.seed) return node;
  const [l, t, r, b] = marginOf(node as object);
  return {
    id: CERT_SEED_IDS.piece(key),
    stack: [{ ...(node as object), margin: [l, 0, r, 0] } as Content, mark(CERT_SEED_IDS.end(key))],
    margin: [0, t, 0, b],
  } as Content;
}

/** A one-node section under the seed: one stack holding the node's vertical margins, its `start`
 *  mark, the node with its vertical margins moved off and its `sectionEnd` mark, so the two marks
 *  stand at the node's own top and bottom (a canvas block is drawn with that node's vertical
 *  margins zeroed). A section that answers no node emits its two marks alone. With no seed, the
 *  nodes unchanged. */
function seedSection(ctx: CertCtx, section: string, nodes: Content[]): Content[] {
  if (!ctx.seed) return nodes;
  if (nodes.length === 0) return [{ stack: [mark(CERT_SEED_IDS.start(section)), mark(CERT_SEED_IDS.sectionEnd(section))] }];
  const [node] = nodes;
  const [l, t, r, b] = marginOf(node as object);
  return [{
    stack: [
      mark(CERT_SEED_IDS.start(section)),
      { ...(node as object), margin: [l, 0, r, 0] } as Content,
      mark(CERT_SEED_IDS.sectionEnd(section)),
    ],
    margin: [0, t, 0, b],
  }];
}

/** A several-node section under the seed: its `start` and `sectionEnd` marks around all its nodes,
 *  every margin kept inside, so the block's height holds the first node's top margin and the last's
 *  bottom (the canvas prints them inside its wrapper). With no seed, the nodes unchanged. */
function seedSeveral(ctx: CertCtx, section: string, nodes: Content[]): Content[] {
  if (!ctx.seed) return nodes;
  return [{ stack: [mark(CERT_SEED_IDS.start(section)), ...nodes, mark(CERT_SEED_IDS.sectionEnd(section))] }];
}

/** This section's visible column-field keys, in config order — what the parts table turns into its
 *  `widths` and its per-row cells. */
function columnKeys(v: CertSectionView, sectionKey: string): string[] {
  const cs = CONTRACT_SECTIONS.get(sectionKey)!;
  return v.order.filter((k) => cs.fields.get(k)?.column !== undefined && v.field(k).visible);
}

// ---------------------------------------------------------------------------------------------
// Blocks, top to bottom in sample order. Each returns Content[] — empty means "nothing left to
// draw" (every configurable piece hidden) and the block drops from the stack. The `footer` section
// is pulled OUT of the content flow into the page-margin strip (below), so it has no renderer here.
// ---------------------------------------------------------------------------------------------

/**
 * Company name over the big "Certification" title, centered; Order No. / Date / Entry Date right —
 * the sample's header. TWO structural slots hand-laid on the sample: the centered title stack
 * (company name + title) and the right order-fields stack; config field ORDER applies WITHIN each
 * slot, and a field never migrates between them (the BOL header's documented mapping decision). The
 * title's label IS its printed text, so a label override renames it; the date slots carry the knob.
 *
 * A placed logo (spec §6.3) fills the 100pt left spacer where the sample's logo area sits
 * (header-left) or joins the top of the title/order-field stack (header-center/header-right) — only
 * a placed logo changes the structure (golden: no logo → today's spacer-left header, byte-for-byte).
 */
function headerBlock(ctx: CertCtx, d: CertPdfData): Content[] {
  const v = ctx.sections.get("header")!;
  const pick = (keys: string[]): string[] =>
    v.order.filter((k) => keys.includes(k) && v.field(k).visible);

  const center: Content[] = [];
  for (const key of pick(["company_name", "title"])) {
    if (key === "company_name") center.push(seedPiece(ctx, key, { text: d.company.name, bold: true, fontSize: 12, alignment: "center" }));
    else center.push(seedPiece(ctx, key, { text: v.field(key).label, bold: true, fontSize: ctx.fonts.headingSize, alignment: "center", margin: [0, 2, 0, 0] }));
  }

  const right: Content[] = [];
  for (const key of pick(["order_no", "print_date", "entry_date"])) {
    if (key === "order_no") right.push(seedPiece(ctx, key, { text: `${v.field(key).label} ${d.orderLabel}`, bold: true, fontSize: 10.5 }));
    else if (key === "print_date") right.push(seedPiece(ctx, key, { text: `${v.field(key).label} ${ctx.date(d.printDate)}`, bold: true, fontSize: 10, margin: [0, 2, 0, 0] }));
    else right.push(seedPiece(ctx, key, { text: `${v.field(key).label} ${ctx.date(d.entryDate)}`, bold: true, fontSize: 10, margin: [0, 2, 0, 0] }));
  }

  // Under the seed the image carries its id (an image is no text node) and an end mark follows it.
  const logoNodes: Content[] | null = ctx.logo === null ? null
    : ctx.seed
      ? [{ image: ctx.logo.dataUri, width: ctx.logo.width, id: CERT_SEED_IDS.piece("logo") } as Content, mark(CERT_SEED_IDS.end("logo"))]
      : [{ image: ctx.logo.dataUri, width: ctx.logo.width }];
  if (logoNodes !== null && ctx.logo!.placement === "header-center") center.unshift(...logoNodes);
  if (logoNodes !== null && ctx.logo!.placement === "header-right") right.unshift(...logoNodes);
  if (center.length + right.length === 0 && !(logoNodes !== null && ctx.logo!.placement === "header-left")) return [];

  const leftColumn: Column = logoNodes !== null && ctx.logo!.placement === "header-left"
    ? { width: ctx.logo!.width, stack: logoNodes }
    : { width: W.headerLeft, text: "" };

  return [{
    columns: [leftColumn, { width: "*", stack: center }, { width: W.headerRight, stack: right }],
    columnGap: W.headerGap,
    margin: [0, 0, 0, CERT_PAGE.headerBottom],
  }];
}

/** The To column's children: the underlined label, R14's attn line (only when the bill-to row
 *  carries a name of its own), the name, the street, and the city, state and zip columns 8 pt lower
 *  (`toCity`, `toState`, `toZip`). `partiesBlock` wraps them in its "*" column; the canvas's To
 *  block prints them through `CERT_FLOW`. */
function toStack(label: string, d: CertPdfData): Content[] {
  return [
    { text: label, bold: true, fontSize: 11, decoration: "underline" },
    ...(d.to.attn ? [{ text: d.to.attn, fontSize: 10, margin: [0, 2, 0, 0] as [number, number, number, number] }] : []),
    { text: d.to.name, fontSize: 10, margin: [0, d.to.attn ? 0 : 2, 0, 0] },
    { text: d.to.street, fontSize: 10 },
    {
      columns: [
        { width: W.toCity, text: d.to.city, fontSize: 10 },
        { width: W.toState, text: d.to.state, fontSize: 10 },
        { width: W.toZip, text: d.to.zip, fontSize: 10 },
      ],
      margin: [0, 8, 0, 0],
    },
  ];
}

/** "To:" (the customer at their billing address) left; PO / Packing List / Material right, then the
 *  full-width rule that closes the parties block (the BOL's inter-block-rule-as-section-glue rule:
 *  it hides and travels with parties). The `to` box is one bound blob (the ticket's party-box
 *  shape); each right field drops its label+value line when hidden. */
function partiesBlock(ctx: CertCtx, d: CertPdfData): Content[] {
  const v = ctx.sections.get("parties")!;
  const f = v.field;
  const cols: Column[] = [];

  // Under the seed the To stack, a one-node section with no margin of its own, is marked inside its
  // column (`seedSection`), so its block's top and bottom are the stack's.
  if (f("to").visible) {
    const children = toStack(f("to").label, d);
    cols.push({ width: "*", stack: ctx.seed ? seedSection(ctx, "to", [{ stack: children }]) : children });
  }

  const rightStack: Content[] = [];
  if (f("po_number").visible) rightStack.push(seedPiece(ctx, "po_number", { text: `${f("po_number").label} ${d.poNumber}`, bold: true, fontSize: 10, margin: [0, 14, 0, 0] }));
  if (f("packing_list_no").visible) rightStack.push(seedPiece(ctx, "packing_list_no", { text: `${f("packing_list_no").label} ${packingListNo(d.packingListNo)}`, bold: true, fontSize: 10, margin: [0, 2, 0, 0] }));
  if (f("material").visible) rightStack.push(seedPiece(ctx, "material", { text: `${f("material").label} ${d.material}`, bold: true, fontSize: 10, margin: [0, 2, 0, 0] }));
  if (rightStack.length > 0) cols.push({ width: W.partiesRight, stack: rightStack });

  if (cols.length === 0) return [];
  return [{ columns: cols, columnGap: W.partiesGap, margin: [0, 0, 0, 4] }, seedPiece(ctx, "parties_rule", rule([0, 2, 0, 4]))];
}

/** Quantity | Part Number / Part Name / Part Description (stacked) | Net weight — one row per part
 *  line with scope-appropriate quantities (§10.3), the ticket's own stacked-cell shape. Columns,
 *  labels and widths are config-driven; hiding a column drops its header cell, width and per-row
 *  cell together. A weight prints with its unit, through `lb`; a row with no weight prints a
 *  blank cell and no unit. */
function partsTable(ctx: CertCtx, d: CertPdfData): Content[] {
  const { num } = ctx;
  const v = ctx.sections.get("parts")!;
  const cols = columnKeys(v, "parts");
  if (cols.length === 0) return [];

  const cellFor = (key: string, p: CertPartRow): TableCell => {
    switch (key) {
      case "part_qty": return { text: p.qty === null ? "" : num(p.qty), alignment: "right" };
      case "part_identity": return { stack: [p.partNumber, p.partName, p.partDescription].filter((t) => t !== "").map((text) => ({ text })) };
      default: return { text: lb(p.pounds === null ? "" : num(p.pounds)), alignment: "right" }; // part_pounds
    }
  };

  return [{
    table: {
      headerRows: 1,
      widths: cols.map((k) => v.field(k).width),
      body: [
        cols.map((k) => head(v.field(k).label)),
        ...d.parts.map((p): TableCell[] => cols.map((k) => cellFor(k, p))),
      ],
    },
    layout: LAYOUT.ruled,
    margin: [0, 0, 0, 10],
  }];
}

/** The §3.21 certification statement — `input.statement`, the block `printCert` binds from the
 *  config's `cert_statement` at the data seam (see the file comment). No fields of its own (the
 *  shipper-liability precedent); the whole section hides when the config hides it. */
function statementBlock(d: CertPdfData): Content[] {
  return [statementNode(d)];
}

/** The statement's one text node, the wording verbatim with its line breaks. */
function statementNode(d: CertPdfData): Content {
  return { text: d.statement, fontSize: 9.5, margin: [0, 2, 0, 8] };
}

/**
 * One requirement: the line naming the specification and scale (the sample's "Were heat treated
 * as per P.O. NONE to HRC:"), then the bare three-across grid of reading values — no min/max, no
 * scale column, no pass/fail, no override marker (§3.21; also see the file comment: none of that
 * is even in this builder's input). The spec line and readings grid are each a config-gated field.
 */
function requirementBlock(v: CertSectionView, r: CertRequirementBlock): Content {
  const parts: Content[] = [];
  if (v.field("spec_line").visible) {
    parts.push({ text: r.scale === "" ? `${r.specification}:` : `${r.specification} to ${r.scale}:`, fontSize: 9.5, margin: [0, 0, 0, 4] });
  }
  if (v.field("readings").visible) {
    parts.push(...chunk3(r.readings).map((row) => ({
      text: row.map(reading).join("   |   "), fontSize: 9.5, margin: [0, 0, 0, 3] as [number, number, number, number],
    })));
  }
  return { stack: parts, margin: [0, 4, 0, 6] };
}

/**
 * The requirement blocks, grouped by frozen line (ruling 27, issue #55): a cert spanning MORE
 * than one part heads each line group with its frozen part identity — without it, two parts
 * sharing an inspection code print indistinguishable grids of readings. A single-part cert emits
 * the bare blocks exactly as before: the owner's §3.21 sample carries no headings, and this
 * deviates from it only where the sample's shape could not answer which part a grid certifies. The
 * grouping is UNCHANGED by the conversion — the `part_heading` field only gates the heading's
 * visibility; the frozen-identity comparison that decides a group boundary is untouched.
 */
function requirementSection(ctx: CertCtx, d: CertPdfData): Content[] {
  const v = ctx.sections.get("requirements")!;
  // Multi-part detection reads the PARTS TABLE, not the requirement rows (!57 review): a cert
  // listing two parts where only one is inspected still needs its one grid attributed. The
  // grouping key is the full frozen identity, never `linePosition` alone — `removeLine` frees
  // positions and a later rider re-uses them (!57 review, P1), so two different parts can share
  // a number; the composite keeps each part's readings under its own heading.
  if (d.parts.length <= 1) return d.requirements.map((r) => requirementBlock(v, r));

  const out: Content[] = [];
  let current: string | null = null;
  for (const r of d.requirements) {
    if (r.lineIdentity !== current) {
      current = r.lineIdentity;
      if (v.field("part_heading").visible) {
        out.push({ text: `${r.partNumber} — ${r.partName}`, bold: true, fontSize: 9.5, margin: [0, 6, 0, 2] });
      }
    }
    out.push(requirementBlock(v, r));
  }
  return out;
}

/** Each part line's serials with their description — the heat/lot field Phase 3 added for exactly
 *  this (§10.3). The sample order carried none, so the shape is the ticket's own serial block,
 *  per part. The label root ("Serial Numbers") is the overridable part; the em-dash glue and part
 *  number stay the builder's. Renders nothing when the field is hidden or no line has serials. */
function serialBlocks(ctx: CertCtx, d: CertPdfData): Content[] {
  const v = ctx.sections.get("serials")!;
  if (!v.field("serials").visible) return [];
  const label = v.field("serials").label;
  return d.serialBlocks.filter((b) => b.serials.length > 0).map((b) => ({
    stack: [
      { text: `${label} — ${b.partNumber}:`, bold: true, fontSize: 9, margin: [0, 0, 0, 2] },
      ...b.serials.map((s) => ({ text: s.description === "" ? s.serial : `${s.serial} — ${s.description}`, fontSize: 9 })),
    ],
    margin: [0, 2, 0, 4] as [number, number, number, number],
  }));
}

/** The cert's PRINTABLE freeform text (spec §7.4's sanctioned half — never internalNotes). Drops
 *  when the field is hidden or the text is empty. */
function freeformBlock(ctx: CertCtx, d: CertPdfData): Content[] {
  const node = freeformNode(ctx, d);
  return node === null ? [] : [node];
}

/** The freeform text's one node; null when the field is hidden or the text is empty. */
function freeformNode(ctx: CertCtx, d: CertPdfData): Content | null {
  const v = ctx.sections.get("freeform")!;
  if (!v.field("freeform").visible || d.freeform === "") return null;
  return { text: d.freeform, fontSize: 9.5, margin: [0, 6, 0, 0] };
}

/**
 * The signature block, bottom right (§3.11): the printing user's signature image above the rule —
 * or their display name TYPED over the rule when no image is on file (visible, blocking nothing,
 * never a fabricated mark) — then the typed name, title (only when one exists — see CertSigner)
 * and company. Each printed piece is a config-gated field, but under the DEFAULT config the emitted
 * node tree is BYTE-IDENTICAL to pre-conversion (untouchable §3.11; pinned in tests/cert-templates):
 * `signature_mark` is the image/typed-name over the rule, `signer_name`/`signer_title`/
 * `signer_company` the lines beneath. The labels are all value-only ("") — a label override has
 * nothing to replace (the BOL's `ship_from` decision).
 */
function signatureBlock(ctx: CertCtx, d: CertPdfData): Content[] {
  const stack = signatureStack(ctx, d, W.signature);
  if (stack.length === 0) return [];
  return [{ columns: [{ width: "*", text: "" }, { width: W.signature, stack }], margin: [0, 24, 0, 0] }];
}

/** The signature column's children: the mark (the image fitted to `signatureFit` ×
 *  `signatureFitHeight`, else the name typed) centred over a rule `width` long, then the name, the
 *  title (only when one exists) and the company; [] when every piece is hidden. `signatureBlock`
 *  calls it with `CERT_WIDTHS.signature`. */
function signatureStack(ctx: CertCtx, d: CertPdfData, width: number): Content[] {
  const v = ctx.sections.get("signature")!;
  const f = v.field;
  const s = d.signer;
  const stack: Content[] = [];
  if (f("signature_mark").visible) {
    stack.push(
      s.signatureDataUri === null
        ? { text: s.name, fontSize: 13, alignment: "center", margin: [0, 0, 0, 2] }
        : { image: s.signatureDataUri, fit: [W.signatureFit, W.signatureFitHeight], alignment: "center", margin: [0, 0, 0, 2] },
      { canvas: [{ type: "line", x1: 0, y1: 0, x2: width, y2: 0, lineWidth: 1 }] },
    );
  }
  if (f("signer_name").visible) stack.push({ text: s.name, fontSize: 10, margin: [4, 3, 0, 0] });
  if (f("signer_title").visible && s.title !== "") stack.push({ text: s.title, fontSize: 10, margin: [4, 1, 0, 0] });
  if (f("signer_company").visible) stack.push({ text: s.company, fontSize: 10, margin: [4, 1, 0, 0] });
  return stack;
}

/** The page footer strip: company address left, phone right — the sample's bottom strip (no Fax;
 *  see the file comment), at the config's `smallSize` role. Returns null when the footer section or
 *  both its fields are hidden. This is a PAGE-MARGIN strip, not a content-flow section: it renders
 *  in the footer slot regardless of its position in the config's section order, and rides the
 *  pageNofM footer's `above` slot when the `pageFooter` knob is on (buildCertDefinition below). */
function footerStrip(ctx: CertCtx, d: CertPdfData): Content | null {
  const v = ctx.sections.get("footer")!;
  if (!v.visible) return null;
  const cols: Column[] = [];
  if (v.field("footer_address").visible) cols.push({ width: "*", text: d.company.address, fontSize: ctx.fonts.smallSize });
  if (v.field("footer_phone").visible) cols.push({ width: W.footerPhone, text: `${v.field("footer_phone").label} ${d.company.phone}`, bold: true, fontSize: ctx.fonts.smallSize, alignment: "right" });
  if (cols.length === 0) return null;
  return { columns: cols, margin: [24, CERT_PAGE.stripInset, 24, 0] };
}

/**
 * The cert's identity band — what a cert overflowing LETTER repeats on its continuation pages. A
 * real cert genuinely overflows: the readings (bounded at 500 per requirement), the parts (order
 * lines are unbounded, min(1) with no max) and the serials (bounded at 10,000) all grow past one
 * page (probed empirically, Task 11: 100 readings → 2 pages). Its identity is `Order No.:
 * <orderLabel>` (§10.3's own header field). Rendered REGARDLESS of the config's visibility flags
 * (the BOL band's identity treatment — identity on paper is locked, not configurable), though the
 * `order_no` label override still carries through. The `[24, 10, 24, 0]` margin aligns the band
 * with the page's 24pt side margins (pdfmake header content spans the full page width).
 */
const CONTINUATION_TOP_MARGIN = 40;
function continuationHeader(ctx: CertCtx, d: CertPdfData): Content {
  const v = ctx.sections.get("header")!;
  return {
    stack: [
      { text: `${v.field("order_no").label} ${d.orderLabel}`, bold: true, fontSize: 11 },
      { text: "(continued)", italics: true, fontSize: ctx.fonts.smallSize },
    ],
    margin: [24, 10, 24, 0],
  };
}

/** One config section key → its renderer. The `footer` section is handled separately (the strip),
 *  so it renders nothing in the content flow. An unknown key renders nothing: the validator refused
 *  it before any config stored it. Under the seed each block section is marked by the wrapper and
 *  margin rule's kind (design 2026-11-10 §5.2): one-node (`seedSection`) or several-node
 *  (`seedSeveral`); with no seed both answer the nodes unchanged. */
function renderSection(key: string, ctx: CertCtx, d: CertPdfData): Content[] {
  switch (key) {
    case "header": return headerBlock(ctx, d);
    case "parties": return partiesBlock(ctx, d);
    case "parts": return seedSection(ctx, key, partsTable(ctx, d));
    case "statement": return seedSection(ctx, key, statementBlock(d));
    case "requirements": return seedSeveral(ctx, key, requirementSection(ctx, d));
    case "serials": return seedSeveral(ctx, key, serialBlocks(ctx, d));
    case "freeform": return seedSection(ctx, key, freeformBlock(ctx, d));
    case "signature": return seedSection(ctx, key, signatureBlock(ctx, d));
    default: return []; // footer (the page-margin strip) and any unknown key
  }
}

// ---------------------------------------------------------------------------------------------
// The built-in default certification template (spec §10.3, P7 spec §5.4). PURE — data and config
// in, JSON out.
// ---------------------------------------------------------------------------------------------

/**
 * `config` is a **backfilled** `TemplateConfig` (what `resolveTemplateForPrint` returns) and
 * DEFAULTS to the contract's own `DEFAULT_CONFIG` — the complete canonical constant the seeded
 * "Standard" template stores — so a config-less call renders exactly today's paper (the
 * golden-compat gate, tests/cert-pdf.test.ts). `logoDataUri` is the traveler's deliberate extra
 * parameter: the logo bytes belong to the resolved template version, not to the cert data.
 *
 * ONE definition — a multi-part cert is ONE sheet group (ruling 27: the per-part requirement
 * headings are §3.21 content WITHIN one document, never separate renders), so `renderPdf` consumes
 * the `RenderableDefinition` directly. The bottom margin is 44 unconditionally (the cert has always
 * carried a per-page company strip, unlike the BOL's 24pt default): the `pageFooter` knob does not
 * change the margin, only where the strip and the page count go.
 *
 * It branches once on `config.layout` (design 2026-11-10 §5.1): a layout prints the canvas
 * (`buildCanvasCertDefinition`, src/server/cert-canvas.ts), handed the flow's own builders
 * (`CERT_FLOW`), one definition in one pass with no `overflowTopMargin`; a null layout is every
 * word above, unchanged.
 *
 * `seedIds` is the canvas seed's layout pass alone (`seedCertLayout`, src/server/cert-canvas-seed.ts):
 * the flow marks the pieces and blocks a canvas item stands for (`CERT_SEED_IDS`) and lays out
 * exactly as it does without them. Every print and preview leaves it off.
 */
export function buildCertDefinition(
  input: CertPdfData,
  config: TemplateConfig = DEFAULT_CONFIG,
  logoDataUri?: string,
  options: { seedIds?: boolean } = {},
): RenderableDefinition {
  // The canvas branch (cert canvas design 2026-11-10 §5.1): a layout prints the canvas, handed the
  // flow's own builders (`CERT_FLOW`), one definition in one pass with no `overflowTopMargin`.
  if (config.layout !== null) return buildCanvasCertDefinition(input, config, config.layout, CERT_FLOW, logoDataUri);
  // The §5.6 belt's OMISSION half: views resolve over `completeSections`, never `config.sections`
  // raw, so a raw config omitting an entry cannot drop it.
  const sectionConfigs = completeSections(CERT_CONTRACT, config.sections);
  const sections = new Map(sectionConfigs.map((sc) => [sc.key, sectionView(sc)] as const));
  const ctx: CertCtx = {
    fonts: config.fonts,
    num: makeNum(config.formats),
    date: makeCertDate(config.formats),
    sections,
    logo: config.logo !== null && logoDataUri !== undefined
      ? { placement: config.logo.placement, width: config.logo.width, dataUri: logoDataUri }
      : null,
    ...(options.seedIds === true ? { seed: true } : {}),
  };

  const content: Content[] = [];
  // Stack order IS the config's section order; hidden sections are omitted (nothing on this
  // contract is locked, so the belt forces none of them back). The footer section never enters the
  // content flow — it is the page-margin strip below.
  for (const sc of sectionConfigs) {
    if (sc.key === "footer") continue;
    if (!sections.get(sc.key)!.visible) continue;
    content.push(...inBoxFlowSection("CERT", sc.key, renderSection(sc.key, ctx, input)));
  }

  const strip = footerStrip(ctx, input);
  return {
    pageSize: "LETTER",
    pageMargins: [24, 24, 24, CERT_PAGE.bottomMargin],
    defaultStyle: { font: config.fonts.family, fontSize: config.fonts.baseSize },
    // No `info.creationDate`, no clock anywhere — the print DATE is data (`printDate`), so the
    // builder itself stays deterministic (the traveler's purity rule).
    //
    // The `pageFooter` knob (spec §6.1) and the static company strip cannot both own pdfmake's one
    // `footer` slot (render.ts refuses two). Knob OFF (default — golden): the strip is a plain
    // static `footer`, exactly today. Knob ON: the strip rides the pageNofM footer's `above` slot,
    // stacked over the page line by render.ts's one callback (the reason `above` exists).
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

/** The flow's own builders, handed to the canvas path (`src/server/cert-canvas.ts`), which imports
 *  only types from this file: it prints each field and block exactly as the flow does, with no
 *  import cycle (the traveler's `CANVAS_FLOW`, the ticket's `TICKET_FLOW`, the bill of lading's
 *  `BOL_FLOW`). */
export type CertFlowBuilders = {
  /** `CERT_WIDTHS`, handed on with the builders so the canvas reads the flow's widths with no value
   *  import from this file. */
  widths: typeof CERT_WIDTHS;
  sectionView: (sc: SectionConfig) => CertSectionView;
  makeNum: (f: FormatsConfig) => (v: number) => string;
  makeCertDate: (f: FormatsConfig) => (iso: string) => string;
  packingListNo: (n: number | null) => string;
  /** The To column's children: the underlined label, R14's attn line, the name, the street, and the
   *  city, state and zip columns 8 pt lower; `partiesBlock` wraps them in its "*" column. */
  toStack: (label: string, d: CertPdfData) => Content[];
  partsTable: (ctx: CertCtx, d: CertPdfData) => Content[];
  statementNode: (d: CertPdfData) => Content;
  requirementSection: (ctx: CertCtx, d: CertPdfData) => Content[];
  serialBlocks: (ctx: CertCtx, d: CertPdfData) => Content[];
  freeformNode: (ctx: CertCtx, d: CertPdfData) => Content | null;
  /** The signature column's children, the mark centred over a rule `width` long; [] when every
   *  piece is hidden. `signatureBlock` calls it with `CERT_WIDTHS.signature`. */
  signatureStack: (ctx: CertCtx, d: CertPdfData, width: number) => Content[];
};

export const CERT_FLOW: CertFlowBuilders = {
  widths: CERT_WIDTHS, sectionView, makeNum, makeCertDate, packingListNo, toStack, partsTable, statementNode,
  requirementSection, serialBlocks, freeformNode, signatureStack,
};

/** A seeded field item's style: the flow's own size, weight and alignment for that key (design
 *  2026-11-10 §5.3), so the item prints its text as the flow prints it; null for a key the seed
 *  places no field for. */
export function certSeedStyle(key: string, fonts: FontsConfig): CanvasTextStyle | null {
  switch (key) {
    case "company_name": return { size: 12, bold: true, align: "center" };
    case "title": return { size: fonts.headingSize, bold: true, align: "center" };
    case "order_no": return { size: 10.5, bold: true, align: "left" };
    case "print_date":
    case "entry_date":
    case "po_number":
    case "packing_list_no":
    case "material": return { size: 10, bold: true, align: "left" };
    case "footer_address": return { size: fonts.smallSize, bold: false, align: "left" };
    case "footer_phone": return { size: fonts.smallSize, bold: true, align: "right" };
    default: return null;
  }
}

/**
 * The canvas item node of the certification, for the template preview's alone layouts
 * (`aloneLayouts`, `pdf/canvas-sheet.ts`): the same node the sheet prints each item with, built from
 * the flow's own builders. Throws on a null layout: only a canvas config has items.
 */
export function certCanvasItemContent(input: CertPdfData, config: TemplateConfig, logoDataUri?: string): ItemContent {
  if (config.layout === null) throw new Error("certCanvasItemContent needs a canvas config.");
  return firstCertItemContent(input, config, config.layout, CERT_FLOW, logoDataUri);
}
