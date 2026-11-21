/**
 * The printed-width arithmetic of the template tables (#457, #519), in a leaf that reads no
 * contract: the layouts' padding and rules, what a table of N columns adds to its declared widths,
 * and the words that state a share. The 39 pt line a share was once judged against is retired on
 * both layouts (owner rulings R-A and R-C, 2026-11-17, #991); `MIN_SHARED_WIDTH_PT` stays only as the
 * figure under which a share is written with two decimals.
 *
 * IMPORT RULE: this file imports no registry (`template-contracts/index.ts`), no
 * `template-printed-width.ts` and no contract module, only the type below. `template-canvas.ts`
 * reads it, and the registry reads `template-canvas.ts`, so any such import is a cycle.
 * `template-printed-width.ts` re-exports every name here, so its importers do not move.
 *
 * CLIENT-SAFE: no `src/server/**` import.
 */
import type { TemplateDocTypeString } from "./template-contracts/types";

/** render.ts's `ruled` and `boxed` layouts: the side padding each gives every column, and the width
 *  of the vertical rule it draws at every column edge (`ruled` draws none). */
export const TABLE_LAYOUT_METRICS = {
  ruled: { padding: 4, rule: 0 },
  boxed: { padding: 4, rule: 0.8 },
} as const;

/** pdfmake's own `noBorders` layout, which the traveler's inspections table is laid out with
 *  inside its box: 4pt of padding on each side of a boundary between two columns, none at the
 *  table's outer edges, and no rules. */
const NO_BORDERS_PADDING = 4;

/**
 * How a column table prints:
 * - `ruled` and `boxed`: one table with render.ts's layout of that name.
 * - `nested`: a `noBorders` table of the columns, inside the one cell of a `boxed` table.
 * - `steps`: the traveler's steps layout, measured by `travelerStepsPrintedWidth`.
 */
export type TableLayoutKind = "ruled" | "boxed" | "nested" | "steps";

/** `copies`: how many times the columns print side by side in one table. */
export type ColumnTableLayout = { kind: TableLayoutKind; copies: number };

const RULED: ColumnTableLayout = { kind: "ruled", copies: 1 };
const BOXED: ColumnTableLayout = { kind: "boxed", copies: 1 };
/** The ticket's container table: the sample folds the container list, so its columns print twice. */
const FOLDED: ColumnTableLayout = { kind: "ruled", copies: 2 };

/** Every column table (`ColumnSpec.table`) of every contract, by document type.
 *  tests/template-printed-width.test.ts holds it to the contracts, both ways. */
export const COLUMN_TABLE_LAYOUTS: Readonly<
  Record<TemplateDocTypeString, Readonly<Record<string, ColumnTableLayout>>>
> = {
  TRAVELER: {
    lines: RULED, quantities: RULED, inspections: { kind: "nested", copies: 1 }, steps: { kind: "steps", copies: 1 },
  },
  SHIPPER: { field_strip: BOXED, lines: RULED, containers: FOLDED },
  MOS_SHIPPER: { field_strip: BOXED, lines: RULED, containers: FOLDED },
  BOL: { freight: BOXED },
  CERT: { parts: RULED },
  INVOICE: { columns: BOXED },
  STATEMENT: { aging: BOXED },
  QUOTE: { columns: BOXED },
  CONTAINER_TAG: {},
};

export const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * What a table of `columns` columns adds to their declared widths, in points.
 * `ruled` and `boxed`: both side paddings of every column, and a rule at every column edge, the
 * table's two outer edges included. `nested`: one `boxed` column, plus `noBorders` padding at each
 * boundary between two of the columns inside it.
 */
export function tableOverhead(kind: "ruled" | "boxed" | "nested", columns: number): number {
  if (kind === "nested") return round2(tableOverhead("boxed", 1) + (columns - 1) * 2 * NO_BORDERS_PADDING);
  const { padding, rule } = TABLE_LAYOUT_METRICS[kind];
  return round2(columns * 2 * padding + (columns + 1) * rule);
}

/**
 * The share, in points, under which a share's words carry two decimals (`sharedWidthWords`). It was the line under
 * which a shared column of the ticket's container table was said to have no room (the weights design's §13.7, point
 * 33: the container table ended at the right margin with each shared column at 39 points, measured 2026-10-12 and
 * 2026-10-16). Under the column clamp (#971, #991) no table prints past its width for a narrow share, so the line's
 * warnings are retired, the flow's (owner ruling R-A) and the canvas's warning (f) (R-C), both 2026-11-17; the heading
 * warnings say when a share is under its headings' widest word.
 */
export const MIN_SHARED_WIDTH_PT = 39;

/** A width or a share in points: one decimal, a closing zero dropped (the weights design's §13.7,
 *  point 14, part f). */
export const pt = (points: number): string => String(Math.round(points * 10) / 10);

/** A share under `MIN_SHARED_WIDTH_PT`, with two decimals (owner, 2026-10-16) and a closing zero
 *  dropped, never rounded up to 39: 38.998 reads 38.99. The owner chose the form so a share never read
 *  39 beside the 39 pt warning; that warning is retired (R-A, R-C), and the form is kept as the words
 *  the share has been printed in since. */
const underTheLine = (each: number): string =>
  String(Math.min(Math.round(each * 100) / 100, (MIN_SHARED_WIDTH_PT * 100 - 1) / 100));

/** What the shared columns get, in the listing's words: "Containers and Tare get 54 pt each", and
 *  one shared column in the singular, "Tare gets 116 pt" (the weights design's §13.7, point 14,
 *  part b). `shared` is `sharedContainerWidth`'s, one name or more, and `each` its share. A share
 *  under 39 pt has two decimals and never reads 39, "Containers and Tare get 38.95 pt each" (owner,
 *  2026-10-16). The editor's share line and the stored-template listing's ticket Widths cell write
 *  every share in these words. */
export function sharedWidthWords(shared: readonly string[], each: number): string {
  const figure = each < MIN_SHARED_WIDTH_PT ? underTheLine(each) : pt(each);
  if (shared.length === 1) return `${shared[0]} gets ${figure} pt`;
  return `${shared.join(" and ")} get ${figure} pt each`;
}
