// The capture tool's choice among candidates (e2e/lib/manual-ids.ts), in a file with no import, so
// that a test can load it. manual-ids.ts cannot be loaded by one: as it loads it refuses every
// database but one named erp on this machine, and runs its command. tests/manual-pick.test.ts runs
// this file.

/** What one dynamic route's chosen example looks like on the way back out. `label` is what the
 *  sweep report prints so a reader can tell WHICH row was photographed; `why` records the
 *  richness that won it the pick, so a thin capture is visible in the report rather than silent. */
export type Pick = { id: string; label: string; why: string; data?: Record<string, string> } | null;

/** Higher score wins. Equal scores go to the earlier candidate, unless `takesTie(candidate, best)`
 *  answers true for the later one. An empty list gives null. */
export function pick<T>(
  rows: T[],
  score: (row: T) => number,
  describe: (row: T) => { label: string; why: string; data?: Record<string, string> },
  takesTie?: (candidate: T, best: T) => boolean,
): Pick {
  let best: T | undefined;
  let bestScore = -Infinity;
  for (const row of rows) {
    const s = score(row);
    if (s > bestScore || (best !== undefined && s === bestScore && takesTie?.(row, best) === true)) {
      best = row;
      bestScore = s;
    }
  }
  if (best === undefined) return null;
  const { label, why, data } = describe(best);
  return { id: (best as { id: string }).id, label, why, ...(data ? { data } : {}) };
}

/** The saved order's rule: of two orders with equal scores, the lower order number. */
export function lowerOrderNumber(candidate: { orderNumber: number }, best: { orderNumber: number }): boolean {
  return candidate.orderNumber < best.orderNumber;
}
