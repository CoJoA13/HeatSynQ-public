/**
 * The pdfmake + bwip-js plumbing, and the only file in the app that knows either library exists
 * (design spec §10). Everything above it deals in plain JSON document definitions — the
 * template-as-data contract Phase 7's designer will edit — so swapping the renderer never
 * reaches past this module.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  Content, ContentColumns, ContentStack, ContentTable, ContentText, Margins, TableCell, TDocumentDefinitions,
} from "pdfmake/interfaces";
import PdfPrinterModule from "pdfmake/js/Printer.js";
import LayoutBuilderModule from "pdfmake/js/LayoutBuilder.js";
import ColumnCalculatorModule, { type CalculatorColumn } from "pdfmake/js/columnCalculator.js";
import vfs from "pdfmake/build/vfs_fonts.js";
import { toBuffer } from "bwip-js/node";
// pdf-lib is imported ONLY here (plan Global Constraints), for its TWO sanctioned jobs: merging the
// per-sheet-group PDFs renderSheetGroups produces, and post-stamping the Phase 8B practice
// watermark (stampPractice). No other file may reach for it — the same module boundary that
// confines pdfmake and bwip-js to this file.
import { createHash } from "node:crypto";
import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFObject, PDFRawStream, PDFRef, StandardFonts, degrees, rgb,
} from "pdf-lib";
import { practiceMode } from "../practice-mode";
import { TRAVELER_STEP_LAYOUT, TRAVELER_STEP_ROW_CONTENT_MIN } from "../../lib/template-contracts/traveler";
import { equalShareCap } from "./equal-share";
import {
  CANVAS_TABLE_ID_PREFIX, KEEP_IN_BOX_KEY, canvasBlockOf, flowTableMarkOf, isKeepInBoxRoot, type CanvasBlock,
} from "./canvas-nodes";

/**
 * pdfmake 0.3's `js/Printer.js` is a CommonJS module shaped `{ __esModule: true, default: PdfPrinter }`.
 * Loaders that honor `__esModule` (Vite/vitest and SWC/Next's build) hand back the class directly, but
 * Node's own CJS interop — which `tsx` uses when the e2e preflight loads this module transitively —
 * hands back the whole namespace object, so a bare `new PdfPrinterModule()` is `new { default: … }()`
 * ("PdfPrinter is not a constructor"). Unwrap defensively so the constructor is correct under EVERY
 * loader: the default import is the class where `__esModule` is honored (its own `.default` is
 * undefined → fall through) and the namespace object otherwise (`.default` is the class).
 */
const PdfPrinter =
  (PdfPrinterModule as unknown as { default?: typeof PdfPrinterModule }).default ?? PdfPrinterModule;

/** pdfmake's layout engine, unwrapped as `PdfPrinter` is (the same CJS shape, the same three loaders). */
const LayoutBuilder =
  (LayoutBuilderModule as unknown as { default?: typeof LayoutBuilderModule }).default ?? LayoutBuilderModule;

/** pdfmake's column calculator object, unwrapped the same way: the object `LayoutBuilder` and
 *  `TableProcessor` read `buildColumnWidths` off at call time (`_columnCalculator.default`). */
const ColumnCalculator =
  (ColumnCalculatorModule as unknown as { default?: typeof ColumnCalculatorModule }).default ?? ColumnCalculatorModule;

/**
 * The pdfmake release `render.ts`' two hooks on its internals were read at: #978's band frame
 * (`installBandFrame`, `LayoutBuilder.addHeadersAndFooters`) and #971's column clamp
 * (`installColumnClamp`, `LayoutBuilder.processNode` and `columnCalculator.buildColumnWidths`).
 * `package.json` asks for `^0.3.13`, so a patch release installs silently; a test reds on any other
 * installed version (design §8.5 of #971), and `js/columnCalculator.js`, `js/LayoutBuilder.js` and
 * `js/TableProcessor.js` are re-checked before this moves. The install-time asserts are the second line.
 */
export const PDFMAKE_INTERNALS_VERSION = "0.3.13";

/**
 * The page-bottom band's frame (#978). pdfmake lays the footer out in one frame as tall as the page's
 * bottom margin (`LayoutBuilder.addHeadersAndFooters`' footer size function), from the band's top to
 * the paper's edge, and drops the lines that pass that frame: the frame is an unbreakable block whose
 * overflow goes to a second page pdfmake discards. So a band item taller than the band printed down
 * to the paper's edge, over the page line. pdfmake has no setting for the frame's height, so the
 * footer callback `toPdfmakeDefinition` builds for a band carries it, under `BAND_FRAME_HEIGHT`, and
 * the wrapper below lays that callback out in a frame the band tall plus `BAND_CUT_TOLERANCE`:
 * pdfmake's own whole-line drop then falls at the band's bottom edge (owner rulings 2026-11-14:
 * whole lines dropped, the frame ended at the band's edge). The page line, which sat in the same frame under the band, is
 * then a second footer piece (`BAND_PAGE_LINE`) laid out in its own frame from the band's bottom to
 * the paper's edge, so it prints where it always printed. A footer carrying no frame height (every
 * definition without a band) takes pdfmake's own path untouched.
 *
 * The keys are `Symbol.for` keys, never module-local symbols: a second evaluation of this module
 * (vitest per test file, a dev server's reload) shares pdfmake's one `LayoutBuilder.prototype`, so
 * the wrapper the first evaluation installed must read the tags the second one's footers carry, and
 * the second must see the first's install flag and not wrap the wrapper.
 */
const BAND_FRAME_HEIGHT = Symbol.for("heatsynq.render.bandFrameHeight");
const BAND_PAGE_LINE = Symbol.for("heatsynq.render.bandPageLine");
const BAND_FRAME_INSTALLED = Symbol.for("heatsynq.render.bandFrameInstalled");

/**
 * How far past the band's bottom edge a line may end and still print, in points: the band frame is
 * `band.height` plus this. It is the canvas warnings' two-decimal rule (`figure`, Ruling 21): an
 * overflow that rounds to 0.00 is no overflow, since the seeds snap a box to the thousandth of a
 * point while pdfmake lays text out raw, so a seeded strip drawn to end at the edge can end a hair
 * under 0.0005 pt past it. A line ending at or past 0.005 pt beyond the edge is dropped (#978,
 * ruling 2026-11-14). The page line's frame keeps its origin at the band's bottom edge.
 */
const BAND_CUT_TOLERANCE = 0.005;

/** pdfmake's dynamic footer: called per page with the page's number, the page count and its size. */
type FooterGetter = (currentPage: number, totalPages: number, pageSize: { height: number }) => Content | null;
/** The band's footer: its items alone, tagged with the band frame's height and the page line's own
 *  getter (null when the definition prints no page line). */
type BandFooter = FooterGetter & { [BAND_FRAME_HEIGHT]: number; [BAND_PAGE_LINE]: FooterGetter | null };

/**
 * Wraps `LayoutBuilder.prototype.addHeadersAndFooters` once (a `Symbol.for` flag on the prototype).
 * For a footer tagged with a band frame height it lays the header out as pdfmake does, then the band
 * in a frame from the band's top (`pageSize.height − bottom`) the band tall plus
 * `BAND_CUT_TOLERANCE`, then the page line, when there is one, in a frame from the band's bottom to
 * the paper's edge, in pdfmake's own order (header, then footer pieces). Anything else goes to pdfmake's own method unchanged. Run at
 * module load; exported for its test alone.
 */
export function installBandFrame(): void {
  const proto = LayoutBuilder.prototype as typeof LayoutBuilder.prototype & { [BAND_FRAME_INSTALLED]?: true };
  // Asserted before anything else, so a pdfmake reorg (or a loader split that hands this module a
  // different LayoutBuilder than Printer.js uses) fails loudly at module load, never as uncut bands.
  for (const name of ["addHeadersAndFooters", "addDynamicRepeatable"] as const) {
    if (typeof (proto as unknown as Record<string, unknown>)[name] !== "function") {
      throw new Error(
        `render.ts: pdfmake's LayoutBuilder.prototype.${name} is not a function; the band frame (#978) wraps pdfmake's ` +
        "internals (js/LayoutBuilder.js, tied to 0.3.13), so a pdfmake change needs them re-checked.",
      );
    }
  }
  if (proto[BAND_FRAME_INSTALLED]) return;
  const original = proto.addHeadersAndFooters;
  proto.addHeadersAndFooters = function (this: InstanceType<typeof LayoutBuilder>, header: unknown, footer: unknown) {
    const frame = typeof footer === "function" ? (footer as Partial<BandFooter>)[BAND_FRAME_HEIGHT] : undefined;
    if (typeof frame !== "number") return original.call(this, header, footer);
    // `original` with an undefined footer also lays out a page's `customProperties.footer` (`addDynamicRepeatable`'s
    // per-page fallback); no builder emits `section`, so none is reachable, but one would be laid out three times and
    // replace the band's items and the page line on that page.
    original.call(this, header, undefined);
    this.addDynamicRepeatable(footer, (pageSize, margins) => ({
      x: 0, y: pageSize.height - margins.bottom, width: pageSize.width, height: frame + BAND_CUT_TOLERANCE,
    }), "footer");
    const pageLine = (footer as BandFooter)[BAND_PAGE_LINE];
    if (pageLine !== null) {
      this.addDynamicRepeatable(pageLine, (pageSize, margins) => ({
        x: 0, y: pageSize.height - margins.bottom + frame, width: pageSize.width, height: margins.bottom - frame,
      }), "footer");
    }
  };
  proto[BAND_FRAME_INSTALLED] = true;
}
installBandFrame();

/**
 * The column clamp (#971; design `docs/superpowers/specs/2026-11-14-971-keep-in-box-design.md` §5).
 * When a row's columns do not fit the width they are handed, pdfmake's column calculator ("case 1",
 * `columnCalculator.js`) gives every auto column its minimum and every `"*"` column the widest `"*"`
 * column's minimum, and shrinks nothing: the row lays out wider than its box. Inside a scope root and
 * not outside one, the clamp corrects that result so the row is exactly as wide as it was handed
 * (`keepInBox`). A scope root (`isKeepInBoxRoot`) is a canvas table block (its id under
 * `CANVAS_TABLE_ID_PREFIX`) or, since #991, a flow table section (the `KEEP_IN_BOX_KEY` that
 * `withFlowTableKeys` carries from the flow builder's mark, design 2026-11-17 §4.1).
 *
 * Two halves, since `buildColumnWidths` is a plain function with no `this` and no way to ask which
 * document or block it is sizing:
 * - THE SCOPE, on the layout. `LayoutBuilder.prototype.processNode` is wrapped. A node under a
 *   block's id raises a depth count held on the builder instance (`this`) for the length of its
 *   layout, and every node laid out while the count is above 0 (stack items, columns and table
 *   cells all come back through `processNode`, so every depth) has the object `buildColumnWidths`
 *   will be handed marked: a `columns` node's `columns` array, and a table node itself (which
 *   `TableProcessor` hands as `tableNode`). The mark's value is the innermost block node.
 * - THE CLAMP, on the calculator. `buildColumnWidths` is wrapped on the calculator object both
 *   callers read at call time. It runs pdfmake's own first, then corrects only a marked call, and
 *   flags the block node the mark names (`COLUMN_CLAMP_SQUEEZED`) when a width changed;
 *   `laidOutNodes` reports that flag as the block's `squeezed`.
 *
 * Per node and per instance, never module state: pdfmake's prototype and calculator object are
 * shared by every render in the process and two renders may be in flight at once. A mark is set
 * only while a block's id is above the node, so it sits only on nodes inside a block; on the
 * one-pass canvas path those nodes are the definition's own content, which the assembler has
 * already made a JSON copy of for every table block (`canvas-sheet.ts`), so no mark outlives its
 * render or crosses documents. A flow document's table sections are scope roots by their key (#991),
 * marked in `renderPdfCore`'s own copy of its content; everything else of a flow document, and any
 * definition no flow builder marked, is laid out exactly as pdfmake lays it out. (`addBackground` would be in scope for a node under a block's id, but
 * no canvas definition sets a `background`, so it is unreachable today.) The
 * keys are `Symbol.for` keys (JSON copies and `structuredClone` drop them, so no measure memo key
 * sees them) for the reason the band frame's are: a second evaluation of this module must find the
 * first's install flag and read the marks the first's wrapper sets.
 */
const COLUMN_CLAMP_INSTALLED = Symbol.for("heatsynq.render.columnClampInstalled");
const COLUMN_CLAMP_MARK = Symbol.for("heatsynq.render.columnClampMark");
const COLUMN_CLAMP_DEPTH = Symbol.for("heatsynq.render.columnClampDepth");
const COLUMN_CLAMP_BLOCK = Symbol.for("heatsynq.render.columnClampBlock");
const COLUMN_CLAMP_SQUEEZED = Symbol.for("heatsynq.render.columnClampSqueezed");
/** Set on a scope root a row of which lays out wider than it was handed and keeps that width: its
 *  fixed columns and floors pass it (`keepInBox`'s "overran"), so it prints past its width as pdfmake
 *  lays it. `clampedFlowTables` reports it; nothing else reads it. */
const COLUMN_CLAMP_OVERRAN = Symbol.for("heatsynq.render.columnClampOverran");

/**
 * How far past the width it was handed a row may lay out and keep pdfmake's own widths, in points:
 * the canvas warnings' two-decimal rule (`figure`, Ruling 21), as `BAND_CUT_TOLERANCE`. pdfmake enters
 * case 1 at equality too (`minW >= availableWidth`), and the block's own `columns` node is one fixed
 * column exactly its width, so a row that fits by a float hair keeps its widths and re-breaks no
 * word: fitting paper lays out byte-identically. An overflow of this much or more is corrected.
 */
export const KEEP_IN_BOX_TOLERANCE = 0.005;

/** A node `processNode` lays out, read for the clamp's scope: its id, its row of columns, its table. */
type ClampNode = {
  id?: unknown; columns?: unknown; table?: unknown; [COLUMN_CLAMP_SQUEEZED]?: true; [COLUMN_CLAMP_OVERRAN]?: true;
};
/** What the clamp keeps on a builder instance: the depth of block nodes being laid out and the innermost. */
type ClampState = { [COLUMN_CLAMP_DEPTH]?: number; [COLUMN_CLAMP_BLOCK]?: ClampNode };
/** An object the calculator is handed (a `columns` array or a table node) that carries the mark. */
type ClampMarked = { [COLUMN_CLAMP_MARK]?: ClampNode };

/**
 * The least width `node` can be laid out at (#991, design 2026-11-17 §4.3): what nothing in it can
 * give up. A word counts 0, since pdfmake breaks it to a glyph a line; a `noWrap` text counts its
 * whole line; a drawing 0, since pdfmake strokes it past its column's edges. A row of columns counts
 * its fixed columns' widths, its flexible columns' floors and its gaps; a table its fixed columns'
 * widths, each flexible column's widest cell floor and its padding and rules (`_offsets`); a stack its
 * widest item; an image or anything else its own least width as pdfmake measured it (`_minWidth`, its
 * margins in it). Every node counts its own side margins.
 * Read from pdfmake's measure (`_margin`, `_gap`, `_offsets`, `_minWidth`), which has run on every node
 * before any width is built.
 */
type MeasuredNode = {
  _margin?: number[] | null; _minWidth?: number; _gap?: number; _offsets?: { total?: number };
  width?: unknown; noWrap?: boolean; text?: unknown; stack?: unknown[]; columns?: MeasuredNode[];
  table?: { widths?: { width?: unknown }[]; body?: unknown[][] }; ul?: unknown; ol?: unknown; colSpan?: number;
  canvas?: unknown;
};
function floorOf(raw: unknown): number {
  if (raw === null || typeof raw !== "object") return 0;
  const node = raw as MeasuredNode;
  const sides = Array.isArray(node._margin) ? (node._margin[0] ?? 0) + (node._margin[2] ?? 0) : 0;
  if (Array.isArray(node.stack)) return sides + node.stack.reduce<number>((most, item) => Math.max(most, floorOf(item)), 0);
  if (Array.isArray(node.columns)) {
    const gaps = (node._gap ?? 0) * Math.max(0, node.columns.length - 1);
    return sides + gaps + node.columns.reduce<number>((sum, column) =>
      sum + (typeof column?.width === "number" ? column.width : floorOf(column)), 0);
  }
  if (node.table !== undefined && node.table !== null && typeof node.table === "object") {
    return sides + (node._offsets?.total ?? 0) + tableFloors(node.table).reduce((sum, f) => sum + f, 0);
  }
  if (node.text !== undefined && node.noWrap !== true) return sides;
  if (node.text !== undefined) return node._minWidth ?? sides;
  // A list's marker column cannot narrow and its items break as text does: pdfmake's own least width
  // (the widest item's, plus the marker's gap) is the floor, which no in-scope builder reaches today.
  if (node.ul !== undefined || node.ol !== undefined) return node._minWidth ?? sides;
  // A drawing takes no room it cannot give: pdfmake strokes its vectors where they are drawn, past its
  // column's edges (the invoice's price rules run margin to margin from inside a narrower block).
  if (node.canvas !== undefined) return sides;
  return node._minWidth ?? sides;
}
/** Each column's floor in a table: a fixed column its width; another the widest floor of its own cells
 *  (a cell spanning several columns is left out). */
function tableFloors(table: NonNullable<MeasuredNode["table"]>): number[] {
  const widths = table.widths ?? [];
  return widths.map((spec, i) => {
    if (typeof spec?.width === "number") return spec.width;
    let most = 0;
    for (const row of table.body ?? []) {
      const cell = row?.[i] as MeasuredNode | undefined;
      if (cell !== null && typeof cell === "object" && (cell.colSpan ?? 1) > 1) continue;
      most = Math.max(most, floorOf(cell));
    }
    return most;
  });
}

/** `budget` shared among `columns` in proportion to `weights`, each at least its floor: a column whose
 *  share is under its floor takes its floor, and the others share what is left, in the same
 *  proportion. With every floor 0 each column takes `budget * weight / Σ weights`, #971's arithmetic to
 *  the last bit. */
function shareAbove(budget: number, columns: CalculatorColumn[], weights: number[], floors: number[]): void {
  let open = columns.map((_, i) => i);
  let left = budget;
  for (;;) {
    const sum = open.reduce((total, i) => total + weights[i], 0);
    const under = open.filter((i) => (sum > 0 ? left * weights[i] / sum : 0) < floors[i]);
    if (under.length === 0) {
      for (const i of open) columns[i]._calcWidth = sum > 0 ? left * weights[i] / sum : 0;
      return;
    }
    for (const i of under) {
      columns[i]._calcWidth = floors[i];
      left -= floors[i];
    }
    open = open.filter((i) => !under.includes(i));
  }
}

/**
 * Design §5.2's correction of pdfmake's result (#971), with #991's floors (design 2026-11-17 §4.3), in
 * place: `columns` laid out by pdfmake for `available`, `floors` each column's floor (`floorOf`; only
 * the autos' and stars' are read). Only autos and stars change (classified by pdfmake's own tests); a
 * fixed column never does. Nothing changes when the row has no auto or star, or lays out within
 * `available` plus `KEEP_IN_BOX_TOLERANCE`, or when its fixed columns and its flexible columns' floors
 * pass `available`: no width the clamp could give keeps that row inside, so it is laid out as pdfmake
 * lays it (a flow table typed past its width prints as it always did, where clamping it would set its
 * stars to a glyph a line, or print a nested table over the column beside it). Otherwise the fixed
 * columns leave `left`: when the autos' minima and the stars' floors fit in it, each auto keeps its
 * width (case 1's, its minimum) and the stars share the rest equally, each at least its floor; when
 * they do not, the stars take their floors and the autos share the rest in proportion to their
 * minima, each at least its floor. Answers whether any width changed.
 */
function keepInBox(
  columns: CalculatorColumn[], available: number, floorsOf: () => number[],
): "fits" | "moved" | "overran" {
  const isAuto = columns.map((column) => ColumnCalculator.isAutoColumn(column));
  const isStar = columns.map((column, i) => !isAuto[i] && ColumnCalculator.isStarColumn(column));
  const autos = columns.flatMap((_, i) => (isAuto[i] ? [i] : []));
  const stars = columns.flatMap((_, i) => (isStar[i] ? [i] : []));
  const total = columns.reduce((sum, column) => sum + column._calcWidth, 0);
  if (total <= available + KEEP_IN_BOX_TOLERANCE) return "fits";
  // Only now, past the overrun test: a fitting row (every row of fitting paper) walks no content.
  if (autos.length + stars.length === 0) return "overran";
  const floors = floorsOf();
  const fixed = columns.reduce((sum, column, i) => sum + (isAuto[i] || isStar[i] ? 0 : column._calcWidth), 0);
  const flexibleFloors = [...autos, ...stars].reduce((sum, i) => sum + floors[i], 0);
  if (fixed + flexibleFloors > available + KEEP_IN_BOX_TOLERANCE) return "overran";
  const left = available - fixed;
  const autoMin = autos.reduce((sum, i) => sum + columns[i]._minWidth, 0);
  const starFloors = stars.reduce((sum, i) => sum + floors[i], 0);
  const before = columns.map((column) => column._calcWidth);
  const pick = (indices: number[]) => indices.map((i) => columns[i]);
  if (autoMin + starFloors <= left) {
    shareAbove(left - autoMin, pick(stars), stars.map(() => 1), stars.map((i) => floors[i]));
  } else {
    for (const i of stars) columns[i]._calcWidth = floors[i];
    if (autoMin > 0) {
      shareAbove(Math.max(0, left) - starFloors, pick(autos), autos.map((i) => columns[i]._minWidth), autos.map((i) => floors[i]));
    } else {
      for (const i of autos) columns[i]._calcWidth = 0;
    }
  }
  return columns.some((column, i) => column._calcWidth !== before[i]) ? "moved" : "fits";
}

/**
 * Installs the column clamp once (a `Symbol.for` flag on the calculator object): wraps
 * `LayoutBuilder.prototype.processNode` (the scope) and the calculator's `buildColumnWidths` (the
 * clamp), as this section's header describes. Run at module load after `installBandFrame`; exported
 * for its test alone.
 */
export function installColumnClamp(): void {
  const proto = LayoutBuilder.prototype as typeof LayoutBuilder.prototype & Record<string, unknown>;
  const calculator = ColumnCalculator as typeof ColumnCalculator & { [COLUMN_CLAMP_INSTALLED]?: true } & Record<string, unknown>;
  // Asserted before anything else, so a pdfmake reorg (or a loader split that hands this module a
  // different calculator than LayoutBuilder and TableProcessor read) fails loudly at module load,
  // never as canvas blocks printing past their boxes again.
  if (typeof proto.processNode !== "function") {
    throw new Error(
      "render.ts: pdfmake's LayoutBuilder.prototype.processNode is not a function; the column clamp (#971) wraps " +
      "pdfmake's internals (js/LayoutBuilder.js, tied to 0.3.13), so a pdfmake change needs them re-checked.",
    );
  }
  for (const name of ["buildColumnWidths", "isStarColumn", "isAutoColumn"] as const) {
    if (typeof calculator[name] !== "function") {
      throw new Error(
        `render.ts: pdfmake's columnCalculator's ${name} is not a function; the column clamp (#971) wraps pdfmake's ` +
        "internals (js/columnCalculator.js, tied to 0.3.13), so a pdfmake change needs them re-checked.",
      );
    }
  }
  if (calculator[COLUMN_CLAMP_INSTALLED]) return;

  const processNode = LayoutBuilder.prototype.processNode;
  LayoutBuilder.prototype.processNode = function (
    this: InstanceType<typeof LayoutBuilder> & ClampState, node: unknown, isVerticalAlignmentAllowed?: boolean,
  ): void {
    const laid = node !== null && typeof node === "object" ? node as ClampNode : undefined;
    const depth = this[COLUMN_CLAMP_DEPTH] ?? 0;
    const scoped = laid !== undefined && isKeepInBoxRoot(laid);
    if (laid === undefined || (depth === 0 && !scoped)) return processNode.call(this, node, isVerticalAlignmentAllowed);
    // The innermost block: this node when it is one, else the block whose layout this is inside.
    const block = scoped ? laid : this[COLUMN_CLAMP_BLOCK]!;
    if (Array.isArray(laid.columns)) (laid.columns as ClampMarked)[COLUMN_CLAMP_MARK] = block;
    if (laid.table !== undefined) (laid as ClampMarked)[COLUMN_CLAMP_MARK] = block;
    if (!scoped) return processNode.call(this, node, isVerticalAlignmentAllowed);
    const outer = this[COLUMN_CLAMP_BLOCK];
    this[COLUMN_CLAMP_DEPTH] = depth + 1;
    this[COLUMN_CLAMP_BLOCK] = laid;
    try {
      return processNode.call(this, node, isVerticalAlignmentAllowed);
    } finally {
      this[COLUMN_CLAMP_DEPTH] = depth;
      this[COLUMN_CLAMP_BLOCK] = outer;
    }
  };

  const buildColumnWidths = ColumnCalculator.buildColumnWidths;
  ColumnCalculator.buildColumnWidths = function (
    this: unknown, columns: CalculatorColumn[], availableWidth: number, offsetTotal?: number, tableNode?: unknown,
  ): void {
    buildColumnWidths.call(this, columns, availableWidth, offsetTotal, tableNode);
    // A table carries the mark on its node, a row of columns on its columns array.
    const block = (tableNode as ClampMarked | undefined)?.[COLUMN_CLAMP_MARK] ?? (columns as ClampMarked)[COLUMN_CLAMP_MARK];
    if (block === undefined) return;
    // A table's flexible columns hold its cells; a row's columns are themselves the content.
    const table = (tableNode as MeasuredNode | undefined)?.table;
    const outcome = keepInBox(columns, availableWidth, () => (table !== undefined && table !== null && typeof table === "object"
      ? tableFloors(table) : columns.map((column) => floorOf(column))));
    if (outcome === "moved") block[COLUMN_CLAMP_SQUEEZED] = true;
    if (outcome === "overran") block[COLUMN_CLAMP_OVERRAN] = true;
  };
  calculator[COLUMN_CLAMP_INSTALLED] = true;
}
installColumnClamp();

/**
 * The font BYTES for the four contract-enumerated families (Phase 7 spec §6.2, owner ruling 5),
 * keyed by the virtual-filesystem filename each face is registered under. Built once at module
 * load, and the SINGLE SOURCE OF TRUTH for both `fontVfs` (which serves the bytes) and `PDF_FONT_FACES`
 * (whose descriptors name these keys) — so a descriptor can never point at a file the vfs lacks.
 * Two mechanisms feed it:
 *
 * - **Roboto** stays decoded out of pdfmake's own bundled vfs (`build/vfs_fonts.js`, base64) —
 *   the pre-Phase-7 source, so every unconverted builder and the posting register keep rendering
 *   in Roboto through the same font data they always have.
 * - **Liberation Sans / Liberation Serif / Roboto Mono** are `.ttf` assets vendored in `fonts/`
 *   beside this file (provenance + sha256 per file: `fonts/PROVENANCE.md`), read from an
 *   app-root-resolved path. `next.config.ts`'s `outputFileTracingIncludes` carries them into the
 *   standalone output (physically verified, Task 6 report).
 *
 * In every case the bytes are read EAGERLY here, at module load, and held in memory — never handed
 * to pdfkit as a FILE PATH at render time. That is deliberate: a path resolved at print time would
 * have to survive `output: "standalone"`'s file tracing into the Docker image unverified, whereas
 * eager reads fail loudly at boot instead of at the first print.
 *
 * (pdfmake 0.3 note: 0.2 let us hand `PdfPrinter` these Buffers DIRECTLY. 0.3 runs a `resolveUrls`
 * pass over the descriptors first — treating each as a URL/vfs path — which a raw Buffer no longer
 * survives, so the bytes now travel through `fontVfs` and the descriptors are filenames. The design
 * intent above is unchanged; only the plumbing moved.)
 */
const FONT_DIR = path.join(process.cwd(), "src", "server", "pdf", "fonts");
const ttf = (rel: string): Buffer => readFileSync(path.join(FONT_DIR, rel));
const roboto = (name: string): Buffer => Buffer.from(vfs[name], "base64");

const FONT_FILES: Record<string, Buffer> = {
  "Roboto-Regular.ttf": roboto("Roboto-Regular.ttf"),
  "Roboto-Medium.ttf": roboto("Roboto-Medium.ttf"),
  "Roboto-Italic.ttf": roboto("Roboto-Italic.ttf"),
  "Roboto-MediumItalic.ttf": roboto("Roboto-MediumItalic.ttf"),
  "LiberationSans-Regular.ttf": ttf("liberation-sans/LiberationSans-Regular.ttf"),
  "LiberationSans-Bold.ttf": ttf("liberation-sans/LiberationSans-Bold.ttf"),
  "LiberationSans-Italic.ttf": ttf("liberation-sans/LiberationSans-Italic.ttf"),
  "LiberationSans-BoldItalic.ttf": ttf("liberation-sans/LiberationSans-BoldItalic.ttf"),
  "LiberationSerif-Regular.ttf": ttf("liberation-serif/LiberationSerif-Regular.ttf"),
  "LiberationSerif-Bold.ttf": ttf("liberation-serif/LiberationSerif-Bold.ttf"),
  "LiberationSerif-Italic.ttf": ttf("liberation-serif/LiberationSerif-Italic.ttf"),
  "LiberationSerif-BoldItalic.ttf": ttf("liberation-serif/LiberationSerif-BoldItalic.ttf"),
  "RobotoMono-Regular.ttf": ttf("roboto-mono/RobotoMono-Regular.ttf"),
  "RobotoMono-Bold.ttf": ttf("roboto-mono/RobotoMono-Bold.ttf"),
  "RobotoMono-Italic.ttf": ttf("roboto-mono/RobotoMono-Italic.ttf"),
  "RobotoMono-BoldItalic.ttf": ttf("roboto-mono/RobotoMono-BoldItalic.ttf"),
};

/**
 * The bytes of one embedded font file, for the template designer's stage: the browser draws the
 * same faces the PDF embeds. Null for a name `FONT_FILES` does not hold (an own-property check, so
 * `__proto__` and the like answer null).
 */
export function fontBytes(file: string): Buffer | null {
  return Object.hasOwn(FONT_FILES, file) ? FONT_FILES[file] : null;
}

/**
 * pdfmake 0.3's in-process virtual filesystem. `PdfPrinter`'s `PDFDocument.provideFont` resolves a
 * font descriptor (a filename) to its bytes through here — `existsSync` then `readFileSync`. Backed
 * directly by `FONT_FILES`, so the fonts live in memory and no path is read at render time (see the
 * eager-load rationale above). Only the two members the font path calls are provided; the
 * URL-download path that would `writeFileSync` is never taken (see `noopUrlResolver`).
 */
const fontVfs = {
  existsSync: (name: string): boolean => Object.hasOwn(FONT_FILES, name),
  readFileSync: (name: string): Buffer => {
    const buf = FONT_FILES[name];
    if (buf === undefined) {
      throw new Error(`Font file "${name}" is not present in the PDF renderer's virtual filesystem`);
    }
    return buf;
  },
};

/**
 * pdfmake 0.3's `Printer.resolveUrls` calls `resolve()` once per font descriptor and awaits
 * `resolved()` once. Our descriptors are `fontVfs` filenames, never `http(s)` URLs, so there is
 * nothing to fetch and both are no-ops — but 0.3 dereferences the resolver unconditionally, so it
 * must exist. (This is what keeps template PDF rendering fully offline: no font is ever a URL.)
 */
const noopUrlResolver = {
  resolve: (): void => {},
  resolved: (): Promise<void> => Promise.resolve(),
};

/**
 * The four families, each face naming a `FONT_FILES` / `fontVfs` entry. Every descriptor must
 * resolve to bytes the vfs holds — asserted at module load so a typo'd or drifted filename fails at
 * BOOT (matching the eager-load philosophy) rather than at the first print of the family that uses
 * it.
 */
export const PDF_FONT_FACES = {
  Roboto: {
    normal: "Roboto-Regular.ttf",
    bold: "Roboto-Medium.ttf",
    italics: "Roboto-Italic.ttf",
    bolditalics: "Roboto-MediumItalic.ttf",
  },
  "Liberation Sans": {
    normal: "LiberationSans-Regular.ttf",
    bold: "LiberationSans-Bold.ttf",
    italics: "LiberationSans-Italic.ttf",
    bolditalics: "LiberationSans-BoldItalic.ttf",
  },
  "Liberation Serif": {
    normal: "LiberationSerif-Regular.ttf",
    bold: "LiberationSerif-Bold.ttf",
    italics: "LiberationSerif-Italic.ttf",
    bolditalics: "LiberationSerif-BoldItalic.ttf",
  },
  "Roboto Mono": {
    normal: "RobotoMono-Regular.ttf",
    bold: "RobotoMono-Bold.ttf",
    italics: "RobotoMono-Italic.ttf",
    bolditalics: "RobotoMono-BoldItalic.ttf",
  },
};

for (const [family, faces] of Object.entries(PDF_FONT_FACES)) {
  for (const file of Object.values(faces)) {
    if (!Object.hasOwn(FONT_FILES, file)) {
      throw new Error(
        `PDF font family "${family}" names "${file}", which is not in FONT_FILES — ` +
        `the descriptor and the byte map have drifted`);
    }
  }
}

// Built once rather than per render: the printer is stateless across `createPdfKitDocument` calls,
// and a traveler for a 14-load order is one call, not fourteen.
const printer = new PdfPrinter(PDF_FONT_FACES, fontVfs, noopUrlResolver, undefined);

/**
 * Custom table layouts, registered by NAME.
 *
 * This indirection is what keeps a document definition plain JSON. pdfmake also accepts a layout
 * as an inline object of callbacks, and that was the first cut here — until the purity test in
 * tests/traveler.test.ts caught it: a definition carrying functions does not survive
 * `JSON.parse(JSON.stringify(...))`, so it could never be stored, versioned or edited as data,
 * which is exactly what spec §10 promises a template is. Names live in the definition; the
 * drawing code lives here, in the renderer, and is handed to pdfmake per render.
 */
export const LAYOUT = {
  /** Horizontal rules only — the mockup's part-lines and quantity blocks are ruled, not gridded. */
  ruled: "traveler-ruled",
  /** As `ruled`, plus one rule where the step text meets the EQ#/OP/Date boxes, which draw
   *  their own borders. */
  steps: "traveler-steps",
  /** A full grid. */
  boxed: "traveler-boxed",
  /** A full grid with EXPLICIT padding equal to pdfmake's own defaults (4 left/right, 2 top/bottom)
   *  — stating the numbers the traveler's empty sign-off boxes in each step row (`handwritingBox`,
   *  traveler.ts) are built on, rather than leaving them implicit. Behaves identically to `boxed`
   *  today; kept separate so a future change to `boxed`'s defaults (inspections/results boxes) can
   *  never silently resize a sign-off box, and vice versa. */
  signoffBox: "traveler-signoff-box",
  /** The sign-off column's HEADER box, which holds the label: `signoffBox` with no side padding
   *  (#358). */
  signoffLabel: "traveler-signoff-label",
  /** The bill of lading's collect checkbox: a full grid whose side padding fits the box to its
   *  column (#557, `BOL_COLLECT_BOX`). */
  collectBox: "bol-collect-box",
} as const;

/**
 * The bill of lading's collect checkbox, in points (#557). `column` is the column the box sits in,
 * in the sidebar, beside the 148 pt label column; `cell` is the cell's content width, wider than
 * the X it holds; `ruleWidth` is the 0.8 pt rule `boxed` also draws, stated apart from it. The
 * `collectBox` layout derives its side padding from the three, so the box inks the column and no
 * more. Print geometry: no template stores it.
 */
export const BOL_COLLECT_BOX = { column: 14, cell: 10, ruleWidth: 0.8 } as const;

const BLACK = () => "#000000";

/** Whether column `i` of a traveler steps table is an EQ#/OP/Date column. The builder records
 *  the indexes by field key (traveler.ts `handwritingColumns`), because a stored template may
 *  order its step columns differently. */
const handwritingColumn = (node: unknown, i: number): boolean =>
  ((node as { handwritingColumns?: number[] }).handwritingColumns ?? []).includes(i);

/** The traveler steps table: horizontal rules, one vertical rule where the step text meets the
 *  sign-off boxes, and unpadded EQ#/OP/Date columns whose boxes (traveler.ts `handwritingBox`)
 *  sit edge to edge as on the owner's form. Those cells turn every table rule off themselves. */
export const TRAVELER_STEPS_LAYOUT = {
  hLineWidth: () => TRAVELER_STEP_LAYOUT.ruleWidth,
  vLineWidth: (i: number, node: unknown) =>
    handwritingColumn(node, i) !== handwritingColumn(node, i - 1) ? TRAVELER_STEP_LAYOUT.ruleWidth : 0,
  paddingLeft: (i: number, node: unknown) => (handwritingColumn(node, i) ? 0 : TRAVELER_STEP_LAYOUT.padding),
  paddingRight: (i: number, node: unknown) => (handwritingColumn(node, i) ? 0 : TRAVELER_STEP_LAYOUT.padding),
  // Explicit rather than left to pdfmake's own default (also 2): TRAVELER_STEP_ROW_CONTENT_MIN
  // is derived from this padding to hit the printed row height, so the padding is stated here.
  paddingTop: () => TRAVELER_STEP_LAYOUT.cellPaddingY,
  paddingBottom: () => TRAVELER_STEP_LAYOUT.cellPaddingY,
  hLineColor: BLACK, vLineColor: BLACK,
};

// `ruled` and `boxed` state their side padding, 4pt, which is also the default pdfmake packs under
// every named layout: src/lib/template-printed-width.ts restates their padding and rule widths in
// client-safe code, and tests/template-printed-width-render.test.ts holds the two equal.
export const TABLE_LAYOUTS = {
  [LAYOUT.ruled]: {
    hLineWidth: () => 0.8, vLineWidth: () => 0, hLineColor: BLACK,
    paddingLeft: () => 4, paddingRight: () => 4,
  },
  [LAYOUT.steps]: TRAVELER_STEPS_LAYOUT,
  [LAYOUT.boxed]: {
    hLineWidth: () => 0.8, vLineWidth: () => 0.8, hLineColor: BLACK, vLineColor: BLACK,
    paddingLeft: () => 4, paddingRight: () => 4,
  },
  // Same rule width as `boxed`; padding restated explicitly (both equal pdfmake's own defaults —
  // 4 left/right, 2 top/bottom). The empty box of a step row. See the handwritingBox docstring
  // (traveler.ts) for why it additionally pins a content height derived from `boxHeight`.
  [LAYOUT.signoffBox]: {
    hLineWidth: () => TRAVELER_STEP_LAYOUT.ruleWidth, vLineWidth: () => TRAVELER_STEP_LAYOUT.ruleWidth,
    hLineColor: BLACK, vLineColor: BLACK,
    paddingLeft: () => TRAVELER_STEP_LAYOUT.padding, paddingRight: () => TRAVELER_STEP_LAYOUT.padding,
    paddingTop: () => TRAVELER_STEP_LAYOUT.cellPaddingY, paddingBottom: () => TRAVELER_STEP_LAYOUT.cellPaddingY,
  },
  // The header box, which holds the centred label. No side padding (#358): the steps table gives
  // these columns none either, so the padding sat INSIDE the column's configured width, and a
  // column narrower than its label plus 9.6pt printed a header box wider than its column, out of
  // line with the step boxes below it and over the next box. A centred label that fitted with the
  // padding sits where it did. One that only fitted by wrapping (a relabel of two words) now
  // prints on one line where the column has room (owner ruling 2026-10-04).
  [LAYOUT.signoffLabel]: {
    hLineWidth: () => TRAVELER_STEP_LAYOUT.ruleWidth, vLineWidth: () => TRAVELER_STEP_LAYOUT.ruleWidth,
    hLineColor: BLACK, vLineColor: BLACK,
    paddingLeft: () => 0, paddingRight: () => 0,
    paddingTop: () => TRAVELER_STEP_LAYOUT.cellPaddingY, paddingBottom: () => TRAVELER_STEP_LAYOUT.cellPaddingY,
  },
  // The collect checkbox. On `boxed` its 4pt sides laid the box out 19.6pt wide in a 14pt column,
  // so its right rule printed 5.6pt past the right margin (ink 574 to 593.6). These sides split
  // what the column has left after the cell and two rules, 1.2pt each, so the box inks the column,
  // 574 to 588, with the cell in its middle (owner ruling 2026-10-18, #557). Top and bottom state
  // pdfmake's default of 2, which `boxed` leans on, so the box keeps its height.
  [LAYOUT.collectBox]: {
    hLineWidth: () => BOL_COLLECT_BOX.ruleWidth, vLineWidth: () => BOL_COLLECT_BOX.ruleWidth,
    hLineColor: BLACK, vLineColor: BLACK,
    paddingLeft: () => (BOL_COLLECT_BOX.column - BOL_COLLECT_BOX.cell - 2 * BOL_COLLECT_BOX.ruleWidth) / 2,
    paddingRight: () => (BOL_COLLECT_BOX.column - BOL_COLLECT_BOX.cell - 2 * BOL_COLLECT_BOX.ruleWidth) / 2,
    paddingTop: () => 2, paddingBottom: () => 2,
  },
};

// ------------------------------------------------------------------------------------------------
// Declarative page callbacks (Phase 7 spec §6.1) — the named-table-layouts indirection, again
// ------------------------------------------------------------------------------------------------

/** `{ kind: "pageNofM" }` renders `"${label} N of M"` (label defaults to `"Page"`) bottom-right
 *  on every page — the quote's hand-written footer, generalized (label `"Page:"` reproduces it
 *  exactly, Task 14's conversion).
 *
 *  `above` (Task 11): static JSON content stacked OVER the page line, drawn on every page by the
 *  same callback. It exists because the cert (and Task 12's invoice) already print a static
 *  per-page company strip through pdfmake's `footer`, and the both-keys refusal below is
 *  deliberate — a builder whose paper carries such a strip passes it here when the knob turns
 *  on, instead of losing it or competing for the one footer slot. Plain data, like everything
 *  else on these specs; the callback deep-clones it per page (pdfmake decorates laid-out nodes —
 *  the two-pass probe's own lesson). */
export type PageFooterSpec = { kind: "pageNofM"; label?: string; above?: Content };

/** Static JSON content (text/images — never functions) repeated by a renderer-side header
 *  callback on every page AFTER the first of the definition.
 *
 *  `overflowTopMargin` (Task 8, #36's margin story): the header draws in the page's TOP MARGIN,
 *  and pdfmake margins are per-document — a header taller than the definition's own top margin
 *  (the traveler's identity band: text + a 44pt barcode against a 24pt margin) would overlap the
 *  body on pages 2+, while unconditionally widening the margin would move page one of EVERY
 *  print (the golden-compat killer). Setting this asks `renderPdf` for the two-pass render: a
 *  definition that fits one page keeps its original margins untouched (the header never shows on
 *  a one-page document anyway); an overflowing one re-renders with the top margin raised to at
 *  least this reserve, so the header has its room on every continuation page. Absent = the
 *  pre-Task-8 single-pass behavior: the header must fit the definition's own top margin. */
export type ContinuationHeaderSpec = { content: Content; overflowTopMargin?: number };

/** The band's items in PAGE coordinates, each carrying `absolutePosition`; render.ts translates them into the footer frame.
 *
 *  A band of `height` points at the top of the page's bottom margin (the traveler canvas's footer
 *  region, #926): the caller reserves it by making the definition's bottom margin at least the band
 *  plus whatever sits under it, and places every item inside the band. pdfmake lays a footer out in
 *  an unbreakable block of the page's width, committed at `y = pageSize.height − bottomMargin`, the
 *  band's top, and positions an `absolutePosition` node inside it in that
 *  block's own frame, so the renderer subtracts the frame's origin from each item's `y`. The frame
 *  ends `BAND_CUT_TOLERANCE` below the band's bottom edge, not at the paper's (`installBandFrame`,
 *  #978): pdfmake drops whole the lines that pass it (the block keeps its first page only), so an
 *  item that outgrows the band
 *  is cut at the band's bottom edge, never printed under it, and an item that fits prints where it
 *  always printed. The page line has its own frame under the band, from the band's bottom to the
 *  paper's edge. The renderer translates and checks nothing more. Each item repeats on its own
 *  flag, not the band's (design §4.5, Ruling 11): `content` prints on the definition's last page
 *  only, `repeated` on every page. Plain data, like the other specs. */
export type PageBottomBandSpec = { height: number; content: Content[]; repeated: Content[] };

/**
 * A pdfmake document definition plus the declarative keys `renderPdf` understands. The key
 * names are deliberately NOT pdfmake's own (`footer`/`header`) and carry the `Spec` suffix no
 * pdfmake key uses, so they can never collide with a definition key pdfmake consumes itself.
 * All are plain data — the JSON round-trip contract (spec §10) extends to them; the CALLBACKS
 * they describe are constructed below, in the renderer, and exist only in this file.
 */
export type RenderableDefinition = TDocumentDefinitions & {
  pageFooterSpec?: PageFooterSpec;
  continuationHeaderSpec?: ContinuationHeaderSpec;
  pageBottomBandSpec?: PageBottomBandSpec;
};

/**
 * Strips the declarative keys off the definition and hands pdfmake the callbacks they describe.
 * A definition carrying BOTH a spec key and the pdfmake key it drives is refused loudly — two
 * competing footers is a builder bug, and pdfmake would silently honor whichever this function
 * happened to assign last. An unknown footer kind is refused the same way (a typo'd kind must
 * never render as "no footer").
 *
 * `pageFooterSpec` and `pageBottomBandSpec` both drive pdfmake's one `footer`, so they share ONE
 * callback, and both refusals of a raw `footer` are asked before it is built (`out` is `rest`, so a
 * check asked after the assignment would see the callback itself). Without a band the callback is
 * exactly the page-line footer it always was, laid out by pdfmake's own path. With one, it answers
 * the band's `repeated` items on every page and its `content` items on the last page only, each
 * translated into the footer frame (`PageBottomBandSpec`), and carries the band's height and the
 * page line as tags `installBandFrame`'s wrapper reads: the items are laid out in a frame the band
 * tall plus `BAND_CUT_TOLERANCE`, and the page line, when there is one, in its own frame from the band's bottom to the
 * paper's edge, at top margin 8, where it printed under the band before (#978). A
 * `pageFooterSpec.above` beside a band goes under the band too: it is stacked over the page line in
 * that frame, the page line keeping its own 8.
 */
function toPdfmakeDefinition(def: RenderableDefinition): TDocumentDefinitions {
  const { pageFooterSpec, continuationHeaderSpec, pageBottomBandSpec, ...rest } = def;
  const out: TDocumentDefinitions = rest;
  if (pageFooterSpec !== undefined && rest.footer !== undefined) {
    throw new Error(
      "Definition carries both a pdfmake `footer` and a `pageFooterSpec` — use one or the other");
  }
  if (pageBottomBandSpec !== undefined && rest.footer !== undefined) {
    throw new Error(
      "Definition carries both a pdfmake `footer` and a `pageBottomBandSpec` — use one or the other");
  }
  if (pageFooterSpec !== undefined && pageFooterSpec.kind !== "pageNofM") {
    throw new Error(
      `Unknown pageFooterSpec kind "${String(pageFooterSpec.kind)}" — the renderer knows: pageNofM`);
  }
  if (pageFooterSpec !== undefined || pageBottomBandSpec !== undefined) {
    const label = pageFooterSpec?.label ?? "Page";
    const above = pageFooterSpec?.above;
    const band = pageBottomBandSpec;
    // The bottom margin is the definition's own: a two-pass render's second pass moves the top alone.
    const bottom = normalizeMargins(def.pageMargins)[3];
    // The quote's exact footer styling (pdf/quote.ts) — its Task 14 conversion must be invisible.
    const pageLineOf = (currentPage: number, totalPages: number, top: number): Content => ({
      text: `${label} ${currentPage} of ${totalPages}`,
      bold: true, fontSize: 8.5, alignment: "right", margin: [24, top, 24, 0],
    });
    // The page line, `above` stacked over it: the whole footer without a band, and the band's own
    // second footer piece with one.
    const pageLine = (currentPage: number, totalPages: number): Content => {
      const line = pageLineOf(currentPage, totalPages, 8);
      if (above === undefined) return line;
      // Pristine nodes per page — see the spec's doc comment (lossless: `above` is plain JSON).
      return { stack: [JSON.parse(JSON.stringify(above)) as Content, line] };
    };
    if (band === undefined) {
      out.footer = pageLine;
    } else {
      // The band's items alone, laid out in a frame the band tall plus `BAND_CUT_TOLERANCE`
      // (`installBandFrame`), so a line that passes the band's bottom edge is dropped whole (#978).
      const bandItems: FooterGetter = (currentPage, totalPages, pageSize) => {
        const origin = pageSize.height - bottom;
        const items = [
          ...bandItemsInFooterFrame(band.repeated, origin),
          ...(currentPage === totalPages ? bandItemsInFooterFrame(band.content, origin) : []),
        ];
        return items.length ? { stack: items } : null;
      };
      out.footer = Object.assign(bandItems, {
        [BAND_FRAME_HEIGHT]: band.height,
        [BAND_PAGE_LINE]: pageFooterSpec === undefined ? null : pageLine,
      }) satisfies BandFooter;
    }
  }
  if (continuationHeaderSpec !== undefined) {
    if (rest.header !== undefined) {
      throw new Error(
        "Definition carries both a pdfmake `header` and a `continuationHeaderSpec` — use one or the other");
    }
    out.header = (currentPage: number): Content | null =>
      currentPage > 1 ? continuationHeaderSpec.content : null;
  }
  return out;
}

/** A fresh JSON clone of the band's items (pdfmake decorates the nodes it lays out, and one spec
 *  serves every page and both passes), with every `absolutePosition.y` in it moved from page
 *  coordinates into the footer frame whose top is at page y `origin`. The spec's own nodes are
 *  never touched, so the translation cannot compound across pages or renders. */
function bandItemsInFooterFrame(nodes: Content[], origin: number): Content[] {
  const items = JSON.parse(JSON.stringify(nodes)) as Content[];
  const translate = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) translate(item);
      return;
    }
    const position = (node as { absolutePosition?: { y?: number } }).absolutePosition;
    if (position && typeof position.y === "number") position.y -= origin;
    for (const [key, value] of Object.entries(node)) {
      if (key !== "absolutePosition") translate(value);
    }
  };
  translate(items);
  return items;
}

/**
 * The render-side font belt (spec §6.2): the contracts already refuse unknown families at
 * config-validation time, but a definition reaching the renderer with an unregistered family —
 * a hand-built fixture, a future builder bug — must fail NAMING the family, never fall back
 * silently. pdfmake does throw its own error today; this belt makes the guarantee ours, with the
 * registered set in the message, independent of pdfmake's internals. The walk skips functions
 * (a definition's own callbacks are not JSON) and only ever inspects `font` string values —
 * pdfmake's one meaning for that key.
 */
function assertFontsRegistered(def: RenderableDefinition): void {
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "font" && typeof value === "string" && !Object.hasOwn(PDF_FONT_FACES, value)) {
        throw new Error(
          `Font family "${value}" is not registered with the PDF renderer — ` +
          `registered families: ${Object.keys(PDF_FONT_FACES).join(", ")}`);
      }
      if (typeof value === "object") walk(value);
    }
  };
  walk(def);
}

/** The single-pass pdfmake render — bytes out of a definition that is already pdfmake-shaped.
 *  `createPdfKitDocument` is async as of pdfmake 0.3 (it resolves font URLs before laying out),
 *  so it is awaited before the pdfkit stream is drained. */
async function renderBytes(def: TDocumentDefinitions): Promise<Buffer> {
  const doc = await printer.createPdfKitDocument(def, { tableLayouts: TABLE_LAYOUTS });
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    // pdfkit reports a bad definition (an unresolvable image, a missing font) by emitting on the
    // stream, long after createPdfKitDocument has already returned. Without this the promise
    // would simply never settle and the request would hang instead of failing.
    doc.on("error", reject);
    doc.end();
  });
}

/** pdfmake margins, normalized to `[left, top, right, bottom]` (40pt is pdfmake's own default). */
function normalizeMargins(
  margins: TDocumentDefinitions["pageMargins"],
): [number, number, number, number] {
  if (margins === undefined) return [40, 40, 40, 40];
  if (typeof margins === "number") return [margins, margins, margins, margins];
  if (margins.length === 2) return [margins[0], margins[1], margins[0], margins[1]];
  return [margins[0], margins[1], margins[2], margins[3]];
}

/**
 * A node's own margin with its top and bottom set to 0, in pdfmake's `[left, top, right, bottom]`
 * form: a number m is `[m, 0, m, 0]`, `[h, v]` is `[h, 0, h, 0]`, and undefined stays undefined.
 * The side margins are kept: they set the width the node's text wraps at. A node's
 * `marginTop`/`marginBottom` keys and a margin that comes from a style are not read; neither of a
 * shipping ticket's kept-together blocks uses them.
 */
function verticalMarginsZeroed(margin: Margins | undefined): Margins | undefined {
  if (margin === undefined) return undefined;
  if (typeof margin === "number") return [margin, 0, margin, 0];
  if (margin.length === 2) return [margin[0], 0, margin[0], 0];
  return [margin[0], 0, margin[2], 0];
}

/** The ids of a shipping ticket's unbreakable blocks, each with the name its measurement's error
 *  gives it. */
const KEPT_TOGETHER: Record<string, string> = {
  "ticket-totals": "Ticket totals",
  "ticket-tear-off": "Ticket tear-off strip",
};

/** The ids of the rows the renderer fits to one line (`fitMeasuredRows`), or stacks where its line is
 *  too narrow to share, each with the name its refusals give it. */
const MEASURED_ROWS: Record<string, string> = {
  "invoice-order-strip": "Invoice order strip",
};

/** The narrowest share, in points, a measured row's field is held to on one line (the owner's
 *  amendment of 2026-10-21 on #590: "about 60 pt"). Where the equal share (`equalShareCap`) is under
 *  it, the row prints as a stack, one field to a line (`fitMeasuredRows`); a share of exactly 60 keeps
 *  the line. Narrower shares printed a field one or two letters to a line, and a 200-character PO ran
 *  to four pages. */
export const MEASURED_ROW_FLOOR = 60;

/** The width, in points, of the page a measured row's columns are measured on: 200 inches, far wider
 *  than any field the invoice's strip prints in practice (a 200-character PO at 9 points is about
 *  1,000; a Process of comma-joined operations has no length limit), so pdfmake gives each column
 *  its whole text on one line. A column wider still is measured whole all the same, by the `noWrap`
 *  it is measured under. */
const MEASURING_PAGE_WIDTH = 14_400;

/**
 * pdfmake cannot place an indivisible row taller than a page. Measure traveler rows with the
 * SAME layout engine, fonts and widths on an auto-height page before choosing row policy.
 * Normal rows stay together. An oversized row uses native table pagination with no numeric
 * minimum height (pdfmake's minimum-height bookkeeping is unsafe across page breaks).
 * No text is segmented, shortened or resized; intentional blank lines remain native text.
 *
 * A shipping ticket's totals block arrives `unbreakable` under the id `ticket-totals`
 * (pdf/shipping-ticket.ts `totalsBlock`) where the template holds a typed label for one of its
 * fields (#673, owner ruling R16), and its tear-off strip under the id `ticket-tear-off`
 * (`tearOff`) where the template holds a typed label for one of the strip's fields, the Sold To name
 * holds a line-break character, or the template's base font size is above its type's Standard's. A
 * block or strip without the id keeps its mark and is not measured.
 * pdfmake draws an unbreakable block whole on one page or leaves it out. Each block under one of
 * those ids is measured as the results block is, but without its own top and bottom margins, and
 * held to the same usable height. That height takes the larger of the definition's top margin and
 * its `overflowTopMargin`: a two-pass render's second pass prints on the shorter page, and the
 * block must fit that one. A block that fits is left as it is. A taller one loses the mark, in the
 * copy, and flows over the pages.
 *
 * The margins are left out because pdfmake applies a node's margins outside its unbreakable block,
 * and does not apply the top margin again on the page the block moves to, so its fit test compares
 * the block's content alone with the page (`verticalMarginsZeroed`). render-primitives' 52- and
 * 53-line rows with a 16-point top margin hold this: with no id they are pdfmake's own fit test,
 * and under `ticket-tear-off` the renderer's.
 *
 * Nothing is measured for a definition with no steps table, no results block and no such block,
 * and the caller's own definition is handed back. It is handed back too when the only finds are
 * such blocks that each fit a page, since nothing was changed.
 *
 * `memo` keeps each measurement's answer for the rest of one `renderSheetGroups` call (#611): every
 * load of one traveler print carries the same steps table and results block, and each was measured
 * again, two complete pdfmake renders a load (about half of a 100-load print, 2026-11-06). The key is
 * the measured node's whole JSON, taken before anything changes it, with everything else the
 * measurement reads: the page width, the side margins, the default style, the styles and, for the
 * steps table, the usable height. The value is numbers only (a block's height, a table's
 * oversized-row verdicts), and each definition applies it to its own JSON copy. The map lives for
 * one call and is never module state; `renderPdf` passes none.
 */
type MeasureMemo = Map<string, number | boolean[]>;
async function prepareTravelerLayout(def: RenderableDefinition, memo?: MeasureMemo): Promise<RenderableDefinition> {
  const copy = { ...def, content: JSON.parse(JSON.stringify(def.content)) } as RenderableDefinition;
  const tables: ContentTable[] = [];
  const results: (ContentColumns & { id: string; unbreakable?: boolean })[] = [];
  const kept: (ContentStack & { id: string; unbreakable?: boolean })[] = [];
  // The flow table section each found node lies in (#991): its measure is laid out in the clamp's
  // scope, as it prints (design 2026-11-17 §4.4). A canvas steps table's scope is its drawn width's.
  const roots = new Map<object, string>();
  const collect = (node: unknown, root: string | undefined): void => {
    if (!node || typeof node !== "object") return;
    const own = (node as Record<string, unknown>)[KEEP_IN_BOX_KEY];
    const inside = typeof own === "string" && own !== "" ? own : root;
    if ("id" in node && node.id === "traveler-results" && "columns" in node) {
      results.push(node as ContentColumns & { id: string; unbreakable?: boolean });
      if (inside !== undefined) roots.set(node, inside);
      return;
    }
    if ("id" in node && typeof node.id === "string" && Object.hasOwn(KEPT_TOGETHER, node.id)
      && "unbreakable" in node && node.unbreakable === true) {
      kept.push(node as ContentStack & { id: string; unbreakable?: boolean });
      if (inside !== undefined) roots.set(node, inside);
      return;
    }
    if ("layout" in node && node.layout === LAYOUT.steps && "table" in node) {
      tables.push(node as ContentTable);
      if (inside !== undefined) roots.set(node, inside);
      return;
    }
    for (const value of Object.values(node)) collect(value, inside);
  };
  collect(copy.content, undefined);
  /** `node` laid out inside a stack carrying its flow table section's key, when it lies in one. */
  const inScope = (node: Content, root: string | undefined): Content =>
    root === undefined ? node : { [KEEP_IN_BOX_KEY]: root, stack: [node] } as Content;
  if (!tables.length && !results.length && !kept.length) return def;
  // The traveler's and the shipping ticket's builders use portrait LETTER. Preserve support for
  // explicit equivalent dimensions.
  const size = typeof def.pageSize === "object" ? def.pageSize : { width: 612, height: 792 };
  const [left, top, right, bottom] = normalizeMargins(def.pageMargins);
  const usableHeight = Number(size.height) - Math.max(top,
    def.continuationHeaderSpec?.overflowTopMargin ?? top) - bottom;
  /** What a measurement reads besides its node: one string, part of every `memo` key. */
  const layoutKey = memo ? JSON.stringify([size.width, left, right, def.defaultStyle ?? null, def.styles ?? null]) : "";
  /** How tall a block is at the body's width: where a sentinel after it starts on an auto-height
   *  page with the definition's side margins, default style and styles. */
  const blockHeight = async (node: Content, what: string, root?: string): Promise<number> => {
    const key = memo ? `block|${layoutKey}|${root ?? ""}|${JSON.stringify(node)}` : "";
    const known = memo?.get(key);
    if (typeof known === "number") return known;
    const sentinel = { text: "measure" } as ContentText & { positions?: { top: number }[] };
    await renderBytes({
      pageSize: { width: size.width, height: "auto" },
      pageMargins: [left, 0, right, 0],
      defaultStyle: def.defaultStyle,
      styles: def.styles,
      content: [inScope(structuredClone(node), root), sentinel],
    });
    const height = sentinel.positions?.[0]?.top;
    if (height === undefined || !Number.isFinite(height)) {
      throw new Error(`${what} measurement has no laid-out position`);
    }
    memo?.set(key, height);
    return height;
  };
  /** Which of a steps table's rows, header aside, are taller than a page with the header above.
   *  The table is laid out at the width it prints at: the body's, or, for a canvas steps table, its
   *  drawn width (`canvasWidth`, traveler-canvas.ts `tableBlock`), the right margin taking the rest
   *  of the page. A narrower table wraps more, so a row the body-width measure calls fine can be
   *  taller than a page at the drawn width, and pdfmake prints a row kept whole under
   *  `dontBreakRows` that is taller than a page on no page at all. The memo key needs no new part:
   *  it holds the node's whole JSON, `canvasWidth` included. */
  const oversizedRows = async (node: ContentTable, root?: string): Promise<boolean[]> => {
    const key = memo ? `steps|${layoutKey}|${usableHeight}|${root ?? ""}|${JSON.stringify(node)}` : "";
    const { canvasWidth } = node as ContentTable & { canvasWidth?: number };
    const measureRight = typeof canvasWidth === "number" ? Number(size.width) - left - canvasWidth : right;
    const known = memo?.get(key);
    if (Array.isArray(known)) return known;
    const measured = JSON.parse(JSON.stringify(node)) as ContentTable;
    measured.margin = 0;
    measured.table.dontBreakRows = false;
    // A final sentinel gives the last real row the same adjacent-start measurement as all others.
    // Its cells are empty texts, which enter no column's minimum or maximum, so the copy's columns
    // are the printed table's and the sentinel only marks where the last row ends. A word there
    // entered every column's minimum ("measure" did, at 31.027 pt), and an instruction whose share
    // was under it was measured wider than it printed: a row taller than a page only at the printed
    // width was called fine and printed on no page (#992, owner ruling 2026-11-15).
    measured.table.body.push(node.table.body[0].map(() => ({ text: "" })));
    await renderBytes({
      pageSize: { width: size.width, height: "auto" },
      pageMargins: [left, 0, measureRight, 0],
      defaultStyle: def.defaultStyle,
      styles: def.styles,
      // A canvas steps table prints inside its block, where the column clamp keeps its columns in the
      // drawn width; the measure takes the same scope (a stack under a block id, the one scope test,
      // spelled from the prefix), so the measured and printed instruction columns are the same width
      // at every drawn width. Unscoped, pdfmake's case 1 would lay the instruction out at its widest
      // glyph where the clamp prints it narrower, and a row taller than a page only at the printed
      // width would be called fine and print on no page (#971, design §5.5). A flow steps table is
      // laid out in its flow table section's scope, as it prints (#991, design 2026-11-17 §4.4).
      content: [typeof canvasWidth === "number"
        ? { id: `${CANVAS_TABLE_ID_PREFIX}steps`, stack: [measured] } as Content
        : inScope(measured, root)],
    });
    type PositionedCell = { positions?: { top: number }[]; stack?: PositionedCell[] };
    const start = (row: TableCell[]): number => {
      const positions: number[] = [];
      const visit = (cell: PositionedCell): void => {
        for (const position of cell.positions ?? []) positions.push(position.top);
        for (const child of cell.stack ?? []) visit(child);
      };
      for (const cell of row) visit(cell as PositionedCell);
      const first = Math.min(...positions);
      if (!Number.isFinite(first)) throw new Error("Traveler row measurement has no laid-out position");
      return first;
    };
    const starts = measured.table.body.map(start);
    const headerHeight = starts[1] - starts[0];
    const verdicts = node.table.body.slice(1).map((_, i) =>
      starts[i + 2] - starts[i + 1] + headerHeight + TRAVELER_STEP_LAYOUT.ruleWidth > usableHeight);
    memo?.set(key, verdicts);
    return verdicts;
  };
  for (const node of tables) {
    const oversized = await oversizedRows(node, roots.get(node));
    if (!oversized.some(Boolean)) continue;
    // The groups copy the table but for its id and drawn width: the id goes on the stack that
    // replaces the table (below), so a reader of laid-out positions (`renderSheetGroupsWithPositions`)
    // finds the table once, at its start, and the width was the measure's alone. A canvas steps
    // table carries no id (its block's wrapper does, `drawnBlock`) and margin [0, 0, 0, 0], so the
    // stack moves neither: the block's columns node holds the lateral margin (#969).
    const table = { ...node } as ContentTable & { id?: string; canvasWidth?: number };
    const id = table.id;
    delete table.id;
    delete table.canvasWidth;
    const groups: ContentTable[] = [];
    let ordinary: TableCell[][] = [];
    const group = (rows: TableCell[][], breakable: boolean): void => {
      const header = structuredClone(node.table.body[0]);
      if (breakable) {
        // Repeat the standard name and step number alongside the column headers on every fragment.
        const identity = rows[0].flatMap((cell) => typeof cell === "object" && "text" in cell &&
          typeof cell.text === "string" && cell.text !== "" ? [cell.text] : []).join(" — ");
        const title = header.find((cell) => typeof cell === "object" && "colSpan" in cell);
        if (title && typeof title === "object" && "text" in title) {
          title.text = `${title.text}  ${identity}`;
        }
      }
      groups.push({
        ...table,
        margin: 0,
        table: {
          ...node.table,
          body: [header, ...rows],
          heights: breakable ? undefined : ["auto", ...rows.map(() => TRAVELER_STEP_ROW_CONTENT_MIN)],
          dontBreakRows: !breakable,
        },
      });
    };
    node.table.body.slice(1).forEach((row, i) => {
      if (!oversized[i]) { ordinary.push(row); return; }
      if (ordinary.length) { group(ordinary, false); ordinary = []; }
      group([row], true);
    });
    if (ordinary.length) group(ordinary, false);
    const margin = node.margin;
    // A flow steps table that is its section's node keeps the section's scope on the stack that
    // replaces it (#991): the groups print under the column clamp, as they were measured.
    const scope = (node as unknown as Record<string, unknown>)[KEEP_IN_BOX_KEY];
    // Replace in place: the parent may be a nested stack; its ordering and margins stay intact.
    for (const key of Object.keys(node)) delete (node as unknown as Record<string, unknown>)[key];
    Object.assign(node, {
      stack: groups, margin, ...(id === undefined ? {} : { id }), ...(scope === undefined ? {} : { [KEEP_IN_BOX_KEY]: scope }),
    });
  }
  for (const node of results) {
    const height = await blockHeight(node, "Traveler results", roots.get(node));
    if (height <= usableHeight) {
      node.unbreakable = true;
    } else {
      // Custom labels can make this block taller than a page. Let text paginate naturally;
      // numeric minimum row heights cannot safely span pages in the installed pdfmake version.
      const removeMinimums = (child: unknown): void => {
        if (!child || typeof child !== "object") return;
        if ("table" in child && child.table && typeof child.table === "object") {
          delete (child.table as { heights?: unknown }).heights;
        }
        for (const value of Object.values(child)) removeMinimums(value);
      };
      removeMinimums(node);
    }
  }
  let flowing = false;
  for (const node of kept) {
    const measured = { ...node, margin: verticalMarginsZeroed(node.margin) };
    if (await blockHeight(measured, KEPT_TOGETHER[node.id], roots.get(node)) <= usableHeight) continue;
    delete node.unbreakable;
    flowing = true;
  }
  return tables.length || results.length || flowing ? copy : def;
}

/**
 * A row of columns that prints on one line, its fields sized by the owner's equal share (#590). The
 * invoice's order strip arrives under the id `invoice-order-strip` (pdf/invoice.ts `orderStrip`),
 * each field an `auto` column. A builder may name one `*` column, which takes what is left; the
 * invoice names none. pdfmake cannot keep the short fields at their own widths by itself: its column
 * sizing (`buildColumnWidths`, `js/columnCalculator.js`) counts a long field's whole text in the
 * row's widest, its column `auto` or `*`, so when the fields do not fit one line every `auto` column
 * gives up width in proportion to how far it can shrink, its whole text on one line less its widest
 * word (`_maxWidth − _minWidth`), and "Our Order #:" prints above "1031".
 * So each column is measured here, with the SAME layout engine, fonts, default style and styles, and
 * the row is fitted in a copy. A column whose text fits its equal share (`equalShareCap`,
 * pdf/equal-share.ts) stays `auto` and gains `noWrap`, under which pdfmake gives it exactly its
 * width however the row is squeezed. A column wider than the share takes the share less 0.01 points
 * and wraps inside it, a word wider than that breaking at its edge. A `*` column stays `*` and
 * takes what is left. The shave keeps a `*` column whose share is its exact width from losing its
 * last word to a rounding; it is a belt, as the `noWrap` a column is measured under is, and no test
 * sees either removed. A row too narrow to share prints as a stack instead (below).
 *
 * A column's width is where a sentinel after it starts. One render of an auto-height page
 * `MEASURING_PAGE_WIDTH` wide with no margins holds, for each column, a copy of its row whose columns
 * are that column alone, `auto` and `noWrap`, then the sentinel, with no gap, no margins and no id.
 * The line is the page's width less the page's side margins and the row's own (each through
 * `normalizeMargins`, so every form of margin is read, a row with no margin read as none:
 * `normalizeMargins` reads an undefined margin as pdfmake's 40-point PAGE default), the block's when
 * the row is in one (below: its `columns` node's four-number margin as `canvasBlockOf` reads it,
 * never through `normalizeMargins`, any other form of margin there being no block) and the gaps
 * between its columns. The gap is the row's own `columnGap`, else the definition's default style's,
 * else pdfmake's 0. A gap or margin that a named style gives the row, and its
 * `marginLeft`/`marginRight` keys, are not read; the invoice's row uses none of them.
 *
 * The row must be an item of the definition's top-level `content` array, or an item of a canvas
 * table block's inner stack: a top-level node whose `id` starts with `CANVAS_TABLE_ID_PREFIX`
 * (`canvas-nodes.ts`) in the one canvas block shape (`canvasBlockOf`, `canvas-nodes.ts`, #969; the
 * invoice canvas prints its strip inside its block, by the invoice canvas design of 2026-11-10, §4.6
 * and §5.2; the invoice's flow keeps it top-level): a wrapper at [0, 0, 0, 0] holding ONE zero-gap
 * `columns` node that carries the lateral margin, its column holding the document's node, each
 * level carrying exactly its own keys. The row is an item of that node's `stack`, the node a plain
 * stack whose keys are `stack` and `margin` only. The block's sides are the `columns` node's margin;
 * the node's own margin is not read (`drawnBlock` sets it to [0, 0, 0, 0]). The old margined wrapper
 * (the id and the lateral margin on one plain stack), which #969 retired, is not that shape, and a
 * row in one is refused like a row anywhere else.
 * Two reasons: the row's own side margins, and the block's, are then the only ones between it and
 * the page's, and nothing above it on pdfmake's style stack changes its font. Its gap is another
 * matter: the block's `columns` node puts `columnGap: 0` on that stack, which a measured row's own
 * `columnGap` overrides (the invoice's strip carries `W.stripGap`) and which equals the default
 * style's gap, which the measure reads for a row with none (above), only because the canvas
 * `defaultStyle` sets no `columnGap`. Found anywhere else in the definition the row is refused by name, as a builder bug: a
 * level deeper in a block, in a block whose document node is not such a plain stack, in the old
 * margined wrapper, in an `unbreakable` region, in a header, footer, continuation or band spec, in a stack under any other
 * id, or in a block carrying any other key at any level (a `columnGap` other than 0 on its `columns`
 * node included). A `content` that is not an array has no items, so a row in it is refused too. So is a
 * node under the id that is not a row of columns, a column whose width is not "auto" or
 * "*", a row with two "*" columns, a page size that is neither "LETTER" nor an object of numeric
 * width (no page size at all included: pdfmake's own is A4), a landscape page, and a page size wider
 * than tall under an explicit portrait orientation: pdfmake swaps its width and height, and the
 * width read here is the page size's own.
 *
 * A row too narrow to share prints as a stack (the owner's amendment of 2026-10-21): where the
 * equal share is under `MEASURED_ROW_FLOOR`, or the gaps between its columns leave them no width at
 * all, the row becomes, in the copy, a stack of its fields, one to a line in their order, under the
 * row's own margin, each without its column width or `noWrap`: each wraps by word across the row's
 * whole width, as a line of text does. Held to a share that narrow, a field printed a letter or two
 * to a line. A row whose gaps leave it no width is stacked without being measured. A row with no
 * width left even for a stack, its side margins reaching past the page's, is handed back as the
 * builder wrote it, and nothing is measured for it. A config the template validator accepts
 * (`col_qty` up to 564 with the weight columns hidden) indents the invoice's strip into each case,
 * and that template must print, never refuse.
 *
 * pdfmake rewrites a text node's inline array in place as it lays the node out, so the measuring
 * render lays out JSON copies of the columns, and the row is fitted (or stacked) where it stands, at
 * the top level or in its block, read by the same path, in a separate JSON copy of the content,
 * taken before anything was measured, that no layout has touched. The caller's own
 * definition is never changed. A definition holding no such row, or only rows with no width left
 * even for a stack, is handed back as it came: canvas blocks holding none are no reason to copy.
 */
async function fitMeasuredRows(def: RenderableDefinition): Promise<RenderableDefinition> {
  type Row = { id: string; columns?: unknown; margin?: Margins; columnGap?: unknown };
  type Column = Record<string, unknown>;
  /** Where a measured row stands: an item of the top-level content array, or, with `inner` and
   *  `block`, the `inner`th item of the inner stack of the canvas table block that is that item. */
  type Place = { top: number } | { top: number; inner: number; block: CanvasBlock };
  /** A node's own side margins, a node with none read as none (never `normalizeMargins`' page default). */
  const sides = (margin: Margins | undefined): [number, number] => {
    const [left, , right] = margin === undefined ? [0, 0, 0, 0] : normalizeMargins(margin);
    return [left, right];
  };
  const measuredId = (node: unknown): string | undefined => {
    const id = node && typeof node === "object" ? (node as { id?: unknown }).id : undefined;
    return typeof id === "string" && Object.hasOwn(MEASURED_ROWS, id) ? id : undefined;
  };
  const refuseNested = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) refuseNested(item);
      return;
    }
    const id = measuredId(node);
    if (id !== undefined) {
      throw new Error(
        `${MEASURED_ROWS[id]} must be an item of the definition's top-level content array, or an item of a ` +
        `canvas block's inner stack, where its own side margins and the block's are the only ones between it ` +
        `and the page's`);
    }
    for (const value of Object.values(node)) refuseNested(value);
  };
  const top: unknown[] | undefined = Array.isArray(def.content) ? def.content : undefined;
  for (const [key, value] of Object.entries(def)) {
    if (key !== "content" || top === undefined) refuseNested(value);
  }
  const rows: Place[] = [];
  const accept = (item: object, place: Place): void => {
    rows.push(place);
    for (const value of Object.values(item)) refuseNested(value);
  };
  top?.forEach((item, index) => {
    if (measuredId(item) !== undefined) {
      accept(item as object, { top: index });
      return;
    }
    const block = canvasBlockOf(item);
    if (block === null || !block.id.startsWith(CANVAS_TABLE_ID_PREFIX)) {
      refuseNested(item);
      return;
    }
    if (block.items === null) {
      refuseNested(block.inner);
      return;
    }
    block.items.forEach((inner, i) => {
      if (measuredId(inner) === undefined) refuseNested(inner);
      else accept(inner as object, { top: index, inner: i, block });
    });
  });
  if (!rows.length) return def;
  /** The node at `place` of `content`: the top-level item, or the item of its block's inner stack, read
   *  the same way in the definition and in its JSON copy. */
  const at = (content: unknown[], place: Place): unknown => !("block" in place) ? content[place.top]
    : canvasBlockOf(content[place.top])!.items![place.inner];
  /** The side margins of the block `place` stands in, its `columns` node's; none at the top level. */
  const blockSides = (place: Place): [number, number] => !("block" in place) ? [0, 0]
    : [place.block.left, place.block.right];

  for (const place of rows) {
    const row = at(top!, place) as Row;
    const name = MEASURED_ROWS[row.id];
    if (!Array.isArray(row.columns)) {
      throw new Error(`${name} is not a row of columns, and only a row of columns is measured`);
    }
    row.columns.forEach((column: unknown, i: number) => {
      const width = column && typeof column === "object" ? (column as Column).width : undefined;
      if (width !== "auto" && width !== "*") {
        throw new Error(
          `${name}'s column ${i + 1} has the width ${JSON.stringify(width)}: a measured row's columns are "auto" or "*"`);
      }
    });
    const stars = row.columns.filter((column: Column) => column.width === "*").length;
    if (stars > 1) throw new Error(`${name} has ${stars} "*" columns: a measured row takes one at most`);
  }
  const first = MEASURED_ROWS[(at(top!, rows[0]) as Row).id];
  if (typeof def.pageOrientation === "string" && def.pageOrientation.toLowerCase() === "landscape") {
    throw new Error(`${first} is measured on a portrait page, and this one is landscape`);
  }
  if (typeof def.pageOrientation === "string" && def.pageOrientation.toLowerCase() === "portrait" &&
      typeof def.pageSize === "object" && typeof def.pageSize.width === "number" &&
      typeof def.pageSize.height === "number" && def.pageSize.width > def.pageSize.height) {
    throw new Error(
      `${first} is measured on a page as wide as its page size says, and pdfmake swaps this one's width ` +
      `and height: it is wider than tall, under a portrait orientation`);
  }
  const pageWidth = def.pageSize === "LETTER" ? 612
    : typeof def.pageSize === "object" && typeof def.pageSize.width === "number" ? def.pageSize.width
    : undefined;
  if (pageWidth === undefined) {
    throw new Error(
      `${first} is measured on a "LETTER" page or a page of numeric width, and this one is ` +
      `${def.pageSize === undefined ? "pdfmake's default, A4" : JSON.stringify(def.pageSize)}`);
  }

  const [pageLeft, , pageRight] = normalizeMargins(def.pageMargins);
  const defaultGap = (def.defaultStyle as { columnGap?: unknown } | undefined)?.columnGap;
  // Each row's width between its side margins and its block's, which a stack takes, and its line,
  // which is that less the gaps between its columns.
  const widths = rows.map((place) => {
    const row = at(top!, place) as Row & { columns: Column[] };
    const [left, right] = sides(row.margin);
    const [outerLeft, outerRight] = blockSides(place);
    const gap = typeof row.columnGap === "number" ? row.columnGap : typeof defaultGap === "number" ? defaultGap : 0;
    const width = pageWidth - pageLeft - pageRight - outerLeft - outerRight - left - right;
    const line = width - gap * Math.max(row.columns.length - 1, 0);
    return { place, width, line, name: MEASURED_ROWS[row.id], count: row.columns.length };
  });
  const stacking = widths.filter(({ width, line }) => width > 0 && line <= 0);
  const fitting = widths.filter(({ line }) => line > 0);
  if (!stacking.length && !fitting.length) return def;

  // Both copies are taken before the measuring render lays anything out (the docblock).
  const copy = { ...def, content: JSON.parse(JSON.stringify(def.content)) } as RenderableDefinition;
  /** The row at `place` of the copy as a stack: its fields one to a line, in their order, each without
   *  its column width or `noWrap`, under the row's own margin and whatever else the row carries. Four
   *  of its deletes are belts no test sees removed: pdfmake reads no width or column gap on a stack
   *  of text, a builder's column carries no `noWrap` (only a fitted row gains one), and pdfmake
   *  draws nothing by an id. */
  const stack = (place: Place): void => {
    const row = at(copy.content as unknown[], place) as Partial<Row> & { columns?: Column[]; stack?: Column[] };
    row.stack = row.columns!.map((field) => {
      delete field.width;
      delete field.noWrap;
      return field;
    });
    delete row.id;
    delete row.columns;
    delete row.columnGap;
  };
  for (const { place } of stacking) stack(place);
  if (!fitting.length) return copy;
  type Sentinel = ContentText & { positions?: { left: number }[] };
  const measuring: Content[] = [];
  const sentinels = fitting.map(({ place, count }) => Array.from({ length: count }, (_, i) => {
    const measured = JSON.parse(JSON.stringify(at(top!, place))) as Partial<Row> & { columns: unknown[] };
    const sentinel: Sentinel = { text: "measure" };
    delete measured.id;
    delete measured.margin;
    measured.columnGap = 0;
    measured.columns = [{ ...(measured.columns[i] as Column), width: "auto", noWrap: true }, sentinel];
    measuring.push(measured as unknown as Content);
    return sentinel;
  }));
  await renderBytes({
    pageSize: { width: MEASURING_PAGE_WIDTH, height: "auto" },
    pageMargins: 0,
    defaultStyle: def.defaultStyle,
    styles: def.styles,
    content: measuring,
  });
  fitting.forEach(({ place, line, name }, k) => {
    const naturals = sentinels[k].map((sentinel) => {
      const left = sentinel.positions?.[0]?.left;
      if (left === undefined || !Number.isFinite(left)) {
        throw new Error(`${name} measurement has no laid-out position`);
      }
      return left;
    });
    const cap = equalShareCap(naturals, line);
    if (cap < MEASURED_ROW_FLOOR) {
      stack(place);
      return;
    }
    const row = at(copy.content as unknown[], place) as { columns: Column[] };
    row.columns = row.columns.map((column, i) => column.width === "*" ? column
      : naturals[i] <= cap ? { ...column, width: "auto", noWrap: true }
      : { ...column, width: cap - 0.01 });
  });
  return copy;
}

/**
 * Renders a document definition to PDF bytes.
 *
 * A `continuationHeaderSpec` carrying `overflowTopMargin` takes the TWO-PASS path (the spec's own
 * doc comment tells the why): pass one renders with the definition's original margins and no
 * continuation header, and a probe header callback captures pdfmake's own page total. One page →
 * those bytes ARE the result: original margins and no header — the golden path costs one render,
 * same as ever, and for a definition holding a measured row with width left on its line after its
 * gaps one measuring render before it (`fitMeasuredRows`; a row stacked for its gaps alone, or
 * handed back, is not measured). They are the page a definition without the spec prints, with one
 * exception: a text node object placed twice, which the probe's clone draws at both places and the
 * one-pass path (the last paragraph here) can draw at its first place only. More → pass two
 * re-renders with the header callback active and the top margin raised to at least the reserve.
 *
 * Neither pass lays out the caller's own content nodes. The probe renders a JSON DEEP CLONE of the
 * definition, and pass two a JSON deep clone of its content. One reason is the probe's: pdfmake
 * decorates content nodes during layout (positions, a `resetXY` function, an image's data swapped
 * for a name in that one render's image list), so pass two must copy nodes no layout has touched.
 * The other is that both passes must lay out the same SHAPE. pdfmake uses a text node's measured
 * words up as it places the node, so one text node OBJECT that sits at two places (a builder
 * spreads one list of heading cells into both halves of a row) is drawn at its first place only,
 * while in a JSON clone the two places are two nodes and both are drawn. If pass two laid out the
 * caller's nodes, such a node would print twice on a one-page document (the probe's bytes) and
 * once on a longer one. The copy must be JSON: `structuredClone` keeps one object placed twice as
 * one object. Pass two copies the content alone, because `full` also holds the footer and header
 * callbacks `toPdfmakeDefinition` built from the specs, which are not JSON. The continuation
 * header's own content is not copied: pdfmake measures it again for each page it draws it on.
 * The clone is lossless because definitions are plain JSON by the house template-as-data contract
 * (every builder's purity test) — and the loud refusal below keeps that honest: a function-valued
 * definition key (a hand-written `footer`/`background` callback) would silently vanish from the
 * clone and skew the probe, so it is refused by name. Use the declarative specs instead.
 *
 * A definition with no `overflowTopMargin` takes ONE pass, over what `prepareTravelerLayout` and
 * then `fitMeasuredRows` handed back. Where the first found a steps table, a results block or a
 * ticket's totals block or tear-off strip taller than a page, or the second a measured row it
 * fitted or stacked, it is a JSON copy of the content, in which a node placed twice is two
 * nodes, as in the two passes' clones above. Where they found none of these it is the caller's own
 * nodes, and there one text node object placed twice is drawn once, whatever the page count.
 *
 * Both run before the two paths part, so the probe and pass two lay out the same fitted row as the
 * one pass does.
 *
 * `laidOut`, when given, is set to the content object pdfmake laid out for the bytes returned, on
 * whichever path returns them: the one pass's content, the probe's clone on a one-page early return,
 * or pass two's fresh clone. pdfmake writes each laid-out node's `positions` onto that object, which
 * is what `renderSheetGroupsWithPositions` reads.
 */
/**
 * The definition with each flow table section's mark (`FLOW_TABLE_MARK`, a non-enumerable property a
 * flow builder sets, `src/server/pdf/flow-tables.ts`) carried as the plain key `KEEP_IN_BOX_KEY` (#991,
 * design 2026-11-17 §4.1), in a copy of the content, so the mark survives every JSON copy the renderer
 * takes after it (the measures, the two-pass render, the memo keys) and the column clamp reads it as a
 * scope root. The caller's nodes are never touched. A definition with no mark is handed back as it is,
 * so a canvas, a register and anything built by hand are laid out exactly as before.
 */
function withFlowTableKeys(def: RenderableDefinition): RenderableDefinition {
  const marked = (node: unknown): boolean => {
    if (node === null || typeof node !== "object") return false;
    if (flowTableMarkOf(node) !== undefined) return true;
    return Object.values(node).some(marked);
  };
  if (!marked(def.content)) return def;
  const copy = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(copy);
    if (node === null || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) out[key] = copy(value);
    const section = flowTableMarkOf(node);
    if (section !== undefined) out[KEEP_IN_BOX_KEY] = section;
    return out;
  };
  return { ...def, content: copy(def.content) as Content };
}

async function renderPdfCore(
  def: RenderableDefinition, memo?: MeasureMemo, laidOut?: { content?: Content },
): Promise<Buffer> {
  assertFontsRegistered(def);
  def = withFlowTableKeys(def);
  def = await prepareTravelerLayout(def, memo);
  def = await fitMeasuredRows(def);
  const full = toPdfmakeDefinition(def); // validates the spec/key collisions for BOTH passes
  const reserve = def.continuationHeaderSpec?.overflowTopMargin;
  if (reserve === undefined) {
    if (laidOut) laidOut.content = full.content;
    return renderBytes(full);
  }

  for (const [key, value] of Object.entries(def)) {
    if (typeof value === "function") {
      throw new Error(
        `overflowTopMargin's two-pass render requires a plain-JSON definition — ` +
        `"${key}" is a function (use the declarative specs instead)`);
    }
  }
  const probe = toPdfmakeDefinition(
    JSON.parse(JSON.stringify({ ...def, continuationHeaderSpec: undefined })) as RenderableDefinition);
  let probedPages = 0;
  probe.header = (_current: number, total: number): Content | null => {
    probedPages = total;
    return null; // draws nothing — the probe's bytes stay content-identical to a header-less render
  };
  const bytes = await renderBytes(probe);
  if (probedPages <= 1) {
    // The early return's bytes are the probe's, laid out from the probe's own clone.
    if (laidOut) laidOut.content = probe.content;
    return bytes;
  }

  const [left, top, right, bottom] = normalizeMargins(def.pageMargins);
  full.pageMargins = [left, Math.max(top, reserve), right, bottom];
  // The same shape the probe laid out (the docblock): a JSON copy, never `structuredClone`.
  full.content = JSON.parse(JSON.stringify(full.content)) as Content;
  if (laidOut) laidOut.content = full.content;
  return renderBytes(full);
}

/**
 * The public single-document render: the pdfmake core plus the Phase 8B practice watermark. Every
 * document type reaches its bytes through here (bol/cert/invoice/statement/quote); the traveler and
 * shipping tickets go through renderSheetGroups, which stamps the MERGED bytes instead.
 */
export async function renderPdf(def: RenderableDefinition): Promise<Buffer> {
  return stampPractice(await renderPdfCore(def));
}

/**
 * The practice-copy watermark (Phase 8B §5.4): a diagonal, low-opacity "PRACTICE / SAMPLE" on every
 * page of already-rendered bytes, keyed off the single practiceMode() helper — NOT the template
 * config, so it can never be removed through the Phase 7 editor. In production this is a TRUE no-op:
 * it short-circuits to the input Buffer with NO pdf-lib re-serialize, so production renders stay
 * byte-golden-identical and reprints of stored bytes stay Buffer.compare-exact. Both entry points
 * funnel through here exactly once — renderPdf stamps its one document; renderSheetGroups stamps the
 * merged bytes (its per-group renders use renderPdfCore, unstamped), so a page is never stamped
 * twice. `useObjectStreams: false` preserves the uncompressed `/Count N` marker, the same reason the
 * merge does.
 */
async function stampPractice(bytes: Buffer): Promise<Buffer> {
  if (!(await practiceMode())) return bytes;
  const pdf = await PDFDocument.load(bytes);
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const text = "PRACTICE / SAMPLE";
  const angle = Math.PI / 4;
  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    const size = Math.max(24, Math.min(width, height) / 9);
    const textWidth = font.widthOfTextAtSize(text, size);
    // Center the rotated baseline on the page (offset the start point back along the 45° vector).
    page.drawText(text, {
      x: width / 2 - (textWidth / 2) * Math.cos(angle),
      y: height / 2 - (textWidth / 2) * Math.sin(angle),
      size,
      font,
      color: rgb(0.86, 0.15, 0.15),
      rotate: degrees(45),
      opacity: 0.18,
    });
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

/**
 * Renders each sheet-group definition as its OWN document and merges the results into one PDF
 * (spec §6.1). This is the whole mechanism behind per-group page numbers and continuation
 * headers: pdfmake's callbacks only ever see whole-document page counts, so "Page 1 of 2" on a
 * ticket meaning THAT ticket's pages requires each group to BE a document — each render's
 * `pageFooterSpec`/`continuationHeaderSpec` scopes to its group for free, restarting at every
 * group boundary.
 *
 * The merge is saved with `useObjectStreams: false`: object streams would deflate the page tree,
 * and the uncompressed `/Type /Pages /Count N` marker is what every house content assertion
 * (and the E2E flows) read off stored bytes. Groups render sequentially — a print is one request,
 * and #43's load bound caps the group count.
 *
 * The merge also keeps ONE copy of an image the groups share (#670): each group is its own pdfkit
 * document, so a template's logo arrived once per load or order (a 100-load traveler with a 512 KB
 * logo stored 54 MB against 2.1 MB without; a 20-order ticket set 10.8 MB against 0.43 MB, measured
 * 2026-11-07). `dedupeImages` below runs after the copy loop and before the save. Fonts are left
 * alone: each group's subset holds its own glyphs under its own tag, so none is a duplicate.
 */
export async function renderSheetGroups(defs: RenderableDefinition[]): Promise<Buffer> {
  return (await renderSheetGroupsWithPositions(defs)).pdf;
}

/** Where pdfmake laid out a node that carries a string `id`: the page of its group (1-based) and
 *  the left and top of its first position, in points from the page's top-left corner. `squeezed`,
 *  present only when true, on a canvas table block whose layout the column clamp corrected (some
 *  column laid out narrower than pdfmake's own case 1 gave it, #971). */
export type LaidOutNode = { id: string; page: number; left: number; top: number; squeezed?: true };

/**
 * `renderSheetGroups`, answering also, for each group, where each of its id'd content nodes was
 * laid out and how many pages the group took. It IS `renderSheetGroups`' implementation (one
 * measurement memo, `renderPdfCore` per group, the merge, `dedupeImages`, one practice stamp), so
 * the bytes are the same paper; the positions are read off the content each group's render laid
 * out (`renderPdfCore`'s `laidOut`), where pdfmake writes `positions` onto the nodes it placed, the
 * technique `blockHeight` measures with.
 *
 * The walk descends a node's `stack`, `columns`, `section`, `ul`, `ol` and `table.body` cells and
 * nothing else (laid-out nodes carry `_inlines`, `resetXY` and line objects that point back at
 * them), visits each object once, and reports a node whose `id` is a string and whose `positions`
 * is not empty, from `positions[0]`. A node pdfmake laid out nowhere (an empty stack) is left out.
 *
 * The caveat: pdfmake takes a position from the OUTERMOST writing context, so a node inside an
 * `unbreakable` block, a `dontBreakRows` row, a header or a footer reports where that block began,
 * not where the node itself drew (and a block moved to the next page corrects only its lines' page
 * number). Id only top-level flow nodes whose position is wanted.
 */
export async function renderSheetGroupsWithPositions(
  defs: RenderableDefinition[],
): Promise<{ pdf: Buffer; groups: { positions: LaidOutNode[]; pages: number }[] }> {
  if (defs.length === 0) {
    throw new Error("renderSheetGroups needs at least one sheet-group definition");
  }
  const merged = await PDFDocument.create();
  // One call's measurements, shared by its groups and dropped with it (#611, `prepareTravelerLayout`).
  const memo: MeasureMemo = new Map();
  const groups: { positions: LaidOutNode[]; pages: number }[] = [];
  for (const def of defs) {
    const laidOut: { content?: Content } = {};
    // renderPdfCore, NOT the public renderPdf: the per-group renders stay UNstamped so the merged
    // document is watermarked exactly once below (no double-stamp — Phase 8B §5.4).
    const src = await PDFDocument.load(await renderPdfCore(def, memo, laidOut));
    groups.push({ positions: laidOutNodes(laidOut.content), pages: src.getPageCount() });
    for (const page of await merged.copyPages(src, src.getPageIndices())) {
      merged.addPage(page);
    }
  }
  dedupeImages(merged);
  const pdf = await stampPractice(Buffer.from(await merged.save({ useObjectStreams: false })));
  return { pdf, groups };
}

/**
 * Joins already-rendered PDFs end to end, in the order given (#1057: the Invoicing list's Print as
 * one PDF, which joins the stored copies its selected prints filed). The merge is
 * `renderSheetGroupsWithPositions`' own: `copyPages` per document, `dedupeImages` so a logo the
 * invoices share is kept once, and `useObjectStreams: false` for the uncompressed `/Count N` marker.
 * It is NEVER practice-stamped: each input is a stored print, already stamped once when it was
 * rendered in the practice copy, and stamping the join would mark every page twice. Nothing renders
 * here, so no pdfmake state is touched.
 */
export async function joinPdfs(parts: readonly Uint8Array[]): Promise<Buffer> {
  if (parts.length === 0) throw new Error("joinPdfs needs at least one PDF");
  const merged = await PDFDocument.create();
  for (const bytes of parts) {
    const src = await PDFDocument.load(bytes);
    for (const page of await merged.copyPages(src, src.getPageIndices())) merged.addPage(page);
  }
  dedupeImages(merged);
  return Buffer.from(await merged.save({ useObjectStreams: false }));
}

/**
 * The positions half of `renderSheetGroupsWithPositions` alone: each definition laid out through
 * `renderPdfCore` with one shared memo and its id'd nodes read off the laid-out content. No pdf-lib
 * document is created, loaded, merged, deduplicated, stamped or saved, so a caller that wants only
 * where things landed (the preview's alone pages) pays for none of it. `[]` for an empty list.
 */
export async function layOutSheetGroups(defs: RenderableDefinition[]): Promise<LaidOutNode[][]> {
  const memo: MeasureMemo = new Map();
  const groups: LaidOutNode[][] = [];
  for (const def of defs) {
    const laidOut: { content?: Content } = {};
    await renderPdfCore(def, memo, laidOut);
    groups.push(laidOutNodes(laidOut.content));
  }
  return groups;
}

/** The id'd nodes of laid-out content, in document order (`renderSheetGroupsWithPositions`). */
/**
 * What the column clamp did to each flow table section (#991, design 2026-11-17 §7), by section key,
 * each once, in the order the definitions lay them out: `moved`, the sections a row of which it laid
 * out narrower than pdfmake would have; `overran`, the sections a row of which lays out wider than it
 * was handed and keeps that width (its fixed columns and floors pass it, `keepInBox`'s belt), so it
 * prints past its width as it did before #991. Each definition is laid out through `renderPdfCore`
 * (one memo, nothing stamped or merged) and every node carrying `KEEP_IN_BOX_KEY` is read off the
 * laid-out content for the clamp's flags. The stored-template listing's `--clamp` verdict; a canvas
 * block is never named (its scope is its id).
 */
export async function clampedFlowTables(defs: RenderableDefinition[]): Promise<{ moved: string[]; overran: string[] }> {
  const memo: MeasureMemo = new Map();
  const moved: string[] = [];
  const overran: string[] = [];
  for (const def of defs) {
    const laidOut: { content?: Content } = {};
    await renderPdfCore(def, memo, laidOut);
    const seen = new Set<object>();
    const visit = (node: unknown): void => {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      const laid = node as Record<string, unknown> & ClampNode & { table?: { body?: unknown } };
      const key = laid[KEEP_IN_BOX_KEY];
      if (typeof key === "string") {
        if (laid[COLUMN_CLAMP_SQUEEZED] === true && !moved.includes(key)) moved.push(key);
        if (laid[COLUMN_CLAMP_OVERRAN] === true && !overran.includes(key)) overran.push(key);
      }
      for (const child of [laid.stack, laid.columns, laid.section, laid.ul, laid.ol, laid.table?.body]) visit(child);
    };
    visit(laidOut.content);
  }
  return { moved, overran };
}

function laidOutNodes(content: Content | undefined): LaidOutNode[] {
  type Laid = {
    id?: unknown; positions?: { pageNumber: number; left: number; top: number }[];
    stack?: unknown; columns?: unknown; section?: unknown; ul?: unknown; ol?: unknown;
    table?: { body?: unknown }; [COLUMN_CLAMP_SQUEEZED]?: true;
  };
  const found: LaidOutNode[] = [];
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const laid = node as Laid;
    const first = laid.positions?.[0];
    if (typeof laid.id === "string" && first) {
      found.push({
        id: laid.id, page: first.pageNumber, left: first.left, top: first.top,
        ...(laid[COLUMN_CLAMP_SQUEEZED] === true ? { squeezed: true as const } : {}),
      });
    }
    for (const child of [laid.stack, laid.columns, laid.section, laid.ul, laid.ol, laid.table?.body]) {
      visit(child);
    }
  };
  visit(content);
  return found;
}

/**
 * One copy of each image in a merged document (#670). An image is the same as another when its
 * bytes, its dictionary and everything its dictionary points at (an alpha PNG's /SMask stream, a
 * palette) are the same, read through the references rather than by them: pdf-lib's `copyPages`
 * gives every copied object a new reference, so two copies of one logo share nothing but content.
 * Every page's /XObject entry that names a duplicate is pointed at the first copy, the duplicates
 * are deleted, and a mask no surviving image references goes with them. Nothing else is touched.
 */
function dedupeImages(doc: PDFDocument): void {
  const ctx = doc.context;
  const SUBTYPE = PDFName.of("Subtype"), IMAGE = PDFName.of("Image"), SMASK = PDFName.of("SMask");
  const LENGTH = PDFName.of("Length"), XOBJECT = PDFName.of("XObject");
  // A content key for any object, references followed (depth-bounded, cycles cut), so two objects
  // with the same bytes and the same structure key alike whatever their reference numbers.
  const canon = (obj: PDFObject | undefined, depth: number, seen: Set<string>): string => {
    if (obj === undefined || depth > 8) return "?";
    if (obj instanceof PDFRef) {
      if (seen.has(obj.toString())) return "cycle";
      return canon(ctx.lookup(obj), depth + 1, new Set(seen).add(obj.toString()));
    }
    if (obj instanceof PDFRawStream) {
      return `stream(${canon(obj.dict, depth, seen)})` + createHash("sha256").update(obj.contents).digest("hex");
    }
    if (obj instanceof PDFDict) {
      return "<<" + obj.entries()
        .filter(([k]) => k !== LENGTH)
        .map(([k, v]) => `${k.toString()} ${canon(v, depth + 1, seen)}`)
        .sort()
        .join(" ") + ">>";
    }
    if (obj instanceof PDFArray) return "[" + obj.asArray().map((v) => canon(v, depth + 1, seen)).join(" ") + "]";
    return obj.toString();
  };
  const keptByKey = new Map<string, PDFRef>();
  const replacement = new Map<string, PDFRef>(); // a duplicate's ref → the kept ref
  const duplicates: PDFRawStream[] = [];
  const masks = new Set<string>(); // every /SMask target: identified through its image, never on its own
  const images: [PDFRef, PDFRawStream][] = [];
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.get(SUBTYPE) !== IMAGE) continue;
    images.push([ref, obj]);
    const mask = obj.dict.get(SMASK);
    if (mask instanceof PDFRef) masks.add(mask.toString());
  }
  for (const [ref, obj] of images) {
    if (masks.has(ref.toString())) continue;
    const key = canon(obj, 0, new Set());
    const kept = keptByKey.get(key);
    if (kept === undefined) keptByKey.set(key, ref);
    else { replacement.set(ref.toString(), kept); duplicates.push(obj); }
  }
  if (replacement.size === 0) return;
  for (const page of doc.getPages()) {
    const xobjects = page.node.Resources()?.lookupMaybe(XOBJECT, PDFDict);
    if (xobjects === undefined) continue;
    for (const [name, value] of xobjects.entries()) {
      const kept = value instanceof PDFRef ? replacement.get(value.toString()) : undefined;
      if (kept !== undefined) xobjects.set(name, kept);
    }
  }
  const survivingMasks = new Set<string>();
  for (const [ref, obj] of images) {
    if (replacement.has(ref.toString())) continue;
    const mask = obj.dict.get(SMASK);
    if (mask instanceof PDFRef) survivingMasks.add(mask.toString());
  }
  for (const [refText] of replacement) {
    const [num, gen] = refText.split(" ").map(Number);
    ctx.delete(PDFRef.of(num, gen));
  }
  for (const dup of duplicates) {
    const mask = dup.dict.get(SMASK);
    if (mask instanceof PDFRef && !survivingMasks.has(mask.toString())) ctx.delete(mask);
  }
}

export const DRAFT_PROCESS_PREVIEW_LABEL = "DRAFT PROCESS PREVIEW - NOT FOR PRODUCTION";

/** Render through the production sheet-group path, then add a small margin-only draft label to
 * every final page. Post-marking keeps the production builder's pagination and content intact. */
export async function renderDraftTraveler(
  defs: RenderableDefinition[],
): Promise<{ pdf: Buffer; pageCount: number }> {
  const production = await renderSheetGroups(defs);
  const pdf = await PDFDocument.load(production);
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = pdf.getPages();
  for (const page of pages) {
    page.drawText(DRAFT_PROCESS_PREVIEW_LABEL, {
      x: 24,
      y: 8,
      size: 6,
      font,
      color: rgb(0.72, 0.12, 0.12),
      opacity: 0.8,
    });
  }
  return {
    pdf: Buffer.from(await pdf.save({ useObjectStreams: false })),
    pageCount: pages.length,
  };
}

/**
 * A Code 128 barcode as a PNG, sized for the traveler's header block.
 *
 * The payload is the bare order number and nothing else (spec §10): scanning it into the Shell's
 * global search hits the exact-order-number short-circuit and opens the order. `includetext` is
 * off because the number is already printed above the barcode in the header.
 */
export async function barcodePng(text: string): Promise<Buffer> {
  return toBuffer({ bcid: "code128", text, scale: 3, height: 12, includetext: false });
}

/** `{ image }` content nodes take a data URI; the definition stays plain JSON either way. */
export function pngDataUri(png: Buffer): string {
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** The JPEG sibling (spec §6.3) — template logos are PNG or JPEG, sniffed at upload; the stored
 *  mime type picks which helper embeds them. */
export function jpegDataUri(jpeg: Buffer): string {
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}
