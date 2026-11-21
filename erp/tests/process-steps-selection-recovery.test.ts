import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createDraftStore } from "../src/lib/draft-store";
import { createDraftSession } from "../src/lib/draft-session";
import { processStepsLand, processStepsRecoveryAdapter, readProcessSteps, type ProcessStepsBaseline, type ProcessStepsDraft, type ProcessRevision } from "../src/lib/process-steps-recovery";
const revision = (n: number, id: string): ProcessRevision => ({ revisionNumber: n, lockedAt: null, steps: [{ id, codeId: "code", code: "C", codeName: "Code", position: 1, instruction: "original", parameters: [] }] });
function baseline(selectedRevision: number): ProcessStepsBaseline {
  return { partId: "part", highestRevision: 4, selectedRevision, codesReady: true, permissions: ["processes.view", "processes.edit"],
    summaries: [4, 3, 2].map(revisionNumber => ({ revisionNumber, lockedAt: null, stepCount: 1, orderCount: 5 - revisionNumber, createdAt: "date" })),
    revisions: new Map([[2, revision(2, "step-two")], [3, revision(3, "step-old")], [4, revision(4, "step-new")]]), codes: [{ id: "code", code: "C", name: "Code", active: true, fields: [] }] };
}
function beforeCutBaseline(): ProcessStepsBaseline {
  const b = baseline(3);
  return { ...b, highestRevision: 3, summaries: b.summaries.filter(row => row.revisionNumber <= 3), revisions: new Map([...b.revisions].filter(([number]) => number <= 3)) };
}
it("a fetched pending target is not a displayed landing: old-revision detour preserves stage and raw keys", () => {
  const stage = { fromRevision: 3, toRevision: 4, map: { "step-old": "step-new" } };
  const data: ProcessStepsDraft = { selectedRevision: 3, orderedEdits: new Map([[3, [{ clientId: "step-old", stepId: "step-old", codeId: "code", instruction: "retain raw", parameters: [] }]]]), pendingRekey: stage };
  const current = { data, baseline: beforeCutBaseline() };
  const detour = processStepsLand(current, baseline(2))!;
  expect(detour.data.selectedRevision).toBe(2); expect(detour.data.pendingRekey).toEqual(stage);
  expect(detour.data.orderedEdits?.get(3)?.[0]).toMatchObject({ stepId: "step-old", instruction: "retain raw" }); expect(detour.data.orderedEdits?.get(4)).toBeUndefined();
  expect(detour.baseline.revisions.get(2)?.steps[0].id).toBe("step-two");
  const landed = processStepsLand(detour, baseline(4))!;
  expect(landed.data.selectedRevision).toBe(4); expect(landed.data.pendingRekey).toBeNull();
  expect(landed.data.orderedEdits?.get(4)?.[0]).toMatchObject({ clientId: "step-new", stepId: "step-new", instruction: "retain raw" });
  expect(landed.data.orderedEdits?.has(3)).toBe(false);
  const repeated = processStepsLand(landed, baseline(4))!; expect(repeated.data.orderedEdits?.get(4)).toEqual(landed.data.orderedEdits?.get(4));
  expect(current.data.selectedRevision).toBe(3); expect(current.data.pendingRekey?.toRevision).toBe(4);
});
it("a superseded explicit revision read cannot change displayed revision or accepted callback", async () => {
  const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "user")!; const session = createDraftSession(store);
  const binding = store.bind({ owner, record: { kind: "part", id: "part" }, editor: processStepsRecoveryAdapter.kind }, { label: "Process steps", href: "/parts/part" }, processStepsRecoveryAdapter); binding.attach("view");
  const b = baseline(3); const id = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId: id, editable: true, baseline: b }, { selectedRevision: 3, pendingRekey: null });
  let resolve!: (rows: ProcessStepsBaseline["summaries"]) => void; const held = new Promise<ProcessStepsBaseline["summaries"]>(yes => { resolve = yes; });
  const firstRead = vi.fn(() => held); const firstAccepted = vi.fn(); const secondAccepted = vi.fn();
  const common = { binding, session, partId: "part", readRevision: async (n: number) => b.revisions.get(n)!, readCodes: async () => b.codes, readIdentity: async () => ({ id: "user", permissions: ["processes.view", "processes.edit"] }) };
  const first = readProcessSteps({ ...common, selectedRevision: 2, readRevisions: firstRead, accepted: firstAccepted }); expect(firstRead).toHaveBeenCalledTimes(1);
  const second = readProcessSteps({ ...common, selectedRevision: 4, readRevisions: async () => b.summaries, accepted: secondAccepted });
  expect(await second).toBe(true); resolve(b.summaries); expect(await first).toBe(false); expect(firstAccepted).not.toHaveBeenCalled(); expect(secondAccepted).toHaveBeenCalledTimes(1);
  expect(binding.getSnapshot().savedBaseline?.selectedRevision).toBe(4); expect(binding.getSnapshot().current?.data.selectedRevision).toBe(4);
});
it("an own map with valid endpoints still rejects a changed target original", () => {
  const old = beforeCutBaseline(); const code = { ...old.codes[0], fields: [{ id: "field", label: "Field", type: "NUMBER", unit: "F", sort: 0 }] };
  const withValue = (r: ProcessRevision, value = "500"): ProcessRevision => ({ ...r, steps: r.steps.map(s => ({ ...s, parameters: [{ key: "field", label: "Field", type: "NUMBER", unit: "F", position: 0, value }] })) });
  const saved = { ...old, highestRevision: 3, codes: [code], revisions: new Map([...old.revisions].map(([n, r]) => [n, withValue(r)])) };
  const data: ProcessStepsDraft = { selectedRevision: 3, pendingRekey: { fromRevision: 3, toRevision: 4, map: { "step-old": "step-new" } },
    orderedEdits: new Map([[3, [{ clientId: "step-old", stepId: "step-old", codeId: "code", instruction: "original", parameters: [{ key: "field", label: "Field", type: "NUMBER", unit: "F", value: "600" }] }]]]) };
  // Revision 4 was cut from 3, but its copy of the value has since changed underneath the draft.
  const fresh = { ...saved, highestRevision: 4, selectedRevision: 4, summaries: baseline(4).summaries,
    revisions: new Map([...baseline(4).revisions].map(([n, r]) => [n, withValue(r, n === 4 ? "700" : "500")])) };
  const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "user")!;
  const binding = store.bind({ owner, record: { kind: "part", id: "part" }, editor: processStepsRecoveryAdapter.kind }, { label: "Process steps", href: "/parts/part" }, processStepsRecoveryAdapter);
  const detach = binding.attach("first"); let readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, editable: true, baseline: saved }, data);
  detach(); binding.attach("return"); readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, editable: true, baseline: fresh }, { selectedRevision: 4, pendingRekey: null });
  expect(binding.getSnapshot().canRestore).toBe(false); expect(binding.getSnapshot().mode).toBe("conflict");
  expect(binding.getSnapshot().current?.data.pendingRekey).toEqual(data.pendingRekey);
  expect(binding.getSnapshot().current?.data.orderedEdits?.get(3)?.[0].parameters).toEqual([{ key: "field", label: "Field", type: "NUMBER", unit: "F", value: "600" }]);
});
it("the actual editor has one document settlement path for add, move and revision selection recovery", () => {
  const path = "../src/app/parts/[id]/ProcessStepsSection.tsx";
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let save: ts.FunctionDeclaration | undefined, change: ts.FunctionDeclaration | undefined;
  const walk = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "saveProcessAction") save = node;
    if (ts.isFunctionDeclaration(node) && node.name?.text === "changeRows") change = node;
    ts.forEachChild(node, walk);
  };
  walk(source); expect(save).toBeDefined(); expect(change).toBeDefined();
  const saveText = save!.getText(source), changeText = change!.getText(source);
  expect(saveText).toContain('/process/document`');
  expect(saveText).toContain('kind: "document"');
  expect(saveText).toContain("revisionNumber: result.baseline.revision?.revisionNumber ?? null");
  expect(saveText.indexOf("binding.settle")).toBeLessThan(saveText.indexOf("invalidateHistory"));
  expect(changeText).toContain("orderedEdits: new Map(d.orderedEdits).set(selected ?? 0, next)");
});
it("authorized document read supplies the coherent current rows and complete editor catalog", async () => {
  const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "user")!; const session = createDraftSession(store);
  const binding = store.bind({ owner, record: { kind: "part", id: "part" }, editor: processStepsRecoveryAdapter.kind }, { label: "Process", href: "/parts/part" }, processStepsRecoveryAdapter); binding.attach("view");
  const b = baseline(4); const r = { ...revision(4, "coherent"), steps: [{ ...revision(4, "coherent").steps[0], instruction: "Document content" }] };
  const codes = [...b.codes.map(c => ({ ...c, defaultInstruction: "Boilerplate" })), { id: "unused", code: "U", name: "Unused", active: true, defaultInstruction: "Unused default", fields: [] }];
  const accepted = await readProcessSteps({ binding, session, partId: "part", readRevisions: async () => b.summaries, readRevision: async n => b.revisions.get(n)!, readCodes: async () => b.codes,
    readDocument: async () => ({ revision: r, baselineToken: "coherent-token", codes }), readIdentity: async () => ({ id: "user", permissions: ["processes.view", "processes.edit"] }), accepted: () => {} });
  expect(accepted).toBe(true); expect(binding.getSnapshot().current?.baseline.document?.baselineToken).toBe("coherent-token");
  // The read rebuilds each summary field by field, so the order count is carried explicitly (owner ruling 2026-09-26).
  expect(binding.getSnapshot().current?.baseline.summaries.map(s => [s.revisionNumber, s.orderCount])).toEqual([[4, 1], [3, 2], [2, 3]]);
  expect(binding.getSnapshot().current?.baseline.revisions.get(4)?.steps[0].instruction).toBe("Document content");
  expect(binding.getSnapshot().current?.baseline.document?.codes[1].defaultInstruction).toBe("Unused default");
});
