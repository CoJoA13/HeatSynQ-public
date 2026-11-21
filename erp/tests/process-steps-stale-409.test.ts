import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/fetcher";
import { all, run } from "./helpers/source-lift";

// #659 (G1-3): when Save process steps or Save recipe is refused 409 ("The process
// changed — reload before saving"), the adapter settles the draft as rejected and keeps it in
// editing mode with no read, so every later Save resent the same `expectedBaselineToken` and was
// refused again; the only ways out were Discard, the revision picker or leaving the page. Each
// save action now runs the section's own recovery read after `settle`, on a 409 only: the store's
// conflict check then finds the changed token and lands conflict mode (Restore, Discard, Start
// fresh), with `saveError` kept. A 400 is a validation refusal a read does nothing for, and a 5xx
// settles as unknown, which already suspends editing until a reconciling read.
//
// vitest has no DOM, and the section's tests render it statically, so each action is lifted out
// of ProcessStepsSection.tsx and run over a hand-built environment (tests/helpers/source-lift.ts).
// Mutation: drop the 409 branch from either action and its case reds.

const PATH = fileURLToPath(new URL("../src/app/parts/[id]/ProcessStepsSection.tsx", import.meta.url));
const file = ts.createSourceFile(PATH, readFileSync(PATH, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const section = file.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "ProcessStepsSection");
function action(name: string): ts.FunctionDeclaration {
  const found = section ? all(section, ts.isFunctionDeclaration).filter((f) => f.name?.text === name) : [];
  if (found.length !== 1) throw new Error(`Expected one ${name} in ProcessStepsSection.tsx, found ${found.length}`);
  return found[0];
}
/** Every promise reaction queued so far has run. */
const settle = () => new Promise<void>((done) => setImmediate(done));

function environment(name: "saveProcessAction" | "saveRecipeNumberAction", answer: () => Promise<unknown>) {
  const load = vi.fn(async () => true);
  const settled: unknown[] = [];
  const submission = name === "saveProcessAction"
    ? { payload: { kind: "document", document: { expectedBaselineToken: "t", steps: [] } }, stamp: { generation: 1 } }
    : { payload: { kind: "recipe-number", recipeNumber: "0042", expectedRecipeNumber: null }, stamp: { generation: 1 } };
  const binding = {
    dispatched: () => true,
    settle: (_s: unknown, outcome: unknown) => { settled.push(outcome); },
    getSnapshot: () => ({ current: { stamp: { generation: 1 } } }),
  };
  const saveError: Array<string | null> = [];
  const env: Record<string, unknown> = {
    binding, pendingRef: { current: false }, mounted: { current: true },
    prepareProcessSteps: () => ({ binding, submission }), newId: () => "req-1",
    rowDisabled: false, document: { expectedBaselineToken: "t", steps: [] },
    numberDisabled: false, numberValue: "0042", savedNumber: null,
    onError: () => {}, setPending: () => {}, setSaveError: (m: string | null) => { saveError.push(m); },
    api: answer, partId: "part-1", ApiError, clearUndo: () => {}, invalidateHistory: () => {},
    refreshAfter: async () => {}, load,
  };
  // The production 409 branch itself, lifted with its two dependencies, so the case runs it.
  env.readAgainIfStale = run<(error: unknown) => void>(action("readAgainIfStale").getText(file), { ApiError, load });
  const fn = run<() => Promise<void>>(action(name).getText(file), env);
  return { fn, load, settled, saveError };
}

describe.each(["saveProcessAction", "saveRecipeNumberAction"] as const)("ProcessStepsSection %s after a refusal", (name) => {
  it("a 409 settles the draft as rejected and reads the section again", async () => {
    const e = environment(name, async () => { throw new ApiError("The process changed — reload before saving", 409); });
    await e.fn();
    await settle();
    expect(e.settled).toEqual([{ kind: "rejected" }]);
    expect(e.load).toHaveBeenCalledTimes(1);
    expect(e.load).toHaveBeenCalledWith();
    if (name === "saveProcessAction") expect(e.saveError.at(-1)).toBe("The process changed — reload before saving");
  });

  it("a 400 settles the draft as rejected and reads nothing", async () => {
    const e = environment(name, async () => { throw new ApiError("Step 2: instruction is required", 400); });
    await e.fn();
    await settle();
    expect(e.settled).toEqual([{ kind: "rejected" }]);
    expect(e.load).not.toHaveBeenCalled();
  });

  it("a 5xx settles the draft as unknown and reads nothing here (the adapter suspends editing itself)", async () => {
    const e = environment(name, async () => { throw new ApiError("Request failed (503)", 503); });
    await e.fn();
    await settle();
    expect(e.settled).toEqual([{ kind: "unknown" }]);
    expect(e.load).not.toHaveBeenCalled();
  });
});
