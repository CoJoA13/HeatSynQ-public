/**
 * The traveler canvas designer's pure leaf (design `docs/superpowers/specs/2026-11-07-traveler-canvas-designer-design.md`
 * §8; PR C of #926): the geometry the Design tab draws and drags with, where a new item goes, the
 * palette, an item's name and every sentence the panel shows. No React, no DOM, no fetch; client-safe
 * (no `src/server` import). The rules a layout must pass live in `./template-canvas`, which this file
 * builds on and never restates.
 *
 * Coordinates. Points from the page's top-left, as the model stores them; the stage multiplies by
 * `fitScale`'s px per pt, and the inspector shows inches (`toInches`, `fromInches`). A NON-table item
 * anchored below a table stores `box.y` as its offset from the table's bottom (`drawnBox` turns it
 * into page coordinates). What the user drops is what prints (ruling C8): the stage drags the box it
 * drew (`stageBox`, the measured place when the preview's measure holds the item, a measured item at
 * its drawn height or its measured height, whichever is taller, and a table the record leaves empty at
 * its drawn box, #958) through `moveBox`, and `dropBox` turns that STAGE box back into the item's model
 * coordinates, judging the anchor against the table bottoms the stage shows (an empty table's, when its
 * region is on page 1, being that region's top, where the paper ends it and its below-table items are
 * drawn, not the hatch's stored bottom); a move keeps the item's stored size, so a drag never stores a
 * measured height, and `moveBox` clamps the move by the item's stored height (Ruling 8,
 * `moveClampHeight`; a table by the height the stage draws, which `stageBox` caps at the page's foot),
 * so a sideways nudge of an item drawn past the page's foot moves it sideways only. The stage is page 1: the stage
 * draws an item that prints on another page (`stageBox(...).page !== 1`) dashed at its drawn box; a
 * drag on it moves the model by the delta and keeps its anchor (ruling C13). `resizeBox` works on the
 * stored box, so an offset stays an offset; a resize starts from it with the height the stage draws
 * when its handle moves a top or bottom edge, and the stored height when it moves a side alone
 * (`resizeStart`, Ruling 7). The stage draws a resize at `resizedBox` and commits `resizedItem`, as it
 * draws a move at `moveBox` and commits `movedItem` (Ruling 9): it keeps no geometry of its own.
 *
 * The grid. A drag or nudge moves a box by whole grid steps (the delta is snapped, not the edge):
 * today's paper, seeded from the flow's positions, does not sit on the grid, and an item nudged one
 * step must move one step and keep its line with the items beside it. A typed figure is snapped
 * whole (`snap(fromInches(text))`).
 *
 * The document. Every function that needs the document is handed its contract and reads the
 * canvas profile it declares (design 2026-11-08 §4.1): its tables, its required items, a table
 * box's floor (`rowFloor`), the fields drawn in a border (`boxedFields`, `drawsBorder`) and the
 * fields drawn on a rule (`ruledFields`, `ruleOf`). No
 * document is named here but in the one table of how a sentence names the record a document prints
 * for (`CANVAS_RECORD_WORDS`, keyed by docType).
 */
import { newId } from "./client-id";
import { spelledDecimal } from "./decimal-entry";
import { round2 } from "./printed-width-core";
import { lineHeightOf } from "./tag-font-metrics";
import {
  STATIC_NAMES, bandTop, canvasFieldKeys, canvasProfile, defaultTableColumns, drawnBox, inferAnchor, inkBoxes, meets,
  leastWidth, pageFoot, regionHeights, tableName, tablesByY, type CanvasMeasure,
} from "./template-canvas";
import {
  BARCODE_MIN, CANVAS_GRID, CANVAS_PAGE,
  type CanvasAnchor, type CanvasPage, type CanvasBox, type CanvasItem, type CanvasLayout, type CanvasTableKey, type CanvasTextStyle,
} from "./template-contracts/canvas";
import type { CanvasRuledField, FontsConfig, TemplateContract, TemplateDocTypeString } from "./template-contracts/types";

type TableItem = Extract<CanvasItem, { kind: "table" }>;

export const INCH = 72;
/** An arrow key's nudge: one grid step, 1/16 in. */
export const NUDGE_FINE = CANVAS_GRID;
/** Shift and an arrow key: 1/4 in. */
export const NUDGE_COARSE = 18;

/** The four edges a box may sit inside on `page` (Letter by default): its margins in from each side.
 *  Read where it is used, never held at module load, so every mover judges the template's own page. */
export function edges(page: CanvasPage = CANVAS_PAGE): { left: number; right: number; top: number; bottom: number } {
  return { left: page.margin, right: page.width - page.margin, top: page.margin, bottom: page.height - page.margin };
}

function clamp(n: number, low: number, high: number): number {
  return Math.min(Math.max(n, low), Math.max(low, high));
}

/** Px per pt so the 612 pt page fits a column `columnPx` wide, never under 0.5 nor over 1.25. */
export function fitScale(columnPx: number, page: CanvasPage = CANVAS_PAGE): number {
  if (!(columnPx > 0)) return 0.5;
  return clamp(columnPx / page.width, 0.5, 1.25);
}

/** The nearest grid point (`CANVAS_GRID`, 4.5 pt = 1/16 in). */
export function snap(pt: number): number {
  return Math.round(pt / CANVAS_GRID) * CANVAS_GRID + 0;
}

/** Points as inches to two decimals, as the inspector shows them. */
export function toInches(pt: number): string {
  return (pt / INCH).toFixed(2);
}

/** Typed inches as points, read through the one decimal rule (`spelledDecimal`: `1.25`, `.5` and
 *  `2.` are figures; `1e2`, `$1`, `1,000` and `+1` are not). Null for text that is no figure: the
 *  inspector keeps the text and shows `DESIGNER_WORDS.notAFigure`. */
export function fromInches(text: string): number | null {
  const read = spelledDecimal(text);
  return read === null ? null : read.value * INCH;
}

/** One of the inspector's four inch boxes: the model box's x, y, width or height. */
export type BoxSide = "x" | "y" | "w" | "h";

/**
 * The inspector's reader for an item's inch box (ruling C31): the typed inches snapped whole to the
 * grid (`snap(fromInches(text))`), or the sentence the panel shows in place of a commit. Text that is
 * no figure is `DESIGNER_WORDS.notAFigure`. A width that snaps under one grid step (0, a negative, or
 * a figure too small to reach the first grid point) is `widthTooSmall`, and a height so is
 * `heightTooSmall`, on every kind: the floor holds on every OPEN side, and a line's zero side is a
 * closed box (`zeroSide`), so a vertical line's length is floored as any height is. The snapped
 * figure is judged, since it is what would be stored.
 * X and Y take any figure: the rules judge an item's place. A refusal commits nothing, and the box
 * shows the stored figure once it is left, as every refused figure box does.
 */
export function readSize(side: BoxSide): (text: string) => { value: number } | { refusal: string } {
  return (text) => {
    const pt = fromInches(text);
    if (pt === null) return { refusal: DESIGNER_WORDS.notAFigure };
    const value = snap(pt);
    if (side === "w" && value <= 0) return { refusal: DESIGNER_WORDS.widthTooSmall };
    if (side === "h" && value <= 0) return { refusal: DESIGNER_WORDS.heightTooSmall };
    return { value };
  };
}

/** The side a line is not drawn along, whose inspector box is closed with `DESIGNER_WORDS.lineOneAxis`
 *  (ruling C31): a horizontal line's height, a vertical line's width. Null for any other item, and for
 *  a line drawn along neither or both (the schema refuses it; `canvasRefusal` names it). */
export function zeroSide(item: CanvasItem): "w" | "h" | null {
  if (item.kind !== "line") return null;
  if (item.box.h === 0 && item.box.w !== 0) return "h";
  if (item.box.w === 0 && item.box.h !== 0) return "w";
  return null;
}

/** A box moved by (dx, dy) snapped to whole grid steps, kept inside the page's margins. It takes
 *  and answers the STAGE box (`stageBox`, page 1's coordinates), which `dropBox` turns back into
 *  the item's model coordinates. The vertical clamp keeps `y` at or above the page's foot less
 *  `clampHeight` (Ruling 8): the box's own height by default, and `moveClampHeight` from a move
 *  (`movedItem`, the stage's drag preview), so a measured item drawn taller than its box past the
 *  page's foot is not lifted by a sideways nudge. */
export function moveBox(
  box: CanvasBox, dx: number, dy: number, clampHeight: number = box.h, page: CanvasPage = CANVAS_PAGE,
): CanvasBox {
  const { left, right, top, bottom } = edges(page);
  return {
    ...box,
    x: clamp(box.x + snap(dx), left, right - box.w),
    y: clamp(box.y + snap(dy), top, bottom - clampHeight),
  };
}

/** The height a move of `item` from `start` (`dragStart`'s box) clamps by at the page's foot (Ruling 8):
 *  the item's STORED height, since a move keeps the stored size and a measured item drawn taller than
 *  its box may run past the foot; a table's stage height, which `stageBox` caps at the page's foot, so
 *  a table measured taller than its stored box is never dragged lower than it could be drawn. The
 *  stage height of a table the record leaves empty (`printsNothing`) is its stored one (#958). */
export function moveClampHeight(item: CanvasItem, start: CanvasBox): number {
  return item.kind === "table" ? start.h : item.box.h;
}

export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/**
 * The item's stored box with the handle's edges moved by (dx, dy) snapped to whole grid steps. The
 * moved edge stops at the item's floor, the opposite edge staying put, and the sides stay inside
 * the page's side margins (a box narrower than its floor, floored past a margin, moves its opposite
 * side instead):
 * - the barcode keeps its 186:44 proportions and never goes under 186 × 44: a handle with an east or
 *   west side sets its width (a north or south one alone its height) and the other side follows
 *   exactly, since the grid is not on the proportions (189 × 45 is refused);
 * - a table keeps one row (the profile's `rowFloor`; the traveler's 24) and its least width;
 * - a line keeps its zero side (a horizontal line takes no height, a vertical one no width);
 * - any item is at least its least width (`leastWidth`, at `fonts`' base size: a column table's
 *   columns and their padding and rules once per copy, what it keeps beside them and one grid step;
 *   a grid block's grid columns, read from `layout` when it is handed; a field's or a block's
 *   `leastWidths` entry) and one grid step wide, and at least one grid step tall.
 */
export function resizeBox(
  item: CanvasItem, handle: Handle, dx: number, dy: number, contract: TemplateContract, page: CanvasPage = CANVAS_PAGE,
  fonts: FontsConfig = contract.fonts, layout?: CanvasLayout,
): CanvasBox {
  const { x, y, w, h } = item.box;
  const { left: LEFT, right: RIGHT } = edges(page);
  const east = handle.includes("e");
  const west = handle.includes("w");
  const north = handle.includes("n");
  const south = handle.includes("s");

  if (item.kind === "barcode") {
    const ratio = BARCODE_MIN.width / BARCODE_MIN.height;
    const room = west ? x + w - LEFT : RIGHT - x;
    let width: number;
    if (east) width = w + snap(dx);
    else if (west) width = w - snap(dx);
    else width = (h + (south ? snap(dy) : -snap(dy))) * ratio;
    width = Math.max(BARCODE_MIN.width, Math.min(width, room));
    const height = (width * BARCODE_MIN.height) / BARCODE_MIN.width;
    return { x: west ? x + w - width : x, y: north ? y + h - height : y, w: width, h: height };
  }

  const minW = Math.max(CANVAS_GRID, leastWidth(contract, item, { fonts, layout }));
  let minH: number = CANVAS_GRID;
  let sideways = true;
  let upDown = true;
  if (item.kind === "table") {
    minH = canvasProfile(contract).rowFloor;
  } else if (item.kind === "line") {
    if (h === 0) upDown = false;
    else if (w === 0) sideways = false;
  } else if (canvasProfile(contract).oneLabel !== undefined && (item.kind === "field" || item.kind === "text")) {
    // One label (R12): a text box is never drawn shorter than one line of its text.
    minH = Math.max(minH, oneLineHeight(item, fonts));
  }

  let left = x;
  let right = x + w;
  let top = y;
  let bottom = y + h;
  if (sideways) {
    // A floor wider than the content width cannot fit (a template whose columns, with their padding
    // and rules and one grid step, pass it; #971): the box is held to the content width, never moved
    // off the page, so rule 9's sentence, not rule 4's "outside the page", is the one the designer shows.
    const floorW = Math.min(minW, RIGHT - LEFT);
    if (east) right = Math.min(right + snap(dx), RIGHT);
    if (west) left = Math.max(left + snap(dx), LEFT);
    if (right - left < floorW) {
      if (west) left = right - floorW;
      else right = left + floorW;
    }
    // A box already narrower than its floor (a width typed in the inspector) floored past a margin
    // moves its other side instead.
    if (right > RIGHT) {
      right = RIGHT;
      left = right - floorW;
    } else if (left < LEFT) {
      left = LEFT;
      right = left + floorW;
    }
  }
  if (upDown) {
    if (south) bottom += snap(dy);
    if (north) top += snap(dy);
    if (bottom - top < minH) {
      if (north) top = bottom - minH;
      else bottom = top + minH;
    }
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * The item a handle's drag resizes (Ruling 2 of Task 2's review; Ruling 7): a resize by a handle with
 * a north or south side (`n`, `s`, `ne`, `nw`, `se`, `sw`) starts from the box the stage draws, so the
 * item with its stored HEIGHT replaced by `dragStart`'s, the measured height where the measure holds
 * the item taller and the stored one otherwise. Its x, y and width stay the stored box's, so a
 * below-table item's offset stays an offset. An east or west handle moves a side alone and starts
 * from the item as it is stored, so a width-only resize never stores a measured height. A table comes
 * back as it is stored for every handle (its measured height is its rows', which the stored box does
 * not hold), and so does a line, whose zero side a resize must never draw. An item measured 30 tall
 * in a 12 pt box whose bottom handle is dragged 9 down commits 39 (`resizedItem`) and is drawn 39
 * during the drag (`resizedBox`) and after it; its east handle dragged 9 right, with the room before
 * the page's margin, commits it 9 wider and still 12 tall, drawn 30 tall during the drag.
 */
export function resizeStart(
  item: CanvasItem, layout: CanvasLayout, measure: CanvasMeasure | null, handle: Handle, page: CanvasPage = CANVAS_PAGE,
): CanvasItem {
  if (item.kind === "table" || item.kind === "line") return item;
  if (!handle.includes("n") && !handle.includes("s")) return item;
  const h = dragStart(item, layout, measure, page).h;
  return h === item.box.h ? item : { ...item, box: { ...item.box, h } };
}

/**
 * The box the stage draws an item at while its `handle` is dragged by (dx, dy) points (Ruling 9): the
 * drag's start (`dragStart`, the box the stage draws at rest) with the handle's edges moved as
 * `resizeBox` moves them from `resizeStart`'s item. The difference is taken in the item's model
 * coordinates and added to the stage's, so a below-table item is drawn where its region puts it.
 */
export function resizedBox(
  item: CanvasItem, layout: CanvasLayout, measure: CanvasMeasure | null, handle: Handle, dx: number, dy: number,
  contract: TemplateContract, page: CanvasPage = CANVAS_PAGE, fonts: FontsConfig = contract.fonts,
): CanvasBox {
  const start = dragStart(item, layout, measure, page);
  const from = resizeStart(item, layout, measure, handle, page);
  const resized = resizeBox(from, handle, dx, dy, contract, page, fonts, layout);
  return {
    x: start.x + (resized.x - from.box.x), y: start.y + (resized.y - from.box.y),
    w: start.w + (resized.w - from.box.w), h: start.h + (resized.h - from.box.h),
  };
}

/**
 * The item a handle's drag by (dx, dy) points commits (Ruling 9): the item with `resizeBox`'s box
 * from `resizeStart`'s item, or null when that box is `resizeStart`'s own (a handle clicked without
 * moving, or a drag the floor or the margins hold where it was), which commits nothing. The stage
 * commits the answer once, through `onCommit`.
 */
export function resizedItem(
  item: CanvasItem, layout: CanvasLayout, measure: CanvasMeasure | null, handle: Handle, dx: number, dy: number,
  contract: TemplateContract, page: CanvasPage = CANVAS_PAGE, fonts: FontsConfig = contract.fonts,
): CanvasItem | null {
  const from = resizeStart(item, layout, measure, handle, page);
  const box = resizeBox(from, handle, dx, dy, contract, page, fonts, layout);
  return sameBox(box, from.box) ? null : { ...item, box };
}

/** One line of a field's or text's text at its size and face in the template's fonts, rounded UP to
 *  0.001 (R12 compares raw heights, so a box of exactly this height passes rule 10). */
export function oneLineHeight(item: Extract<CanvasItem, { kind: "field" | "text" }>, fonts: FontsConfig): number {
  return Math.ceil(lineHeightOf(fonts.family, item.style.bold ? "bold" : "normal", item.style.size) * 1000) / 1000;
}

/** Whether two boxes are the same four figures. */
export function sameBox(a: CanvasBox, b: CanvasBox): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** Whether two copies of an item stand in the same place: the same box, anchor and repeat flag,
 *  the three things a move (`dropBox`) can change. */
export function sameItemPlace(a: CanvasItem, b: CanvasItem): boolean {
  const sameAnchor = a.anchor.kind === b.anchor.kind
    && (a.anchor.kind !== "below-table" || (b.anchor.kind === "below-table" && a.anchor.table === b.anchor.table));
  return sameBox(a.box, b.box) && sameAnchor && a.repeat === b.repeat;
}

/** Where a drag or nudge of the item starts on the stage: its stage box when it prints on page 1,
 *  its drawn box when it prints on another page, which the stage draws dashed there (ruling C13). A
 *  table the record leaves empty (`printsNothing`) starts from its drawn box, which is its stage box
 *  (#958). */
export function dragStart(
  item: CanvasItem, layout: CanvasLayout, measure: CanvasMeasure | null, page: CanvasPage = CANVAS_PAGE,
): CanvasBox {
  const stage = stageBox(item, layout, measure, page);
  return stage.page === 1 ? stage.box : drawnBox(item, layout);
}

/**
 * The item a drag or arrow-key nudge by (dx, dy) points commits, or null when it commits nothing:
 * when the delta snaps to no grid step (a click), and when the drop leaves the item's box, anchor
 * and repeat as they were (ruling C33: an arrow pressed against a margin, which `moveBox` clamps
 * back to the same box, must not mark the draft changed). Otherwise `{ ...item, ...dropBox(...) }`
 * from `dragStart`'s box moved by `moveBox`, clamped by `moveClampHeight` (Ruling 8). The
 * stage commits the answer once, through `onCommit`.
 */
export function movedItem(
  layout: CanvasLayout, item: CanvasItem, dx: number, dy: number,
  options: { pageFooter?: boolean; measure?: CanvasMeasure | null; page?: CanvasPage } = {},
): CanvasItem | null {
  if (snap(dx) === 0 && snap(dy) === 0) return null;
  const page = options.page ?? CANVAS_PAGE;
  const start = dragStart(item, layout, options.measure ?? null, page);
  const next: CanvasItem = {
    ...item, ...dropBox(layout, item, moveBox(start, dx, dy, moveClampHeight(item, start), page), options),
  };
  return sameItemPlace(next, item) ? null : next;
}

/** The bottom of each table as the stage shows it on PAGE 1, which is the page the stage draws
 *  (ruling C11): a table whose measured region is on page 1 at the region's top (the table's
 *  rendered bottom); a table the measure does not hold at its drawn bottom; a table whose region is
 *  on another page not at all, since its bottom lies on no point of page 1. With no measure, every
 *  drawn bottom. An empty table's bottom (`printsNothing`, drawn hatched at its stored box) follows
 *  the same branches: its region's top when that region is on page 1, where the paper ends it and its
 *  below-table items are drawn, not the hatch's stored bottom; none when the region is on another
 *  page (#958). */
function stageBottoms(layout: CanvasLayout, measure: CanvasMeasure | null): { key: CanvasTableKey; bottom: number }[] {
  const bottoms: { key: CanvasTableKey; bottom: number }[] = [];
  for (const table of tablesByY(layout)) {
    const region = measure?.regions.find((r) => r.after === table.key);
    if (region === undefined) bottoms.push({ key: table.key, bottom: table.box.y + table.box.h });
    else if (region.page === 1) bottoms.push({ key: table.key, bottom: region.top });
  }
  return bottoms;
}

/**
 * Where an item the user dropped at `moved` is stored, its anchor and its repeat flag (ruling C8).
 * `moved` is the box the stage drew the item at, shifted by the drag: `stageBox(...).box` under the
 * same `measure` for an item that prints on page 1, and `drawnBox(item, layout)` for one that prints
 * on another page, which the stage draws dashed at its drawn box. The answer is in the item's MODEL
 * coordinates, ready to spread over the item (`{ ...item, ...dropBox(...) }` is a whole item). A
 * move never resizes: every answer but a table's carries the item's own width and height, whatever
 * height the stage drew it at (a measured item is drawn at least its measured height):
 * - An item that prints on another page (`stageBox(...).page !== 1`) is moved by the drag alone:
 *   `item.box` plus (`moved` less its drawn box), on all four sides for a table and on x and y for
 *   anything else, its anchor and repeat its own; no anchor is inferred and no band clamps it, since
 *   the stage does not show the page it prints on (ruling C13).
 * - A table keeps its anchor (derived from the stacking), and its model box moves by the drag
 *   alone: `item.box` plus (`moved` less its stage box), so a table the measure pushed down 100 and
 *   the user dragged down 20 is stored 20 lower.
 * - A page-bottom item keeps its anchor, since the inspector is the only way into or out of the
 *   band, and its drop is clamped inside the band as the layout holds it now (from `bandTop` to the
 *   page's foot, less its stored height): a drag moves an item within the band and never raises the
 *   band's top, which the inspector's Y does. The band's topmost item is therefore a one-way
 *   ratchet by drag: dragged down it lowers the band's top, and only its Y in the inspector takes it
 *   back up (for a sole page-bottom item, every drag is that item's).
 * - Any other item hangs below the nearest table whose bottom AS THE STAGE SHOWS IT ON PAGE 1
 *   (`stageBottoms`) is at or above its top, its `y` stored as the offset from that bottom, so the
 *   stage draws it where it was dropped (an empty table's bottom, when its region is on page 1, is
 *   that region's top, where the paper ends it and its below-table items are drawn, not the hatch's
 *   stored bottom, #958); else it is page-top at `moved` itself (a page-top item does not move with
 *   growth). With no measure every bottom is drawn, `inferAnchor`'s answer.
 * `repeat` is false on a below-table answer (the rules refuse a repeating below-table item), else
 * the item's own.
 */
export function dropBox(
  layout: CanvasLayout, item: CanvasItem, moved: CanvasBox,
  options: { pageFooter?: boolean; measure?: CanvasMeasure | null; page?: CanvasPage } = {},
): { box: CanvasBox; anchor: CanvasAnchor; repeat: boolean } {
  const measure = options.measure ?? null;
  const page = options.page ?? CANVAS_PAGE;
  const stage = stageBox(item, layout, measure, page);
  if (stage.page !== 1 || item.kind === "table") {
    const staged = stage.page !== 1 ? drawnBox(item, layout) : stage.box;
    const box = item.kind === "table"
      ? {
        x: item.box.x + (moved.x - staged.x), y: item.box.y + (moved.y - staged.y),
        w: item.box.w + (moved.w - staged.w), h: item.box.h + (moved.h - staged.h),
      }
      : { x: item.box.x + (moved.x - staged.x), y: item.box.y + (moved.y - staged.y), w: item.box.w, h: item.box.h };
    return { box, anchor: item.anchor, repeat: item.repeat };
  }
  if (item.anchor.kind === "page-bottom") {
    const pageFooter = options.pageFooter ?? false;
    const top = bandTop(layout, pageFooter, page);
    const y = clamp(moved.y, top, pageFoot(pageFooter, page) - item.box.h);
    return { box: { x: moved.x, y, w: item.box.w, h: item.box.h }, anchor: item.anchor, repeat: item.repeat };
  }
  let nearest: { key: CanvasTableKey; bottom: number } | null = null;
  for (const table of stageBottoms(layout, measure)) {
    if (table.bottom <= moved.y && (nearest === null || table.bottom > nearest.bottom)) nearest = table;
  }
  const size = { w: item.box.w, h: item.box.h };
  if (nearest === null) return { box: { x: moved.x, y: moved.y, ...size }, anchor: { kind: "page-top" }, repeat: item.repeat };
  return {
    box: { x: moved.x, y: moved.y - nearest.bottom, ...size }, anchor: { kind: "below-table", table: nearest.key }, repeat: false,
  };
}

/** A page-coordinate box in the coordinates `anchor` stores: an offset from the anchor table's
 *  bottom for a below-table anchor (page coordinates when the layout does not place the table). */
function offsetBox(layout: CanvasLayout, box: CanvasBox, anchor: CanvasAnchor): CanvasBox {
  if (anchor.kind !== "below-table") return { ...box };
  const table = layout.items.find((other): other is TableItem => other.kind === "table" && other.key === anchor.table);
  return table === undefined ? { ...box } : { ...box, y: box.y - (table.box.y + table.box.h) };
}

/** The inspector's anchor change: the item where it is drawn, re-stored under `anchor`, and
 *  `repeat` cleared on a below-table anchor (the rules refuse a repeating below-table item). A
 *  table's anchor is derived from the stacking, never set: a table comes back as it is. */
export function setAnchor(layout: CanvasLayout, item: CanvasItem, anchor: CanvasAnchor): CanvasItem {
  if (item.kind === "table") return item;
  const box = offsetBox(layout, drawnBox(item, layout), anchor);
  return { ...item, anchor, box, repeat: anchor.kind === "below-table" ? false : item.repeat };
}

/** One entry of the palette: a field (by `key`), a table (by `key`) or a page item. `placed`: the
 *  layout holds it (a field may be placed again, so a placed field is only marked); `required`: an
 *  item the profile requires (the traveler's barcode and steps table). */
export type PaletteEntry = {
  kind: CanvasItem["kind"]; key?: string; label: string; group: string; state: "available" | "placed" | "required";
};

function assertNever(value: never): never {
  throw new Error(`Unhandled required kind: ${JSON.stringify(value)}`);
}

/** Whether the profile requires the item, which can then be moved and never removed (the
 *  traveler's: the barcode and the Process steps table). The palette marks it "required", the stage
 *  titles it so, and the panel and the inspector refuse its removal (`DESIGNER_WORDS.cannotRemove`).
 *  A contract with no canvas requires nothing. */
export function isRequired(item: { kind: CanvasItem["kind"]; key?: string }, contract: TemplateContract): boolean {
  return (contract.canvas?.required ?? []).some((required) => {
    switch (required.kind) {
      case "barcode": return item.kind === "barcode";
      case "table": return item.kind === "table" && item.key === required.key;
      case "field": return item.kind === "field" && item.key === required.key;
      default: return assertNever(required);
    }
  });
}

/** Whether the stage draws the item in a border, as the paper prints it: a field item whose key
 *  the profile's `boxedFields` names (the shipping ticket's party boxes). Any other item, and any
 *  item on a contract with no canvas, prints bare. */
export function drawsBorder(item: CanvasItem, contract: TemplateContract): boolean {
  return item.kind === "field" && (contract.canvas?.boxedFields ?? []).includes(item.key);
}

/** How the stage draws the item on a rule, as the paper prints it: a field item's `ruledFields` entry
 *  (the bill of lading's form and write-in rules, its carrier line and its consignee). Any other item,
 *  and any item on a contract with no canvas, draws bare: null. */
export function ruleOf(item: CanvasItem, contract: TemplateContract): CanvasRuledField | null {
  if (item.kind !== "field") return null;
  return contract.canvas?.ruledFields.find((ruled) => ruled.key === item.key) ?? null;
}

/** Where the stage draws a ruled field's label, as the paper prints it (owner ruling on #1053,
 *  2026-11-25): the entry's label column and the gap before the rule, in points, and the type the
 *  label is drawn at, the entry's fixed type set left where the paper fixes one (the bill of lading's
 *  carrier, whose item style is its name's), else the item's own style. The stage wraps the label
 *  inside the column, as pdfmake does. */
export function ruledLabelOf(
  item: Extract<CanvasItem, { kind: "field" }>, ruled: CanvasRuledField,
): { width: number; gap: number; style: CanvasTextStyle } {
  const { width, gap, type } = ruled.label;
  return { width, gap, style: type === undefined ? item.style : { size: type.size, bold: type.bold, align: "left" } };
}

const TABLES_GROUP = "Tables";
const WORDING_GROUP = "Wording";
const PAGE_ITEMS_GROUP = "Page items";

/** The default box of a new item of each kind (a table's is `placeNew`'s own). A text block is the
 *  content width wide and 24 pt tall, 564 × 24. */
function newSize(kind: Exclude<CanvasItem["kind"], "table">, page: CanvasPage): { w: number; h: number } {
  if (kind === "textBlock") return { w: edges(page).right - edges(page).left, h: 24 };
  return NEW_SIZE[kind];
}
const NEW_SIZE: Record<Exclude<CanvasItem["kind"], "table" | "textBlock">, { w: number; h: number }> = {
  field: { w: 180, h: 12 },
  text: { w: 180, h: 12 },
  line: { w: 180, h: 0 },
  box: { w: 90, h: 45 },
  logo: { w: 80, h: 40 },
  barcode: { w: BARCODE_MIN.width, h: BARCODE_MIN.height },
};
/** A new table's top on a layout with no table (the belt's steps table's, `completeCanvas`). */
const FIRST_TABLE_TOP = 140;
/** A new line's or box's stroke weight. */
const NEW_WEIGHT = 1;

/** Whether `item`'s ink meets the ink of anything the layout draws. */
function inkMeetsAny(layout: CanvasLayout, item: CanvasItem): boolean {
  const ink = inkBoxes(item);
  return layout.items.some((other) => {
    const drawn = { ...other, box: drawnBox(other, layout) } as CanvasItem;
    return inkBoxes(drawn).some((a) => ink.some((b) => meets(a, b)));
  });
}

/**
 * The item a palette entry adds, with a fresh id (`newId`).
 * - A table: the content width wide, one row tall (the profile's `rowFloor`), at the left margin,
 *   one grid step under the lowest table and everything hung below it (140 with no table), anchored
 *   below that table (page top with none), with the contract's columns (`defaultTableColumns`).
 * - Anything else: at the left margin, on the first grid row under the lowest page-top item (the
 *   page's top margin with none) that ends at or above the band's top (`bandTop`: the page's foot,
 *   less the page line's room when `pageFooter`, when nothing is anchored page-bottom) and where its
 *   ink meets no item's, its anchor inferred from there as a drop's is (so a row under a table hangs
 *   below it). When no row is free, the first row anyway, overlapping what is there, for the user
 *   to drag. A field 180 × 12 at the template's base size, or its least width (`leastWidth`) when
 *   wider, so a field with fixed parts lands as wide as rule 4 asks; a text item 180 × 12 reading
 *   "Text", a text block 564 × 24 at the template's small size printing the entry's wording, a line
 *   180 × 0 and a box 90 × 45 at weight 1, the logo 80 × 40, a barcode 186 × 44 (the palette offers
 *   one only on a profile that places a barcode).
 */
export function placeNew(
  layout: CanvasLayout, contract: TemplateContract, entry: PaletteEntry, options: { pageFooter?: boolean; page?: CanvasPage; fonts?: FontsConfig } = {},
): CanvasItem {
  const id = newId();
  const page = options.page ?? CANVAS_PAGE;
  const { left: LEFT, right: RIGHT, top: TOP } = edges(page);
  if (entry.kind === "table") {
    const key = entry.key ?? "";
    const last = tablesByY(layout).at(-1);
    let y: number = FIRST_TABLE_TOP;
    if (last !== undefined) {
      const tail = regionHeights(layout).find((region) => region.after === last.key)?.height ?? 0;
      y = last.box.y + last.box.h + tail + CANVAS_GRID;
    }
    return {
      id, kind: "table", key, heading: null, columns: defaultTableColumns(contract, key), repeat: false,
      box: { x: LEFT, y, w: RIGHT - LEFT, h: canvasProfile(contract).rowFloor },
      anchor: last === undefined ? { kind: "page-top" } : { kind: "below-table", table: last.key },
    };
  }

  const { w: defaultW, h: sized } = newSize(entry.kind, page);
  // One label (R12): a field or a text starts one line tall in the template's fonts.
  const oneLabel = canvasProfile(contract).oneLabel !== undefined && (entry.kind === "field" || entry.kind === "text");
  const h = oneLabel
    ? oneLineHeight({ kind: "field", style: { size: contract.fonts.baseSize, bold: false, align: "left" } } as Extract<CanvasItem, { kind: "field" }>, options.fonts ?? contract.fonts)
    : sized;
  let lowest: number = TOP;
  for (const item of layout.items) {
    if (item.kind === "table" || item.anchor.kind !== "page-top") continue;
    lowest = Math.max(lowest, item.box.y + item.box.h);
  }
  const shape = (box: CanvasBox, anchor: CanvasAnchor): CanvasItem => {
    const common = { id, box, anchor, repeat: false };
    const style = { size: contract.fonts.baseSize, bold: false, align: "left" as const };
    switch (entry.kind) {
      case "field": return { ...common, kind: "field", key: entry.key ?? "", label: null, style };
      case "text": return { ...common, kind: "text", text: STATIC_NAMES.text, style };
      case "textBlock":
        return { ...common, kind: "textBlock", key: entry.key ?? "", style: { ...style, size: contract.fonts.smallSize } };
      case "line": return { ...common, kind: "line", weight: NEW_WEIGHT };
      case "box": return { ...common, kind: "box", weight: NEW_WEIGHT };
      case "logo": return { ...common, kind: "logo" };
      default: return { ...common, kind: "barcode" };
    }
  };
  // A field is at least its least width, read before the free-row search so the search tries the
  // box it places.
  const w = entry.kind === "field"
    ? Math.max(defaultW, leastWidth(contract, shape({ x: LEFT, y: TOP, w: defaultW, h }, { kind: "page-top" }), { fonts: options.fonts, layout }))
    : defaultW;
  const first = Math.ceil(lowest / CANVAS_GRID) * CANVAS_GRID;
  const band = bandTop(layout, options.pageFooter ?? false, page);
  let free = first;
  for (let y = first; y + h <= band; y += CANVAS_GRID) {
    if (!inkMeetsAny(layout, shape({ x: LEFT, y, w, h }, { kind: "page-top" }))) {
      free = y;
      break;
    }
  }
  const box = { x: LEFT, y: free, w, h };
  const anchor = inferAnchor(layout, box);
  return shape(offsetBox(layout, box, anchor), anchor);
}

/** The palette's and the stage's name for an item of this kind and key. */
function titleOf(kind: CanvasItem["kind"], key: string | undefined, contract: TemplateContract): string {
  if (kind === "field") {
    const field = contract.sections.flatMap((section) => section.fields).find((f) => f.key === key);
    return field === undefined ? `Field "${key ?? ""}"` : field.name;
  }
  if (kind === "table") return `${tableName(contract, key ?? "")} table`;
  if (kind === "textBlock") {
    const block = contract.textBlocks.find((b) => b.key === key);
    return block === undefined ? `Wording "${key ?? ""}"` : `${block.name} wording`;
  }
  return STATIC_NAMES[kind];
}

/**
 * The palette: the contract's placeable fields (`canvasFieldKeys`), grouped under their section's
 * name in the contract's order (a section placing no field prints no group); then the profile's
 * tables in its order ("Tables"); then the contract's text blocks by their names ("Wording"), but
 * for those a profile table prints itself (its spec's `textBlocks`, which rule 2 refuses as items);
 * then the barcode (only on a profile that places one), the logo, static text, a line and a box
 * ("Page items"). A field, table, text block or logo the layout holds is "placed"; an item the profile
 * requires (`isRequired`) is "required": a table or the barcode placed or not, a field once placed (an unplaced one is "available"). Text, line and box are always available.
 */
export function paletteEntries(layout: CanvasLayout, contract: TemplateContract): PaletteEntry[] {
  const placeable = canvasFieldKeys(contract);
  const fields = new Set<string>();
  const tables = new Set<string>();
  const blocks = new Set<string>();
  let logo = false;
  for (const item of layout.items) {
    if (item.kind === "field") fields.add(item.key);
    else if (item.kind === "table") tables.add(item.key);
    else if (item.kind === "textBlock") blocks.add(item.key);
    else if (item.kind === "logo") logo = true;
  }
  const entries: PaletteEntry[] = [];
  for (const section of contract.sections) {
    for (const f of section.fields) {
      if (!placeable.has(f.key)) continue;
      // A required field is "required" once placed (the plan); unplaced it is "available" like any other.
      const state = !fields.has(f.key) ? "available" : isRequired({ kind: "field", key: f.key }, contract) ? "required" : "placed";
      entries.push({ kind: "field", key: f.key, label: f.name, group: section.name, state });
    }
  }
  for (const { key } of canvasProfile(contract).tables) {
    const state = isRequired({ kind: "table", key }, contract) ? "required" : tables.has(key) ? "placed" : "available";
    entries.push({ kind: "table", key, label: titleOf("table", key, contract), group: TABLES_GROUP, state });
  }
  // A wording a profile table prints itself is edited on the Wording tab, never placed (rule 2).
  const printedByBlock = new Set(canvasProfile(contract).tables.flatMap((spec) => spec.textBlocks ?? []));
  for (const block of contract.textBlocks) {
    if (printedByBlock.has(block.key)) continue;
    entries.push({
      kind: "textBlock", key: block.key, label: titleOf("textBlock", block.key, contract), group: WORDING_GROUP,
      state: blocks.has(block.key) ? "placed" : "available",
    });
  }
  if (canvasProfile(contract).barcode) {
    entries.push({
      kind: "barcode", label: STATIC_NAMES.barcode, group: PAGE_ITEMS_GROUP, state: isRequired({ kind: "barcode" }, contract) ? "required" : "available",
    });
  }
  entries.push({ kind: "logo", label: STATIC_NAMES.logo, group: PAGE_ITEMS_GROUP, state: logo ? "placed" : "available" });
  for (const kind of ["text", "line", "box"] as const) {
    entries.push({ kind, label: STATIC_NAMES[kind], group: PAGE_ITEMS_GROUP, state: "available" });
  }
  return entries;
}

/** "Clear the page": the items the profile requires, in its order, where the belt puts them
 *  (`completeCanvas`): a barcode at the header's right slot, page-top and repeated, and the required
 *  tables stacked, each the content width wide and one row (`rowFloor`) tall, with the contract's
 *  columns: the first at 140, page-top, and each next one grid step under the one before, anchored
 *  below it (the traveler's: its barcode and its steps table). A profile requiring nothing clears to
 *  an empty canvas. */
export function clearedLayout(contract: TemplateContract, page: CanvasPage = CANVAS_PAGE, fonts: FontsConfig = contract.fonts): CanvasLayout {
  const { left: LEFT, right: RIGHT } = edges(page);
  const profile = canvasProfile(contract);
  let previous: TableItem | null = null;
  const items = profile.required.map((required): CanvasItem => {
    if (required.kind === "barcode") {
      return {
        id: newId(), kind: "barcode", anchor: { kind: "page-top" }, repeat: true,
        box: { x: RIGHT - BARCODE_MIN.width, y: 48, w: BARCODE_MIN.width, h: BARCODE_MIN.height },
      };
    }
    if (required.kind === "field") {
      const style = { size: contract.fonts.baseSize, bold: false, align: "left" as const };
      const field = {
        id: newId(), kind: "field" as const, key: required.key, label: null, anchor: { kind: "page-top" as const }, repeat: false,
        box: { x: LEFT, y: edges(page).top, ...NEW_SIZE.field }, style,
      };
      if (profile.oneLabel !== undefined) field.box = { ...field.box, h: oneLineHeight(field, fonts) };
      return field;
    }
    if (required.kind !== "table") return assertNever(required);
    const above: TableItem | null = previous;
    const table: TableItem = {
      id: newId(), kind: "table", key: required.key, heading: null, repeat: false,
      anchor: above === null ? { kind: "page-top" } : { kind: "below-table", table: above.key },
      columns: defaultTableColumns(contract, required.key),
      box: {
        x: LEFT, y: above === null ? FIRST_TABLE_TOP : above.box.y + above.box.h + CANVAS_GRID, w: RIGHT - LEFT, h: profile.rowFloor,
      },
    };
    previous = table;
    return table;
  });
  return { version: 1, items };
}

/** Whether `item` is a table the picked record leaves empty (#958): the preview's measure holds it,
 *  at a height that rounds to 0 at two decimals (`round2`, the rounding warnings (a) and (b) judge
 *  by), since an empty block's height is the difference of two laid-out points and may carry a float
 *  residue. A table the measure does not hold is not judged (it stays unmeasured), and neither is any
 *  other kind of item. The stage draws such a table at its drawn box, hatched and titled
 *  `DESIGNER_WORDS.printsNothing`. */
export function printsNothing(item: CanvasItem, measure: CanvasMeasure | null): boolean {
  if (item.kind !== "table") return false;
  const entry = measure?.tables.find((table) => table.key === item.key);
  return entry !== undefined && round2(entry.height) === 0;
}

/**
 * Where the stage draws an item, on which page it prints for the picked order, and whether the box
 * came from the preview's measure (`measured`):
 * - a table at its measured top and height, on the page it starts on, the height capped at the
 *   page's usable bottom (768 less its top): the stage is page 1 and draws nothing taller than the
 *   page, so a table that runs onto page 2 is drawn down to the page's foot (ruling C10);
 * - a table the picked record leaves empty (`printsNothing`: the measure holds it at 0 pt at two
 *   decimals) at its drawn box on page 1, since it prints on no page (#958); it answers `measured`
 *   true, since the measure holds it, though its box is the drawn one;
 * - a below-table item at its offset from its table's measured region top (the table's rendered
 *   bottom), on the region's page;
 * - a page-top item at its box, on the page the measure reports it on;
 * - a page-bottom item at its box, on the page the measure reports it on; with no entry for it, on
 *   the last page, or the first when it repeats on every page, unmeasured.
 * A non-table item the measure holds (`measure.items`) is drawn at its drawn height or its measured
 * height, whichever is taller: the paper grows a box to its content and never shrinks one, and the
 * stored box is left as it is (`dropBox` keeps the item's size).
 * Without a measure, or for an item the measure does not place, the drawn box on page 1.
 */
export function stageBox(
  item: CanvasItem, layout: CanvasLayout, measure: CanvasMeasure | null, page: CanvasPage = CANVAS_PAGE,
): { box: CanvasBox; page: number; measured: boolean } {
  const unmeasured = { box: drawnBox(item, layout), page: 1, measured: false };
  if (measure === null) return unmeasured;
  if (item.kind === "table") {
    const m = measure.tables.find((table) => table.key === item.key);
    if (m === undefined) return unmeasured;
    if (printsNothing(item, measure)) return { box: drawnBox(item, layout), page: 1, measured: true };
    return { box: { ...item.box, y: m.top, h: Math.min(m.height, edges(page).bottom - m.top) }, page: m.page, measured: true };
  }
  const m = measure.items.find((other) => other.id === item.id);
  const h = m === undefined ? item.box.h : Math.max(item.box.h, m.height);
  if (item.anchor.kind === "below-table") {
    const after = item.anchor.table;
    const region = measure.regions.find((r) => r.after === after);
    return region === undefined ? unmeasured : { box: { ...item.box, y: region.top + item.box.y, h }, page: region.page, measured: true };
  }
  if (item.anchor.kind === "page-bottom") {
    return m === undefined ? { ...unmeasured, page: item.repeat ? 1 : measure.pages } : { box: { ...item.box, h }, page: m.page, measured: true };
  }
  return m === undefined ? unmeasured : { box: { ...item.box, h }, page: m.page, measured: true };
}

/** The palette's and the stage's name for an item: a field's contract name ("Company name"), a
 *  table's `tableName` ("Part lines table"; a field-keyed block's field's name, "Consignee's ref/PO
 *  table"), a page item's kind ("Logo"). Shorter than the
 *  refusals' names (`itemName` in `./template-canvas`, "The Company name field"), which a sentence
 *  needs and a label does not. */
export function itemTitle(item: CanvasItem, contract: TemplateContract): string {
  return titleOf(item.kind, item.kind === "field" || item.kind === "table" || item.kind === "textBlock" ? item.key : undefined, contract);
}

/** The layout with the item of the same id replaced by `item`. */
export function replaceItem(layout: CanvasLayout, item: CanvasItem): CanvasLayout {
  return { ...layout, items: layout.items.map((other) => (other.id === item.id ? item : other)) };
}

/**
 * The layout without the item `id`. It refuses nothing: the panel refuses the barcode and the steps
 * table (`DESIGNER_WORDS.cannotRemove`) before it calls this.
 *
 * Removing a TABLE re-homes every item anchored below it at its drawn place (ruling C30), since an
 * anchor naming a table the canvas no longer places is refused (rule 3) and would draw the item's
 * stored offset as a page y. Each such item's drawn box is taken while the table is still in the
 * layout; its anchor is then inferred from that box against the tables that remain (`inferAnchor`:
 * below the nearest remaining table above it, else page-top), and the box re-stored under it
 * (`offsetBox`), so it is drawn exactly where it was. `repeat` is cleared on a below-table answer, as
 * `setAnchor` does. A table that stacked below the removed one keeps its box and takes the anchor
 * the stacking now derives for it (the table above it by y, else page-top). Not through
 * `setAnchor`: that reads the drawn box from the layout it is handed, which no longer holds the
 * table, and it leaves a table as it is.
 */
export function removeItem(layout: CanvasLayout, id: string): CanvasLayout {
  const removed = layout.items.find((item) => item.id === id);
  const without: CanvasLayout = { ...layout, items: layout.items.filter((item) => item.id !== id) };
  if (removed === undefined || removed.kind !== "table") return without;
  return {
    ...without,
    items: without.items.map((item) => {
      if (item.anchor.kind !== "below-table" || item.anchor.table !== removed.key) return item;
      if (item.kind === "table") return { ...item, anchor: inferAnchor(without, item.box) };
      const box = drawnBox(item, layout);
      const anchor = inferAnchor(without, box);
      return { ...item, anchor, box: offsetBox(without, box, anchor), repeat: anchor.kind === "below-table" ? false : item.repeat };
    }),
  };
}

/** How the designer's sentences name the record a document prints for: the Preview pick it asks
 *  for (`pick`), the paper the canvas is seeded from (`subject`, given the record's number) and
 *  whom a page prints for (`prints`). */
// The pick nouns restate previewRecordSpec's (template-editor.ts imports this leaf, so it cannot be
// imported here); tests/template-editor.test.ts holds the two together.
// Every docType has its words, so a new docType is a compile error here until it is named.
export const CANVAS_RECORD_WORDS: Record<TemplateDocTypeString, {
  pick: string; subject: (n: number | string) => string; prints: string;
}> = {
  TRAVELER: { pick: "Pick an order in Preview first", subject: (n) => `order #${n} and its first load`, prints: "for this order" },
  SHIPPER: { pick: "Pick a single-order shipment in Preview first", subject: (n) => `shipment #${n}'s first ticket`, prints: "for this shipment" },
  MOS_SHIPPER: { pick: "Pick a multi-order shipment in Preview first", subject: (n) => `shipment #${n}'s first ticket`, prints: "for this shipment" },
  BOL: { pick: "Pick a shipment in Preview first", subject: (n) => `shipment #${n}'s bill of lading`, prints: "for this shipment" },
  // A certification's number is its printed label (PreviewPane's `optionsFor`): "92036-3", "92036, load 2".
  CERT: { pick: "Pick a certification in Preview first", subject: (n) => `certification ${n}`, prints: "for this certification" },
  // An invoice's number carries its kind (PreviewPane's `optionsFor`): "invoice 7 - 92026", "credit 512",
  // so the kind reaches `subject` through the number and the subject adds nothing to it.
  INVOICE: { pick: "Pick an invoice or credit in Preview first", subject: (n) => String(n), prints: "for this invoice or credit" },
  // A customer's number is its code (PreviewPane's `optionsFor`), as the statement's Customer line prints it: "ACME".
  STATEMENT: { pick: "Pick a customer in Preview first", subject: (n) => `customer ${n}`, prints: "for this customer" },
  // A quote's number is its list row's `quoteNumber` (PreviewPane's `optionsFor`), as its paper prints it: "1042".
  QUOTE: { pick: "Pick a quote in Preview first", subject: (n) => `quote #${n}`, prints: "for this quote" },
  // A tag's number is its order's (PreviewPane's `optionsFor`, the `tagOrder` kind): "92036".
  CONTAINER_TAG: { pick: "Pick an order in Preview first", subject: (n) => `order #${n}'s first tag`, prints: "for this order" },
};

function recordWords(docType: TemplateDocTypeString) {
  return CANVAS_RECORD_WORDS[docType];
}

/** The items the profile requires, named inside a sentence: "the barcode and the Process steps
 *  table" (a page item by its kind, lower-cased; a table by `titleOf`), or null with none. */
function requiredNames(contract: TemplateContract): { names: string; count: number } | null {
  const required = canvasProfile(contract).required;
  if (required.length === 0) return null;
  const names = required.map((item) => {
    switch (item.kind) {
      case "barcode": return `the ${STATIC_NAMES.barcode.toLowerCase()}`;
      case "table": return `the ${titleOf("table", item.key, contract)}`;
      case "field": return `the ${titleOf("field", item.key, contract)}`;
      default: return assertNever(item);
    }
  });
  return { names: names.join(" and "), count: names.length };
}

/** "Design on a canvas"'s `disabled` and `title`: the editor's edit gate first, then no record
 *  picked in Preview (the document's own pick, `DESIGNER_WORDS.pickRecordFirst`), then its own
 *  request out (a Save in flight carries no title, #487). */
export function designOnCanvasGate(
  state: { blocked: boolean; editTitle: string | undefined; picked: boolean; busy: boolean }, docType: TemplateDocTypeString,
): { disabled: boolean; title: string | undefined } {
  if (state.blocked) return { disabled: true, title: state.editTitle };
  if (!state.picked) return { disabled: true, title: DESIGNER_WORDS.pickRecordFirst(docType) };
  return { disabled: state.busy, title: undefined };
}

/** Every sentence and label the Design tab and its two actions show, including the three
 *  `askConfirm` bodies (the confirm's title and button are the action's label). */
export const DESIGNER_WORDS = {
  designOnCanvas: "Design on a canvas",
  backToSections: "Back to sections",
  clearPage: "Clear the page",
  /** The Preview pick the document's canvas is seeded from ("Pick an order in Preview first"). */
  pickRecordFirst: (docType: TemplateDocTypeString) => recordWords(docType).pick,
  seedUnreadable: "The canvas could not be read from the answer; nothing was changed. Try Design on a canvas again.",
  seedFailed: "The canvas could not be laid out; nothing was changed. Try Design on a canvas again.",
  /** Why a required item stays ("The barcode and the Process steps table are on every traveler; …"),
   *  or null when the profile requires nothing. */
  cannotRemove: (contract: TemplateContract): string | null => {
    const required = requiredNames(contract);
    if (required === null) return null;
    const [verb, pronoun] = required.count === 1 ? ["is", "it"] : ["are", "they"];
    const names = required.names.charAt(0).toUpperCase() + required.names.slice(1);
    return `${names} ${verb} on every ${canvasProfile(contract).paper}; ${pronoun} can be moved, not removed.`;
  },
  notAFigure: "Enter inches as a number, such as 1.25.",
  widthTooSmall: "Width must be at least 0.06 in, one grid step.",
  heightTooSmall: "Height must be at least 0.06 in, one grid step.",
  lineOneAxis: "A line is drawn along one axis, so this side stays at zero.",
  printsOnPage: (n: number, docType: TemplateDocTypeString) => `Prints on page ${n} ${recordWords(docType).prints}`,
  designConfirm: (docType: TemplateDocTypeString, n: number | string) =>
    "The sections layout stops printing for this template. The canvas starts from today's paper for " +
    `${recordWords(docType).subject(n)}; Save keeps it, Discard undoes it.`,
  backToSectionsConfirm:
    "The canvas is set aside and the sections layout prints again for this template; Save keeps it, Discard undoes it.",
  clearPageConfirm: (contract: TemplateContract) => {
    const required = requiredNames(contract);
    return `Every item${required === null ? "" : ` but ${required.names}`} is removed from the canvas; Save keeps it, Discard undoes it.`;
  },
  logoPlaced: "Placed by the Logo item on the Design tab",
  logoPrintsCanvas: "The logo prints only when an image is on file and a Logo item is on the page.",
  stacksWithTables: "Stacks with the tables",
  rowsGrow: "rows grow with the data",
  /** A table the picked record leaves empty (`printsNothing`), on the stage's hover title (#958). */
  printsNothing: "Prints nothing for this record",
  placed: "Placed",
  required: "Required",
  anchorPageTop: "Page top",
  anchorBelow: (title: string) => `Below ${title}`,
  anchorPageBottom: "Page bottom",
  repeat: "Repeat on every page",
  repeatBelowTable: "An item below a table prints after its table; only page-top and page-bottom items repeat.",
  yBelowTable: "Y is measured from the bottom of the table above.",
  // The Design tab's own (Task 4): the stage, the palette and the inspector.
  canvasItems: "Canvas items",
  continued: "(continued)",
  palette: "Palette",
  onPage: "Already on the page",
  selectAnItem: "Select an item on the page to change it.",
  // The Design tab's live page (Task 6): the real PDF beside the stage, re-rendered after each change.
  livePage: "Live page",
  rendering: "Rendering the page…",
  notPoints: "Enter a width in points greater than zero, such as 72, or leave it blank for the default.",
  notASize: "Enter a size from 4 to 72 points.",
  notAWeight: "Enter a weight from 0.25 to 4 points.",
  anchor: "Anchor",
  x: "X (in)",
  y: "Y (in)",
  width: "Width (in)",
  height: "Height (in)",
  label: "Label",
  text: "Text",
  size: "Size (pt)",
  bold: "Bold",
  align: "Align",
  alignLeft: "Left",
  alignCenter: "Center",
  alignRight: "Right",
  weight: "Weight (pt)",
  heading: "Heading",
  columns: "Columns",
  columnShown: (name: string) => `Show ${name}`,
  columnLabel: (name: string) => `Label for ${name}`,
  columnWidth: (name: string) => `Width for ${name} (pt)`,
  remove: "Remove from the page",
} as const;
