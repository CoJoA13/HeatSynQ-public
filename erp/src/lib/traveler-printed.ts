// Client-safe and pure: the order hub's one rule for `travelerPrinted` when a whole order from the
// server replaces the page's (#550, owner ruling 2 of 2026-10-18). Both of the hub's applies read
// it inside their state updater: `load`'s, after a read of the order, and `applyMutation`'s, after a
// write's answer (Codex MR !141 round 5 first kept the flag there).
//
// The flag is "the order has a stored traveler" (`toDetail` in src/server/order-internals.ts), and
// stored documents never delete (spec §5.6), so it only ever goes false to true. A traveler print is
// not an `applyMutation` write: `onPrinted` sets the page's flag true locally. A read or an answer
// computed before that print committed, landing after it, still says false, and applied whole it
// cleared the traveler-printed banner until the next payload. Keeping a local true is exact under
// every ordering of answers.
//
// The rule is the page's alone. The bulk grids' recovery read is handed the server's order itself,
// flag included.

/** `next`, unless the page holds true and `next` says false: then a copy of `next` saying true.
 *  `next` itself in every other case, never written into. */
export function keepTravelerPrinted<T extends { travelerPrinted: boolean }>(
  prev: { travelerPrinted: boolean } | null, next: T,
): T {
  return prev?.travelerPrinted && !next.travelerPrinted ? { ...next, travelerPrinted: true } : next;
}
