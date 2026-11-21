import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { PROVISIONAL_KEY, parametersFromSuggestions, type ProcessDocumentStep, type ProcessDraftStep, type ProcessParameterInput } from "@/lib/process-document";
import { appendProcessStep, readProcessDocument, resolveParameterKeys, sameStoredRows, saveProcessDocument } from "@/server/process-document";
import * as processHelpers from "@/server/part-process-steps";
import { getRevision, lockRevision, lockCurrentRevision, saveRecipeNumber } from "@/server/part-process-steps";
import { setStepFields, updateStepCodeWithFields } from "@/server/process-step-codes";
const asSystem = <T>(fn: () => Promise<T>) => runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);
const provisional = () => `new:${randomUUID()}`;
const text = (label: string, value = ""): ProcessParameterInput => ({ key: provisional(), label, type: "TEXT", unit: null, value });
/** A step added in the editor: it names the code and name the operator saw (R11, owner ruling
 *  2026-11-02), as `documentSteps` attaches them. */
const fresh = (code: { id: string; code: string; name: string }, instruction = "", parameters: ProcessParameterInput[] = []): ProcessDocumentStep =>
  ({ clientId: provisional(), stepId: null, codeId: code.id, codeSeen: { code: code.code, name: code.name }, instruction, parameters });
async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
  const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P1", eachWeight: 1 } });
  const code = await prisma.processStepCode.create({ data: { code: "HT", name: "Heat", defaultInstruction: "Default" } });
  const field = await prisma.processStepFieldDef.create({ data: { codeId: code.id, label: "Temperature", type: "NUMBER", unit: "F", sort: 1 } });
  // A TEXT suggestion beside the NUMBER one: a hand-added or unverifiable row is only re-keyed
  // when it is text; every other type is refused (spec §3.1).
  const note = await prisma.processStepFieldDef.create({ data: { codeId: code.id, label: "Note", type: "TEXT", unit: null, sort: 2 } });
  return { part, code, field, note };
}
/** The saved document as the editor submits it: rows with their keys, no positions. */
async function draft(partId: string) {
  const baseline = await readProcessDocument(partId);
  return { expectedBaselineToken: baseline.baselineToken, steps: (baseline.revision?.steps ?? []).map<ProcessDraftStep>(s => ({
    clientId: s.id, stepId: s.id, codeId: s.codeId, instruction: s.instruction,
    parameters: s.parameters.map(p => ({ key: p.key, label: p.label, type: p.type, unit: p.unit, value: p.value })),
  })) };
}
async function suggestions(partId: string, codeId: string) {
  return parametersFromSuggestions((await readProcessDocument(partId)).codes.find(c => c.id === codeId)!);
}
/** The stored rows of one revision, step by step, in position order. */
async function rowsOf(partId: string, revisionNumber: number) {
  const steps = await prisma.partProcessStep.findMany({
    where: { revision: { partId, revisionNumber } }, orderBy: { position: "asc" },
    include: { parameters: { orderBy: { position: "asc" } } },
  });
  return steps.map(s => s.parameters.map(p => ({ position: p.position, key: p.key, label: p.label, type: p.type, unit: p.unit, value: p.value })));
}
const isFreshKey = (key: string, ...never: string[]) => key.length > 0 && !PROVISIONAL_KEY.test(key) && !never.includes(key);

describe("resolveParameterKeys (spec §3.3, pure)", () => {
  const saved = [{ key: "s-num", type: "NUMBER", unit: "F" }, { key: "s-text", type: "TEXT", unit: null }];
  const row = (key: string, type: ProcessParameterInput["type"] = "TEXT", unit: string | null = null): ProcessParameterInput => ({ key, label: "Row", type, unit, value: "" });
  it("keeps an origin's key only while its type and unit are unchanged, claims each origin once, and re-keys the rest", () => {
    const keys = resolveParameterKeys(saved, [row("s-num", "NUMBER", " F "), row("s-text"), row("s-text")], []);
    expect(keys.slice(0, 2)).toEqual(["s-num", "s-text"]);
    expect(isFreshKey(keys[2], "s-num", "s-text")).toBe(true); // the second claim of one origin is a hand-added row
    const [reunit, retyped] = resolveParameterKeys(saved, [row("s-num", "NUMBER", "C"), row("s-text", "NUMBER")], []);
    expect(isFreshKey(reunit, "s-num")).toBe(true); expect(isFreshKey(retyped, "s-text")).toBe(true);
    expect(resolveParameterKeys([], [row("sg", "NUMBER", "F")], [{ id: "sg", type: "NUMBER", unit: "F" }])).toEqual(["sg"]);
  });
  it("refuses a non-text row that names no origin: provisional, unknown, a claimed origin or a suggestion an existing step never carried", () => {
    const refusal = expect.objectContaining({ status: 400, message: `"Row" was added by hand, so it must be text` });
    for (const type of ["NUMBER", "DATE", "CHECKBOX"] as const) {
      expect(() => resolveParameterKeys(saved, [row(provisional(), type)], [])).toThrow(refusal);
      expect(() => resolveParameterKeys(saved, [row("unknown", type)], [])).toThrow(refusal);
      expect(() => resolveParameterKeys(saved, [row("s-num", "NUMBER", "F"), row("s-num", type, "F")], [])).toThrow(refusal);
      expect(() => resolveParameterKeys(saved, [row("sg", type)], [])).toThrow(refusal);
    }
    expect(isFreshKey(resolveParameterKeys(saved, [row(provisional())], [])[0])).toBe(true);
  });
});

describe("appendProcessStep (the seed and fixture helper on the one save path)", () => {
  beforeEach(truncateAll);
  it("appends a step with the code's standard instruction when none is given", async () => {
    const { part, code } = await fixture();
    await prisma.processStepCode.update({ where: { id: code.id }, data: { defaultInstruction: "Hold at heat." } });
    const first = await appendProcessStep(part.id, { codeId: code.id });
    const second = await appendProcessStep(part.id, { codeId: code.id, instruction: "Second pass." });
    const rev = await getRevision(part.id, second.revisionNumber);
    expect(rev.steps.map(s => [s.id, s.instruction])).toEqual([[first.stepId, "Hold at heat."], [second.stepId, "Second pass."]]);
  });
  it("cuts the next revision when the current one is locked, like any document save", async () => {
    const { part, code } = await fixture();
    const first = await appendProcessStep(part.id, { codeId: code.id, instruction: "A" });
    await prisma.$transaction(tx => lockRevision(part.id, first.revisionNumber, tx));
    const next = await appendProcessStep(part.id, { codeId: code.id, instruction: "B" });
    expect(next.revisionNumber).toBe(first.revisionNumber + 1);
  });
  it("copies the code's suggestions keyed by their IDs, fills values by label, saves explicit rows as given, and refuses an unsuggested label", async () => {
    const { part, code, field, note } = await fixture();
    const { stepId } = await appendProcessStep(part.id, { codeId: code.id, values: { Temperature: "1500" } });
    expect((await getRevision(part.id, 1)).steps[0].parameters).toEqual([
      { key: field.id, label: "Temperature", type: "NUMBER", unit: "F", position: 0, value: "1500" },
      { key: note.id, label: "Note", type: "TEXT", unit: null, position: 1, value: "" },
    ]);
    expect(stepId).toBeTruthy();
    await expect(appendProcessStep(part.id, { codeId: code.id, values: { Bogus: "1" } })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/"Bogus".*suggest/) });
    const explicit = await appendProcessStep(part.id, { codeId: code.id, parameters: [text("Load", "Basket A")] });
    const [row] = (await getRevision(part.id, 1)).steps.find(s => s.id === explicit.stepId)!.parameters;
    expect(row).toMatchObject({ label: "Load", type: "TEXT", unit: null, position: 0, value: "Basket A" });
    expect(isFreshKey(row.key, field.id, note.id)).toBe(true);
  });
  it("refuses values together with explicit parameters, so a seed cannot lose a value it thought it set", async () => {
    const { part, code, field } = await fixture();
    const parameters: ProcessParameterInput[] = [{ key: field.id, label: "Temperature", type: "NUMBER", unit: "F", value: "" }];
    await expect(appendProcessStep(part.id, { codeId: code.id, values: { Temperature: "1500" }, parameters }))
      .rejects.toMatchObject({ status: 400, message: "Pass values (filled into the code's suggestions) or explicit parameters, not both" });
    expect(await prisma.partProcessRevision.count()).toBe(0);
    // Either one alone is still accepted.
    await appendProcessStep(part.id, { codeId: code.id, parameters });
    await appendProcessStep(part.id, { codeId: code.id, values: { Temperature: "1500" } });
    expect((await rowsOf(part.id, 1)).map(rows => rows.map(p => p.value))).toEqual([[""], ["1500", ""]]);
  });
  it("reaches the save's own 400 for an unknown or inactive code, never a TypeError", async () => {
    const { part, code } = await fixture();
    const missing = { status: 400, message: expect.stringMatching(/deleted or inactive/) };
    await expect(appendProcessStep(part.id, { codeId: "missing" })).rejects.toMatchObject(missing);
    await expect(appendProcessStep(part.id, { codeId: "missing", values: { Temperature: "1" } })).rejects.toMatchObject(missing);
    await prisma.processStepCode.update({ where: { id: code.id }, data: { active: false } });
    await expect(appendProcessStep(part.id, { codeId: code.id })).rejects.toMatchObject(missing);
    expect(await prisma.partProcessRevision.count()).toBe(0);
  });
});

describe("atomic process documents", () => {
  beforeEach(truncateAll);
  it("reads deterministic empty baselines and saves insertion, removal, reorder, edits and duplicate codes together", async () => {
    const { part, code } = await fixture();
    expect(await readProcessDocument(part.id)).toEqual(await readProcessDocument(part.id));
    const empty = await draft(part.id);
    const inserted = await asSystem(() => saveProcessDocument(part.id, { ...empty, steps: [fresh(code, "a"), fresh(code, "b"), fresh(code, "c")] }));
    expect(inserted.baseline.revision?.steps).toHaveLength(3);
    const input = await draft(part.id);
    const removed = input.steps[1].stepId!;
    input.steps = [{ ...input.steps[2], instruction: "changed\n\n" }, fresh(code, ""), input.steps[0]];
    const saved = await asSystem(() => saveProcessDocument(part.id, input));
    expect(saved.baseline.revision?.steps.map(s => s.instruction)).toEqual(["changed\n\n", "", "a"]);
    expect(saved.stepIdMap[removed]).toBeUndefined();
    expect(Object.keys(saved.stepIdMap)).toEqual(expect.arrayContaining(input.steps.map(s => s.clientId)));
    expect(saved.parameterKeys).toEqual(Object.fromEntries(input.steps.map(s => [s.clientId, []])));
    expect(await readProcessDocument(part.id)).toEqual(saved.baseline); // ambiguous response reread
    await expect(asSystem(() => saveProcessDocument(part.id, input))).rejects.toMatchObject({ status: 409 });
  });
  it("no-op after a new lock leaves the numbered snapshot and revisions untouched", async () => {
    const { part, code } = await fixture();
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "old" }));
    await asSystem(() => saveRecipeNumber(part.id, { recipeNumber: "0012", expectedRecipeNumber: null }));
    const beforeLock = await draft(part.id);
    await asSystem(() => prisma.$transaction(tx => lockRevision(part.id, 1, tx)));
    const before = await prisma.partProcessRevision.findMany({ where: { partId: part.id }, include: { steps: { include: { parameters: true } } } });
    const lockedDraft = await draft(part.id);
    const audits = await prisma.auditLog.count();
    await asSystem(() => saveProcessDocument(part.id, lockedDraft));
    expect(await prisma.auditLog.count()).toBe(audits);
    expect(await prisma.partProcessRevision.findMany({ where: { partId: part.id }, include: { steps: { include: { parameters: true } } } })).toEqual(before);
    await expect(asSystem(() => saveProcessDocument(part.id, beforeLock))).rejects.toMatchObject({ status: 409 });
    lockedDraft.steps[0].instruction = "new";
    const saved = await asSystem(() => saveProcessDocument(part.id, lockedDraft));
    expect(saved.baseline.revision?.revisionNumber).toBe(2);
    expect(await prisma.partProcessRevision.findMany({ where: { id: before[0].id }, include: { steps: { include: { parameters: true } } } })).toEqual(before);
  });
  it("rejects foreign identities, replacement codes and malformed typed values without revisions or audits", async () => {
    const { part, code } = await fixture();
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id }));
    const input = await draft(part.id);
    const before = await readProcessDocument(part.id);
    const audits = await prisma.auditLog.count();
    const temperature = input.steps[0].parameters.find(p => p.label === "Temperature")!;
    for (const [steps, message] of [
      [[{ ...input.steps[0], stepId: "foreign", clientId: "foreign" }], /does not belong/],
      [[{ ...input.steps[0], codeId: "foreign" }], /does not belong/],
      [[{ ...input.steps[0], parameters: [{ ...temperature, value: "NaN" }] }], /"NaN" is not a valid number for Temperature/],
    ] as const) {
      await expect(asSystem(() => saveProcessDocument(part.id, { ...input, steps: [...steps] }))).rejects.toMatchObject({ status: 400, message: expect.stringMatching(message) });
      expect(await readProcessDocument(part.id)).toEqual(before);
      expect(await prisma.auditLog.count()).toBe(audits);
    }
  });
  it("ignores default changes, retains inactive references and refuses a new step of an inactive code", async () => {
    const { part, code } = await fixture();
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id }));
    const input = await draft(part.id);
    await prisma.processStepCode.update({ where: { id: code.id }, data: { defaultInstruction: "changed", active: false } });
    input.steps[0].instruction = "chosen";
    expect((await asSystem(() => saveProcessDocument(part.id, input))).baseline.revision?.steps[0].instruction).toBe("chosen");
    const current = await draft(part.id);
    await expect(asSystem(() => saveProcessDocument(part.id, { ...current, steps: [...current.steps, fresh(code)] }))).rejects.toMatchObject({ status: 400 });
  });
  it("rejects a baseline superseded by another save", async () => {
    const { part, code } = await fixture();
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id }));
    const input = await draft(part.id); input.steps[0].instruction = "mine";
    const other = await draft(part.id); other.steps[0].instruction = "theirs";
    await asSystem(() => saveProcessDocument(part.id, other));
    await expect(asSystem(() => saveProcessDocument(part.id, input))).rejects.toMatchObject({ status: 409 });
    expect((await readProcessDocument(part.id)).revision?.steps[0].instruction).toBe("theirs");
  });
  it("a suggestion edit (label, unit or delete) never changes the document token or an open document's acceptance", async () => {
    const { part, code, field, note } = await fixture();
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id, values: { Temperature: "1500" } }));
    const open = await draft(part.id);
    const { baselineToken } = await readProcessDocument(part.id);
    await prisma.processStepFieldDef.update({ where: { id: field.id }, data: { label: "Renamed", unit: "C" } });
    await asSystem(() => setStepFields(code.id, [{ id: note.id, label: "Note", type: "TEXT", unit: null, sort: 2 }])); // deletes Temperature
    await asSystem(() => updateStepCodeWithFields(code.id, { fields: [{ id: note.id, label: "Remark", type: "TEXT", unit: null, sort: 2 }] }));
    expect((await readProcessDocument(part.id)).baselineToken).toBe(baselineToken);
    const audits = await prisma.auditLog.count();
    const unchanged = await asSystem(() => saveProcessDocument(part.id, open));
    expect(await prisma.auditLog.count()).toBe(audits);
    expect(unchanged.baseline.revision?.steps[0].parameters.map(p => [p.key, p.label, p.unit, p.value])).toEqual([[field.id, "Temperature", "F", "1500"], [note.id, "Note", null, ""]]);
  });
});

describe("a save writes only what changed (#658)", () => {
  beforeEach(truncateAll);
  it("sameStoredRows compares every stored field and the order", () => {
    const row = { key: "k", label: "Load", type: "TEXT", unit: "lb", value: "A" };
    expect(sameStoredRows([row], [{ ...row }])).toBe(true);
    for (const change of [{ key: "k2" }, { label: "Lot" }, { type: "NUMBER" }, { unit: null }, { value: "B" }]) expect(sameStoredRows([row], [{ ...row, ...change }])).toBe(false);
    expect(sameStoredRows([row, { ...row, key: "k2" }], [{ ...row, key: "k2" }, row])).toBe(false);
    expect(sameStoredRows([row], [row, { ...row, key: "k2" }])).toBe(false);
    expect(sameStoredRows([row, { ...row, key: "k2" }], [row])).toBe(false);
  });
  /** Three steps of two hand-added rows each, saved, and the document as the editor would send it. */
  async function three() {
    const { part, code } = await fixture();
    const empty = await draft(part.id);
    await asSystem(() => saveProcessDocument(part.id, { ...empty, steps: ["a", "b", "c"].map(n => fresh(code, n, [text("Load", `${n}1`), text("Lot", `${n}2`)])) }));
    return { part, code, input: await draft(part.id) };
  }
  /** What the save stored, as content and identity. */
  async function stored(partId: string) {
    return (await draft(partId)).steps.map(s => ({ stepId: s.stepId, instruction: s.instruction, rows: s.parameters.map(p => [p.key, p.label, p.type, p.unit, p.value]) }));
  }
  const edits: [string, (steps: ProcessDraftStep[]) => ProcessDraftStep[]][] = [
    ["an instruction", st => st.map((s, i) => i === 1 ? { ...s, instruction: "changed" } : s)],
    ["the step order", st => [st[2], st[0], st[1]]],
    ["a removed middle step", st => [st[0], st[2]]],
    ["a row label", st => st.map((s, i) => i === 2 ? { ...s, parameters: s.parameters.map((p, j) => j === 0 ? { ...p, label: "Basket" } : p) } : s)],
    ["a row value", st => st.map((s, i) => i === 0 ? { ...s, parameters: s.parameters.map((p, j) => j === 1 ? { ...p, value: "x" } : p) } : s)],
    ["a row unit", st => st.map((s, i) => i === 0 ? { ...s, parameters: s.parameters.map((p, j) => j === 1 ? { ...p, unit: "lb" } : p) } : s)],
    ["the row order", st => st.map((s, i) => i === 1 ? { ...s, parameters: [s.parameters[1], s.parameters[0]] } : s)],
    ["an added row", st => st.map((s, i) => i === 1 ? { ...s, parameters: [...s.parameters, text("Extra", "e")] } : s)],
    ["a removed row", st => st.map((s, i) => i === 1 ? { ...s, parameters: s.parameters.slice(1) } : s)],
  ];
  it.each(edits)("%s alone is stored, and every other step and row keeps what it had", async (_name, edit) => {
    const { part, input } = await three();
    const steps = edit(input.steps.map(s => ({ ...s, parameters: s.parameters.map(p => ({ ...p })) })));
    const saved = await asSystem(() => saveProcessDocument(part.id, { ...input, steps }));
    const after = await stored(part.id);
    expect(after.map(s => s.stepId)).toEqual(steps.map(s => saved.stepIdMap[s.clientId]));
    expect(after.map(s => s.instruction)).toEqual(steps.map(s => s.instruction));
    expect(after.map(s => s.rows)).toEqual(steps.map(s => s.parameters.map((p, i) => [saved.parameterKeys[s.clientId][i], p.label, p.type, p.unit, p.value])));
  });
  it.each(edits)("%s alone is stored on a locked revision's cut too", async (_name, edit) => {
    const { part } = await three();
    await prisma.$transaction(t => lockRevision(part.id, 1, t));
    const input = await draft(part.id);
    const steps = edit(input.steps.map(s => ({ ...s, parameters: s.parameters.map(p => ({ ...p })) })));
    const saved = await asSystem(() => saveProcessDocument(part.id, { ...input, steps }));
    expect(saved.baseline.revision?.revisionNumber).toBe(2);
    const after = await stored(part.id);
    expect(after.map(s => s.instruction)).toEqual(steps.map(s => s.instruction));
    expect(after.map(s => s.rows)).toEqual(steps.map(s => s.parameters.map((p, i) => [saved.parameterKeys[s.clientId][i], p.label, p.type, p.unit, p.value])));
    // The locked revision is left as it was.
    expect((await rowsOf(part.id, 1)).map(rows => rows.map(r => r.value))).toEqual([["a1", "a2"], ["b1", "b2"], ["c1", "c2"]]);
  });
  it("a step inserted ahead of kept steps, and one appended, take their places with the kept steps moved down", async () => {
    const { part, code, input } = await three();
    const steps = [fresh(code, "first", [text("Load", "f")]), input.steps[0], fresh(code, "mid"), input.steps[1], input.steps[2], fresh(code, "last")];
    const saved = await asSystem(() => saveProcessDocument(part.id, { ...input, steps }));
    const after = await stored(part.id);
    expect(after.map(s => [s.stepId, s.instruction])).toEqual(steps.map(s => [saved.stepIdMap[s.clientId], s.instruction]));
    expect(after.map(s => s.rows.map(r => r[4]))).toEqual([["f"], ["a1", "a2"], [], ["b1", "b2"], ["c1", "c2"], []]);
  });
});

describe("the baseline token's scope (R11, #659)", () => {
  beforeEach(truncateAll);
  const stale = { status: 409, message: "The process changed — reload before saving" };
  it("creating, renaming or deleting a code no step names leaves the token unchanged, and an open edit still saves", async () => {
    const { part, code } = await fixture();
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id }));
    const open = await draft(part.id); open.steps[0].instruction = "mine";
    const { baselineToken } = await readProcessDocument(part.id);
    const other = await prisma.processStepCode.create({ data: { code: "QN", name: "Quench" } });
    expect((await readProcessDocument(part.id)).baselineToken).toBe(baselineToken);
    await prisma.processStepCode.update({ where: { id: other.id }, data: { code: "QX", name: "Quench renamed" } });
    expect((await readProcessDocument(part.id)).baselineToken).toBe(baselineToken);
    await prisma.processStepCode.update({ where: { id: other.id }, data: { deletedAt: new Date() } });
    expect((await readProcessDocument(part.id)).baselineToken).toBe(baselineToken);
    const saved = await asSystem(() => saveProcessDocument(part.id, open));
    expect(saved.baseline.revision?.steps[0].instruction).toBe("mine");
  });
  it("renaming a code a step names still changes the token, by its code and by its name", async () => {
    const { part, code } = await fixture();
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id }));
    for (const data of [{ code: "HX" }, { name: "Harden" }]) {
      const open = await draft(part.id); open.steps[0].instruction = "mine";
      const { baselineToken } = await readProcessDocument(part.id);
      await prisma.processStepCode.update({ where: { id: code.id }, data });
      expect((await readProcessDocument(part.id)).baselineToken).not.toBe(baselineToken);
      await expect(asSystem(() => saveProcessDocument(part.id, open))).rejects.toMatchObject(stale);
    }
  });
  it("an added step whose code was renamed or deleted since it was added answers the same 409, and writes nothing", async () => {
    const { part, code } = await fixture();
    for (const [n, data] of [{ code: "HX" }, { name: "Harden" }, { deletedAt: new Date() }].entries()) {
      const added = await prisma.processStepCode.create({ data: { code: `A${n + 1}`, name: "Added" } });
      const open = await draft(part.id);
      const step = fresh(added);
      await prisma.processStepCode.update({ where: { id: added.id }, data });
      const audits = await prisma.auditLog.count();
      await expect(asSystem(() => saveProcessDocument(part.id, { ...open, steps: [...open.steps, step] }))).rejects.toMatchObject(stale);
      expect(await prisma.auditLog.count()).toBe(audits);
      expect(await prisma.partProcessStep.count()).toBe(0);
    }
    // The code the operator saw, sent back unchanged, saves.
    const open = await draft(part.id);
    expect((await asSystem(() => saveProcessDocument(part.id, { ...open, steps: [fresh(code)] }))).baseline.revision?.steps).toHaveLength(1);
  });
  it("a new step must name the code it was added as; an existing step may not; an unknown code keeps its 400", async () => {
    const { part, code } = await fixture();
    const empty = await draft(part.id);
    const unnamed = { ...fresh(code), codeSeen: undefined };
    await expect(asSystem(() => saveProcessDocument(part.id, { ...empty, steps: [unnamed] })))
      .rejects.toMatchObject({ status: 400, message: "A new step must name the code it was added as" });
    await expect(asSystem(() => saveProcessDocument(part.id, { ...empty, steps: [{ ...fresh(code), codeId: "missing" }] })))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/deleted or inactive/) });
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id }));
    const input = await draft(part.id);
    await expect(asSystem(() => saveProcessDocument(part.id, { ...input, steps: [{ ...input.steps[0], instruction: "x", codeSeen: { code: "HT", name: "Heat" } }] })))
      .rejects.toThrow(/Only a new step names the code it was added as/); // a ZodError, which `handle` answers 400
  });
});

describe("parameter keys on save (spec §3.3)", () => {
  beforeEach(truncateAll);
  it("a new step copied from its code's suggestions keeps the suggestion IDs as keys", async () => {
    const { part, code, field, note } = await fixture();
    const input = await draft(part.id);
    const step = fresh(code, "x", await suggestions(part.id, code.id));
    const saved = await asSystem(() => saveProcessDocument(part.id, { ...input, steps: [step] }));
    expect(saved.parameterKeys).toEqual({ [step.clientId]: [field.id, note.id] });
    expect(await rowsOf(part.id, 1)).toEqual([[
      { position: 0, key: field.id, label: "Temperature", type: "NUMBER", unit: "F", value: "" },
      { position: 1, key: note.id, label: "Note", type: "TEXT", unit: null, value: "" },
    ]]);
  });
  it("a hand-added TEXT row gets a new key at its index; a hand-added NUMBER, DATE or CHECKBOX row is refused without writes", async () => {
    const { part, code, field, note } = await fixture();
    const input = await draft(part.id);
    const step = fresh(code, "x", [...await suggestions(part.id, code.id), text("Load", "Basket A")]);
    const saved = await asSystem(() => saveProcessDocument(part.id, { ...input, steps: [step] }));
    const keys = saved.parameterKeys[step.clientId];
    expect(keys.slice(0, 2)).toEqual([field.id, note.id]);
    expect(isFreshKey(keys[2], field.id, note.id)).toBe(true);
    expect(new Set(keys).size).toBe(3);
    expect((await rowsOf(part.id, 1))[0][2]).toEqual({ position: 2, key: keys[2], label: "Load", type: "TEXT", unit: null, value: "Basket A" });
    const before = await readProcessDocument(part.id), audits = await prisma.auditLog.count();
    for (const [type, key] of [["NUMBER", provisional()], ["DATE", provisional()], ["CHECKBOX", provisional()], ["NUMBER", "no-origin"]] as const) {
      const current = await draft(part.id);
      const hand: ProcessParameterInput = { key, label: "Load", type, unit: null, value: "" };
      await expect(asSystem(() => saveProcessDocument(part.id, { ...current, steps: [{ ...current.steps[0], parameters: [...current.steps[0].parameters, hand] }] })))
        .rejects.toMatchObject({ status: 400, message: `"Load" was added by hand, so it must be text` });
    }
    expect(await readProcessDocument(part.id)).toEqual(before);
    expect(await prisma.auditLog.count()).toBe(audits);
  });
  it("a label edit keeps the key; a unit change or a type change gives a new key that keeps the submitted type", async () => {
    const { part, code, field } = await fixture();
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id, values: { Temperature: "1500" } }));
    const relabel = await draft(part.id);
    relabel.steps[0].parameters[0].label = "Furnace temperature";
    const relabelled = await asSystem(() => saveProcessDocument(part.id, relabel));
    expect(relabelled.parameterKeys[relabel.steps[0].clientId][0]).toBe(field.id);
    expect((await rowsOf(part.id, 1))[0][0]).toMatchObject({ key: field.id, label: "Furnace temperature", type: "NUMBER", unit: "F", value: "1500" });
    const reunit = await draft(part.id);
    reunit.steps[0].parameters[0].unit = "C";
    const reunited = await asSystem(() => saveProcessDocument(part.id, reunit));
    const unitKey = reunited.parameterKeys[reunit.steps[0].clientId][0];
    expect(isFreshKey(unitKey, field.id)).toBe(true);
    expect((await rowsOf(part.id, 1))[0][0]).toMatchObject({ key: unitKey, type: "NUMBER", unit: "C", value: "1500" });
    const retype = await draft(part.id);
    retype.steps[0].parameters[0] = { ...retype.steps[0].parameters[0], type: "TEXT", value: "about 1500" };
    const retyped = await asSystem(() => saveProcessDocument(part.id, retype));
    const typeKey = retyped.parameterKeys[retype.steps[0].clientId][0];
    expect(isFreshKey(typeKey, field.id, unitKey)).toBe(true);
    expect((await rowsOf(part.id, 1))[0][0]).toMatchObject({ key: typeKey, type: "TEXT", unit: "C", value: "about 1500" });
  });
  it("a key the server cannot verify is re-keyed when the row is text and refused otherwise", async () => {
    const { part, code, field, note } = await fixture();
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id }));
    const forgedText = await draft(part.id);
    forgedText.steps[0].parameters[1].key = "forged";
    const saved = await asSystem(() => saveProcessDocument(part.id, forgedText));
    const [, noteKey] = saved.parameterKeys[forgedText.steps[0].clientId];
    expect(isFreshKey(noteKey, "forged", note.id, field.id)).toBe(true);
    expect((await rowsOf(part.id, 1))[0].map(p => p.key)).toEqual([field.id, noteKey]);
    const forgedNumber = await draft(part.id);
    forgedNumber.steps[0].parameters[0].key = "forged";
    await expect(asSystem(() => saveProcessDocument(part.id, forgedNumber))).rejects.toMatchObject({ status: 400, message: `"Temperature" was added by hand, so it must be text` });
  });
  it("on an existing step a suggestion ID the step does not carry is never adopted: a never-copied suggestion, or one removed and saved", async () => {
    const { part, code, field, note } = await fixture();
    const nested = await asSystem(() => appendProcessStep(part.id, { codeId: code.id, parameters: [{ key: field.id, label: "Temperature", type: "NUMBER", unit: "F", value: "1" }] }));
    const neverCopied = await draft(part.id);
    neverCopied.steps[0].parameters.push({ key: note.id, label: "Note", type: "TEXT", unit: null, value: "late" });
    const added = await asSystem(() => saveProcessDocument(part.id, neverCopied));
    const lateKey = added.parameterKeys[nested.stepId][1];
    expect(isFreshKey(lateKey, note.id, field.id)).toBe(true);
    expect((await rowsOf(part.id, 1))[0].map(p => p.key)).toEqual([field.id, lateKey]);
    // Remove the copied Temperature row and save, then bring its suggestion ID back.
    const removal = await draft(part.id);
    removal.steps[0].parameters = removal.steps[0].parameters.filter(p => p.key !== field.id);
    await asSystem(() => saveProcessDocument(part.id, removal));
    const back = await draft(part.id);
    back.steps[0].parameters.push({ key: field.id, label: "Temperature", type: "TEXT", unit: null, value: "" });
    const returned = await asSystem(() => saveProcessDocument(part.id, back));
    expect(isFreshKey(returned.parameterKeys[nested.stepId][1], field.id, note.id, lateKey)).toBe(true);
  });
  it("a new step copied before a suggestion was removed still saves with its suggestion IDs as keys, and the removed one's type and unit are still verified", async () => {
    // Spec §3.2: removing a suggestion never changes a draft. The editor copied both suggestions
    // onto two new steps; an administrator then removes the NUMBER suggestion before the save.
    const { part, code, field, note } = await fixture();
    const input = await draft(part.id);
    const kept = fresh(code, "kept", await suggestions(part.id, code.id));
    const reunited = fresh(code, "reunited", (await suggestions(part.id, code.id)).map(p => p.key === field.id ? { ...p, unit: "C" } : p));
    await asSystem(() => setStepFields(code.id, [{ id: note.id, label: "Note", type: "TEXT", unit: null, sort: 2 }]));
    expect((await readProcessDocument(part.id)).codes.find(c => c.id === code.id)!.fields.map(f => f.id)).toEqual([note.id]);
    const saved = await asSystem(() => saveProcessDocument(part.id, { ...input, steps: [kept, reunited] }));
    // Neither row of the untouched copy is refused as hand-added, and neither is re-keyed.
    expect(saved.parameterKeys[kept.clientId]).toEqual([field.id, note.id]);
    // The removed suggestion still carries its type and unit, so a changed unit is a new key.
    const [reunitKey, noteKey] = saved.parameterKeys[reunited.clientId];
    expect(isFreshKey(reunitKey, field.id, note.id)).toBe(true);
    expect(noteKey).toBe(note.id);
    expect(await rowsOf(part.id, 1)).toEqual([
      [{ position: 0, key: field.id, label: "Temperature", type: "NUMBER", unit: "F", value: "" },
        { position: 1, key: note.id, label: "Note", type: "TEXT", unit: null, value: "" }],
      [{ position: 0, key: reunitKey, label: "Temperature", type: "NUMBER", unit: "C", value: "" },
        { position: 1, key: note.id, label: "Note", type: "TEXT", unit: null, value: "" }],
    ]);
  });
  describe("a new step never adopts another code's suggestion ID, even when that code's new step in the same save copies it", () => {
    // In each save the quench step is new, so both quench suggestion IDs are among that save's
    // origins; the heat step beside it may still verify only its own code's suggestions.
    async function twoCodes() {
      const { part, code } = await fixture();
      const quench = await prisma.processStepCode.create({ data: { code: "QU", name: "Quench" } });
      const time = await prisma.processStepFieldDef.create({ data: { codeId: quench.id, label: "Time", type: "NUMBER", unit: "min", sort: 1 } });
      const media = await prisma.processStepFieldDef.create({ data: { codeId: quench.id, label: "Media", type: "TEXT", unit: null, sort: 2 } });
      return { part, heat: code, quench, time, media, quenchStep: fresh(quench, "quench", await suggestions(part.id, quench.id)) };
    }
    it("a TEXT row keyed with the other code's suggestion ID is re-keyed", async () => {
      const { part, heat, time, media, quenchStep } = await twoCodes();
      const input = await draft(part.id);
      const borrowed = fresh(heat, "heat", [{ key: media.id, label: "Media", type: "TEXT", unit: null, value: "oil" }]);
      const saved = await asSystem(() => saveProcessDocument(part.id, { ...input, steps: [borrowed, quenchStep] }));
      expect(isFreshKey(saved.parameterKeys[borrowed.clientId][0], media.id, time.id)).toBe(true);
      expect(saved.parameterKeys[quenchStep.clientId]).toEqual([time.id, media.id]);
    });
    it("a NUMBER row keyed with the other code's suggestion ID is refused as hand-added, without writes", async () => {
      const { part, heat, time, quenchStep } = await twoCodes();
      const before = await readProcessDocument(part.id), audits = await prisma.auditLog.count();
      const input = await draft(part.id);
      const borrowed = fresh(heat, "heat", [{ key: time.id, label: "Time", type: "NUMBER", unit: "min", value: "5" }]);
      await expect(asSystem(() => saveProcessDocument(part.id, { ...input, steps: [borrowed, quenchStep] })))
        .rejects.toMatchObject({ status: 400, message: `"Time" was added by hand, so it must be text` });
      expect(await readProcessDocument(part.id)).toEqual(before);
      expect(await prisma.auditLog.count()).toBe(audits);
    });
  });
  it("a suggestion whose stored unit has surrounding spaces keeps its key when copied, and again across an unrelated save", async () => {
    const { part, code, field } = await fixture();
    await prisma.processStepFieldDef.update({ where: { id: field.id }, data: { unit: " F " } }); // the admin schema allows it
    const input = await draft(part.id);
    const step = fresh(code, "x", await suggestions(part.id, code.id));
    expect(step.parameters[0].unit).toBe("F");
    const saved = await asSystem(() => saveProcessDocument(part.id, { ...input, steps: [step] }));
    expect(saved.parameterKeys[step.clientId][0]).toBe(field.id);
    const unrelated = await draft(part.id); unrelated.steps[0].instruction = "edited";
    const again = await asSystem(() => saveProcessDocument(part.id, unrelated));
    expect(again.parameterKeys[unrelated.steps[0].clientId][0]).toBe(field.id);
    expect((await rowsOf(part.id, 1))[0][0]).toMatchObject({ key: field.id, unit: "F" });
  });
  it("a revision cut copies every row with its key and leaves the locked revision's rows untouched", async () => {
    const { part, code, field, note } = await fixture();
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id, values: { Temperature: "1500", Note: "salt" } }));
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id, parameters: [text("Load", "Basket B")] }));
    await asSystem(() => prisma.$transaction(tx => lockRevision(part.id, 1, tx)));
    const locked = await rowsOf(part.id, 1);
    const input = await draft(part.id); input.steps[1].instruction = "cut";
    const saved = await asSystem(() => saveProcessDocument(part.id, input));
    expect(saved.baseline.revision?.revisionNumber).toBe(2);
    expect(await rowsOf(part.id, 2)).toEqual(locked);
    expect(await rowsOf(part.id, 1)).toEqual(locked);
    expect(locked[0].map(p => p.key)).toEqual([field.id, note.id]);
    expect(saved.parameterKeys[input.steps[0].clientId]).toEqual([field.id, note.id]);
  });
  it("a pre-migration captured revision edits from its rows: the baseline shows the rows' labels, and an instruction-only edit cuts N+1 with exactly those rows", async () => {
    const { part, code, field, note } = await fixture();
    const { stepId } = await asSystem(() => appendProcessStep(part.id, { codeId: code.id, values: { Temperature: "1500" } }));
    await asSystem(() => saveRecipeNumber(part.id, { recipeNumber: "0077", expectedRecipeNumber: null }));
    await asSystem(() => prisma.$transaction(tx => lockCurrentRevision(part.id, tx)));
    // A snapshot captured before this change lists the code's fields: a captured label that
    // differs from the row's, and an unset field that has no row.
    const revision = await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: part.id } });
    const snapshot = JSON.parse(JSON.stringify(revision.recipeSnapshot));
    snapshot.steps[0].fields[0].label = "Captured temperature";
    snapshot.steps[0].fields.push({ fieldDefId: "ghost-def", label: "Ghost", type: "TEXT", unit: null, position: 2, value: null });
    await prisma.partProcessRevision.update({ where: { id: revision.id }, data: { recipeSnapshot: snapshot } });
    const baseline = await readProcessDocument(part.id);
    expect(baseline.revision?.steps[0].parameters.map(p => [p.key, p.label, p.value])).toEqual([[field.id, "Temperature", "1500"], [note.id, "Note", ""]]);
    expect(baseline.revision?.recipeSnapshot?.steps[0].fields.map(f => f.label)).toEqual(["Captured temperature", "Note", "Ghost"]); // still attached for display
    expect((await getRevision(part.id, 1)).steps[0].parameters.map(p => p.label)).toEqual(["Captured temperature", "Note", "Ghost"]); // history reads stay captured
    const input = await draft(part.id); input.steps[0].instruction = "Edited";
    const saved = await asSystem(() => saveProcessDocument(part.id, input));
    expect(saved.baseline.revision?.revisionNumber).toBe(2);
    expect(await rowsOf(part.id, 2)).toEqual([[
      { position: 0, key: field.id, label: "Temperature", type: "NUMBER", unit: "F", value: "1500" },
      { position: 1, key: note.id, label: "Note", type: "TEXT", unit: null, value: "" },
    ]]);
    expect(saved.stepIdMap[stepId]).toBeTruthy();
    expect((await prisma.partProcessRevision.findUniqueOrThrow({ where: { id: revision.id } })).recipeSnapshot).toEqual(snapshot);
  });
});

describe("parameter values, writes and rollback", () => {
  beforeEach(truncateAll);
  it("validates each row's value by its own type, naming the label, and stores an empty value as empty", async () => {
    const { part, code } = await fixture();
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id, values: { Temperature: "1500" } }));
    const input = await draft(part.id);
    // Each row is validated by its OWN type: the Temperature row retyped through its saved origin.
    const retyped = (type: ProcessParameterInput["type"], value: string) => [{ ...input.steps[0], parameters: [{ ...input.steps[0].parameters[0], type, value }] }];
    await expect(asSystem(() => saveProcessDocument(part.id, { ...input, steps: retyped("NUMBER", "abc") }))).rejects.toMatchObject({ status: 400, message: `"abc" is not a valid number for Temperature` });
    await expect(asSystem(() => saveProcessDocument(part.id, { ...input, steps: retyped("DATE", "2025-02-29") }))).rejects.toMatchObject({ status: 400, message: `"2025-02-29" is not a valid date (yyyy-mm-dd) for Temperature` });
    await expect(asSystem(() => saveProcessDocument(part.id, { ...input, steps: retyped("CHECKBOX", "yes") }))).rejects.toMatchObject({ status: 400, message: "Temperature must be true or false" });
    await expect(asSystem(() => saveProcessDocument(part.id, { ...input, steps: [{ ...input.steps[0], parameters: [text("Hand", "x".repeat(501))] }] }))).rejects.toMatchObject({ name: "ZodError" });
    input.steps[0].parameters[0].value = "";
    await asSystem(() => saveProcessDocument(part.id, input));
    expect((await rowsOf(part.id, 1))[0][0]).toMatchObject({ label: "Temperature", value: "" });
  });
  it("an unchanged submission writes nothing and returns the saved keys; a stale token is a 409", async () => {
    const { part, code, field, note } = await fixture();
    const { stepId } = await asSystem(() => appendProcessStep(part.id, { codeId: code.id, values: { Temperature: "1500" } }));
    const input = await draft(part.id);
    const audits = await prisma.auditLog.count();
    const rows = await rowsOf(part.id, 1);
    const result = await asSystem(() => saveProcessDocument(part.id, input));
    expect(result.parameterKeys).toEqual({ [stepId]: [field.id, note.id] });
    expect(result.stepIdMap).toEqual({ [stepId]: stepId });
    expect(await prisma.auditLog.count()).toBe(audits);
    expect(await prisma.partProcessRevision.count()).toBe(1);
    expect(await rowsOf(part.id, 1)).toEqual(rows);
    await expect(asSystem(() => saveProcessDocument(part.id, { ...input, expectedBaselineToken: "stale" }))).rejects.toMatchObject({ status: 409 });
  });
  it("rolls back every step and parameter write and the audit after a late storage failure", async () => {
    const { part, code } = await fixture();
    // Two steps on an UNCUT working revision: the first step's rows are really rewritten before
    // the second step's write fails, which is what a rollback has to undo. (A cut would leave the
    // copies uncommitted, so a write escaping the transaction would fail on the FK instead.)
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id, values: { Temperature: "1500" } }));
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id, values: { Temperature: "1600" } }));
    const input = await draft(part.id);
    input.steps[0].parameters[0].value = "1501"; input.steps[1].parameters[0].value = "1601";
    const before = await readProcessDocument(part.id), rows = await rowsOf(part.id, 1), audits = await prisma.auditLog.count();
    // Only inject a storage failure on the second call; the first runs the real implementation.
    const real = processHelpers.replaceStepParameters;
    const failure = vi.spyOn(processHelpers, "replaceStepParameters")
      .mockImplementationOnce((...args) => real(...args))
      .mockRejectedValueOnce(new Error("injected storage failure"));
    let calls = 0;
    try { await expect(asSystem(() => saveProcessDocument(part.id, input))).rejects.toThrow("injected storage failure"); calls = failure.mock.calls.length; }
    finally { failure.mockRestore(); } // restore clears the call history, so it is read first
    expect(calls).toBe(2);
    expect(await readProcessDocument(part.id)).toEqual(before);
    expect(await rowsOf(part.id, 1)).toEqual(rows);
    expect(await prisma.partProcessRevision.count()).toBe(1);
    expect(await prisma.auditLog.count()).toBe(audits);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
// Real backend wait state proves the contender reached the held claim before release.
async function waitForBlockedClaims(count: number) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND query LIKE '%UPDATE "Part" SET "id" = "id"%'`;
    if (Number(rows[0].n) >= count) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`Expected ${count} process callers blocked on the part claim`);
}
describe("process document identities and controlled concurrent transactions", () => {
  beforeEach(truncateAll);
  it("returns a surviving mapping for an explicit remove/reinsert with identical content", async () => {
    const { part, code } = await fixture();
    const old = await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "same" }));
    const input = await draft(part.id);
    const replacement = fresh(code, "same", await suggestions(part.id, code.id));
    const saved = await asSystem(() => saveProcessDocument(part.id, { ...input, steps: [replacement] }));
    const mapped = saved.stepIdMap[replacement.clientId];
    expect(mapped).toBeTruthy();
    expect(saved.baseline.revision?.steps[0].id).toBe(mapped);
    expect(saved.stepIdMap[old.stepId]).toBeUndefined();
  });
  it("preserves an order's captured snapshot and pointer when its lock wins against save", async () => {
    const { part, code } = await fixture();
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "captured" }));
    await asSystem(() => saveRecipeNumber(part.id, { recipeNumber: "0012", expectedRecipeNumber: null }));
    const input = await draft(part.id);
    input.steps[0].instruction = "draft";
    const ready = deferred(), release = deferred();
    const orderCall = asSystem(() => prisma.$transaction(async tx => {
      const locked = await lockCurrentRevision(part.id, tx);
      const order = await tx.order.create({ data: { customerId: part.customerId, orderNumber: 1000, receivedDate: new Date(), requestDate: new Date(), lines: { create: { partId: part.id, position: 1, qty: 1, weight: 1, revisionNumber: locked.revisionNumber } } }, include: { lines: true } });
      ready.resolve();
      await release.promise;
      return order;
    }, { timeout: 15000 }));
    await ready.promise;
    const saving = asSystem(() => saveProcessDocument(part.id, input));
    const result = Promise.allSettled([saving]);
    try { await waitForBlockedClaims(1); } finally { release.resolve(); }
    const order = await orderCall;
    expect((await result)[0]).toMatchObject({ status: "rejected", reason: { status: 409 } });
    const captured = await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: part.id }, include: { steps: { include: { parameters: true } } } });
    expect(captured.steps[0].instruction).toBe("captured");
    expect(captured.recipeSnapshot).toMatchObject({ steps: [{ instruction: "captured" }] });
    const next = await draft(part.id); next.steps[0].instruction = "new working";
    await asSystem(() => saveProcessDocument(part.id, next));
    expect(await prisma.partProcessRevision.findUnique({ where: { id: captured.id }, include: { steps: { include: { parameters: true } } } })).toEqual(captured);
    expect(await prisma.orderLine.findMany({ where: { orderId: order.id } })).toEqual(order.lines);
  });
  it("allows one winner when two saves contend on one baseline", async () => {
    const { part, code } = await fixture();
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id }));
    const input = await draft(part.id);
    const audits = await prisma.auditLog.count();
    const ready = deferred(), release = deferred();
    // A read lock queues both real service calls without itself changing row version.
    const holder = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Part" WHERE "id" = ${part.id} FOR UPDATE`;
      ready.resolve(); await release.promise;
    }, { timeout: 15000 });
    await ready.promise;
    const first = asSystem(() => saveProcessDocument(part.id, { ...input, steps: [{ ...input.steps[0], instruction: "batch first" }] }));
    const second = asSystem(() => saveProcessDocument(part.id, { ...input, steps: [{ ...input.steps[0], instruction: "batch second" }] }));
    const result = Promise.allSettled([first, second]);
    try { await waitForBlockedClaims(2); } finally { release.resolve(); }
    await holder;
    const settled = await result;
    expect(settled.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(settled.find(r => r.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect(await prisma.partProcessRevision.count()).toBe(1);
    expect(await prisma.auditLog.count()).toBe(audits + 1);
    const saved = await readProcessDocument(part.id);
    expect(saved.revision?.steps[0].instruction).toBe(settled[0].status === "fulfilled" ? "batch first" : "batch second");
  });
});

describe("process document validation and capture boundaries", () => {
  beforeEach(truncateAll);
  it("rejects deleted referenced codes without writes, while allowing their removal", async () => {
    const { part, code } = await fixture();
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id }));
    const input = await draft(part.id);
    await prisma.processStepCode.update({ where: { id: code.id }, data: { deletedAt: new Date() } });
    const audits = await prisma.auditLog.count();
    await expect(asSystem(() => saveProcessDocument(part.id, input))).rejects.toMatchObject({ status: 409 });
    const current = await draft(part.id);
    await expect(asSystem(() => saveProcessDocument(part.id, current))).rejects.toMatchObject({ status: 400 });
    expect(await prisma.auditLog.count()).toBe(audits);
    await asSystem(() => saveProcessDocument(part.id, { ...current, steps: [] }));
    expect((await readProcessDocument(part.id)).revision?.steps).toEqual([]);
  });
  it("captures saved content when save wins the claim before the order lock", async () => {
    const { part, code } = await fixture();
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "before" }));
    await asSystem(() => saveRecipeNumber(part.id, { recipeNumber: "0099", expectedRecipeNumber: null }));
    const input = await draft(part.id); input.steps[0].instruction = "saved before capture";
    const ready = deferred(), release = deferred();
    const holder = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "ProcessStepCode" WHERE "id" = ${code.id} FOR UPDATE`;
      ready.resolve(); await release.promise;
    }, { timeout: 15000 });
    await ready.promise;
    const saving = asSystem(() => saveProcessDocument(part.id, input));
    let orderCall: Promise<unknown> | undefined;
    try {
      const end = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < end) {
        const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%UPDATE "ProcessStepCode" SET "id" = "id"%'`;
        if (Number(rows[0].n) >= 1) { blocked = true; break; }
        await new Promise(r => setTimeout(r, 10));
      }
      expect(blocked).toBe(true);
      orderCall = asSystem(() => prisma.$transaction(tx => lockCurrentRevision(part.id, tx)));
      await waitForBlockedClaims(1);
    } finally { release.resolve(); }
    await holder; await saving; await orderCall;
    const revision = await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: part.id } });
    expect(revision.recipeSnapshot).toMatchObject({ steps: [{ instruction: "saved before capture" }] });
    expect(revision.revisionNumber).toBe(1);
  });
});
