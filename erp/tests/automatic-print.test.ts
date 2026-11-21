import { describe, expect, it } from "vitest";
import { INITIAL_AUTOMATIC_PRINT, stepAutomaticPrint, type AutomaticPrintInputs, type AutomaticPrintState } from "@/lib/automatic-print";

/** Replays one effect run per input, the way the order hub's automatic-print effect does. */
function replay(runs: AutomaticPrintInputs[]) {
  let state: AutomaticPrintState = INITIAL_AUTOMATIC_PRINT;
  return runs.map(inputs => {
    const step = stepAutomaticPrint(state, inputs);
    state = step.state;
    return step.decision;
  });
}
const base: AutomaticPrintInputs = { requested: true, permissionsReady: false, draftsReady: false, draftsBlock: false };

describe("automatic traveler print admission (#340)", () => {
  it("does nothing without a request", () => {
    expect(replay([{ ...base, requested: false, permissionsReady: true, draftsReady: true }])).toEqual(["idle"]);
  });

  it("waits for both permission and draft readiness, then runs once", () => {
    expect(replay([
      base,
      { ...base, permissionsReady: true },
      { ...base, permissionsReady: true, draftsReady: true },
      { ...base, permissionsReady: true, draftsReady: true },
    ])).toEqual(["wait", "wait", "run", "idle"]);
  });

  it("refuses when retained drafts block at the moment both are ready", () => {
    expect(replay([
      { ...base, permissionsReady: true, draftsReady: true, draftsBlock: true },
      { ...base, permissionsReady: true, draftsReady: true, draftsBlock: false },
    ])).toEqual(["refuse", "idle"]);
  });

  it("never defers a draft-blocked request until the drafts are discarded, however late permissions land", () => {
    // Drafts are known to block while permissions are still unresolved. The operator restores and
    // discards the retained edits; only then does the permission read answer. The request was
    // refused by the drafts, so it must be consumed as refused, never printed.
    expect(replay([
      { ...base, draftsReady: true, draftsBlock: true },
      { ...base, draftsReady: true, draftsBlock: false },
      { ...base, permissionsReady: true, draftsReady: true, draftsBlock: false },
    ])).toEqual(["wait", "wait", "refuse"]);
  });

  it("judges drafts at their first readiness only, so later edits and saves keep today's gate behaviour", () => {
    // Clean at first readiness: a later unsaved edit (then saved) before permissions land is left
    // to the print gate and admission re-check exactly as before.
    expect(replay([
      { ...base, draftsReady: true, draftsBlock: false },
      { ...base, draftsReady: true, draftsBlock: true },
      { ...base, permissionsReady: true, draftsReady: true, draftsBlock: false },
    ])).toEqual(["wait", "wait", "run"]);
  });

  it("keeps the first draft judgement when identity is re-checked before permissions land", () => {
    expect(replay([
      { ...base, draftsReady: true, draftsBlock: true },
      { ...base, draftsReady: false },
      { ...base, draftsReady: true, draftsBlock: false },
      { ...base, permissionsReady: true, draftsReady: true, draftsBlock: false },
    ])).toEqual(["wait", "wait", "wait", "refuse"]);
  });

  it("does not judge drafts while no request is present, even if they are ready", () => {
    // A request appearing only after drafts are ready is judged against the drafts at that point.
    expect(replay([
      { ...base, requested: false, draftsReady: true, draftsBlock: true },
      { ...base, requested: true, permissionsReady: true, draftsReady: true, draftsBlock: false },
    ])).toEqual(["idle", "run"]);
  });

  it("does not judge drafts before they are ready", () => {
    // A block reported while drafts are unknown is not a readiness observation.
    expect(replay([
      { ...base, draftsReady: false, draftsBlock: true },
      { ...base, permissionsReady: true, draftsReady: true, draftsBlock: false },
    ])).toEqual(["wait", "run"]);
  });
});
