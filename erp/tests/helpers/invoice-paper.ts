import { expect } from "vitest";
import { strokedLines } from "./pdf";

/**
 * The invoice's page readers, copied from tests/invoice-pdf.test.ts (which keeps its own, the
 * golden file not being edited) for the canvas suites: the order strip's fields read from a page's
 * runs (#590) and the price rules read from its strokes (#589). Plain syntax node can strip.
 *
 * `textRunsWithY` gives where each word STARTS, and nothing of where it ends, so every assertion on
 * the strip is made of starts. A field starts at its label. pdfkit draws a word as a run, and a field
 * that fits its share is drawn under `noWrap`, as one run of each style, so a label's run is the
 * whole label or its first word. Fields on one line are labels on one y; a field takes as many
 * baselines as its runs have different y values.
 */
export const LABELS = ["Our Order #:", "Your PO #:", "Material:", "Process:"];
export type Run = { text: string; x: number; y: number };

/** A rendered page's runs, and the strip's runs field by field. pdfkit draws a row column by column,
 *  so a field holds every run drawn from its label to the next field's label; the last holds the
 *  runs drawn after its label that start at or right of it, which ends at the PARTS heading. `labels`
 *  are the shown fields' labels as the template prints them, in their order. */
export const fieldsOf = (page: Run[], labels: string[] = LABELS) => {
  const at = labels.map((label) => page.findIndex((r) => [label, label.split(" ")[0]].includes(r.text.trim())));
  expect(at.every((i) => i >= 0), `every label is drawn on the page: ${JSON.stringify(at)}`).toBe(true);
  // A field is cut from one label's run to the next one's, so the labels must be drawn in their order.
  expect(at.every((i, k) => k === 0 || i > at[k - 1]), `the labels are drawn in their order: ${JSON.stringify(at)}`).toBe(true);
  const fields = at.map((start, i): Run[] => {
    if (i + 1 < at.length) return page.slice(start, at[i + 1]);
    const rest = page.slice(start);
    const end = rest.findIndex((r) => r.x < rest[0].x);
    return end < 0 ? rest : rest.slice(0, end);
  });
  return { page, fields, labels: fields.map((field) => field[0]) };
};

export const baselines = (runs: Run[]): number => new Set(runs.map((r) => r.y)).size;

/** The labels on one y, left to right in their order. */
export const onOneLine = (labels: Run[]): void => {
  expect(labels.map((r) => r.y), "the labels' y").toEqual(labels.map(() => labels[0].y));
  expect(labels.every((r, i) => i === 0 || r.x > labels[i - 1].x), "the labels' x, left to right").toBe(true);
};

/** The price rule's thickness, as the owner ruled at the paper look of 2026-10-21 (#589). */
export const RULE_WIDTH = 0.5;

/** Page `page`'s (0-based) price rules, top to bottom: its horizontal strokes of the rule's
 *  thickness. `strokedLines`' y is top-down; the column strip's box draws 0.8 points, so it is not
 *  one. */
export const ruledRules = (pdf: Buffer, page: number) =>
  strokedLines(pdf)[page]
    .filter((s) => s.y1 === s.y2 && s.width === RULE_WIDTH)
    .sort((a, b) => a.y1 - b.y1);
