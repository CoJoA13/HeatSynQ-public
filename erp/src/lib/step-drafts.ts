// The staged re-key behind the process-steps draft adapter (src/lib/process-steps-recovery.ts).
// A pure leaf in src/lib so it can be tested at all: vitest runs "node" with no component renderer
// — the next-sort.ts / permission-ui.ts precedent.
//
// The per-step draft overlays and their helpers went with the per-step save routes (owner ruling
// 2026-09-26: the process-document save is the only write path). The editor now drafts the whole
// ordered document; what remains here is the one piece a revision cut still needs.

/**
 * A cut's re-keying, held until the rows it belongs to are actually on screen.
 *
 * THE INVARIANT (#288): a draft must always be keyed in the key space the RENDERED rows use. A
 * recipe-number save that cuts a revision answers with the new mapping a full round trip before the
 * reload that renumbers the rows, so re-keying on arrival left the draft and the rendered rows
 * disagreeing about what a step is called for the whole window. Every draft went invisible, a
 * keystroke landed under a pre-cut id nothing would ever reach again, and the section read dirty on
 * a page the user had not touched. So the mapping is STAGED here and applied at the landing instead
 * (`processStepsLand`, which re-keys the ordered draft rows in the same commit that installs them).
 *
 * `toRevision` is what makes the landing unambiguous: a detail load can be for a revision the
 * picker moved to rather than the one the save produced, and applying a cut's mapping to the wrong
 * revision's rows would recreate the very mismatch this exists to prevent. A staged mapping
 * therefore waits — it is not discarded — until its own revision lands, which is what makes a
 * detour through an older revision and back harmless.
 */
export type PendingRekey = { toRevision: number; map: Record<string, string> } | null;

/**
 * Record a save's mapping against the revision it produced, composing with anything already
 * waiting. An EMPTY mapping means no cut happened and stages nothing.
 *
 * Composition matters because the ids move twice: a mapping already staged points at the previous
 * cut's ids, so each of its values is forwarded through the new mapping before the new entries are
 * merged in. Without that, a draft two cuts behind resolves to a revision that no longer exists.
 */
export function stagePendingRekey(
  pending: PendingRekey, toRevision: number, map: Record<string, string>,
): PendingRekey {
  if (Object.keys(map).length === 0) return pending;
  if (pending === null) return { toRevision, map };
  const composed: Record<string, string> = {};
  for (const [from, to] of Object.entries(pending.map)) composed[from] = map[to] ?? to;
  return { toRevision, map: { ...composed, ...map } };
}
