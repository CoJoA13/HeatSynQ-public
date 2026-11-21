/**
 * A log of pdfmake's column sizing (#971): every call of `buildColumnWidths` a render makes, read
 * after the call returns, so a clamped row is logged at the widths it is laid out at. Wraps the
 * property on the calculator object pdfmake's callers read at call time (`LayoutBuilder.processColumns`,
 * `TableProcessor.beginTable`), around whatever is installed there (`render.ts`' column clamp), with
 * plain property save and restore in `finally`. A test helper, never a module of the app: `render.ts`
 * stays pdfmake's only importer in `src/`.
 *
 * `marked` reads the clamp's mark (`Symbol.for("heatsynq.render.columnClampMark")`) on the call's
 * table node, or on its `columns` array for a row of columns: whether the call was inside a canvas
 * table block. `specs` are the widths as the definition gave them (read before the call: pdfmake
 * turns a percentage into points in place), `minWidths` pdfmake's measured minima, and `widths` the
 * widths laid out (`_calcWidth`). `available` is what the caller handed: a row's width less its gaps,
 * a table's less its layout's offsets.
 *
 * The log is process-wide while `run` runs, so a caller runs one render at a time under it.
 */
import ColumnCalculatorModule, { type CalculatorColumn } from "pdfmake/js/columnCalculator.js";

/** The calculator object, unwrapped as `render.ts` unwraps it (`.default ?? module`). */
const calculator =
  (ColumnCalculatorModule as unknown as { default?: typeof ColumnCalculatorModule }).default ?? ColumnCalculatorModule;

const CLAMP_MARK = Symbol.for("heatsynq.render.columnClampMark");

export type ColumnEvent = {
  marked: boolean; available: number; specs: unknown[]; minWidths: number[]; widths: number[];
  /** The table node the call was handed (`TableProcessor`), absent for a row of columns. */
  table?: unknown;
};

/** The traveler steps table's layout name (render.ts `LAYOUT.steps`), restated so this helper
 *  imports nothing of the app; tests/steps-measure.test.ts holds it to `LAYOUT.steps`. */
export const STEPS_LAYOUT = "traveler-steps";

/**
 * Whether a call is the steps measure's (`oversizedRows`, render.ts): a steps-layout table whose last
 * row is the measure's sentinel, every cell a bare text (a `text` and none of the stack, table,
 * border, bold, italics or colSpan a printed cell carries). Read by shape, never by the sentinel's
 * words (#992 changed them): no row a steps table prints is one, as every step row prints its
 * position in bold and its instruction as a stack, and a table with no steps prints its italic
 * "carries no steps" sentence and borderless handwriting cells.
 */
export function isStepsMeasure(e: ColumnEvent): boolean {
  const t = e.table as { layout?: unknown; table?: { body?: unknown[][] } } | undefined;
  const body = t?.layout === STEPS_LAYOUT ? t.table?.body ?? [] : [];
  const last = body[body.length - 1];
  return Array.isArray(last) && last.length > 0 && last.every((cell) => {
    if (cell === null || typeof cell !== "object") return false;
    const c = cell as Record<string, unknown>;
    return typeof c.text === "string"
      && ["stack", "table", "border", "bold", "italics", "colSpan"].every((key) => c[key] === undefined);
  });
}

export async function logColumnWidths<T>(run: () => Promise<T>): Promise<{ result: T; events: ColumnEvent[] }> {
  const events: ColumnEvent[] = [];
  const installed = calculator.buildColumnWidths;
  calculator.buildColumnWidths = function (
    columns: CalculatorColumn[], availableWidth: number, offsetTotal?: number, tableNode?: unknown,
  ): void {
    const specs = columns.map((column) => column.width);
    installed.call(this, columns, availableWidth, offsetTotal, tableNode);
    const carrier = (tableNode ?? columns) as { [CLAMP_MARK]?: unknown };
    events.push({
      marked: carrier[CLAMP_MARK] !== undefined,
      available: availableWidth,
      specs,
      minWidths: columns.map((column) => column._minWidth),
      widths: columns.map((column) => column._calcWidth),
      ...(tableNode === undefined ? {} : { table: tableNode }),
    });
  };
  try {
    return { result: await run(), events };
  } finally {
    calculator.buildColumnWidths = installed;
  }
}
