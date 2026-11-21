// The shipping ticket's totals block and tear-off strip, read off one sheet of a builder's
// definition, and ticket rows for the weights examples. Shared by tests/shipping-ticket.test.ts
// and tests/shipping-ticket-templates.test.ts. `stripBlock` is the strip's own node, which carries
// the id the renderer measures it by only where the builder gives it one.
//
// Not named `*.test.ts`, so it is type-checked and linted but vitest never runs it as a suite.
import type { TicketContainer, TicketLine } from "@/server/pdf/shipping-ticket";
import { cellTexts, findNodes } from "./definition-text";

type Node = Record<string, unknown>;
const isTable = (n: Node): boolean => typeof n.table === "object" && n.table !== null;
const rowsOf = (node: Node): string[][] =>
  (node.table as { body: unknown[][] }).body.map((row) => row.map((cell) => cellTexts(cell).join("\n")));
function only(found: Node[], what: string): Node | undefined {
  if (found.length > 1) throw new Error(`${found.length} ${what} on one sheet`);
  return found[0];
}
/** A sheet's unbreakable nodes are its totals block and its tear-off strip. The strip is the one
 *  whose stack opens with its rule, a canvas. */
const isStrip = (n: Node): boolean => n.unbreakable === true && Array.isArray(n.stack)
  && typeof n.stack[0] === "object" && n.stack[0] !== null && "canvas" in n.stack[0];

/** The totals block's node on one sheet: the unbreakable node that is not the strip. undefined
 *  when the sheet has none. */
export function totalsBlock(sheet: unknown): Node | undefined {
  return only(findNodes(sheet, (n) => n.unbreakable === true && !isStrip(n)), "totals blocks");
}
/** The totals block's table node on one sheet. undefined when the block draws no table. */
export function totalsTable(sheet: unknown): Node | undefined {
  return only(findNodes(sheet, (n) => n.layout === "noBorders" && isTable(n)), "totals tables");
}
/** The totals block's rows, top first, each as [label, figure]. [] when it draws no table. */
export function totalsRows(sheet: unknown): string[][] {
  const table = totalsTable(sheet);
  return table === undefined ? [] : rowsOf(table);
}
/** The tear-off strip's own node on one sheet: the unbreakable stack that opens with its rule.
 *  Throws when the sheet has no strip. */
export function stripBlock(sheet: unknown): Node {
  const strip = only(findNodes(sheet, isStrip), "tear-off strips");
  if (strip === undefined) throw new Error("no tear-off strip on the sheet");
  return strip;
}
/** The tear-off strip's boxed table node on one sheet. undefined when the strip has no boxed row.
 *  Throws when the sheet has no strip, so the two are never one answer. */
export function stripTable(sheet: unknown): Node | undefined {
  return only(findNodes(stripBlock(sheet), isTable), "tables in the strip");
}
/** The tear-off strip's boxed rows, top first, each as [label, figure]. [] when the strip has no
 *  boxed row. Throws when the sheet has no strip. */
export function stripRows(sheet: unknown): string[][] {
  const table = stripTable(sheet);
  return table === undefined ? [] : rowsOf(table);
}
/** One part line for each net weight. */
export const linesOf = (pounds: readonly number[]): TicketLine[] => pounds.map((weight, i) => (
  { qty: 150, partNumber: `W-${i + 1}`, partName: "Weights example", partDescription: "", pounds: weight }));
/** One container row as the ticket's builder reads it. */
export const bin = (count: number, tareEach: number | null): TicketContainer =>
  ({ typeName: "Steel Basket", count, customerContainerId: "", tareEach });
