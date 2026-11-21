import { STATEMENT_WIDTHS } from "@/server/pdf/statement";
import { CANVAS_GRID } from "@/lib/template-contracts/canvas";
import { STATEMENT_CONTRACT } from "@/lib/template-contracts/statement";
import { tableOverhead } from "@/lib/printed-width-core";

/**
 * The statement profile's least widths derived from the flow's exported widths (design 2026-11-11
 * §4.1, call 12), stated once for the hold in tests/statement-canvas.test.ts and the resize floors in
 * tests/template-contracts.test.ts and tests/canvas-designer.test.ts (the invoice's
 * tests/helpers/invoice-flow-widths.ts shape): the finance charge's and Total Due's `totalLine`, its
 * label column, its amount column and the two gaps between its three columns, and a step. The open
 * items' columns are content-sized, so theirs is the owner's (#971, ruling 4, 2026-11-14): the boxed
 * table's padding and rules over its columns (one per field of its section, the builder's
 * `OPEN_ITEM_WIDTH`), rounded up to the grid, and a step. The Bill To has no fixed part and no entry.
 */
export function statementFlowLeastWidths(): Record<string, number> {
  const W = STATEMENT_WIDTHS;
  const totals = W.totalsLabel + W.totalsAmount + 2 * W.totalsGap + CANVAS_GRID;
  const openColumns = STATEMENT_CONTRACT.sections.find((s) => s.key === "open_items")!.fields.length;
  const openItems = Math.ceil(tableOverhead("boxed", openColumns) / CANVAS_GRID) * CANVAS_GRID + CANVAS_GRID;
  return { open_items: openItems, finance_charge: totals, total: totals };
}
