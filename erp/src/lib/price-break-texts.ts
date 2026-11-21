// The part page's Pricing section: what the user has typed into a saved price break's Threshold
// or Price box but not yet blurred (#652). A break's cells are nested inside their price row, and
// the edit guard's keyed variant (`applyRows`) is flat, so a reload landing through it would put
// the stored figure back under the cursor of a break cell. The section therefore keeps a break's
// typed text here, keyed by the break's id and field, and composes it with the row's own figure at
// render (the admin surcharges page's `textDrafts` shape): the rows carry only what the server
// holds plus a save's optimistic patch, and no reload reaches this map. The row money boxes, which
// are flat, register with the guard instead.
//
// The keys are break ids, the key space the rendered rows use (#288), and the pruner is asked on
// every landed payload: an entry whose break the payload no longer lists would otherwise render
// over a break that re-enters under the same id. A pure leaf so the decisions are mutation-proven
// (the `break-drafts.ts` precedent); the setState calls stay in the component.

export type BreakTextField = "threshold" | "price";

/** Typed-but-unblurred text per saved break cell, keyed by `breakTextKey`. */
export type BreakTexts = Readonly<Record<string, string>>;

export const breakTextKey = (breakId: string, field: BreakTextField): string => `${breakId}.${field}`;

const SEPARATOR = ".";

/** The map without the entries of any break `liveBreakIds` does not list; the same map when
 *  nothing is dropped, so a landed payload that changed no break re-renders nothing for it. */
export function retainBreakTexts(cur: BreakTexts, liveBreakIds: Iterable<string>): BreakTexts {
  const live = new Set(liveBreakIds);
  const kept = Object.entries(cur).filter(([key]) => live.has(key.slice(0, key.lastIndexOf(SEPARATOR))));
  return kept.length === Object.keys(cur).length ? cur : Object.fromEntries(kept);
}

/** The map without one cell's text: asked at that cell's blur, whatever the blur then does. */
export function withoutBreakText(cur: BreakTexts, key: string): BreakTexts {
  const { [key]: dropped, ...rest } = cur;
  void dropped;
  return rest;
}
