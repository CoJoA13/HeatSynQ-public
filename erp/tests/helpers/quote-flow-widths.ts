import { QUOTE_WIDTHS } from "@/server/pdf/quote";
import { QUOTE_CONTRACT } from "@/lib/template-contracts/quote";
import { CANVAS_GRID } from "@/lib/template-contracts/canvas";

/**
 * The quotation profile's least widths derived from the flow's exported widths (design 2026-11-12
 * §4.1, call 9; since quote canvas PR 2), stated once for the hold in tests/quote-canvas.test.ts (the
 * invoice's tests/helpers/invoice-flow-widths.ts shape): the parties' left inset, their gap and the
 * quote fields' column, and a step; the lines' three numeric column defaults (read from the contract's
 * `column_header` fields, the `"*"` information column left out), the three gaps between the four
 * columns and the information cell's own left margin, and a step; the closing's gap and its signature
 * column, and a step.
 */
export function quoteFlowLeastWidths(): { parties: number; lines: number; closing: number } {
  const W = QUOTE_WIDTHS;
  const columns = QUOTE_CONTRACT.sections.find((s) => s.key === "column_header")!.fields
    .map((f) => f.column?.defaultWidth)
    .filter((w): w is number => typeof w === "number");
  if (columns.length !== 3) throw new Error(`Expected three numeric column defaults, found ${columns.length}.`);
  const numeric = columns.reduce((a, b) => a + b, 0);
  return {
    parties: W.partiesIndent + W.partiesGap + W.quoteFields + CANVAS_GRID,
    lines: numeric + 3 * W.gridGap + W.infoIndent + CANVAS_GRID,
    closing: W.closingGap + W.signature + CANVAS_GRID,
  };
}
