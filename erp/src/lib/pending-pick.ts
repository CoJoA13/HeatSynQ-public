// A choice a control has sent and whose re-read has not landed yet (#677). Pure and client-safe.
//
// A select or checkbox bound only to server state snaps back the moment its change event ends and
// shows the operator's choice only once the write and the re-read after it have both landed. While
// they are out, the control shows the pick instead. Each pick carries the number of the write it
// belongs to, so the re-read after an earlier write cannot clear a later pick that is still out:
// only the settling of a pick's own write clears it, landed or failed (a failed write's rollback
// read, or that read failing too, settles it as well).

export type PendingPick<V> = { value: V; seq: number };
export type PendingPicks<V> = Readonly<Record<string, PendingPick<V>>>;

/** What a control shows: its pick while one is out, the server's value otherwise. */
export function shownValue<V>(pick: PendingPick<V> | undefined, server: V): V {
  return pick === undefined ? server : pick.value;
}

/** `picks` with `key`'s pick added for the write numbered `seq`. */
export function withPick<V>(picks: PendingPicks<V>, key: string, value: V, seq: number): PendingPicks<V> {
  return { ...picks, [key]: { value, seq } };
}

/** `picks` without `key`'s pick when it is still the pick of the write numbered `seq` that settled;
 *  `picks` itself when a later pick of that key has replaced it, or none is held. */
export function withoutSettledPick<V>(picks: PendingPicks<V>, key: string, seq: number): PendingPicks<V> {
  if (picks[key]?.seq !== seq) return picks;
  const next = { ...picks };
  delete next[key];
  return next;
}
