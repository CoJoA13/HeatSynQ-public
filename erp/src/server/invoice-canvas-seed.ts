/**
 * The invoice's and the credit memo's canvas SEED (design `docs/superpowers/specs/2026-11-10-invoice-canvas-design.md`
 * §5.3, §4.4): an invoice draft's canvas starts from today's paper. The flow config the editor holds
 * is laid out ONCE for a stand-in copy of the picked invoice or credit (`invoiceStandIn`), and every
 * piece is read back from where it landed, so the `CanvasLayout` answered prints the same lines in the
 * same places. Nothing is stored: no document, no audit row, no filing ticket, and so no Printed
 * (derived from the stored documents, `printedSince`). `seedCanvasLayout` (template-canvas-seed.ts)
 * dispatches an INVOICE template here (the invoice in `CANVAS_PRINTS` since PR 3 of its lane); it
 * lives in its own module beside that one, as the bill of lading's and the certification's do
 * (`cert-canvas-seed.ts`, the model).
 *
 * The flow marks its pieces and blocks only when asked (`buildInvoiceDefinition`'s `seedIds`,
 * `INVOICE_SEED_IDS` in pdf/invoice.ts): a piece's end mark before its bottom margin, so a seeded box
 * is the piece alone; a one-node block's marks inside its node's own margins, a several-node block's
 * as top-level siblings of its nodes (§5.3). Positions report a left and a top only, so every width
 * comes from the flow's own constants (`INVOICE_WIDTHS`) and every style from the flow's own
 * (`invoiceSeedStyle`).
 *
 * What the seed does (§5.3, the plan's calls):
 *  - it lays every growing block out at its least, from a stand-in whose growing pieces are always
 *    placeholders (`INVOICE_STAND_IN`: each address one line, the order strip's PO, Material and
 *    Process short words on one line, one part line of one line, one operation of that part with no
 *    quote source, unit price, minimum or setup, no surcharge, charge, cert, freight or tax line); the
 *    picked record's company, Remit To box, kind, document number, date, terms, order number and its
 *    two totals are kept;
 *  - it refuses only where the template's settings stop the canvas starting from today's paper, in
 *    one of its sentences, each naming those settings, in this order: before any read, where the
 *    Column headers are hidden over columns that differ from the Standard's (`gridDiffers`: a canvas
 *    with no Column headers block prints the body under the Standard's columns); where the stand-in's
 *    render runs past one page; where the header, or the identity lines and the Remit To box, do not
 *    fit the page's width (`pastTheRightMargin`: a side logo's width, or a font and heading size
 *    whose title is one long word, can leave the header's pieces no width once `tidy` has clamped
 *    them to the margin; a long unbroken identity label, which pdfmake's "*" column widens to,
 *    pushes the Remit To box past it); and where it fits one page in the flow but the drawn stack does
 *    not fit the canvas's page (`fitsTheCanvas`: the strip's band and the page line's room above the
 *    flow's bottom margin, and the row-floor `lift`, can each put a drawn bottom past the band's
 *    top); then the seeded layout is judged by the canvas rules, and any other refusal is the seed's
 *    own fault and surfaces unmapped;
 *  - it draws every block at least the profile's row floor tall, and every later block lower by the
 *    clamps above it (`lift`), so each still prints at the flow's place (the sheet spaces a block from
 *    the one above it by their drawn distance);
 *  - it anchors every piece by the walk (the last block whose end the walk has passed, else the
 *    page's top), its `y` its top less that block's laid-out end;
 *  - it seeds each block's rows in the flow's order with the config's visibility and labels (the
 *    addresses' rows in the config's order, every other rows block's in its contract section's, the
 *    order its builder prints them in), and the column headers' columns in the config's order with
 *    their typed widths; a hidden section gives no block, and so do the addresses with both rows
 *    hidden (they print nothing); any other block whose builder answers nothing seeds at the row floor;
 *  - it places the company strip in the page-bottom band from the flow's column arithmetic, each of
 *    its three fields repeated, their heights from one alone layout (`invoiceStrip`), at the flow's
 *    754 pt where the tallest fits above the page's foot, else with that one's bottom at the foot;
 *  - it flags `invoice_no` to repeat where it stands page-top at least one grid step above the first
 *    block, with no shift ever.
 *
 * This module imports nothing from template-canvas-seed.ts, which imports it.
 */
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { invoicePrintSettings, readInvoicePdfData } from "./invoices";
import {
  INVOICE_FLOW, INVOICE_PAGE, INVOICE_SEED_IDS, INVOICE_WIDTHS, buildInvoiceDefinition, invoiceCanvasItemContent,
  invoiceSeedStyle, type InvoicePdfData,
} from "./pdf/invoice";
import { layOutSheetGroups, renderSheetGroupsWithPositions, type LaidOutNode } from "./pdf/render";
import { CANVAS_IDS, aloneLayouts } from "./pdf/canvas-sheet";
import {
  bandTop, canvasProfile, defaultTableColumns, drawnBox, pageFoot, tablesByY, floorRefusal, validateCanvasLayout, widthFloorRefusal,
} from "@/lib/template-canvas";
import { INVOICE_CONTRACT } from "@/lib/template-contracts/invoice";
import {
  CANVAS_GRID, CANVAS_PAGE, type CanvasAnchor, type CanvasBox, type CanvasColumn, type CanvasItem, type CanvasLayout,
  type CanvasTextStyle,
} from "@/lib/template-contracts/canvas";
import type { SectionConfig, TemplateConfig } from "@/lib/template-contracts/types";

const W = INVOICE_WIDTHS;
const LEFT = CANVAS_PAGE.margin;
const RIGHT = CANVAS_PAGE.width - CANVAS_PAGE.margin;
/** A block's least drawn height, the profile's. */
const ROW_FLOOR = canvasProfile(INVOICE_CONTRACT).rowFloor;
/** The flow's strip top: the page less its 44 pt bottom margin, plus the strip's 6 pt inset (754). */
const STRIP_TOP = CANVAS_PAGE.height - INVOICE_PAGE.bottomMargin + INVOICE_PAGE.stripInset;

/** The six blocks, each opened by its `start` mark and closed by its `sectionEnd` mark. */
const BLOCKS = ["parties", "column_header", "order_strip", "parts", "price", "totals"] as const;
type Block = (typeof BLOCKS)[number];
/** The header's two pieces, which print as wide as the content less a side logo's column. */
const HEADER = new Set(["title", "company_name"]);
/** The identity lines, which print in the identity's "*" column past its indent. */
const IDENTITY_LINES = new Set(["invoice_no", "invoice_date", "terms"]);
/** The company strip's three fields, left to right, each its flow column's fixed width (null: the
 *  strip's "*" column, the address). */
const STRIP: { key: "footer_address" | "footer_contact" | "footer_phone"; width: number | null }[] = [
  { key: "footer_address", width: null },
  { key: "footer_contact", width: W.footerContact },
  { key: "footer_phone", width: W.footerPhone },
];
export type InvoiceStripHeights = { address: number | null; contact: number | null; phone: number | null };
const STRIP_HEIGHT: Record<(typeof STRIP)[number]["key"], keyof InvoiceStripHeights> = {
  footer_address: "address", footer_contact: "contact", footer_phone: "phone",
};

const pageTop: CanvasAnchor = { kind: "page-top" };

/**
 * The stand-in's placeholders (open question 5): every growing piece at its least. The picked
 * record's order number, company, Remit To box, kind, number, date, terms and totals are kept.
 */
export const INVOICE_STAND_IN = {
  address: ["Customer"],
  poNumber: "PO",
  materialName: "Material",
  processNames: "Process",
  part: { qty: 1, partNumber: "Part", partName: "", partDescription: "", eachWeight: 1, totalWeight: 1 },
  priceRow: {
    description: "Operation", pricePerLabel: "Each", unitPrice: null, minimumCharge: null, setupCharge: null,
    sourceQuoteNumber: null, amount: 0, partIndex: 0,
  },
} as const;

/** The config's field entry, for its typed label and its visibility. */
function fieldConfig(config: TemplateConfig, section: string, key: string) {
  return config.sections.find((s) => s.key === section)?.fields.find((f) => f.key === key);
}
const shown = (config: TemplateConfig, section: string, key: string) => fieldConfig(config, section, key)?.visible ?? true;
const sectionShown = (config: TemplateConfig, section: string) => config.sections.find((s) => s.key === section)?.visible ?? true;

/**
 * The stand-in the seed lays out (§5.3): the picked record's own company, Remit To, kind, number,
 * date, terms, order number and totals; every growing piece `INVOICE_STAND_IN`'s. `config` is taken
 * for the certification's signature (`certStandIn`): nothing of the invoice's stand-in depends on it.
 */
export function invoiceStandIn(d: InvoicePdfData, config: TemplateConfig): InvoicePdfData {
  void config;
  const s = INVOICE_STAND_IN;
  return {
    ...d,
    billTo: [...s.address],
    shipTo: [...s.address],
    poNumber: s.poNumber,
    materialName: s.materialName,
    processNames: s.processNames,
    parts: [{ ...s.part }],
    priceRows: [{ ...s.priceRow }],
    surchargeRows: [],
    chargeRows: [],
    certRow: null,
    freightRow: null,
    taxRow: null,
  };
}

function style(key: string, config: TemplateConfig): CanvasTextStyle {
  const s = invoiceSeedStyle(key, config.fonts);
  if (s === null) throw new Error(`The invoice's seed has no style for ${key}.`);
  return s;
}

/** The contract section holding a field. */
const SECTION_OF = new Map(INVOICE_CONTRACT.sections.flatMap((s) => s.fields.map((f) => [f.key, s.key] as const)));

/** A field item, its label the config's (null: the contract's default, as the flow reads it). */
function fieldItem(config: TemplateConfig, key: string, box: CanvasBox, anchor: CanvasAnchor, repeat = false): CanvasItem {
  return {
    kind: "field", id: crypto.randomUUID(), key, label: fieldConfig(config, SECTION_OF.get(key)!, key)?.label ?? null,
    box, anchor, repeat, style: style(key, config),
  };
}

/** The contract's field keys of a section, in the contract's order: the order its builder prints a
 *  rows block's rows in (design §4.1). */
const contractKeys = (section: string): string[] =>
  INVOICE_CONTRACT.sections.find((s) => s.key === section)!.fields.map((f) => f.key);

/** A block's table item: the column headers with the config's columns in its order, each with its
 *  visible, label and typed width; the addresses with their rows in the config's order; every other
 *  rows block with its rows in the contract's order; each row with the config's visible and label
 *  (null when untyped) and no width. */
function tableItem(config: TemplateConfig, key: Block, box: CanvasBox, anchor: CanvasAnchor): CanvasItem {
  let columns: CanvasColumn[];
  if (key === "column_header") {
    columns = config.sections.find((s) => s.key === key)!.fields.map((f) => ({
      key: f.key, visible: f.visible ?? true, label: f.label ?? null, width: f.width ?? null,
    }));
    const expected = defaultTableColumns(INVOICE_CONTRACT, key).map((c) => c.key).sort();
    if (JSON.stringify(columns.map((c) => c.key).sort()) !== JSON.stringify(expected)) {
      throw new Error(`The invoice's seed found the column headers' columns ${columns.map((c) => c.key).join(", ")}.`);
    }
  } else {
    const keys = key === "parties" ? config.sections.find((s) => s.key === key)!.fields.map((f) => f.key) : contractKeys(key);
    columns = keys.map((k) => {
      const f = fieldConfig(config, key, k);
      return { key: k, visible: f?.visible ?? true, label: f?.label ?? null, width: null };
    });
  }
  return { kind: "table", id: crypto.randomUUID(), key, box, anchor, repeat: false, heading: null, columns };
}

const snap = (n: number) => Math.round(n * 1000) / 1000;

/** A box's figures to a thousandth of a point, and its right edge never past the page's right margin
 *  (template-canvas-seed.ts's `tidy`, kept here so this module imports nothing back from that one). */
function tidy(item: CanvasItem): CanvasItem {
  const x = snap(item.box.x);
  const w = Math.min(snap(item.box.w), RIGHT - x);
  return { ...item, box: { x, y: snap(item.box.y), w, h: snap(item.box.h) } } as CanvasItem;
}

/** The most a snapped block may start above the block before it's drawn bottom and still be read as
 *  meeting it: the thousandth `tidy` rounds to, twice, with room for the sum's binary error. */
const ROUNDING = 0.0025;

/** The blocks' stack after the snap (the certification's `sealed`, with one change): the several-node
 *  blocks stand back to back in the flow (the order strip, the parts, the prices and the totals), and
 *  a thousandth rounded the wrong way, or the binary error of `y + h`, would draw the lower one above
 *  the upper one's bottom (rule 5). Each such block is moved down to the first thousandth at or below
 *  that bottom, and only by a rounding step (`ROUNDING`): a real overlap is left for the rules. The
 *  change: every later block moves with it (`shift`), so the drawn distances stay the flow's and the
 *  moves do not add up. The certification's moved each block on its own, so on four blocks back to
 *  back its moves added up past `ROUNDING` (in Liberation Serif the totals block was left 0.003 pt
 *  above the price block's bottom, measured on the invoice's stand-in). */
function sealed(items: CanvasItem[]): CanvasItem[] {
  const moved = new Map<string, number>();
  let bottom: number | null = null;
  let shift = 0;
  for (const t of tablesByY({ version: 1, items })) {
    let y = shift === 0 ? t.box.y : snap(t.box.y + shift);
    if (bottom !== null && y < bottom && bottom - y <= ROUNDING) {
      y = snap(bottom);
      while (y < bottom) y = snap(y + 0.001);
    }
    if (y !== t.box.y) {
      moved.set(t.id, y);
      shift = y - t.box.y;
    }
    bottom = y + t.box.h;
  }
  return items.map((i) => (moved.has(i.id) ? { ...i, box: { ...i.box, y: moved.get(i.id)! } } as CanvasItem : i));
}

/**
 * The company strip's band items (§4.4), given each one's height (null: not shown, the footer
 * section or the field hidden): x and widths from the flow's column arithmetic (the address the
 * strip's "*" column, the contact line `footerContact` and the phone `footerPhone` wide, left to
 * right from the left margin with no gap, a hidden field's column dropped, so with all three the
 * address is 244 at 24, the contact 180 at 268 and the phone 140 at 448), one top for all, the flow's
 * 754 where the tallest ends at or above the page's foot, else the tallest's bottom at the foot. Each
 * repeated, so the strip prints on every page.
 */
function stripItems(config: TemplateConfig, strip: InvoiceStripHeights, pageFooter: boolean): CanvasItem[] {
  const placed = STRIP.filter((s) => strip[STRIP_HEIGHT[s.key]] !== null);
  if (placed.length === 0) return [];
  const fixed = placed.reduce((sum, s) => sum + (s.width ?? 0), 0);
  const tallest = Math.max(...placed.map((s) => snap(strip[STRIP_HEIGHT[s.key]]!)));
  const foot = pageFoot(pageFooter);
  const top = STRIP_TOP + tallest <= foot ? STRIP_TOP : snap(foot - tallest);
  const bottom: CanvasAnchor = { kind: "page-bottom" };
  let x = LEFT;
  return placed.map((s) => {
    const w = s.width ?? CANVAS_PAGE.width - 2 * CANVAS_PAGE.margin - fixed;
    const item = fieldItem(config, s.key, { x, y: top, w, h: snap(strip[STRIP_HEIGHT[s.key]]!) }, bottom, true);
    x += w;
    return item;
  });
}

/**
 * The company strip's three heights, each laid out ALONE at its seeded x and width (the `aloneLayouts`
 * technique, the preview's measure's), from the item node the sheet prints it with; null for a field
 * not shown (the footer section or the field hidden). All are placed at one top, so the offset
 * `aloneLayouts` takes off each is 0 and each height is its end mark's top.
 */
export async function invoiceStrip(d: InvoicePdfData, config: TemplateConfig, logoDataUri?: string): Promise<InvoiceStripHeights> {
  const visible = sectionShown(config, "footer");
  const candidate: InvoiceStripHeights = {
    address: visible && shown(config, "footer", "footer_address") ? 0 : null,
    contact: visible && shown(config, "footer", "footer_contact") ? 0 : null,
    phone: visible && shown(config, "footer", "footer_phone") ? 0 : null,
  };
  const items = stripItems(config, candidate, config.pageFooter);
  if (items.length === 0) return candidate;
  const layout: CanvasLayout = { version: 1, items };
  const itemContent = invoiceCanvasItemContent(d, { ...config, layout }, logoDataUri);
  const alone = aloneLayouts({ layout, pageFooter: config.pageFooter, fonts: config.fonts, itemContent });
  const [positions] = await layOutSheetGroups(alone.map((a) => a.def));
  const heightOf = (key: string): number | null => {
    const item = items.find((i) => i.kind === "field" && i.key === key);
    if (item === undefined) return null;
    const end = positions.find((n) => n.id === CANVAS_IDS.itemEnd(item.id));
    if (end === undefined) throw new Error(`The strip's alone layout has no end for ${key}.`);
    return end.top;
  };
  return { address: heightOf("footer_address"), contact: heightOf("footer_contact"), phone: heightOf("footer_phone") };
}

/**
 * The items, from the positions of the one layout, in the order the flow draws them, and the strip's
 * band items. Each piece's anchor is the last block whose end the walk has passed, its `y` its top
 * less that block's laid-out end (the page's top: 0). A hidden field or section prints nothing, so
 * it has no position and seeds nothing; the addresses with both rows hidden seed no block; any other
 * block whose builder answered nothing seeds at the row floor from its start mark. The walk skips
 * every id outside the seed's namespace (`invoice-order-strip`, the measured row's own id, among them).
 */
export function seedInvoiceItems(
  config: TemplateConfig, positions: LaidOutNode[], strip: InvoiceStripHeights, logoPlaced: boolean, pageFooter: boolean,
): CanvasItem[] {
  const byId = new Map(positions.map((n) => [n.id, n] as const));
  const endOf = (key: string): number => {
    const node = byId.get(INVOICE_SEED_IDS.end(key));
    if (node === undefined) throw new Error(`The seed's layout has no position for ${INVOICE_SEED_IDS.end(key)}.`);
    return node.top;
  };

  const sideLogo = logoPlaced && config.logo !== null
    && (config.logo.placement === "header-left" || config.logo.placement === "header-right");
  const headerWidth = W.content - (sideLogo ? config.logo!.width + W.headerLogoGap : 0);
  const identityWidth = W.content - W.identityIndent - (shown(config, "identity", "remit_to") ? W.remitTo + W.identityGap : 0);

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
      // The addresses with both rows hidden print nothing on any invoice, and a rows block cannot
      // carry them otherwise: no block.
      if (block === "parties" && !shown(config, "parties", "bill_to") && !shown(config, "parties", "ship_to")) continue;
      // A block's drawn box is absolute: its y is its top. Its height is at least the profile's row
      // floor; the walk still passes it at its laid-out end, and the items below it ride its rendered
      // bottom on paper, so their offsets are the flow's. The sheet spaces the next block from this
      // one's DRAWN bottom, so every later block is drawn lower by the clamps above it (`lift`).
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
    } else if (HEADER.has(key)) {
      items.push(fieldItem(config, key, { x: node.left, y: top, w: headerWidth, h }, anchor));
    } else if (IDENTITY_LINES.has(key)) {
      items.push(fieldItem(config, key, { x: node.left, y: top, w: identityWidth, h }, anchor));
    } else if (key === "remit_to") {
      items.push(fieldItem(config, key, { x: node.left, y: top, w: W.remitTo, h }, anchor));
    } else {
      throw new Error(`The invoice's seed has no item for ${key}.`);
    }
  }
  return sealed([...items, ...stripItems(config, strip, pageFooter)].map(tidy));
}

/**
 * The repeat (§4.4, call 2): the invoice number repeats where it stands page-top at least one grid
 * step above the first block's top (rule 3's own comparison), with no shift ever; otherwise nothing
 * repeats (the number hidden, or printed below a block, or no block placed).
 */
export function withRepeat(items: CanvasItem[]): CanvasItem[] {
  const number = items.find((i) => i.kind === "field" && i.key === "invoice_no" && i.anchor.kind === "page-top");
  const first = tablesByY({ version: 1, items })[0];
  if (number === undefined || first === undefined) return items;
  if (number.box.y + number.box.h + CANVAS_GRID > first.box.y) return items;
  return items.map((item) => (item === number ? { ...item, repeat: true } : item));
}

/** A column section's columns as the flow prints its grid under them (`ctxOf`'s `slotNum`, through the
 *  flow's own lens): in its order, each with its visibility and its width resolved, typed or the
 *  contract's (`"*"` for the Information column untyped), a hidden column reserving none (0). Labels
 *  are left out: under a hidden section no column header prints. */
function resolvedColumns(sc: SectionConfig): { key: string; visible: boolean; width: number | "*" }[] {
  const view = INVOICE_FLOW.sectionView(sc);
  return view.order.map((key) => {
    const f = view.field(key);
    return { key, visible: f.visible, width: f.visible ? f.width : 0 };
  });
}

/** The Standard's column headers: the contract's columns in its order, each shown at its own width. */
const STANDARD_COLUMNS: SectionConfig = {
  key: "column_header",
  visible: true,
  fields: INVOICE_CONTRACT.sections.find((s) => s.key === "column_header")!.fields
    .map((f) => ({ key: f.key, visible: true, label: null, width: null })),
};

/**
 * Whether the config hides its Column headers while setting their columns apart from the Standard's
 * (design §15, sentence 1): their order, a column's visibility, or its width as the flow resolves it
 * (a typed width equal to the contract's is the Standard's), labels aside. The flow aligns its body to
 * the hidden section's columns all the same; the seed places no block for a hidden section, and a
 * canvas with no Column headers block prints its body under the contract's columns (`gridOf`), so
 * such a canvas would not print today's paper. A shown section seeds its block, columns and all.
 */
export function gridDiffers(config: TemplateConfig): boolean {
  const section = config.sections.find((s) => s.key === "column_header");
  if (section === undefined || section.visible) return false;
  return JSON.stringify(resolvedColumns(section)) !== JSON.stringify(resolvedColumns(STANDARD_COLUMNS));
}

/** The header's pieces, which print in the header's row beside a side logo. */
const inHeader = (item: CanvasItem): boolean => item.kind === "logo" || (item.kind === "field" && HEADER.has(item.key));
/** The identity's pieces: its three lines and the Remit To box beside them. */
const inIdentity = (item: CanvasItem): boolean =>
  item.kind === "field" && (IDENTITY_LINES.has(item.key) || item.key === "remit_to");

/**
 * The part of the seeded layout that runs past the page's right margin, else null: a header piece, or
 * an identity line or the Remit To box, left no width once `tidy` has clamped its right edge to the
 * margin. A side logo takes its own width and the gap from the header's "*" column, and pdfmake widens
 * a "*" column to its longest word (the title at a large heading size), pushing the pieces past the
 * margin; the identity's "*" column widens the same way to a long unbroken label and pushes the Remit
 * To box along. The stand-in's own text is fixed, so only the template's settings cause either. A
 * piece pushed only part of the way keeps a clamped width and seeds (open question 11).
 */
function pastTheRightMargin(layout: CanvasLayout): "header" | "identity" | null {
  if (layout.items.some((item) => inHeader(item) && item.box.w <= 0)) return "header";
  if (layout.items.some((item) => inIdentity(item) && item.box.w <= 0)) return "identity";
  return null;
}

/**
 * How many thousandths of a point a drawn bottom must stand above the band's top (the bill of lading's
 * `FIT_CLEARANCE`, bol-canvas-seed.ts, whose reasoning carries: every seeded figure is snapped to a
 * thousandth, so a printed bottom stands up to half a thousandth per block either side of the drawn
 * one). No case pins the value: at 0 the seed's suite stays green, the bill of lading's residual.
 */
const FIT_CLEARANCE = 2;

/**
 * Whether the seeded layout's drawn stack fits the canvas's one page (design §5.3, open question 7):
 * the bill of lading's check over every item's drawn box (`drawnBox`, an item below a block included,
 * which rule 4 does not judge), counted in whole thousandths. A block, a page-top item and an item
 * below a block end at least `FIT_CLEARANCE` thousandths above the band's top; a page-bottom item ends
 * at most on the page's foot, with no clearance, since the strip is placed by construction with its
 * bottom ON the foot whenever it does not fit at 754 (every seed with the page line on); and the first
 * block has the profile's room for its first lines above the band (the certification's clause, rule
 * 8's room, a backstop no stand-in reaches: the first block starts near the page's top). The flow runs
 * its content down to its 44 pt bottom margin (748); the canvas stops at the band's top, which with
 * the page line on is the strip's top (about 739), and the band rises with the strip's own height.
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
  return drawnFits && (first === undefined || first.box.y + canvasProfile(INVOICE_CONTRACT).firstTableRoom <= band);
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
  const floor = widthFloorRefusal({ version: 1, items }, INVOICE_CONTRACT, { fonts: config.fonts });
  if (floor !== null) throw new HttpError(400, floor.sentence);
}

/**
 * The layout that prints the submitted flow config's invoice for the picked invoice or credit (§5.3).
 * `config` is validated by the caller with its own `layout` set aside; `logoDataUri` is the version's
 * logo where the config places it. The record is read as the preview reads it (`readInvoicePdfData`
 * with `invoicePrintSettings`, on one read-only RepeatableRead transaction), a draft and a discarded
 * one included, and an id naming none is refused in its 404.
 */
export async function seedInvoiceLayout(
  recordId: string, config: TemplateConfig, logoDataUri: string | undefined,
): Promise<CanvasLayout> {
  // A config check, before any read: the record cannot change it.
  if (gridDiffers(config)) {
    throw new HttpError(400,
      `The canvas starts from today's paper, and this template hides its Column headers while setting their columns apart from the Standard's (their order, widths or which are shown); a canvas with no Column headers block prints the body under the Standard's columns. Show the Column headers, or set their columns back to the Standard's, before designing on a canvas.`);
  }
  widthFloorsFirst(config);
  const settings = await invoicePrintSettings();
  const data = await readOnly((tx) => readInvoicePdfData(tx, recordId, settings));
  const standIn = invoiceStandIn(data, config);
  const laid = await renderSheetGroupsWithPositions([buildInvoiceDefinition(standIn, config, logoDataUri, { seedIds: true })]);
  // A canvas stacks the blocks on one page. At the stand-in's lengths only the template's settings can
  // put the invoice on a second page, so the sentence names them.
  const pages = laid.groups[0].pages;
  if (pages > 1) {
    throw new HttpError(400,
      `The canvas starts from a one-page invoice; laid out at its least, this template's invoice prints ${pages} pages. Change this template's settings (its font, sizes or logo) so it fits one page.`);
  }
  const strip = await invoiceStrip(standIn, config, logoDataUri);
  const items = seedInvoiceItems(config, laid.groups[0].positions, strip, logoDataUri !== undefined, config.pageFooter);
  const layout: CanvasLayout = { version: 1, items: withRepeat(items) };
  // The width first: a piece left with no width can make the stack taller, and the height sentence
  // would then name the wrong settings.
  const past = pastTheRightMargin(layout);
  if (past === "header") {
    throw new HttpError(400,
      `The canvas starts from an invoice whose header fits the page; laid out at its least, this template's header runs past the page's right margin. Change this template's settings (its logo's width, font or heading size) so the header fits the page's width.`);
  }
  if (past === "identity") {
    throw new HttpError(400,
      `The canvas starts from an invoice whose identity lines and Remit To box fit the page; laid out at its least, this template's Remit To box runs past the page's right margin. Change this template's settings (its font, sizes or labels) so they fit the page's width.`);
  }
  // One page in the flow is not yet one page on the canvas (design §5.3: the drawn stack must fit the
  // page rule 4 judges). Where it does not, only the template's settings put it there, so the sentence
  // names them, the page line among them; the flow printed one page, so it names no page count.
  if (!fitsTheCanvas(layout, config.pageFooter)) {
    throw new HttpError(400,
      `The canvas starts from a one-page invoice; laid out at its least on the canvas, this template's invoice runs past one page. Change this template's settings (its font, sizes, logo or page line) so it fits one page.`);
  }
  // A block the template's columns leave narrower than its least width (rule 4's or rule 9's floor,
  // #971 design §6) is the template's to change: the 400 in the rule's own sentence.
  const floor = floorRefusal(layout, INVOICE_CONTRACT, { pageFooter: config.pageFooter, fonts: config.fonts });
  if (floor !== null) throw new HttpError(400, floor.sentence);
  // Every other rule the layout must pass is the seed's to meet: the settings that can break one (the
  // Column headers' columns, the page count, the header's and the identity's widths, the drawn stack's
  // fit) are refused above in their own sentences, so a refusal here is the seed's fault, not mapped to
  // a 400, and surfaces as the fault it is.
  validateCanvasLayout(layout, INVOICE_CONTRACT, { pageFooter: config.pageFooter, fonts: config.fonts });
  return layout;
}
