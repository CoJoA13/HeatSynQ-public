/**
 * The canvas SHEET, shared by every canvas document (the traveler's design
 * `docs/superpowers/specs/2026-11-07-traveler-canvas-designer-design.md` §5.2, lifted out of
 * `traveler-canvas.ts` by the shipping ticket's design `docs/superpowers/specs/2026-11-08-shipping-ticket-canvas-design.md`
 * §5.2): a template whose `config.layout` is not null prints its items where they are drawn, its
 * tables in the flow at their drawn places and widths, and the items anchored below a table riding
 * that table's rendered bottom. A document hands in two callbacks, its item node (`ItemContent`) and
 * its table block (`TableBlock`); its field families and its belt stay its own.
 *
 * pdfmake lays a document out as a flow, and a canvas is made of three of its primitives:
 *
 *  - A page-top item is a DETACHED node (`absolutePosition`): pdfmake restores the writer's x, y,
 *    page and available height when a detached block ends (`DocumentContext.endDetachedBlock`), so
 *    the item draws at its coordinates and takes no flow. A spacer then carries the flow from the
 *    fixed top margin (`topMargin`) to the first table's drawn top.
 *  - The tables ARE the flow, each at its drawn x and width, as tall as its rows need (§4.3:
 *    nothing is resized by data): each in the one canvas block shape (`drawnBlock`, over
 *    `canvas-nodes.ts`'s `blockAt`, whose header tells why), the lateral margin on a zero-gap
 *    `columns` node inside the block's wrapper, its one column the drawn width as pdfmake subtracts
 *    it from the content width (`drawnBlock`), so a `"*"` column of the table resolves against that
 *    width on every page (#969).
 *  - After each table, a float REGION: one `unbreakable` stack of the items anchored below that
 *    table, each detached at `relativePosition` by its stored offset, then a spacer of the drawn
 *    distance to the next table's top (after the last table, to the lowest item's bottom:
 *    `regionHeights`). The items add nothing to the flow, so the region's flow height is the
 *    spacer's alone, known without a measurement, and the region moves whole to the next page when
 *    it does not fit the page's remainder. The regions are deliberately NOT in render.ts's measured
 *    kept-together set (`KEPT_TOGETHER`): that would lay each out once a sheet and bring back the
 *    cost #611 removed; the validator's bound on every region's height (`usableHeight`) is the
 *    guard against a region taller than a page, which pdfmake would print on no page at all. A
 *    TRAILING region from which nothing prints (no item of it or of a later region prints, no later
 *    block prints: `nothingPrintsAfter`) is left out (#997, owner ruling 2026-11-15), so a gap the
 *    owner draws under the last thing that prints can never move whole to a blank last page.
 *
 *  - The REPEAT BAND is the existing `continuationHeaderSpec` seam: every page-top item set to
 *    repeat, and "(continued)", drawn on every page after the first. It carries NO
 *    `overflowTopMargin`, so `renderPdfCore` takes one pass with this sheet's own top margin
 *    (§4.5: the same on every page, so a table prints where it is drawn whether the sheet takes one
 *    page or three); the probe and second pass are the flow path's alone.
 *  - The PAGE-BOTTOM BAND is `pageBottomBandSpec` (render.ts): its height is reserved in the bottom
 *    margin of EVERY page and its items print on the last page only, each repeated item on every
 *    page (the traveler design's §14 call 1: placing the sign-off at the foot of the last page with
 *    no reserved band would take a second layout pass per sheet).
 *
 * Ids are what the measure reads (`canvas-measure.ts`, from `renderSheetGroupsWithPositions`), so
 * they go only on top-level flow nodes and on the detached wrappers, whose positions are where they
 * drew: a node inside an `unbreakable` region reports the region's start, so a region's items carry
 * none. They never go on a TEXT node (pdfmake refuses two text nodes sharing an id in one document
 * and makes a named destination of a text id): an item's id is on its wrapper stack, a table's on
 * its block's wrapper (`drawnBlock`, which the document's `TableBlock` calls), and the marks are
 * canvas nodes (`canvas-nodes.ts`). A repeated item's node in the header and an item in the band
 * carry NO id and no end mark: pdfmake lays both out in its header and footer frames, where a
 * laid-out position means nothing to the measure, and the header's nodes would repeat an id on
 * every page.
 *
 * Server-only, and it imports no document builder: each document imports this file, never the
 * other way round.
 */
import type { Content, Margins, TableCell } from "pdfmake/interfaces";
import { LAYOUT, type PageBottomBandSpec, type RenderableDefinition } from "./render";
import { CANVAS_TABLE_ID_PREFIX, blockAt, mark, spacer } from "./canvas-nodes";
import {
  PAGE_LINE_ROOM, bandHeight, bandTop, continuedBox, regionHeights, tableHeadingKey, tablesByY, topMargin,
} from "@/lib/template-canvas";
import {
  CANVAS_PAGE, CONTINUED_FONT_SIZE, type CanvasBox, type CanvasItem, type CanvasLayout, type CanvasTableKey,
} from "@/lib/template-contracts/canvas";
import type { FieldConfig, FontsConfig, SectionConfig, TemplateContract } from "@/lib/template-contracts/types";

export { mark, spacer };

export type TableItem = Extract<CanvasItem, { kind: "table" }>;
export type TextItem = Extract<CanvasItem, { kind: "text" }>;
export type TextBlockItem = Extract<CanvasItem, { kind: "textBlock" }>;
export type LogoItem = Extract<CanvasItem, { kind: "logo" }>;
export type LineItem = Extract<CanvasItem, { kind: "line" }>;
export type BoxItem = Extract<CanvasItem, { kind: "box" }>;
export type FieldItem = Extract<CanvasItem, { kind: "field" }>;

/** pdfmake's types allow `id` on text nodes alone; the canvas puts ids on stacks, tables and canvas
 *  nodes only (see the header), through this one cast. */
export type WithId<T> = T & { id: string };

/** The ids the canvas path puts on its flow nodes, read back from the laid-out content. */
export const CANVAS_IDS = {
  table: (key: CanvasTableKey) => `${CANVAS_TABLE_ID_PREFIX}${key}`,
  end: (key: CanvasTableKey) => `canvas:end:${key}`,
  regionEnd: (key: CanvasTableKey) => `canvas:regionEnd:${key}`,
  item: (id: string) => `canvas:item:${id}`,
  itemEnd: (id: string) => `canvas:itemEnd:${id}`,
} as const;

/** A document's node for one item, or null when it prints nothing. A table is never an item node. */
export type ItemContent = (item: CanvasItem) => Content | null;
/** A document's block for one table, at its drawn x and width: its node placed by `drawnBlock`,
 *  which puts the id (`CANVAS_IDS.table`) on the block's wrapper and the lateral margin on its
 *  `columns` node, the vertical distances left to the spacers; null when the document prints no
 *  block for it (every column hidden, say). The sheet still emits the table's marks and region
 *  either way. */
export type TableBlock = (item: TableItem) => Content | null;

/** The content's left and right edges on the page: a table drawn at the content's width runs from
 *  one to the other. */
export const LEFT = CANVAS_PAGE.margin;
export const RIGHT = CANVAS_PAGE.width - CANVAS_PAGE.margin;

/** The section config a table item stands for on `contract`: its columns' (a rows block's rows)
 *  visible, label and width, in the item's order, and its heading (the contract's heading field for
 *  the table, its label the item's `heading`; null = the contract's default label, as a flow
 *  config's label is). A canvas table always prints its heading: the model has no knob to hide it. */
export function sectionConfigOf(contract: TemplateContract, item: TableItem): SectionConfig {
  const heading = tableHeadingKey(contract, item.key);
  const fields: FieldConfig[] = [
    ...(heading === null ? [] : [{ key: heading, visible: true, label: item.heading, width: null }]),
    ...item.columns.map((column) => ({
      key: column.key, visible: column.visible, label: column.label, width: column.width,
    })),
  ];
  return { key: item.key, visible: true, fields };
}

/** The default label of the field `key` on `contract` (empty when no section holds it). */
export function defaultLabelOf(contract: TemplateContract, key: string): string {
  const field = contract.sections.flatMap((section) => section.fields).find((f) => f.key === key);
  return field?.defaultLabel ?? "";
}

/** A field item's printed label: its own, else the default of its key on `contract`. */
export function labelOf(contract: TemplateContract, item: FieldItem): string {
  return item.label ?? defaultLabelOf(contract, item.key);
}

/** A table's flow node at its drawn place, in the one canvas block shape (`blockAt`, whose
 *  `canvas-nodes.ts` header tells why the lateral margin sits on its `columns` node): the table's id
 *  (`CANVAS_IDS.table`) on the wrapper, the node's own id deleted (the wrapper carries the block's)
 *  and its whole margin replaced by [0, 0, 0, 0] (the spacers carry the drawn vertical distances, the
 *  `columns` node the lateral margin), in ONE fixed-width column. That width is pdfmake's own
 *  subtraction from the content width, `564 − (left + right)`, the width a lateral margin on the
 *  node would leave it (`addMargin`), never `item.box.w`, which may differ from it in the last place.
 *  With `held`, the block takes at least that height (`blockAt`). */
export function drawnBlock(node: object, item: TableItem, held?: number): Content & { id: string } {
  const own = node as { id?: unknown; margin?: Margins };
  delete own.id;
  own.margin = [0, 0, 0, 0];
  const left = item.box.x - LEFT;
  const right = RIGHT - item.box.x - item.box.w;
  return blockAt(
    CANVAS_IDS.table(item.key), node as Content, left, right,
    (CANVAS_PAGE.width - 2 * CANVAS_PAGE.margin) - (left + right), held,
  ) as Content & { id: string };
}

/** Text the item's box wraps: a column exactly the box's width, so the box's width is the wrap
 *  width (§4.1) and an alignment is taken within it. A detached node otherwise takes the page's
 *  width from its x (`absolutePosition`) or the body's (`relativePosition`). */
export function inBoxWidth(width: number, node: Content): Content {
  return { columns: [{ width, stack: [node] }], columnGap: 0 };
}

/** A hand-written area: a one-cell boxed table drawn at the box, its content at the top-left.
 *  `LAYOUT.boxed` adds 4 pt of padding on each side, 2 above and below, and a 0.8 pt rule on every
 *  edge, so the cell's content is the box less 9.6 across and 5.6 down (the flow's
 *  `samplePlaceholder` arithmetic). A label taller than the box grows it, as any text item grows. */
export function boxedCell(box: CanvasBox, cell: TableCell): Content {
  return {
    table: {
      widths: [Math.max(0, box.w - 9.6)],
      heights: [Math.max(0, box.h - 5.6)],
      body: [[cell]],
    },
    layout: LAYOUT.boxed,
  };
}

/** A text item: its text in its style, wrapped at its box's width. */
export function textContent(item: TextItem): Content {
  const { size, bold, align } = item.style;
  return inBoxWidth(item.box.w, { text: item.text, fontSize: size, bold, alignment: align });
}

/** A text-block item: the block's text, one paragraph per run between blank lines, each in the
 *  item's style with 4 pt under it, wrapped at its box's width. */
export function textBlockContent(item: TextBlockItem, text: string): Content {
  const { size, bold, align } = item.style;
  return inBoxWidth(item.box.w, {
    stack: text.split(/\n\s*\n/).map((paragraph) => ({
      text: paragraph, fontSize: size, bold, alignment: align, margin: [0, 0, 0, 4],
    })) as Content[],
  });
}

/** A logo item: the version's bytes fitted to its box (`fit` keeps the image's proportions, unlike
 *  the traveler barcode's stretch), nothing when the version carries none. */
export function logoContent(item: LogoItem, logoDataUri: string | undefined): Content | null {
  return logoDataUri === undefined ? null : { image: logoDataUri, fit: [item.box.w, item.box.h] };
}

/** A line or a box: a STROKED canvas vector of its weight (no `color`, which is what strokes it:
 *  `mark` and `spacer` are the fill-only opposite); a line runs from its box's top-left to its
 *  bottom-right, which the schema holds to one axis. */
export function strokeContent(item: LineItem | BoxItem): Content {
  if (item.kind === "line") {
    return { canvas: [{ type: "line", x1: 0, y1: 0, x2: item.box.w, y2: item.box.h, lineWidth: item.weight }] };
  }
  return { canvas: [{ type: "rect", x: 0, y: 0, w: item.box.w, h: item.box.h, lineWidth: item.weight }] };
}

/** An item detached at its page coordinates with no id and no end mark: a repeated item in the
 *  header, or an item in the page-bottom band, each laid out in a pdfmake header or footer frame
 *  (see the header). The header frame's origin is the page's, so its coordinates are page
 *  coordinates; render.ts moves a band item's `y` into the footer frame. */
function placedNode(itemContent: ItemContent, item: CanvasItem): Content | null {
  const node = itemContent(item);
  if (node === null) return null;
  return { absolutePosition: { x: item.box.x, y: item.box.y }, stack: [node] };
}

/** A page-top item, detached at its page coordinates. Its id is on the wrapper stack, whose
 *  position is its first child's (the item's own top-left), and the end mark after the item
 *  reports where the item's content ends. */
function pageTopNode(itemContent: ItemContent, item: CanvasItem): Content | null {
  const node = itemContent(item);
  if (node === null) return null;
  return {
    id: CANVAS_IDS.item(item.id),
    absolutePosition: { x: item.box.x, y: item.box.y },
    stack: [node, mark(CANVAS_IDS.itemEnd(item.id))],
  } as WithId<Content>;
}

/**
 * Whether nothing prints in the flow from table `key`'s float region on: no item anchored below
 * `key`, or below any table drawn after it (`tablesByY`), prints (`itemContent` answers it a node),
 * and no table drawn after it prints a block (`blockPrints`). An item whose node is null (a Logo item
 * with no logo bytes) prints nothing. A page-top item and a page-bottom item never count: the first
 * prints detached at the page's top, the second in the page-bottom band's footer frame, neither in
 * the flow after the table.
 *
 * Asked twice, so the two answers cannot disagree: by the sheet, which drops a region it answers
 * true for (#997, `assembleCanvasSheet`), and by the invoice's end-of-block belt, which takes the
 * price block's last rule's space off when it answers true for the price block (`invoice-canvas.ts`,
 * the invoice canvas design's §5.2).
 */
export function nothingPrintsAfter(
  layout: CanvasLayout, key: CanvasTableKey, itemContent: ItemContent, blockPrints: (table: TableItem) => boolean,
): boolean {
  const tables = tablesByY(layout);
  const later = tables.slice(tables.findIndex((table) => table.key === key) + 1);
  if (later.some(blockPrints)) return false;
  const regions = new Set<string>([key, ...later.map((table) => table.key)]);
  return !layout.items.some((item) => item.kind !== "table" && item.anchor.kind === "below-table" &&
    regions.has(item.anchor.table) && itemContent(item) !== null);
}

/** The float region after a table: its anchored items, each detached at its offset from the
 *  region's top (the table's rendered bottom), then the spacer, LAST, so the items are placed from
 *  the region's top. Null for a region of height 0 holding no item; the sheet also leaves out a
 *  region from which nothing prints (`nothingPrintsAfter`, #997) without asking this. */
function regionNode(
  itemContent: ItemContent, layout: CanvasLayout, key: CanvasTableKey, height: number,
): Content | null {
  const items: Content[] = [];
  for (const item of layout.items) {
    if (item.kind === "table" || item.anchor.kind !== "below-table" || item.anchor.table !== key) continue;
    const node = itemContent(item);
    if (node === null) continue;
    items.push({ ...(node as object), relativePosition: { x: item.box.x - LEFT, y: item.box.y } } as Content);
  }
  if (height === 0 && items.length === 0) return null;
  return { unbreakable: true, stack: [...items, spacer(height)] };
}

/**
 * One sheet's definition from a document's callbacks. The top margin is the layout's fixed one
 * (§4.5: one pass, the same on every page); the bottom margin reserves the page-bottom band and,
 * when the template prints it, the page line's room, which render.ts draws under the band
 * (`pageFooterSpec`). Each sheet carries its own repeat band and page-bottom band, so a
 * continuation page names its own sheet's figures. The content, in order: the page-top items; the
 * spacer to the first table (none on a layout with no table); then each table by its drawn y with
 * its `end` mark, its region and its `regionEnd` mark. Both marks are emitted for every table, its
 * block or region omitted or not. A printed region's top is `regionEnd.top − its height`; a region
 * left out because nothing prints from it on (#997) puts its `regionEnd` mark exactly on its `end`
 * mark, which is how the measure tells the two apart (`canvasMeasure`).
 *
 * `layout` is the layout that prints: a document with a belt hands in its completed layout.
 */
export function assembleCanvasSheet(args: {
  layout: CanvasLayout; pageFooter: boolean; fonts: FontsConfig; itemContent: ItemContent; tableBlock: TableBlock;
}): RenderableDefinition {
  const { layout, pageFooter, fonts, itemContent, tableBlock } = args;
  const tables = tablesByY(layout);
  const heights = new Map(regionHeights(layout).map((region) => [region.after, region.height] as const));
  const top = topMargin(layout);
  const band = bandHeight(layout, pageFooter);
  const bottom = CANVAS_PAGE.margin + band + (pageFooter ? PAGE_LINE_ROOM : 0);
  const continued = continuedBox(layout);
  const pageTop = layout.items.filter((item) => item.kind !== "table" && item.anchor.kind === "page-top");
  const pageBottom = layout.items.filter((item) => item.kind !== "table" && item.anchor.kind === "page-bottom");

  const content: Content[] = [];
  for (const item of pageTop) {
    const node = pageTopNode(itemContent, item);
    if (node !== null) content.push(node);
  }
  // Never negative: the validator refuses a repeat band that ends below the first table's top
  // (Ruling 9), so this belt only keeps a layout that bypassed it from pulling the flow up.
  if (tables.length > 0) content.push(spacer(Math.max(0, tables[0].box.y - top)));
  // Every table's block, built once by the sheet and in the tables' order, before any is placed: the
  // trailing gap's question below reads whether each later block prints from these. (A document's
  // own `tableBlock` may ask the same question of its later blocks by its own means: the invoice's
  // end-of-block belt builds their children again through `blockChildren`.)
  const blocks = new Map(tables.map((table) => [table.key, tableBlock(table)] as const));
  const blockPrints = (table: TableItem) => blocks.get(table.key) !== null;
  for (const table of tables) {
    const block = blocks.get(table.key) ?? null;
    // A JSON copy of each table's block (every definition is pure JSON): the one-pass render prints
    // a node it has laid out once, pdfmake using up a text node as it lays it out, and a flow
    // builder may place one cell object twice (the ticket's folded containers table, whose heading
    // cells are one object per column in both copies).
    if (block !== null) content.push(JSON.parse(JSON.stringify(block)) as Content);
    content.push(mark(CANVAS_IDS.end(table.key)));
    // A TRAILING region from which nothing prints is left out (#997, owner ruling 2026-11-15): it
    // prints nothing either way, but its spacer is `unbreakable`, so a drawn gap that does not fit
    // under the last thing printed would move whole to a new page and print a blank last page. A
    // region holding an item that prints keeps its spacer, which is what moves it whole, and a gap
    // with anything that prints after it keeps the drawn distance to it.
    const region = nothingPrintsAfter(layout, table.key, itemContent, blockPrints) ? null
      : regionNode(itemContent, layout, table.key, heights.get(table.key) ?? 0);
    if (region !== null) content.push(region);
    content.push(mark(CANVAS_IDS.regionEnd(table.key)));
  }
  // The repeat band: pdfmake lays the header out in a frame exactly the top margin tall and drops
  // a line that passes it; everything here fits the frame by construction. "(continued)" prints on
  // every page after the first in its own box at the band's bottom-left (`continuedBox`, Ruling
  // 16), its bottom level with the lowest repeated item's. Drawn last, so it prints over a repeated
  // item placed there, which `canvasWarnings` warns of.
  const repeated: Content[] = [];
  for (const item of pageTop) {
    if (!item.repeat) continue;
    const node = placedNode(itemContent, item);
    if (node !== null) repeated.push(node);
  }
  if (continued !== null) {
    repeated.push({
      text: "(continued)", italics: true, fontSize: CONTINUED_FONT_SIZE,
      absolutePosition: { x: continued.x, y: continued.y },
    });
  }
  // Each band item repeats on its own flag (the traveler design's §4.5, Ruling 11): a repeated one
  // on every page, the rest on the last page only.
  const lastOnly: Content[] = [];
  const everyPage: Content[] = [];
  for (const item of pageBottom) {
    const node = placedNode(itemContent, item);
    if (node !== null) (item.repeat ? everyPage : lastOnly).push(node);
  }
  const bandSpec: PageBottomBandSpec | null = band === 0 ? null
    : { height: band, content: lastOnly, repeated: everyPage };
  return {
    pageSize: "LETTER",
    pageMargins: [LEFT, top, CANVAS_PAGE.margin, bottom],
    defaultStyle: { font: fonts.family, fontSize: fonts.baseSize },
    content,
    continuationHeaderSpec: { content: { stack: repeated } },
    ...(bandSpec === null ? {} : { pageBottomBandSpec: bandSpec }),
    ...(pageFooter ? { pageFooterSpec: { kind: "pageNofM" as const } } : {}),
  };
}

/**
 * The ALONE layouts the preview renders beside the sheet (the shipping ticket design's §5.2): the
 * sheet's float regions and its page-bottom band are where the measure cannot see, since pdfmake
 * reports a node inside an `unbreakable` region, or in a footer frame, at the block's start. So the
 * preview lays each region's items, and the band's, out once more by themselves, exactly as the
 * sheet measures its page-top items: each item detached at its x and its offset from the region's
 * top (its stored `box.y`; a band item at its y less the band's top, `bandTop`), on a wrapper stack
 * under `CANVAS_IDS.item(id)` holding the item's node and its end mark (`CANVAS_IDS.itemEnd`).
 *
 * One definition per float region holding at least one item that prints (its table's key, by the
 * tables' drawn order, its items in the layout's order) and one for the band ("band") when an item
 * anchored page-bottom prints; an item whose node is null prints nothing and is left out, and a
 * region or band left with no item gives no definition. Each is an AUTO-HEIGHT page of the sheet's
 * width with no top or bottom margin (the `blockHeight` technique, render.ts; Ruling 5 of PR 2a):
 * pdfmake never breaks a page there, so every end mark lands on page 1 and an item's height is its
 * end mark's top less the offset it was placed at, with no cross-page arithmetic. The detached
 * items take no flow, so one 1 pt spacer gives the page a body.
 *
 * A preview alone renders these (`renderPreview`, template-preview.ts); a print never does.
 */
export function aloneLayouts(args: {
  layout: CanvasLayout; pageFooter: boolean; fonts: FontsConfig; itemContent: ItemContent;
}): { after: CanvasTableKey | "band"; def: RenderableDefinition }[] {
  const { layout, pageFooter, fonts, itemContent } = args;
  const wrapper = (item: CanvasItem, y: number): Content | null => {
    const node = itemContent(item);
    if (node === null) return null;
    return {
      id: CANVAS_IDS.item(item.id),
      absolutePosition: { x: item.box.x, y },
      stack: [node, mark(CANVAS_IDS.itemEnd(item.id))],
    } as WithId<Content>;
  };
  const page = (wrappers: Content[]): RenderableDefinition => ({
    pageSize: { width: CANVAS_PAGE.width, height: "auto" },
    pageMargins: [LEFT, 0, CANVAS_PAGE.margin, 0],
    defaultStyle: { font: fonts.family, fontSize: fonts.baseSize },
    content: [...wrappers, spacer(1)],
  });
  const answer: { after: CanvasTableKey | "band"; def: RenderableDefinition }[] = [];
  for (const table of tablesByY(layout)) {
    const wrappers: Content[] = [];
    for (const item of layout.items) {
      if (item.kind === "table" || item.anchor.kind !== "below-table" || item.anchor.table !== table.key) continue;
      const node = wrapper(item, item.box.y);
      if (node !== null) wrappers.push(node);
    }
    if (wrappers.length > 0) answer.push({ after: table.key, def: page(wrappers) });
  }
  const top = bandTop(layout, pageFooter);
  const band: Content[] = [];
  for (const item of layout.items) {
    if (item.kind === "table" || item.anchor.kind !== "page-bottom") continue;
    const node = wrapper(item, item.box.y - top);
    if (node !== null) band.push(node);
  }
  if (band.length > 0) answer.push({ after: "band", def: page(band) });
  return answer;
}
