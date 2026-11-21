import { INVOICE_WIDTHS } from "@/server/pdf/invoice";
import { MEASURED_ROW_FLOOR } from "@/server/pdf/render";
import { CANVAS_GRID } from "@/lib/template-contracts/canvas";

/**
 * The invoice profile's least widths derived from the flow's exported widths (design 2026-11-10
 * §4.1, call 11), stated once for the hold in tests/invoice-canvas.test.ts and the resize floors in
 * tests/canvas-designer.test.ts: the addresses' two "*" columns each keep the first one's indent and
 * a grid step, with the gap between them; the parts' and prices' fixed columns, the three gaps
 * between the four columns and the information cell's own left margin, and a step; the totals'
 * label, amount and two gaps, and a step; the order strip's indent past the Quantity column, #590's
 * floor and a step.
 */
export function flowLeastWidths(): Record<string, number> {
  const W = INVOICE_WIDTHS;
  const grid = W.qty + W.each + W.amt + 3 * W.gridGap + W.infoMargin + CANVAS_GRID;
  return {
    parties: 2 * (W.partiesIndent + CANVAS_GRID) + W.partiesGap,
    order_strip: W.qty + W.stripIndentGap + MEASURED_ROW_FLOOR + CANVAS_GRID,
    parts: grid,
    price: grid,
    totals: W.totalsLabel + W.amt + 2 * W.totalsGap + CANVAS_GRID,
  };
}
