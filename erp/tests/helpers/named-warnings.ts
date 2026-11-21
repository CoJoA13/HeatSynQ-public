import type { CanvasWarning } from "@/lib/template-canvas";
import type { CanvasItem, CanvasLayout } from "@/lib/template-contracts/canvas";

/**
 * The warnings a layout draws, read by item: a field, wording or block by its key, a Line by its place
 * among the layout's Lines (`line 1`, …), any other item by its kind; each sentence with a static
 * item's random id replaced by that name (a static item's sentence names it `(kind id)`, every other
 * item names no id). Read by tests/template-canvas-seed.test.ts and tests/statement-canvas-seed.test.ts,
 * whose seeded layouts carry random ids.
 */
export function namedWarnings(layout: CanvasLayout, warnings: CanvasWarning[]) {
  const lines = layout.items.filter((i) => i.kind === "line");
  const name = (item: CanvasItem) =>
    item.kind === "field" || item.kind === "textBlock" || item.kind === "table" ? item.key
      : item.kind === "line" ? `line ${lines.indexOf(item) + 1}` : item.kind;
  const byId = new Map(layout.items.map((i) => [i.id, i]));
  return warnings.map((w) => ({
    items: w.itemIds.map((id) => name(byId.get(id)!)),
    sentence: layout.items.reduce((text, item) => text.replaceAll(`(${item.kind} ${item.id})`, `(${name(item)})`), w.sentence),
  }));
}
