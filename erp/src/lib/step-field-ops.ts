// The step-codes page's three suggestion edits, each a transform over the field set as it stands
// when the queued op RUNS (#650). The page chains every save behind the previous one's reload, so
// the array a transform is handed is fresh; what was stale was the RENDER INDEX the callers
// captured at click. With [A, B, C, D, E], remove on C then on D before the first PUT and its
// reload landed filtered index 3 out of [A, B, D, E]: E went, D stayed. Each transform here finds
// its row by `id`, which `listStepCodes` gives every suggestion; an id the fresh array no longer
// holds answers `null`, the queue's existing no-op. In `src/lib` so the page's tests, which render
// with `renderToStaticMarkup` and run no queue, can prove the decisions from a pure module (the
// `break-drafts.ts` precedent). `swapAt` stays index-based: the move finds the row's current index.
import { swapAt } from "./reorder";

type WithId = { id?: string };

/** The array without the row whose id is `id`; `null` when no row has it. */
export function removeFieldById<F extends WithId>(fields: readonly F[], id: string): F[] | null {
  if (!fields.some((f) => f.id === id)) return null;
  return fields.filter((f) => f.id !== id);
}

/** The array with the row whose id is `id` swapped with its neighbour in `direction`; `null` when
 *  no row has it or it is already at that end (the controls are disabled there: belt and braces). */
export function moveFieldById<F extends WithId>(fields: readonly F[], id: string, direction: -1 | 1): F[] | null {
  const index = fields.findIndex((f) => f.id === id);
  if (index < 0) return null;
  return swapAt(fields, index, direction);
}

/** The array with the row whose id is `id` relabelled; `null` when no row has it. */
export function relabelFieldById<F extends WithId & { label: string }>(
  fields: readonly F[], id: string, label: string,
): F[] | null {
  if (!fields.some((f) => f.id === id)) return null;
  return fields.map((f) => (f.id === id ? { ...f, label } : f));
}

/** A suggestion label's draft and focus-note key: the code and the suggestion's id, so the draft
 *  and the rendered row (keyed by the same id) share one key space (#288). A reload that reorders
 *  the rows mid-typing then keeps the typed text in the row it was typed into. */
export const fieldLabelDraftKey = (codeId: string, fieldId: string): string => `${codeId}.${fieldId}.label`;
