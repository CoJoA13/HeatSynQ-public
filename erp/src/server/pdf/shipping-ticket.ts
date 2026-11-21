/**
 * The shipping ticket — one sheet per order of a shipment (design spec §10.1, owner ruling §3.20:
 * "five orders on a truck print five shipping tickets and one BOL"; there is NO multi-order ticket
 * layout — a multi-order shipment prints one ticket per order). PURE by construction, the
 * traveler.ts contract: `TicketData[]` in, a plain-JSON pdfmake definition out — no I/O, no clock,
 * nothing that would not survive `JSON.parse(JSON.stringify())` (asserted in tests).
 *
 * A CONFIG-CONSUMER since Phase 7 Task 9 (P7 spec §5.4), and the ONE builder serving BOTH ticket
 * docTypes (P7 spec §5.2): `SHIPPER` (single-order shipments) and `MOS_SHIPPER` (multi-order
 * shipments — including the per-order ticket print of one of their orders; the SHIPMENT'S order
 * count decides, so all paper from one shipment styles alike). The two contracts start
 * structurally identical but are free to diverge, so every build names the docType its config was
 * validated against and resolves labels/widths against THAT contract — never a shared one.
 *
 * **THE TWO-DATE-STYLES TRAP (Task 1 review carry, BINDING).** This paper prints TWO date styles
 * against the contract's ONE date knob: the header's `shortDate` ("7/29/2026") and the tear-off's
 * zero-padded `paddedDate` ("Shipped ON: 07/29/2026"). The knob maps to the HEADER slot ONLY;
 * the tear-off keeps `paddedDate` UNCONDITIONALLY — mapping the knob there too would change the
 * tear-off at the golden-compat gate. Do not "unify" them.
 *
 * Layout mirrors the owner's `docs/samples/Shipping Ticket Sample.pdf`, which IS the contract
 * (spec §3.1). Deviations are individually commented; there are no silent ones:
 *  - no "Page 1 of 1" between the address blocks — page numbers are the render runtime's
 *    declarative footer spec now (P7 spec §6.1), per ticket group, behind the config's
 *    `pageFooter` knob (default off — golden).
 *  - the sample's stray "Temper Only" annotation has no field behind it in this model and spec
 *    §10.1 does not list it — not printed (do not invent fields, task brief Step 1).
 *  - each part line's net weight and each container row's tare figures carry their unit, written
 *    by `lb` and `lbEach` of ./printed-weight.ts and never by a label, so it prints under a typed
 *    heading too (owner ruling W15, 2026-10-09). The sample prints bare figures.
 *  - the container table has a Tare column the sample lacks (owner ruling W16, 2026-10-09): a
 *    row's tare total over its tare each.
 *  - the totals print the net weight of this order's part of the shipment, and a Tare row and a
 *    Gross weight row only when that part has a gross: at least one container row, a tare each
 *    on every row, and sums the calculation can work out (weights design §13; owner answer 5 of
 *    2026-10-11, ruling W1). The sample prints one weight. The tear-off strip states the net
 *    weight only (W16). Each of these weights carries its unit too, written by `lb` (W15).
 */
import type { Column, Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { LAYOUT, type RenderableDefinition } from "./render";
import { inBoxFlowSection } from "./flow-tables";
import { mark } from "./canvas-nodes";
import type { ItemContent } from "./canvas-sheet";
import { buildCanvasTicketDefinitions, firstTicketItemContent } from "../shipping-ticket-canvas";
import { LINE_BREAK } from "../../lib/line-break";
import { SHIPPER_CONTRACT, DEFAULT_CONFIG as SHIPPER_DEFAULT_CONFIG } from "../../lib/template-contracts/shipper";
import { MOS_SHIPPER_CONTRACT, DEFAULT_CONFIG as MOS_SHIPPER_DEFAULT_CONFIG } from "../../lib/template-contracts/mos-shipper";
import {
  completeSections,
  type FontsConfig, type FormatsConfig, type LogoPlacement, type SectionConfig,
  type TemplateConfig, type TemplateContract,
} from "../../lib/template-contracts/types";
import { tareTotalCents, weightTotals, type WeightTotals } from "../../lib/net-weight";
import { lb, lbEach } from "./printed-weight";

// ---------------------------------------------------------------------------------------------
// TicketData — the builder's whole input. It began as task-18-brief.md's shape. Since then a
// container row has gained `tareEach` and the sheet has lost `totalWeight`: the builder works
// the weights out itself, from the lines and the container rows. Plain data: no Decimals, no
// Dates, no Prisma rows.
// ---------------------------------------------------------------------------------------------

export type TicketCompany = { name: string; address: string; phone: string; liabilityText: string };
/** `attn` is the bill-to row's name stacked above the customer's in the Sold To box (R14, #671),
 *  "" when the row has none or it repeats the customer's; the Ship To party carries "". */
export type TicketParty = { code: string; attn: string; name: string; street: string; city: string; state: string; zip: string };
export type TicketLine = { qty: number; partNumber: string; partName: string; partDescription: string; pounds: number };
/** `tareEach` is the shipment row's own tare each in pounds, the weight of one empty container.
 *  null when the row has none. */
export type TicketContainer = { typeName: string; count: number; customerContainerId: string; tareEach: number | null };
export type TicketData = {
  company: TicketCompany;
  soldTo: TicketParty;                 // the customer's default BILL_TO
  shipTo: TicketParty;                 // the shipment's ship-to address
  orderLabel: string;                  // "92036-3"
  orderNumber: number;
  shipDate: string;                    // "yyyy-mm-dd"
  poNumber: string;
  packingListNo: number;               // Shipper.shipperNumber
  customerJobNo: string;
  route: string;
  carrierName: string;
  lines: TicketLine[];
  containers: TicketContainer[];
  serials: { serial: string; description: string }[];   // only printOnShipper rows
  shippedComplete: boolean;
  totalQty: number;
};

/** The two ticket docTypes this ONE builder serves (P7 spec §5.2): the shipment's order count
 *  picks which — see printShippingTickets in shippers.ts. */
export type TicketDocType = "SHIPPER" | "MOS_SHIPPER";

const CONTRACTS: Record<TicketDocType, TemplateContract> = {
  SHIPPER: SHIPPER_CONTRACT,
  MOS_SHIPPER: MOS_SHIPPER_CONTRACT,
};
const DEFAULT_CONFIGS: Record<TicketDocType, TemplateConfig> = {
  SHIPPER: SHIPPER_DEFAULT_CONFIG,
  MOS_SHIPPER: MOS_SHIPPER_DEFAULT_CONFIG,
};

// ---------------------------------------------------------------------------------------------
// Formatting. Pure, config-driven (P7 spec §5.4's per-file formatting helpers), locale pinned
// (the traveler's own rule) so output never tracks the server's.
// ---------------------------------------------------------------------------------------------

/** Thousands-separated per the knob, at most 2 decimals, trailing zeros dropped — "4,128", "192". */
function makeNum(formats: FormatsConfig): (value: number) => string {
  const useGrouping = formats.thousandsSeparator !== false;
  return (value) => value.toLocaleString("en-US", { maximumFractionDigits: 2, useGrouping });
}

/** Always 2 decimals — the sample's own totals style ("192.00", "4,128.00"). */
function makeNum2(formats: FormatsConfig): (value: number) => string {
  const useGrouping = formats.thousandsSeparator !== false;
  return (value) => value.toLocaleString("en-US",
    { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping });
}

const MONTHS_FULL = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The header date, driven by the contract's ONE date knob (default "M/D/YYYY" — the sample
 * header's own `shortDate`). Pure string work — parsing to a Date would drag a timezone into a
 * date-only value (src/lib/business-days.ts's whole point). The tear-off NEVER uses this — see
 * `paddedDate` below and the header comment's two-date-styles trap.
 */
function makeHeaderDate(formats: FormatsConfig): (iso: string) => string {
  const format = formats.dateFormat ?? "M/D/YYYY";
  return (iso) => {
    const [y, m, d] = iso.split("-");
    switch (format) {
      case "MM/DD/YYYY": return `${m}/${d}/${y}`;
      case "YYYY-MM-DD": return iso;
      case "MMMM D, YYYY": return `${MONTHS_FULL[Number(m) - 1]} ${Number(d)}, ${y}`;
      case "MMM - DD - YYYY": return `${MONTHS_ABBR[Number(m) - 1]} - ${d} - ${y}`;
      default: return `${Number(m)}/${Number(d)}/${y}`; // "M/D/YYYY"
    }
  };
}

/** "2026-07-29" -> "07/29/2026" — the tear-off's zero-padded "Shipped ON" style, as printed.
 *  UNCONDITIONAL: deliberately NOT wired to the date knob (the two-date-styles trap — the knob
 *  is the header's; changing it must never move the tear-off at the golden gate). */
function paddedDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

/** The packing list number zero-padded to six digits — the sample prints "092826", not "92826".
 *  A formatting rule of the paper itself, not a knob. */
function packingListNo(n: number): string {
  return String(n).padStart(6, "0");
}

const head = (text: string, colSpan?: number): TableCell =>
  ({ text, bold: true, alignment: "center", ...(colSpan ? { colSpan } : {}) });

/** LETTER (612pt) minus the 24pt margins — the width every full-bleed rule below draws to. */
const CONTENT_WIDTH = 564;

const rule = (margin: [number, number, number, number]): Content =>
  ({ canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 1.5 }], margin });

// ---------------------------------------------------------------------------------------------
// The config lens (P7 spec §5.4) — the traveler's `sectionView`, per docType. The builder
// ASSUMES a complete config (`validateConfig`'s §5.3 backfill guarantees every entry exists);
// only the two null-means-contract-default knobs a complete config still carries resolve here.
//
// THE §5.6 BELT, both halves: the flag half (`visible || !hideable` / `visible || !removable`)
// is the traveler's expression verbatim — on THESE contracts nothing is locked ("spec §5.6's
// locks are traveler-only", shipper.ts), so it forces nothing and a config may hide anything;
// the omission half is `completeSections` in `prepareTickets` below, so a raw config that OMITS
// an entry still renders it with the contract's defaults.
// ---------------------------------------------------------------------------------------------

const CONTRACT_SECTIONS: Record<TicketDocType, Map<string, {
  section: TemplateContract["sections"][number];
  fields: Map<string, TemplateContract["sections"][number]["fields"][number]>;
}>> = {
  SHIPPER: new Map(SHIPPER_CONTRACT.sections.map((s) =>
    [s.key, { section: s, fields: new Map(s.fields.map((f) => [f.key, f])) }] as const)),
  MOS_SHIPPER: new Map(MOS_SHIPPER_CONTRACT.sections.map((s) =>
    [s.key, { section: s, fields: new Map(s.fields.map((f) => [f.key, f])) }] as const)),
};

type FieldView = {
  visible: boolean; label: string; width: number | "*";
  /** The stored config holds a label for the field: any string, "" and the built-in wording
   *  included. The editor stores one only when someone types in the label box. */
  typed: boolean;
};
export type SectionView = {
  visible: boolean;
  /** Field keys in config (= display) order; per-field visibility still applies at use. */
  order: string[];
  field: (key: string) => FieldView;
};

function sectionView(docType: TicketDocType, sc: SectionConfig): SectionView {
  const cs = CONTRACT_SECTIONS[docType].get(sc.key);
  // Unknown keys were refused by the validator before any config could be stored; a miss here
  // is a caller bug, not a config state.
  if (cs === undefined) throw new Error(`Unknown ${docType} template section "${sc.key}"`);
  const byKey = new Map(sc.fields.map((f) => [f.key, f]));
  return {
    visible: sc.visible || !cs.section.hideable, // the belt, section half (nothing locked here)
    order: sc.fields.map((f) => f.key),
    field: (key) => {
      const cf = cs.fields.get(key);
      if (cf === undefined) throw new Error(`Unknown ${docType} template field "${sc.key}.${key}"`);
      const fc = byKey.get(key);
      return {
        visible: (fc?.visible ?? true) || !cf.removable, // the belt, field half
        label: fc?.label ?? cf.defaultLabel,
        width: fc?.width ?? cf.column?.defaultWidth ?? "*",
        typed: (fc?.label ?? null) !== null,
      };
    },
  };
}

/** Everything a section renderer needs, threaded once instead of parameter-by-parameter. */
export type Ctx = {
  /** The contract the sections were resolved against: the canvas path's field items read their
   *  default labels from it (`shipping-ticket-canvas.ts`). */
  docType: TicketDocType;
  fonts: FontsConfig;
  num: (value: number) => string;
  num2: (value: number) => string;
  /** The date knob's ONLY consumer — the header's Ship Date slot. */
  headerDate: (iso: string) => string;
  sections: Map<string, SectionView>;
  /** Present only when the resolved version carries logo BYTES and the config PLACES them
   *  (spec §6.3) — either alone renders today's text-only header. */
  logo: { placement: LogoPlacement; width: number; dataUri: string } | null;
  /** The canvas seed's layout pass (`buildShippingTicketDefinitions`' `seedIds`): when true the
   *  builders mark the pieces a canvas item stands for (`TICKET_SEED_IDS`). Absent on every print
   *  and preview, which render exactly the nodes they rendered before. */
  seed?: boolean;
  /** The seed's placeholder (`seedPlaceholders`): a ticket flagging no serial prints one blank
   *  serial line, so the serial list has a position to seed from. Absent on every print. */
  seedPlaceholders?: boolean;
};

/**
 * The ids the ticket's canvas seed reads back from one layout of today's paper (the shipping
 * ticket design of 2026-11-08 §5.3), the shape of the traveler's `SEED_IDS` (`traveler.ts`, whose
 * header states the rule): emitted only under `seedIds`, and never on a TEXT node (pdfmake refuses
 * two text nodes sharing an id in one document and makes a named destination of a text id). A
 * piece's id is on a wrapper stack around it, on a column's or a table cell's stack, or on the
 * logo's image, and its `end` mark follows it inside that wrapper; the `start` and `sectionEnd`
 * marks around each section block are top-level in the sheet's stack. The section keys and the
 * piece keys never meet.
 */
export const TICKET_SEED_IDS = {
  piece: (key: string) => `seed:${key}`,
  end: (key: string) => `seed:end:${key}`,
  start: (section: string) => `seed:start:${section}`,
  sectionEnd: (section: string) => `seed:end:${section}`,
} as const;

type WithId<T> = T & { id: string };

/** A piece wrapped for the seed: its id on a stack around it, and its end mark after it. With no
 *  seed, the piece itself, unchanged. */
function seedPiece(ctx: Ctx, key: string, node: Content): Content {
  if (!ctx.seed) return node;
  return { id: TICKET_SEED_IDS.piece(key), stack: [node, mark(TICKET_SEED_IDS.end(key))] } as WithId<Content>;
}

/** A column holding one text node, wrapped for the seed: its width stays on the column, the text
 *  moves into a stack under the id with the end mark after it. With no seed, the column unchanged. */
function seedColumn(ctx: Ctx, key: string, column: Column): Column {
  if (!ctx.seed) return column;
  const { width, ...text } = column as unknown as Record<string, unknown> & { width: number | "*" };
  return { width, id: TICKET_SEED_IDS.piece(key), stack: [text, mark(TICKET_SEED_IDS.end(key))] } as unknown as Column;
}

/** A table cell's content wrapped for the seed: its `colSpan` stays on the cell, the rest of it
 *  moves into a stack under the id with the end mark after it. With no seed, the cell unchanged. */
function seedCell(ctx: Ctx, key: string, cell: TableCell): TableCell {
  if (!ctx.seed) return cell;
  const { colSpan, ...content } = cell as Record<string, unknown> & { colSpan?: number };
  return {
    id: TICKET_SEED_IDS.piece(key), ...(colSpan === undefined ? {} : { colSpan }),
    stack: [content, mark(TICKET_SEED_IDS.end(key))],
  } as unknown as TableCell;
}

/** This section's visible column-field keys, in config order — what a table renderer turns into
 *  its `widths` and its per-row cells. */
function columnKeys(docType: TicketDocType, v: SectionView, sectionKey: string): string[] {
  const cs = CONTRACT_SECTIONS[docType].get(sectionKey)!;
  return v.order.filter((k) => cs.fields.get(k)?.column !== undefined && v.field(k).visible);
}

// ---------------------------------------------------------------------------------------------
// Blocks, top to bottom in sample order. Each returns Content[] — empty means "nothing left to
// draw" (every configurable piece hidden) and the block drops from the stack.
// ---------------------------------------------------------------------------------------------

/**
 * Header: three structural slots hand-laid on the sample — company/title left, order/date center
 * (170pt), the company address block right (130pt). Config field ORDER applies WITHIN each slot;
 * a field never migrates between columns (the traveler's documented mapping decision). Value-only
 * fields (company name/address/phone — contract defaultLabel "") have no label element, so a
 * label override has nothing to replace; the title's label IS its printed text.
 *
 * A placed logo (spec §6.3) joins the TOP of its slot's stack at its configured width; the stack
 * reflows beneath. No logo → today's text-only header, byte-for-byte.
 */
function headerBlock(ctx: Ctx, d: TicketData): Content[] {
  const v = ctx.sections.get("header")!;
  const pick = (keys: string[]): string[] =>
    v.order.filter((k) => keys.includes(k) && v.field(k).visible);

  const left: Content[] = [];
  for (const key of pick(["company_name", "title"])) {
    if (key === "company_name") left.push(seedPiece(ctx, key, { text: d.company.name, bold: true, fontSize: 11 }));
    else left.push(seedPiece(ctx, key, { text: v.field(key).label, bold: true, fontSize: ctx.fonts.headingSize, margin: [0, 2, 0, 0] }));
  }

  const center: Content[] = [];
  for (const key of pick(["order_no", "ship_date"])) {
    if (key === "order_no") center.push(seedPiece(ctx, key, { text: `${v.field(key).label} ${d.orderLabel}`, bold: true, fontSize: 11 }));
    // The ONE place the date knob lands (the two-date-styles trap, header comment).
    else center.push(seedPiece(ctx, key, { text: `${v.field(key).label} ${ctx.headerDate(d.shipDate)}`, fontSize: 10, margin: [0, 4, 0, 0] }));
  }

  const right: Content[] = [];
  for (const key of pick(["company_address", "company_phone"])) {
    right.push(seedPiece(ctx, key, { text: key === "company_address" ? d.company.address : d.company.phone, fontSize: 7 }));
  }

  if (ctx.logo !== null) {
    // Under the seed the logo's id is on the image and its end mark follows it, so its printed
    // height is read off the layout rather than off the image's own header (the traveler's form).
    const node: Content[] = ctx.seed
      ? [{ image: ctx.logo.dataUri, width: ctx.logo.width, id: TICKET_SEED_IDS.piece("logo") } as Content,
        mark(TICKET_SEED_IDS.end("logo"))]
      : [{ image: ctx.logo.dataUri, width: ctx.logo.width }];
    if (ctx.logo.placement === "header-left") left.unshift(...node);
    else if (ctx.logo.placement === "header-center") center.unshift(...node);
    else right.unshift(...node);
  }
  if (left.length + center.length + right.length === 0) return [];

  return [{
    columns: [
      { width: "*", stack: left },
      { width: 170, stack: center },
      { width: 130, alignment: "right", stack: right },
    ],
    columnGap: 10,
    margin: [0, 0, 0, 12],
  }];
}

/** The inside of one address block: the label (13 pt on the flow, the item's size on a canvas)
 *  with the identifying code in the corner, the stacked name (R14), the name, the street and the
 *  city line, at the flow's own sizes. The cell `partyBox` boxes, and a canvas party box draws in
 *  the item's box (`shipping-ticket-canvas.ts`). */
function partyLines(label: string, party: TicketParty, labelSize = 13): TableCell {
  return {
    stack: [
      {
        columns: [
          { width: "*", text: label, bold: true, fontSize: labelSize },
          { width: 60, text: party.code, alignment: "right", fontSize: 9 },
        ],
      },
      ...(party.attn ? [{ text: party.attn, bold: true, fontSize: 9.5 }] : []),
      { text: party.name, bold: true, fontSize: 9.5 },
      { text: party.street, margin: [0, 1, 0, 0] },
      {
        columns: [
          { width: "*", text: party.city },
          { width: 34, text: party.state },
          { width: 48, text: party.zip },
        ],
        margin: [0, 10, 0, 0],
      },
    ],
    margin: [2, 1, 2, 2],
  };
}

/** One boxed address block — "Sold To:"/"Ship To:" with the identifying code in the corner
 *  (spec §10.1: the customer code for Sold To; blank for Ship To, since a CustomerAddress has no
 *  short code in this system and a cuid is not paper). */
function partyBox(label: string, party: TicketParty): Content {
  return {
    table: { widths: ["*"], body: [[partyLines(label, party)]] },
    layout: LAYOUT.boxed,
  };
}

/** The two boxed address blocks. The two party fields fill the left and right slots in CONFIG
 *  order; a hidden field leaves its slot EMPTY so its sibling holds position (the traveler
 *  footer's hidden-half treatment). Both hidden → the section drops. */
function partiesBlock(ctx: Ctx, d: TicketData): Content[] {
  const v = ctx.sections.get("parties")!;
  const keys = v.order.filter((k) => k === "sold_to" || k === "ship_to");
  if (keys.every((k) => !v.field(k).visible)) return [];

  const slot = (key: string | undefined): Column => {
    if (key === undefined || !v.field(key).visible) return { width: "*", text: "" };
    const party = key === "sold_to" ? d.soldTo : d.shipTo;
    return { width: "*", stack: [seedPiece(ctx, key, partyBox(v.field(key).label, party))] };
  };

  return [{
    columns: [slot(keys[0]), { width: 50, text: "" }, slot(keys[1])],
    columnGap: 0,
    margin: [0, 0, 0, 6],
  }];
}

/** The five-cell field strip: PO / Packing List No / Customer Job No / Route / Carrier — columns
 *  in config order, labels and widths from the view. */
function fieldStrip(ctx: Ctx, docType: TicketDocType, d: TicketData): Content[] {
  const v = ctx.sections.get("field_strip")!;
  const cols = columnKeys(docType, v, "field_strip");
  if (cols.length === 0) return [];

  const cellFor = (key: string): TableCell => {
    switch (key) {
      case "po_number": return { text: d.poNumber };
      case "packing_list_no": return { text: packingListNo(d.packingListNo) };
      case "customer_job_no": return { text: d.customerJobNo };
      case "route": return { text: d.route };
      case "carrier": return { text: d.carrierName };
      default: return { text: "" };
    }
  };

  return [{
    table: {
      headerRows: 1,
      widths: cols.map((k) => v.field(k).width),
      body: [cols.map((k) => head(v.field(k).label)), cols.map(cellFor)],
    },
    layout: LAYOUT.boxed,
    margin: [0, 0, 0, 6],
  }];
}

/** Quantity | Part No. / Part Name / Part Description (stacked, the sample's three lines) |
 *  Net weight, each figure with its unit. Horizontal rules only — the sample's body rows are
 *  ruled, not gridded. */
function linesTable(ctx: Ctx, docType: TicketDocType, d: TicketData): Content[] {
  const { num } = ctx;
  const v = ctx.sections.get("lines")!;
  const cols = columnKeys(docType, v, "lines");
  if (cols.length === 0) return [];

  const cellFor = (key: string, l: TicketLine): TableCell => {
    switch (key) {
      case "line_qty": return { text: num(l.qty), alignment: "right" };
      case "line_part": return {
        stack: [l.partNumber, l.partName, l.partDescription].filter((p) => p !== "").map((text) => ({ text })),
      };
      case "line_pounds": return { text: lb(num(l.pounds)), alignment: "right" };
      default: return { text: "" };
    }
  };

  return [{
    table: {
      headerRows: 1,
      widths: cols.map((k) => v.field(k).width),
      body: [
        cols.map((k) => head(v.field(k).label)),
        ...d.lines.map((l): TableCell[] => cols.map((k) => cellFor(k, l))),
      ],
    },
    layout: LAYOUT.ruled,
    margin: [0, 0, 0, 8],
  }];
}

/** The container table's two side-by-side column groups — the sample folds the container list
 *  into two columns, so the visible columns (config order) print TWICE and their width budget is
 *  half the content width (the contract's 282pt tableBudget).
 *
 *  A row's Tare cell is the traveler's tare cell in shape: the row's tare total, with its tare
 *  each beneath in small grey type. A row with no tare each, and a half with no row, print an
 *  empty cell. A row whose total cannot be worked out prints the small line under an empty first
 *  line. The small line is 6.5 points, a size of this cell's own: the ticket's small role, 5.5
 *  points as built in, sizes its liability print and the continuation band's "(continued)". The
 *  arithmetic is `tareTotalCents` of src/lib/net-weight.ts. */
function containersTable(ctx: Ctx, docType: TicketDocType, d: TicketData): Content[] {
  const { num } = ctx;
  const v = ctx.sections.get("containers")!;
  const cols = columnKeys(docType, v, "containers");
  if (cols.length === 0) return [];

  const half = Math.ceil(d.containers.length / 2);
  const left = d.containers.slice(0, half);
  const right = d.containers.slice(half);
  const rows = Math.max(left.length, 1);

  const group = (c: TicketContainer | undefined): TableCell[] => cols.map((key): TableCell => {
    switch (key) {
      case "container_type": return { text: c?.typeName ?? "" };
      case "container_count": return { text: c === undefined ? "" : num(c.count), alignment: "center" };
      case "container_tare": {
        if (c === undefined || c.tareEach === null) return { text: "" };
        const total = tareTotalCents(c);
        return {
          alignment: "center",
          stack: [
            { text: total === null ? "" : lb(num(total / 100)) },
            { text: lbEach(num(c.tareEach)), fontSize: 6.5, color: "#444444" },
          ],
        };
      }
      case "cust_cont_id": return { text: c?.customerContainerId ?? "" };
      default: return { text: "" };
    }
  });
  const groupWidths = cols.map((k) => v.field(k).width);
  const groupHeads = cols.map((k) => head(v.field(k).label));

  return [{
    table: {
      headerRows: 1,
      widths: [...groupWidths, ...groupWidths],
      body: [
        [...groupHeads, ...groupHeads],
        ...Array.from({ length: rows }, (_, i): TableCell[] => [...group(left[i]), ...group(right[i])]),
      ],
    },
    layout: LAYOUT.ruled,
    margin: [0, 0, 0, 6],
  }];
}

/** Serial numbers where `printOnShipper` (spec §10.1) — a labelled list, description (the
 *  heat/lot field) beside each serial. Renders nothing at all when no serial is flagged. */
function serialsBlock(ctx: Ctx, d: TicketData): Content[] {
  const v = ctx.sections.get("serials")!;
  // The seed's placeholder: one blank line where the ticket flags no serial (Ruling 1).
  const serials = d.serials.length === 0 && ctx.seedPlaceholders ? [{ serial: " ", description: "" }] : d.serials;
  if (serials.length === 0 || !v.field("serials").visible) return [];
  return [{
    stack: [
      { text: v.field("serials").label, bold: true, margin: [0, 0, 0, 2] },
      ...serials.map((s) => ({ text: s.description === "" ? s.serial : `${s.serial} — ${s.description}` })),
    ],
    margin: [0, 0, 0, 6],
  }];
}

/**
 * The standing liability text in the sample's own fine print (the config's `smallSize` role),
 * one paragraph per blank-line-separated block, closed by the sample's heavy rule.
 *
 * The TEXT arrives on `TicketData.company.liabilityText` — deliberately. The print path sources
 * that value from the resolved config's `shipper_liability_text` text block (P7 spec §8: the
 * template owns the standing text now; see printShippingTickets), while the config-less legacy
 * call keeps rendering whatever the data carries — exactly today's paper. Binding the builder to
 * `config.textBlocks` directly would make the default-parameter call print the contract's
 * literal instead of the caller's data, breaking the golden gate; one source per fact, injected
 * at the data seam by the path that owns resolution.
 */
function liabilityBlock(ctx: Ctx, d: TicketData): Content[] {
  const v = ctx.sections.get("liability")!;
  if (!v.visible) return []; // unreachable via prepareTickets' own gate; belt for direct callers
  const paragraphs: Content[] = d.company.liabilityText.split(/\n\s*\n/).map((paragraph) => (
    { text: paragraph, fontSize: ctx.fonts.smallSize, margin: [0, 0, 0, 4] as [number, number, number, number] }));
  return [{
    // Under the seed the paragraphs are one piece (the text block's) and the rule another.
    stack: ctx.seed
      ? [seedPiece(ctx, "shipper_liability_text", { stack: paragraphs }), seedPiece(ctx, "liability_rule", rule([0, 2, 0, 0]))]
      : [...paragraphs, rule([0, 2, 0, 0])],
    margin: [0, 2, 0, 8],
  }];
}

/** A weight of the sheet's totals as it prints: two decimals, then the unit. "" when the
 *  calculation gives no figure, so a sum too large to work out prints nothing and no unit. */
function totalWeightText(ctx: Ctx, cents: number | null): string {
  return cents === null ? "" : lb(ctx.num2(cents / 100));
}

/** "Shipped Complete" (only when every line on this ticket stood complete after this shipment AND
 *  the field is visible), then the totals' rows in config order, right of center as on the sample:
 *  the quantity shipped, the net weight, and the Tare and Gross weight rows. Those two print only
 *  when this order's part of the shipment has a gross, so a ticket never shows a gross made of
 *  some rows (ruling W1) and with no gross it prints the net weight alone (owner answer 5 of
 *  2026-10-11). A hidden row is left out, the net row too: Tare and Gross weight then print
 *  without it.
 *
 *  What prints of the banner and the rows is one `unbreakable` stack, so a page break does not
 *  part a block that fits a page: where it does not fit on the page it would start on, the whole
 *  block starts the next page (the owner's choice at the paper look, 2026-10-12). The stack has
 *  no margin of its own. With the banner and every row left out there is no stack.
 *
 *  pdfmake draws an unbreakable block whole on one page or does not draw it, and a typed label
 *  has no length bound. So where the template holds a typed label for one of the section's fields
 *  (`FieldView.typed`, shown or hidden; "" and the built-in wording count as typed, as for the
 *  tear-off strip), the stack carries the id `ticket-totals`, which the renderer finds it by:
 *  where the block is taller than a page the renderer takes the mark off its copy of the block
 *  (render.ts `prepareTravelerLayout`), and that block flows over the pages. Otherwise it carries
 *  no id, and nothing measures it: it keeps its mark. That is the tear-off's input-bounded
 *  exception applied here (owner ruling R16, #673): under the built-in labels the block is at most
 *  the banner (12 pt) over four rows (12 and 11 pt, set here, not taken from the base size) whose
 *  figures are numbers and "lb", which no page is too short for. Each ticket's measurement was one
 *  more complete render, about a third of a whole-shipment print (2026-11-06). */
function totalsBlock(ctx: Ctx, d: TicketData, totals: WeightTotals): Content[] {
  const { num } = ctx;
  const v = ctx.sections.get("totals")!;
  const banner = v.field("shipped_complete").visible && d.shippedComplete;
  const hasGross = totals.grossCents !== null;

  /** A row's figure, or null for a key that prints no row on this sheet. */
  const figureFor = (key: string): string | null => {
    switch (key) {
      case "total_qty": return num(d.totalQty);
      case "total_weight": return totalWeightText(ctx, totals.netCents);
      case "total_tare": return hasGross ? totalWeightText(ctx, totals.tareCents) : null;
      case "total_gross": return hasGross ? totalWeightText(ctx, totals.grossCents) : null;
      default: return null; // shipped_complete is the banner, never a row
    }
  };
  const rows = v.order.flatMap((key): TableCell[][] => {
    const figure = v.field(key).visible ? figureFor(key) : null;
    return figure === null ? [] : [[
      seedCell(ctx, key, { text: v.field(key).label, bold: true, fontSize: 12, alignment: "right" }),
      { text: figure, fontSize: 11, alignment: "right" },
    ]];
  });

  const out: Content[] = [];
  if (banner) {
    out.push(seedPiece(ctx, "shipped_complete", {
      text: v.field("shipped_complete").label, bold: true, fontSize: 12,
      alignment: "center", margin: [0, 2, 0, 6],
    }));
  }
  if (rows.length > 0) {
    out.push({
      columns: [
        { width: "*", text: "" },
        {
          width: 260,
          table: { widths: ["*", 80], body: rows },
          layout: "noBorders",
        },
      ],
    });
  }
  if (out.length === 0) return [];
  const measure = v.order.some((k) => v.field(k).typed);
  return [{ ...(measure ? { id: "ticket-totals" } : {}), stack: out, unbreakable: true } as Content & { id?: string }];
}

/** The strip's two hand-written rules, printed after their labels. */
const RECEIVED_BY_RULE = "_______________________";
const RECEIVED_DATE_RULE = "_______________";

/**
 * The footer tear-off strip. FLOW-BASED since Task 9 (P7 spec §5.6, ruling 3's guardrail;
 * HANDOFF §7 item 5.3): the strip used to be stamped at `absolutePosition {x: 24, y: 648}` —
 * the one instrument a data-only definition had for the sample's page-bottom placement — and a
 * part table long enough to reach that fixed slot simply ran UNDER it. The strip now follows
 * the content as an `unbreakable` stack behind a fixed gap: long tables and width overrides
 * reflow it (to the next page when it no longer fits) instead of overlapping it, and
 * `unbreakable` keeps the strip whole where the strip fits a page — the flow-safe replacement for
 * what the absolute pin incidentally provided. Accepted deviation from the sample: on a sparse
 * ticket the strip sits below the totals rather than at the page's bottom edge — bottom-pinning
 * would need render-time measurement, exactly the layout coupling plain-JSON definitions exist
 * to avoid (the two-pass precedent in render.ts reserves MARGIN space; it cannot push flowed
 * content down without measuring it).
 *
 * A label has no length bound, and pdfmake draws an unbreakable block whole or not at all. So where
 * the template holds a typed label for one of the strip's fields (`FieldView.typed`, shown or
 * hidden), where the Sold To name holds a line-break character (`LINE_BREAK`), or where the
 * template's base font size is above its type's Standard's (`DEFAULT_CONFIG`, read here and never
 * retyped; the boxed quantity and net weight figures set no font size of their own and take the
 * base size), the stack carries the id `ticket-tear-off`, which the renderer finds it by, measures,
 * and unmarks where it is taller than a page (render.ts `prepareTravelerLayout`). Such a strip flows
 * over the pages (owner ruling, 2026-10-15, #522, amended 2026-10-16 for the Sold To name and for
 * the base size). Otherwise the strip carries no id, and nothing measures it: it keeps its mark. That
 * is the ruled exception to marking no unbreakable block without the renderer's measure, and these
 * inputs bound it: by that ruling and its two amendments, no other input to the strip can make it
 * taller than a page.
 *
 * Bare order number — the sample's tear-off prints "92036", not "92036-3" — the quantity and the
 * net weight again in their boxed pair (the totals' own net text; never tare or gross, ruling
 * W16), the hand-completed Received By / Date rules, then Sold To and Shipped ON.
 * Config mapping (a hand-laid strip, the traveler footer's grouping decision): fields group into
 * the ROWS they anchor — {order no, shipped complete, the totals pair}, {received by, date},
 * {sold to, shipped on}. A group renders when ANY member is visible (a hidden half leaves an
 * empty slot so its sibling holds position), groups sort by their earliest visible member's
 * config position, and a group with nothing visible drops.
 *
 * "Shipped ON" is `paddedDate` UNCONDITIONALLY — the two-date-styles trap (header comment): the
 * date knob is the header's; it must never move this line.
 */
function tearOff(ctx: Ctx, docType: TicketDocType, d: TicketData, totals: WeightTotals): Content[] {
  const { num2 } = ctx;
  const v = ctx.sections.get("tear_off")!;
  const f = v.field;
  /** A shown field's column, wrapped for the seed; a hidden one's slot is printed bare. */
  const seen = (key: string, column: Column): Column => (f(key).visible ? seedColumn(ctx, key, column) : column);

  type Group = { members: string[]; build: () => Content };
  const groups: Group[] = [
    {
      members: ["tear_order_no", "tear_shipped_complete", "tear_total_qty", "tear_total_weight"],
      build: () => {
        const totalRows = v.order
          .filter((k) => (k === "tear_total_qty" || k === "tear_total_weight") && f(k).visible)
          .map((k): TableCell[] => [
            seedCell(ctx, k, { text: f(k).label, bold: true, fontSize: 10.5 }),
            { text: k === "tear_total_qty" ? num2(d.totalQty) : totalWeightText(ctx, totals.netCents), alignment: "right" },
          ]);
        return {
          columns: [
            seen("tear_order_no", {
              width: "*",
              text: f("tear_order_no").visible ? `${f("tear_order_no").label} ${d.orderNumber}` : "",
              bold: true, fontSize: 11,
            }),
            seen("tear_shipped_complete", {
              width: 150,
              text: f("tear_shipped_complete").visible && d.shippedComplete
                ? f("tear_shipped_complete").label : "",
              bold: true, fontSize: 11, alignment: "center",
            }),
            totalRows.length > 0
              ? {
                width: 200,
                table: { widths: ["*", 62], body: totalRows },
                layout: LAYOUT.boxed,
              }
              : { width: 200, text: "" },
          ],
          columnGap: 8,
        };
      },
    },
    {
      members: ["received_by", "received_date"],
      build: () => ({
        columns: [
          seen("received_by", {
            width: 220,
            text: f("received_by").visible ? `${f("received_by").label} ${RECEIVED_BY_RULE}` : "",
            bold: true, fontSize: 9.5,
          }),
          seen("received_date", {
            width: "*",
            text: f("received_date").visible ? `${f("received_date").label} ${RECEIVED_DATE_RULE}` : "",
            bold: true, fontSize: 9.5,
          }),
        ],
        margin: [0, 12, 0, 0],
      }),
    },
    {
      members: ["tear_sold_to", "shipped_on"],
      build: () => ({
        columns: [
          seen("tear_sold_to", {
            width: "*",
            text: f("tear_sold_to").visible ? `${f("tear_sold_to").label} ${d.soldTo.name}` : "",
            bold: true, fontSize: 9.5,
          }),
          seen("shipped_on", {
            // paddedDate, NEVER ctx.headerDate — the two-date-styles trap (see the doc comment).
            width: 180,
            text: f("shipped_on").visible ? `${f("shipped_on").label} ${paddedDate(d.shipDate)}` : "",
            bold: true, fontSize: 9.5, alignment: "right",
          }),
        ],
        margin: [0, 10, 0, 0],
      }),
    },
  ];

  const active = groups
    .map((g) => ({ g, at: Math.min(...g.members.filter((k) => f(k).visible).map((k) => v.order.indexOf(k))) }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => a.at - b.at);
  if (active.length === 0) return [];

  // `v.order` holds every field key of the section: `completeSections` puts back any a stored
  // config omits. The Standard's base size is this type's `DEFAULT_CONFIG`'s, never a typed number:
  // tests/shipping-ticket-templates.test.ts reads this comparison from the source.
  const measure = v.order.some((k) => f(k).typed) || LINE_BREAK.test(d.soldTo.name)
    || ctx.fonts.baseSize > DEFAULT_CONFIGS[docType].fonts.baseSize;
  return [{
    ...(measure ? { id: "ticket-tear-off" } : {}),
    stack: [seedPiece(ctx, "tear_off_rule", rule([0, 0, 0, 6])), ...active.map(({ g }) => g.build())],
    margin: [0, 16, 0, 0],
    unbreakable: true,
  } as Content & { id?: string }];
}

/** One config section key → its renderer. Empty array means "nothing left to draw" — the block
 *  drops from the stack, like a hidden section. An unknown key renders nothing: the validator
 *  refused it before any config stored it. */
function renderSection(key: string, ctx: Ctx, docType: TicketDocType, d: TicketData, totals: WeightTotals): Content[] {
  switch (key) {
    case "header": return headerBlock(ctx, d);
    case "parties": return partiesBlock(ctx, d);
    case "field_strip": return fieldStrip(ctx, docType, d);
    case "lines": return linesTable(ctx, docType, d);
    case "containers": return containersTable(ctx, docType, d);
    case "serials": return serialsBlock(ctx, d);
    case "liability": return liabilityBlock(ctx, d);
    case "totals": return totalsBlock(ctx, d, totals);
    case "tear_off": return tearOff(ctx, docType, d, totals);
    default: return [];
  }
}

/**
 * A section block under the seed: a `start` mark before it and a `sectionEnd` mark at its own
 * bottom, both top-level in the ticket's stack, so both are exact (the traveler's `seedBlock`). A
 * block with a bottom margin moves the margin onto a stack around the block and its end mark,
 * which lays out the same, so the end mark reports the block's bottom and not the margin's.
 */
function seedBlock(section: string, block: Content): Content[] {
  const margin = (block as { margin?: unknown }).margin;
  const end = mark(TICKET_SEED_IDS.sectionEnd(section));
  if (!Array.isArray(margin) || margin.length !== 4 || margin[3] === 0) {
    return [mark(TICKET_SEED_IDS.start(section)), block, end];
  }
  const [left, top, right, bottom] = margin as [number, number, number, number];
  return [
    mark(TICKET_SEED_IDS.start(section)),
    { stack: [{ ...(block as object), margin: [left, top, right, 0] } as Content, end], margin: [0, 0, 0, bottom] },
  ];
}

/** What both builders share: the resolved views and the per-ticket block stack. The §5.6 belt's
 *  OMISSION half lives here — views resolve over `completeSections(contract, config.sections)`,
 *  never `config.sections` raw, so a raw config omitting an entry cannot drop it. */
function prepareTickets(
  docType: TicketDocType, config: TemplateConfig, logoDataUri?: string,
  options: { seedIds?: boolean; seedPlaceholders?: boolean } = {},
): { ctx: Ctx; ticketBlocks: (d: TicketData) => Content[] } {
  const sectionConfigs = completeSections(CONTRACTS[docType], config.sections);
  const sections = new Map(sectionConfigs.map((sc) => [sc.key, sectionView(docType, sc)] as const));
  const seed = options.seedIds === true;
  const ctx: Ctx = {
    docType,
    fonts: config.fonts,
    num: makeNum(config.formats),
    num2: makeNum2(config.formats),
    headerDate: makeHeaderDate(config.formats),
    sections,
    logo: config.logo !== null && logoDataUri !== undefined
      ? { placement: config.logo.placement, width: config.logo.width, dataUri: logoDataUri }
      : null,
    ...(seed ? { seed: true } : {}),
    ...(options.seedPlaceholders === true ? { seedPlaceholders: true } : {}),
  };
  const ticketBlocks = (d: TicketData): Content[] => {
    // Net, tare and gross for this sheet's order, worked out once from its rows on the shipment
    // (src/lib/net-weight.ts). The totals block and the tear-off strip are both handed it.
    const totals = weightTotals({ lineWeights: d.lines.map((l) => l.pounds), containers: d.containers });
    const blocks: Content[] = [];
    // Stack order IS the config's section order; hidden sections are omitted (nothing on these
    // contracts is locked, so the belt forces none of them back).
    for (const sc of sectionConfigs) {
      if (!sections.get(sc.key)!.visible) continue;
      for (const block of renderSection(sc.key, ctx, docType, d, totals)) {
        // A table section's nodes are kept inside the page by the column clamp (#991), marked after
        // the seed's wrappers so a seed lays its flow out as it prints.
        blocks.push(...inBoxFlowSection(docType, sc.key, seed ? seedBlock(sc.key, block) : [block]));
      }
    }
    return blocks;
  };
  return { ctx, ticketBlocks };
}

// ---------------------------------------------------------------------------------------------
// The builders (spec §10.1, P7 spec §5.4). PURE — data and config in, JSON out.
// ---------------------------------------------------------------------------------------------

/**
 * One sheet per `TicketData` — the traveler's per-load mechanic reused for orders (spec §3.20):
 * "print tickets" hands this every order on the shipment; "print this order's ticket" hands it
 * exactly one.
 *
 * `docType` names which contract the config was validated against (this ONE builder serves both
 * ticket types — header comment); `config` is a **backfilled** `TemplateConfig` and DEFAULTS to
 * that docType's own `DEFAULT_CONFIG` — the complete canonical constant the seeded "Standard"
 * template stores — so a config-less call renders exactly today's paper (the golden-compat gate)
 * without re-defaulting any individual key. `logoDataUri` is the traveler's deliberate extra
 * parameter: the logo bytes belong to the resolved template version, not to the shipment data.
 *
 * SINCE TASK 9 this whole-document shape (every ticket in one definition, page breaks between)
 * is the LEGACY view — kept for the pre-Phase-7 suite and as the golden oracle, and deliberately
 * consuming neither `config.pageFooter` nor a continuation band: per-ticket page numbers and
 * identity headers only exist per sheet GROUP (P7 spec §6.1), which one whole document cannot
 * express. The print path uses `buildShippingTicketDefinitions` below; both share
 * `prepareTickets`, so their per-ticket content can never drift (pinned by test).
 */
export function buildShippingTicketDefinition(
  input: TicketData[],
  docType: TicketDocType = "SHIPPER",
  config: TemplateConfig = DEFAULT_CONFIGS[docType],
  logoDataUri?: string,
): TDocumentDefinitions {
  // A canvas prints its tickets as sheet groups, each with its own bands: one whole document
  // cannot hold them, and printing the sections' paper for a canvas template would be silent.
  if (config.layout !== null) {
    throw new Error("A canvas ticket prints per sheet group: use buildShippingTicketDefinitions");
  }
  const { ticketBlocks } = prepareTickets(docType, config, logoDataUri);
  const content: Content[] = input.map((ticket, index) => ({
    // Page break BEFORE every sheet but the first — never a trailing blank page (the traveler's
    // own rule).
    ...(index === 0 ? {} : { pageBreak: "before" as const }),
    stack: ticketBlocks(ticket),
  }));
  return {
    pageSize: "LETTER",
    pageMargins: [24, 24, 24, 24],
    defaultStyle: { font: config.fonts.family, fontSize: config.fonts.baseSize },
    // No `info.creationDate`, no clock anywhere — two prints of the same shipment must not differ
    // for no reason (the traveler's purity rule).
    content,
  };
}

/** The continuation band's margin reserve: one 11pt identity line plus the small "(continued)"
 *  line under a 10pt offset — 40 clears the body (the traveler's CONTINUATION_TOP_MARGIN story,
 *  sized for a text-only band; the ticket repeats no barcode). Only OVERFLOWING tickets pay it
 *  (render.ts's two-pass); a one-page ticket keeps today's 24pt top margin untouched. */
const CONTINUATION_TOP_MARGIN = 40;
/** Bottom margin when a template turns the `pageFooter` knob on: the footer draws in the bottom
 *  margin and needs ≥ ~28pt — 44 is the quote's own value, the house precedent (Task 8's
 *  FOOTER_BOTTOM_MARGIN). The knob defaults OFF, so the default paper keeps its 24pt (golden). */
const FOOTER_BOTTOM_MARGIN = 44;

/**
 * The ticket's identity band — what a ticket overflowing LETTER repeats on its continuation
 * pages: THAT order's label, so a page separated from its ticket still names its work. Rendered
 * REGARDLESS of the config's visibility flags (the traveler band's identity treatment — identity
 * on paper is locked, not configurable), though the order-number label override still carries
 * through. The `[24, 10, 24, 0]` margin aligns the band with the page's 24pt side margins:
 * pdfmake header content spans the full page width (the footer spec's own convention).
 */
function continuationHeader(ctx: Ctx, d: TicketData): Content {
  const v = ctx.sections.get("header")!;
  return {
    stack: [
      { text: `${v.field("order_no").label} ${d.orderLabel}`, bold: true, fontSize: 11 },
      { text: "(continued)", italics: true, fontSize: ctx.fonts.smallSize },
    ],
    margin: [24, 10, 24, 0],
  };
}

/**
 * ONE DEFINITION PER TICKET (P7 spec §6.1) — the print path's builder since Task 9, the
 * traveler's Task 8 shape applied to orders-on-a-shipment. As pure as the singular above (same
 * `prepareTickets`, same per-ticket content — pinned by test), but each ticket becomes its own
 * `RenderableDefinition` for `renderSheetGroups` to merge:
 *
 *  - each definition carries ITS order's `continuationHeaderSpec` (the identity band above), so
 *    a ticket overflowing LETTER repeats the right order label on its continuation pages and a
 *    following ticket's first page can never inherit a stale header — per-GROUP scoping is the
 *    whole mechanism (render.ts's renderSheetGroups comment);
 *  - `overflowTopMargin` makes the band's room a two-pass reserve: a ticket that fits one page
 *    renders with today's exact margins (golden compat), only overflow pays for header space;
 *  - `config.pageFooter` (default OFF — golden) turns on the per-group `pageNofM` footer, whose
 *    numbering restarts with every ticket because each group IS its own document, and widens
 *    the bottom margin to fit it.
 *
 * A config carrying a canvas `layout` takes the canvas path instead (`shipping-ticket-canvas.ts`,
 * the shipping ticket design of 2026-11-08 §5.1), handed the flow's own builders (`TICKET_FLOW`);
 * a null layout is every stored config's and renders exactly what it rendered before.
 *
 * `options` is the canvas seed's: `seedIds` marks the flow's pieces with the `TICKET_SEED_IDS`
 * the seed reads back from one layout, and `seedPlaceholders` prints one blank serial line on a
 * ticket flagging none. A fifth parameter, so the callers passing a logo fourth are untouched;
 * without it the nodes are exactly the print's.
 */
export function buildShippingTicketDefinitions(
  input: TicketData[],
  docType: TicketDocType = "SHIPPER",
  config: TemplateConfig = DEFAULT_CONFIGS[docType],
  logoDataUri?: string,
  options: { seedIds?: boolean; seedPlaceholders?: boolean } = {},
): RenderableDefinition[] {
  if (config.layout !== null) {
    return buildCanvasTicketDefinitions(input, docType, config, config.layout, TICKET_FLOW, logoDataUri);
  }
  const { ctx, ticketBlocks } = prepareTickets(docType, config, logoDataUri, options);
  return input.map((ticket) => ({
    pageSize: "LETTER",
    pageMargins: [24, 24, 24, config.pageFooter ? FOOTER_BOTTOM_MARGIN : 24],
    defaultStyle: { font: config.fonts.family, fontSize: config.fonts.baseSize },
    content: [{ stack: ticketBlocks(ticket) }],
    continuationHeaderSpec: {
      content: continuationHeader(ctx, ticket),
      overflowTopMargin: CONTINUATION_TOP_MARGIN,
    },
    ...(config.pageFooter ? { pageFooterSpec: { kind: "pageNofM" as const } } : {}),
  }));
}

/** The flow's own builders, handed to the canvas path (`shipping-ticket-canvas.ts`), which imports
 *  only types from this file: it prints each table and figure exactly as the flow does, with no
 *  import cycle (the traveler's `CANVAS_FLOW`). */
export type TicketFlowBuilders = {
  sectionView: (docType: TicketDocType, sc: SectionConfig) => SectionView;
  makeNum: (formats: FormatsConfig) => (value: number) => string;
  makeNum2: (formats: FormatsConfig) => (value: number) => string;
  makeHeaderDate: (formats: FormatsConfig) => (iso: string) => string;
  paddedDate: (iso: string) => string;
  partyLines: (label: string, party: TicketParty, labelSize?: number) => TableCell;
  fieldStrip: (ctx: Ctx, docType: TicketDocType, d: TicketData) => Content[];
  linesTable: (ctx: Ctx, docType: TicketDocType, d: TicketData) => Content[];
  containersTable: (ctx: Ctx, docType: TicketDocType, d: TicketData) => Content[];
  serialsBlock: (ctx: Ctx, d: TicketData) => Content[];
  totalsBlock: (ctx: Ctx, d: TicketData, totals: WeightTotals) => Content[];
  totalWeightText: (ctx: Ctx, cents: number | null) => string;
  RECEIVED_BY_RULE: string;
  RECEIVED_DATE_RULE: string;
};

export const TICKET_FLOW: TicketFlowBuilders = {
  sectionView, makeNum, makeNum2, makeHeaderDate, paddedDate, partyLines,
  fieldStrip, linesTable, containersTable, serialsBlock, totalsBlock, totalWeightText,
  RECEIVED_BY_RULE, RECEIVED_DATE_RULE,
};

/**
 * The canvas item node of the shipment's FIRST ticket, for the template preview's alone layouts
 * (`aloneLayouts`, `pdf/canvas-sheet.ts`; Ruling 6 of PR 2a): the closure that ticket's sheet is
 * assembled with, built over the same ctx and the flow's own builders (`TICKET_FLOW`). Only a
 * canvas config has one. It lives here, beside `TICKET_FLOW`, as the traveler's
 * `travelerCanvasItemContent` lives in traveler.ts: the canvas module cannot reach the flow's
 * builders but through a parameter.
 */
export function ticketCanvasItemContent(
  input: TicketData[], docType: TicketDocType, config: TemplateConfig, logoDataUri?: string,
): ItemContent {
  if (config.layout === null) throw new Error("ticketCanvasItemContent needs a canvas config.");
  return firstTicketItemContent(input, docType, config, config.layout, TICKET_FLOW, logoDataUri);
}
