import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createDraftStore } from "../src/lib/draft-store";
import { createDraftSession } from "../src/lib/draft-session";
import { ApiError } from "../src/lib/fetcher";
import { customFieldsRecoveryAdapter, prepareCustomFields, readCustomFields, type CustomFieldsBaseline } from "../src/lib/custom-fields-recovery";
import { processStepsRecoveryAdapter, prepareProcessSteps, readProcessSteps, type ProcessStepsBaseline } from "../src/lib/process-steps-recovery";

function actual<T>(path: string, name: string, environment: Record<string, unknown>): T {
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: ts.FunctionDeclaration | ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) {
      found = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(source); expect(found, `actual ${name} callback`).toBeDefined();
  const code = ts.transpileModule(`return (${found!.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(environment), code)(...Object.values(environment)) as T;
}
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { resolve, promise }; }
function owner() { const store = createDraftStore(); const user = store.acceptIdentity(store.beginIdentityCheck(), "user")!; return { store, user }; }
const fields = (): CustomFieldsBaseline => ({ partId: "part", permissions: ["parts.view", "parts.edit"], rows: [
  { fieldId: "field-a", name: "A", type: "TEXT", sort: 0, active: true, value: "old" },
] });
function fieldEditor() {
  const { store, user } = owner(); const binding = store.bind({ owner: user, record: { kind: "part", id: "part" }, editor: customFieldsRecoveryAdapter.kind }, { label: "Custom fields", href: "/parts/part" }, customFieldsRecoveryAdapter);
  const detach = binding.attach("view"); const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline: fields(), editable: true }, { values: new Map([["field-a", "old"]]), original: new Map([["field-a", "old"]]) });
  binding.change(d => ({ ...d, values: new Map([["field-a", "submitted"]]) })); return { store, binding, detach };
}
const steps = (): ProcessStepsBaseline => {
  const revision = { revisionNumber: 3, lockedAt: "locked", steps: [{ id: "step", position: 1, codeId: "code", code: "C", codeName: "Code", instruction: "old", parameters: [] }] };
  const codes = [{ id: "code", code: "C", name: "Code", active: true, defaultInstruction: "Default", fields: [] }];
  return { partId: "part", permissions: ["processes.view", "processes.edit"], highestRevision: 3, selectedRevision: 3, codesReady: true,
    summaries: [{ revisionNumber: 3, lockedAt: "locked", stepCount: 1, orderCount: 0, createdAt: "date" }], codes,
    revisions: new Map([[3, revision]]), document: { revision, baselineToken: "token3", codes } };
};

it("actual custom fields PUT acknowledges before throwing history/UI and never repeats PUT for refresh", async () => {
  const h = fieldEditor(); const settle = vi.spyOn(h.binding, "settle"); const api = vi.fn(async () => ({ ok: true }));
  const onError = vi.fn(); const history = vi.fn(() => { throw new Error("UI history failed after persistence"); });
  const save = actual<() => Promise<void>>("../src/app/parts/[id]/CustomFieldsSection.tsx", "save", {
    binding: h.binding, prepareCustomFields, partId: "part", api, onError, invalidateHistory: history,
    rows: [{ ...fields().rows[0], value: "submitted" }], dirty: [{ ...fields().rows[0], value: "submitted" }],
    setSaving: vi.fn(), setRows: vi.fn(), setOriginal: vi.fn(), saving: false, mounted: { current: true }, ApiError,
    load: vi.fn(), newId: () => "request",
  });
  await save();
  expect(api).toHaveBeenCalledTimes(1); expect(api).toHaveBeenCalledWith("/api/parts/part/fields", { method: "PUT", body: JSON.stringify({ values: [{ fieldId: "field-a", value: "submitted" }] }) });
  expect(settle).toHaveBeenCalledTimes(1); expect(settle.mock.calls[0][1]).toEqual({ kind: "persisted", response: undefined });
  expect(h.binding.getSnapshot().current?.data.original.get("field-a")).toBe("submitted"); expect(prepareCustomFields(h.binding, "retry")).toBeNull();
});
it("actual atomic process save settles captured scope before throwing history UI and preserves a late edit", async () => {
  const { store, user } = owner(); const binding = store.bind({ owner: user, record: { kind: "part", id: "part" }, editor: processStepsRecoveryAdapter.kind }, { label: "Process steps", href: "/parts/part" }, processStepsRecoveryAdapter);
  const baseline = steps(); binding.attach("view"); const readId = binding.beginRead();
  binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, { selectedRevision: 3, orderedEdits: new Map(), pendingRekey: null });
  const submitted = { clientId: "step", stepId: "step", codeId: "code", instruction: "submitted", parameters: [] };
  binding.change(data => ({ ...data, orderedEdits: new Map([[3, [submitted]]]) }));
  const document = { expectedBaselineToken: "untrusted", steps: [submitted] };
  const freshRevision = { ...baseline.revisions.get(3)!, revisionNumber: 4, lockedAt: null, steps: [{ ...baseline.revisions.get(3)!.steps[0], id: "new-step", instruction: "submitted" }] };
  const result = { baseline: { revision: freshRevision, baselineToken: "token-4", codes: [{ ...baseline.codes[0], defaultInstruction: "" }] }, stepIdMap: { step: "new-step" }, parameterKeys: { step: [] } };
  const settle = vi.spyOn(binding, "settle");
  const api = vi.fn(async () => {
    binding.change(data => ({ ...data, orderedEdits: new Map([[3, [{ ...submitted, instruction: "late edit" }]]]) }));
    return result;
  });
  const onError = vi.fn();
  const action = actual<() => Promise<void>>("../src/app/parts/[id]/ProcessStepsSection.tsx", "saveProcessAction", {
    binding, partId: "part", rowDisabled: false, document, pendingRef: { current: false }, setPending: vi.fn(), setSaveError: vi.fn(),
    prepareProcessSteps, newId: () => "request", api, ApiError, mounted: { current: true }, onError,
    invalidateHistory: () => { throw new Error("History failed"); }, refreshAfter: vi.fn(),
    clearUndo: vi.fn(), // the Undo bar's clear (Task 8, ruling D-2); its ordering is pinned in process-step-table.test.tsx
  });
  await action();
  expect(api).toHaveBeenCalledWith("/api/parts/part/process/document", { method: "PUT", body: JSON.stringify({ ...document, expectedBaselineToken: "token3" }) });
  expect(settle).toHaveBeenCalledTimes(1);
  expect(settle.mock.calls[0][1]).toEqual({ kind: "persisted", response: { revisionNumber: 4, document: result } });
  expect(binding.getSnapshot().current?.data.orderedEdits?.get(4)?.[0]).toMatchObject({ stepId: "new-step", instruction: "late edit" });
  expect(binding.getSnapshot().current?.baseline.document?.baselineToken).toBe("token-4");
  expect(binding.getSnapshot().needsRefresh).toBe(true);
  expect(onError).toHaveBeenCalledWith("History failed");
});

it("custom-field read obtains authority before awaits and same-user revalidation invalidates its response", async () => {
  const h = fieldEditor(); const session = createDraftSession(h.store); const binding = h.binding;
  const held = deferred<CustomFieldsBaseline["rows"]>();
  const readRows = vi.fn(() => held.promise); const accepted = vi.fn();
  const run = readCustomFields({ binding, session, partId: "part", readRows, readIdentity: async () => ({ id: "user", permissions: ["parts.view", "parts.edit"] }), accepted });
  expect(readRows).toHaveBeenCalledTimes(1); await session.validateIdentity(async () => ({ id: "user" }));
  held.resolve(fields().rows); expect(await run).toBe(false); expect(accepted).not.toHaveBeenCalled(); expect(binding.getSnapshot().savedBaseline).toBeUndefined();
});
it("process read validates actual revisions and fresh definitions for every required hidden revision", async () => {
  const { store, user } = owner(); const session = createDraftSession(store);
  const binding = store.bind({ owner: user, record: { kind: "part", id: "part" }, editor: processStepsRecoveryAdapter.kind }, { label: "Process steps", href: "/parts/part" }, processStepsRecoveryAdapter); binding.attach("view");
  const b = steps(); const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline: b, editable: true }, { selectedRevision: 3, orderedEdits: new Map([[3, [{ clientId: "step", stepId: "step", codeId: "code", instruction: "mine", parameters: [] }]]]), pendingRekey: null });
  const readRevision = vi.fn(async () => ({ ...b.revisions.get(3)!, revisionNumber: 2 })); const readCodes = vi.fn(async () => b.codes);
  const result = await readProcessSteps({ binding, session, partId: "part", readRevisions: async () => b.summaries, readRevision, readCodes,
    readIdentity: async () => ({ id: "user", permissions: ["processes.view", "processes.edit"] }), accepted: vi.fn() });
  expect(result).toBe(false); expect(readRevision).toHaveBeenCalledWith(3); expect(binding.getSnapshot().mode).toBe("unavailable");
});
it("custom-field settlement during a read requires one actual fresh reread, never old pre-PUT truth", async () => {
  const h = fieldEditor(); const session = createDraftSession(h.store);
  const s = h.binding.capture({ values: [{ fieldId: "field-a", value: "submitted" }] }, "save"); h.binding.dispatched(s);
  h.binding.change(d => ({ ...d, values: new Map(d.values).set("field-a", "later raw") }));
  const held = deferred<CustomFieldsBaseline["rows"]>(); const fresh = [{ ...fields().rows[0], value: "submitted" }];
  const readRows = vi.fn().mockImplementationOnce(() => held.promise).mockResolvedValue(fresh); const accepted = vi.fn();
  const run = readCustomFields({ binding: h.binding, session, partId: "part", readRows,
    readIdentity: async () => ({ id: "user", permissions: ["parts.view", "parts.edit"] }), accepted });
  expect(readRows).toHaveBeenCalledTimes(1); h.binding.settle(s, { kind: "persisted", response: undefined }); held.resolve(fields().rows);
  expect(await run).toBe(true); expect(readRows).toHaveBeenCalledTimes(2); expect(accepted).toHaveBeenCalledTimes(1);
  expect(h.binding.getSnapshot().savedBaseline?.rows[0].value).toBe("submitted");
  expect(h.binding.getSnapshot().current?.data.values.get("field-a")).toBe("later raw");
});
it("own cut during revisions GET makes one source-qualified reread and atomically lands new IDs", async () => {
  const { store, user } = owner(); const session = createDraftSession(store); const b = steps();
  const binding = store.bind({ owner: user, record: { kind: "part", id: "part" }, editor: processStepsRecoveryAdapter.kind }, { label: "Process steps", href: "/parts/part" }, processStepsRecoveryAdapter);
  binding.attach("view"); const id = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId: id, baseline: b, editable: true }, { selectedRevision: 3, pendingRekey: null });
  binding.change(d => ({ ...d, orderedEdits: new Map([[3, [{ clientId: "step", stepId: "step", codeId: "code", instruction: "later sibling", parameters: [] }]]]) }));
  const s = binding.capture({ kind: "recipe-number", recipeNumber: "001", expectedRecipeNumber: null }, "cut"); binding.dispatched(s);
  const held = deferred<ProcessStepsBaseline["summaries"]>(); const newRevision = { ...b.revisions.get(3)!, revisionNumber: 4, lockedAt: null, steps: b.revisions.get(3)!.steps.map(row => ({ ...row, id: "step-new" })) };
  const readRevisions = vi.fn().mockImplementationOnce(() => held.promise).mockResolvedValue([{ revisionNumber: 4, lockedAt: null, stepCount: 1, orderCount: 0, createdAt: "new" }, ...b.summaries]);
  const readRevision = vi.fn(async (n: number) => n === 4 ? newRevision : b.revisions.get(3)!);
  const run = readProcessSteps({ binding, session, partId: "part", readRevisions, readRevision, readCodes: async () => b.codes,
    readIdentity: async () => ({ id: "user", permissions: ["processes.view", "processes.edit"] }), accepted: vi.fn() });
  expect(readRevisions).toHaveBeenCalledTimes(1); binding.settle(s, { kind: "persisted", response: { recipeNumber: "001", revisionNumber: 4, stepIdMap: { step: "step-new" } } }); held.resolve(b.summaries);
  expect(await run).toBe(true); expect(readRevisions).toHaveBeenCalledTimes(2); expect(readRevision).toHaveBeenCalledWith(4);
  expect(binding.getSnapshot().current?.data.orderedEdits?.get(4)?.[0]).toMatchObject({ stepId: "step-new", instruction: "later sibling" }); expect(binding.getSnapshot().current?.data.pendingRekey).toBeNull();
});
it("actual custom-field load retries reads only after a failed post-PUT refresh", async () => {
  const h = fieldEditor(); const session = createDraftSession(h.store); const load = vi.fn(async () => false);
  const api = vi.fn(async () => ({ ok: true })); const save = actual<() => Promise<void>>("../src/app/parts/[id]/CustomFieldsSection.tsx", "save", {
    binding: h.binding, prepareCustomFields, partId: "part", api, onError: vi.fn(), invalidateHistory: vi.fn(),
    rows: [{ ...fields().rows[0], value: "submitted" }], dirty: [{ ...fields().rows[0], value: "submitted" }],
    setSaving: vi.fn(), setRows: vi.fn(), setOriginal: vi.fn(), saving: false, mounted: { current: true }, ApiError,
    load, newId: () => "request",
  });
  await save(); expect(api).toHaveBeenCalledTimes(1); expect(load).toHaveBeenCalledTimes(1); expect(h.binding.getSnapshot().needsRefresh).toBe(true);
  const readRows = vi.fn(async () => [{ ...fields().rows[0], value: "submitted" }]);
  await readCustomFields({ binding: h.binding, session, partId: "part", readRows, readIdentity: async () => ({ id: "user", permissions: ["parts.view", "parts.edit"] }), accepted: vi.fn() });
  expect(readRows).toHaveBeenCalledTimes(1); expect(api).toHaveBeenCalledTimes(1); expect(h.store.getSnapshot().count).toBe(0);
});
it("missing definitions preserve clean saved process display while denying retained Restore", async () => {
  const { store, user } = owner(); const session = createDraftSession(store); const b = steps();
  const binding = store.bind({ owner: user, record: { kind: "part", id: "part" }, editor: processStepsRecoveryAdapter.kind }, { label: "Process steps", href: "/parts/part" }, processStepsRecoveryAdapter);
  const detach = binding.attach("first"); const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline: b, editable: true }, { selectedRevision: 3, pendingRekey: null });
  const args = { binding, session, partId: "part", readRevisions: async () => b.summaries, readRevision: async () => b.revisions.get(3)!,
    readCodes: async () => { throw new Error("catalog unavailable"); }, readIdentity: async () => ({ id: "user", permissions: ["processes.view", "processes.edit"] }), accepted: vi.fn() };
  expect(await readProcessSteps(args)).toBe(true); expect(binding.getSnapshot().savedBaseline?.revisions.get(3)?.steps[0].instruction).toBe("old");
  expect(binding.getSnapshot().savedBaseline?.codesReady).toBe(false); expect(binding.getSnapshot().recoveryAllowed).toBe(false); expect(binding.getSnapshot().mode).toBe("editing");
  binding.change(d => ({ ...d, orderedEdits: new Map([[3, [{ clientId: "step", stepId: "step", codeId: "code", instruction: "saved-row edit", parameters: [] }]]]) }));
  expect(binding.getSnapshot().current?.data.orderedEdits?.get(3)?.[0].instruction).toBe("saved-row edit");
  detach(); binding.attach("return"); expect(await readProcessSteps(args)).toBe(true);
  expect(binding.getSnapshot().canRestore).toBe(false); expect(binding.getSnapshot().mode).toBe("conflict");
  expect(binding.getSnapshot().savedBaseline?.revisions.get(3)?.steps[0].instruction).toBe("old");
});
