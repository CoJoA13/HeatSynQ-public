/**
 * The quotation's canvas SEED (design `docs/superpowers/specs/2026-11-12-quote-canvas-design.md` §5.3,
 * §4.4; since quote canvas PR 2): a quote draft's canvas starts from today's paper. The flow config the
 * editor holds is laid out ONCE for a stand-in quote (`quoteStandIn`), and every piece is read back
 * from where it landed, so the `CanvasLayout` answered prints the same lines in the same places.
 * Nothing is stored: no document, no audit row, no draft edit. It lives in its own module, as the bill
 * of lading's, the certification's, the invoice's and the statement's do (`invoice-canvas-seed.ts`
 * and `statement-canvas-seed.ts`, the models).
 *
 * The flow marks its pieces and blocks only when asked (`buildQuoteDefinition`'s `seedIds`,
 * `QUOTE_SEED_IDS` in pdf/quote.ts): a header piece's end mark before its bottom margin, so a seeded
 * box is the piece alone; a one-node block's marks inside its node's own vertical margins; the
 * several-node lines' and the liability's as top-level siblings, so the lines' start mark lies above
 * the first grid row's 2 pt and the liability's above its kept 10 pt (design §5.2's per-key
 * exception). Positions report a left and a top only, so every width comes from the flow's own
 * constants (`QUOTE_WIDTHS`) and every style from the flow's own (`quoteSeedStyle`).
 *
 * What the seed does (§5.3, the plan's calls):
 *  - it reads the company block (`quotePrintSettings`, on the top-level client, before any
 *    transaction) and the picked quote as the preview reads it (`readQuotePdfData` on one read-only
 *    RepeatableRead transaction: an unknown id is the preview's own 404, a deleted quote is read), and
 *    lays out a stand-in that keeps the picked quote's number and two dates (fixed columns, so they
 *    move nothing), the company block and the template's own intro and liability wording, every
 *    other piece `QUOTE_STAND_IN`'s placeholder at its least, one of every kind of row the lines block
 *    prints included (call 7): so the seeded layout is the same whichever quote is picked;
 *  - it seeds the header's pieces at the flow's places and styles: the title, the company name and
 *    the company address the centre column's fixed width (208: the content less the two 170 pt side
 *    columns and their gaps), the number the right column's 170, the logo its configured width;
 *  - it draws every block at least the profile's row floor tall, and every later block lower by the
 *    clamps above it (`lift`), so each still prints at the flow's place (the sheet spaces a block from
 *    the one above it by their drawn distance); the liability's top is its start mark, above its kept
 *    10 pt, so under the closing (or the lines) it touches the block above it, and the seal draws it
 *    exactly at that block's drawn bottom (`sealed`), so no region is emitted between them;
 *  - it anchors every piece by the walk (the last block whose end the walk has passed, else the
 *    page's top), its `y` its top less that block's laid-out end;
 *  - it seeds each block's rows or columns with the config's visibility and labels (an untyped label
 *    stays null): the parties' and the closing's in the config's order (the order `partiesBlock` and
 *    `closingBlock` print them in), the lines' in the contract's (`linesBlock` reads no order),
 *    `surcharge_estimate` among them as the config holds it, and the column headers' in the config's
 *    order with their typed widths; the intro and the liability carry none; a hidden section gives no
 *    block;
 *  - it flags `quote_number` to repeat where it stands page-top at least one grid step above the first
 *    block, with no shift ever (call 2, ruled option (a));
 *  - it places nothing in the band (the quote prints no strip);
 *  - it refuses where the canvas cannot start from today's paper, in one of four sentences, in the
 *    invoice's order (`invoice-canvas-seed.ts`), each naming the causes measured reaching it: the
 *    template's settings, and the company name or address and the template's intro and liability
 *    wording, which the stand-in keeps, where they reach it (the controller's ruling of 2026-11-12):
 *    before any read, where the Column headers are hidden over columns that differ from the Standard's
 *    (`gridDiffers`: a canvas with no Column headers block prints the lines under the Standard's
 *    columns); where the stand-in's render runs past one page; where the header does not fit the
 *    page's width (`pastTheRightMargin`: the flow's centre column is "*", which pdfmake widens to its
 *    widest unbroken child, a header-centre logo, the title's longest word at its font and heading
 *    size, or a long unbroken word in the company name or address, pushing the 170 pt number column
 *    right until, clamped by `tidy`, it has no width); and where it fits one page
 *    in the flow but the drawn stack does not fit the canvas's page (`fitsTheCanvas`: with the page
 *    line on the band's top is the flow's own foot, so the row-floor `lift`, the Standard's blank
 *    liability drawn a floor tall under the closing, can put a drawn bottom past it); then the seeded
 *    layout is judged by the canvas rules, and any other refusal is the seed's own fault and surfaces
 *    unmapped.
 *
 * This module imports nothing from template-canvas-seed.ts.
 */
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { quotePrintSettings, readQuotePdfData, type QuotePrintSettings } from "./quotes";
import {
  QUOTE_FLOW, QUOTE_SEED_IDS, QUOTE_WIDTHS, buildQuoteDefinition, quoteSeedStyle, type QuotePdfData,
} from "./pdf/quote";
import { renderSheetGroupsWithPositions, type LaidOutNode } from "./pdf/render";
import {
  bandTop, canvasProfile, defaultTableColumns, drawnBox, pageFoot, tablesByY, floorRefusal, validateCanvasLayout, widthFloorRefusal,
} from "@/lib/template-canvas";
import { QUOTE_CONTRACT } from "@/lib/template-contracts/quote";
import {
  CANVAS_GRID, CANVAS_PAGE, type CanvasAnchor, type CanvasBox, type CanvasColumn, type CanvasItem, type CanvasLayout,
  type CanvasTextStyle,
} from "@/lib/template-contracts/canvas";
import type { SectionConfig, TemplateConfig } from "@/lib/template-contracts/types";

const W = QUOTE_WIDTHS;
const LEFT = CANVAS_PAGE.margin;
const RIGHT = CANVAS_PAGE.width - CANVAS_PAGE.margin;
/** A block's least drawn height, the profile's. */
const ROW_FLOOR = canvasProfile(QUOTE_CONTRACT).rowFloor;
/** The header's centre column on the flow's paper: the content less the two fixed side columns and
 *  the two gaps between the three (208). The flow's column is `"*"`, which pdfmake widens past this
 *  to a wider unbroken title or header-center logo; the seed draws the centre pieces at 208 all the
 *  same (the plan's call: such a seed differs from the flow by design, its number clamped or refused). */
const CENTRE = W.content - 2 * W.headerSide - 2 * W.headerGap;

/** The six blocks, each opened by its `start` mark and closed by its `sectionEnd` mark. */
const BLOCKS = ["parties", "intro", "column_header", "lines", "closing", "liability"] as const;
type Block = (typeof BLOCKS)[number];
/** The header's three centre pieces, which print in the centre column. */
const CENTRE_PIECES = new Set(["title", "company_name", "company_address"]);

const pageTop: CanvasAnchor = { kind: "page-top" };

/**
 * The stand-in's placeholders (design §5.3, call 7; the plan's open question 2): every piece that
 * grows at its least, one line each, and one of every kind of row the lines block prints (a grid
 * row, a Material line, a PRICE heading, one price row with one detail line, its setup charge with
 * no trailer, and one surcharge estimate row with a figure). The customer phone is blank, so it is
 * omitted, as the flow omits a blank phone. The picked quote's number and dates, the company block
 * and the template's own intro and liability wording are kept (`quoteStandIn`).
 */
export const QUOTE_STAND_IN = {
  attn: "Contact",
  billTo: ["Customer"],
  termsName: "Terms",
  rfqNumber: "RFQ",
  customerPhone: "",
  line: {
    quotedQty: 1, quotedUnlimited: false, partNumber: "Part", partName: "", partDescription: "",
    eachWeight: 1, totalLbs: 1, material: "Material",
  },
  priceRow: {
    stepName: "Operation", notes: "", setupCharge: 0, unitPrice: null, minimumCharge: null,
    pricePerLabel: "Each", pricedPerLb: false, breaks: [], amount: 0,
  },
  surcharge: { name: "Surcharge", rateText: "0%", amount: 0 },
  endingStatementText: "Ending statement",
  notes: "",
  signer: { name: "Signer", title: "Title" },
} as const;

/**
 * The stand-in the seed lays out (§5.3): the settings' company block; the picked quote's number and
 * two dates (a placeholder date cannot stand in: the flow's date format splits an ISO string); the
 * config's own intro and liability wording (template data, the same for every quote); and
 * `QUOTE_STAND_IN`'s placeholders for everything else.
 */
export function quoteStandIn(
  settings: QuotePrintSettings, picked: Pick<QuotePdfData, "quoteNumber" | "effectiveDate" | "expiryDate">,
  config: TemplateConfig,
): QuotePdfData {
  const s = QUOTE_STAND_IN;
  return {
    company: { ...settings.company },
    quoteNumber: picked.quoteNumber,
    effectiveDate: picked.effectiveDate,
    expiryDate: picked.expiryDate,
    termsName: s.termsName,
    rfqNumber: s.rfqNumber,
    attn: s.attn,
    customerPhone: s.customerPhone,
    billTo: [...s.billTo],
    introText: config.textBlocks.quote_intro_text ?? "",
    lines: [{
      ...s.line,
      prices: [{ ...s.priceRow, breaks: [] }],
      surcharges: [{ ...s.surcharge }],
    }],
    endingStatementText: s.endingStatementText,
    notes: s.notes,
    liabilityText: config.textBlocks.quote_liability_text ?? "",
    signer: { ...s.signer },
  };
}

/** The config's field entry, for its typed label and its visibility. */
function fieldConfig(config: TemplateConfig, section: string, key: string) {
  return config.sections.find((s) => s.key === section)?.fields.find((f) => f.key === key);
}

function style(key: string, config: TemplateConfig): CanvasTextStyle {
  const s = quoteSeedStyle(key, config.fonts);
  if (s === null) throw new Error(`The quote's seed has no style for ${key}.`);
  return s;
}

/** A header field item, its label the config's (`label: f.label`: null when untyped, as the flow
 *  re-resolves it at every print). */
function fieldItem(config: TemplateConfig, key: string, box: CanvasBox, anchor: CanvasAnchor): CanvasItem {
  return {
    kind: "field", id: crypto.randomUUID(), key, label: fieldConfig(config, "header", key)?.label ?? null,
    box, anchor, repeat: false, style: style(key, config),
  };
}

/** The contract's field keys of a section, in the contract's order. */
const contractKeys = (section: string): string[] =>
  QUOTE_CONTRACT.sections.find((s) => s.key === section)!.fields.map((f) => f.key);

/**
 * A block's table item (design §5.3): the parties' and the closing's rows in the config's order (the
 * order their builders print them in); the lines' in the contract's (its builder reads no order),
 * `surcharge_estimate` among them; each row with the config's visible and label (null when untyped)
 * and no width; the column headers' columns in the config's order with their visible, label and
 * typed width; the intro and the liability with none (`defaultTableColumns`' answer).
 */
function tableItem(config: TemplateConfig, key: Block, box: CanvasBox, anchor: CanvasAnchor): CanvasItem {
  let columns: CanvasColumn[];
  if (key === "intro" || key === "liability") {
    columns = defaultTableColumns(QUOTE_CONTRACT, key);
  } else if (key === "column_header") {
    columns = config.sections.find((s) => s.key === key)!.fields.map((f) => ({
      key: f.key, visible: f.visible ?? true, label: f.label ?? null, width: f.width ?? null,
    }));
  } else {
    const keys = key === "lines" ? contractKeys(key) : config.sections.find((s) => s.key === key)!.fields.map((f) => f.key);
    columns = keys.map((k) => {
      const f = fieldConfig(config, key, k);
      return { key: k, visible: f?.visible ?? true, label: f?.label ?? null, width: null };
    });
  }
  return { kind: "table", id: crypto.randomUUID(), key, box, anchor, repeat: false, heading: null, columns };
}

const snap = (n: number) => Math.round(n * 1000) / 1000;

/** A box's figures to a thousandth of a point, and its right edge never past the page's right margin
 *  (the invoice's `tidy`, copied as the statement's seed copies it: this module imports nothing back
 *  from template-canvas-seed.ts). A header-right logo wider than its 170 pt column, and a number
 *  pushed right by a widened centre column, are clamped here. */
function tidy(item: CanvasItem): CanvasItem {
  const x = snap(item.box.x);
  const w = Math.min(snap(item.box.w), RIGHT - x);
  return { ...item, box: { x, y: snap(item.box.y), w, h: snap(item.box.h) } } as CanvasItem;
}

/** The most a snapped block may stand off the block before it's drawn bottom and still be read as
 *  meeting it: the thousandth `tidy` rounds to, twice, with room for the sum's binary error. */
const ROUNDING = 0.0025;

/**
 * The blocks' stack after the snap (the invoice's `sealed`, with one change). A block the flow lays
 * out directly under another (the liability under the closing or the lines: its start mark is the
 * block above's end) is snapped apart from that block's drawn bottom by a rounding step either way:
 * above it (rule 5 refuses the overlap) or below it (a region of a thousandth, which the sheet emits
 * as a float region of its own, a spacer that can start a blank last page on a quote that ends near
 * the foot: design §4.5, call 4). Each such block is drawn EXACTLY at that bottom (the float sum of
 * the drawn top and height above it), only by a rounding step (`ROUNDING`), and every later block
 * moves with it (`shift`), so the drawn distances stay the flow's and the moves do not add up. The
 * change from the invoice's (which moves a block only down, to the first thousandth at or below the
 * bottom): it closes a rounding gap too, so a seeded liability meets the closing with a region of 0.
 * A real overlap or a real gap is left for the rules.
 */
function sealed(items: CanvasItem[]): CanvasItem[] {
  const moved = new Map<string, number>();
  let bottom: number | null = null;
  let shift = 0;
  for (const t of tablesByY({ version: 1, items })) {
    let y = shift === 0 ? t.box.y : snap(t.box.y + shift);
    if (bottom !== null && Math.abs(y - bottom) <= ROUNDING) y = bottom;
    if (y !== t.box.y) {
      moved.set(t.id, y);
      shift = y - t.box.y;
    }
    bottom = y + t.box.h;
  }
  return items.map((i) => (moved.has(i.id) ? { ...i, box: { ...i.box, y: moved.get(i.id)! } } as CanvasItem : i));
}

/**
 * The items, from the positions of the one layout, in the order the flow draws them. Each piece's
 * anchor is the last block whose end the walk has passed, its `y` its top less that block's laid-out
 * end (the page's top: 0); each block's drawn box is absolute, its `y` its start mark plus the `lift`
 * above it. A hidden field or section prints nothing, so it has no position and seeds nothing (a
 * blank company address prints no line and has no piece); a shown block whose builder answered
 * nothing seeds at the row floor from its start mark. The walk skips every id outside the seed's
 * namespace.
 */
export function seedQuoteItems(config: TemplateConfig, positions: LaidOutNode[], logoPlaced: boolean): CanvasItem[] {
  const byId = new Map(positions.map((n) => [n.id, n] as const));
  const endOf = (key: string): number => {
    const node = byId.get(QUOTE_SEED_IDS.end(key));
    if (node === undefined) throw new Error(`The seed's layout has no position for ${QUOTE_SEED_IDS.end(key)}.`);
    return node.top;
  };

  const items: CanvasItem[] = [];
  let anchor: CanvasAnchor = pageTop;
  let base = 0;
  const open = new Map<Block, LaidOutNode>();
  /** How much lower than its laid-out top a block is drawn: the row-floor clamps of the blocks above it. */
  let lift = 0;

  for (const node of positions) {
    const id = node.id;
    // The render reports every id'd node; one the seed did not place is none of the seed's business.
    if (!id.startsWith("seed:")) continue;
    if (id.startsWith("seed:start:")) {
      open.set(id.slice("seed:start:".length) as Block, node);
      continue;
    }
    if (id.startsWith("seed:end:")) {
      const key = id.slice("seed:end:".length);
      const start = open.get(key as Block);
      if (start === undefined || !(BLOCKS as readonly string[]).includes(key)) continue; // a piece's end
      const block = key as Block;
      // A block's drawn box is absolute: its y is its top (the liability's, its start mark above its
      // kept 10 pt). Its height is at least the profile's row floor; the walk still passes it at its
      // laid-out end, and the items below it ride its rendered bottom on paper, so their offsets are
      // the flow's. The sheet spaces the next block from this one's DRAWN bottom, so every later block
      // is drawn lower by the clamps above it (`lift`).
      const laidOut = node.top - start.top;
      const h = Math.max(ROW_FLOOR, laidOut);
      items.push(tableItem(config, block, { x: LEFT, y: start.top + lift, w: W.content, h }, anchor));
      lift += h - laidOut;
      anchor = { kind: "below-table", table: block };
      base = node.top;
      continue;
    }
    const key = id.slice("seed:".length);
    const h = endOf(key) - node.top;
    const top = node.top - base;
    if (key === "logo") {
      if (!logoPlaced || config.logo === null) continue;
      items.push({ kind: "logo", id: crypto.randomUUID(), box: { x: node.left, y: top, w: config.logo.width, h }, anchor, repeat: false });
    } else if (CENTRE_PIECES.has(key)) {
      items.push(fieldItem(config, key, { x: node.left, y: top, w: CENTRE, h }, anchor));
    } else if (key === "quote_number") {
      items.push(fieldItem(config, key, { x: node.left, y: top, w: W.headerSide, h }, anchor));
    } else {
      throw new Error(`The quote's seed has no item for ${key}.`);
    }
  }
  return sealed(items.map(tidy));
}

/**
 * The repeat (§4.4, call 2, ruled option (a)): the quotation number repeats where it stands page-top
 * at least one grid step above the first block's top (rule 3's own comparison), with no shift ever;
 * otherwise nothing repeats (the number hidden, its Header section hidden, or printed below a block,
 * or no block placed).
 */
export function withRepeat(items: CanvasItem[]): CanvasItem[] {
  const number = items.find((i) => i.kind === "field" && i.key === "quote_number" && i.anchor.kind === "page-top");
  const first = tablesByY({ version: 1, items })[0];
  if (number === undefined || first === undefined) return items;
  if (number.box.y + number.box.h + CANVAS_GRID > first.box.y) return items;
  return items.map((item) => (item === number ? { ...item, repeat: true } : item));
}

/** A column section's columns as the flow prints its grid under them (`ctxOf`'s `qtyW` and
 *  `gridColumns`, through the flow's own lens): in its order, each with its visibility and its width
 *  resolved, typed or the contract's (`"*"` for the Information column untyped), a hidden column
 *  reserving none (0). Labels are left out: under a hidden section no column header prints. The
 *  invoice's (`invoice-canvas-seed.ts`), copied: a hidden column keeps its place in the order
 *  compared, so a hidden column moved under a hidden section is refused though it prints the same
 *  paper (the invoice's over-refusal, kept as its shape). */
function resolvedColumns(sc: SectionConfig): { key: string; visible: boolean; width: number | "*" }[] {
  const view = QUOTE_FLOW.sectionView(sc);
  return view.order.map((key) => {
    const f = view.field(key);
    return { key, visible: f.visible, width: f.visible ? f.width : 0 };
  });
}

/** The Standard's column headers: the contract's columns in its order, each shown at its own width. */
const STANDARD_COLUMNS: SectionConfig = {
  key: "column_header",
  visible: true,
  fields: QUOTE_CONTRACT.sections.find((s) => s.key === "column_header")!.fields
    .map((f) => ({ key: f.key, visible: true, label: null, width: null })),
};

/**
 * Whether the config hides its Column headers while setting their columns apart from the Standard's
 * (sentence 1): their order, a column's visibility, or its width as the flow resolves it (a typed
 * width equal to the contract's is the Standard's), labels aside. The flow aligns its lines to the
 * hidden section's columns all the same; the seed places no block for a hidden section, and a canvas
 * with no Column headers block prints its lines under the contract's columns (`gridOf`), so such a
 * canvas would not print today's paper. A shown section seeds its block, columns and all.
 */
export function gridDiffers(config: TemplateConfig): boolean {
  const section = config.sections.find((s) => s.key === "column_header");
  if (section === undefined || section.visible) return false;
  return JSON.stringify(resolvedColumns(section)) !== JSON.stringify(resolvedColumns(STANDARD_COLUMNS));
}

/** The header's pieces: every field the quote's canvas places (all four are the header's) and the logo. */
const inHeader = (item: CanvasItem): boolean => item.kind === "logo" || item.kind === "field";

/**
 * The part of the seeded layout that runs past the page's right margin, else null: a header piece
 * left no width once `tidy` has clamped its right edge to the margin (the invoice's, its header half
 * alone: the quote has no identity row). The flow's centre column is "*", which pdfmake widens to its
 * widest unbroken child, and that pushes the 170 pt number column right. Measured causes: a
 * header-centre logo, the title's longest word at the template's font and heading size, and the
 * company name or company address (Settings, not the template's: the stand-in keeps them) holding one
 * unbroken word wide enough, which the header sentence names beside the template's settings (on the
 * Standard, 34 "W"s in the name, or 43 in an address line, leave the number no width; 33 and 42 seed
 * it clamped). A number
 * pushed only part of the way keeps a clamped width and seeds.
 */
function pastTheRightMargin(layout: CanvasLayout): "header" | null {
  return layout.items.some((item) => inHeader(item) && item.box.w <= 0) ? "header" : null;
}

/**
 * How many thousandths of a point a drawn bottom must stand above the band's top (the bill of lading's
 * `FIT_CLEARANCE`, bol-canvas-seed.ts, copied through the invoice's: every seeded figure is snapped to
 * a thousandth, so a printed bottom stands up to half a thousandth per block either side of the drawn
 * one). Exported so the seed's fit case reads it rather than retyping it.
 */
export const FIT_CLEARANCE = 2;

/**
 * Whether the seeded layout's drawn stack fits the canvas's one page (design §5.3): the invoice's
 * check, copied, over every item's drawn box (`drawnBox`, an item below a block included, which rule
 * 4 does not judge), counted in whole thousandths. A block, a page-top item and an item below a block
 * end at least `FIT_CLEARANCE` thousandths above the band's top; a page-bottom item ends at most on
 * the page's foot; and the first block has the profile's room for its first lines above the band. The
 * quote's seed places nothing in the band, so the page-bottom arm is kept as copied and reached by no
 * stand-in. The first-block-room arm is reached, and the seed needs it: a first block that starts
 * within `firstTableRoom` (25 pt) of the band while its drawn bottom clears it, as an empty parties
 * block alone (every other block hidden, and every parties field) does under a tall header-centre logo
 * (measured: starting at 726 to 735 pt, its row-floor box ending at 736 to 745, under the band's 748).
 * Without the arm the rules refuse that block, unmapped. The flow runs its content down to its 44 pt
 * bottom margin (748), where the canvas's band starts with the page line on, so a stand-in the flow
 * fits on one page draws a bottom past the band only through the row-floor `lift` (the Standard's blank
 * liability drawn a floor tall under the closing) or within the clearance.
 */
function fitsTheCanvas(layout: CanvasLayout, pageFooter: boolean): boolean {
  const band = bandTop(layout, pageFooter);
  const foot = pageFoot(pageFooter);
  const grains = (n: number) => Math.round(n * 1000);
  const drawnFits = layout.items.every((item) => {
    const box = drawnBox(item, layout);
    if (item.kind !== "table" && item.anchor.kind === "page-bottom") return grains(box.y + box.h) <= grains(foot);
    return grains(box.y + box.h) <= grains(band) - FIT_CLEARANCE;
  });
  const first = tablesByY(layout)[0];
  return drawnFits && (first === undefined || first.box.y + canvasProfile(QUOTE_CONTRACT).firstTableRoom <= band);
}

/** Read-only, on one RepeatableRead snapshot, as the preview reads. */
function readOnly<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/** The blocks' width floors at the content width, before the stand-in is laid out (#991 review I2, the
 *  controller's ruling of 2026-11-17): a template whose columns leave the page no room for a block is
 *  refused in rule 9's or rule 4's own sentence (`widthFloorRefusal`), as before #991, never in the
 *  one-page sentence a stand-in squeezed by the column clamp would reach first. Each shown section's
 *  block is drawn as the seed draws it, at the content width. */
function widthFloorsFirst(config: TemplateConfig): void {
  const box = { x: LEFT, y: 0, w: RIGHT - LEFT, h: ROW_FLOOR };
  const items = BLOCKS.filter((block) => config.sections.find((s) => s.key === block)?.visible === true)
    .map((block) => tableItem(config, block, box, pageTop));
  const floor = widthFloorRefusal({ version: 1, items }, QUOTE_CONTRACT, { fonts: config.fonts });
  if (floor !== null) throw new HttpError(400, floor.sentence);
}

/**
 * The layout that prints the submitted flow config's quotation for any quote (§5.3). `config` is
 * validated by the caller with its own `layout` set aside; `logoDataUri` is the version's logo where
 * the config places it. A hidden Column headers section over a grid set apart from the Standard's is
 * refused first, before any read: the record cannot change it. The company block is read next,
 * outside any transaction (`quotePrintSettings` reads on the top-level client, as every quote print
 * reads it); the picked quote is read as the preview reads it, on one read-only RepeatableRead
 * transaction (an unknown id is refused in the preview's own 404, "Quote not found"; a deleted quote
 * is read, and seeds the stand-in's line). Only its number and its two dates reach the stand-in. It
 * writes nothing.
 */
export async function seedQuoteLayout(
  recordId: string, config: TemplateConfig, logoDataUri: string | undefined,
): Promise<CanvasLayout> {
  // A config check, before any read: the record cannot change it.
  if (gridDiffers(config)) {
    throw new HttpError(400,
      `The canvas starts from today's paper, and this template hides its Column headers while setting their columns apart from the Standard's (their order, widths or which are shown); a canvas with no Column headers block prints the lines under the Standard's columns. Show the Column headers, or set their columns back to the Standard's, before designing on a canvas.`);
  }
  widthFloorsFirst(config);
  const settings = await quotePrintSettings();
  const picked = await readOnly((tx) => readQuotePdfData(tx, recordId, settings));
  const standIn = quoteStandIn(settings, picked, config);
  const laid = await renderSheetGroupsWithPositions([buildQuoteDefinition(standIn, config, logoDataUri, { seedIds: true })]);
  // A canvas stacks the blocks on one page. At the stand-in's lengths the template's font, sizes and
  // logo, its title's label (read from `config`, as every label is), its own intro and liability wording
  // (the stand-in keeps both: a long intro, measured, pages it, and so does a title's label of 40 words,
  // which wraps under the header's centre column) and the company address can put the quote on a second
  // page, and the sentence names them. A paged pass's positions say nothing of one page, so nothing is read off it.
  const pages = laid.groups[0].pages;
  if (pages > 1) {
    throw new HttpError(400,
      `The canvas starts from a one-page quote; laid out at its least, this template's quote prints ${pages} pages. Change this template's settings (its font, sizes, logo or title's label), its intro or liability wording, or the company address so it fits one page.`);
  }
  const items = seedQuoteItems(config, laid.groups[0].positions, logoDataUri !== undefined);
  const layout: CanvasLayout = { version: 1, items: withRepeat(items) };
  // The width first: a piece left with no width can make the stack taller (a square header-centre
  // logo wide enough can be tall enough too), and the height sentence would then name the wrong
  // settings. The sentence names the template's settings and the company name or address, one
  // unbroken word in either wide enough reaching it too (`pastTheRightMargin`).
  if (pastTheRightMargin(layout) === "header") {
    throw new HttpError(400,
      `The canvas starts from a quote whose header fits the page; laid out at its least, this template's header runs past the page's right margin. Change this template's settings (its logo's width, font, heading size or title's label) or the company name or address so the header fits the page's width.`);
  }
  // One page in the flow is not yet one page on the canvas (design §5.3: the drawn stack must fit the
  // page rule 4 judges). The sentence names the template's settings that were measured putting it
  // there, the page line and the title's label among them (a title's label that wraps grows the header
  // by a line, measured), its intro and liability wording, which the stand-in keeps (an intro a line
  // longer, measured, draws the stack past the band; the blank liability is the one drawn a floor
  // tall, and a typed one, measured, reaches the sentence at the clearance), and the company address.
  // The flow printed one page, so it names no page count.
  if (!fitsTheCanvas(layout, config.pageFooter)) {
    throw new HttpError(400,
      `The canvas starts from a one-page quote; laid out at its least on the canvas, this template's quote runs past one page. Change this template's settings (its font, sizes, logo, page line or title's label), its intro or liability wording, or the company address so it fits one page.`);
  }
  // A block the template's columns leave narrower than its least width (rule 4's or rule 9's floor,
  // #971 design §6) is the template's to change: the 400 in the rule's own sentence.
  const floor = floorRefusal(layout, QUOTE_CONTRACT, { pageFooter: config.pageFooter, fonts: config.fonts });
  if (floor !== null) throw new HttpError(400, floor.sentence);
  // Every other rule the layout must pass is the seed's to meet: the four causes that can break one
  // (the Column headers' columns, the page count, the header's width, the drawn stack's fit) are
  // refused above in their own sentences, so a refusal here is the seed's fault, not mapped to a 400,
  // and surfaces as the fault it is.
  validateCanvasLayout(layout, QUOTE_CONTRACT, { pageFooter: config.pageFooter, fonts: config.fonts });
  return layout;
}
