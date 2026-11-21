/**
 * The traveler canvas's two invisible flow nodes (design §5.2, `docs/superpowers/specs/2026-11-07-traveler-canvas-designer-design.md`):
 * a mark, which reports where the flow stands, and a spacer, which moves the flow down by a known
 * distance. A leaf with no runtime import, so `traveler-canvas.ts` and `traveler.ts` can both import
 * it without either importing the other (the controller's Ruling 1 for PR B: an import cycle only
 * crashes at module evaluation). The one import is a type, erased at build. It also holds the canvas
 * table id's prefix (`CANVAS_TABLE_ID_PREFIX`), which the sheet and the renderer both read, and the
 * one canvas table BLOCK shape (#969): its builder (`blockAt`, which `canvas-sheet.ts`'s `drawnBlock`
 * calls with the drawn place) and its reader (`canvasBlockOf`, which `render.ts` asks), here so the
 * renderer can read the shape without importing the sheet, which imports it.
 *
 * A block is a wrapper carrying the table's id at margin [0, 0, 0, 0], and inside it ONE zero-gap
 * `columns` node carrying the lateral margin `[left, 0, right, 0]`, its one column holding the
 * document's node (and, for a block that holds its drawn height, a 0-wide spacer column beside it).
 * The margin is on the `columns` node because, when a level-1 column group breaks across a page,
 * pdfmake rebuilds the outermost width on the new page (`DocumentContext.initializePage`) as the
 * page's content width less that group's own margin (`marginXTopParent`, which
 * `LayoutBuilder.processRow` passes only at nesting level 1). A margin on an outer stack is not in
 * that rebuild: the new page's width drops it, and the stack's end adds it back all the same, so
 * every node laid out after the block was handed a width wider by the block's left plus right inset,
 * past the page's right margin (#969). The column's width is a fixed
 * number, never `"*"`: a `"*"` column takes its widest child's minimum width when that minimum reaches
 * the available width, so one child wider than the block would widen every sibling.
 *
 * Both are pdfmake canvas nodes holding one FILLED rectangle of zero width with an explicit `color`
 * and a fill opacity of 0 (`fillOpacity: 0`). pdfmake strokes a vector that names no colour
 * (`fillAndStroke` / `fill` / `stroke`, by which of `color` and `lineColor` it carries), and a
 * stroked zero-width rectangle is a visible vertical rule. A FILLED one covers no area, and Poppler
 * paints it as nothing, but Chrome's PDF viewer (PDFium), where the app shows every print
 * (`src/lib/print-tab.ts`), paints a zero-width fill as a one-device-pixel vertical hairline and a
 * 0 × 0 fill as a dot: the invoice canvas PR 3 whole-branch review found both at the canvas sheet's
 * left margin, in Chrome's PDF viewer (from which an operator prints). pdfmake has no vector it lays out (and so measures and
 * positions) without a paint operator: every `renderVector` ends in `fill`, `fillAndStroke` or
 * `stroke`. So the fill stays, at opacity 0: pdfkit writes `/GsN gs` naming an ExtGState with
 * `/ca 0` before the `f`. Measured on 2026-11-11 (the record in
 * docs/execution/2026-11-11-canvas-marks-ink/), PDFium then paints no hairline or dot, Ghostscript
 * no longer paints the dots it drew for some 0 × 0 marks, and Poppler still paints nothing;
 * tests/canvas-marks-ink.test.ts reads every canvas document's print for the opacity. That state
 * has no `q`/`Q` around it, so it stays in force until the next opacity is set: pdfmake sets one
 * before each text inline, image and filled vector, and the reader refuses anything painted at 0. A
 * text `background` would NOT be reset (pdfmake's `drawBackground` fills before the inline sets its
 * opacity); no builder uses one. pdfmake sizes a canvas node from its vectors (`measureCanvas`), so
 * a spacer of height `h` takes exactly `h` of flow and a mark none: the flow distance is known
 * without a measurement, and the opacity changes neither. A mark's id goes on the canvas node,
 * never on a text node (pdfmake refuses two text nodes sharing an id in one document and turns a
 * text id into a named destination), and pdfmake's types allow `id` on text nodes alone, hence the
 * cast.
 */
import type { Content } from "pdfmake/interfaces";

/** The prefix of every canvas table's id (`canvas-sheet.ts`'s `CANVAS_IDS.table`), held here, in the
 *  import-free leaf, so `render.ts` can recognise a canvas table's block without importing the
 *  sheet, which imports it. A top-level block under an id with this prefix is the one place, beside
 *  the top-level content array, where `render.ts` measures a row (`fitMeasuredRows`): the invoice
 *  canvas prints its order strip inside its block (the invoice canvas design of 2026-11-10, §4.6 and
 *  §5.2). The row stands in the block's document node, a plain `{ stack, margin }`, in the one block
 *  shape (`blockAt`, `canvasBlockOf`). */
export const CANVAS_TABLE_ID_PREFIX = "canvas:table:";

/** Whether `id` is a canvas table block's id: a string under `CANVAS_TABLE_ID_PREFIX`. The column
 *  clamp's canvas scope test (`render.ts`' `installColumnClamp`, #971; with the flow's, `isKeepInBoxRoot`,
 *  #991): a node laid out under such an id, at any depth, has its `"*"` and `auto` columns kept inside
 *  the width it is handed. A string id
 *  survives every JSON copy taken before a layout, which a `Symbol` would not; no flow builder emits
 *  the prefix. */
export function isCanvasBlockId(id: unknown): id is string {
  return typeof id === "string" && id.startsWith(CANVAS_TABLE_ID_PREFIX);
}

/**
 * The flow's half of the column clamp's scope (#991, design
 * `docs/superpowers/specs/2026-11-17-991-flow-tables-in-box-design.md` §4.1). A flow builder marks each top-level
 * node of a section its type's canvas profile names as a section-keyed table block with `FLOW_TABLE_MARK`, a
 * non-enumerable `Symbol.for` property holding the section's key (`markFlowTable`, read through
 * `src/server/pdf/flow-tables.ts`). Non-enumerable and Symbol-keyed, it is invisible to `JSON.stringify`, `toEqual`,
 * an object spread and `structuredClone`, so a builder's JSON (the flow oracles') is what it was, and a canvas,
 * which lays out JSON copies of the flow's nodes, never carries it. `render.ts` turns it, in its own working copy,
 * into the plain key `KEEP_IN_BOX_KEY`, which survives the JSON copies the renderer takes, and the clamp treats a
 * node carrying that key as a scope root (`isKeepInBoxRoot`) as it treats a canvas block's id.
 */
export const FLOW_TABLE_MARK = Symbol.for("heatsynq.render.flowTable");
/** The plain key `render.ts` carries a flow table's mark under in its working copy: the section's key. */
export const KEEP_IN_BOX_KEY = "keepInBox";

/** Marks `node` (an object) as a flow table section's top-level node, by the section's key. */
export function markFlowTable(node: unknown, section: string): void {
  if (node === null || typeof node !== "object") return;
  Object.defineProperty(node, FLOW_TABLE_MARK, { value: section, enumerable: false, configurable: true, writable: true });
}

/** The section key a flow builder marked `node` with, or undefined. */
export function flowTableMarkOf(node: unknown): string | undefined {
  if (node === null || typeof node !== "object") return undefined;
  const value = (node as { [FLOW_TABLE_MARK]?: unknown })[FLOW_TABLE_MARK];
  return typeof value === "string" ? value : undefined;
}

/** Whether a node the renderer lays out is a column-clamp scope root: a canvas table block (its id,
 *  `isCanvasBlockId`) or a flow table section (its `KEEP_IN_BOX_KEY`, a non-empty string). Anything
 *  else is laid out as pdfmake lays it: the test fails closed. */
export function isKeepInBoxRoot(node: { id?: unknown; [KEEP_IN_BOX_KEY]?: unknown }): boolean {
  if (isCanvasBlockId(node.id)) return true;
  const key = node[KEEP_IN_BOX_KEY];
  return typeof key === "string" && key !== "";
}

/** A zero-size rect with an explicit `color`, so pdfmake fills it (`re f`) where a vector with no
 *  `color` is STROKED (`re S`, a stroke op in the content stream, which the canvas test's
 *  `strokedRects` reader sees; `strokedLines` reads `m`/`l` segments only), at fill opacity 0, so
 *  PDFium paints no dot. Pushes one position, consumes no height. */
export function mark(id: string): Content {
  return { id, canvas: [{ type: "rect", x: 0, y: 0, w: 0, h: 0, color: "#000000", fillOpacity: 0 }] } as Content;
}

/** A zero-width rect of height h in the same form, filled at opacity 0 so PDFium paints no
 *  hairline: exactly h of flow. */
export function spacer(h: number): Content {
  return { canvas: [{ type: "rect", x: 0, y: 0, w: 0, h, color: "#000000", fillOpacity: 0 }] };
}

/** A canvas table block read back (`canvasBlockOf`): its id, the lateral margin on its `columns`
 *  node, its column's width, the height its spacer column holds (null for none), the document's node
 *  in its column (`inner`), and that node's stack when the node is a plain `{ stack, margin }` (null
 *  otherwise). */
export type CanvasBlock = {
  id: string; left: number; right: number; width: number; held: number | null; inner: unknown; items: unknown[] | null;
};

/**
 * The one canvas table block (this file's header): `node` in a column `width` wide, the lateral
 * margin `[left, 0, right, 0]` on the zero-gap `columns` node holding that column, and the id on a
 * wrapper at [0, 0, 0, 0]. With `held`, a 0-wide second column holds a spacer of that height, so the
 * block takes at least it (the statement's Bill To, the profile's `holdsHeight`). The caller computes
 * the width (`drawnBlock`, as pdfmake's own subtraction from the content width) and owns `node`,
 * which is placed, not copied.
 */
export function blockAt(id: string, node: Content, left: number, right: number, width: number, held?: number): Content {
  return {
    id,
    margin: [0, 0, 0, 0],
    stack: [{
      columns: [{ width, stack: [node] }, ...(held === undefined ? [] : [{ width: 0, stack: [spacer(held)] }])],
      columnGap: 0,
      margin: [left, 0, right, 0],
    }],
  } as Content;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/** `o`'s own keys are exactly `keys`. */
const keysAre = (o: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(o).length === keys.length && keys.every((key) => Object.hasOwn(o, key));
/** A four-number margin. */
const fourSides = (value: unknown): value is [number, number, number, number] =>
  Array.isArray(value) && value.length === 4 && value.every((m) => typeof m === "number" && Number.isFinite(m));
/** The height of a spacer column (`{ width: 0, stack: [spacer(h)] }`), or null for anything else. */
function spacerColumnHeight(column: unknown): number | null {
  if (!isRecord(column) || !keysAre(column, ["width", "stack"]) || column.width !== 0) return null;
  const { stack } = column;
  if (!Array.isArray(stack) || stack.length !== 1 || !isRecord(stack[0])) return null;
  const canvas = stack[0].canvas;
  const h = Array.isArray(canvas) && canvas.length === 1 && isRecord(canvas[0]) ? canvas[0].h : undefined;
  if (typeof h !== "number" || JSON.stringify(stack[0]) !== JSON.stringify(spacer(h))) return null;
  return h;
}

/**
 * `node` read as the one canvas table block (`blockAt`), or null when it is not exactly that shape:
 * - the wrapper's own keys exactly `id` (a string), `margin` ([0, 0, 0, 0]) and `stack` (one entry);
 * - that entry's exactly `columns`, `columnGap` (0) and `margin` (`[left, 0, right, 0]`);
 * - its first column's exactly `width` (a number) and `stack` (one node, `inner`);
 * - a second column, if any, a 0-wide spacer column, read as `held`; never a third.
 * `items` is `inner`'s stack when `inner`'s own keys are `stack` (an array) and at most `margin`
 * beside it, and null otherwise. It checks no id prefix: `render.ts` does.
 */
export function canvasBlockOf(node: unknown): CanvasBlock | null {
  if (!isRecord(node) || !keysAre(node, ["id", "margin", "stack"])) return null;
  const { id, margin, stack } = node;
  if (typeof id !== "string" || !fourSides(margin) || margin.some((m) => m !== 0)) return null;
  if (!Array.isArray(stack) || stack.length !== 1) return null;
  const group = stack[0];
  if (!isRecord(group) || !keysAre(group, ["columns", "columnGap", "margin"]) || group.columnGap !== 0) return null;
  const sides = group.margin;
  if (!fourSides(sides) || sides[1] !== 0 || sides[3] !== 0) return null;
  const { columns } = group;
  if (!Array.isArray(columns) || columns.length < 1 || columns.length > 2) return null;
  const [column, second] = columns as unknown[];
  if (!isRecord(column) || !keysAre(column, ["width", "stack"]) || typeof column.width !== "number") return null;
  if (!Array.isArray(column.stack) || column.stack.length !== 1) return null;
  const held = second === undefined ? null : spacerColumnHeight(second);
  if (second !== undefined && held === null) return null;
  const inner: unknown = column.stack[0];
  const items = isRecord(inner) && Array.isArray(inner.stack) &&
    Object.keys(inner).every((key) => key === "stack" || key === "margin") ? inner.stack as unknown[] : null;
  return { id, left: sides[0], right: sides[2], width: column.width, held, inner, items };
}
