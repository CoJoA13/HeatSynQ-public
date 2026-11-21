import { describe, expect, it, vi } from "vitest";
import { createDraftSession } from "../src/lib/draft-session";
import { createDraftStore } from "../src/lib/draft-store";
import { processStepsRecoveryAdapter as adapter, prepareProcessSteps, processStepsLand, processDraftSteps, readProcessSteps,
  type ProcessStepsBaseline, type ProcessStepsDraft, type ProcessRevision } from "../src/lib/process-steps-recovery";
import type { ProcessDraftStep, ProcessDocumentResult } from "../src/lib/process-document";
const freshRow = (n = 1): ProcessDraftStep => ({ clientId: `new:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, stepId: null, codeId: "code", instruction: "New row", parameters: [] });
const rev = (n = 3): ProcessRevision => ({ revisionNumber: n, lockedAt: null, steps: ["a", "b"].map((id, i) => ({ id: `${id}${n}`, position: i + 1, codeId: "code", code: "C", codeName: "Code", instruction: id, parameters: [{ key: "f", label: "Field", type: "TEXT", unit: null, position: 0, value: "value" }] })) });
const baseline = (r = rev()): ProcessStepsBaseline => {
  const codes = [{ id: "code", code: "C", name: "Code", active: true, defaultInstruction: "Default", fields: [{ id: "f", label: "Field", type: "TEXT", unit: null, sort: 0 }] }];
  return { partId: "part", permissions: ["processes.view", "processes.edit"], highestRevision: r.revisionNumber, revisions: new Map([[r.revisionNumber, r]]), summaries: [{ revisionNumber: r.revisionNumber, lockedAt: r.lockedAt, stepCount: r.steps.length, orderCount: 0, createdAt: "" }], codes, codesReady: true, document: { revision: r, baselineToken: `token${r.revisionNumber}`, codes } };
};
/** The rows as the Save sends them: each added row names its code as the catalog shows it (R11). */
const named = (rows: ProcessDraftStep[]) => rows.map(r => r.stepId === null ? { ...r, codeSeen: { code: "C", name: "Code" } } : r);
const clean = (n = 3): ProcessStepsDraft => ({ selectedRevision: n, pendingRekey: null });
function open(b = baseline()) {
  const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "user")!;
  const binding = store.bind({ owner, record: { kind: "part", id: "part" }, editor: adapter.kind }, { label: "Process", href: "/parts/part" }, adapter);
  const detach = binding.attach("initial");
  const read = (fresh: ProcessStepsBaseline, recoveryAllowed = true) => { const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline: fresh, editable: true, recoveryAllowed }, clean(fresh.highestRevision!)); return readId; };
  read(b);
  const change = (steps: ProcessDraftStep[]) => binding.change(d => ({ ...d, orderedEdits: new Map(d.orderedEdits).set(3, steps) }));
  const capture = () => { const prepared = prepareProcessSteps(binding, { kind: "document", document: { expectedBaselineToken: "untrusted", steps: [] } }, "save")!; expect(prepared).not.toBeNull(); binding.dispatched(prepared.submission); return prepared.submission; };
  return { store, binding, read, detach, change, capture };
}
/** A save's answer: revision 4 holding `steps` as saved rows, each row's key kept as submitted. */
function response(steps: ProcessDraftStep[]): ProcessDocumentResult {
  const r = rev(4); const codes = baseline().document!.codes;
  const mapped = steps.map((s, i) => ({ id: `saved${i}`, position: i + 1, codeId: s.codeId, code: "C", codeName: "Code", instruction: s.instruction, parameters: s.parameters.map((p, index) => ({ ...p, position: index })) }));
  return { baseline: { revision: { ...r, steps: mapped }, codes, baselineToken: "token4" }, stepIdMap: Object.fromEntries(steps.map((s, i) => [s.clientId, `saved${i}`])), parameterKeys: Object.fromEntries(steps.map(s => [s.clientId, s.parameters.map(p => p.key)])) };
}
it("ordered removal, insertion and reorder are dirty and appear in recovery preview", () => {
  const b = baseline(); const rows = processDraftSteps(clean(), b, 3); const d = { ...clean(), orderedEdits: new Map([[3, [freshRow(), rows[0]]]]) };
  expect(adapter.dirty(d, b)).toBe(true); expect(adapter.valid(d, b)).toBe(true);
  expect(adapter.preview(d, b).map(p => p.value).join(" ")).toContain("New row");
  expect(adapter.preview(d, b).map(p => p.label)).toContain("Rev 3 step 2 Field");
  expect(adapter.preview({ ...d, orderedEdits: new Map([[3, []]]) }, b).length).toBeGreaterThan(0);
  expect(adapter.dirty({ ...clean(), orderedEdits: new Map([[3, rows]]) }, b)).toBe(false);
});
it("captures live full document and baseline token and preserves late rows plus number", () => {
  const h = open(); const submitted = [freshRow()]; h.change(submitted); h.binding.change(d => ({ ...d, recipeNumberEdit: "UNSAVED" })); const s = h.capture();
  expect(s.payload).toEqual({ kind: "document", document: { expectedBaselineToken: "token3", steps: named(submitted) } });
  h.change([{ ...submitted[0], instruction: "Edited after dispatch" }, { ...freshRow(2), instruction: "New row after dispatch" }]);
  h.binding.settle(s, { kind: "persisted", response: { revisionNumber: 4, document: response(submitted) } });
  const afterSave = h.binding.getSnapshot().current!;
  expect(afterSave.data.orderedEdits?.get(4)?.map(s => s.instruction)).toEqual(["Edited after dispatch", "New row after dispatch"]);
  expect(afterSave.data.orderedEdits?.get(4)?.map(s => s.stepId)).toEqual(["saved0", null]);
  expect(afterSave.data.recipeNumberEdit).toBe("UNSAVED");
  expect(afterSave.baseline.document?.baselineToken).toBe("token4");
});
it("a document save carries each summary's order count: a cut revision starts on no order, an amended one keeps its count (owner ruling 2026-09-26)", () => {
  const b = baseline(); const onOrders = { ...b, summaries: [{ ...b.summaries[0], orderCount: 2 }] };
  const cutting = open(onOrders); const submitted = [freshRow()]; cutting.change(submitted);
  cutting.binding.settle(cutting.capture(), { kind: "persisted", response: { revisionNumber: 4, document: response(submitted) } });
  expect(cutting.binding.getSnapshot().current!.baseline.summaries.map(s => [s.revisionNumber, s.orderCount])).toEqual([[4, 0], [3, 2]]);
  const inPlace = open(onOrders); inPlace.change(submitted);
  const answer = response(submitted); const amended = { ...answer, baseline: { ...answer.baseline, revision: { ...answer.baseline.revision!, revisionNumber: 3 } } };
  inPlace.binding.settle(inPlace.capture(), { kind: "persisted", response: { revisionNumber: 3, document: amended } });
  expect(inPlace.binding.getSnapshot().current!.baseline.summaries.map(s => [s.revisionNumber, s.orderCount])).toEqual([[3, 2]]);
});
it("does not assign removed identity to a new insertion or changed code after dispatch", () => {
  const h = open(); const submitted = [freshRow()]; h.change(submitted); const s = h.capture();
  h.change([{ ...submitted[0], codeId: "different" }, freshRow(2)]);
  h.binding.settle(s, { kind: "persisted", response: { revisionNumber: 4, document: response(submitted) } });
  expect(h.binding.getSnapshot().current!.data.orderedEdits?.get(4)?.map(s => s.stepId)).toEqual([null, null]);
});
it("clears the acknowledged ordered submission and retains another revision's ordered draft", () => {
  const b = baseline(); const h = open({ ...b, revisions: new Map([...b.revisions, [2, rev(2)]]) });
  h.binding.change(d => ({ ...d, orderedEdits: new Map([[2, processDraftSteps(d, h.binding.getSnapshot().current!.baseline, 2).map((s, i) => i === 0 ? { ...s, instruction: "History" } : s)]]) }));
  const submitted = [freshRow()]; h.change(submitted); const s = h.capture(); h.binding.settle(s, { kind: "persisted", response: { revisionNumber: 4, document: response(submitted) } });
  expect([...h.binding.getSnapshot().current!.data.orderedEdits!.keys()]).toEqual([2]);
  expect(h.binding.getSnapshot().current!.data.orderedEdits?.get(2)?.[0].instruction).toBe("History");
});
it("preserves ordered new rows and reordered existing IDs when a number save cuts revision", () => {
  const h = open(); const rows = processDraftSteps(clean(), baseline(), 3); h.change([rows[1], freshRow(), rows[0]]);
  h.binding.change(d => ({ ...d, recipeNumberEdit: "123" }));
  const s = prepareProcessSteps(h.binding, { kind: "recipe-number", recipeNumber: "123", expectedRecipeNumber: null }, "number")!.submission; h.binding.dispatched(s);
  h.binding.settle(s, { kind: "persisted", response: { revisionNumber: 4, recipeNumber: "123", stepIdMap: { a3: "a4", b3: "b4" } } });
  const landed = processStepsLand(h.binding.getSnapshot().current!, baseline({ ...rev(4), recipeNumber: "123" }))!;
  expect(landed.data.orderedEdits?.get(4)?.map(s => s.stepId)).toEqual(["b4", null, "a4"]);
});
it("unknown submission retains exact IDs, blocks replay, and survives unavailable and denied reads", () => {
  const h = open(); const submitted = [freshRow()]; h.change(submitted); const s = h.capture(); h.change([{ ...submitted[0], instruction: "Late" }]); h.binding.settle(s, { kind: "unknown" });
  expect(prepareProcessSteps(h.binding, s.payload, "retry")).toBeNull();
  const retainedReference = h.binding.getSnapshot().current!.data.submittedDocument!;
  expect(retainedReference.steps.map(s => s.clientId)).toEqual(submitted.map(s => s.clientId));
  h.binding.acceptRead({ kind: "unavailable", readId: h.binding.beginRead() }, clean());
  expect(h.binding.getSnapshot().mode).toBe("unavailable");
  h.read(baseline(), false); expect(h.binding.getSnapshot().recoveryAllowed).toBe(false);
});
it("ordered draft conflicts with concurrent content even when touched rows survived", () => {
  const h = open(); h.change([freshRow()]); h.detach(); h.binding.attach("return");
  const b = baseline(); h.read({ ...b, document: { ...b.document!, baselineToken: "changed" } });
  expect(h.binding.getSnapshot().canRestore).toBe(false);
});
it("rejects malformed optional ordered data without invalidating old payloads", () => {
  expect(adapter.valid({ ...clean(), orderedEdits: new Map([[3, [{ ...freshRow(), parameters: [{ key: "f", label: "Field", type: "TEXT", unit: null, value: "1" }, { key: "f", label: "Field", type: "TEXT", unit: null, value: "2" }] }]]]) }, baseline())).toBe(false);
  expect(adapter.valid({ ...clean(), orderedEdits: new Map([[3, [{ ...freshRow(), parameters: [{ key: "f", label: "Field", type: "COLOUR", unit: null, value: "1" }] }]]]) }, baseline())).toBe(false);
});
it("fresh authorized matching read resolves unknown once and maps only submitted identities", () => {
  const h = open(); const submitted = [freshRow()]; h.change(submitted); const s = h.capture(); h.change([{ ...submitted[0], instruction: "Late" }, freshRow(2)]); h.binding.settle(s, { kind: "unknown" });
  const result = response(submitted); const fresh = { ...baseline(result.baseline.revision!), document: result.baseline };
  h.read(fresh, false); expect(h.binding.getSnapshot().current?.data.submittedDocument).toBeDefined();
  h.read(fresh); const view = h.binding.getSnapshot();
  expect(view.mode).toBe("editing"); expect(view.current?.data.submittedDocument).toBeUndefined();
  expect(view.current?.data.orderedEdits?.get(4)?.map(s => s.stepId)).toEqual(["saved0", null]);
  expect(view.current?.data.orderedEdits?.get(4)?.map(s => s.instruction)).toEqual(["Late", "New row"]);
});
it("a fresh matching read adopts the saved rows' keys for a hand-added row whose answer was lost", () => {
  // Content is compared without keys (a provisional key can never match a saved one), and the
  // fresh rows' keys become the local rows' identity, exactly as the lost answer would have.
  const h = open(); const submitted = [{ ...freshRow(), parameters: [{ key: "new:11111111-1111-4111-8111-111111111111", label: "Load", type: "TEXT" as const, unit: null, value: "x" }] }];
  h.change(submitted); const s = h.capture(); h.change([{ ...submitted[0], instruction: "Late" }]); h.binding.settle(s, { kind: "unknown" });
  const saved = response([{ ...submitted[0], parameters: [{ ...submitted[0].parameters[0], key: "SERVER-KEY" }] }]);
  h.read({ ...baseline(saved.baseline.revision!), document: saved.baseline });
  const view = h.binding.getSnapshot(); expect(view.mode).toBe("editing");
  expect(view.current?.data.orderedEdits?.get(4)?.[0].parameters).toEqual([{ key: "SERVER-KEY", label: "Load", type: "TEXT", unit: null, value: "x" }]);
  expect(view.current?.data.orderedEdits?.get(4)?.[0].instruction).toBe("Late");
});
it("divergent fresh content leaves unknown reference and never infers an ID map", () => {
  const h = open(); const submitted = [freshRow()]; h.change(submitted); const s = h.capture(); h.binding.settle(s, { kind: "unknown" });
  const result = response([{ ...submitted[0], instruction: "Different editor" }]); h.read({ ...baseline(result.baseline.revision!), document: result.baseline });
  expect(h.binding.getSnapshot().current?.data.submittedDocument?.steps).toEqual(named(submitted));
  expect(h.binding.getSnapshot().canRestore).toBe(false); expect(prepareProcessSteps(h.binding, s.payload, "retry")).toBeNull();
});
it("late settlement cannot alter a replacement generation", () => {
  const h = open(); const submitted = [freshRow()]; h.change(submitted); const s = h.capture();
  h.binding.discard(h.binding.getSnapshot().current!.stamp); h.change([freshRow(2)]); const before = h.binding.getSnapshot().current;
  h.binding.settle(s, { kind: "persisted", response: { revisionNumber: 4, document: response(submitted) } });
  expect(h.binding.getSnapshot().current).toBe(before);
});
it("remove and reinsert with identical content remains dirty until new identity is acknowledged", () => {
  const b = baseline(); const rows = processDraftSteps(clean(), b, 3);
  const data = { ...clean(), orderedEdits: new Map([[3, [{ ...rows[0], clientId: freshRow().clientId, stepId: null }, rows[1]]]]) };
  expect(adapter.dirty(data, b)).toBe(true);
});
it("stale read after document success cannot replace the acknowledged baseline", () => {
  const h = open(); const submitted = [freshRow()]; h.change(submitted); const s = h.capture(); h.change([{ ...submitted[0], instruction: "Late" }]);
  h.binding.settle(s, { kind: "persisted", response: { revisionNumber: 4, document: response(submitted) } }); h.read(baseline());
  expect(h.binding.getSnapshot().mode).toBe("conflict");
  expect(h.binding.getSnapshot().current?.baseline.document?.baselineToken).toBe("token4");
  expect(h.binding.getSnapshot().current?.data.orderedEdits?.get(4)?.[0].instruction).toBe("Late");
});
it("unknown reconciliation cannot clear an unsaved recipe number when another writer changed it", () => {
  const h = open(); const submitted = [freshRow()]; h.change(submitted); h.binding.change(d => ({ ...d, recipeNumberEdit: "MINE" }));
  const s = h.capture(); h.binding.settle(s, { kind: "unknown" }); const result = response(submitted);
  const r = { ...result.baseline.revision!, recipeNumber: "OTHER" };
  h.read({ ...baseline(r), document: { ...result.baseline, revision: r } });
  expect(h.binding.getSnapshot().current?.data.submittedDocument).toBeDefined();
  expect(h.binding.getSnapshot().current?.data.recipeNumberEdit).toBe("MINE");
});
it("ordered number-cut mapping survives a historical revision detour", () => {
  const b = baseline(); const h = open({ ...b, revisions: new Map([...b.revisions, [2, rev(2)]]) }); h.change([freshRow()]); h.binding.change(d => ({ ...d, recipeNumberEdit: "123" }));
  const s = prepareProcessSteps(h.binding, { kind: "recipe-number", recipeNumber: "123", expectedRecipeNumber: null }, "number")!.submission; h.binding.dispatched(s);
  h.binding.settle(s, { kind: "persisted", response: { revisionNumber: 4, recipeNumber: "123", stepIdMap: { a3: "a4", b3: "b4" } } });
  const b4 = baseline({ ...rev(4), recipeNumber: "123" }); const fresh = { ...b4, revisions: new Map([...b4.revisions, [2, rev(2)], [3, rev(3)]]) };
  const detour = processStepsLand(h.binding.getSnapshot().current!, { ...fresh, selectedRevision: 2 })!;
  const landed = processStepsLand(detour, { ...fresh, selectedRevision: 4 })!;
  expect(landed.data.orderedEdits?.get(4)?.[0].clientId).toBe(freshRow().clientId);
});
it("a number cut of an empty process carries locally inserted ordered rows", () => {
  const h = open(baseline({ ...rev(), steps: [] })); h.change([freshRow()]); h.binding.change(d => ({ ...d, recipeNumberEdit: "123" }));
  const s = prepareProcessSteps(h.binding, { kind: "recipe-number", recipeNumber: "123", expectedRecipeNumber: null }, "number")!.submission; h.binding.dispatched(s);
  h.binding.settle(s, { kind: "persisted", response: { revisionNumber: 4, recipeNumber: "123", stepIdMap: {} } });
  const landed = processStepsLand(h.binding.getSnapshot().current!, baseline({ ...rev(4), steps: [], recipeNumber: "123" }))!;
  expect(landed.data.orderedEdits?.get(4)?.[0].clientId).toBe(freshRow().clientId);
});
it.each(["queued", "pending"])("unknown matching read waits for a %s sibling submission", state => {
  const h = open(); const submitted = [freshRow()]; h.change(submitted); const s = h.capture();
  const sibling = h.binding.capture(s.payload, "sibling"); if (state === "pending") h.binding.dispatched(sibling);
  h.binding.settle(s, { kind: "unknown" }); const result = response(submitted);
  h.read({ ...baseline(result.baseline.revision!), document: result.baseline });
  expect(h.binding.getSnapshot().current?.data.submittedDocument?.steps).toEqual(named(submitted));
  expect(prepareProcessSteps(h.binding, s.payload, "retry")).toBeNull();
});
it("unknown matching read from a replaced authorization context cannot reconcile the old binding", () => {
  const h = open(); const submitted = [freshRow()]; h.change(submitted); const s = h.capture(); h.binding.settle(s, { kind: "unknown" });
  const readId = h.binding.beginRead(); const result = response(submitted);
  h.store.acceptIdentity(h.store.beginIdentityCheck(), "different-user");
  expect(h.binding.acceptRead({ kind: "authorized", readId, editable: true, recoveryAllowed: true, baseline: { ...baseline(result.baseline.revision!), document: result.baseline } }, clean(4))).toBe(false);
  expect(h.binding.getSnapshot().current).toBeUndefined();
  expect(h.binding.getSnapshot().submitted).toBeUndefined();
});
// #657 (2026-10-22 review, G1-1): with the document read supplied, the current revision and the
// catalog come from the document's answer, so the loader no longer reads them on their own (two of
// five serial GETs, both thrown away). A revision OTHER than the current is still read on its own.
// Mutation: read the current revision or the catalog regardless and these cases red.
it("with the document supplied, the current revision and the catalog are not read on their own", async () => {
  const h = open(); const b = baseline();
  const readRevision = vi.fn(async (n: number) => ({ ...b.revisions.get(3)!, revisionNumber: n }));
  const readCodes = vi.fn(async () => b.codes);
  const accepted = await readProcessSteps({ binding: h.binding, session: createDraftSession(h.store), partId: "part", readRevisions: async () => b.summaries, readRevision, readCodes,
    readDocument: async () => b.document!, readIdentity: async () => ({ id: "user", permissions: ["processes.view", "processes.edit"] }), accepted: () => {} });
  expect(accepted).toBe(true);
  expect(readRevision).not.toHaveBeenCalled();
  expect(readCodes).not.toHaveBeenCalled();
  expect(h.binding.getSnapshot().savedBaseline?.codes.length).toBeGreaterThan(0);
});
it("with the document supplied, a picked older revision is read on its own and the current one is not", async () => {
  const h = open(); const b = baseline();
  const older = { ...rev(2) };
  const readRevision = vi.fn(async (n: number) => n === 2 ? older : { ...b.revisions.get(3)!, revisionNumber: n });
  const summaries = [...b.summaries, { ...b.summaries[0], revisionNumber: 2 }];
  const accepted = await readProcessSteps({ binding: h.binding, session: createDraftSession(h.store), partId: "part", selectedRevision: 2, readRevisions: async () => summaries, readRevision, readCodes: vi.fn(async () => b.codes),
    readDocument: async () => b.document!, readIdentity: async () => ({ id: "user", permissions: ["processes.view", "processes.edit"] }), accepted: () => {} });
  expect(accepted).toBe(true);
  expect(readRevision.mock.calls.map(c => c[0])).toEqual([2]);
  expect(h.binding.getSnapshot().savedBaseline?.revisions.has(3)).toBe(true);
});
it("first-process unknown read keeps newly mapped late edits selected", async () => {
  const b = baseline(); const h = open({ ...b, highestRevision: null, revisions: new Map(), summaries: [], document: { ...b.document!, revision: null } });
  h.binding.change(d => ({ ...d, selectedRevision: null, orderedEdits: new Map([[0, [freshRow()]]]) }));
  const s = h.capture(); h.binding.change(d => ({ ...d, orderedEdits: new Map([[0, [{ ...freshRow(), instruction: "Late first-process edit" }]]]) })); h.binding.settle(s, { kind: "unknown" });
  const result = response([freshRow()]); const r = { ...result.baseline.revision!, revisionNumber: 1 }; const fresh = baseline(r);
  const accepted = await readProcessSteps({ binding: h.binding, session: createDraftSession(h.store), partId: "part", readRevisions: async () => fresh.summaries, readRevision: async () => r,
    readCodes: async () => fresh.codes, readDocument: async () => ({ ...result.baseline, revision: r }), readIdentity: async () => ({ id: "user", permissions: ["processes.view", "processes.edit"] }), accepted: () => {} });
  expect(accepted).toBe(true); expect(h.binding.getSnapshot().mode).toBe("editing");
  expect(h.binding.getSnapshot().current?.data.orderedEdits?.get(1)?.[0].instruction).toBe("Late first-process edit");
  expect(h.binding.getSnapshot().current?.data.selectedRevision).toBe(1);
});

it("keeps late number and ordered edits after an acknowledged number-only baseline change", () => {
  const h = open();
  h.binding.change(d => ({ ...d, recipeNumberEdit: "HELD-001" }));
  const submission = prepareProcessSteps(h.binding, { kind: "recipe-number", recipeNumber: "HELD-001", expectedRecipeNumber: null }, "number-ack")!.submission;
  expect(h.binding.dispatched(submission)).toBe(true);
  h.binding.change(d => ({ ...d, recipeNumberEdit: "HELD-002", orderedEdits: new Map([[3,
    processDraftSteps(d, h.binding.getSnapshot().current!.baseline, 3).map((step, index) => index === 0 ? { ...step, instruction: "Instruction typed during save" } : step),
  ]]) }));
  const acknowledged = baseline({ ...rev(), recipeNumber: "HELD-001" });
  acknowledged.document!.baselineToken = "acknowledged-number-token";
  h.binding.settle(submission, { kind: "persisted", response: { revisionNumber: 3, recipeNumber: "HELD-001", document: { baseline: acknowledged.document!, stepIdMap: {}, parameterKeys: {} } } });
  h.read(acknowledged);
  const view = h.binding.getSnapshot();
  expect(view.mode).toBe("editing"); expect(view.needsRefresh).toBe(false);
  expect(view.current!.data.recipeNumberEdit).toBe("HELD-002");
  expect(processDraftSteps(view.current!.data, view.current!.baseline, 3)[0].instruction).toBe("Instruction typed during save");
  const captured = prepareProcessSteps(h.binding, { kind: "document", document: { expectedBaselineToken: "ignored", steps: [] } }, "after-number")!;
  expect(captured.submission.payload.kind === "document" && captured.submission.payload.document.expectedBaselineToken).toBe("acknowledged-number-token");
  h.detach(); h.binding.attach("return-after-concurrent-change");
  h.read({ ...acknowledged, document: { ...acknowledged.document!, baselineToken: "later-independent-change" } });
  expect(h.binding.getSnapshot().canRestore).toBe(false);
  expect(h.binding.getSnapshot().current!.data.recipeNumberEdit).toBe("HELD-002");
});

it.each(["instruction", "identity", "row meaning", "code name"])("does not adopt unrelated %s changes from a recipe acknowledgement", change => {
  const h = open();
  h.binding.change(d => ({ ...d, recipeNumberEdit: "HELD-001" }));
  const submission = prepareProcessSteps(h.binding, { kind: "recipe-number", recipeNumber: "HELD-001", expectedRecipeNumber: null }, "unrelated-ack")!.submission;
  expect(h.binding.dispatched(submission)).toBe(true);
  h.change([freshRow()]);
  const originalRevision = rev();
  // A row's label, type and unit are the row's own now, so "row meaning" is a changed unit on the
  // acknowledged revision's first row; a suggestion (catalog field) edit would not be a change.
  const candidate = baseline({ ...originalRevision, recipeNumber: "HELD-001", steps: originalRevision.steps.map((step, index) => index === 0
    ? { ...step, ...(change === "instruction" ? { instruction: "Changed elsewhere" } : {}), ...(change === "identity" ? { id: "replacement-step" } : {}),
      ...(change === "row meaning" ? { parameters: step.parameters.map(p => ({ ...p, unit: "minutes" })) } : {}) }
    : step) });
  const acknowledged: ProcessStepsBaseline = { ...candidate, document: { ...candidate.document!, baselineToken: "unrelated-token", codes: candidate.document!.codes.map((code, index) => index === 0 && change === "code name"
    ? { ...code, name: "Renamed code" }
    : code) } };
  h.binding.settle(submission, { kind: "persisted", response: { revisionNumber: 3, recipeNumber: "HELD-001", document: { baseline: acknowledged.document!, stepIdMap: {}, parameterKeys: {} } } });
  h.read(acknowledged);
  const view = h.binding.getSnapshot();
  expect(view.mode).toBe("conflict"); expect(view.canRestore).toBe(false);
  expect(view.current!.data.orderedEdits?.get(3)?.[0].clientId).toBe(freshRow().clientId);
});
it("adopts a recipe acknowledgement whose only catalog difference is a suggestion edit", () => {
  const h = open();
  h.binding.change(d => ({ ...d, recipeNumberEdit: "HELD-001" }));
  const submission = prepareProcessSteps(h.binding, { kind: "recipe-number", recipeNumber: "HELD-001", expectedRecipeNumber: null }, "suggestion-ack")!.submission;
  expect(h.binding.dispatched(submission)).toBe(true);
  h.change([freshRow()]);
  const candidate = baseline({ ...rev(), recipeNumber: "HELD-001" });
  const acknowledged: ProcessStepsBaseline = { ...candidate, document: { ...candidate.document!, baselineToken: "suggestion-token",
    codes: candidate.document!.codes.map(code => ({ ...code, fields: code.fields.map(f => ({ ...f, label: "Renamed suggestion", type: "NUMBER", unit: "F" })) })) } };
  h.binding.settle(submission, { kind: "persisted", response: { revisionNumber: 3, recipeNumber: "HELD-001", document: { baseline: acknowledged.document!, stepIdMap: {}, parameterKeys: {} } } });
  expect(h.binding.getSnapshot().current!.baseline.document?.baselineToken).toBe("suggestion-token");
  h.read(acknowledged);
  expect(h.binding.getSnapshot().mode).toBe("editing");
  expect(h.binding.getSnapshot().current!.data.orderedEdits?.get(3)?.[0].clientId).toBe(freshRow().clientId);
});

// R11 (#659): the token hashes only the codes the saved steps name, so the draft check compares
// an ADDED step's code itself (owner answer 2026-11-03), and the two other catalog checks narrow
// to the same scope.
describe("the baseline token's scope on the client (R11, #659)", () => {
  const code = (id: string, name = id) => ({ id, code: id.toUpperCase(), name, active: true, defaultInstruction: "", fields: [] });
  /** Revision 3 with an `added` and an `other` code in the catalog, which no saved step names. */
  const wide = (codes = [code("added"), code("other")]): ProcessStepsBaseline => {
    const b = baseline(); return { ...b, document: { ...b.document!, codes: [...b.document!.codes, ...codes] } };
  };
  const addedRow = (): ProcessDraftStep => ({ ...freshRow(9), codeId: "added" });
  /** A read under the same token whose catalog differs only by `codes`. */
  const readWith = (h: ReturnType<typeof open>, codes: ReturnType<typeof code>[]) => h.read(wide(codes));
  it.each([
    ["renamed", [code("added", "Renamed"), code("other")]],
    ["re-coded", [{ ...code("added"), code: "ADX" }, code("other")]],
    ["deleted", [code("other")]],
  ] as const)("an added step's code %s under an unchanged token lands conflict mode", (_change, codes) => {
    const h = open(wide()); const rows = processDraftSteps(clean(), wide(), 3); h.change([...rows, addedRow()]);
    readWith(h, [...codes]);
    expect(h.binding.getSnapshot().mode).toBe("conflict");
    // As for any other change under a draft: Discard retained changes and Start fresh, no Restore.
    expect(h.binding.getSnapshot().canRestore).toBe(false);
  });
  it("a rename of a code the draft neither names nor adds leaves the draft editing, and Save names the code as the catalog shows it now", () => {
    const h = open(wide()); const rows = processDraftSteps(clean(), wide(), 3); h.change([...rows, addedRow()]);
    readWith(h, [code("added"), code("other", "Renamed")]);
    expect(h.binding.getSnapshot().mode).toBe("editing");
    const s = h.capture();
    expect(s.payload.kind === "document" && s.payload.document.steps.map(st => st.codeSeen)).toEqual([undefined, undefined, { code: "ADDED", name: "added" }]);
  });
  it("an unknown outcome reconciles across a rename of a code the submission does not name, and not across one it adds", () => {
    for (const [renamed, reconciles] of [["other", true], ["added", false]] as const) {
      const h = open(wide()); const submitted = [{ ...addedRow() }]; h.change(submitted); const s = h.capture(); h.binding.settle(s, { kind: "unknown" });
      const result = response(submitted);
      const codes = wide().document!.codes.map(c => c.id === renamed ? { ...c, name: "Renamed" } : c);
      h.read({ ...baseline(result.baseline.revision!), document: { ...result.baseline, codes } });
      expect(h.binding.getSnapshot().current?.data.submittedDocument === undefined).toBe(reconciles);
    }
  });
  it("a recipe acknowledgement is adopted across a rename of a code no step names or adds, and not across one the draft adds", () => {
    for (const [renamed, adopted] of [["other", true], ["added", false]] as const) {
      const h = open(wide());
      h.binding.change(d => ({ ...d, recipeNumberEdit: "HELD-001" }));
      const submission = prepareProcessSteps(h.binding, { kind: "recipe-number", recipeNumber: "HELD-001", expectedRecipeNumber: null }, "ack")!.submission;
      expect(h.binding.dispatched(submission)).toBe(true);
      h.change([...processDraftSteps(clean(), wide(), 3), addedRow()]);
      const candidate = wide();
      const acknowledged = { ...candidate.document!, baselineToken: "number-token", codes: candidate.document!.codes.map(c => c.id === renamed ? { ...c, name: "Renamed" } : c),
        revision: { ...candidate.document!.revision!, recipeNumber: "HELD-001" } };
      h.binding.settle(submission, { kind: "persisted", response: { revisionNumber: 3, recipeNumber: "HELD-001", document: { baseline: acknowledged, stepIdMap: {}, parameterKeys: {} } } });
      expect(h.binding.getSnapshot().current!.baseline.document?.baselineToken === "number-token").toBe(adopted);
    }
  });
});
