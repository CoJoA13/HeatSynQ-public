import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "../prisma/generated/prisma/client";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { parseRecipeSnapshot, type RecipeSnapshotV1 } from "@/lib/recipe-snapshot";
import { getRevision, getRevisions, lockCurrentRevision, saveRecipeNumber } from "@/server/part-process-steps";
import { appendProcessStep, saveProcessDocument } from "@/server/process-document";
import { editedProcess, saveProcessEdit, setInstruction, setValue } from "./helpers/process-edit";
import { setStepFields, updateStepCode, updateStepCodeWithFields } from "@/server/process-step-codes";
import { withDbErrors } from "@/server/db-errors";
import { readAudit } from "@/server/audit";
import { createOrder } from "@/server/orders";

const asSystem = <T>(fn: () => Promise<T>) => runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);
/** One step copied from a code with one NUMBER suggestion ("Temperature", F); its row is keyed by
 *  the suggestion's id and holds `value` (or stays empty). */
async function fixture(number: string | null = "001207", value?: string) {
  const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
  const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-1", eachWeight: 1 } });
  const code = await prisma.processStepCode.create({ data: { code: "HT", name: "Heat" } });
  const field = await prisma.processStepFieldDef.create({ data: {
    codeId: code.id, label: "Temperature", type: "NUMBER", unit: "F", sort: 1,
  } });
  const { stepId } = await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "Hold",
    values: value === undefined ? {} : { Temperature: value },
  }));
  if (number !== null) await asSystem(() => saveRecipeNumber(part.id, { recipeNumber: number, expectedRecipeNumber: null }));
  return { part, code, field, stepId };
}
/** The editor's value edit through the one save path. Its document is read before the race, as an
 *  open page holds it, so only the save's own transaction takes part in the race. */
async function valueEdit(partId: string, stepId: string, key: string, value: string) {
  const input = await editedProcess(partId, setValue(stepId, key, value));
  return () => asSystem(async () => ({ revisionNumber: (await saveProcessDocument(partId, input)).baseline.revision?.revisionNumber ?? null }));
}
const capture = (partId: string, isolationLevel: Prisma.TransactionIsolationLevel = "ReadCommitted") =>
  asSystem(() => withDbErrors({ entity: "Part" }, () => prisma.$transaction(
    (tx) => lockCurrentRevision(partId, tx), { isolationLevel, timeout: 15000 },
  )));
const stored = async (partId: string) => parseRecipeSnapshot((await prisma.partProcessRevision.findUniqueOrThrow({
  where: { partId_revisionNumber: { partId, revisionNumber: 1 } },
})).recipeSnapshot);
const rowsOf = async (stepId: string) => (await prisma.partProcessStepParameter.findMany({ where: { stepId }, orderBy: { position: "asc" } }))
  .map((p) => ({ position: p.position, key: p.key, label: p.label, type: p.type, unit: p.unit, value: p.value }));

/** Hold an actual public service transaction after its work, before commit. The spy changes
 * only scheduling; all service statements, claims, isolation and writes remain real. Observe
 * Postgres's blocking graph before release, then assert the resulting saved projection. */
async function orderedRace<T, U>(holderCall: () => Promise<T>, waiterCall: () => Promise<U>) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let ready!: (pid: number) => void;
  let failed!: (error: unknown) => void;
  const held = new Promise<number>((resolve, reject) => { ready = resolve; failed = reject; });
  type Run = <R>(fn: (tx: Prisma.TransactionClient) => Promise<R>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number }) => Promise<R>;
  const original = prisma.$transaction.bind(prisma) as Run;
  const intercept: Run = (fn, options) => original(async (tx) => {
    try {
      const result = await fn(tx);
      const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      ready(row.pid);
      await released;
      return result;
    } catch (error) { failed(error); throw error; }
  }, { ...options, timeout: 15000 });
  const spy = vi.spyOn(prisma, "$transaction").mockImplementationOnce(intercept as typeof prisma.$transaction);
  const holder = holderCall();
  const holderResult = holder.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  let waiter: Promise<{ ok: true; value: U } | { ok: false; error: unknown }> | undefined;
  let waiterSettled = false;
  try {
    const pid = await held;
    spy.mockRestore();
    waiter = waiterCall().then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))
      .finally(() => { waiterSettled = true; });
    // Bounded polling is a barrier on observed DB state, not an assumption that a sleep was enough.
    const deadline = Date.now() + 4000;
    let blocked = false;
    while (Date.now() < deadline) {
      const [row] = await prisma.$queryRaw<{ blocked: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked`;
      if (row.blocked) { blocked = true; break; }
      if (waiterSettled) break; // a removed claim may finish early; the saved-state assertions must catch it
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(blocked || waiterSettled, "waiter must reach the holder or settle before release").toBe(true);
  } finally {
    spy.mockRestore();
    release();
    await holderResult;
    if (waiter) await waiter;
  }
  expect(await holderResult).toMatchObject({ ok: true });
  return await waiter!;
}

describe("numbered recipe snapshots", () => {
  beforeEach(truncateAll);

  it("captures the step's own rows in position order, all four types, an empty value as null, and writes no membership rows", async () => {
    const { part, code, field, stepId } = await fixture("001207", "0001650.250000");
    // Rows the part owns (spec 2026-09-26 §3.4): hand-added and re-keyed rows alike, in position
    // order. A suggestion the step never copied ("Absent") is absent, not reported as null.
    await prisma.partProcessStepParameter.createMany({ data: [
      { stepId, position: 1, key: "row-date", label: "Date", type: "DATE", unit: null, value: "2028-02-29" },
      { stepId, position: 2, key: "row-flag", label: "Flag", type: "CHECKBOX", unit: null, value: "false" },
      { stepId, position: 3, key: "row-empty", label: "Empty", type: "TEXT", unit: null, value: "" },
      { stepId, position: 4, key: "row-comment", label: "Comment", type: "TEXT", unit: "note", value: "Use basket" },
    ] });
    await prisma.processStepFieldDef.create({ data: { codeId: code.id, label: "Absent", type: "CHECKBOX", sort: 5 } });
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "Cool" }));
    await capture(part.id);
    const snapshot = await stored(part.id);
    expect(snapshot).toMatchObject({ schemaVersion: 1, recipeNumber: "001207", partId: part.id, revisionNumber: 1 });
    expect(snapshot.steps.map((step) => [step.position, step.instruction])).toEqual([[1, "Hold"], [2, "Cool"]]);
    expect(snapshot.steps[0].fields).toEqual([
      { fieldDefId: field.id, label: "Temperature", type: "NUMBER", unit: "F", position: 0, value: "0001650.250000" },
      { fieldDefId: "row-date", label: "Date", type: "DATE", unit: null, position: 1, value: "2028-02-29" },
      { fieldDefId: "row-flag", label: "Flag", type: "CHECKBOX", unit: null, position: 2, value: false },
      { fieldDefId: "row-empty", label: "Empty", type: "TEXT", unit: null, position: 3, value: null },
      { fieldDefId: "row-comment", label: "Comment", type: "TEXT", unit: "note", position: 4, value: "Use basket" },
    ]);
    // The second step was added after "Absent" existed, so it copied both suggestions, unset.
    expect(snapshot.steps[1].fields.map((f) => [f.label, f.value])).toEqual([["Temperature", null], ["Absent", null]]);
    expect(await prisma.recipeSnapshotField.count()).toBe(0);
    const detail = await getRevision(part.id, 1);
    expect(detail.recipeSnapshot).toEqual(snapshot);
    expect(detail.steps[0].parameters.find((p) => p.key === "row-flag")?.value).toBe("false");
    expect((await getRevisions(part.id))[0].recipeNumber).toBe("001207");
    const audit = await readAudit("partProcessRevision", (await prisma.partProcessRevision.findFirstOrThrow()).id);
    expect(audit[0].after).toMatchObject({ recipeSnapshot: snapshot, recipe: { number: "001207" } });
  });

  it("a suggestion edit or removal changes neither a captured snapshot nor a working revision's rows", async () => {
    const { part, code, field, stepId } = await fixture();
    await capture(part.id);
    const before = await stored(part.id);
    await asSystem(() => updateStepCodeWithFields(code.id, { code: "NEW", name: "Renamed", fields: [
      { id: field.id, label: "Renamed temperature", type: "NUMBER", unit: "F", sort: 9 },
    ] }));
    expect((await getRevision(part.id, 1)).steps[0]).toMatchObject({ code: "HT", codeName: "Heat",
      parameters: [{ key: field.id, label: "Temperature", unit: "F", position: 0, value: "" }] });
    // An instruction edit cuts the working revision 2 with the same rows; the suggestion's later
    // removal changes none of them (spec 2026-09-26 §3.2).
    const cut = await asSystem(() => saveProcessEdit(part.id, setInstruction(stepId, "Working")));
    expect(cut.revisionNumber).toBe(2);
    const working = await rowsOf(cut.stepIdMap[stepId]);
    await asSystem(() => setStepFields(code.id, []));
    expect((await getRevision(part.id, 1)).recipeSnapshot).toEqual(before);
    expect(await rowsOf(cut.stepIdMap[stepId])).toEqual(working);
    expect(working).toEqual([{ position: 0, key: field.id, label: "Temperature", type: "NUMBER", unit: "F", value: "" }]);
    expect(await prisma.recipeSnapshotField.count()).toBe(0);
  });

  it.each([
    ["type", false], ["unit", false], ["type", true], ["unit", true],
  ] as const)("refuses a suggestion's %s change in place (captured: %s): one key means one type and one unit", async (change, captured) => {
    const { part, code, field } = await fixture();
    if (captured) await capture(part.id);
    const fields = [{ id: field.id, label: field.label, type: "NUMBER" as const, unit: "F", sort: 1 }];
    await expect(asSystem(() => setStepFields(code.id, fields.map((f) => ({ ...f,
      ...(change === "type" ? { type: "TEXT" as const } : { unit: "C" }),
    }))))).rejects.toMatchObject({ status: 400, message: 'The type and unit of a suggested parameter cannot change. Remove "Temperature" and add a new one.' });
    expect(await prisma.processStepFieldDef.findUniqueOrThrow({ where: { id: field.id } })).toMatchObject({ type: "NUMBER", unit: "F" });
    // A unit that differs only by surrounding whitespace is the same unit (`normalizeUnit`).
    await asSystem(() => setStepFields(code.id, fields.map((f) => ({ ...f, unit: " F " }))));
    expect((await prisma.processStepFieldDef.findUniqueOrThrow({ where: { id: field.id } })).unit).toBe("F");
  });

  it("a new suggestion reaches only steps added after it, and capture lists each step's own rows", async () => {
    const { part, code, field, stepId } = await fixture("001207", "1650");
    await capture(part.id);
    const before = JSON.stringify(await stored(part.id));
    const base = { id: field.id, label: field.label, type: "NUMBER" as const, unit: "F", sort: 1 };
    await asSystem(() => setStepFields(code.id, [base, { label: "Replacement", type: "NUMBER", unit: "C", sort: 2 }]));
    const replacement = await prisma.processStepFieldDef.findFirstOrThrow({ where: { label: "Replacement" } });
    await capture(part.id);
    expect(JSON.stringify(await stored(part.id))).toBe(before);
    await asSystem(() => saveProcessEdit(part.id, setInstruction(stepId, "Next")));
    expect((await getRevision(part.id, 2)).recipeSnapshot).toBeNull();
    expect((await getRevision(part.id, 2)).steps[0].parameters).toEqual([{ key: field.id, label: "Temperature", type: "NUMBER", unit: "F", position: 0, value: "1650" }]);
    const added = await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "Added later" }));
    await capture(part.id);
    const fields = (await getRevision(part.id, 2)).recipeSnapshot?.steps.map((s) => s.fields.map((f) => [f.fieldDefId, f.label, f.unit, f.value]));
    expect(fields).toEqual([[[field.id, "Temperature", "F", "1650"]], [[field.id, "Temperature", "F", null], [replacement.id, "Replacement", "C", null]]]);
    expect(added.revisionNumber).toBe(2);
  });

  it("keeps locked legacy rows unchanged and rejects malformed persisted snapshots on read", async () => {
    const { part } = await fixture(null);
    await capture(part.id);
    const before = await prisma.partProcessRevision.findFirstOrThrow();
    await capture(part.id);
    expect(await prisma.partProcessRevision.findFirstOrThrow()).toEqual(before);
    expect((await getRevision(part.id, 1)).recipeSnapshot).toBeNull();
    await prisma.partProcessRevision.update({ where: { id: before.id }, data: { recipeSnapshot: { schemaVersion: 99 } } });
    await expect(getRevision(part.id, 1)).rejects.toThrow();
  });
});

const valid: RecipeSnapshotV1 = { schemaVersion: 1, recipeId: "r", recipeNumber: "001", partId: "p", revisionNumber: 1,
  steps: [{ stepId: "s", position: 1, codeId: "c", code: "HT", codeName: "Heat", instruction: "",
    fields: [{ fieldDefId: "f", label: "Temp", type: "NUMBER", unit: "F", position: 0, value: "1650" }] }] };
describe("recipe snapshot parser", () => {
  it.each([
    ["NUMBER", 1650], ["NUMBER", "NaN"], ["NUMBER", true], ["DATE", "2025-02-29"],
    ["DATE", true], ["TEXT", false], ["CHECKBOX", "true"], ["CHECKBOX", 0], ["OTHER", null],
  ])("rejects malformed %s value %s", (type, value) => {
    const input = structuredClone(valid);
    Object.assign(input.steps[0].fields[0], { type, value });
    expect(() => parseRecipeSnapshot(input)).toThrow();
  });
  it("requires complete versioned identity and accepts null for every field type", () => {
    for (const type of ["NUMBER", "TEXT", "DATE", "CHECKBOX"] as const) {
      const input = structuredClone(valid); Object.assign(input.steps[0].fields[0], { type, value: null });
      expect(parseRecipeSnapshot(input)).toEqual(input);
    }
    for (const patch of [{ schemaVersion: 2 }, { recipeNumber: 1207 }, { steps: null }, { partId: "" }, { extra: true }]) {
      expect(() => parseRecipeSnapshot({ ...valid, ...patch })).toThrow();
    }
  });
});

describe("barrier-driven recipe capture races", () => {
  beforeEach(truncateAll);
  it("real order capture wins before a value edit", async () => {
    await seedOrderGatePrereqs();
    const { part, field, stepId } = await fixture("001207", "1650");
    const result = await orderedRace(() => asSystem(() => createOrder({ customerId: part.customerId,
      lines: [{ partId: part.id, qty: 1, weight: "1.00" }],
    })), await valueEdit(part.id, stepId, field.id, "1700"));
    if (!result.ok) expect(result.error).toMatchObject({ status: 409 });
    else expect(result.value.revisionNumber).toBe(2);
    expect((await stored(part.id)).steps[0].fields[0]).toMatchObject({ value: "1650", unit: "F" });
    expect((await prisma.orderLine.findFirstOrThrow()).revisionNumber).toBe(1);
  });
  it("a value-edit revision cut wins before the real order selects its saved revision", async () => {
    await seedOrderGatePrereqs();
    const { part, field, stepId } = await fixture("001207", "1650");
    await capture(part.id);
    const result = await orderedRace(await valueEdit(part.id, stepId, field.id, "1700"),
      () => asSystem(() => createOrder({ customerId: part.customerId, lines: [{ partId: part.id, qty: 1, weight: "1.00" }] })));
    expect(result.ok).toBe(true); // the allocating order service retries a serialization conflict
    if (result.ok) expect(result.value.order.lines[0].revisionNumber).toBe(2);
    expect((await getRevision(part.id, 2)).recipeSnapshot?.steps[0].fields[0]).toMatchObject({ value: "1700", unit: "F" });
    expect((await stored(part.id)).steps[0].fields[0]).toMatchObject({ value: "1650", unit: "F" });
  });
  it.each(["ReadCommitted", "Serializable"] as const)("number assignment wins before %s capture selects its revision", async (isolation) => {
    const { part } = await fixture(null);
    await capture(part.id); // assignment must create N+1, exposing stale current-revision reads
    const result = await orderedRace(
      () => asSystem(() => saveRecipeNumber(part.id, { recipeNumber: "001207", expectedRecipeNumber: null })),
      () => capture(part.id, isolation),
    );
    if (!result.ok) expect(result.error).toMatchObject({ status: 409 });
    else {
      expect(result.value.revisionNumber).toBe(2);
      expect((await getRevision(part.id, 2)).recipeSnapshot?.recipeNumber).toBe("001207");
      expect((await getRevision(part.id, 1)).recipeSnapshot).toBeNull();
    }
    if (isolation === "ReadCommitted") expect(result.ok).toBe(true);
  });
  it("capture wins before number assignment; legacy capture never gains a retrospective number", async () => {
    const { part } = await fixture(null);
    const result = await orderedRace(() => capture(part.id),
      () => asSystem(() => saveRecipeNumber(part.id, { recipeNumber: "001207", expectedRecipeNumber: null })));
    if (!result.ok) expect(result.error).toMatchObject({ status: 409 });
    else expect(result.value.revisionNumber).toBe(2);
    const first = await getRevision(part.id, 1);
    expect(first.recipeNumber).toBeNull(); expect(first.recipeSnapshot).toBeNull();
  });
  it.each(["ReadCommitted", "Serializable"] as const)("value edit wins before %s capture", async (isolation) => {
    const { part, field, stepId } = await fixture("001207", "1650");
    await capture(part.id); // value edit must cut N+1 before the waiter chooses its revision
    const result = await orderedRace(await valueEdit(part.id, stepId, field.id, "1700"),
      () => capture(part.id, isolation));
    if (!result.ok) expect(result.error).toMatchObject({ status: 409 });
    else {
      expect(result.value.revisionNumber).toBe(2);
      expect((await getRevision(part.id, 2)).recipeSnapshot?.steps[0].fields[0]).toMatchObject({ value: "1700", unit: "F" });
      expect((await stored(part.id)).steps[0].fields[0]).toMatchObject({ value: "1650", unit: "F" });
    }
    if (isolation === "ReadCommitted") expect(result.ok).toBe(true);
  });
  it("capture wins before value edit and preserves its exact value/unit pair", async () => {
    const { part, field, stepId } = await fixture("001207", "1650");
    const result = await orderedRace(() => capture(part.id), await valueEdit(part.id, stepId, field.id, "1700"));
    if (!result.ok) expect(result.error).toMatchObject({ status: 409 });
    else expect(result.value.revisionNumber).toBe(2);
    expect((await stored(part.id)).steps[0].fields[0]).toMatchObject({ value: "1650", unit: "F" });
  });
  // Code names are the one catalog fact capture still reads, under the catalog claim; a
  // suggestion's type and unit can no longer be edited in place, so the rename is the race left.
  it.each(["ReadCommitted", "Serializable"] as const)("catalog code rename wins before %s capture", async (isolation) => {
    const { part, code } = await fixture();
    const result = await orderedRace(() => asSystem(() => updateStepCode(code.id, { name: "Renamed heat" })),
      () => capture(part.id, isolation));
    if (!result.ok) expect(result.error).toMatchObject({ status: 409 });
    else expect((await stored(part.id)).steps[0]).toMatchObject({ codeName: "Renamed heat", fields: [{ value: null, type: "NUMBER", unit: "F" }] });
    if (isolation === "ReadCommitted") expect(result.ok).toBe(true);
  });
  it("capture wins before a catalog code rename; the snapshot keeps the captured name", async () => {
    const { part, code } = await fixture();
    const result = await orderedRace(() => capture(part.id), () => asSystem(() => updateStepCode(code.id, { name: "Renamed heat" })));
    expect(result.ok).toBe(true);
    expect((await stored(part.id)).steps[0]).toMatchObject({ codeName: "Heat", fields: [{ value: null, type: "NUMBER", unit: "F" }] });
    expect((await prisma.processStepCode.findUniqueOrThrow({ where: { id: code.id } })).name).toBe("Renamed heat");
  });
});
