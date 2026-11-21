/**
 * A canvas table block's document children, read in the one canvas block shape (#969; `drawnBlock`,
 * `canvas-sheet.ts`; `canvasBlockOf`, `canvas-nodes.ts`), so a test reading what a document's
 * `tableBlock` put inside its block need not walk the shape: the inner node's stack when it is a
 * plain `{ stack, margin }`, else the inner node alone.
 */
import { canvasBlockOf } from "@/server/pdf/canvas-nodes";
import { CANVAS_IDS } from "@/server/pdf/canvas-sheet";
import type { CanvasTableKey } from "@/lib/template-contracts/canvas";

/** The node under `id` in `node`, depth first, or undefined. */
function findById(node: unknown, id: string): Record<string, unknown> | undefined {
  if (node === null || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findById(item, id);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const o = node as Record<string, unknown>;
  if (o.id === id) return o;
  for (const value of Object.values(o)) {
    const found = findById(value, id);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The document children of the block `key` in `def`'s content. Throws when no node carries the
 *  block's id, or the node under it is not the block shape. */
export function blockItems(def: unknown, key: string): unknown[] {
  const id = CANVAS_IDS.table(key as CanvasTableKey);
  const content = def !== null && typeof def === "object" ? (def as { content?: unknown }).content : undefined;
  const node = findById(content, id);
  if (node === undefined) throw new Error(`no node under ${id}`);
  // pdfmake writes its own keys (`positions`, `_margin`, …) onto the nodes it lays out, so a block it
  // laid out no longer reads as the block shape.
  if ("positions" in node) throw new Error(`${id}: a laid-out definition; read the one the builder answered`);
  const block = canvasBlockOf(node);
  if (block !== null) return block.items ?? [block.inner];
  throw new Error(`${id}: not the canvas block shape`);
}
