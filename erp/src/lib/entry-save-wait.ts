// New order's Save while the load plan is pending (ruling R12, owner 2026-10-22; #662).
//
// Every change to Qty, Net weight, the lead part or a load cap makes a new preview identity; the
// plan is null until the preview POST, sent 250 ms after typing stops, answers. A Save clicked in
// that window used to be refused with "Wait for a current load plan before saving." and moved the
// operator to Process & loads. Under R12 the page sends the preview at once and continues the
// save when it lands; a preview that fails, or an edit that supersedes the identity before the
// answer lands, ends in the same refusal as before. The two decisions are here, pure, so vitest can
// run them (the page renders no component under vitest); the page's wiring is pinned by
// tests/order-entry-containers.test.tsx.

/** The plan-wait problem `validate` adds when nothing else is refused and no plan is current. */
export const PLAN_WAIT_FIELD = "entry-refresh-plan";
export const PLAN_WAIT_MESSAGE = "Wait for a current load plan before saving.";

/** A save waiting on the preview of one identity; `print` is Save & Print's. */
export type PendingSave<I> = { identity: I; print: boolean };

export type SaveDecision = { kind: "proceed" | "refuse" | "wait" | "already-waiting" };

/**
 * What Save does with `validate`'s problems. "wait" only when the one problem is the plan wait
 * itself (never a failed preview's own sentence, which carries the same field), a preview is
 * pending for the current identity (`availability` is "loading"), and no save is already waiting
 * on it: a second click while waiting must not send a second preview ("already-waiting").
 */
export function saveDecision<I>(args: {
  problems: readonly { message: string; fieldId: string }[];
  availability: string;
  identity: I;
  pending: PendingSave<I> | null;
}): SaveDecision {
  const { problems, availability, identity, pending } = args;
  if (problems.length === 0) return { kind: "proceed" };
  const onlyPlanWait = problems.length === 1 && problems[0].fieldId === PLAN_WAIT_FIELD && problems[0].message === PLAN_WAIT_MESSAGE;
  if (!onlyPlanWait || availability !== "loading") return { kind: "refuse" };
  if (pending !== null && pending.identity === identity) return { kind: "already-waiting" };
  return { kind: "wait" };
}

export type PendingSaveOutcome =
  | { kind: "waiting" }
  | { kind: "continue" }
  | { kind: "failed"; error: string }
  | { kind: "superseded" };

/**
 * Once the plan state moves, what a waiting save does: the identity the page now holds decides
 * first (an edit superseded the wait), then the preview answer for the identity waited on.
 * `state` is the page's current plan state for `identity`, or null while none has landed.
 */
export function pendingSaveOutcome<I>(
  pending: PendingSave<I>, identity: I, state: { preview: unknown; error: string | null } | null,
): PendingSaveOutcome {
  if (identity !== pending.identity) return { kind: "superseded" };
  if (state === null) return { kind: "waiting" };
  if (state.error !== null) return { kind: "failed", error: state.error };
  if (state.preview) return { kind: "continue" };
  return { kind: "waiting" };
}
