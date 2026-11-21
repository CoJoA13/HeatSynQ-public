/**
 * The traveler header's left column as a rendered page prints it (#518). Shared by the layout, the
 * SAMPLE and the template preview suites, so all three read the column by one rule.
 */
import assert from "node:assert/strict";
import { textRunsWithY } from "./pdf";

/** Where the header's left slot ends on the Standard sheet: the 24-point page margin and the
 *  177-point slot. The center slot starts 10 points further on, at 211. */
export const LEFT_COLUMN_RIGHT = 24 + 177;

/** The write-in rule an order with no PO prints after the label: 23 underscores. */
export const RULE = "_".repeat(23);

/**
 * One page's left header column, top line first: the runs left of `LEFT_COLUMN_RIGHT` that lie
 * above the part lines' heading (the highest run reading "Part "), joined along each baseline
 * (rounded to 0.1 point), each line trimmed. A page with no part lines' heading fails.
 */
export function leftColumn(pdf: Buffer, page = 0): string[] {
  const runs = textRunsWithY(pdf)[page] ?? assert.fail(`the document has no page ${page + 1}`);
  const heads = runs.filter((run) => run.text === "Part ");
  assert.ok(heads.length > 0, `page ${page + 1} prints no part lines' heading`);
  const floor = Math.max(...heads.map((run) => run.y));
  const byLine = new Map<number, typeof runs>();
  for (const run of runs) {
    if (run.x >= LEFT_COLUMN_RIGHT || run.y <= floor) continue;
    const y = Math.round(run.y * 10) / 10;
    byLine.set(y, [...(byLine.get(y) ?? []), run]);
  }
  return [...byLine.entries()].sort((a, b) => b[0] - a[0])
    .map(([, line]) => line.sort((a, b) => a.x - b.x).map((run) => run.text).join("").trim());
}
