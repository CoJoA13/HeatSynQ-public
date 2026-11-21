import type { DraftSummary, Owner } from "./draft-store";

/**
 * Narrow views of the draft store's summary (#700). Each keystroke in a recoverable editor
 * publishes a new summary (a new stamp on its row), and a component subscribed to the whole
 * summary renders again for every one. Most subscribers read only the identity (`owner`,
 * `identityReady`) or the draft count, so they subscribe through these selectors instead: each
 * answers the SAME frozen object while the fields it names are unchanged (`owner` is the store's
 * own object until the identity changes), which `useSyncExternalStore` compares by `Object.is` and
 * so renders nothing for the keystroke. The same summary always answers the same object (a
 * `WeakMap`), which `useSyncExternalStore` requires of a snapshot. Pure: no React, no store.
 */
export type DraftIdentity = Readonly<{ owner: Owner | null; identityReady: boolean }>;
export type DraftCount = Readonly<{ owner: Owner | null; identityReady: boolean; count: number }>;

function selector<T extends Record<string, unknown>>(pick: (summary: DraftSummary) => T): (summary: DraftSummary) => Readonly<T> {
  const answered = new WeakMap<DraftSummary, Readonly<T>>();
  let last: Readonly<T> | null = null;
  return (summary) => {
    const known = answered.get(summary);
    if (known) return known;
    const next = pick(summary);
    const kept = last && Object.keys(next).every((key) => Object.is(next[key], last![key])) ? last : Object.freeze(next);
    last = kept; answered.set(summary, kept);
    return kept;
  };
}

export const selectDraftIdentity: (summary: DraftSummary) => DraftIdentity =
  selector((s) => ({ owner: s.owner, identityReady: s.identityReady }));
export const selectDraftCount: (summary: DraftSummary) => DraftCount =
  selector((s) => ({ owner: s.owner, identityReady: s.identityReady, count: s.count }));
