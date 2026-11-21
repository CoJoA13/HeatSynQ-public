/**
 * Warning (i) of `canvasWarnings` (#971 design §7.3, the controller's call C3): this record's words
 * break. When render.ts' column clamp lays a canvas block's columns out narrower than pdfmake's own
 * widths, the preview's measure carries `squeezed: true` on the block's `tables` entry, and the
 * designer says so for the picked record, in one sentence, for a table warning (d) has not already
 * warned. It reads the measure alone: it refuses nothing, and no measure (or none flagged) says
 * nothing. Ruling 4's "the designer warns" for the statement's open items is this warning.
 */
import { describe, expect, it } from "vitest";
import { STATEMENT_CONTRACT } from "@/lib/template-contracts/statement";
import type { CanvasLayout } from "@/lib/template-contracts/canvas";
import { canvasRefusal, canvasWarnings, leastWidth, type CanvasMeasure } from "@/lib/template-canvas";
import { parseMeasure } from "@/lib/template-editor";
import { reboxed } from "./helpers/keep-in-box-cases";
import { standardStatementLayout } from "./helpers/statement-canvas-fixtures";

const OPEN_ITEMS = "The Open items table's columns are narrower than words it prints for this record, so they break inside their cells.";
const AGING = "The Aging strip table's columns are narrower than words it prints for this record, so they break inside their cells.";

/** A measure holding every table of the layout at its drawn box, `squeezed` on the keys named. */
function measureOf(layout: CanvasLayout, squeezed: string[]): CanvasMeasure {
  return {
    pages: 1, regions: [], items: [],
    tables: layout.items.flatMap((i) => (i.kind !== "table" ? [] : [{
      key: i.key, page: 1, top: i.box.y, height: i.box.h, ...(squeezed.includes(i.key) ? { squeezed: true as const } : {}),
    }])),
  };
}

/** The sentences of (i) on the layout. */
function said(layout: CanvasLayout, measure?: CanvasMeasure): string[] {
  return canvasWarnings(layout, STATEMENT_CONTRACT, measure, { fonts: STATEMENT_CONTRACT.fonts })
    .filter((w) => /words it prints for this record/.test(w.sentence)).map((w) => w.sentence);
}

describe("canvasWarnings (i)", () => {
  it("states a squeezed table for this record", () => {
    const layout = standardStatementLayout();
    // Never a refusal: the layout is one the rules accept, and the measure is no input to them.
    expect(canvasRefusal(layout, STATEMENT_CONTRACT, { fonts: STATEMENT_CONTRACT.fonts })).toBeNull();
    const warnings = canvasWarnings(layout, STATEMENT_CONTRACT, measureOf(layout, ["open_items"]), { fonts: STATEMENT_CONTRACT.fonts });
    expect(warnings.filter((w) => /words it prints for this record/.test(w.sentence)))
      .toEqual([{ itemIds: ["table-open_items"], sentence: OPEN_ITEMS }]);
    // Each squeezed table its own sentence, in the layout's order.
    expect(said(layout, measureOf(layout, ["open_items", "aging"]))).toEqual([OPEN_ITEMS, AGING]);
  });

  it("says nothing of a table warning (d) has already warned", () => {
    // The aging at its least width: its headings break (d), so (i) does not say it again.
    const base = standardStatementLayout();
    const aging = base.items.find((i) => i.kind === "table" && i.key === "aging")!;
    const least = leastWidth(STATEMENT_CONTRACT, aging, { fonts: STATEMENT_CONTRACT.fonts });
    const layout = reboxed(base, "aging", { x: 588 - least, w: least });
    expect(canvasRefusal(layout, STATEMENT_CONTRACT, { fonts: STATEMENT_CONTRACT.fonts })).toBeNull();
    const warnings = canvasWarnings(layout, STATEMENT_CONTRACT, measureOf(layout, ["aging", "open_items"]), { fonts: STATEMENT_CONTRACT.fonts });
    expect(warnings.some((w) => w.itemIds.includes("table-aging") && /heading words break/.test(w.sentence))).toBe(true);
    expect(said(layout, measureOf(layout, ["aging", "open_items"]))).toEqual([OPEN_ITEMS]);
  });

  it("says nothing with no squeezed table, or no measure", () => {
    const layout = standardStatementLayout();
    expect(said(layout, measureOf(layout, []))).toEqual([]);
    expect(said(layout)).toEqual([]);
  });

  it("reaches the designer: the preview's X-Preview-Measure header, read through parseMeasure, keeps squeezed", () => {
    const layout = standardStatementLayout();
    const header = encodeURIComponent(JSON.stringify(measureOf(layout, ["open_items"])));
    const parsed = parseMeasure(header);
    expect(parsed?.tables.find((t) => t.key === "open_items")?.squeezed).toBe(true);
    expect(said(layout, parsed ?? undefined)).toEqual([OPEN_ITEMS]);
  });
});
