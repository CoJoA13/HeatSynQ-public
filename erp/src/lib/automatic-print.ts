/**
 * Admission for the order hub's automatic traveler print (`?printIntent=` handoff and legacy
 * `?print=1`). A pure leaf so its ordering rules can be replayed run by run in vitest.
 *
 * Nothing is decided until BOTH permission and draft readiness are known (an unresolved permission
 * read never consumes the request). But the draft half is judged ONCE, at its first readiness, and
 * that judgement is kept (#340): a permission read slow enough to span Restore + Discard of a
 * retained traveler-affecting draft otherwise found the drafts gone when it finally answered and
 * printed a request the drafts had refused. A draft-blocked request is consumed as refused, never
 * deferred until the drafts are cleared. Drafts clean at first readiness are judged again by the
 * caller's print gate at decision time, as before.
 *
 * The judgement lives for one component instance (the caller keeps it in a ref). A remount of the
 * order hub starts it afresh; no remount path is reachable inside the defect window today, so a new
 * one is a decision to revisit here.
 */
export type AutomaticPrintState = Readonly<{ handled: boolean; draftsSeen: boolean; draftBlocked: boolean }>;
export type AutomaticPrintInputs = Readonly<{
  /** A handoff key or the legacy flag is present. */
  requested: boolean;
  permissionsReady: boolean;
  /** The browser draft store is bound and identity is confirmed. */
  draftsReady: boolean;
  /** A retained or unsaved traveler-affecting edit exists. Meaningful only when `draftsReady`. */
  draftsBlock: boolean;
}>;
export type AutomaticPrintDecision = "idle" | "wait" | "run" | "refuse";
export const INITIAL_AUTOMATIC_PRINT: AutomaticPrintState = Object.freeze({ handled: false, draftsSeen: false, draftBlocked: false });

export function stepAutomaticPrint(state: AutomaticPrintState, inputs: AutomaticPrintInputs): { state: AutomaticPrintState; decision: AutomaticPrintDecision } {
  if (state.handled || !inputs.requested) return { state, decision: "idle" };
  const judged = inputs.draftsReady && !state.draftsSeen
    ? { ...state, draftsSeen: true, draftBlocked: inputs.draftsBlock } : state;
  if (!inputs.permissionsReady || !inputs.draftsReady) return { state: judged, decision: "wait" };
  return { state: { ...judged, handled: true }, decision: judged.draftBlocked ? "refuse" : "run" };
}
