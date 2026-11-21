// A header select-all checkbox's two halves, as a dependency-free leaf (#239 C9a) — the
// `src/lib/` pure-leaf convention this repo uses for any decision that has to be mutation-proven,
// because vitest here runs `environment: "node"` with no component renderer, so a rule written
// inline in a `"use client"` table cannot be tested at all (the `step-drafts.ts` / `break-drafts.ts`
// reasoning, CLAUDE.md).
//
// The load-bearing property is the SAME one at both halves and it is about the rows the header does
// NOT govern: a selection may legitimately hold keys that are not selectable on this page — a row
// whose checkbox is disabled, or a tick the caller deliberately keeps across a reload it could not
// reconcile (InvoicingList's post-run prune keeps exactly such a set when the candidates reload
// failed). Those keys must neither be REPORTED on (a foreign tick must not make an untouched page
// read "some") nor WRITTEN to (select-all must not tick a row the operator cannot tick, and
// select-none must not silently clear something the header never showed). So `selectAllState`
// reads only the intersection and `applySelectAll` is a union/difference over the selectable keys
// alone, never a wholesale replace.

/** `"all"` renders a ticked box, `"none"` an empty one, `"some"` the indeterminate dash. */
export type SelectAllState = "all" | "none" | "some";

/**
 * What the header box shows for `selectable` given `selected`.
 *
 * An EMPTY `selectable` is `"none"`, never `"all"`: `every()` is vacuously true on an empty list,
 * and a ticked header above a table with nothing to tick claims a selection that does not exist.
 * (Callers disable the box in that state; this answer is what it shows while disabled.)
 */
export function selectAllState(
  selectable: readonly string[], selected: ReadonlySet<string>,
): SelectAllState {
  let ticked = 0;
  for (const key of selectable) if (selected.has(key)) ticked += 1;
  if (ticked === 0) return "none";
  return ticked === selectable.length ? "all" : "some";
}

/**
 * The selection after the header box is toggled to `checked`.
 *
 * Returns a NEW set every time — `selected` is React state and an updater that mutated its previous
 * value would be a bug independent of anything here (the `patchAdded`/`appendRows` rule in
 * bulk-grid.ts). Keys outside `selectable` are carried through untouched in both directions.
 */
export function applySelectAll(
  selected: ReadonlySet<string>, selectable: readonly string[], checked: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const key of selectable) {
    if (checked) next.add(key); else next.delete(key);
  }
  return next;
}
