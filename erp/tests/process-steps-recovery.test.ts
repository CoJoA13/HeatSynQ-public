import { expect, it } from "vitest";
import { createDraftStore } from "../src/lib/draft-store";
import { processStepsRecoveryAdapter as adapter, processDraftSteps, processStepsLand, prepareProcessSteps,
  type ProcessStepsBaseline, type ProcessStepsDraft, type ProcessStepsIntent, type ProcessRevision } from "../src/lib/process-steps-recovery";
import type { ProcessDraftStep, ProcessDocumentResult, ProcessParameterInput } from "../src/lib/process-document";
const revision = (n = 3, a = "step-old", b = "sibling-old"): ProcessRevision => ({ revisionNumber: n, lockedAt: n === 3 ? "2026-09-01" : null, steps: [
  { id: a, codeId: "code", position: 1, code: "C", codeName: "Code", instruction: "original instruction", parameters: [
    { key: "temperature", label: "Temperature", type: "NUMBER", unit: "F", position: 0, value: "500" },
    { key: "checkbox", label: "Checkbox", type: "CHECKBOX", unit: null, position: 1, value: "true" },
  ] },
  { id: b, codeId: "code", position: 2, code: "C", codeName: "Code", instruction: "sibling original", parameters: [] },
] });
const baseline = (r = revision()): ProcessStepsBaseline => ({ partId: "part", permissions: ["processes.view", "processes.edit"], highestRevision: r.revisionNumber,
  codesReady: true,
  summaries: [{ revisionNumber: r.revisionNumber, lockedAt: r.lockedAt, stepCount: 2, orderCount: 2, createdAt: "2026-09-01" }], revisions: new Map([[r.revisionNumber, r]]),
  codes: [{ id: "code", code: "C", name: "Code", active: true, fields: [
    { id: "temperature", label: "Temperature", type: "NUMBER", unit: "F", sort: 0 },
    { id: "checkbox", label: "Checkbox", type: "CHECKBOX", unit: null, sort: 1 },
    { id: "default-empty", label: "Unstored field", type: "TEXT", unit: null, sort: 2 },
  ] }],
});
/** The same baseline with the document the atomic save needs (an editor with `processes.view`). */
const documentBaseline = (r = revision()): ProcessStepsBaseline => {
  const b = baseline(r);
  return { ...b, document: { revision: r, baselineToken: `token${r.revisionNumber}`, codes: b.codes.map(c => ({ ...c, defaultInstruction: "" })) } };
};
const clean = (n: number | null = 3): ProcessStepsDraft => ({ selectedRevision: n, pendingRekey: null });
// A revision cut from a recipe-number save: every step of revision 3 copied to a new id on 4.
const cut = { "step-old": "step-new", "sibling-old": "sibling-new" };
function open(b = baseline()) {
  const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "user")!;
  const binding = store.bind({ owner, record: { kind: "part", id: "part" }, editor: adapter.kind }, { label: "Process steps", href: "/parts/part" }, adapter);
  const detach = binding.attach("first"); const read = (fresh: ProcessStepsBaseline) => { const id = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId: id, editable: true, baseline: fresh }, clean(fresh.highestRevision)); return id; }; read(b);
  // Every edit lands in the whole ordered draft of one revision, as the editor's changeRows does.
  const editRows = (rev: number, change: (step: ProcessDraftStep) => ProcessDraftStep, step: string) => {
    const view = binding.getSnapshot(); const accepted = (view.current?.baseline ?? view.savedBaseline)!;
    binding.change(d => ({ ...d, orderedEdits: new Map(d.orderedEdits).set(rev, processDraftSteps(d, accepted, rev).map(s => s.stepId === step ? change(s) : s)) }));
  };
  const edit = (step: string, instruction: string, rev = 3) => editRows(rev, s => ({ ...s, instruction }), step);
  const setValue = (step: string, key: string, value: string, rev = 3) => editRows(rev, s => ({ ...s, parameters: s.parameters.map(p => p.key === key ? { ...p, value } : p) }), step);
  const setParameters = (step: string, parameters: (rows: ProcessParameterInput[]) => ProcessParameterInput[], rev = 3) => editRows(rev, s => ({ ...s, parameters: parameters(s.parameters) }), step);
  const capture = (intent: ProcessStepsIntent, id = "save") => { const s = binding.capture(intent, id); binding.dispatched(s); return s; };
  const number = (id = "number") => capture({ kind: "recipe-number", recipeNumber: "001", expectedRecipeNumber: null }, id);
  // The document save: `prepareProcessSteps` builds the submitted document from the draft itself.
  const saveDocument = (id = "document") => { const prepared = prepareProcessSteps(binding, { kind: "document", document: { expectedBaselineToken: "ignored", steps: [] } }, id)!; expect(prepared).not.toBeNull(); binding.dispatched(prepared.submission); return prepared.submission; };
  return { store, binding, detach, read, edit, setValue, setParameters, capture, number, saveDocument };
}
/** A save's answer for revision 3 amended in place: the acknowledged rows are `steps`' rows with the
 *  keys the server chose, and `parameterKeys` reports those keys per submitted row index. */
function acknowledged(steps: readonly ProcessDraftStep[], keys: Record<string, string[]>): ProcessDocumentResult {
  const r = revision(3);
  const saved: ProcessRevision = { ...r, steps: steps.map((s, i) => ({ id: s.stepId!, position: i + 1, codeId: s.codeId, code: "C", codeName: "Code", instruction: s.instruction,
    parameters: s.parameters.map((p, index) => ({ key: keys[s.clientId][index], label: p.label, type: p.type, unit: p.unit, position: index, value: p.value })) })) };
  return { baseline: { revision: saved, baselineToken: "token3-after", codes: documentBaseline().document!.codes }, stepIdMap: Object.fromEntries(steps.map(s => [s.clientId, s.stepId!])), parameterKeys: keys };
}
it("Restore retains the selected revision and an ordered draft's cleared stored value against its actual original", () => {
  const b = baseline(); const withOld = { ...b, revisions: new Map([[2, revision(2, "older", "older-b")], ...b.revisions]), summaries: [...b.summaries, { revisionNumber: 2, lockedAt: null, stepCount: 2, orderCount: 0, createdAt: "old" }] };
  const h = open(withOld); h.setValue("step-old", "temperature", ""); h.binding.change(d => ({ ...d, selectedRevision: 2 }));
  expect(h.store.getSnapshot().count).toBe(1); h.detach(); h.binding.attach("return");
  expect(h.binding.getSnapshot().current).toBeUndefined();
  const id = h.read(withOld);
  expect(h.binding.getSnapshot().mode).toBe("offer"); expect(h.binding.restore(h.binding.getSnapshot().current!.stamp, id)).toBe(true);
  expect(h.binding.getSnapshot().current?.data.selectedRevision).toBe(2);
  expect(h.binding.getSnapshot().current?.data.orderedEdits?.get(3)?.[0].parameters).toEqual([
    { key: "temperature", label: "Temperature", type: "NUMBER", unit: "F", value: "" }, { key: "checkbox", label: "Checkbox", type: "CHECKBOX", unit: null, value: "true" },
  ]);
  expect(h.binding.getSnapshot().current?.baseline.revisions.get(3)?.steps[0].parameters[0].value).toBe("500");
});
it("the saved rows are clean; clearing a stored value or adding a blank row is dirty", () => {
  const b = baseline(); const rows = processDraftSteps(clean(), b, 3);
  const withRows = (parameters: (rows: ProcessParameterInput[]) => ProcessParameterInput[]) => rows.map((s, i) => i === 0 ? { ...s, parameters: parameters(s.parameters) } : s);
  expect(adapter.dirty({ ...clean(), orderedEdits: new Map([[3, rows]]) }, b)).toBe(false);
  expect(adapter.dirty({ ...clean(), orderedEdits: new Map([[3, withRows(p => p.map(row => row.key === "temperature" ? { ...row, value: "" } : row))]]) }, b)).toBe(true);
  expect(adapter.dirty({ ...clean(), orderedEdits: new Map([[3, withRows(p => [...p, { key: "new:11111111-1111-4111-8111-111111111111", label: "Load", type: "TEXT", unit: null, value: "" }])]]) }, b)).toBe(true);
});
it("wrong revision retains stage; matching fresh rows land mapping, ordered draft and baseline together", () => {
  const h = open(); h.edit("step-old", "retain instruction");
  const s = h.number(); h.binding.settle(s, { kind: "persisted", response: { recipeNumber: "001", revisionNumber: 4, stepIdMap: cut } });
  const current = h.binding.getSnapshot().current!;
  expect(current.data.pendingRekey).toEqual({ toRevision: 4, fromRevision: 3, map: cut });
  const wrong = processStepsLand(current, baseline(revision(2, "old-two", "sibling-two")))!;
  expect(wrong.data.pendingRekey?.toRevision).toBe(4); expect(wrong.data.orderedEdits?.get(3)?.[0].instruction).toBe("retain instruction");
  const fresh = baseline(revision(4, "step-new", "sibling-new")); const landed = processStepsLand(current, fresh)!;
  expect(landed.data.pendingRekey).toBeNull();
  expect(landed.data.orderedEdits?.get(4)?.map(s => [s.stepId, s.instruction])).toEqual([["step-new", "retain instruction"], ["sibling-new", "sibling original"]]);
  expect(landed.data.orderedEdits?.has(3)).toBe(false); expect(landed.data.selectedRevision).toBe(4); expect(landed.baseline).toEqual(fresh);
  expect(current.data.pendingRekey?.toRevision).toBe(4); expect(current.data.orderedEdits?.get(3)?.[0].instruction).toBe("retain instruction");
});
it("valid own pending mapping is offered on return and consumed only by explicit Restore", () => {
  const h = open(); h.edit("step-old", "mine"); const s = h.number();
  h.binding.settle(s, { kind: "persisted", response: { recipeNumber: "001", revisionNumber: 4, stepIdMap: cut } });
  h.detach(); h.binding.attach("return"); const id = h.read(baseline(revision(4, "step-new", "sibling-new")));
  expect(h.binding.getSnapshot().canRestore).toBe(true); expect(h.binding.getSnapshot().current?.data.pendingRekey?.toRevision).toBe(4);
  expect(h.binding.restore(h.binding.getSnapshot().current!.stamp, id)).toBe(true);
  expect(h.binding.getSnapshot().current?.data.orderedEdits?.get(4)?.[0]).toMatchObject({ stepId: "step-new", instruction: "mine" });
  expect(h.binding.getSnapshot().current?.data.pendingRekey).toBeNull();
});
it("chained own cuts compose through the previous target, and the landing maps rows by identity, not position", () => {
  const h = open(); const b = h.binding.getSnapshot().current!.baseline;
  h.binding.change(d => { const [step, sibling] = processDraftSteps(d, b, 3); return { ...d, orderedEdits: new Map([[3, [sibling, { ...step, instruction: "keep" }]]]) }; });
  const s = h.number("one"); const t = h.number("two");
  h.binding.settle(s, { kind: "persisted", response: { recipeNumber: "001", revisionNumber: 4, stepIdMap: { "step-old": "step-middle", "sibling-old": "sibling-middle" } } });
  h.binding.settle(t, { kind: "persisted", response: { recipeNumber: "001", revisionNumber: 5, stepIdMap: { "step-middle": "step-final", "sibling-middle": "sibling-final" } } });
  const current = h.binding.getSnapshot().current!; expect(current.data.pendingRekey?.toRevision).toBe(5); expect(current.data.pendingRekey?.map["step-old"]).toBe("step-final");
  const landed = processStepsLand(current, baseline(revision(5, "step-final", "sibling-final")))!;
  expect(landed.data.orderedEdits?.get(5)?.map(s => [s.stepId, s.instruction])).toEqual([["sibling-final", "sibling original"], ["step-final", "keep"]]);
});
it.each(["external IDs", "missing endpoint", "changed code", "target original"])("%s cannot authorize recovery", kind => {
  const h = open(); h.setValue("step-old", "temperature", "600");
  if (kind === "missing endpoint") { const s = h.number(); h.binding.settle(s, { kind: "persisted", response: { recipeNumber: "001", revisionNumber: 4, stepIdMap: { "step-old": "absent" } } }); }
  h.detach(); h.binding.attach("return"); const b = baseline();
  let fresh = b;
  if (kind === "external IDs" || kind === "missing endpoint") fresh = baseline(revision(4, "external", "external-b"));
  if (kind === "changed code") fresh = { ...b, revisions: new Map([[3, { ...revision(), steps: revision().steps.map(s => s.id === "step-old" ? { ...s, codeId: "other-code" } : s) }]]) };
  if (kind === "target original") fresh = { ...b, revisions: new Map([[3, { ...revision(), steps: revision().steps.map(s => s.id === "step-old" ? { ...s, parameters: s.parameters.map(p => p.key === "temperature" ? { ...p, value: "700" } : p) } : s) }]]) };
  h.read(fresh); expect(h.binding.getSnapshot().canRestore).toBe(false); expect(h.binding.getSnapshot().mode).toBe("conflict");
  expect(h.binding.getSnapshot().current?.data.orderedEdits?.get(3)?.[0].parameters.find(p => p.key === "temperature")?.value).toBe("600");
});
it.each(["unit", "type"])("a row's %s changed under a staged cut cannot land: the landing compares the rows themselves, not the catalog", change => {
  // Task 1 review's check item: while a cut is staged `matches` skips the token check, so what
  // protects the landing is the row comparison. A row's type and unit are the row's own, so a
  // change to either between the cut and its landing is a content mismatch (a suggestion edit,
  // by contrast, changes no row and is not one).
  const h = open(); h.edit("step-old", "retain instruction");
  const s = h.number(); h.binding.settle(s, { kind: "persisted", response: { recipeNumber: "001", revisionNumber: 4, stepIdMap: cut } });
  const current = h.binding.getSnapshot().current!;
  const changed = revision(4, "step-new", "sibling-new");
  const fresh = baseline({ ...changed, steps: changed.steps.map(st => st.id === "step-new" ? { ...st, parameters: st.parameters.map(p => p.key === "temperature" ? (change === "unit" ? { ...p, unit: "C" } : { ...p, type: "TEXT" as const }) : p) } : st) });
  expect(processStepsLand(current, fresh)).toBeNull();
  const unchanged = baseline(changed);
  const suggestionOnly: ProcessStepsBaseline = { ...unchanged, codes: unchanged.codes.map(c => ({ ...c, fields: c.fields.map(f => f.id === "temperature" ? { ...f, unit: "C", label: "Renamed" } : f) })) };
  expect(processStepsLand(current, suggestionOnly)?.data.orderedEdits?.get(4)?.[0].instruction).toBe("retain instruction");
});
it("an old selected revision never dispatches and a no-op never captures", () => {
  const b = baseline(); const h = open({ ...b, revisions: new Map([[2, revision(2, "older", "older-b")], ...b.revisions]), summaries: [...b.summaries, { revisionNumber: 2, lockedAt: null, stepCount: 2, orderCount: 0, createdAt: "old" }] });
  const intent: ProcessStepsIntent = { kind: "recipe-number", recipeNumber: "001", expectedRecipeNumber: null };
  expect(prepareProcessSteps(h.binding, intent, "noop")).toBeNull();
  h.binding.change(d => ({ ...d, selectedRevision: 2, recipeNumberEdit: "001" }));
  expect(h.binding.getSnapshot().current?.data.selectedRevision).toBe(2);
  expect(prepareProcessSteps(h.binding, intent, "old")).toBeNull();
  expect(h.binding.getSnapshot().submitted).toBeUndefined();
  // The same number on the current revision does capture, so the refusal above is the revision's.
  h.binding.change(d => ({ ...d, selectedRevision: 3 }));
  expect(prepareProcessSteps(h.binding, intent, "current")).not.toBeNull();
});
it("retains both conflicting references until explicit dismissal; no third generation", () => {
  const h = open(); h.edit("step-old", "first"); h.detach(); h.binding.attach("return"); const fresh = baseline(revision(4, "step-new", "sibling-new")); const id = h.read(fresh);
  expect(h.binding.startFresh(id, clean(4))).toBe(true); h.edit("step-new", "second", 4);
  const latest = h.read(baseline(revision(5, "step-third", "sibling-third")));
  expect(h.binding.getSnapshot().mode).toBe("blocked-two-copies"); expect(h.binding.startFresh(latest, clean(5))).toBe(false);
  expect(h.binding.getSnapshot().reference?.data.orderedEdits?.get(3)?.[0].instruction).toBe("first");
  expect(h.binding.getSnapshot().current?.data.orderedEdits?.get(4)?.[0].instruction).toBe("second");
});
it("late recipe-number response cannot rekey a replacement generation", () => {
  const h = open(); h.edit("step-old", "old"); const s = h.number(); h.binding.discard(h.binding.getSnapshot().current!.stamp); h.edit("step-old", "replacement"); const current = h.binding.getSnapshot().current;
  h.binding.settle(s, { kind: "persisted", response: { recipeNumber: "001", revisionNumber: 4, stepIdMap: { "step-old": "step-new" } } });
  expect(h.binding.getSnapshot().current).toBe(current); expect(current?.data.pendingRekey).toBeNull();
});

it("keeps a recipe number typed while the previous number saves", () => {
  const h = open();
  h.binding.change(d => ({ ...d, recipeNumberEdit: "A" }));
  const intent: ProcessStepsIntent = { kind: "recipe-number", recipeNumber: "A", expectedRecipeNumber: null };
  const ready = prepareProcessSteps(h.binding, intent, "save")!;
  expect(ready).not.toBeNull();
  h.binding.dispatched(ready.submission);
  h.binding.change(d => ({ ...d, recipeNumberEdit: "B" }));
  h.binding.settle(ready.submission, { kind: "persisted", response: {
    recipeNumber: "A", revisionNumber: 4,
    stepIdMap: cut,
  } });
  expect(h.binding.getSnapshot().current?.data.recipeNumberEdit).toBe("B");
  expect(h.store.getSnapshot().count).toBe(1);
});
it("acknowledges a number-only cut and maps pending step values", () => {
  const h = open();
  h.binding.change(d => ({ ...d, recipeNumberEdit: "001207" })); h.setValue("step-old", "temperature", "600");
  const s = h.capture({ kind: "recipe-number", recipeNumber: "001207", expectedRecipeNumber: null });
  h.binding.settle(s, { kind: "persisted", response: { recipeNumber: "001207", revisionNumber: 4, stepIdMap: cut } });
  const current = h.binding.getSnapshot().current!;
  expect(current.data.recipeNumberEdit).toBeUndefined();
  const landed = processStepsLand(current, baseline({ ...revision(4, "step-new", "sibling-new"), recipeNumber: "001207" }))!;
  expect(landed.data.orderedEdits?.get(4)?.[0].stepId).toBe("step-new");
  expect(landed.data.orderedEdits?.get(4)?.[0].parameters.find(p => p.key === "temperature")?.value).toBe("600");
});
it.each([false, true])("keeps an emptied local process draft through a recipe-number save (cut: %s)", withCut => {
  // Task 2 review's carried case: "All steps removed" is a draft, not the absence of one, and a
  // number save must carry it, with or without the revision cut the number can cause.
  const h = open();
  h.binding.change(d => ({ ...d, orderedEdits: new Map([[3, []]]), recipeNumberEdit: "001" }));
  expect(adapter.dirty(h.binding.getSnapshot().current!.data, h.binding.getSnapshot().current!.baseline)).toBe(true);
  const s = h.number();
  h.binding.settle(s, { kind: "persisted", response: withCut ? { recipeNumber: "001", revisionNumber: 4, stepIdMap: cut } : { recipeNumber: "001", revisionNumber: 3, stepIdMap: {} } });
  const current = h.binding.getSnapshot().current!;
  if (withCut) {
    const landed = processStepsLand(current, baseline({ ...revision(4, "step-new", "sibling-new"), recipeNumber: "001" }))!;
    expect(landed.data.orderedEdits?.get(4)).toEqual([]); expect(landed.data.orderedEdits?.has(3)).toBe(false);
    expect(processDraftSteps(landed.data, landed.baseline, 4)).toEqual([]);
    expect(adapter.dirty(landed.data, landed.baseline)).toBe(true);
  } else {
    expect(current.data.pendingRekey).toBeNull();
    expect(current.data.orderedEdits?.get(3)).toEqual([]);
    expect(processDraftSteps(current.data, current.baseline, 3)).toEqual([]);
    expect(adapter.dirty(current.data, current.baseline)).toBe(true);
  }
});
it("reconciles an uncertain number save conservatively and preserves later input", () => {
  const h = open(baseline({ ...revision(), lockedAt: null, recipeNumber: null }));
  h.binding.change(d => ({ ...d, recipeNumberEdit: "A" }));
  const s = h.capture({ kind: "recipe-number", recipeNumber: "A", expectedRecipeNumber: null });
  h.binding.change(d => ({ ...d, recipeNumberEdit: "B" }));
  h.binding.settle(s, { kind: "unknown" });
  h.read(baseline({ ...revision(), lockedAt: null, recipeNumber: "A" }));
  expect(h.binding.getSnapshot().current?.data.recipeNumberEdit).toBe("B");
  expect(h.binding.getSnapshot().canRestore).toBe(false);
  expect(h.binding.getSnapshot().mode).toBe("conflict");
});
it("keeps the next recipe edit after an acknowledged cut lands", () => {
  const h = open(); h.binding.change(d => ({ ...d, recipeNumberEdit: "A" }));
  const s = h.capture({ kind: "recipe-number", recipeNumber: "A", expectedRecipeNumber: null });
  h.binding.change(d => ({ ...d, recipeNumberEdit: "B" }));
  h.binding.settle(s, { kind: "persisted", response: { recipeNumber: "A", revisionNumber: 4, stepIdMap: cut } });
  h.read(baseline({ ...revision(4, "step-new", "sibling-new"), recipeNumber: "A" }));
  expect(h.binding.getSnapshot().current?.data.recipeNumberEdit).toBe("B");
  expect(h.binding.getSnapshot().mode).toBe("editing");
  expect(h.store.getSnapshot().count).toBe(1);
});
it("a null-revision no-op does not create a pending mapping or revision", () => {
  const h = open({ ...baseline(), highestRevision: null, revisions: new Map(), summaries: [] });
  const s = h.capture({ kind: "recipe-number", recipeNumber: null, expectedRecipeNumber: null });
  h.binding.settle(s, { kind: "persisted", response: { recipeNumber: null, revisionNumber: null } });
  expect(h.binding.getSnapshot().current?.data.pendingRekey).toBeNull();
  expect(h.binding.getSnapshot().current?.baseline.highestRevision).toBeNull();
  expect(h.binding.getSnapshot().current?.baseline.revisions.size).toBe(0);
});
it("every summary carries its order count (owner ruling 2026-09-26): one without it is invalid, a settled cut starts on no order, an amended revision keeps its count", () => {
  const b = baseline();
  expect(adapter.valid(clean(), b)).toBe(true);
  const without = { ...b.summaries[0] } as Record<string, unknown>; delete without.orderCount;
  expect(adapter.valid(clean(), { ...b, summaries: [without as unknown as ProcessStepsBaseline["summaries"][number]] })).toBe(false);
  expect(adapter.valid(clean(), { ...b, summaries: [{ ...b.summaries[0], orderCount: "2" as unknown as number }] })).toBe(false);
  // A recipe-number save that cuts revision 4: nothing has saved the new revision yet; 3 keeps its two.
  const h = open(); h.binding.change(d => ({ ...d, recipeNumberEdit: "001" }));
  h.binding.settle(h.number(), { kind: "persisted", response: { recipeNumber: "001", revisionNumber: 4, stepIdMap: cut } });
  expect(h.binding.getSnapshot().current?.baseline.summaries.map(s => [s.revisionNumber, s.orderCount])).toEqual([[4, 0], [3, 2]]);
  // A number acknowledged on the same revision leaves its count alone.
  const same = open(); same.binding.change(d => ({ ...d, recipeNumberEdit: "001" }));
  same.binding.settle(same.number(), { kind: "persisted", response: { recipeNumber: "001", revisionNumber: 3, stepIdMap: {} } });
  expect(same.binding.getSnapshot().current?.baseline.summaries.map(s => [s.revisionNumber, s.orderCount])).toEqual([[3, 2]]);
});
it("the adapter declares the v2 draft schema", () => {
  // Owner ruling 2026-09-26: drafts live only in the open tab's memory, so no v1 draft survives the
  // reload that installs the one save path, and none is converted.
  expect(adapter.schema).toBe("process-steps-v2");
});

const A: ProcessParameterInput = { key: "new:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", label: "Load", type: "TEXT", unit: null, value: "a" };
const B: ProcessParameterInput = { key: "new:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", label: "Fixture", type: "TEXT", unit: null, value: "b" };
it("adopts acknowledged keys by identity: two hand-added rows swapped in flight each carry the key returned for them", () => {
  const h = open(documentBaseline());
  h.setParameters("step-old", rows => [...rows, A, B]);
  const s = h.saveDocument();
  expect(s.payload.kind === "document" && s.payload.document.steps[0].parameters.map(p => p.key)).toEqual(["temperature", "checkbox", A.key, B.key]);
  // While the save is in flight: the two new rows are swapped and one is edited.
  h.setParameters("step-old", rows => [rows[0], rows[1], rows[3], { ...rows[2], value: "a2" }]);
  const submitted = s.payload.kind === "document" ? s.payload.document.steps : [];
  h.binding.settle(s, { kind: "persisted", response: { revisionNumber: 3, document: acknowledged(submitted, { "step-old": ["temperature", "checkbox", "KEY-A", "KEY-B"], "sibling-old": [] }) } });
  const rows = h.binding.getSnapshot().current!.data.orderedEdits!.get(3)![0].parameters;
  expect(rows.map(p => [p.key, p.label, p.value])).toEqual([["temperature", "Temperature", "500"], ["checkbox", "Checkbox", "true"], ["KEY-B", "Fixture", "b"], ["KEY-A", "Load", "a2"]]);
  expect(h.binding.getSnapshot().current!.baseline.revisions.get(3)!.steps[0].parameters.map(p => p.key)).toEqual(["temperature", "checkbox", "KEY-A", "KEY-B"]);
});
it("a suggested NUMBER row re-keyed by a unit change carries the returned key even when its unit changed again in flight", () => {
  const h = open(documentBaseline());
  h.setParameters("step-old", rows => rows.map(p => p.key === "temperature" ? { ...p, unit: "C" } : p));
  const s = h.saveDocument();
  // In flight: the unit changes again. The acknowledged key is the row's new origin; the next
  // save re-keys from it instead of rejecting a NUMBER row whose old key nothing holds any more.
  h.setParameters("step-old", rows => rows.map(p => p.key === "temperature" ? { ...p, unit: "K" } : p));
  const submitted = s.payload.kind === "document" ? s.payload.document.steps : [];
  const result = acknowledged(submitted, { "step-old": ["KEY-T", "checkbox"], "sibling-old": [] });
  h.binding.settle(s, { kind: "persisted", response: { revisionNumber: 3, document: result } });
  const local = h.binding.getSnapshot().current!.data.orderedEdits!.get(3)![0].parameters[0];
  expect(local).toMatchObject({ key: "KEY-T", type: "NUMBER", unit: "K" });
  // The editor reloads after a save; the fresh read matches the acknowledged baseline and the
  // following save submits the re-keyed row against its new origin.
  h.read({ ...documentBaseline(result.baseline.revision!), document: result.baseline });
  expect(h.binding.getSnapshot().mode).toBe("editing");
  const next = h.saveDocument("following");
  expect(next.payload.kind === "document" && next.payload.document.steps[0].parameters[0]).toMatchObject({ key: "KEY-T", type: "NUMBER", unit: "K" });
});
it("a local row whose key names no submitted row keeps its key for the next save", () => {
  const h = open(documentBaseline());
  h.setParameters("step-old", rows => [...rows, A]);
  const s = h.saveDocument();
  h.setParameters("step-old", rows => [...rows, B]); // added after dispatch: not in the answer
  const submitted = s.payload.kind === "document" ? s.payload.document.steps : [];
  h.binding.settle(s, { kind: "persisted", response: { revisionNumber: 3, document: acknowledged(submitted, { "step-old": ["temperature", "checkbox", "KEY-A"], "sibling-old": [] }) } });
  expect(h.binding.getSnapshot().current!.data.orderedEdits!.get(3)![0].parameters.map(p => p.key)).toEqual(["temperature", "checkbox", "KEY-A", B.key]);
});
