import { describe, expect, it } from "vitest";
import { PLAN_WAIT_FIELD, PLAN_WAIT_MESSAGE, pendingSaveOutcome, saveDecision } from "@/lib/entry-save-wait";

// Ruling R12 (owner 2026-10-22, #662): a Save clicked while New order's load plan is pending no
// longer refuses and jumps to Process & loads. The page sends the preview at once and continues
// the save when it lands; a preview that fails, or an edit that supersedes the identity before it
// lands, ends in the same refusal as before. The decisions live here so vitest can run them (the
// page renders no component under vitest); tests/order-entry-containers.test.tsx pins the page's
// wiring. Mutation: make `saveDecision` answer "refuse" for the plan-wait problem and the first
// case reds; make `pendingSaveOutcome` ignore the identity and the superseded case reds.
const identity = { inputKey: "k1", refreshPlan: 0 };
const other = { inputKey: "k2", refreshPlan: 0 };
const wait = { message: PLAN_WAIT_MESSAGE, tab: "process", fieldId: PLAN_WAIT_FIELD };

describe("saveDecision", () => {
  it("proceeds with no problems", () => {
    expect(saveDecision({ problems: [], availability: "ready", identity, pending: null })).toEqual({ kind: "proceed" });
  });

  it("waits when the only problem is the plan wait and a preview is pending for this identity", () => {
    expect(saveDecision({ problems: [wait], availability: "loading", identity, pending: null })).toEqual({ kind: "wait" });
  });

  it("does not send a second preview for a second click while already waiting on this identity", () => {
    expect(saveDecision({ problems: [wait], availability: "loading", identity, pending: { identity, print: false } }))
      .toEqual({ kind: "already-waiting" });
  });

  it("refuses when the plan is not pending: no input, a failed preview, or any other problem", () => {
    expect(saveDecision({ problems: [wait], availability: "incomplete", identity, pending: null })).toEqual({ kind: "refuse" });
    expect(saveDecision({ problems: [{ ...wait, message: "Could not preview the load plan." }], availability: "error", identity, pending: null }))
      .toEqual({ kind: "refuse" });
    expect(saveDecision({ problems: [{ message: "Pick a customer.", tab: "details", fieldId: "entry-customer" }, wait],
      availability: "loading", identity, pending: null })).toEqual({ kind: "refuse" });
  });

  it("a wait recorded for an older identity does not stand in for this one", () => {
    expect(saveDecision({ problems: [wait], availability: "loading", identity, pending: { identity: other, print: false } }))
      .toEqual({ kind: "wait" });
  });
});

describe("pendingSaveOutcome", () => {
  const pending = { identity, print: false };

  it("keeps waiting while no answer for this identity has landed", () => {
    expect(pendingSaveOutcome(pending, identity, null)).toEqual({ kind: "waiting" });
  });

  it("continues the save once the plan lands", () => {
    expect(pendingSaveOutcome(pending, identity, { preview: { loads: [] }, error: null })).toEqual({ kind: "continue" });
  });

  it("refuses with the preview's own error when it fails", () => {
    expect(pendingSaveOutcome(pending, identity, { preview: null, error: "Could not preview the load plan." }))
      .toEqual({ kind: "failed", error: "Could not preview the load plan." });
  });

  it("refuses as superseded when an edit changed the identity before the answer landed", () => {
    expect(pendingSaveOutcome(pending, other, null)).toEqual({ kind: "superseded" });
    expect(pendingSaveOutcome(pending, other, { preview: { loads: [] }, error: null })).toEqual({ kind: "superseded" });
  });
});
