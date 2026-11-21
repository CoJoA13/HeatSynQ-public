import { describe, expect, it } from "vitest";
import {
  UNDO_WINDOW_MS, offerUndo, expireUndo, stepFromCode, removeStepAt, undoRemove, replaceStepAt,
  addParameter, updateParameter, removeParameter, focusAfterAdd, emptyParameters, orderCountLabel, lockedRevisionNote,
  type RemovedStep,
} from "../src/lib/process-table";
import type { ProcessDraftStep, ProcessParameterInput } from "../src/lib/process-document";
import type { ProcessEditorCode } from "../src/lib/process-editor-catalog";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.getOwnPropertyNames(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

const parameter = (key: string, label: string, type: ProcessParameterInput["type"], unit: string | null, value: string): ProcessParameterInput =>
  ({ key, label, type, unit, value });

const draftStep = (clientId: string, overrides: Partial<ProcessDraftStep> = {}): ProcessDraftStep =>
  deepFreeze({ clientId, stepId: clientId, codeId: "HT", instruction: "Hold", parameters: [], ...overrides });

const editorCode = (overrides: Partial<ProcessEditorCode> = {}): ProcessEditorCode => deepFreeze({
  id: "HT", code: "HT", name: "Heat", active: true, defaultInstruction: "Hold at heat.",
  fields: [
    { id: "f-temp", label: "Temperature", type: "NUMBER", unit: "F", sort: 1 },
    { id: "f-note", label: "Note", type: "TEXT", unit: null, sort: 2 },
  ],
  ...overrides,
});

describe("UNDO_WINDOW_MS", () => {
  it("is 15 seconds", () => {
    expect(UNDO_WINDOW_MS).toBe(15_000);
  });
});

describe("stepFromCode", () => {
  it("copies the default instruction and the suggestions, keyed by suggestion id, with empty values", () => {
    const result = stepFromCode(editorCode(), "new:client-1");
    expect(result).toEqual({
      clientId: "new:client-1", stepId: null, codeId: "HT", instruction: "Hold at heat.",
      parameters: [
        { key: "f-temp", label: "Temperature", type: "NUMBER", unit: "F", value: "" },
        { key: "f-note", label: "Note", type: "TEXT", unit: null, value: "" },
      ],
    });
  });
});

describe("removeStepAt / undoRemove", () => {
  it("removes the step at index; undo restores the identical object at the same index when it still fits", () => {
    const steps = deepFreeze([draftStep("a"), draftStep("b"), draftStep("c")]);
    const { steps: after, removed } = removeStepAt(steps, 1);
    expect(after.map(s => s.clientId)).toEqual(["a", "c"]);
    expect(removed).toEqual({ step: steps[1], index: 1 });
    const restored = undoRemove(after, removed);
    expect(restored.map(s => s.clientId)).toEqual(["a", "b", "c"]);
    expect(restored[1]).toBe(steps[1]); // the identical object, not a rebuilt copy
  });

  it("is a no-op when a step of that identity is already present", () => {
    const steps = deepFreeze([draftStep("a"), draftStep("b"), draftStep("c")]);
    const { steps: after, removed } = removeStepAt(steps, 1);
    const restoredOnce = deepFreeze(undoRemove(after, removed));
    const restoredTwice = undoRemove(restoredOnce, removed); // "b" is already there
    expect(restoredTwice.map(s => s.clientId)).toEqual(["a", "b", "c"]);
    expect(restoredTwice).toEqual(restoredOnce);
  });

  it("clamps to the end once the list has shrunk past the removed index (a later removal, not an insertion)", () => {
    // An insertion only ever makes the list LONGER, so it can never exercise the clamp
    // (pre-flight T7-1): `Math.min(removed.index, steps.length)` only differs from `removed.index`
    // once the list is shorter than it was at removal time.
    const steps = deepFreeze([draftStep("a"), draftStep("b"), draftStep("c")]);
    const { steps: afterFirst, removed: removedC } = removeStepAt(steps, 2); // removedC.index === 2
    const { steps: afterSecond } = removeStepAt(deepFreeze(afterFirst), 1); // now just ["a"]
    expect(afterSecond.map(s => s.clientId)).toEqual(["a"]);
    const restored = undoRemove(afterSecond, removedC); // 2 > length 1: clamp to the end
    expect(restored.map(s => s.clientId)).toEqual(["a", "c"]);
  });
});

describe("replaceStepAt", () => {
  it("replaces only the step at index, leaving the others as the same objects", () => {
    const steps = deepFreeze([draftStep("a"), draftStep("b"), draftStep("c")]);
    const replacement = draftStep("b", { instruction: "Changed" });
    const result = replaceStepAt(steps, 1, replacement);
    expect(result.map(s => s.clientId)).toEqual(["a", "b", "c"]);
    expect(result[1]).toBe(replacement);
    expect(result[0]).toBe(steps[0]);
    expect(result[2]).toBe(steps[2]);
  });
});

describe("addParameter", () => {
  it('appends { key: provisionalKey, label: "", type: "TEXT", unit: null, value: "" }', () => {
    const base = draftStep("a", { parameters: [parameter("f-temp", "Temperature", "NUMBER", "F", "1500")] });
    const result = addParameter(base, "new:11111111-1111-4111-8111-111111111111");
    expect(result.parameters).toEqual([
      { key: "f-temp", label: "Temperature", type: "NUMBER", unit: "F", value: "1500" },
      { key: "new:11111111-1111-4111-8111-111111111111", label: "", type: "TEXT", unit: null, value: "" },
    ]);
    expect(result.parameters[0]).toBe(base.parameters[0]); // untouched original row, same reference
  });
});

describe("updateParameter", () => {
  it("patches label, unit or value while leaving the key and type untouched", () => {
    const base = draftStep("a", { parameters: [parameter("f-temp", "Temperature", "NUMBER", "F", "1500")] });
    const relabelled = updateParameter(base, 0, { label: "Furnace temperature" });
    expect(relabelled.parameters[0]).toEqual({ key: "f-temp", label: "Furnace temperature", type: "NUMBER", unit: "F", value: "1500" });
    const reunited = updateParameter(deepFreeze(relabelled), 0, { unit: "C", value: "1520" });
    expect(reunited.parameters[0]).toEqual({ key: "f-temp", label: "Furnace temperature", type: "NUMBER", unit: "C", value: "1520" });
  });

  it("leaves every other row as the same object", () => {
    const base = draftStep("a", { parameters: [parameter("p1", "A", "TEXT", null, "1"), parameter("p2", "B", "TEXT", null, "2")] });
    const result = updateParameter(base, 1, { value: "changed" });
    expect(result.parameters[0]).toBe(base.parameters[0]);
    expect(result.parameters[1]).toEqual({ key: "p2", label: "B", type: "TEXT", unit: null, value: "changed" });
  });
});

describe("removeParameter", () => {
  it("removes the row at index, leaving the others in order", () => {
    const base = draftStep("a", { parameters: [
      parameter("p1", "A", "TEXT", null, "1"), parameter("p2", "B", "TEXT", null, "2"), parameter("p3", "C", "TEXT", null, "3"),
    ] });
    const result = removeParameter(base, 1);
    expect(result.parameters.map(p => p.key)).toEqual(["p1", "p3"]);
  });
});

describe("focusAfterAdd", () => {
  it("returns the first parameter whose trimmed value is empty", () => {
    const s = draftStep("a", { parameters: [
      parameter("p1", "A", "TEXT", null, "filled"),
      parameter("p2", "B", "TEXT", null, "   "),
      parameter("p3", "C", "TEXT", null, ""),
    ] });
    expect(focusAfterAdd(s)).toEqual({ kind: "parameter", index: 1 });
  });

  it("returns the instruction once every parameter already has a value", () => {
    const s = draftStep("a", { parameters: [parameter("p1", "A", "TEXT", null, "filled")] });
    expect(focusAfterAdd(s)).toEqual({ kind: "instruction" });
  });

  it("returns the instruction when there are no parameters at all", () => {
    expect(focusAfterAdd(draftStep("a"))).toEqual({ kind: "instruction" });
  });
});

describe("emptyParameters", () => {
  it("marks empty and whitespace-only values, leaving filled ones alone", () => {
    const s = draftStep("a", { parameters: [
      parameter("p1", "A", "TEXT", null, "filled"),
      parameter("p2", "B", "TEXT", null, "   "),
      parameter("p3", "C", "TEXT", null, ""),
    ] });
    expect(emptyParameters(s)).toEqual([false, true, true]);
  });
});

describe("offerUndo / expireUndo", () => {
  it("a later removal's offer survives its predecessor's timer, and is cleared only by its own token", () => {
    const removedA: RemovedStep = deepFreeze({ step: draftStep("a"), index: 0 });
    const removedB: RemovedStep = deepFreeze({ step: draftStep("b"), index: 1 });
    const first = offerUndo(null, removedA);
    expect(first).toEqual({ removed: removedA, token: 1 });
    // A second removal inside the first offer's 15s window replaces the bar with its own offer.
    const second = offerUndo(first, removedB);
    expect(second).toEqual({ removed: removedB, token: 2 });
    // The FIRST timer fires late and names its own (now stale) token: the second offer is untouched.
    expect(expireUndo(second, first.token)).toEqual(second);
    // Expiring with the CURRENT token clears it.
    expect(expireUndo(second, second.token)).toBeNull();
  });

  it("clearing an already-empty offer is a no-op", () => {
    expect(expireUndo(null, 1)).toBeNull();
  });
});

describe("purity: no function mutates its frozen inputs", () => {
  it("runs every operation against deep-frozen fixtures without throwing, and leaves them unchanged", () => {
    const steps = deepFreeze([draftStep("a"), draftStep("b", { parameters: [parameter("p1", "A", "TEXT", null, "")] })]);
    const code = editorCode();
    const removedFixture: RemovedStep = deepFreeze({ step: draftStep("c"), index: 0 });

    expect(() => {
      stepFromCode(code, "new:x");
      const { steps: after, removed } = removeStepAt(steps, 0);
      undoRemove(deepFreeze(after), removed);
      replaceStepAt(steps, 0, draftStep("z"));
      addParameter(steps[1], "new:y");
      updateParameter(steps[1], 0, { value: "1" });
      removeParameter(steps[1], 0);
      focusAfterAdd(steps[1]);
      emptyParameters(steps[1]);
      offerUndo(null, removedFixture);
      expireUndo(offerUndo(null, removedFixture), 999);
    }).not.toThrow();

    // The frozen fixtures still look exactly as they did before any of the above ran.
    expect(steps).toEqual([draftStep("a"), draftStep("b", { parameters: [parameter("p1", "A", "TEXT", null, "")] })]);
    expect(code).toEqual(editorCode());
  });
});

describe("the header's revision wording (owner ruling 2026-09-26; owner answer D-3, 2026-09-27)", () => {
  it("counts orders in the plural except exactly one", () => {
    expect(orderCountLabel(0)).toBe("on 0 orders");
    expect(orderCountLabel(1)).toBe("on 1 order");
    expect(orderCountLabel(2)).toBe("on 2 orders");
  });
  it("a locked current revision always says a save cuts the next one, and names the orders that keep it only when there are any", () => {
    expect(lockedRevisionNote(1, 0)).toBe("Saving creates Rev 2.");
    expect(lockedRevisionNote(1, 1)).toBe("Saving creates Rev 2. The 1 order on Rev 1 keeps it.");
    expect(lockedRevisionNote(3, 4)).toBe("Saving creates Rev 4. The 4 orders on Rev 3 keep it.");
  });
});
