/**
 * The canvas SEED (design `docs/superpowers/specs/2026-11-07-traveler-canvas-designer-design.md` §5.4,
 * ruling 5; PR B of #926): a traveler draft's canvas starts from today's paper. The flow template the
 * editor holds is laid out ONCE for the picked order, and every piece is read back from where it
 * landed, so the `CanvasLayout` answered prints the same lines in the same places. Nothing is
 * stored: the editor applies the answer as an ordinary config edit, unsaved until saved.
 *
 * The flow builder marks its pieces only when asked (`buildTravelerDefinitions`' `seedIds`, the
 * `SEED_IDS` in traveler.ts): an id on a wrapper stack, a table cell's stack, an image or a `mark()`,
 * never on a text node, which pdfmake refuses to repeat and turns into a named destination. Header
 * pieces carry an end mark for their height; each section block has a `start` and an `end` mark at
 * the top level of the sheet's stack, where a position is exact.
 *
 * The results and sign-off block (`traveler-results`) is the exception the positions cannot serve
 * directly (the controller's Ruling 4): `prepareTravelerLayout` marks it `unbreakable` when it fits
 * a page, and pdfmake reports every node inside an unbreakable block at the block's start. So the
 * block's start comes from its `start` mark, and the block is laid out a second time ALONE, cloned
 * under another id so it stays breakable, on a page with no top margin: each cell's top there is
 * its offset within the block. Its cells' x and widths come from the tables' own widths, resolved
 * as pdfmake resolves them (`resolvedColumns`).
 *
 * The footer's items are anchored below the steps table, the table above them in the flow (design
 * §14 call 8: the flow paper does not pin them to the page's foot), and the process pairs below the
 * table above the process row, so both ride their table's rendered bottom as the flow's do.
 *
 * The seed needs a picked order (the owner's ruling at PR B's hand-over): the design's SAMPLE sheet
 * reads a part the route cannot name, so `recordId` is required, as the preview's is, and the order's
 * first load is laid out, as the preview lays it out (R17).
 *
 * The shipping ticket's seed (the shipping ticket design of 2026-11-08 §5.3, `seedTicketLayout`
 * below) is the same method over the ticket's flow; the bill of lading's (design 2026-11-09 §5.3)
 * lives in its own module, `bol-canvas-seed.ts` (`seedBolLayout`), the certification's (design
 * 2026-11-10 §5.3) in its own, `cert-canvas-seed.ts` (`seedCertLayout`), the invoice's (design
 * 2026-11-10 §5.3) in `invoice-canvas-seed.ts` (`seedInvoiceLayout`), the statement's (design
 * 2026-11-11 §5.3) in `statement-canvas-seed.ts` (`seedStatementLayout`) and the quotation's (design
 * 2026-11-12 §5.3, since quote canvas PR 2) in `quote-canvas-seed.ts` (`seedQuoteLayout`) and the
 * container tag's (design 2026-11-13 §7.4, since container tag PR 3) in `container-tag-canvas-seed.ts`
 * (`seedContainerTagLayout`): `seedCanvasLayout` dispatches on the docType, every type having an arm,
 * and a type whose contract offers no canvas is refused in `canvasProfile`'s own words, and one whose
 * canvas does not print in the later-release sentence (`assertCanvasPrints`), each reached today only
 * by the tests' stubbed docType.
 */
import type { Content } from "pdfmake/interfaces";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { readDetail } from "./orders";
import { readShippingTicketData, ticketSettings } from "./shippers";
import { TICKET_SEED_IDS, buildShippingTicketDefinitions, type TicketDocType } from "./pdf/shipping-ticket";
import { mark } from "./pdf/canvas-nodes";
import {
  FOOTER_SIGNOFF_WIDTHS, HEADER_GAP, HEADER_LEFT_WIDTH, HEADER_RIGHT_WIDTH, SEED_IDS,
  buildTravelerDefinitions, readTravelerData, travelerSettings,
} from "./traveler";
import {
  LAYOUT, TABLE_LAYOUTS, jpegDataUri, pngDataUri, renderSheetGroupsWithPositions,
  type LaidOutNode, type RenderableDefinition,
} from "./pdf/render";
import type { PreviewContext } from "./template-preview";
import { seedBolLayout } from "./bol-canvas-seed";
import { seedCertLayout } from "./cert-canvas-seed";
import { seedInvoiceLayout } from "./invoice-canvas-seed";
import { seedStatementLayout } from "./statement-canvas-seed";
import { seedQuoteLayout } from "./quote-canvas-seed";
import { seedContainerTagLayout } from "./container-tag-canvas-seed";
import { templatePlacesLogo } from "@/lib/template-contracts/template-logo";
import { TRAVELER_CONTRACT } from "@/lib/template-contracts/traveler";
import { CONTENT_WIDTH, TemplateConfigError, type TemplateConfig } from "@/lib/template-contracts/types";
import { assertCanvasPrints, contractFor, validateConfig } from "@/lib/template-contracts/index";
import { canvasProfile, pageFoot, tableSpec } from "@/lib/template-canvas";
import {
  CANVAS_PAGE, CANVAS_TABLES, type CanvasAnchor, type CanvasBox, type CanvasItem, type CanvasLayout,
  type CanvasTextStyle,
} from "@/lib/template-contracts/canvas";

const LEFT = CANVAS_PAGE.margin;
const RIGHT_SLOT_X = CANVAS_PAGE.width - CANVAS_PAGE.margin - HEADER_RIGHT_WIDTH;

/** A table layout's rule and padding, as `render.ts` draws it; pdfmake's default top and bottom
 *  padding (2) where the layout states none, as `boxed` and `ruled` do not. */
function tableGeometry(name: typeof LAYOUT.boxed | typeof LAYOUT.ruled) {
  const layout = TABLE_LAYOUTS[name] as { hLineWidth: () => number; vLineWidth: () => number; paddingLeft: () => number };
  return { rule: layout.hLineWidth(), vRule: layout.vLineWidth(), padX: layout.paddingLeft(), padY: 2 };
}
export const BOXED = tableGeometry(LAYOUT.boxed);
const RULED = tableGeometry(LAYOUT.ruled);

/** One straight stroke on a line: horizontal at `at` (a y) or vertical at `at` (an x), from..to. */
type Stroke = { axis: "h" | "v"; at: number; from: number; to: number };

/**
 * A table's column boundaries as pdfmake lays it out (`DocMeasure.getOffsets`, `TableProcessor`'s
 * row-span data): each column takes its content width plus both paddings and its left rule, and a
 * `"*"` column shares what the fixed ones leave. `edges[j]` is column j's left edge from the table's
 * x, `edges[n]` the right rule's; the table is `edges[n] + vRule` wide.
 */
function resolvedColumns(widths: readonly (number | "*")[], tableWidth: number, g: typeof BOXED): number[] {
  const offsets = widths.length * (2 * g.padX + g.vRule) + g.vRule;
  const fixed = widths.reduce<number>((sum, w) => sum + (w === "*" ? 0 : w), 0);
  const stars = widths.filter((w) => w === "*").length;
  const star = stars === 0 ? 0 : (tableWidth - offsets - fixed) / stars;
  const edges = [0];
  for (const w of widths) edges.push(edges.at(-1)! + 2 * g.padX + g.vRule + (w === "*" ? star : w));
  return edges;
}

/** The strokes a one-cell boxed table at `box` draws (a hand-written canvas item, `boxedCell` in
 *  traveler-canvas.ts): its rules centred inside its box, the horizontal ones stopping short of the
 *  right rule as pdfmake's do. */
function boxedOutline(box: CanvasBox): Stroke[] {
  const half = BOXED.rule / 2;
  return [
    { axis: "h", at: box.y + half, from: box.x, to: box.x + box.w - BOXED.vRule },
    { axis: "h", at: box.y + box.h - half, from: box.x, to: box.x + box.w - BOXED.vRule },
    { axis: "v", at: box.x + half, from: box.y, to: box.y + box.h },
    { axis: "v", at: box.x + box.w - half, from: box.y, to: box.y + box.h },
  ];
}

/** A boxed grid's strokes: a full-width rule at each row's top and at the bottom, and in each row a
 *  rule at each cell's edge (`rows[i].cells`, indexes into `edges`), from the row's top to under the
 *  next row's top rule, as `TableProcessor` draws them. */
function gridStrokes(x: number, edges: number[], rows: { top: number; cells: number[] }[], bottom: number): Stroke[] {
  const half = BOXED.rule / 2;
  const width = edges.at(-1)!;
  const out: Stroke[] = [];
  rows.forEach((row, i) => {
    const next = i + 1 < rows.length ? rows[i + 1].top : bottom - BOXED.rule;
    out.push({ axis: "h", at: row.top + half, from: x, to: x + width });
    for (const j of row.cells) out.push({ axis: "v", at: x + edges[j] + half, from: row.top, to: next + BOXED.rule });
  });
  out.push({ axis: "h", at: bottom - half, from: x, to: x + width });
  return out;
}

/** What of `drawn` the `covered` strokes do not ink: each stroke less every covering stroke on its
 *  own line, the remainders kept where longer than a hair. */
function uncovered(drawn: Stroke[], covered: Stroke[]): Stroke[] {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.05;
  const out: Stroke[] = [];
  for (const stroke of drawn) {
    let parts: [number, number][] = [[stroke.from, stroke.to]];
    for (const c of covered) {
      if (c.axis !== stroke.axis || !near(c.at, stroke.at)) continue;
      parts = parts.flatMap(([a, b]): [number, number][] => {
        if (c.to <= a + 0.05 || c.from >= b - 0.05) return [[a, b]];
        return [[a, Math.max(a, c.from)], [Math.min(b, c.to), b]].filter(([p, q]) => q - p > 0.05) as [number, number][];
      });
    }
    for (const [from, to] of parts) out.push({ ...stroke, from, to });
  }
  return out;
}

const pageTop: CanvasAnchor = { kind: "page-top" };
const HEADER_KEYS = new Set(TRAVELER_CONTRACT.sections.find((s) => s.key === "header")!.fields.map((f) => f.key));

function lineItem(stroke: Stroke, anchor: CanvasAnchor, weight: number): CanvasItem {
  const box = stroke.axis === "h"
    ? { x: stroke.from, y: stroke.at, w: stroke.to - stroke.from, h: 0 }
    : { x: stroke.at, y: stroke.from, w: 0, h: stroke.to - stroke.from };
  return { kind: "line", id: crypto.randomUUID(), box, anchor, repeat: false, weight };
}

/** The flow's own size and weight for a header piece (`headerBlock`): the customer line's 9.5 bold,
 *  the company name bold at the heading size, the rest plain at the base size (a canvas field prints
 *  the order and load labels bold itself, as the flow does), the centre slot and the numbers centred. */
function headerStyle(key: string, config: TemplateConfig): CanvasTextStyle {
  const base = config.fonts.baseSize;
  if (key === "customer_name") return { size: 9.5, bold: true, align: "left" };
  if (key === "company_name") return { size: config.fonts.headingSize, bold: true, align: "center" };
  if (key.startsWith("company_")) return { size: base, bold: false, align: "center" };
  if (key === "order_number" || key === "load_number") return { size: base, bold: false, align: "center" };
  return { size: base, bold: false, align: "left" };
}

/** The config's field entry, for its typed label. */
function fieldConfig(config: TemplateConfig, section: string, key: string) {
  return config.sections.find((s) => s.key === section)?.fields.find((f) => f.key === key);
}

/** A field item, its label the config's (null: the contract's default, as the flow reads it). */
function fieldItem(
  config: TemplateConfig, section: string, key: string, box: CanvasBox, anchor: CanvasAnchor, style: CanvasTextStyle,
): CanvasItem {
  return {
    kind: "field", id: crypto.randomUUID(), key, label: fieldConfig(config, section, key)?.label ?? null,
    box, anchor, repeat: key === "order_number" || key === "load_number", style,
  };
}

/** Builds the seed from the laid-out positions of the one sheet and of the results block alone. */
function seedItems(config: TemplateConfig, sheet: LaidOutNode[], footer: LaidOutNode[], logoPlaced: boolean): CanvasItem[] {
  const at = (nodes: LaidOutNode[], id: string) => nodes.find((n) => n.id === id);
  const must = (nodes: LaidOutNode[], id: string): LaidOutNode => {
    const node = at(nodes, id);
    if (node === undefined) throw new Error(`The seed's layout has no position for ${id}.`);
    return node;
  };
  const items: CanvasItem[] = [];

  // The header's three slots: the left at the margin, the right a fixed 190 at the right margin, the
  // centre wherever pdfmake put it (it widens a "*" slot to its widest word), so the two "*" slots'
  // widths are read off the layout when a centre piece printed.
  const centreLeft = sheet.find((n) => /^seed:(company_|logo$)/.test(n.id) && n.left > LEFT + 1 && n.left < RIGHT_SLOT_X - 1)?.left
    ?? LEFT + HEADER_LEFT_WIDTH + HEADER_GAP;
  const leftWidth = centreLeft - HEADER_GAP - LEFT;
  const centreWidth = RIGHT_SLOT_X - HEADER_GAP - centreLeft;
  const slot = (left: number) => (left < centreLeft - 0.5 ? { x: LEFT, w: leftWidth }
    : left < RIGHT_SLOT_X - 0.5 ? { x: centreLeft, w: centreWidth } : { x: RIGHT_SLOT_X, w: HEADER_RIGHT_WIDTH });
  const loadLeft = at(sheet, SEED_IDS.piece("load_number"))?.left;
  const receivedLines = sheet.filter((n) => n.id.startsWith("seed:received_from:"));

  // The header, in the order it draws: the left stack, the centre stack, the right stack (the
  // positions are in document order, and the header is the sheet's first block).
  for (const node of sheet) {
    const key = node.id.slice("seed:".length);
    if (key === "barcode") {
      items.push({ kind: "barcode", id: crypto.randomUUID(), box: { x: node.left, y: node.top, w: 186, h: 44 }, anchor: pageTop, repeat: true });
      continue;
    }
    if (key === "logo" && logoPlaced && config.logo !== null) {
      const s = slot(node.left);
      const width = config.logo.width;
      // A centred slot centres its image (pdfmake's `alignImage`); the position is the slot's left.
      const x = config.logo.placement === "header-center" ? s.x + (s.w - width) / 2 : node.left;
      const h = must(sheet, SEED_IDS.end("logo")).top - node.top;
      items.push({ kind: "logo", id: crypto.randomUUID(), box: { x, y: node.top, w: width, h }, anchor: pageTop, repeat: false });
      continue;
    }
    if (key === "received_from:0") {
      const last = receivedLines.at(-1)!.id.slice("seed:".length);
      const h = must(sheet, SEED_IDS.end(last)).top - node.top;
      items.push(fieldItem(config, "header", "received_from", { x: LEFT, y: node.top, w: leftWidth, h }, pageTop, headerStyle("received_from", config)));
      continue;
    }
    if (!HEADER_KEYS.has(key) || key === "received_from") continue;
    const h = must(sheet, SEED_IDS.end(key)).top - node.top;
    let box: CanvasBox;
    if (key === "order_number") {
      box = { x: node.left, y: node.top, w: (loadLeft ?? RIGHT_SLOT_X + HEADER_RIGHT_WIDTH) - node.left, h };
    } else if (key === "load_number") {
      box = { x: node.left, y: node.top, w: RIGHT_SLOT_X + HEADER_RIGHT_WIDTH - node.left, h };
    } else if (key === "po_number") {
      // The PO prints in a column of the left slot's share whatever the slot's width (`headerBlock`).
      box = { x: LEFT, y: node.top, w: HEADER_LEFT_WIDTH, h };
    } else {
      const s = slot(node.left);
      box = { x: s.x, y: node.top, w: s.w, h };
    }
    items.push(fieldItem(config, "header", key, box, pageTop, headerStyle(key, config)));
  }

  // The tables, in the flow's order, each its block's rectangle: the content width wide, from its
  // start mark to its end mark (the table's own bottom, its margin below it).
  const blocks = [...new Set(sheet.filter((n) => n.id.startsWith("seed:start:")).map((n) => n.id.slice("seed:start:".length)))];
  const tableEnd = new Map<string, LaidOutNode>();
  let above: (typeof CANVAS_TABLES)[number] | null = null;
  /** The table above each block, which its items hang below. */
  const anchorOf = new Map<string, (typeof CANVAS_TABLES)[number] | null>();
  for (const section of blocks) {
    anchorOf.set(section, above);
    if (!(CANVAS_TABLES as readonly string[]).includes(section)) continue;
    const key = section as (typeof CANVAS_TABLES)[number];
    const start = must(sheet, SEED_IDS.start(key));
    const end = must(sheet, SEED_IDS.end(key));
    tableEnd.set(key, end);
    const sc = config.sections.find((s) => s.key === key)!;
    const columns = sc.fields
      .filter((f) => TRAVELER_CONTRACT.sections.flatMap((s) => s.fields).find((c) => c.key === f.key)?.column?.table === key)
      .map((f) => ({ key: f.key, visible: f.visible, label: f.label, width: typeof f.width === "number" ? f.width : null }));
    const headingKey = key === "inspections" ? "inspections_title" : key === "steps" ? "steps_title" : null;
    items.push({
      kind: "table", id: crypto.randomUUID(), key,
      // A table that runs onto the next page (a long steps list) is drawn to the page's foot: a
      // drawn box is the editor's picture of where a table starts, and the items below it ride its
      // rendered bottom, measured on the page it ends on, whatever its drawn height.
      box: {
        x: LEFT, y: start.top, w: CONTENT_WIDTH,
        h: end.page === start.page ? end.top - start.top : pageFoot(config.pageFooter) - start.top,
      },
      anchor: above === null ? pageTop : { kind: "below-table", table: above },
      repeat: false, heading: headingKey === null ? null : fieldConfig(config, key, headingKey)?.label ?? null, columns,
    });
    above = key;
  }

  /** A block's anchor and the y its offsets are taken from (the anchor table's rendered bottom, or
   *  the page's top when no table is above it). */
  const base = (section: string): { anchor: CanvasAnchor; y: number } => {
    const table = anchorOf.get(section) ?? null;
    return table === null ? { anchor: pageTop, y: 0 } : { anchor: { kind: "below-table", table }, y: tableEnd.get(table)!.top };
  };

  // The process row: each visible pair a field item over its two cells, its text where the flow's
  // label printed (a ruled table's cells are in no block, so their positions are exact), and the
  // row's two rules as line items.
  if (blocks.includes("process")) {
    const { anchor, y } = base("process");
    const start = must(sheet, SEED_IDS.start("process")).top;
    const end = must(sheet, SEED_IDS.end("process")).top;
    const pairs = ["process", "material", "process_id"]
      .map((key) => ({ key, node: at(sheet, SEED_IDS.piece(key)) }))
      .filter((p): p is { key: string; node: LaidOutNode } => p.node !== undefined)
      .sort((a, b) => a.node.left - b.node.left);
    pairs.forEach(({ key, node }, i) => {
      const right = i + 1 < pairs.length ? pairs[i + 1].node.left - RULED.padX : LEFT + CONTENT_WIDTH;
      const box = { x: node.left, y: node.top - y, w: right - RULED.padX - node.left, h: end - RULED.rule - RULED.padY - node.top };
      items.push(fieldItem(config, "process", key, box, anchor, { size: config.fonts.baseSize, bold: false, align: "left" }));
    });
    const half = RULED.rule / 2;
    for (const at of [start + half, end - half]) {
      items.push(lineItem({ axis: "h", at: at - y, from: LEFT, to: LEFT + CONTENT_WIDTH }, anchor, RULED.rule));
    }
  }

  // The results and sign-off block, from its alone layout (Ruling 4): each label's cell a field item,
  // and every rule of the two boxed grids that no item's own outline draws a line item.
  if (blocks.includes("footer")) {
    const { anchor, y } = base("footer");
    const startMark = must(sheet, SEED_IDS.start("footer"));
    const anchorPage = anchor.kind === "below-table" ? tableEnd.get(anchor.table)!.page : 1;
    const offset = startMark.page === anchorPage ? startMark.top - y : 0;
    const resultsEnd = at(footer, SEED_IDS.tableEnd("results"));
    const signoffEnd = at(footer, SEED_IDS.tableEnd("signoff"));
    const columnWidth = CONTENT_WIDTH / ((resultsEnd ? 1 : 0) + (signoffEnd ? 1 : 0));
    const rowTop = (node: LaidOutNode) => node.top - BOXED.rule - BOXED.padY;
    const drawn: Stroke[] = [];
    const outlines: Stroke[] = [];
    const place = (key: string, box: CanvasBox) => {
      const shifted = { ...box, y: box.y + offset };
      items.push(fieldItem(config, "footer", key, shifted, anchor, { size: config.fonts.baseSize, bold: true, align: "left" }));
      outlines.push(...boxedOutline(shifted));
    };

    if (resultsEnd) {
      const head = must(footer, SEED_IDS.piece("results"));
      const body = must(footer, SEED_IDS.body("results"));
      const edges = resolvedColumns(["*"], columnWidth, BOXED);
      place("results", { x: LEFT, y: rowTop(head), w: columnWidth, h: resultsEnd.top - rowTop(head) });
      drawn.push(...gridStrokes(LEFT, edges, [
        { top: rowTop(head) + offset, cells: [0, 1] }, { top: rowTop(body) + offset, cells: [0, 1] },
      ], resultsEnd.top + offset));
    }
    if (signoffEnd) {
      const x = LEFT + (resultsEnd ? columnWidth : 0);
      const edges = resolvedColumns(FOOTER_SIGNOFF_WIDTHS, columnWidth, BOXED);
      const keys = ["tempered_results", "final_inspection", "pass", "fail", "tested_by", "tested_date", "ok_to_ship", "ship_date"];
      const pieces = keys
        .map((key) => ({ key, node: at(footer, SEED_IDS.piece(key)) }))
        .filter((p): p is { key: string; node: LaidOutNode } => p.node !== undefined);
      const tempered = at(footer, SEED_IDS.body("tempered_results"));
      const tops = [...new Set([...pieces.map((p) => rowTop(p.node)), ...(tempered ? [rowTop(tempered)] : [])])].sort((a, b) => a - b);
      const bottomOf = (top: number) => {
        const i = tops.indexOf(top);
        return i + 1 < tops.length ? tops[i + 1] + BOXED.rule : signoffEnd.top;
      };
      /** The column a piece's cell starts at, from its content's x. */
      const columnOf = (node: LaidOutNode) => {
        const rel = node.left - x - BOXED.vRule - BOXED.padX;
        return edges.reduce((best, edge, j) => (Math.abs(edge - rel) < Math.abs(edges[best] - rel) ? j : best), 0);
      };
      const rows = new Map<number, Set<number>>(tops.map((top) => [top, new Set([0, 4])]));
      for (const { key, node } of pieces) {
        const top = rowTop(node);
        const full = key === "tempered_results" || key === "final_inspection";
        const from = full ? 0 : columnOf(node);
        const to = full ? 4 : from + 2;
        // TEMPERED RESULTS' item takes its head and its writing row together.
        const bottom = key === "tempered_results" && tempered ? bottomOf(rowTop(tempered)) : bottomOf(top);
        place(key, { x: x + edges[from], y: top, w: edges[to] - edges[from] + BOXED.vRule, h: bottom - top });
        rows.get(top)!.add(from).add(to);
        // A checkbox has its own cell beside its label (`footerBlocks`' pass/fail row).
        if (key === "pass" || key === "fail") rows.get(top)!.add(from + 1);
      }
      // A half the config hides leaves its cell in the row, with its edges (`labelHalf`): the
      // tested and ship rows' halves sit at fixed columns, the pass/fail row's cells are single.
      for (const [top, cells] of rows) {
        const row = pieces.filter((p) => rowTop(p.node) === top).map((p) => p.key);
        if (row.some((k) => ["tested_by", "tested_date", "ok_to_ship", "ship_date"].includes(k))) cells.add(2);
        if (row.some((k) => k === "pass" || k === "fail")) for (const j of [1, 2, 3]) cells.add(j);
      }
      drawn.push(...gridStrokes(x, edges,
        tops.map((top) => ({ top: top + offset, cells: [...rows.get(top)!].sort((a, b) => a - b) })), signoffEnd.top + offset));
    }
    for (const stroke of uncovered(drawn, outlines)) items.push(lineItem(stroke, anchor, BOXED.rule));
  }
  return items.map(tidy);
}

/** A box's figures to a thousandth of a point, and its right edge never past the page's right
 *  margin: positions summed in floating point land a hair past 588 where the flow printed at it,
 *  and the validator refuses a box past it by any amount. */
function tidy(item: CanvasItem): CanvasItem {
  const snap = (n: number) => Math.round(n * 1000) / 1000;
  const right = CANVAS_PAGE.width - CANVAS_PAGE.margin;
  const x = snap(item.box.x);
  const w = Math.min(snap(item.box.w), right - x);
  return { ...item, box: { x, y: snap(item.box.y), w, h: snap(item.box.h) } } as CanvasItem;
}

/** Read-only, on one RepeatableRead snapshot, as the preview reads (`template-preview.ts`). */
function readOnly<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/** The results block of a definition's content, the one node carrying `traveler-results`. */
function resultsBlock(content: unknown): object | null {
  if (!content || typeof content !== "object") return null;
  if ("id" in content && content.id === "traveler-results") return content;
  for (const value of Object.values(content)) {
    const found = resultsBlock(value);
    if (found !== null) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The shipping ticket's seed (the shipping ticket design of 2026-11-08 §5.3). The flow builder marks
// its pieces under `seedIds` (`TICKET_SEED_IDS`, pdf/shipping-ticket.ts) and, under
// `seedPlaceholders`, prints one blank serial line on a ticket that flags none, so the serial list
// has a height to seed. The shipment's FIRST ticket is laid out once; the tear-off strip, which the
// flow keeps `unbreakable` (every node inside it reports the block's start), is laid out once more
// ALONE, the traveler's Ruling 4 technique, and each strip piece's top there is its offset within
// the block.
// ---------------------------------------------------------------------------------------------

/** The flow's header slots (`headerBlock`): `["*", 170, 130]` with a 10 pt gap. */
const TICKET_CENTRE_WIDTH = 170;
const TICKET_RIGHT_WIDTH = 130;
const TICKET_HEADER_GAP = 10;
const TICKET_RIGHT_X = CANVAS_PAGE.width - CANVAS_PAGE.margin - TICKET_RIGHT_WIDTH;
/** The flow's party slots (`partiesBlock`): `[*, 50, *]` with no gap, each `(564 − 50) / 2`. */
const PARTY_WIDTH = (CONTENT_WIDTH - 50) / 2;
/** The strip's three rows (`tearOff`): their columns' widths and gaps, and the boxed pair's columns. */
const STRIP_FIRST = { widths: ["*", 150, 200] as (number | "*")[], gap: 8 };
const STRIP_RECEIVED = { widths: [220, "*"] as (number | "*")[], gap: 0 };
const STRIP_SOLD = { widths: ["*", 180] as (number | "*")[], gap: 0 };
const PAIR_WIDTHS: (number | "*")[] = ["*", 62];
/** The flow's heavy rules (`rule`): the liability block's and the strip's. */
const HEAVY_RULE = 1.5;
/** The id the strip's alone layout carries: one the renderer does not measure (`KEPT_TOGETHER`). */
const STRIP_ALONE_ID = "seed:tear_off_alone";

/** Each column's x of a row of columns pdfmake lays out over the content width: a `"*"` column
 *  shares what the fixed ones and the gaps leave. */
function columnXs(row: { widths: (number | "*")[]; gap: number }): { x: number; w: number }[] {
  const fixed = row.widths.reduce<number>((sum, w) => sum + (w === "*" ? 0 : w), 0);
  const stars = row.widths.filter((w) => w === "*").length;
  const star = stars === 0 ? 0 : (CONTENT_WIDTH - fixed - row.gap * (row.widths.length - 1)) / stars;
  let x: number = LEFT;
  return row.widths.map((w) => {
    const width = w === "*" ? star : w;
    const column = { x, w: width };
    x += width + row.gap;
    return column;
  });
}

/** The flow's own size, weight and alignment for a ticket piece (`headerBlock`, `tearOff`). */
function ticketStyle(key: string, config: TemplateConfig): CanvasTextStyle {
  switch (key) {
    case "company_name": return { size: 11, bold: true, align: "left" };
    case "title": return { size: config.fonts.headingSize, bold: true, align: "left" };
    case "order_no": return { size: 11, bold: true, align: "left" };
    case "ship_date": return { size: 10, bold: false, align: "left" };
    case "company_address":
    case "company_phone": return { size: 7, bold: false, align: "right" };
    case "sold_to":
    case "ship_to": return { size: 13, bold: true, align: "left" };
    case "tear_order_no": return { size: 11, bold: true, align: "left" };
    case "tear_shipped_complete": return { size: 11, bold: true, align: "center" };
    case "tear_total_qty":
    case "tear_total_weight": return { size: 10.5, bold: true, align: "left" };
    case "shipped_on": return { size: 9.5, bold: true, align: "right" };
    default: return { size: 9.5, bold: true, align: "left" }; // received_by, received_date, tear_sold_to
  }
}

/** A ticket field item, its label the config's (null: the contract's default). Only the header's
 *  order number repeats, and only where it stands at the page's top (a repeated item below a table
 *  is refused). */
function ticketField(config: TemplateConfig, section: string, key: string, box: CanvasBox, anchor: CanvasAnchor): CanvasItem {
  return {
    kind: "field", id: crypto.randomUUID(), key, label: fieldConfig(config, section, key)?.label ?? null,
    box, anchor, repeat: key === "order_no" && anchor.kind === "page-top", style: ticketStyle(key, config),
  };
}

const TICKET_HEADER_SLOT: Record<string, "left" | "centre" | "right"> = {
  company_name: "left", title: "left", order_no: "centre", ship_date: "centre", company_address: "right", company_phone: "right",
};
/** The strip's pieces that print as one line in a column of their row. */
type StripLine = "tear_order_no" | "tear_shipped_complete" | "received_by" | "received_date" | "tear_sold_to" | "shipped_on";

/** Builds the ticket's seed from the laid-out positions of its first ticket and of its strip alone. */
function seedTicketItems(
  docType: TicketDocType, config: TemplateConfig, sheet: LaidOutNode[], strip: LaidOutNode[], logoPlaced: boolean,
): CanvasItem[] {
  const contract = contractFor(docType);
  const tableKeys = new Set(canvasProfile(contract).tables.map((t) => t.key));
  const at = (nodes: LaidOutNode[], id: string) => nodes.find((n) => n.id === id);
  const must = (nodes: LaidOutNode[], id: string): LaidOutNode => {
    const node = at(nodes, id);
    if (node === undefined) throw new Error(`The seed's layout has no position for ${id}.`);
    return node;
  };
  const items: CanvasItem[] = [];

  // The section blocks in the flow's order (the config's), each with the table above it, which its
  // items hang below (the first table and anything above it: the page's top).
  const blocks = [...new Set(sheet.filter((n) => n.id.startsWith("seed:start:")).map((n) => n.id.slice("seed:start:".length)))];
  const anchorOf = new Map<string, string | null>();
  let above: string | null = null;
  for (const section of blocks) {
    anchorOf.set(section, above);
    if (tableKeys.has(section)) above = section;
  }
  /** A block's anchor and the y its offsets are taken from (the anchor table's rendered bottom, or
   *  the page's top when no table is above it). */
  const base = (section: string): { anchor: CanvasAnchor; y: number } => {
    const table = anchorOf.get(section) ?? null;
    if (table === null) return { anchor: pageTop, y: 0 };
    return { anchor: { kind: "below-table", table }, y: must(sheet, TICKET_SEED_IDS.sectionEnd(table)).top };
  };

  for (const section of blocks) {
    const { anchor, y } = base(section);

    if (section === "header") {
      // The centre slot's left as pdfmake laid it out; the left slot takes what is left of it.
      const centreLeft = sheet.find((n) => n.id === TICKET_SEED_IDS.piece("order_no") || n.id === TICKET_SEED_IDS.piece("ship_date")
        || (n.id === TICKET_SEED_IDS.piece("logo") && config.logo?.placement === "header-center"))?.left
        ?? TICKET_RIGHT_X - TICKET_HEADER_GAP - TICKET_CENTRE_WIDTH;
      const slots = {
        left: { x: LEFT, w: centreLeft - TICKET_HEADER_GAP - LEFT },
        centre: { x: centreLeft, w: TICKET_CENTRE_WIDTH },
        right: { x: TICKET_RIGHT_X, w: TICKET_RIGHT_WIDTH },
      };
      // In the order the header draws them: the left stack, the centre stack, the right stack.
      for (const node of sheet) {
        const key = node.id.slice("seed:".length);
        if (key === "logo" && logoPlaced && config.logo !== null) {
          const h = must(sheet, TICKET_SEED_IDS.end("logo")).top - node.top;
          // The right slot aligns its stack right, its image included (pdfmake's `alignImage`), and
          // the position is the slot's left; the other two slots align left.
          const width = config.logo.width;
          const x = config.logo.placement === "header-right" ? TICKET_RIGHT_X + TICKET_RIGHT_WIDTH - width : node.left;
          items.push({ kind: "logo", id: crypto.randomUUID(), box: { x, y: node.top - y, w: width, h }, anchor, repeat: false });
          continue;
        }
        const slot = TICKET_HEADER_SLOT[key];
        if (slot === undefined) continue;
        const h = must(sheet, TICKET_SEED_IDS.end(key)).top - node.top;
        items.push(ticketField(config, "header", key, { ...slots[slot], y: node.top - y, h }, anchor));
      }
      continue;
    }

    if (section === "parties") {
      // Each box from the block's top (its top rule) to its own bottom rule, at its slot.
      const top = must(sheet, TICKET_SEED_IDS.start("parties")).top;
      for (const key of ["sold_to", "ship_to"]) {
        const node = at(sheet, TICKET_SEED_IDS.piece(key));
        if (node === undefined) continue;
        const x = node.left < LEFT + PARTY_WIDTH ? LEFT : LEFT + PARTY_WIDTH + 50;
        const h = must(sheet, TICKET_SEED_IDS.end(key)).top - top;
        items.push(ticketField(config, "parties", key, { x, y: top - y, w: PARTY_WIDTH, h }, anchor));
      }
      continue;
    }

    if (tableKeys.has(section)) {
      // The table's block: the content width wide, from its start mark to its end mark (its own
      // bottom, its margin below it). The ticket is one page (`seedTicketLayout` refuses more), so
      // no table runs onto a next page.
      const start = must(sheet, TICKET_SEED_IDS.start(section));
      const end = must(sheet, TICKET_SEED_IDS.sectionEnd(section));
      const spec = tableSpec(contract, section)!;
      const sc = config.sections.find((s) => s.key === section)!;
      const ownColumns = (key: string) => contract.sections.flatMap((s) => s.fields).find((f) => f.key === key)?.column?.table === section;
      const columns = spec.rows
        ? sc.fields.map((f) => ({ key: f.key, visible: f.visible, label: f.label, width: null }))
        : sc.fields.filter((f) => ownColumns(f.key))
          .map((f) => ({ key: f.key, visible: f.visible, label: f.label, width: typeof f.width === "number" ? f.width : null }));
      items.push({
        kind: "table", id: crypto.randomUUID(), key: section,
        box: { x: LEFT, y: start.top, w: CONTENT_WIDTH, h: end.top - start.top },
        anchor: anchor.kind === "below-table" ? anchor : pageTop,
        repeat: false,
        heading: spec.heading === null ? null : fieldConfig(config, section, spec.heading)?.label ?? null,
        columns,
      });
      continue;
    }

    if (section === "liability") {
      // The wording at its paragraphs' extent, and its heavy rule under it.
      const text = at(sheet, TICKET_SEED_IDS.piece("shipper_liability_text"));
      if (text !== undefined) {
        const h = must(sheet, TICKET_SEED_IDS.end("shipper_liability_text")).top - text.top;
        items.push({
          kind: "textBlock", id: crypto.randomUUID(), key: "shipper_liability_text",
          box: { x: LEFT, y: text.top - y, w: CONTENT_WIDTH, h }, anchor, repeat: false,
          style: { size: config.fonts.smallSize, bold: false, align: "left" },
        });
      }
      const rule = at(sheet, TICKET_SEED_IDS.piece("liability_rule"));
      if (rule !== undefined) {
        items.push(lineItem({ axis: "h", at: rule.top - y, from: LEFT, to: LEFT + CONTENT_WIDTH }, anchor, HEAVY_RULE));
      }
      continue;
    }

    if (section === "tear_off") items.push(...stripItems(config, sheet, strip, base(section), must));
  }
  return items.map(tidy);
}

/**
 * The strip's items, from its alone layout (`strip`): every piece's top there is its offset within
 * the block, so its place on the sheet is the block's start (its `start` mark, top-level and exact)
 * plus that offset, taken from the anchor's rendered bottom (the ticket is one page: the seed
 * refuses more).
 *
 * The boxed pair is one static Box at the pair table's printed outline (the centrelines of its outer
 * rules), its two rows field items at their cells, and its inner rules two static Lines drawn from
 * the Box's inner faces (half the Box's weight in from each edge), so they touch the Box's ink and
 * do not overlap it.
 */
function stripItems(
  config: TemplateConfig, sheet: LaidOutNode[], strip: LaidOutNode[],
  { anchor, y }: { anchor: CanvasAnchor; y: number },
  must: (nodes: LaidOutNode[], id: string) => LaidOutNode,
): CanvasItem[] {
  const startMark = must(sheet, TICKET_SEED_IDS.start("tear_off"));
  const shift = startMark.top - y;
  const at = (id: string) => strip.find((n) => n.id === id);
  const items: CanvasItem[] = [];

  const rule = at(TICKET_SEED_IDS.piece("tear_off_rule"));
  if (rule !== undefined) {
    items.push(lineItem({ axis: "h", at: rule.top + shift, from: LEFT, to: LEFT + CONTENT_WIDTH }, anchor, HEAVY_RULE));
  }

  const [orderColumn, bannerColumn, pairColumn] = columnXs(STRIP_FIRST);
  const [byColumn, dateColumn] = columnXs(STRIP_RECEIVED);
  const [soldColumn, onColumn] = columnXs(STRIP_SOLD);
  const columnOf: Record<StripLine, { x: number; w: number }> = {
    tear_order_no: orderColumn, tear_shipped_complete: bannerColumn, received_by: byColumn,
    received_date: dateColumn, tear_sold_to: soldColumn, shipped_on: onColumn,
  };
  const place = (key: string, node: LaidOutNode, column: { x: number; w: number }) => {
    const h = must(strip, TICKET_SEED_IDS.end(key)).top - node.top;
    items.push(ticketField(config, "tear_off", key, { x: column.x, y: node.top + shift, w: column.w, h }, anchor));
  };

  // The pieces in the order the strip draws them: the first row's order number and banner, the
  // pair, then the two rows under it.
  for (const key of ["tear_order_no", "tear_shipped_complete"] as const) {
    const node = at(TICKET_SEED_IDS.piece(key));
    if (node !== undefined) place(key, node, columnOf[key]);
  }
  const rows = ["tear_total_qty", "tear_total_weight"]
    .map((key) => ({ key, node: at(TICKET_SEED_IDS.piece(key)) }))
    .filter((r): r is { key: string; node: LaidOutNode } => r.node !== undefined)
    .sort((a, b) => a.node.top - b.node.top);
  if (rows.length > 0) {
    // The pair table (`["*", 62]`, boxed) in the first row's third column: each cell's content is
    // under the row's top rule and padding, the row as tall as the taller of its two cells (the
    // label's 10.5 pt bold or the figure's base size, whichever a template makes taller), the table
    // closed by the last row's bottom padding and the bottom rule.
    const edges = resolvedColumns(PAIR_WIDTHS, pairColumn.w, BOXED);
    const inset = BOXED.rule + BOXED.padY;
    const tableTop = rows[0].node.top - inset;
    const last = rows.at(-1)!.key;
    const lastBottom = Math.max(must(strip, TICKET_SEED_IDS.end(last)).top, must(strip, PAIR_FIGURE_END(last)).top);
    const tableBottom = lastBottom + BOXED.padY + BOXED.rule;
    const contentLeft = pairColumn.x + BOXED.vRule + BOXED.padX;
    const contentRight = pairColumn.x + edges[2] - BOXED.padX;
    for (const { key, node } of rows) {
      // The row as tall as its taller cell, the label's end or the figure's, as the Box reads it.
      const h = Math.max(must(strip, TICKET_SEED_IDS.end(key)).top, must(strip, PAIR_FIGURE_END(key)).top) - node.top;
      items.push(ticketField(config, "tear_off", key, { x: contentLeft, y: node.top + shift, w: contentRight - contentLeft, h }, anchor));
    }
    const half = BOXED.rule / 2;
    const box = {
      x: pairColumn.x + half, y: tableTop + shift + half,
      w: pairColumn.w - BOXED.rule, h: tableBottom - tableTop - BOXED.rule,
    };
    items.push({ kind: "box", id: crypto.randomUUID(), box, anchor, repeat: false, weight: BOXED.rule });
    // The rule between the rows, at the second row's top rule's centre, and the figure column's
    // rule, at the 62 pt column's left edge, each from the Box's inner faces (its centreline plus
    // half its weight) less one thousandth of a point, the grain `tidy` snaps to: the faces are sums
    // of binary fractions, and a stroke ending exactly on one can pass it by a rounding error, which
    // the overlap warning reads as ink over the Box.
    const face = half + 0.001; // 0.401 in from the Box's centreline: its 0.8 pt weight's half and one grain
    if (rows.length > 1) {
      const divider = rows[1].node.top - inset + half + shift;
      items.push(lineItem({ axis: "h", at: divider, from: box.x + face, to: box.x + box.w - face }, anchor, BOXED.rule));
    }
    items.push(lineItem({ axis: "v", at: pairColumn.x + edges[1] + half, from: box.y + face, to: box.y + box.h - face }, anchor, BOXED.rule));
  }
  for (const key of ["received_by", "received_date", "tear_sold_to", "shipped_on"] as const) {
    const node = at(TICKET_SEED_IDS.piece(key));
    if (node !== undefined) place(key, node, columnOf[key]);
  }
  return items;
}

/** The end mark the strip's alone layout puts after a pair row's figure cell. */
const PAIR_FIGURE_END = (key: string) => `seed:end:figure:${key}`;

/** Marks each pair row's figure cell in the strip's alone clone: a row is a table body row whose
 *  first cell carries a pair piece's id (`seedCell`), its second cell the figure, which gets a stack
 *  with an end mark after it (the cell's own text and alignment unchanged inside it). */
function markPairFigures(node: unknown): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    const id = (node[0] as { id?: unknown } | undefined)?.id;
    const key = typeof id === "string" && id.startsWith("seed:tear_total_") ? id.slice("seed:".length) : null;
    if (key !== null && node.length === 2) {
      node[1] = { stack: [node[1], mark(PAIR_FIGURE_END(key))] };
      return;
    }
    for (const child of node) markPairFigures(child);
    return;
  }
  for (const value of Object.values(node)) markPairFigures(value);
}

/** The strip block of a ticket definition's content: the block after the strip's `start` mark. */
function stripBlock(content: unknown): object | null {
  const stack = (content as { stack?: unknown[] }[] | undefined)?.[0]?.stack;
  if (!Array.isArray(stack)) return null;
  const i = stack.findIndex((node) => (node as { id?: unknown })?.id === TICKET_SEED_IDS.start("tear_off"));
  return i === -1 ? null : (stack[i + 1] as object);
}

/** The ticket's layout pass: the shipment read as the preview reads it, its FIRST order's ticket
 *  laid out once, and its strip alone. */
async function seedTicketLayout(
  docType: TicketDocType, recordId: string, config: TemplateConfig, logoDataUri: string | undefined,
): Promise<CanvasLayout> {
  const settings = await ticketSettings();
  const data = await readOnly((tx) => readShippingTicketData(tx, recordId,
    { ...settings, liabilityText: config.textBlocks.shipper_liability_text }, undefined));
  const [sheet] = buildShippingTicketDefinitions([data[0]], docType, config, logoDataUri, { seedIds: true, seedPlaceholders: true });
  const laid = await renderSheetGroupsWithPositions([sheet]);
  // A canvas stacks the ticket's tables on one page: a table that starts on a second page has no
  // drawn place the rules accept (the stacking rule or the page's bounds refuse it), so the seed
  // starts only from a ticket that fits one page.
  const pages = laid.groups[0].pages;
  if (pages > 1) {
    throw new HttpError(400,
      `The canvas starts from a one-page ticket; this shipment's first ticket prints ${pages} pages. Pick a shipment whose ticket fits one page.`);
  }

  // The strip alone, cloned under an id the renderer does not measure and without its mark, so it
  // stays breakable and each piece reports its own top, on a page with no top margin. Each pair
  // row's figure cell gets an end mark in the clone, so the row's height is read from both cells.
  const block = stripBlock(sheet.content);
  let strip: LaidOutNode[] = [];
  if (block !== null) {
    const clone = { ...JSON.parse(JSON.stringify(block)), id: STRIP_ALONE_ID } as Record<string, unknown>;
    delete clone.unbreakable;
    markPairFigures(clone);
    const alone: RenderableDefinition = {
      pageSize: "LETTER",
      pageMargins: [CANVAS_PAGE.margin, 0, CANVAS_PAGE.margin, 0],
      defaultStyle: sheet.defaultStyle,
      content: [clone as unknown as Content],
    };
    strip = (await renderSheetGroupsWithPositions([alone])).groups[0].positions;
  }
  return {
    version: 1,
    items: seedTicketItems(docType, config, laid.groups[0].positions, strip, logoDataUri !== undefined),
  };
}

/** The traveler's layout pass (§5.4): the order's first load laid out once, and its results block
 *  alone (Ruling 4). */
async function seedTravelerLayout(
  recordId: string, config: TemplateConfig, logoDataUri: string | undefined,
): Promise<CanvasLayout> {
  const settings = await travelerSettings();
  const data = await readOnly(async (tx) => {
    const order = await readDetail(tx, recordId, settings.traffic);
    return readTravelerData(tx, recordId, settings, order.loads[0]?.loadNumber, order);
  });
  const [sheet] = buildTravelerDefinitions(data, config, logoDataUri, { seedIds: true });
  const laid = await renderSheetGroupsWithPositions([sheet]);

  // The results block alone (Ruling 4), under an id `prepareTravelerLayout` does not know, so it
  // stays breakable and each cell reports its own top, on a page with no top margin.
  const block = resultsBlock(sheet.content);
  let footer: LaidOutNode[] = [];
  if (block !== null) {
    const alone: RenderableDefinition = {
      pageSize: "LETTER",
      pageMargins: [CANVAS_PAGE.margin, 0, CANVAS_PAGE.margin, 0],
      defaultStyle: sheet.defaultStyle,
      content: [{ ...JSON.parse(JSON.stringify(block)), id: "seed:footer" }],
    };
    footer = (await renderSheetGroupsWithPositions([alone])).groups[0].positions;
  }
  return {
    version: 1,
    items: seedItems(config, laid.groups[0].positions, footer, logoDataUri !== undefined),
  };
}

/**
 * The layout that prints the submitted flow config's paper for the picked record (§5.4; the
 * shipping ticket design of 2026-11-08 §5.3). The config is validated against its own type as the
 * preview validates it, its own `layout` set aside: the seed starts a canvas from the sections,
 * whatever canvas the draft already holds. Then the type's canvas profile decides: the traveler's
 * seed for a traveler (the picked order), the ticket's for a SHIPPER or MOS_SHIPPER (the picked
 * shipment), the bill of lading's for a BOL (the picked shipment, `seedBolLayout`), the
 * certification's for a CERT (the picked certification, `seedCertLayout`, design 2026-11-10 §5.3), the
 * invoice's for an INVOICE (the picked invoice or credit memo, `seedInvoiceLayout`, the invoice canvas
 * design 2026-11-10 §5.3), the statement's for a STATEMENT (the picked customer, `seedStatementLayout`,
 * laid out from a stand-in at its least, the statement canvas design 2026-11-11 §5.3), the quotation's
 * for a QUOTE (the picked quote, `seedQuoteLayout`, laid out from a stand-in at its least, the quote
 * canvas design 2026-11-12 §5.3, since quote canvas PR 2), the container tag's for a CONTAINER_TAG (the
 * picked order, `seedContainerTagLayout`, worked from the flow's line heights, the container tag
 * design 2026-11-13 §7.4, since container tag PR 3), and a type whose contract offers no canvas
 * is refused with `canvasProfile`'s own sentence, and one whose canvas does not print in the
 * later-release sentence (`assertCanvasPrints`, the registry's own refusal, a 400 before any record is
 * read). Every docType has an arm, so the switch's default is the exhaustive check `renderPreview`
 * uses and no request reaches it: an unregistered docType is refused by `validateConfig`, one whose
 * canvas does not print by `assertCanvasPrints`, both before the switch, and `tsc` refuses a missing
 * arm. `signerUserId` is the acting
 * user: the certification's seed signs its render with it, as the preview does (§3.11); no other
 * paper here signs anything.
 */
export async function seedCanvasLayout(
  ctx: PreviewContext, input: { recordId: string; config: unknown }, signerUserId: string,
): Promise<CanvasLayout> {
  const submitted = input.config !== null && typeof input.config === "object" ? input.config : {};
  let config: TemplateConfig;
  try {
    config = validateConfig(ctx.docType, { ...submitted, layout: null });
    assertCanvasPrints(ctx.docType);
  } catch (err) {
    if (err instanceof TemplateConfigError) throw new HttpError(400, err.message);
    throw err;
  }
  const logoDataUri = ctx.logoImage !== null && templatePlacesLogo(config)
    ? (ctx.logoMimeType === "image/jpeg" ? jpegDataUri(Buffer.from(ctx.logoImage)) : pngDataUri(Buffer.from(ctx.logoImage)))
    : undefined;

  switch (ctx.docType) {
    case "TRAVELER": return seedTravelerLayout(input.recordId, config, logoDataUri);
    case "SHIPPER":
    case "MOS_SHIPPER": return seedTicketLayout(ctx.docType, input.recordId, config, logoDataUri);
    case "BOL": return seedBolLayout(input.recordId, config, logoDataUri);
    case "CERT": return seedCertLayout(input.recordId, config, logoDataUri, signerUserId);
    case "INVOICE": return seedInvoiceLayout(input.recordId, config, logoDataUri);
    case "STATEMENT": return seedStatementLayout(input.recordId, config, logoDataUri);
    case "QUOTE": return seedQuoteLayout(input.recordId, config, logoDataUri);
    case "CONTAINER_TAG": return seedContainerTagLayout(input.recordId, config, logoDataUri);
    default: {
      const _exhaustive: never = ctx.docType;
      throw new Error(`Unhandled canvas seed docType: ${String(_exhaustive)}`);
    }
  }
}
