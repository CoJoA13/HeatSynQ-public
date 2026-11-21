/**
 * The traveler — the paper that rides with the work (design spec §10).
 *
 * Three layers, deliberately separated:
 *
 *   collectTravelerData()               reads (order + LOCKED revision + lead part + settings + barcode)
 *   buildTravelerDefinition(d, config)  PURE: TravelerData + a backfilled TemplateConfig in,
 *                                       a plain-JSON pdfmake definition out
 *   renderPdf()                         bytes (src/server/pdf/render.ts — the only pdfmake-aware file)
 *
 * The middle layer is the point. Spec §10 made the traveler template *data, not code*, and Phase
 * 7 (Task 7) cashed that promise in: the builder is now a CONFIG-CONSUMER (P7 spec §5.4) — the
 * seeded "Standard" template's config reproduces the Phase 3 paper exactly (the golden-compat
 * gate, tests/traveler.test.ts unchanged), and every knob a template stores (section/field
 * visibility and order, labels, column widths, fonts, formats, the logo slot) is applied here.
 * "Exactly" and "unchanged" were true of Phase 7: the quantities row's three container cells
 * changed on 2026-10-09 under the weights design (its §9.4), and that test's fixture with them.
 * Under its §13 (the owner's answers of 2026-10-11) every weight on the sheet carries its unit,
 * and the last cell of that row became the order's net, tare and gross under the heading
 * "Order totals". That test's pins moved with each. Under #518 (owner 2026-10-15) the header's
 * left stack ends in the order's PO, and that test's mockup case holds it too.
 * `buildTravelerDefinition` still performs no I/O, reads no clock, and returns nothing that
 * would not survive `JSON.parse(JSON.stringify(...))` — asserted in tests, not merely intended.
 *
 * Layout mirrors the owner's `docs/samples/2025-aht-orderform-mockup.pdf`, which the owner ruled
 * on 2026-08-03 to BE the build target (spec §3.9 amendment). Deviations from it are individually
 * commented below; there are no silent ones.
 */
import type { Column, Content, TDocumentDefinitions, TableCell } from "pdfmake/interfaces";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { isExpiredTransaction, withDbErrors } from "./db-errors";
import { readDetail, trafficSettings } from "./orders";
import { claimOrder } from "./order-locks";
import { normalizeTravelerSelection, type TravelerSelection } from "../lib/traveler-selection";
import { buildTravelerPrintRecord } from "../lib/traveler-print-record";
import { tareTotalCents, weightTotals } from "../lib/net-weight";
import { printExpectationFor } from "./traveler-identity";
import { getRevision } from "./part-process-steps";
import { listPartInspections } from "./part-inspections";
import { listAddresses } from "./customer-addresses";
import { cityLine as cityLineOf, pickDefaultAddress } from "./party-address";
import { getSetting } from "./settings";
import {
  renderSheetGroups, barcodePng, pngDataUri, jpegDataUri, LAYOUT,
  type RenderableDefinition,
} from "./pdf/render";
import { lb, lbEach } from "./pdf/printed-weight";
import { mark } from "./pdf/canvas-nodes";
import { inBoxFlowSection } from "./pdf/flow-tables";
import { storeDocument, listDocumentsForOrder, documentFilename, assertPrintable } from "./documents";
import { resolveTemplateForPrint } from "./template-assignments";
import { buildCanvasTravelerDefinitions, firstSheetItemContent, type FlowBuilders } from "./traveler-canvas";
import type { ItemContent } from "./pdf/canvas-sheet";
import { templatePlacesLogo } from "@/lib/template-contracts/template-logo";
import {
  TRAVELER_CONTRACT, DEFAULT_CONFIG as TRAVELER_DEFAULT_CONFIG,
  TRAVELER_STEP_ROW_CONTENT_MIN, TRAVELER_STEP_BOX_CONTENT,
  normalizeTravelerHandwritingFields,
} from "../lib/template-contracts/traveler";
import {
  CONTENT_WIDTH, completeSections,
  type FontsConfig, type FormatsConfig, type LogoPlacement, type SectionConfig,
  type TemplateConfig,
} from "../lib/template-contracts/types";

// Re-exported unchanged: `src/app/api/orders/[id]/documents/route.ts` and this file's own tests
// depend on `getDocument` living at this import path. Phase 4 Task 3 moved its implementation
// (and the storage it shares with shipping tickets, BOLs and certifications) to documents.ts —
// see the "Stored documents" section below for `listDocuments`, the other half of that surface.
export { getDocument } from "./documents";

// ---------------------------------------------------------------------------------------------
// TravelerData — the builder's whole input. Plain data by construction: no Decimals, no Dates,
// no Prisma rows, nothing that needs a database to interpret.
// ---------------------------------------------------------------------------------------------

export type TravelerLine = {
  qty: number | null; partNumber: string; partName: string; description: string;
  eachWeight: number | null; lineWeight: number | null;
};
/** One order container row as the sheet prints it. `pieces` is the row's total, and `tareEach`
 *  is the weight of one empty container. A scale gross is not carried: nothing prints it. */
export type TravelerContainer = {
  typeName: string; count: number; pieces: number | null; tareEach: number | null;
};
export type TravelerInspection = {
  code: string; scale: string | null; min: number | null; max: number | null;
  sampleQty: string; location: string;
};
export type TravelerStepValue = { label: string; value: string; unit: string | null };
export type TravelerStep = {
  position: number; codeName: string; instruction: string; values: TravelerStepValue[];
};
/** One printed sheet-set: the mockup's header carries a load number, and the load's own numbers
 *  replace the order-wide ones in the quantity row. */
export type TravelerSheet = {
  loadNumber: number | null; loadQty: number | null; loadWeight: number | null;
  /** Code 128: ORDER-LOAD, or the bare order number when no loads exist. */
  barcodeDataUri: string;
};

export type TravelerData = {
  /** True only for the SAMPLE preview (spec 2026-09-26 §5): the part's real details with no
   *  order. `orderNumber` is a meaningless 0, `orderQty` and every line/sheet quantity are
   *  `null`, and every builder prints "SAMPLE" for the order number, the load and
   *  the barcode slot instead of inventing a number. Absent (or false) for every real print. */
  sample?: true;
  orderNumber: number;
  /** Order.poNumber as the order holds it: on a print, read under the print's claim with the rest
   *  of the order (#518, owner 2026-10-15), amending Phase 3 decision 9(a) for this one line.
   *  "" prints the label and a write-in rule. Stored untrimmed: the PO is not trimmed at save,
   *  unlike the phone. */
  poNumber: string;
  customerName: string;
  /** Received-from address lines, already assembled; empty when the customer has none. */
  receivedFrom: string[];
  /** Customer.phone, read live like the name and address (spec §7). "" prints nothing. */
  customerPhone: string;
  company: { name: string; address: string; phone: string };
  lines: TravelerLine[];
  orderQty: number | null;
  // No order weight is carried. The Order totals cell adds the lines' weights up itself, through
  // src/lib/net-weight.ts.
  containers: TravelerContainer[];
  materialName: string;
  /** The lead part's `processName` (Phase 7 ruling 4, P7 spec §5.7): presentation vocabulary the
   *  Process: slot binds LIVE at render — read fresh from the part on every print, never locked
   *  with the revision. Blank ("") prints nothing, exactly the Phase 3 blank-slot ruling. */
  processName: string;
  /** The lead part number: the shop's process identity for this order (spec §3.1/§10). */
  processId: string;
  inspections: TravelerInspection[];
  /** The LOCKED revision — historical, never the part's current working revision. Governs
   *  `steps`; deliberately NOT printed (owner ruling 2026-08-03, see `processRow`), and kept on
   *  the payload because it is what makes `steps` interpretable to any future template. */
  revisionNumber: number | null;
  steps: TravelerStep[];
  sheets: TravelerSheet[];
};

// ---------------------------------------------------------------------------------------------
// Formatting. Pure, config-driven (P7 spec §5.4's per-file formatting helper), and shared by
// every cell so one number never renders two ways.
// ---------------------------------------------------------------------------------------------

/** At most 2 decimals, trailing zeros dropped, thousands grouped per the config's ONE format
 *  knob (the traveler's contract declares only `thousandsSeparator` — it prints no date and no
 *  price). Default true reproduces the mockup's own style ("4,500", "33,750", "13.5"). Locale
 *  pinned so the output never tracks the server's. */
function makeNum(formats: FormatsConfig): (value: number | null | undefined) => string {
  const useGrouping = formats.thousandsSeparator !== false;
  return (value) => value === null || value === undefined
    ? "" : value.toLocaleString("en-US", { maximumFractionDigits: 2, useGrouping });
}

/** `Label: value unit`, the mockup's step-value line ("Furnace Temp: 1650 °F"). An empty value
 *  prints as a handwriting blank instead of a bare label (spec 2026-09-26 §6, slice 2): a
 *  part-owned parameter may carry no value yet, and the traveler still has to give the floor
 *  somewhere to write the reading. */
function valueLine(v: TravelerStepValue): string {
  return `${v.label}: ${v.value === "" ? "________" : v.value}${v.unit ? ` ${v.unit}` : ""}`;
}

/** The write-in rule an order with no PO prints after the label: 23 underscores, the length of
 *  the shipping ticket's Received By blank (shipping-ticket.ts), ruled 2026-10-17 (#518). */
const PO_WRITE_IN = "_".repeat(23);

/** The header's right slot and the gap on either side of the center slot. */
export const HEADER_RIGHT_WIDTH = 190;
export const HEADER_GAP = 10;
/** The left slot's share of the header: the content width less the right slot and both gaps,
 *  halved between the two `*` slots. pdfmake gives both `*` slots this share or, when either
 *  holds a word or an image wider than it, the width of the widest, so the left slot is never
 *  narrower than this. */
export const HEADER_LEFT_WIDTH = (CONTENT_WIDTH - HEADER_RIGHT_WIDTH - 2 * HEADER_GAP) / 2;

// ---------------------------------------------------------------------------------------------
// The config lens (P7 spec §5.4). The builder ASSUMES a complete config — `validateConfig`'s
// §5.3 backfill guarantees every section and field entry exists, so nothing here re-defaults a
// missing entry (re-defaulting would hide a broken caller). What IS resolved here is the two
// null-means-contract-default knobs a complete config still carries: `label: null` → the
// contract's defaultLabel, `width: null` → the contract column's defaultWidth.
//
// THE §5.6 BUILDER-SIDE BELT: a non-hideable section (steps, header) and a non-removable field
// (the typed step fields, the barcode) render REGARDLESS of what the config's visible flags say.
// The validator refuses such configs at save time, but the builder does not trust that alone —
// belt in the builder, no logging, just render them (spec §5.6's defense in depth).
// ---------------------------------------------------------------------------------------------

const CONTRACT_SECTIONS = new Map(TRAVELER_CONTRACT.sections.map((s) =>
  [s.key, { section: s, fields: new Map(s.fields.map((f) => [f.key, f])) }] as const));

type FieldView = { visible: boolean; label: string; width: number | "*" };
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
  if (cs === undefined) throw new Error(`Unknown traveler template section "${sc.key}"`);
  const byKey = new Map(sc.fields.map((f) => [f.key, f]));
  return {
    visible: sc.visible || !cs.section.hideable, // the belt, section half
    order: sc.fields.map((f) => f.key),
    field: (key) => {
      const cf = cs.fields.get(key);
      if (cf === undefined) throw new Error(`Unknown traveler template field "${sc.key}.${key}"`);
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
  d: TravelerData;
  fonts: FontsConfig;
  num: (value: number | null | undefined) => string;
  sections: Map<string, SectionView>;
  /** Present only when the resolved version carries logo BYTES and the config PLACES them
   *  (spec §6.3) — either alone renders today's text-only header. */
  logo: { placement: LogoPlacement; width: number; dataUri: string } | null;
  /** The canvas seed's layout pass (`buildTravelerDefinitions`' `seedIds`): when true the builders
   *  mark the pieces a canvas item stands for (`SEED_IDS`). Absent on every print and preview, which
   *  render exactly the nodes they rendered before. */
  seed?: boolean;
};

/**
 * The ids the canvas seed (`template-canvas-seed.ts`, design 2026-11-07 §5.4, ruling 5) reads back
 * from one layout of today's paper, to place each canvas item where the flow printed its piece.
 * Emitted only under `seedIds`; a print never carries one.
 *
 * pdfmake refuses two TEXT nodes sharing an id in one document and makes a named destination of a
 * text id, so no id goes on a text node: a piece's id is on a wrapper stack around its text (whose
 * position is its first line's top-left), on a table cell's stack, on an image, or on a `mark()`
 * (`pdf/canvas-nodes.ts`, a zero-size fill at fill opacity 0, which paints nothing and takes no
 * height). A text piece's `end` mark, last in its wrapper, reports where its lines end, so its
 * height needs no font arithmetic. The `start` and `end` marks around a section block are
 * top-level in the sheet's stack, so they are exact where a node inside the block may not be (a
 * `dontBreakRows` row, the `unbreakable` results block, both report their block's start).
 */
export const SEED_IDS = {
  piece: (key: string) => `seed:${key}`,
  end: (key: string) => `seed:end:${key}`,
  /** A section block's start; its end is `end(section)`, the block's own bottom above its bottom
   *  margin. The section keys and the header's field keys never meet (only `process` is both, and
   *  a process pair is a cell, which takes no end mark). */
  start: (section: string) => `seed:start:${section}`,
  /** The empty writing row under a footer head (RESULTS, TEMPERED RESULTS): a mark at its content top. */
  body: (key: string) => `seed:body:${key}`,
  /** A footer table's own bottom, inside its column (the RESULTS box and the sign-off grid). */
  tableEnd: (which: "results" | "signoff") => `seed:table:${which}`,
} as const;

type WithId<T> = T & { id: string };

/** A piece wrapped for the seed: its id on a stack around it, and its end mark after it. With no
 *  seed, the piece itself, unchanged. */
function seedPiece(ctx: Ctx, key: string, node: Content): Content {
  if (!ctx.seed) return node;
  return { id: SEED_IDS.piece(key), stack: [node, mark(SEED_IDS.end(key))] } as WithId<Content>;
}

/** A table cell's content wrapped for the seed: its `colSpan` stays on the cell, the rest of it (the
 *  text and its style) moves into a stack under the id. With no seed, the cell unchanged. */
function seedCell(ctx: Ctx, key: string, cell: TableCell): TableCell {
  if (!ctx.seed) return cell;
  const { colSpan, ...content } = cell as Record<string, unknown> & { colSpan?: number };
  return { id: SEED_IDS.piece(key), ...(colSpan === undefined ? {} : { colSpan }), stack: [content] } as unknown as TableCell;
}

/** This section's visible column-field keys, in config order — what a table renderer turns into
 *  its `widths` and its per-row cells. */
function columnKeys(v: SectionView, sectionKey: string): string[] {
  const cs = CONTRACT_SECTIONS.get(sectionKey)!;
  return v.order.filter((k) => cs.fields.get(k)?.column !== undefined && v.field(k).visible);
}

// ---------------------------------------------------------------------------------------------
// buildTravelerDefinition — PURE.
// ---------------------------------------------------------------------------------------------

// Table layouts are referenced BY NAME (src/server/pdf/render.ts registers the drawing code).
// An inline layout object would put callbacks in the definition, and a definition carrying
// functions is not data — see render.ts's LAYOUT comment and the purity test.

const head = (text: string, colSpan?: number): TableCell =>
  ({ text, bold: true, alignment: "center", ...(colSpan ? { colSpan } : {}) });
const cell = (text: string): TableCell => ({ text, alignment: "center" });
/** A drawn square rather than "☐": a glyph would depend on the font actually carrying U+2610. */
const checkbox = (): TableCell => ({
  canvas: [{ type: "rect", x: 0, y: 0, w: 10, h: 10, lineWidth: 0.8 }], margin: [14, 2, 0, 0],
});

/** SAMPLE stands in for the scannable barcode: a sample has no order, and inventing a number is
 *  refused (spec 2026-09-26 §5). Sized to fill the same 186×44 slot the barcode image occupies:
 *  `LAYOUT.boxed` adds padding equal to pdfmake's own default (4pt left/right, 2pt top/bottom) and
 *  two 0.8pt rules on top of a declared width/height, so 176.4×38 renders at (176.4 + 8 + 1.6) ×
 *  (38 + 4 + 1.6) = 186×43.6. */
const samplePlaceholder = (): Content => ({
  table: {
    widths: [176.4], heights: [38],
    body: [[{ text: "SAMPLE", bold: true, fontSize: 14, alignment: "center", margin: [0, 10, 0, 0] }]],
  },
  layout: LAYOUT.boxed, margin: [0, 4, 0, 0],
});

/**
 * Header: three structural slots (left/center/right), hand-laid on the mockup. Config field
 * ORDER applies WITHIN each slot — for the left stack, that governs name and received-from only;
 * the phone that can follow, then the PO, always print LAST in that stack regardless of stored
 * order (see the comments below for why) — the center stack's three fields, and the right
 * block's two number columns. The slots themselves are the builder's layout, not a per-field
 * knob, so a field never migrates between columns (documented mapping decision).
 *
 * The customer line's 9.5pt is the mockup's own size — between the base and heading roles,
 * covered by neither knob, so it stays the builder's literal.
 *
 * A placed logo (spec §6.3) joins the TOP of its slot's stack at its configured width; the
 * stack reflows the slot's text beneath it. No logo → today's text-only header, byte-for-byte.
 */
function headerBlock(ctx: Ctx, sheet: TravelerSheet): Content {
  const { d } = ctx;
  const v = ctx.sections.get("header")!;
  const pick = (keys: string[]): string[] =>
    v.order.filter((k) => keys.includes(k) && v.field(k).visible);

  const left: Content[] = [];
  for (const key of pick(["customer_name", "received_from"])) {
    if (key === "customer_name") left.push(seedPiece(ctx, key, { text: d.customerName, bold: true, fontSize: 9.5 }));
    // Each address line is its own piece under the seed, indexed: two text-free wrappers may not
    // share an id either, as two text nodes may not.
    else left.push(...d.receivedFrom.map((line, i): Content => seedPiece(ctx, `${key}:${i}`, { text: line })));
  }

  // The phone always prints under the customer name and address (spec §7), whatever order a
  // stored template holds: a template saved before this field existed gets it backfilled at its
  // contract index, which can land ahead of a customer block that template moved.
  const phone = v.field("customer_phone");
  if (phone.visible && d.customerPhone !== "") {
    left.push(seedPiece(ctx, "customer_phone", {
      text: [phone.label, d.customerPhone].filter((part) => part !== "").join(" "),
    }));
  }

  // The order's PO, which the mockup does not carry (#518, owner 2026-10-15, amending Phase 3
  // decision 9(a)). It always prints last in the left stack, under the phone, whatever order a
  // stored template holds, for the phone's reason above. An order with no PO prints the label and
  // the write-in rule. The join is the phone's; only a raw config can store an empty label, since
  // the editor turns a cleared label box back into null.
  //
  // The line is the one column of a fixed-width row (the owner's answer of 2026-10-17 on a long
  // PO). pdfmake widens a `*` slot to its widest word, so a long PO with no spaces would push the
  // center and right slots to the right, and the barcode off the paper. A fixed-width column
  // counts as its own width and never its words', so the PO leaves the left slot its share.
  // pdfmake still wraps the line at its spaces, and breaks a word wider than the column at the
  // column's edge, mid-word. The break adds no character: the PO's characters print once each, in
  // order, over several lines. The write-in rule takes the same column (the owner's fifth answer
  // of 2026-10-17, keep as built): at a base size above about 17 points it breaks inside the
  // column too, and Order Number, Load and the barcode stay where they print at any base size.
  const po = v.field("po_number");
  if (po.visible) {
    left.push(seedPiece(ctx, "po_number", {
      columns: [{
        width: HEADER_LEFT_WIDTH,
        text: [po.label, d.poNumber === "" ? PO_WRITE_IN : d.poNumber].filter((part) => part !== "").join(" "),
      }],
    }));
  }

  // Pre-Phase-7 the company block stood in for the missing logo; with §6.3 the logo is ADDITIVE
  // (unshifted below) — a template wanting a logo-ONLY center hides the company fields.
  const center: Content[] = [];
  for (const key of pick(["company_name", "company_address", "company_phone"])) {
    if (key === "company_name") center.push(seedPiece(ctx, key, { text: d.company.name, bold: true, fontSize: ctx.fonts.headingSize }));
    else if (key === "company_address") center.push(seedPiece(ctx, key, { text: d.company.address }));
    else center.push(seedPiece(ctx, key, { text: d.company.phone }));
  }

  const right: Content[] = [];
  const numberCols = pick(["order_number", "load_number"]);
  if (numberCols.length > 0) {
    // Under the seed each number is one piece over two rows: its id on the label's column, its end
    // mark after the value in the value's column (a column is a stack, so the text stays id-free).
    const seedColumn = (column: Column, key: string, part: "label" | "value"): Column => {
      if (!ctx.seed) return column;
      const { width, ...text } = column as unknown as Record<string, unknown> & { width: number | "*" };
      return part === "label"
        ? { width, id: SEED_IDS.piece(key), stack: [text] } as unknown as Column
        : { width, stack: [text, mark(SEED_IDS.end(key))] } as unknown as Column;
    };
    right.push({
      columns: numberCols.map((key): Column => seedColumn(key === "order_number"
        ? { width: "*", text: v.field(key).label, bold: true, alignment: "center" }
        : { width: 44, text: v.field(key).label, bold: true, alignment: "center" }, key, "label")),
    });
    right.push({
      columns: numberCols.map((key): Column => seedColumn(key === "order_number"
        ? { width: "*", text: d.sample ? "SAMPLE" : String(d.orderNumber), alignment: "center" }
        : {
          width: 44,
          text: d.sample ? "SAMPLE" : sheet.loadNumber === null ? "—" : String(sheet.loadNumber),
          alignment: "center",
        }, key, "value")),
    });
  }
  // The barcode renders REGARDLESS of config — the §5.6 belt (BARCODE_LOCK's builder half) — except
  // for the SAMPLE preview, which has no order and therefore no number to encode: printing one
  // would mean inventing an order number, which spec 2026-09-26 §5 refuses.
  right.push(d.sample
    ? samplePlaceholder()
    : {
      image: sheet.barcodeDataUri, width: 186, height: 44, margin: [0, 4, 0, 0],
      ...(ctx.seed ? { id: SEED_IDS.piece("barcode") } : {}),
    } as Content);

  if (ctx.logo !== null) {
    // Under the seed the logo's id is on the image and its end mark follows it, so its printed
    // height is read off the layout rather than off the image's own header.
    const node: Content[] = ctx.seed
      ? [{ image: ctx.logo.dataUri, width: ctx.logo.width, id: SEED_IDS.piece("logo") } as Content, mark(SEED_IDS.end("logo"))]
      : [{ image: ctx.logo.dataUri, width: ctx.logo.width }];
    if (ctx.logo.placement === "header-left") left.unshift(...node);
    else if (ctx.logo.placement === "header-center") center.unshift(...node);
    else right.unshift(...node);
  }

  return {
    columns: [
      { width: "*", stack: left },
      { width: "*", alignment: "center", stack: center },
      { width: HEADER_RIGHT_WIDTH, stack: right },
    ],
    columnGap: HEADER_GAP,
    margin: [0, 0, 0, 8],
  };
}

function linesTable(ctx: Ctx): Content | null {
  const { d, num } = ctx;
  const v = ctx.sections.get("lines")!;
  const cols = columnKeys(v, "lines");
  if (cols.length === 0) return null; // a zero-column table is not a table

  const cellFor = (key: string, l: TravelerLine): TableCell => {
    switch (key) {
      case "line_qty": return cell(num(l.qty));
      // One cell, slash-joined, exactly as the mockup prints it.
      case "line_part": return cell([l.partNumber, l.partName, l.description].filter((p) => p !== "").join(" / "));
      // The mockup prints its weights bare. Each carries its unit here (owner ruling W15,
      // 2026-10-09). A blank figure stays blank: a SAMPLE's line has no net weight.
      case "line_each_weight": return cell(lb(num(l.eachWeight)));
      case "line_weight": return cell(lb(num(l.lineWeight)));
      default: return cell("");
    }
  };

  return {
    table: {
      headerRows: 1,
      widths: cols.map((k) => v.field(k).width),
      body: [
        cols.map((k) => head(v.field(k).label)),
        ...d.lines.map((l): TableCell[] => cols.map((k) => cellFor(k, l))),
      ],
    },
    layout: LAYOUT.ruled,
  };
}

/**
 * Order Quantity · Load Quantity · Containers · Order totals.
 *
 * `Containers` is the number of CONTAINERS (`OrderContainer.count`), the mockup's own meaning:
 * 8 drop pans + 12 bins against a 4,500-piece order. A row's `pieces` is the row's total (the
 * weights design §9.4), not the pieces in one container. It has no column of its own on the
 * mockup, so it rides as a second line inside the Container cell ("252 pcs"). A row that
 * states none prints its type alone.
 *
 * `Tare` prints the row's tare total, which is tare each × containers, with the tare each
 * beneath it in the small type ("127.5 lb" over "42.5 lb each"). A row with no tare each prints
 * nothing there. A row whose total cannot be worked out prints an empty first line over its
 * tare each.
 *
 * `Order totals` is one cell for the whole order, where the mockup prints one gross figure
 * (60,750 + 6,764 = 67,514 there). It holds three lines, "Net", "Tare" and "Gross", each with
 * its figure: the line weights added up, every row's tare total added up, and the two together
 * (the weights design §13, owner answer 4 of 2026-10-11). The three words are this builder's,
 * not template labels. A word always prints. Its figure follows when `weightTotals` gives one,
 * and nothing follows when it gives none: with no container rows, or a row with no tare total,
 * Tare and Gross stand bare, never over a partial sum (owner ruling W1, 2026-10-09, and answer
 * 5 of 2026-10-11). A scale gross is not printed. The figures are the order's on every load's
 * sheet. The load's own weight is the small line under its quantity.
 *
 * The arithmetic is `src/lib/net-weight.ts`'s, in whole cents. Every figure goes through `num`,
 * the sheet's one number format, and every weight then takes its unit from
 * `pdf/printed-weight.ts` (owner ruling W15): no cell has a format of its own, and the mockup
 * prints its weights bare.
 */
function quantityTable(ctx: Ctx, sheet: TravelerSheet): Content | null {
  const { d, num } = ctx;
  const v = ctx.sections.get("quantities")!;
  const cols = columnKeys(v, "quantities");
  if (cols.length === 0) return null;

  const rows = d.containers.length > 0 ? d.containers : [null];
  // The order's net, tare and gross, worked out once for the sheet. Each is null when it cannot
  // be given. Net: a line weight that cannot be read, or a sum past the calculation's ceiling.
  // Tare: no container rows, a row with no tare total, or a sum past the ceiling. Gross: either
  // of those, or the two together past the ceiling. A SAMPLE has one line with no weight and no
  // container rows, so all three are null there.
  const totals = weightTotals({
    lineWeights: d.lines.map((l) => l.lineWeight), containers: d.containers,
  });

  const spanned = (text: string): TableCell => ({ text, alignment: "center", rowSpan: rows.length });
  /** A cell's second line, in the small type. */
  const small = (text: string) => ({ text, fontSize: ctx.fonts.smallSize, color: "#444444" });
  /** One line of the Order totals cell: the word, then its figure with the unit. The word alone
   *  when there is no figure. */
  const totalLine = (word: string, cents: number | null) => ({ text: cents === null ? word : `${word} ${lb(num(cents / 100))}` });
  const totalLines = [totalLine("Net", totals.netCents), totalLine("Tare", totals.tareCents), totalLine("Gross", totals.grossCents)];
  /** One cell for the whole order, spanned over its container rows, in the sheet's ordinary type. */
  const totalsCell: TableCell = { alignment: "center", rowSpan: rows.length, stack: totalLines };

  const cellFor = (key: string, c: TravelerContainer | null, i: number): TableCell => {
    switch (key) {
      case "order_qty": return i === 0 ? spanned(num(d.orderQty)) : {};
      case "load_qty": return i === 0 ? {
        alignment: "center", rowSpan: rows.length,
        stack: [
          { text: sheet.loadQty === null ? "" : num(sheet.loadQty) },
          // The split is weight-capped as often as it is piece-capped (spec §5.4), so the
          // load's own weight rides under its piece count rather than being dropped — the
          // same treatment the Container cell gives the row's pieces.
          ...(sheet.loadWeight === null
            ? [] : [{ text: lb(num(sheet.loadWeight)), fontSize: ctx.fonts.smallSize, color: "#444444" }]),
        ],
      } : {};
      case "container": return c === null ? cell("") : {
        alignment: "center",
        stack: [
          { text: c.typeName },
          ...(c.pieces === null ? [] : [small(`${num(c.pieces)} pcs`)]),
        ],
      };
      case "container_qty": return cell(c === null ? "" : num(c.count));
      case "tare_weight": {
        if (c === null || c.tareEach === null) return cell("");
        const totalCents = tareTotalCents(c);
        return {
          alignment: "center",
          stack: [
            { text: totalCents === null ? "" : lb(num(totalCents / 100)) },
            small(lbEach(num(c.tareEach))),
          ],
        };
      }
      case "gross_weight": return i === 0 ? totalsCell : {};
      default: return cell("");
    }
  };

  return {
    table: {
      headerRows: 1,
      widths: cols.map((k) => v.field(k).width),
      body: [
        cols.map((k) => head(v.field(k).label)),
        ...rows.map((c, i): TableCell[] => cols.map((k) => cellFor(k, c, i))),
      ],
    },
    layout: LAYOUT.ruled,
  };
}

/**
 * Process / Material / Process ID — label/value pairs in one hand-laid table (no per-column
 * width knob; each pair keeps the builder's own label width). Config order and visibility apply
 * per PAIR; a label override replaces the pair's label cell.
 *
 * **The Process: slot binds `d.processName` — Phase 7 ruling 4 (P7 spec §5.7), closing the
 * Phase 3 owner ruling (2026-08-03, spec §3.9 amendment) that deliberately left it BLANK.** The
 * mockup prints a process NAME there ("Austemper") and the Phase 3 data model had no such field;
 * every stand-in (the part name, an assembled step-code name, the locked revision) answered a
 * different question than the label asks, so the slot stayed empty and Phase 7 was ruled its
 * owner. `Part.processName` is that owner's answer: presentation vocabulary, read LIVE from the
 * lead part at render — blank prints nothing, exactly the Phase 3 behavior. The locked revision
 * is still carried on TravelerData (and governs `steps`) — it is still not printed here.
 */
function processRow(ctx: Ctx): Content | null {
  const { d } = ctx;
  const v = ctx.sections.get("process")!;
  const PAIRS: Record<string, { labelWidth: number; value: string }> = {
    process: { labelWidth: 50, value: d.processName },
    material: { labelWidth: 50, value: d.materialName },
    process_id: { labelWidth: 56, value: d.processId },
  };
  const keys = v.order.filter((k) => k in PAIRS && v.field(k).visible);
  if (keys.length === 0) return null;

  return {
    table: {
      widths: keys.flatMap((k): (number | "*")[] => [PAIRS[k].labelWidth, "*"]),
      body: [keys.flatMap((k): TableCell[] => [
        seedCell(ctx, k, { text: v.field(k).label, bold: true, alignment: "center" }), cell(PAIRS[k].value),
      ])],
    },
    layout: LAYOUT.ruled,
  };
}

/**
 * Key Characteristic Inspection(s).
 *
 * Two deviations from the mockup, both forced:
 *  - the first column's header reads "Inspection", not "Hardness". On the mockup that header
 *    cell holds a DATA value (the first inspection's code name), which cannot generalise to an
 *    arbitrary set of inspection codes.
 *  - the mockup's `{Inspection Location.bmp}` slot renders nothing. Owner ruling 2026-08-03
 *    (spec §3.9c): no inspection-location images in Phase 3 — Phase 4/7 owns image handling.
 *    `PartInspection.location`'s TEXT still prints, in the last column.
 */
function inspectionsBlock(ctx: Ctx): Content | null {
  const { d, num } = ctx;
  const v = ctx.sections.get("inspections")!;
  const title = v.field("inspections_title");
  const cols = columnKeys(v, "inspections");
  if (cols.length === 0 && !title.visible) return null;

  const cellFor = (key: string, i: TravelerInspection): TableCell => {
    switch (key) {
      case "inspection_code": return { text: i.code, bold: true };
      case "inspection_scale": return cell(i.scale ?? "");
      case "inspection_min": return cell(num(i.min));
      case "inspection_max": return cell(num(i.max));
      case "inspection_qty": return cell(i.sampleQty);
      case "inspection_location": return cell(i.location);
      default: return cell("");
    }
  };

  const body: TableCell[][] = [
    cols.map((k) => head(v.field(k).label)),
    ...d.inspections.map((i): TableCell[] => cols.map((k) => cellFor(k, i))),
  ];
  if (d.inspections.length === 0) body.push(cols.map(() => cell("")));

  return {
    table: {
      widths: ["*"],
      body: [[{
        stack: [
          ...(title.visible
            ? [seedPiece(ctx, "inspections_title",
              { text: title.label, bold: true, alignment: "center" as const, margin: [0, 0, 0, 3] as [number, number, number, number] })]
            : []),
          ...(cols.length > 0
            ? [{ table: { widths: cols.map((k) => v.field(k).width), body }, layout: "noBorders" }]
            : []),
        ],
      }]],
    },
    layout: LAYOUT.boxed,
    margin: [0, 0, 0, 6],
  };
}

/**
 * PROCESS STEPS — position, code name, instruction + typed values (def order, units included),
 * and small EQ# / OP / Date handwriting boxes at the top of each row, which the floor fills in
 * by hand (there is no shop-floor tracking, by decision — spec §10).
 *
 * LOCKED WHOLE (P7 spec §5.6, the §15 Step-fields ruling): the section and its typed-field
 * columns render regardless of the config's visible flags — `sectionView`'s belt forces them,
 * so only the removable pieces (the title text, the handwriting boxes) actually answer to the
 * config. The typed step VALUES render inside the instruction column unconditionally: they are
 * a locked rendering, not a column of their own.
 *
 * The "PROCESS STEPS:" title cell spans the leading run of content columns (position/code/
 * instruction) — under the default order that is exactly the mockup's colSpan-3 cell; a config
 * that interleaves a handwriting column into that run gets plain empty header cells for the
 * content columns past the title's run instead of a broken span.
 */
const HANDWRITING_COLS = new Set(["step_eq", "step_op", "step_date"]);

/**
 * One small EQ#/OP/Date handwriting box at the top of its cell (owner markup, spec §6). The
 * outer cell draws no table rules, so no row rule or column rule runs through the sign-off area;
 * pdfmake honours per-cell `border` flags for both horizontal and vertical lines.
 *
 * A header box carries its label, keeps no fixed height, keeps the `[0, 2, 0, 2]` margin, and has
 * no side padding (`LAYOUT.signoffLabel`, #358), so it is as wide as its column whatever width a
 * template gives that column. A step box is empty, not square (its width is its
 * column's), and PRINTS `boxHeight` tall AT THE DEFAULT TEMPLATE FONT (owner ruling B, 2026-09-26;
 * see `TRAVELER_STEP_LAYOUT`'s own docstring for why a larger base font grows it): `heights` pins
 * pdfmake's *content* height to the derived `TRAVELER_STEP_BOX_CONTENT`, not `boxHeight` itself —
 * `LAYOUT.signoffBox`'s own top/bottom padding and rule width add on top of whatever content
 * height is declared — and the margin drops to zero so the row around it doesn't add a further two.
 */
const handwritingBox = (label?: string): TableCell => ({
  border: [false, false, false, false],
  table: {
    widths: ["*"],
    ...(label === undefined ? { heights: [TRAVELER_STEP_BOX_CONTENT] } : {}),
    body: [[label === undefined ? { text: "" } : { text: label, bold: true, alignment: "center" }]],
  },
  layout: label === undefined ? LAYOUT.signoffBox : LAYOUT.signoffLabel,
  margin: label === undefined ? [0, 0, 0, 0] : [0, 2, 0, 2],
} as TableCell);

const STEP_CONTENT_COLS = new Set(["step_position", "step_code", "step_instruction"]);
function stepsTable(ctx: Ctx): Content {
  const { d } = ctx;
  const v = ctx.sections.get("steps")!;
  const title = v.field("steps_title");
  const cols = columnKeys(v, "steps");

  const headerCells: TableCell[] = [];
  let i = 0;
  let titleDone = false;
  while (i < cols.length) {
    if (STEP_CONTENT_COLS.has(cols[i])) {
      let run = 1;
      while (i + run < cols.length && STEP_CONTENT_COLS.has(cols[i + run])) run++;
      if (!titleDone) {
        headerCells.push({
          text: title.visible ? title.label : "", bold: true, alignment: "center",
          ...(run > 1 ? { colSpan: run } : {}),
        });
        for (let j = 1; j < run; j++) headerCells.push({});
        titleDone = true;
      } else {
        for (let j = 0; j < run; j++) headerCells.push(head(""));
      }
      i += run;
    } else {
      headerCells.push(HANDWRITING_COLS.has(cols[i])
        ? handwritingBox(v.field(cols[i]).label) : head(v.field(cols[i]).label));
      i++;
    }
  }

  const stepCell = (key: string, s: TravelerStep): TableCell => {
    switch (key) {
      case "step_position": return { text: String(s.position), bold: true };
      case "step_code": return { text: s.codeName, bold: true };
      case "step_instruction": return {
        // Parameters print above the instruction text (owner 2026-09-26, spec §6): settings
        // first, then the operator's text and its handwriting blanks, as on the owner's form.
        stack: [
          ...s.values.map((val) => ({ text: valueLine(val), wordBreak: "break-all" as const })),
          ...(s.instruction === "" ? [] : [{ text: s.instruction, wordBreak: "break-all" as const }]),
        ],
      };
      default: return HANDWRITING_COLS.has(key) ? handwritingBox() : { text: "" };
    }
  };
  const stepRows = d.steps.map((step) => cols.map((key) => stepCell(key, step)));
  const blank: TableCell[] = cols.map((k) => k === "step_instruction"
    ? { text: "The locked revision carries no steps.", italics: true }
    : HANDWRITING_COLS.has(k) ? { text: "", border: [false, false, false, false] } : { text: "" });

  return {
    table: {
      headerRows: 1,
      widths: cols.map((k) => v.field(k).width),
      // Numeric heights are pdfmake CONTENT-height minimums, not printed sizes: a short row still
      // prints at exactly `rowHeight` (owner ruling B) once the derived content minimum below adds
      // its cell padding and rule width back — the boxes give the handwriting room, not this
      // number. Wrapped instructions and deliberate blank lines still grow the row naturally.
      heights: ["auto", ...Array(Math.max(1, stepRows.length)).fill(TRAVELER_STEP_ROW_CONTENT_MIN)],
      // A process step and its three handwriting boxes are one physical traveler row. Moving an
      // intact row to the next page keeps their borders aligned at page boundaries.
      dontBreakRows: true,
      body: [
        headerCells,
        ...(stepRows.length > 0 ? stepRows : [blank]),
      ],
    },
    layout: LAYOUT.steps,
    // Which columns carry the EQ#/OP/Date boxes, by field identity. render.ts's steps layout
    // reads it for padding and rules, because a stored template may order its step columns
    // differently (normalization anchors EQ#/OP/Date after the instruction, not at index 3).
    handwritingColumns: cols.flatMap((key, index) => (HANDWRITING_COLS.has(key) ? [index] : [])),
    margin: [0, 0, 0, 6],
  } as Content;
}

/** The sign-off grid's four columns: a label, its checkbox or the label's second half, twice. The
 *  canvas seed resolves the same widths to place each cell. */
export const FOOTER_SIGNOFF_WIDTHS = ["*", 34, "*", 34] as const;

/**
 * RESULTS / TEMPERED RESULTS / FINAL INSPECTION PASS-FAIL / Tested By / OK to Ship. All
 * handwriting areas — the traveler comes back marked up.
 *
 * Config mapping (a hand-laid signature block, so fields group into the ROWS they anchor):
 * `results` is the left box; the right column's row groups are tempered_results (its header +
 * the 92pt writing row), final_inspection, pass/fail (one shared row), tested_by/tested_date,
 * ok_to_ship/ship_date. A group renders when ANY of its fields is visible (a hidden half leaves
 * an empty spanned cell so its sibling keeps its place), groups order by the EARLIEST config
 * position among their visible fields, and a group with nothing visible drops — heights follow
 * their rows. The left box keeps its hand-tuned 151pt (level with the DEFAULT right column;
 * pdfmake cannot say "match my sibling", so a template hiding right-column rows accepts the
 * mismatch it configured).
 */
function footerBlocks(ctx: Ctx): Content | null {
  const v = ctx.sections.get("footer")!;
  const f = v.field;
  const label = (text: string): TableCell => ({ text, bold: true, colSpan: 2 });
  const labelHalf = (key: string): TableCell[] =>
    f(key).visible ? [seedCell(ctx, key, label(f(key).label)), {}] : [{ text: "", colSpan: 2 }, {}];
  /** An empty writing row's cell; under the seed a mark at its content top instead of the empty
   *  text (the row's fixed minimum height is taller than either). */
  const writingCell = (key: string, colSpan?: number): TableCell => (ctx.seed
    ? { ...(colSpan === undefined ? {} : { colSpan }), stack: [mark(SEED_IDS.body(key))] }
    : { text: "", ...(colSpan === undefined ? {} : { colSpan }) }) as TableCell;

  type Group = { members: string[]; build: () => { rows: TableCell[][]; heights: ("auto" | number)[] } };
  const groups: Group[] = [
    {
      members: ["tempered_results"],
      build: () => ({
        rows: [
          [seedCell(ctx, "tempered_results", head(f("tempered_results").label, 4)), {}, {}, {}],
          [writingCell("tempered_results", 4), {}, {}, {}] as TableCell[],
        ],
        heights: ["auto", 92],
      }),
    },
    {
      members: ["final_inspection"],
      build: () => ({
        rows: [[seedCell(ctx, "final_inspection", head(f("final_inspection").label, 4)), {}, {}, {}]], heights: ["auto"],
      }),
    },
    {
      members: ["pass", "fail"],
      build: () => {
        const order = v.order.filter((k) => (k === "pass" || k === "fail") && f(k).visible);
        const cells: TableCell[] = order.flatMap((k) => [seedCell(ctx, k, head(f(k).label)), checkbox()]);
        while (cells.length < 4) cells.push({ text: "" });
        return { rows: [cells], heights: ["auto"] };
      },
    },
    {
      members: ["tested_by", "tested_date"],
      build: () => ({ rows: [[...labelHalf("tested_by"), ...labelHalf("tested_date")]], heights: ["auto"] }),
    },
    {
      members: ["ok_to_ship", "ship_date"],
      build: () => ({ rows: [[...labelHalf("ok_to_ship"), ...labelHalf("ship_date")]], heights: ["auto"] }),
    },
  ];

  const active = groups
    .map((g) => ({ g, at: Math.min(...g.members.filter((k) => f(k).visible).map((k) => v.order.indexOf(k))) }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => a.at - b.at);
  const rows: TableCell[][] = [];
  const heights: ("auto" | number)[] = [];
  for (const { g } of active) {
    const built = g.build();
    rows.push(...built.rows);
    heights.push(...built.heights);
  }

  // Under the seed each column holds its table and, after it, a mark at the table's own bottom.
  const seedColumn = (column: Column, which: "results" | "signoff"): Column => {
    if (!ctx.seed) return column;
    const { width, ...table } = column as unknown as Record<string, unknown> & { width: "*" };
    return { width, stack: [table, mark(SEED_IDS.tableEnd(which))] } as unknown as Column;
  };
  const columns: Column[] = [];
  if (f("results").visible) {
    columns.push(seedColumn({
      width: "*",
      table: {
        widths: ["*"],
        // Hand-tuned so the RESULTS box ends level with the right column's last row. pdfmake
        // gives no way to say "match my sibling's height", and a mismatch is the one thing that
        // makes this footer look wrong on paper. Re-measure if the right column gains a row.
        heights: ["auto", 151],
        body: [[seedCell(ctx, "results", head(f("results").label))], [writingCell("results")]],
      },
      layout: LAYOUT.boxed,
    }, "results"));
  }
  if (rows.length > 0) {
    columns.push(seedColumn({
      width: "*",
      table: { widths: [...FOOTER_SIGNOFF_WIDTHS], heights, body: rows },
      layout: LAYOUT.boxed,
    }, "signoff"));
  }
  if (columns.length === 0) return null;

  return { id: "traveler-results", columns, columnGap: 0 } as Content & { id: string };
}

/** One config section key → its renderer. `null` from a renderer means "nothing left to draw"
 *  (every configurable piece hidden) — the block is dropped from the stack, like a hidden
 *  section. An unknown key returns null: the validator refused it before any config stored it. */
function renderSection(key: string, ctx: Ctx, sheet: TravelerSheet): Content | null {
  switch (key) {
    case "header": return headerBlock(ctx, sheet);
    case "lines": return linesTable(ctx);
    case "quantities": return quantityTable(ctx, sheet);
    case "process": return processRow(ctx);
    case "inspections": return inspectionsBlock(ctx);
    case "steps": return stepsTable(ctx);
    case "footer": return footerBlocks(ctx);
    default: return null;
  }
}

/** #36's margin reserve: the identity band is 44pt of barcode under a 10pt offset plus its text
 *  lines — 64 gives it clearance over the body. Only OVERFLOWING sheets pay it (the renderer's
 *  two-pass, render.ts); a one-page sheet keeps today's 24pt top margin untouched. */
const CONTINUATION_TOP_MARGIN = 64;
/** Bottom margin when a template turns the `pageFooter` knob on: the footer draws in the bottom
 *  margin and needs ≥ ~28pt (Task 6's note) — 44 is the quote's own value, the house precedent.
 *  The knob defaults OFF, so the default paper keeps its 24pt (golden compat). Exported for the
 *  test that pins the canvas's `PAGE_LINE_ROOM` (`src/lib/template-canvas.ts`) to it. */
export const FOOTER_BOTTOM_MARGIN = 44;

/**
 * #36's identity band — what a sheet overflowing LETTER repeats on its continuation pages: the
 * order number, THAT load's number, and the barcode, so a page torn loose on the floor still
 * names its work. Rendered REGARDLESS of the config's visibility flags (the barcode treatment —
 * identity on shop paper is locked, not configurable), though label overrides still carry
 * through. The band does not repeat the order's PO (#518, owner 2026-10-15). The
 * `[24, 10, 24, 0]` margin aligns the band with the page's 24pt side margins: pdfmake header
 * content spans the full page width (the footer spec's own convention).
 */
function continuationHeader(ctx: Ctx, sheet: TravelerSheet): Content {
  const { d } = ctx;
  const v = ctx.sections.get("header")!;
  return {
    columns: [
      {
        width: "*",
        stack: [
          { text: `${v.field("order_number").label} ${d.sample ? "SAMPLE" : d.orderNumber}`, bold: true },
          // A SAMPLE preview always names its (SAMPLE) load, even though its one sheet's
          // loadNumber is null — the ordinary null-loadNumber case (a real order with no loads)
          // still omits the line entirely.
          ...(d.sample
            ? [{ text: `${v.field("load_number").label} SAMPLE`, bold: true }]
            : sheet.loadNumber === null
              ? [] : [{ text: `${v.field("load_number").label} ${sheet.loadNumber}`, bold: true }]),
          { text: "(continued)", italics: true, fontSize: ctx.fonts.smallSize },
        ],
      },
      // The sheet header's own right-slot shape: a 190pt column, the barcode at 186×44 — or, for
      // the SAMPLE preview, the same-sized placeholder in place of a barcode that has no order to
      // encode (spec 2026-09-26 §5).
      {
        width: 190,
        stack: [d.sample ? samplePlaceholder() : { image: sheet.barcodeDataUri, width: 186, height: 44 }],
      },
    ],
    columnGap: 10,
    margin: [24, 10, 24, 0],
  };
}

/**
 * A section block under the seed: a `start` mark before it and an `end` mark at its own bottom, both
 * top-level in the sheet's stack, so both are exact (design 2026-11-07 §5.4). A block with a bottom
 * margin (the inspections and steps tables) moves the margin onto a stack around the block and its
 * end mark, which lays out the same, so the end mark reports the table's bottom and not the
 * margin's: the canvas carries that gap as the drawn distance to the next table.
 */
function seedBlock(section: string, block: Content): Content[] {
  const margin = (block as { margin?: unknown }).margin;
  const end = mark(SEED_IDS.end(section));
  if (!Array.isArray(margin) || margin.length !== 4 || margin[3] === 0) {
    return [mark(SEED_IDS.start(section)), block, end];
  }
  const [left, top, right, bottom] = margin as [number, number, number, number];
  return [
    mark(SEED_IDS.start(section)),
    { stack: [{ ...(block as object), margin: [left, top, right, 0] } as Content, end], margin: [0, 0, 0, bottom] },
  ];
}

/** What both builders share: the resolved views and the per-sheet block stack. The belt's
 *  OMISSION half (Task 8 pre-step) lives here: views resolve over the config's lists MERGED with
 *  the contract's key list — a config that omits a locked entry (rather than flag-flipping it,
 *  which sectionView's belt already catches) still renders it. See completeSections. */
function prepareSheets(
  input: TravelerData, config: TemplateConfig, logoDataUri?: string, seed = false,
): { ctx: Ctx; sheetBlocks: (sheet: TravelerSheet) => Content[] } {
  const sectionConfigs = completeSections(
    TRAVELER_CONTRACT,
    normalizeTravelerHandwritingFields(config.sections, config.fonts.baseSize),
  );
  const sections = new Map(sectionConfigs.map((sc) => [sc.key, sectionView(sc)] as const));
  const ctx: Ctx = {
    d: input,
    fonts: config.fonts,
    num: makeNum(config.formats),
    sections,
    logo: config.logo !== null && logoDataUri !== undefined
      ? { placement: config.logo.placement, width: config.logo.width, dataUri: logoDataUri }
      : null,
    ...(seed ? { seed: true } : {}),
  };
  const sheetBlocks = (sheet: TravelerSheet): Content[] => {
    const blocks: Content[] = [];
    // Stack order IS the config's section order; hidden sections are omitted — except the
    // §5.6-locked ones, whose views the belt forces visible (see sectionView).
    for (const sc of sectionConfigs) {
      if (!sections.get(sc.key)!.visible) continue;
      const block = renderSection(sc.key, ctx, sheet);
      if (block === null) continue;
      // A table section's nodes are kept inside the page by the column clamp (#991), marked after
      // the seed's wrappers so a seed lays its flow out as it prints.
      blocks.push(...inBoxFlowSection("TRAVELER", sc.key, seed && sc.key !== "header" ? seedBlock(sc.key, block) : [block]));
    }
    return blocks;
  };
  return { ctx, sheetBlocks };
}

/**
 * The traveler builder, a CONFIG-CONSUMER since Phase 7 Task 7 (P7 spec §5.4). PURE — data and
 * config in, JSON out; no I/O, no clock.
 *
 * `config` is a **backfilled** `TemplateConfig` (what `resolveTemplateForPrint` returns — the
 * §5.3 backfill means every section/field entry and every knob is present, so this builder never
 * re-defaults a missing entry). It DEFAULTS to the contract's own `DEFAULT_CONFIG` — the same
 * complete object the seeded "Standard" template stores — so a config-less call renders exactly
 * today's paper: that keeps the pre-Phase-7 test suite calling `buildTravelerDefinition(data)`
 * green UNCHANGED (the golden-compat gate) without re-defaulting any individual key. That was
 * Phase 7's gate. This file's header gives the one account of what has changed on the sheet
 * since, under the weights design and #518, and of that suite's fixture and pins changing with
 * it.
 *
 * `logoDataUri` is a deliberate THIRD parameter, not a TravelerData field: TravelerData is what
 * `readTravelerData` assembles from the ORDER, while the logo bytes belong to the resolved
 * template version — the print path converts them (`pngDataUri`/`jpegDataUri` by the stored
 * `logoMimeType`) and passes them alongside the config they arrived with. It only renders when
 * the config also PLACES a logo (spec §6.3).
 *
 * SINCE TASK 8 this whole-document shape (every sheet in one definition, page breaks between) is
 * the LEGACY view — kept for the pre-Phase-7 suite and any caller wanting one definition, and
 * deliberately consuming neither `config.pageFooter` nor the continuation band: per-group page
 * numbers and #36's identity headers only exist per sheet GROUP, which this single document
 * cannot express. The print path (and Task 19's preview, when it lands) uses
 * `buildTravelerDefinitions` below; both builders share `prepareSheets`, so their per-sheet
 * content can never drift.
 */
export function buildTravelerDefinition(
  input: TravelerData,
  config: TemplateConfig = TRAVELER_DEFAULT_CONFIG,
  logoDataUri?: string,
): TDocumentDefinitions {
  const { sheetBlocks } = prepareSheets(input, config, logoDataUri);
  const content: Content[] = input.sheets.map((sheet, index) => ({
    // Page break BEFORE every sheet but the first — never a trailing blank page.
    ...(index === 0 ? {} : { pageBreak: "before" as const }),
    stack: sheetBlocks(sheet),
  }));
  return {
    pageSize: "LETTER",
    pageMargins: [24, 24, 24, 24],
    defaultStyle: { font: config.fonts.family, fontSize: config.fonts.baseSize },
    // No `info.creationDate`, no header/footer clock: a definition that embedded "now" would make
    // two prints of the same order differ for no reason, and would break this builder's purity.
    content,
  };
}

/** The flow's own builders, handed to the canvas path (`traveler-canvas.ts`), which imports only
 *  types from this file: it prints each table exactly as the flow does, with no import cycle. */
const CANVAS_FLOW: FlowBuilders = {
  sectionView, makeNum, linesTable, quantityTable, inspectionsBlock, stepsTable, checkbox, PO_WRITE_IN,
};

/**
 * The canvas item node of the traveler's first sheet, for the template preview's alone layouts
 * (`aloneLayouts`, `pdf/canvas-sheet.ts`): the closure that sheet's definition is assembled with,
 * built over the same ctx and the flow's own builders (`CANVAS_FLOW`). Only a canvas config has one.
 */
export function travelerCanvasItemContent(
  input: TravelerData, config: TemplateConfig, logoDataUri?: string,
): ItemContent {
  if (config.layout === null) throw new Error("travelerCanvasItemContent needs a canvas config.");
  return firstSheetItemContent(input, config, config.layout, CANVAS_FLOW, logoDataUri);
}

/**
 * #36 — ONE DEFINITION PER LOAD (P7 spec §5.8/§6.1), the print path's builder since Task 8. As
 * pure as the singular above (same `prepareSheets`, same per-sheet content — pinned by test),
 * but each sheet becomes its own `RenderableDefinition` for `renderSheetGroups` to merge:
 *
 *  - each definition carries ITS load's `continuationHeaderSpec` (the identity band above), so a
 *    sheet overflowing LETTER repeats the right order/load/barcode on its continuation pages and
 *    a following load's first page can never inherit a stale header — per-GROUP scoping is the
 *    whole mechanism, not a page-number trick (render.ts's renderSheetGroups comment);
 *  - `overflowTopMargin` makes the band's room a two-pass reserve: a sheet that fits one page
 *    renders with today's exact margins (golden compat), only overflow pays for header space;
 *  - `config.pageFooter` (default OFF — golden) turns on the per-group `pageNofM` footer, whose
 *    numbering restarts with every load because each group IS its own document, and widens the
 *    bottom margin to fit it.
 *
 * A config carrying a canvas `layout` takes the canvas path instead (`traveler-canvas.ts`, design
 * of 2026-11-07 §5.1), handed the flow's own section builders (`CANVAS_FLOW`); a null layout is
 * every stored config's and renders exactly what it rendered before.
 *
 * `options.seedIds` is the canvas seed's (`template-canvas-seed.ts`): the flow's pieces carry the
 * `SEED_IDS` the seed reads back from one layout. It is a fourth parameter so the three callers that
 * pass a logo third are untouched; without it the nodes are exactly the print's.
 */
export function buildTravelerDefinitions(
  input: TravelerData,
  config: TemplateConfig = TRAVELER_DEFAULT_CONFIG,
  logoDataUri?: string,
  options: { seedIds?: boolean } = {},
): RenderableDefinition[] {
  if (config.layout !== null) {
    return buildCanvasTravelerDefinitions(input, config, config.layout, CANVAS_FLOW, logoDataUri);
  }
  const { ctx, sheetBlocks } = prepareSheets(input, config, logoDataUri, options.seedIds === true);
  return input.sheets.map((sheet) => ({
    pageSize: "LETTER",
    pageMargins: [24, 24, 24, config.pageFooter ? FOOTER_BOTTOM_MARGIN : 24],
    defaultStyle: { font: config.fonts.family, fontSize: config.fonts.baseSize },
    content: [{ stack: sheetBlocks(sheet) }],
    continuationHeaderSpec: {
      content: continuationHeader(ctx, sheet),
      overflowTopMargin: CONTINUATION_TOP_MARGIN,
    },
    ...(config.pageFooter ? { pageFooterSpec: { kind: "pageNofM" as const } } : {}),
  }));
}

// ---------------------------------------------------------------------------------------------
// collectTravelerData — the reads.
// ---------------------------------------------------------------------------------------------

/**
 * Every SETTING the traveler needs, read in one place so `readTravelerData` below performs no
 * setting reads of its own (fix-wave R4 finding 8).
 *
 * Production printing reads settings before its write transaction, as before. Read-only draft
 * previews may pass their snapshot transaction so company settings, traffic thresholds, order
 * data and template resolution all observe the same committed state.
 */
export type TravelerSettings = {
  traffic: Awaited<ReturnType<typeof trafficSettings>>;
  company: { name: string; address: string; phone: string };
};

export async function travelerSettings(db?: Prisma.TransactionClient): Promise<TravelerSettings> {
  const [traffic, name, address, phone] = await Promise.all([
    trafficSettings(db),
    getSetting("company_name", db),
    getSetting("company_address", db),
    getSetting("company_phone", db),
  ]);
  return { traffic, company: { name, address, phone } };
}

/**
 * The customer's received-from address (the default site, else the first one on file) and phone
 * — read live, like the customer name (spec §7) — shared by the real print and the SAMPLE preview
 * so both mean the same thing by "customer contact". Extracted from `readTravelerData` (pre-flight
 * C, T5-2) so this helper's shape stays exactly `{ receivedFrom, phone }`, independent of whichever
 * caller also needs the customer's NAME. The printed output is unchanged, but the cost is not: the
 * name is read separately at each call site. `readTravelerData` reads it with a one-field query of
 * its own just before calling this helper, which reads the same customer row again for the phone,
 * so a real print issues one more customer query than before the extraction (both on the caller's
 * `db`; the phone and the address were already separate statements). The SAMPLE preview takes the
 * name from the part's own customer relation instead.
 */
export async function travelerCustomerContact(
  db: Prisma.TransactionClient, customerId: string,
): Promise<{ receivedFrom: string[]; phone: string }> {
  const customer = await db.customer.findFirst({ where: { id: customerId }, select: { phone: true } });
  const addresses = await listAddresses(customerId, undefined, db);

  // The default received-from address, else the first one on file: street and city/state/zip.
  // The phone line comes from Customer.phone (spec §7); the mockup's fax line is deliberately
  // not carried.
  const site = pickDefaultAddress(addresses, "RECEIVED_FROM");
  const cityLine = site ? cityLineOf(site) : "";
  const receivedFrom = site ? [site.street, cityLine].filter((line) => line !== "") : [];

  return { receivedFrom, phone: customer?.phone ?? "" };
}

/** The lead part's key-characteristic inspections, mapped to the traveler's print shape.
 *  Extracted from `readTravelerData` with no behavior change, so the real print and the SAMPLE
 *  preview share one mapping and can never drift apart. */
export async function travelerInspections(
  db: Prisma.TransactionClient, partId: string,
): Promise<TravelerInspection[]> {
  const rows = await listPartInspections(partId, db);
  return rows.map((i) => ({
    code: i.inspectionCodeName, scale: i.scaleName, min: i.min, max: i.max,
    sampleQty: i.sampleQty, location: i.location,
  }));
}

/**
 * #43, OWNER-RULED: the all-loads traveler REFUSES above 100 loads and tells the user to print
 * per load. A constant, deliberately NOT a setting — the number exists to bound one request's
 * memory and the time the order row spends claimed, which is an engineering property of the print
 * path, not a business preference someone should be able to raise to 5,000 from a settings page.
 * (`MAX_LOADS` in src/lib/load-split.ts caps an ORDER at 10,000 loads; this is the far smaller
 * cap on what ONE print may render at once.)
 *
 * Enforced here, at the single point where "every load" is decided, so BOTH the print path and
 * the standalone/preview path (`collectTravelerData`) refuse identically — and, because the read
 * happens before any definition is built, `printTraveler`'s claim can never span an unbounded
 * render: at or under the bound the render is ≤ 100 per-load documents, each one page-bounded by
 * its own sheet. A single-load print (`?load=N`) is never subject to it — that IS the remedy the
 * message names.
 */
const MAX_TRAVELER_LOADS_PER_PRINT = 100;

/**
 * Assembles a print payload for one order (every load) or one load of it, reading EVERYTHING
 * through `db`.
 *
 * Fix-wave R4 finding 8: this used to run against the top-level `prisma` client while
 * `printTraveler`'s transaction held a connection of its own — six reads plus the ~100 ms render,
 * all on a second pooled connection borrowed from inside a transaction. Under concurrent prints
 * that is a pool-starvation shape: each in-flight print holds one connection idle and competes for
 * another, and if the pool empties every holder waits on a connection only another holder can
 * release. Threading `db` also makes the reads mean what the surrounding claim already promised —
 * they now see the same transaction snapshot the claim was taken in, rather than whatever
 * committed between the claim and each individual query.
 *
 * The claim: between the print transaction's open and its commit there is NO query against the
 * top-level client. `readDetail` takes the client (as `getOrder` has always shown), and
 * `listAddresses`/`listPartInspections`/`getRevision` each gained the same trailing `db`
 * parameter; settings moved out of the transaction entirely (`travelerSettings` above). The reads
 * are sequential rather than `Promise.all`'d: on ONE connection they are serialized regardless,
 * and issuing them concurrently is what makes @prisma/adapter-pg's `performIO` overlap calls on a
 * single connection and emit node-postgres' own deprecation warning (tests/helpers/setup.ts
 * documents the same threshold for `readDetail`'s relation loads).
 *
 * Reads the LOCKED revision via `getRevision(leadPartId, lockedRevisionNumber)` — never the
 * part's current working revision. That is the whole point of locking at save (spec §5.3): a
 * traveler reprinted after the recipe changed must still say what the shop actually ran.
 *
 * Line parts are read here in ONE query rather than through `getPart` per line: the traveler
 * needs the same three fields (description, each-weight, material) for every line, and `getPart`
 * both fires a second per-part revision query and 404s a part an order may legitimately still
 * reference. Inspections still come from the parts service (`listPartInspections`).
 */
export async function readTravelerData(
  db: Prisma.TransactionClient, orderId: string, settings: TravelerSettings,
  selectionInput?: number | TravelerSelection, savedOrder?: Awaited<ReturnType<typeof readDetail>>,
  options: { readRevision?: boolean } = {},
): Promise<TravelerData> {
  const selection = normalizeTravelerSelection(typeof selectionInput === "number"
    ? { mode: "loads", loadNumbers: [selectionInput] } : selectionInput ?? { mode: "all" });
  const order = savedOrder ?? await readDetail(db, orderId, settings.traffic); // 404s a missing order
  const lead = order.lines[0];
  if (!lead) throw new HttpError(400, "This order has no part lines to print");

  const parts = await db.part.findMany({
    // Deliberately unfiltered on deletedAt: the order references these parts and the paper
    // has to name them, whatever has happened to the catalog since.
    where: { id: { in: order.lines.map((l) => l.partId) } },
    select: { id: true, partNumber: true, name: true, description: true, eachWeight: true,
      processName: true, material: { select: { name: true } } },
  });
  // The customer's name is read here, directly, because this call site already has the order's
  // customerId in hand for other purposes; the shared `travelerCustomerContact` below covers only
  // the address/phone half so its shape stays identical for the SAMPLE preview (pre-flight C, T5-2).
  const customer = await db.customer.findFirst({ where: { id: order.customerId }, select: { name: true } });
  const contact = await travelerCustomerContact(db, order.customerId);
  const inspectionRows = await travelerInspections(db, lead.partId);
  // `readRevision: false` is the Process steps draft preview's alone (#660): it prints the draft's
  // own steps and revision number, so the locked revision read here would be thrown away. Every
  // print path reads it.
  const revision = lead.revisionNumber === null || options.readRevision === false
    ? null : await getRevision(lead.partId, lead.revisionNumber, db);
  const { name: companyName, address: companyAddress, phone: companyPhone } = settings.company;

  const partById = new Map(parts.map((p) => [p.id, p]));
  const leadPart = partById.get(lead.partId);

  const allSheets: Omit<TravelerSheet, "barcodeDataUri">[] = order.loads.map((l) => (
    { loadNumber: l.loadNumber, loadQty: l.qty, loadWeight: l.weight }));
  let sheets = allSheets;
  if (selection.mode === "loads") {
    for (const number of selection.loadNumbers) {
      if (!allSheets.some(sheet => sheet.loadNumber === number))
        throw new HttpError(404, `This order has no load ${number}`);
    }
    sheets = selection.loadNumbers.map(number => allSheets.find(sheet => sheet.loadNumber === number)!);
  } else if (allSheets.length > MAX_TRAVELER_LOADS_PER_PRINT) {
    // #43 (see MAX_TRAVELER_LOADS_PER_PRINT above) — refuse before anything is rendered.
    throw new HttpError(400,
      `This order has ${allSheets.length} loads — more than the ` +
      `${MAX_TRAVELER_LOADS_PER_PRINT} an all-loads traveler prints at once. ` +
      `Print the loads one at a time.`);
  }
  // An order with no loads at all still prints one sheet — the paper is what the shop works
  // from, and refusing to print it would be a worse answer than a blank Load box.
  if (sheets.length === 0) sheets = [{ loadNumber: null, loadQty: null, loadWeight: null }];

  // Generate only the requested sheets after validation, one at a time. Both headers use the
  // same per-sheet image, and a large all-loads print does not fan out PNG encoding work.
  const encodedSheets: TravelerSheet[] = [];
  for (const sheet of sheets) {
    const payload = sheet.loadNumber === null
      ? String(order.orderNumber) : `${order.orderNumber}-${sheet.loadNumber}`;
    encodedSheets.push({ ...sheet, barcodeDataUri: pngDataUri(await barcodePng(payload)) });
  }

  return {
    orderNumber: order.orderNumber,
    poNumber: order.poNumber,
    customerName: customer?.name ?? "",
    receivedFrom: contact.receivedFrom,
    customerPhone: contact.phone,
    company: { name: companyName, address: companyAddress, phone: companyPhone },
    lines: order.lines.map((l) => {
      const part = partById.get(l.partId);
      return {
        qty: l.qty,
        partNumber: part?.partNumber ?? l.part.partNumber,
        partName: part?.name ?? l.part.name,
        description: part?.description ?? "",
        eachWeight: part ? part.eachWeight.toNumber() : null,
        lineWeight: l.weight,
      };
    }),
    orderQty: order.lines.reduce((sum, l) => sum + l.qty, 0),
    containers: order.containers.map((c) => ({
      typeName: c.type.name, count: c.count, pieces: c.pieces, tareEach: c.tareEach,
    })),
    materialName: leadPart?.material?.name ?? "",
    // LIVE, not locked (ruling 4, P7 spec §5.7): the slot always says what the part says TODAY —
    // presentation vocabulary, deliberately outside the locked revision's freeze.
    processName: leadPart?.processName ?? "",
    processId: leadPart?.partNumber ?? lead.part.partNumber,
    inspections: inspectionRows,
    revisionNumber: revision?.revisionNumber ?? null,
    steps: (revision?.steps ?? []).map((s) => ({
      position: s.position, codeName: s.codeName, instruction: s.instruction,
      values: s.parameters.map((p) => ({ label: p.label, value: p.value, unit: p.unit })),
    })),
    sheets: encodedSheets,
  };
}

/**
 * The standalone entry point: same payload, read outside any transaction — the `getOrder` /
 * `readDetail` split in orders.ts, applied here for the same reason. Used by the traveler
 * PREVIEW path and by tests; `printTraveler` calls `readTravelerData` on its own `tx` instead.
 */
export async function collectTravelerData(orderId: string, loadNumber?: number): Promise<TravelerData> {
  return readTravelerData(prisma, orderId, await travelerSettings(), loadNumber);
}

// ---------------------------------------------------------------------------------------------
// Stored documents. Permanent, create-only (spec §4) — there is no delete path at all. The
// storage itself (this section used to own it directly) now lives in documents.ts, shared with
// the shipping ticket, BOL and certification kinds Phase 4 adds; `printTraveler` below and
// `listDocuments`/`getDocument` further down are this file's thin, order-scoped remainder of it.
// ---------------------------------------------------------------------------------------------

// #305: the 100-load print has taken 6,379 ms under load, beyond Prisma's 5s default.
// On 2026-09-08 its full boundary test took 2,438/2,385/2,376 ms on an idle Node 26
// host with PostgreSQL 18; the faster baseline must not erase the slower observed case.
// #521: on 2026-10-12, with both runner slots paused, 100 one-page sheets took about 11.4 s.
// Re-measured on 2026-10-17 at c6fff38, on the laptop (Core Ultra X7 358H) on mains, power
// profile Performance with turbo, both runner slots paused: 100 one-page sheets printed in
// 4,789/4,926/4,996 ms, and 100 two-page sheets found the transaction expired at the first
// query after the render, 21,840/21,445/21,746 ms after it began.
// The owner kept 15 s (2026-10-17); a print whose claim expires when its budget runs out is
// refused below and stores nothing.
// #611 (2026-11-06, the same laptop and setup, tests/print-claim-timing.test.ts, three runs each):
// one print now measures its steps table and results block once, not once a load (render.ts,
// `prepareTravelerLayout`'s memo). 100 one-page sheets settled in 4,655/4,716/4,778 ms before and
// 2,400/2,433/2,528 ms after; 100 two-page sheets were refused at 21,329/21,509/21,496 ms before
// and stored at 14,658/14,586/14,741 ms after, inside the budget by under half a second on this
// machine, so the 100-load refusal and its remedy stay as they are.
// Keep this budget local: the 100-load bound and the claim through archive still apply,
// and every other transaction but the shipping ticket print (SHIPPING_TICKET_PRINT_TIMEOUT_MS,
// shippers.ts, #556) retains its default timeout.
const TRAVELER_PRINT_TIMEOUT_MS = 15_000;

/**
 * Renders and archives one traveler, returning the exact bytes stored.
 *
 * Voided orders refuse a NEW print (spec §5c) but keep every earlier print listable and
 * reprintable — `listDocuments`/`getDocument` deliberately do not filter on `deletedAt`
 * (documents.ts's own doc comment).
 *
 * A print whose claim expires, its 15-second budget spent before its last statement or its commit,
 * is refused with a 400 and stores and audits nothing (#521, owner ruling 2026-10-17;
 * `TRAVELER_PRINT_TIMEOUT_MS`; the catch in `printSelectedTraveler` states the one case that stays
 * a 500).
 *
 * Fix-wave R3 finding 1: the ENTIRE operation — claim, content read, render, archive — now runs
 * inside ONE transaction, claimed with the shared `claimOrder` (order-locks.ts) before anything
 * else happens. Before this, the claim only wrapped the final archive commit (fix-wave R2 finding 4,
 * below): `collectTravelerData` (the read that decides what the PDF says) and `renderPdf` (~100 ms
 * of pure CPU) both ran BEFORE any lock was taken, so a child mutator — `replaceLoads`,
 * `replaceContainers`, a line/serial/charge edit — could claim the SAME row, write, and commit
 * entirely within that unlocked window, and the archive commit that followed would still see the
 * order as "not voided" (the only thing the old claim re-checked) and happily archive the STALE,
 * pre-edit snapshot already rendered. No warning was possible either: from the archive's own
 * point of view nothing was wrong, the document simply didn't exist yet when the stale read
 * happened.
 *
 * `claimOrder`'s (order-locks.ts) row lock now brackets the read too, and every order-family
 * mutator (orders.ts, order-loads.ts, attachments.ts's order-owner writes) opens with the SAME
 * claim on its own transaction — so the two sides properly serialize: whichever gets here first
 * forces the other to wait for its FULL transaction, not just its final write, to finish. A print
 * that wins the race archives the pre-edit state, and the edit — blocked until the print commits —
 * lands cleanly right after, affecting only the next print ("a load edit after printing changes
 * the NEXT print, never the stored one", below). An edit that wins the race commits first, and the
 * print — blocked until the edit commits — reads and archives the POST-edit state once it can
 * proceed. Either way the archived bytes always describe a real, fully-committed state; a torn,
 * mid-edit snapshot is no longer reachable.
 *
 * This does mean the Order row's lock is now held across the render, not just the final insert —
 * accepted deliberately: correctness (no torn snapshot) matters more here than shaving the
 * occasional wait a concurrent claimant on the SAME order might see, and two prints (or a print
 * and an edit) of the same order overlapping in time is not a case this app needs to run fast. The
 * single check below (claim, then decide) also replaces the OLD two-tier check — an unlocked
 * pre-check before the transaction opened, plus the locked re-check inside it — with one: the
 * expensive work (collectTravelerData, renderPdf) still only ever runs after the order is known to
 * exist and be live, so a refusal is exactly as cheap as it always was.
 *
 * Fix-wave R2 finding 4 (superseded in shape, not in substance, by the above): the original in-tx
 * re-check read `deletedAt` with a plain (unlocked) SELECT, which under Postgres MVCC never blocks
 * on anything — so a `voidOrder` call whose own UPDATE committed in the gap between that read and
 * the `storedDocument` insert went unnoticed, and the print archived against an order that was, by
 * the time anyone looked, already voided. Claiming the row with `SELECT … FOR UPDATE` before the
 * re-check closed that gap: `voidOrder`'s own order UPDATE (via `auditedSoftDelete`, in orders.ts —
 * this file performs no mutation of its own since Phase 4 Task 3 moved storage to documents.ts)
 * takes a write lock on the same row at ANY isolation level, the same "a row lock is the right
 * instrument because both sides take it regardless of isolation" guarantee `workingRevision`
 * documents for the process-steps revision claim (part-process-steps.ts) — `claimOrder` is that
 * same claim, generalized into the one instrument every order-family caller now shares.
 */
export type PrintedTraveler = {
  documentId: string; orderNumber: number; loadNumber: number | null; travelerLoadNumbers: number[]; pdf: Buffer;
};

export async function printTraveler(orderId: string, loadNumber?: number): Promise<PrintedTraveler> {
  return printSelectedTraveler(orderId, loadNumber === undefined
    ? { mode: "all" } : { mode: "loads", loadNumbers: [loadNumber] });
}

export async function printSelectedTraveler(
  orderId: string, selectionInput: TravelerSelection, expectedPrintFingerprint?: string,
): Promise<PrintedTraveler> {
  const selection = normalizeTravelerSelection(selectionInput);
  const loadNumber = selection.mode === "loads" && selection.loadNumbers.length === 1
    ? selection.loadNumbers[0] : null;
  const travelerLoadNumbers = selection.mode === "loads" && selection.loadNumbers.length > 1
    ? selection.loadNumbers : [];
  // Fix-wave R4 finding 8: settings first, OUTSIDE the transaction — the `createOrder` precedent.
  // They are read-only, they are not order state, and reading them here means the transaction
  // below never waits on a round trip that has nothing to do with the order it is holding.
  const settings = await travelerSettings();

  // What the refusal's log line names (#521, the catch below), set as the print reads it.
  const started = performance.now();
  let claimedOrderNumber: number | undefined;
  let loadsInPrint = selection.mode === "loads" ? selection.loadNumbers.length : undefined;

  const { doc, orderNumber, pdf } = await withDbErrors({ entity: "Order" }, () =>
    prisma.$transaction(async (tx) => {
      const live = await claimOrder(tx, orderId);
      if (!live) throw new HttpError(404, "Order not found");
      claimedOrderNumber = live.orderNumber;
      assertPrintable(live);
      const order = await readDetail(tx, orderId, settings.traffic);
      loadsInPrint ??= order.loads.length;
      if (expectedPrintFingerprint !== undefined && printExpectationFor(order) !== expectedPrintFingerprint)
        throw new HttpError(412, "The saved load plan changed. Review the order before printing.");

      // Template resolution on THIS claimed transaction, at its DEFAULT isolation — deliberately
      // unchanged (P7 spec §5.1). The resolution is correct at ANY isolation **by immutability,
      // not by locking**: publish commits the immutable published version row and the
      // `publishedVersionId` pointer move atomically, so any committed pointer this read follows
      // yields a complete published config; drafts can never print; and the stamped
      // `templateVersionId` below records exactly which version produced the paper. A print
      // racing a publish may legitimately render with the previous published version — ruling
      // 2's "from that moment" means COMMIT order, not wall clock (accepted-by-design, §5.1).
      // No template row is claimed here and none is needed — do not add one.
      const resolved = await resolveTemplateForPrint(tx, "TRAVELER", live.customerId);
      // Logo bytes → data URI by the STORED mime type (spec §6.3); the builder renders it only
      // when the config also places it, so an unplaced upload converts nothing.
      const logoDataUri = resolved.logoImage !== null && templatePlacesLogo(resolved.config)
        ? (resolved.logoMimeType === "image/jpeg"
            ? jpegDataUri(Buffer.from(resolved.logoImage))
            : pngDataUri(Buffer.from(resolved.logoImage)))
        : undefined;

      // Only now, with the claim held: the read that decides what the PDF says, and the render
      // itself. Nothing else touching this order's traveler-relevant children can commit until
      // this whole transaction ends — see the fix-wave R3 finding 1 comment above.
      //
      // `readTravelerData(tx, …)`, never `collectTravelerData(…)` (R4 finding 8): every read it
      // performs runs on THIS transaction's connection. The version that called the standalone
      // helper went to the top-level client for all six of them while this transaction sat
      // holding a connection of its own — a pool-starvation shape under concurrent prints, and a
      // snapshot the surrounding claim did not actually cover.
      const data = await readTravelerData(tx, orderId, settings, selection, order);
      // #36: one definition per load, merged — each load's continuation header and (when a
      // template turns the knob on) page numbering scope to ITS OWN sheet group, and the
      // single-load print is simply a one-group merge of the same shape.
      //
      // The render this claim spans is BOUNDED by construction: `readTravelerData` above already
      // refused an all-loads print over MAX_TRAVELER_LOADS_PER_PRINT (#43), so what follows is at
      // most that many per-load documents rather than one unbounded pass over every load an order
      // may legally carry (up to MAX_LOADS = 10,000). Nothing else may commit against this order
      // while the claim is held, so the bound is what keeps that window finite.
      const pdf = await renderSheetGroups(buildTravelerDefinitions(data, resolved.config, logoDataUri));

      // Storage itself — permanence, the audit-payload/bytes split, and the `new Uint8Array`
      // conversion — is documents.ts's job now (Phase 4 Task 3); this claim-holding transaction
      // is still the one thing that has to stay HERE, since the archive must land before the
      // claim is released. `resolved.versionId` is the §5.2 stamp.
      //
      // `printRecord` is what this print printed, for the order page's out-of-date notice (owner
      // ruling P3-Q1, 2026-10-08). It is built from the `order` read under the claim above, the
      // one the paper was built from, and from the normalized `selection`. `readTravelerData` has
      // already refused a selection that names a load the order does not have, so every load the
      // record lists exists. A selection names at most 100 loads, and an all-loads print of more
      // than MAX_TRAVELER_LOADS_PER_PRINT is refused, so the record lists at most 100. Every
      // traveler print ends here, so every print stores one.
      const printRecord = buildTravelerPrintRecord(order, selection);
      const doc = await storeDocument(tx,
        { kind: "TRAVELER", orderId, loadNumber, travelerLoadNumbers, printRecord }, pdf, resolved.versionId);
      return { doc, orderNumber: data.orderNumber, pdf };
    }, { timeout: TRAVELER_PRINT_TIMEOUT_MS }))
    .catch((err: unknown): never => {
      // #521, owner ruling 2026-10-17: a print whose claim expires is refused. Prisma's own timer
      // rolls the transaction back, and so releases the claim, at its first event-loop turn after
      // the budget, but it cannot stop the render. The expiry therefore surfaces at the next query
      // on `tx`, inside the callback, or at the commit, which `$transaction` runs after the
      // callback has returned. This catch is outside the transaction, so it sees both. Nothing
      // was stored or audited: the rollback undid whatever the print had written.
      //
      // A 400, as #43's refusal is: the order page shows a 4xx's sentence as written. On a 5xx it
      // adds that the request may already have archived a traveler (DocumentsSection.tsx, its
      // `e.status < 500` branch), which would be false here.
      //
      // Only two prints map the expiry, this one and `printShippingTickets` (shippers.ts, #556);
      // every other transaction keeps its default. The known miss is `isExpiredTransaction`'s
      // (db-errors.ts): an expired transaction that Prisma has already forgotten, after 100 later
      // closes, reads "Transaction not found" and stays a 500.
      //
      // One server log line per refusal (owner, 2026-10-17): the order number, the loads in the
      // print and the seconds taken, and nothing of the error, the PDF or the customer. A print
      // that waited out its budget behind another claim on the order can expire before it has
      // read the order; its line then names the order by id, and an all-loads print's loads as
      // unknown.
      if (!isExpiredTransaction(err)) throw err;
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      console.error(`[traveler] print refused, took too long: order ${claimedOrderNumber ?? `id ${orderId}`}, `
        + `loads ${loadsInPrint ?? "unknown"}, ${seconds} s`);
      throw new HttpError(400,
        "This traveler took too long to print, so nothing was stored. Print the loads one at a time.");
    });

  // `orderNumber`/`loadNumber` ride along purely so the route can name the download without a
  // second read — `getDocument` would pull the whole PDF back out of the database to learn them.
  return { documentId: doc.id, orderNumber, loadNumber, travelerLoadNumbers, pdf };
}

/** Every traveler this order has had printed, newest first — the order-scoped view onto
 *  documents.ts's shared store. Kept under this name (rather than `listDocumentsForOrder`
 *  directly) because `src/app/api/orders/[id]/documents/route.ts` and this file's own tests
 *  already depend on it. */
export const listDocuments = listDocumentsForOrder;

/** `traveler-91246.pdf` / `traveler-91246-load-3.pdf` — what the browser tab and any save-as
 *  dialog show. Delegates to documents.ts's shared `documentFilename` (Phase 4 Task 3) rather
 *  than keeping its own copy of the naming rule; the adapter object below carries only what a
 *  TRAVELER filename needs (`kind`, `loadNumber`, and `orderId: null` since the real order
 *  number arrives as the second argument instead) — `id`/`createdAt` are part of `DocumentMeta`
 *  but `documentFilename` never reads them for this kind. */
export function travelerFilename(orderNumber: number, loadNumber: number | null, travelerLoadNumbers: number[] = []): string {
  return documentFilename(
    { id: "", createdAt: new Date(0), kind: "TRAVELER",
      orderId: null, shipperId: null, certId: null, invoiceId: null, customerId: null, quoteId: null,
      loadNumber, travelerLoadNumbers },
    orderNumber,
  );
}
