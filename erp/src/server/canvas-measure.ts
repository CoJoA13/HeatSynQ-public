/**
 * A canvas document's MEASURE REPORT (the traveler's design `docs/superpowers/specs/2026-11-07-traveler-canvas-designer-design.md`
 * §5.3, PR B of #926, task 6; shared by every canvas document since the shipping ticket's design
 * `docs/superpowers/specs/2026-11-08-shipping-ticket-canvas-design.md` §5.2): where the preview laid
 * each table, each float region and each page-top item out for the picked record, so the designer
 * draws its floating items where they will print and `canvasWarnings` judges overlaps and overruns
 * on rendered boxes.
 *
 * One render serves the paper and the measure (design §14 call 6): the preview renders through
 * `renderSheetGroupsWithPositions`, whose bytes are `renderSheetGroups`' own, and this file maps the
 * positions that render already laid out. No second layout pass, and a print takes none at all
 * (§5.6).
 *
 * MARKS, NOT NODES, carry the positions. pdfmake reports a node's position from the outermost
 * writing context, so a node inside an `unbreakable` region or a `dontBreakRows` row reports where
 * that block began, and a table's own node reports its first laid-out line, under its top rule.
 * Every end mark the sheet emits (`CANVAS_IDS.end`, `regionEnd`, `itemEnd`) is a top-level node,
 * so its position is exact; a page-top item's wrapper reports its first laid-out line. A table's
 * own node (`CANVAS_IDS.table`) is read for its PAGE alone: when it reports a later page than its flow point, pdfmake moved the
 * table's first row to that page because it did not fit, and the table starts under that page's
 * top margin.
 *
 * Below-table and page-bottom items are not in THIS render's positions. A below-table item is a
 * detached node inside its unbreakable region, and a page-bottom item is laid out in pdfmake's
 * footer frame; neither carries an id there (`pdf/canvas-sheet.ts`'s header), because neither
 * position would mean anything. The preview measures them by laying each region's items and the
 * band's out once more alone (`aloneLayouts`) and merging those renders in (`mergeAloneMeasure`, the
 * shipping ticket design's §5.2); `canvasMeasure` alone reports the tables, the regions and the
 * page-top items, and `canvasWarnings` falls back to an item's drawn box for an entry the measure
 * does not hold.
 */
import { CANVAS_IDS } from "./pdf/canvas-sheet";
import type { LaidOutNode } from "./pdf/render";
import {
  bandTop, regionHeights, tablesByY, topMargin, usableHeight, type CanvasMeasure,
} from "@/lib/template-canvas";
import type { CanvasLayout } from "@/lib/template-contracts/canvas";

type Point = { page: number; top: number };

/**
 * The flow distance from `a` down to `b`: on one page their difference; across pages the rest of
 * `a`'s page down to the band's top, every whole page between (each the usable height, from the
 * fixed top margin to the band's top: the canvas lays every page out under the same margins), and
 * `b`'s page from the top margin down to `b`.
 */
function extent(a: Point, b: Point, bandTopY: number, usable: number, margin: number): number {
  if (b.page === a.page) return b.top - a.top;
  return (bandTopY - a.top) + (b.page - a.page - 1) * usable + (b.top - margin);
}

/**
 * The measure of one sheet group (the preview's first: on the traveler with All loads ticked every
 * sheet lays out the same tables and items at the same places but for its own load's figures, and
 * the designer draws one page).
 *
 * - `pages` is the group's page count.
 * - Each table of the STORED layout, top to bottom by its drawn y, starts at its flow point: the
 *   first at its drawn top on page 1 (the head spacer carries the flow there; the sheet's spacer
 *   is `max(0, y − topMargin)`, and the validator refuses a first table above the top margin, so the
 *   two coincide), every later one at the `regionEnd` mark of the table above. Unless its own node
 *   reports a later page (above): then it starts at `(that page, topMargin)`. Its height is the
 *   extent from there to its `end` mark. A table whose block the document omitted (every column
 *   hidden) has no node and an `end` mark at its flow point: it measures 0 tall there. A table whose
 *   block node reports `squeezed` (render.ts' column clamp corrected its columns, #971) carries it. A table
 *   whose region moved whole to the next page ends somewhere in the unfilled remainder of its page,
 *   and the `end` mark, a top-level node right after the table, reports exactly where.
 * - Each region ends at its table's `regionEnd` mark and is its drawn height tall
 *   (`regionHeights`): the region's spacer is its whole flow height, its items adding none. A region
 *   that moved whole reports the page it moved to. A trailing region from which nothing prints,
 *   which the sheet leaves out (#997), takes no flow, so its `regionEnd` mark sits on its `end` mark:
 *   it is reported there, at the table's rendered bottom, still its drawn height tall.
 * - Each page-top item that printed, under its own `id`: the box it was placed at (its stored x and
 *   y, Ruling 7), and the extent to its end mark. An item that printed nothing (an empty phone, no
 *   received-from lines, a logo item with no logo bytes) has no wrapper and is left out, as is an
 *   item missing either mark.
 *
 * The document's builder prints its belt's completion of the layout (`complete`: the traveler's
 * `completeCanvas`, which adds a missing barcode or steps table past the validator; the identity for
 * a document that requires nothing). The geometry here (top margin, band, region heights) is
 * therefore the COMPLETED layout's, the one that printed, while the tables and items reported are
 * the stored layout's alone: a belt item's id is one the stored layout does not know, so its marks
 * are ignored. A validated layout is complete, so in the preview the two are one.
 */
export function canvasMeasure(
  layout: CanvasLayout, pageFooter: boolean, group: { positions: LaidOutNode[]; pages: number },
  complete: (layout: CanvasLayout) => CanvasLayout,
): CanvasMeasure {
  const printed = complete(layout);
  const margin = topMargin(printed);
  const bandTopY = bandTop(printed, pageFooter);
  const usable = usableHeight(printed, pageFooter);
  const heights = new Map(regionHeights(printed).map((region) => [region.after, region.height] as const));
  const at = (id: string): LaidOutNode | undefined => group.positions.find((node) => node.id === id);
  const span = (a: Point, b: Point) => extent(a, b, bandTopY, usable, margin);

  const measure: CanvasMeasure = { pages: group.pages, tables: [], regions: [], items: [] };
  const tables = tablesByY(layout);
  let flow: Point = { page: 1, top: tables[0]?.box.y ?? margin };
  for (const table of tables) {
    const end = at(CANVAS_IDS.end(table.key));
    const regionEnd = at(CANVAS_IDS.regionEnd(table.key));
    // Both marks are emitted for every table the sheet prints; one missing means this group was
    // not a canvas sheet of this layout, and nothing after it can be placed.
    if (end === undefined || regionEnd === undefined) break;
    const own = at(CANVAS_IDS.table(table.key));
    const start: Point = own !== undefined && own.page > flow.page ? { page: own.page, top: margin } : flow;
    // `squeezed` from the block's own node (`laidOutNodes`): the column clamp corrected its columns.
    measure.tables.push({
      key: table.key, page: start.page, top: start.top, height: span(start, end),
      ...(own?.squeezed === true ? { squeezed: true as const } : {}),
    });
    const height = heights.get(table.key) ?? 0;
    // A region the sheet left out because nothing prints from it on (#997) took no flow: its
    // `regionEnd` mark lies exactly on its `end` mark, which a printed region of any height above 0
    // never does (its spacer puts the mark that far below, or on a later page). It is reported at its
    // table's rendered bottom, where it is drawn, at its drawn height.
    const dropped = height > 0 && regionEnd.page === end.page && regionEnd.top === end.top;
    measure.regions.push({ after: table.key, page: regionEnd.page, top: dropped ? end.top : regionEnd.top - height, height });
    flow = { page: regionEnd.page, top: regionEnd.top };
  }

  for (const item of layout.items) {
    if (item.kind === "table" || item.anchor.kind !== "page-top") continue;
    const node = at(CANVAS_IDS.item(item.id));
    const end = at(CANVAS_IDS.itemEnd(item.id));
    if (node === undefined || end === undefined) continue;
    // The box the wrapper was PLACED at (Ruling 7 of PR 2a): its stored x and y, and the extent from
    // that y to the end mark. The sheet places a page-top wrapper on page 1 (Ruling 14), so the
    // placed point is page 1 whatever page pdfmake laid the wrapper's first line on; when it pushed
    // that line to a later page, the extent spans the pages to the end mark and carries the
    // displacement to the warnings. The wrapper's own position is its first laid-out line, which in
    // a boxed cell is under the cell's rule and padding.
    const placed: Point = { page: 1, top: item.box.y };
    measure.items.push({ id: item.id, page: 1, left: item.box.x, top: item.box.y, height: span(placed, end) });
  }
  return measure;
}

/**
 * The measure with the alone layouts' items merged in (the shipping ticket design's §5.2): each
 * entry of `alone` is one alone layout's laid-out positions, under what it measures (`after`: a region's
 * table key, or "band"), as `aloneLayouts` (`pdf/canvas-sheet.ts`) builds them. For each item of
 * that region or band whose wrapper (`CANVAS_IDS.item`) and end mark (`CANVAS_IDS.itemEnd`) the
 * group holds, one entry is pushed, its height the end mark's top less the offset the alone page
 * placed its wrapper at (the alone page is auto-height with no top margin, so both are on page 1 in
 * page coordinates; Ruling 7 of PR 2a):
 *
 * - an item anchored below a table sits on the region's measured page, at the region's measured top
 *   plus its stored offset (`box.y`), at its drawn x. A region the measure does not hold (a table
 *   whose marks it did not find) leaves its items out, as the drawn boxes are then all there is.
 * - an item in the band sits at its drawn x and y (the band is reserved at the same place on every
 *   page), on the last page, or on page 1 when it repeats (it prints on every page; the designer
 *   draws one).
 *
 * The left and the height's start are the placed box's, never the wrapper's position: a wrapper
 * reports its first laid-out line, which in a boxed cell is inside the cell's rule and padding. The items already in the measure (the page-top
 * ones) are kept; the answer is a new measure, and the one passed in is not changed.
 */
export function mergeAloneMeasure(
  measure: CanvasMeasure, layout: CanvasLayout, pageFooter: boolean,
  alone: { after: string; positions: LaidOutNode[] }[],
): CanvasMeasure {
  // The band's top `aloneLayouts` took off each band item's y (it moves with the page line's room).
  const bandTopY = bandTop(layout, pageFooter);
  const items = [...measure.items];
  for (const { after, positions } of alone) {
    const at = (id: string): LaidOutNode | undefined => positions.find((node) => node.id === id);
    const region = after === "band" ? undefined : measure.regions.find((r) => r.after === after);
    if (after !== "band" && region === undefined) continue;
    for (const item of layout.items) {
      if (item.kind === "table") continue;
      const mine = after === "band"
        ? item.anchor.kind === "page-bottom"
        : item.anchor.kind === "below-table" && item.anchor.table === after;
      if (!mine) continue;
      const node = at(CANVAS_IDS.item(item.id));
      const end = at(CANVAS_IDS.itemEnd(item.id));
      if (node === undefined || end === undefined) continue;
      // The height from the offset the alone page placed the wrapper at (Ruling 7 of PR 2a), never
      // from the wrapper's own position, its first laid-out line.
      if (region === undefined) {
        const height = end.top - (item.box.y - bandTopY);
        items.push({ id: item.id, page: item.repeat ? 1 : measure.pages, left: item.box.x, top: item.box.y, height });
      } else {
        items.push({ id: item.id, page: region.page, left: item.box.x, top: region.top + item.box.y, height: end.top - item.box.y });
      }
    }
  }
  return { ...measure, items };
}
