import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, prisma } from "./helpers/db";
import { Prisma } from "../prisma/generated/prisma/client";
import {
  listStepCodes, createStepCode, updateStepCode, deleteStepCode, setStepFields, updateStepCodeWithFields,
} from "@/server/process-step-codes";
import { saveRecipeNumber, lockRevision } from "@/server/part-process-steps";
import { appendProcessStep, readProcessEditorCatalog } from "@/server/process-document";
import { createReference } from "@/server/reference";
import { findBlockers } from "@/server/reference-blockers";
import { readAudit } from "@/server/audit";
import { HttpError } from "@/server/errors";
import { GET as listRoute, POST as createRoute } from "@/app/api/admin/step-codes/route";
import { PUT as updateRoute, DELETE as deleteRoute } from "@/app/api/admin/step-codes/[id]/route";
import { GET as stepCodeBlockersRoute } from "@/app/api/admin/step-codes/[id]/blockers/route";
import { GET as stepCodeBlockersExportRoute } from "@/app/api/admin/step-codes/[id]/blockers/export/route";
import { signInWith } from "./helpers/auth";
import { readXlsx } from "./helpers/xlsx";

// Shared by the guard-matrix and route-blocker describes below. `part.create` needs
// `eachWeight: 1` (a required non-default column); a "historical" revision is one with
// `lockedAt` set and a higher-numbered revision present (tests/process-step-code-blockers.test.ts
// precedent — Task 2's findBlockers coverage).
async function stepCodeFixture() {
  const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
  const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-1", eachWeight: 1 } });
  const { id: codeId } = await createStepCode({ code: "HT-01", name: "Austenitize" });
  return { customer, part, codeId };
}
const addPartStep = (revisionId: string, codeId: string, position = 1) =>
  prisma.partProcessStep.create({ data: { revisionId, codeId, position, instruction: "" } });

describe("process step codes", () => {
  beforeEach(async () => await truncateAll());

  it("a refused suggestion unit change rolls back its accompanying cosmetic code change and audit", async () => {
    const { part, codeId } = await stepCodeFixture();
    await setStepFields(codeId, [{ label: "Temperature", type: "NUMBER", unit: "F", sort: 1 }]);
    const def = await prisma.processStepFieldDef.findFirstOrThrow({ where: { codeId } });
    await saveRecipeNumber(part.id, { recipeNumber: "001207", expectedRecipeNumber: null });
    const revision = await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: part.id } });
    await addPartStep(revision.id, codeId);
    await prisma.$transaction((tx) => lockRevision(part.id, 1, tx));
    const before = await prisma.processStepCode.findUniqueOrThrow({ where: { id: codeId } });
    const audits = await prisma.auditLog.count();
    // Refused whether or not any row or capture exists (spec 2026-09-26 §3.3): one key, one unit.
    await expect(updateStepCodeWithFields(codeId, { name: "Should roll back", fields: [{
      id: def.id, label: def.label, type: "NUMBER", unit: "C", sort: 1,
    }] })).rejects.toMatchObject({ status: 400, message: 'The type and unit of a suggested parameter cannot change. Remove "Temperature" and add a new one.' });
    expect(await prisma.processStepCode.findUniqueOrThrow({ where: { id: codeId } })).toEqual(before);
    expect(await prisma.auditLog.count()).toBe(audits);
    expect((await prisma.processStepFieldDef.findUniqueOrThrow({ where: { id: def.id } })).unit).toBe("F");
  });

  it(".strict() rejects an unknown key on a field item instead of silently dropping it", async () => {
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await expect(setStepFields(id, [{ label: "Temp", type: "NUMBER", sort: 1, bogus: "x" } as never]))
      .rejects.toMatchObject({ status: 400 });
  });

  it("relabeling a suggestion by id preserves its id (the key a copied part row carries), and a new one stores a trimmed unit", async () => {
    const { id: codeId } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await setStepFields(codeId, [{ label: "Temp", type: "NUMBER", unit: " F ", sort: 1 }]);
    const fieldDef = (await listStepCodes()).find((c) => c.id === codeId)!.fields[0];
    expect(fieldDef.unit).toBe("F");
    await setStepFields(codeId, [{ id: fieldDef.id, label: "Temperature", type: "NUMBER", unit: "F", sort: 1 }]);
    const fields = (await listStepCodes()).find((c) => c.id === codeId)!.fields;
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ id: fieldDef.id, label: "Temperature", unit: "F" });
  });

  it("creates a code without a GL account and flags that it needs one", async () => {
    await createStepCode({ code: "HT-01", name: "Austenitize" });
    const [row] = await listStepCodes();
    expect(row).toMatchObject({ code: "HT-01", name: "Austenitize", glAccountId: null, needsGlAccount: true });
  });

  it("stores and audits standard instructions independently from existing steps", async () => {
    const { id } = await createStepCode({
      code: "HT-01", name: "Austenitize", defaultInstruction: "Inspect packaging.",
    });
    expect((await listStepCodes())[0].defaultInstruction).toBe("Inspect packaging.");

    const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "P-1", eachWeight: 1 },
    });
    const revision = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    const step = await prisma.partProcessStep.create({
      data: { revisionId: revision.id, position: 1, codeId: id, instruction: "Part-owned text" },
    });

    await updateStepCode(id, { defaultInstruction: "New default." });

    expect((await listStepCodes())[0].defaultInstruction).toBe("New default.");
    expect((await prisma.partProcessStep.findUniqueOrThrow({ where: { id: step.id } })).instruction)
      .toBe("Part-owned text");
    const [entry] = await readAudit("processStepCode", id);
    expect(entry.after).toMatchObject({ defaultInstruction: "New default." });
  });

  it("accepts 4000 standard-instruction characters and rejects 4001 on create and update", async () => {
    const { id } = await createStepCode({
      code: "HT-01", name: "Austenitize", defaultInstruction: "x".repeat(4000),
    });
    expect((await listStepCodes())[0].defaultInstruction).toHaveLength(4000);

    await expect(createStepCode({
      code: "HT-02", name: "Temper", defaultInstruction: "x".repeat(4001),
    })).rejects.toThrow();
    await expect(updateStepCode(id, { defaultInstruction: "x".repeat(4001) })).rejects.toThrow();
    await updateStepCode(id, { defaultInstruction: "y".repeat(4000) });
    expect((await listStepCodes())[0].defaultInstruction).toHaveLength(4000);
  });

  it("clears the needsGlAccount flag once an account is attached", async () => {
    const gl = await createReference("glAccount", { name: "4010" });
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await updateStepCode(id, { glAccountId: gl.id });
    expect((await listStepCodes())[0].needsGlAccount).toBe(false);
  });

  it("rejects a duplicate code", async () => {
    await createStepCode({ code: "HT-01", name: "Austenitize" });
    await expect(createStepCode({ code: "HT-01", name: "Other" })).rejects.toThrow(HttpError);
  });

  it("re-creating a deleted code makes a NEW code with no inherited fields", async () => {
    const gl = await createReference("glAccount", { name: "4010" });
    const { id: firstId } = await createStepCode({
      code: "HT-01", name: "Austenitize", glAccountId: gl.id, equipmentTag: "F1",
    });
    await setStepFields(firstId, [{ label: "Soak", type: "NUMBER", unit: "min", sort: 0 }]);

    // Confirm the non-default values actually took before the delete — otherwise the
    // "resets to default" assertions below could pass even if they never applied in the first
    // place (Task 7's review caught exactly this: a field seeded with its own default value).
    const firstRow = (await listStepCodes()).find((c) => c.id === firstId)!;
    expect(firstRow).toMatchObject({ glAccountId: gl.id, equipmentTag: "F1" });
    expect(firstRow.fields).toHaveLength(1);

    await deleteStepCode(firstId);

    const { id: secondId } = await createStepCode({ code: "HT-01", name: "Renamed" });
    expect(secondId).not.toBe(firstId);

    const [fresh] = await listStepCodes();
    expect(fresh).toMatchObject({
      id: secondId, code: "HT-01", name: "Renamed",
      glAccountId: null, equipmentTag: "", defaultInstruction: "", active: true, needsGlAccount: true,
    });
    expect(fresh.fields).toEqual([]);

    // A real create entry under its own identity — the defect issue #10 was filed for.
    expect((await readAudit("processStepCode", secondId)).map((e) => e.action)).toEqual(["create"]);
  });

  it("still rejects a duplicate code when the existing row is not soft-deleted", async () => {
    await createStepCode({ code: "HT-01", name: "Austenitize" });
    await expect(createStepCode({ code: "HT-01", name: "Other" })).rejects.toMatchObject({ status: 400 });
    expect(await listStepCodes()).toHaveLength(1);
  });

  it("stores ordered field definitions and returns them in sort order", async () => {
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await setStepFields(id, [
      { label: "Carbon potential", type: "NUMBER", sort: 3 },
      { label: "Temperature", type: "NUMBER", unit: "F", sort: 1 },
      { label: "Time", type: "NUMBER", unit: "min", sort: 2 },
    ]);
    const fields = (await listStepCodes())[0].fields;
    expect(fields.map((f) => f.label)).toEqual(["Temperature", "Time", "Carbon potential"]);
    expect(fields[0].unit).toBe("F");
  });

  it("a code with no fields is valid — Hot Wash is text only", async () => {
    const { id } = await createStepCode({ code: "WS-01", name: "Hot Wash" });
    await setStepFields(id, []);
    expect((await listStepCodes()).find((c) => c.id === id)?.fields).toEqual([]);
  });

  it("setStepFields replaces the whole set rather than appending", async () => {
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await setStepFields(id, [{ label: "Temperature", type: "NUMBER", sort: 1 }]);
    await setStepFields(id, [{ label: "Time", type: "NUMBER", sort: 1 }]);
    const fields = (await listStepCodes())[0].fields;
    expect(fields.map((f) => f.label)).toEqual(["Time"]);
  });

  it("rejects an unknown field type", async () => {
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    // @ts-expect-error deliberately invalid type
    await expect(setStepFields(id, [{ label: "X", type: "COLOUR", sort: 1 }])).rejects.toThrow();
  });

  it("audits field changes with a diff that names the fields", async () => {
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await setStepFields(id, [{ label: "Temperature", type: "NUMBER", sort: 1 }]);
    const [entry] = await readAudit("processStepCode", id);
    const after = (entry.after as { fields: { label: string }[] }).fields.map((f) => f.label);
    expect(after).toEqual(["Temperature"]);
  });

  it("soft deletes", async () => {
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await deleteStepCode(id);
    expect(await listStepCodes()).toHaveLength(0);
  });

  it("rejects duplicate sort values instead of leaving Postgres to tie-break the order", async () => {
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await expect(setStepFields(id, [
      { label: "Temperature", type: "NUMBER", sort: 1 },
      { label: "Time", type: "NUMBER", sort: 1 },
    ])).rejects.toThrow();
    expect((await listStepCodes())[0].fields).toEqual([]);
  });

  // #406: a save refuses a NEW or RENAMED suggestion whose name is blank or one the code already
  // has, in words of its own: the unique index would otherwise answer through the code's own save
  // wrapper, as a duplicate CODE. A suggestion the save leaves as it is stored is not judged, so a
  // code holding names from before the rule can still be edited one row at a time.
  describe("suggestion names (#406)", () => {
    const names = async () => (await listStepCodes())[0].fields.map((f) => f.label);
    /** Suggestions as they could be stored before #406: written straight to the table. */
    const legacy = async (codeId: string, labels: string[]) => {
      await prisma.processStepFieldDef.createMany({ data: labels.map((label, sort) => ({ codeId, label, type: "NUMBER" as const, sort })) });
      return (await listStepCodes())[0].fields;
    };

    it("refuses two suggestions with the same name, and says which name, through both save paths", async () => {
      const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
      const twice = [{ label: "Soak", type: "NUMBER" as const, sort: 0 }, { label: "Soak", type: "TEXT" as const, sort: 1 }];
      await expect(setStepFields(id, twice)).rejects.toMatchObject({ status: 400, message: 'A suggested parameter named "Soak" already exists' });
      await expect(updateStepCodeWithFields(id, { fields: twice })).rejects.toMatchObject({ status: 400, message: 'A suggested parameter named "Soak" already exists' });
      expect(await names()).toEqual([]);
    });

    it("counts names that differ only by case (owner ruling 2026-10-01) or by surrounding spaces (a name is trimmed) as the same", async () => {
      const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
      await setStepFields(id, [{ label: "Soak", type: "NUMBER", sort: 0 }]);
      const [saved] = (await listStepCodes())[0].fields;
      for (const label of ["soak", "SOAK", " Soak", "Soak  "]) {
        await expect(setStepFields(id, [saved, { label, type: "NUMBER", sort: 1 }]), JSON.stringify(label))
          .rejects.toMatchObject({ status: 400, message: `A suggested parameter named "${label.trim()}" already exists` });
      }
      expect(await names()).toEqual(["Soak"]);
    });

    it("keeps names that differ by inner spacing apart (owner ruling 2026-10-01)", async () => {
      const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
      await setStepFields(id, [{ label: "Soak time", type: "NUMBER", sort: 0 }, { label: "Soak  time", type: "NUMBER", sort: 1 }]);
      expect(await names()).toEqual(["Soak time", "Soak  time"]);
    });

    it("stores a name trimmed, a renamed one included", async () => {
      const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
      await setStepFields(id, [{ label: "  Soak time ", type: "NUMBER", sort: 0 }]);
      expect(await names()).toEqual(["Soak time"]);
      const [saved] = (await listStepCodes())[0].fields;
      await updateStepCodeWithFields(id, { fields: [{ ...saved, label: " Hold  " }] });
      expect(await names()).toEqual(["Hold"]);
      // Padding alone is a change too: the stored name sent back padded stays trimmed.
      await updateStepCodeWithFields(id, { fields: [{ ...saved, label: " Hold " }] });
      expect(await names()).toEqual(["Hold"]);
    });

    it("refuses a name over 60 characters as sent, and stores one of exactly 60", async () => {
      const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
      const at = "x".repeat(60); const over = "x".repeat(61);
      await expect(setStepFields(id, [{ label: over, type: "NUMBER", sort: 0 }])).rejects.toMatchObject({ status: 400 });
      await expect(updateStepCodeWithFields(id, { fields: [{ label: over, type: "NUMBER", sort: 0 }] })).rejects.toMatchObject({ status: 400 });
      expect(await names()).toEqual([]);
      await setStepFields(id, [{ label: at, type: "NUMBER", sort: 0 }]);
      expect(await names()).toEqual([at]);
    });

    it("answers a removed suggestion's id as not found before any naming question, wherever it is listed", async () => {
      const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
      await setStepFields(id, [{ label: "Hold", type: "NUMBER", sort: 0 }, { label: "Temp", type: "NUMBER", sort: 1 }]);
      const [hold, temp] = (await listStepCodes())[0].fields;
      // Another save removes Hold; a screen still showing it sends its id back.
      await setStepFields(id, [{ ...temp, sort: 0 }]);
      const stale = { status: 404, message: "Suggested parameter not found" };
      // The stale row's name reads the same as a rename beside it, in either order, or is blank.
      await expect(setStepFields(id, [hold, { ...temp, label: "hold" }])).rejects.toMatchObject(stale);
      await expect(setStepFields(id, [{ ...temp, label: "hold" }, hold])).rejects.toMatchObject(stale);
      await expect(setStepFields(id, [{ ...temp, label: "hold" }, { ...hold, label: " " }])).rejects.toMatchObject(stale);
      expect(await names()).toEqual(["Temp"]);
    });

    it("refuses a name that is empty or only whitespace, as a 400 that says a name is needed", async () => {
      const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
      for (const label of ["", " ", " \t "]) {
        await expect(setStepFields(id, [{ label, type: "NUMBER", sort: 0 }]), JSON.stringify(label))
          .rejects.toMatchObject({ status: 400, message: expect.stringContaining("A suggested parameter needs a name") });
        await expect(updateStepCodeWithFields(id, { fields: [{ label, type: "NUMBER", sort: 0 }] }), JSON.stringify(label))
          .rejects.toMatchObject({ status: 400, message: expect.stringContaining("A suggested parameter needs a name") });
      }
      expect(await names()).toEqual([]);
    });

    it("still lets a removed name come back as a new suggestion in the same save", async () => {
      const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
      await setStepFields(id, [{ label: "Soak", type: "NUMBER", sort: 0 }]);
      const [first] = (await listStepCodes())[0].fields;
      await setStepFields(id, [{ label: "soak", type: "TEXT", sort: 0 }]);
      const [second] = (await listStepCodes())[0].fields;
      expect(second).toMatchObject({ label: "soak", type: "TEXT" });
      expect(second.id).not.toBe(first.id);
    });

    it("refuses two suggestions swapping names in one save as a name conflict, not a duplicate code", async () => {
      const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
      await setStepFields(id, [{ label: "Soak", type: "NUMBER", sort: 0 }, { label: "Hold", type: "NUMBER", sort: 1 }]);
      const [soak, hold] = (await listStepCodes())[0].fields;
      const swapped = [{ ...soak, label: "Hold" }, { ...hold, label: "Soak" }];
      // The first rename meets the other row's still-current name at the unique index.
      await expect(updateStepCodeWithFields(id, { fields: swapped }))
        .rejects.toMatchObject({ status: 400, message: "A suggested parameter with that name already exists" });
      await expect(setStepFields(id, swapped))
        .rejects.toMatchObject({ status: 400, message: "A suggested parameter with that name already exists" });
      expect(await names()).toEqual(["Soak", "Hold"]);
    });

    it("refuses a rename onto a name the code already has, naming the typed name trimmed, whichever row is renamed", async () => {
      const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
      await setStepFields(id, [{ label: "Soak", type: "NUMBER", sort: 0 }, { label: "Hold", type: "NUMBER", sort: 1 }]);
      const [soak, hold] = (await listStepCodes())[0].fields;
      await expect(updateStepCodeWithFields(id, { fields: [soak, { ...hold, label: " soak" }] }))
        .rejects.toMatchObject({ status: 400, message: 'A suggested parameter named "soak" already exists' });
      await expect(updateStepCodeWithFields(id, { fields: [{ ...soak, label: "HOLD" }, hold] }))
        .rejects.toMatchObject({ status: 400, message: 'A suggested parameter named "HOLD" already exists' });
      expect(await names()).toEqual(["Soak", "Hold"]);
      // Its own case is a suggestion's to change: there is no other row to collide with.
      await updateStepCodeWithFields(id, { fields: [{ ...soak, label: "SOAK" }, hold] });
      expect(await names()).toEqual(["SOAK", "Hold"]);
    });

    it("leaves names stored before the rule alone, so such a code is edited one row at a time", async () => {
      const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
      // Three that now read the same, one blank, one padded: all legal before #406 and #396.
      const [soak, lower, upper, blank, padded] = await legacy(id, ["Soak", "soak", "SOAK", "  ", " Hold "]);
      const all = [soak, lower, upper, blank, padded];
      // A reorder, and a new suggestion of another name, send every stored name back untouched.
      await setStepFields(id, [padded, soak, lower, upper, blank].map((f, sort) => ({ ...f, sort })));
      await setStepFields(id, [...all, { label: "Quench", type: "TEXT" as const, sort: 5 }].map((f, sort) => ({ ...f, sort })));
      expect(await names()).toEqual(["Soak", "soak", "SOAK", "  ", " Hold ", "Quench"]);
      const quench = (await listStepCodes())[0].fields[5];
      // One row renamed away, one removed: each goes through although its neighbours still collide.
      await setStepFields(id, [soak, { ...lower, label: "Temper" }, upper, blank, padded, quench]);
      await setStepFields(id, [soak, { ...lower, label: "Temper" }, blank, padded, quench].map((f, sort) => ({ ...f, sort })));
      expect(await names()).toEqual(["Soak", "Temper", "  ", " Hold ", "Quench"]);
      // The untouched padded and blank names are still stored as they were.
      expect((await prisma.processStepFieldDef.findMany({ where: { codeId: id, deletedAt: null }, orderBy: { sort: "asc" } })).map((d) => d.label))
        .toEqual(["Soak", "Temper", "  ", " Hold ", "Quench"]);
    });

    it("still judges what a save changes on such a code: a new or renamed name must be real and unused", async () => {
      const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
      const [soak, lower, blank, padded] = await legacy(id, ["Soak", "soak", "  ", " Hold "]);
      const refused = (fields: Parameters<typeof setStepFields>[1], message: string) =>
        expect(setStepFields(id, fields), message).rejects.toMatchObject({ status: 400, message });
      await refused([soak, lower, blank, padded, { label: "hold", type: "NUMBER", sort: 4 }], 'A suggested parameter named "hold" already exists');
      await refused([soak, lower, blank, padded, { label: "SOAK", type: "NUMBER", sort: 4 }], 'A suggested parameter named "SOAK" already exists');
      await refused([soak, lower, blank, { ...padded, label: "soak " }], 'A suggested parameter named "soak" already exists');
      await refused([soak, lower, { ...blank, label: " " }, padded], "A suggested parameter needs a name");
      await refused([soak, lower, blank, padded, { label: " \t", type: "NUMBER", sort: 4 }], "A suggested parameter needs a name");
      expect(await names()).toEqual(["Soak", "soak", "  ", " Hold "]);
      // The blank one is given a name, and the padded one renamed, trimmed.
      await setStepFields(id, [soak, lower, { ...blank, label: "Temper" }, { ...padded, label: " Hold time " }]);
      expect(await names()).toEqual(["Soak", "soak", "Temper", "Hold time"]);
    });

    it("renames a row beside a padded name that reads the same, the padded one listed first", async () => {
      const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
      const [padded, plain] = await legacy(id, ["Soak ", "Soak"]);
      await updateStepCodeWithFields(id, { fields: [padded, { ...plain, label: "Hold" }] });
      expect(await names()).toEqual(["Soak ", "Hold"]);
    });

    it("answers a write failure that is not a name conflict as what it is, not as a name conflict", async () => {
      const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
      await setStepFields(id, [{ label: "Soak", type: "NUMBER", sort: 0 }]);
      const [soak] = (await listStepCodes())[0].fields;
      // The suggestion write is made to fail the way a serialization abort does. `$transaction` is
      // wrapped by plain save and restore (never `vi.spyOn` on this client), and the real
      // transaction is handed on behind a proxy whose suggestion `create` throws.
      const real = prisma.$transaction.bind(prisma);
      const original = prisma.$transaction;
      const abort = new Prisma.PrismaClientKnownRequestError("Simulated serialization abort", { code: "P2034", clientVersion: "test" });
      (prisma as { $transaction: unknown }).$transaction = (fn: (tx: unknown) => Promise<unknown>, options?: unknown) =>
        (real as (f: (tx: unknown) => Promise<unknown>, o?: unknown) => Promise<unknown>)((tx) => fn(new Proxy(tx as object, {
          get(target, key, receiver) {
            if (key !== "processStepFieldDef") return Reflect.get(target, key, receiver);
            const delegate = Reflect.get(target, key, receiver) as object;
            return new Proxy(delegate, { get: (d, k, r) => (k === "create" ? () => { throw abort; } : Reflect.get(d, k, r)) });
          },
        })), options);
      try {
        await expect(setStepFields(id, [soak, { label: "Hold", type: "NUMBER", sort: 1 }])).rejects.toMatchObject({ status: 409 });
      } finally {
        (prisma as { $transaction: unknown }).$transaction = original;
      }
      expect(prisma.$transaction).toBe(original);
      expect(await names()).toEqual(["Soak"]);
    });

    it("the PUT route answers a duplicate name with that message", async () => {
      const cookie = await signInWith(["admin.edit"]);
      const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
      const res = await updateRoute(new Request(`http://t/api/admin/step-codes/${id}`, {
        method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ fields: [{ label: "Soak", type: "NUMBER", sort: 0 }, { label: " soak ", type: "NUMBER", sort: 1 }] }),
      }), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'A suggested parameter named "soak" already exists' });
    });
  });

  it("404s setStepFields against a nonexistent code instead of silently succeeding", async () => {
    await expect(setStepFields("nope", [])).rejects.toMatchObject({ status: 404 });
    await expect(setStepFields("nope", [{ label: "X", type: "NUMBER", sort: 1 }]))
      .rejects.toMatchObject({ status: 404 });
  });
});

/** A code's audit image of its suggestions (SNAPSHOT_INCLUDE.processStepCode). */
type CodeSnapshot = { fields: { id: string; label: string; type: string; unit: string | null; sort: number }[] };

// A part row copied from a suggestion carries the suggestion's ID as its key, so one key always
// means one type and one unit: a suggestion's type and unit never change in place, and removing
// one soft-deletes it, so the process-document save can still verify a copied key against it
// (spec 2026-09-26 §3.2: removing a suggestion never changes a draft). The exact-message type and
// unit refusals, with and without a captured revision, are in recipe-snapshots.test.ts.
describe("suggested parameters (spec 2026-09-26 §3.2–§3.3)", () => {
  beforeEach(async () => await truncateAll());
  const suggestionsOf = async (codeId: string) => (await listStepCodes()).find((c) => c.id === codeId)!.fields;

  it("a label change by id keeps the id and never rewrites the stored unit, even one stored with surrounding spaces", async () => {
    const { id: codeId } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await setStepFields(codeId, [{ label: "Temperature", type: "NUMBER", unit: "°F", sort: 0 }]);
    const [def] = await suggestionsOf(codeId);
    // A unit stored before units were normalized: the admin schema never trimmed it.
    await prisma.processStepFieldDef.update({ where: { id: def.id }, data: { unit: " °F " } });
    // As the admin page sends it (the stored unit echoed back), and trimmed: the same unit either way.
    for (const [label, unit] of [["Furnace temperature", " °F "], ["Quench temperature", "°F"]]) {
      await setStepFields(codeId, [{ id: def.id, label, type: "NUMBER", unit, sort: 0 }]);
      expect(await prisma.processStepFieldDef.findUniqueOrThrow({ where: { id: def.id } }))
        .toMatchObject({ label, type: "NUMBER", unit: " °F " });
    }
    expect((await suggestionsOf(codeId)).map((f) => f.id)).toEqual([def.id]);
  });

  it("removing a suggestion soft-deletes it: a part row copied from it keeps its key, label and value; it leaves the admin list, the catalog and the code's audit image; its label is free for a new ID", async () => {
    const { part, codeId } = await stepCodeFixture();
    await setStepFields(codeId, [
      { label: "Temperature", type: "NUMBER", unit: "F", sort: 0 },
      { label: "Note", type: "TEXT", sort: 1 },
    ]);
    const [temperature, note] = await suggestionsOf(codeId);
    const { stepId } = await appendProcessStep(part.id, { codeId, values: { Temperature: "1500" } });
    const rows = () => prisma.partProcessStepParameter.findMany({
      where: { stepId }, orderBy: { position: "asc" }, select: { key: true, label: true, type: true, unit: true, value: true },
    });
    const copied = await rows();
    expect(copied).toEqual([
      { key: temperature.id, label: "Temperature", type: "NUMBER", unit: "F", value: "1500" },
      { key: note.id, label: "Note", type: "TEXT", unit: null, value: "" },
    ]);

    await setStepFields(codeId, [{ id: note.id, label: "Note", type: "TEXT", unit: null, sort: 0 }]);

    expect(await prisma.processStepFieldDef.findUniqueOrThrow({ where: { id: temperature.id } }))
      .toMatchObject({ label: "Temperature", type: "NUMBER", unit: "F", deletedAt: expect.any(Date) });
    expect(await rows()).toEqual(copied);
    expect((await suggestionsOf(codeId)).map((f) => f.id)).toEqual([note.id]);
    expect((await readProcessEditorCatalog()).find((c) => c.id === codeId)!.fields.map((f) => f.id)).toEqual([note.id]);
    const [removal] = await readAudit("processStepCode", codeId);
    expect((removal.before as CodeSnapshot).fields.map((f) => f.id)).toEqual([temperature.id, note.id]);
    expect((removal.after as CodeSnapshot).fields.map((f) => f.id)).toEqual([note.id]);

    // Labels are unique among live suggestions only: the label comes back as a new suggestion with
    // its own ID, so it may carry another unit without touching the copied row.
    await setStepFields(codeId, [
      { id: note.id, label: "Note", type: "TEXT", unit: null, sort: 0 },
      { label: "Temperature", type: "NUMBER", unit: "C", sort: 1 },
    ]);
    const [, reused] = await suggestionsOf(codeId);
    expect(reused).toMatchObject({ label: "Temperature", type: "NUMBER", unit: "C" });
    expect(reused.id).not.toBe(temperature.id);
    expect((await suggestionsOf(codeId)).map((f) => f.id)).toEqual([note.id, reused.id]);
    expect(await rows()).toEqual(copied);
  });

  it("replacing a suggestion with an identical one in one save shows in the code's history as a changed ID", async () => {
    const { id: codeId } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    const temperature = { label: "Temperature", type: "NUMBER" as const, unit: "F", sort: 0 };
    await setStepFields(codeId, [temperature]);
    const [old] = await suggestionsOf(codeId);
    // No id: the save removes the old suggestion and adds an identical one. A part row copied from
    // the old one keeps the old ID as its key, so the two are different parameters.
    await setStepFields(codeId, [temperature]);
    const [replacement] = await suggestionsOf(codeId);
    expect(replacement.id).not.toBe(old.id);
    const [entry] = await readAudit("processStepCode", codeId);
    expect((entry.before as CodeSnapshot).fields).toEqual([{ id: old.id, ...temperature }]);
    expect((entry.after as CodeSnapshot).fields).toEqual([{ id: replacement.id, ...temperature }]);
  });

  it("a stale payload naming a removed suggestion 404s and rolls back, never editing the removed row or removing a live one", async () => {
    const { id: codeId } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await setStepFields(codeId, [{ label: "Temperature", type: "NUMBER", unit: "F", sort: 0 }]);
    // A second tab loads the code; then the first tab removes Temperature and adds Time.
    const stale = await suggestionsOf(codeId);
    await setStepFields(codeId, [{ label: "Time", type: "NUMBER", unit: "min", sort: 0 }]);
    const live = await listStepCodes();
    const table = await prisma.processStepFieldDef.findMany({ where: { codeId }, orderBy: { id: "asc" } });
    const audits = await prisma.auditLog.count();
    // The second tab relabels the Temperature it still shows.
    await expect(setStepFields(codeId, stale.map((f) => ({ ...f, label: "Furnace temperature" }))))
      .rejects.toMatchObject({ status: 404, message: "Suggested parameter not found" });
    expect(await listStepCodes()).toEqual(live);
    expect(await prisma.processStepFieldDef.findMany({ where: { codeId }, orderBy: { id: "asc" } })).toEqual(table);
    expect(await prisma.auditLog.count()).toBe(audits);
  });

  it("PUT answers a type or unit change by id with the rule's 400, and accepts a label change, a reorder, an add and a removal in one request", async () => {
    const cookie = await signInWith(["admin.edit"]);
    const { id: codeId } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await setStepFields(codeId, [
      { label: "Temperature", type: "NUMBER", unit: "F", sort: 0 },
      { label: "Time", type: "NUMBER", unit: "min", sort: 1 },
      { label: "Note", type: "TEXT", sort: 2 },
    ]);
    const [temperature, time, note] = await suggestionsOf(codeId);
    const put = (fields: unknown) => updateRoute(new Request(`http://t/api/admin/step-codes/${codeId}`, {
      method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ fields }),
    }), { params: Promise.resolve({ id: codeId }) });
    for (const change of [{ unit: "C" }, { type: "TEXT" }]) {
      const refused = await put([{ ...temperature, ...change }, time, note]);
      expect(refused.status).toBe(400);
      expect((await refused.json()).error)
        .toBe('The type and unit of a suggested parameter cannot change. Remove "Temperature" and add a new one.');
    }
    expect(await suggestionsOf(codeId)).toEqual([temperature, time, note]);
    const accepted = await put([
      { ...note, sort: 0 }, { ...time, label: "Soak time", sort: 1 }, { label: "Load", type: "TEXT", unit: null, sort: 2 },
    ]);
    expect(accepted.status).toBe(200);
    const after = await suggestionsOf(codeId);
    expect(after.map((f) => [f.label, f.type, f.unit])).toEqual([["Note", "TEXT", null], ["Soak time", "NUMBER", "min"], ["Load", "TEXT", null]]);
    expect(after.slice(0, 2).map((f) => f.id)).toEqual([note.id, time.id]);
    expect((await prisma.processStepFieldDef.findUniqueOrThrow({ where: { id: temperature.id } })).deletedAt).toBeInstanceOf(Date);
  });
});

describe("process step code routes", () => {
  beforeEach(async () => await truncateAll());
  const ctx = { params: Promise.resolve({}) };
  const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

  it("401s on every verb without a session", async () => {
    const get = await listRoute(new Request("http://t/api/admin/step-codes"), ctx);
    expect(get.status).toBe(401);

    const post = await createRoute(new Request("http://t/api/admin/step-codes", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "HT-01", name: "Austenitize" }),
    }), ctx);
    expect(post.status).toBe(401);

    const put = await updateRoute(new Request("http://t/api/admin/step-codes/placeholder", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }),
    }), idCtx("placeholder"));
    expect(put.status).toBe(401);

    const del = await deleteRoute(
      new Request("http://t/api/admin/step-codes/placeholder", { method: "DELETE" }), idCtx("placeholder"),
    );
    expect(del.status).toBe(401);
  });

  it("403s for a signed-in user lacking the specific verb each route requires", async () => {
    const cookie = await signInWith(["admin.view"]);

    const ok = await listRoute(new Request("http://t/api/admin/step-codes", { headers: { cookie } }), ctx);
    expect(ok.status).toBe(200);

    const post = await createRoute(new Request("http://t/api/admin/step-codes", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ code: "HT-01", name: "Austenitize" }),
    }), ctx);
    expect(post.status).toBe(403);

    const put = await updateRoute(new Request("http://t/api/admin/step-codes/placeholder", {
      method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "x" }),
    }), idCtx("placeholder"));
    expect(put.status).toBe(403);

    const del = await deleteRoute(new Request("http://t/api/admin/step-codes/placeholder", {
      method: "DELETE", headers: { cookie },
    }), idCtx("placeholder"));
    expect(del.status).toBe(403);
  });

  it("rejects an empty PUT body with 400 rather than reporting success for a no-op", async () => {
    const cookie = await signInWith(["admin.edit"]);
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });

    const res = await updateRoute(new Request(`http://t/api/admin/step-codes/${id}`, {
      method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({}),
    }), idCtx(id));
    expect(res.status).toBe(400);
  });

  // `fields` is destructured out of `scalars` whatever its type, and `hasFields` only asks whether
  // it is an array — so a present-but-malformed `fields` used to vanish while the scalar half of
  // the same PUT applied and returned 200. That is the half-apply the route's atomic contract
  // exists to prevent, and the caller had no way to tell its field changes were dropped (Codex,
  // MR !22). Absent `fields` is still a legal scalars-only PUT; JSON cannot carry an `undefined`
  // value, so "not undefined" is exactly "the key was present".
  it("rejects a malformed fields value instead of dropping it and applying the scalars", async () => {
    const cookie = await signInWith(["admin.edit"]);

    for (const malformed of [null, {}, "nope", 7] as const) {
      const { id } = await createStepCode({ code: `HT-${String(malformed)}`, name: "Austenitize" });
      await setStepFields(id, [{ label: "Temperature", type: "NUMBER", sort: 1 }]);

      const res = await updateRoute(new Request(`http://t/api/admin/step-codes/${id}`, {
        method: "PUT", headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Renamed", fields: malformed }),
      }), idCtx(id));
      expect(res.status).toBe(400);

      // Neither half applied: the name is untouched and the field set is untouched.
      const code = (await listStepCodes()).find((c) => c.id === id);
      expect(code?.name).toBe("Austenitize");
      expect(code?.fields.map((f) => f.label)).toEqual(["Temperature"]);
    }
  });

  // A stale tab keeps a deleted code's editor on screen. Its next PUT used to succeed, because
  // the update matched on `id` alone with no liveness filter — so scalars and field definitions
  // were mutated under a soft-deleted code, and an `update` audit entry was written after the
  // delete entry, describing a change to a row nothing can see (Codex, MR !22). The code has no
  // undelete path, so nothing about that write was ever going to become visible again.
  it("refuses a PUT against a soft-deleted code instead of mutating it invisibly", async () => {
    const cookie = await signInWith(["admin.edit"]);
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await setStepFields(id, [{ label: "Temperature", type: "NUMBER", sort: 1 }]);
    await deleteStepCode(id);
    const auditAfterDelete = (await readAudit("processStepCode", id)).length;

    for (const body of [{ name: "Renamed" }, { fields: [{ label: "Time", type: "NUMBER", sort: 1 }] }]) {
      const res = await updateRoute(new Request(`http://t/api/admin/step-codes/${id}`, {
        method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
      }), idCtx(id));
      expect(res.status).toBe(404);
    }

    const row = await prisma.processStepCode.findUniqueOrThrow({
      where: { id }, include: { fields: true },
    });
    expect(row.name).toBe("Austenitize");
    expect(row.fields.map((f) => f.label)).toEqual(["Temperature"]);
    // No audit entry describing a change to a row that is already deleted.
    expect(await readAudit("processStepCode", id)).toHaveLength(auditAfterDelete);
  });

  it("still accepts a scalars-only PUT that omits fields entirely", async () => {
    const cookie = await signInWith(["admin.edit"]);
    const { id } = await createStepCode({ code: "HT-02", name: "Austenitize" });
    await setStepFields(id, [{ label: "Temperature", type: "NUMBER", sort: 1 }]);

    const res = await updateRoute(new Request(`http://t/api/admin/step-codes/${id}`, {
      method: "PUT", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    }), idCtx(id));
    expect(res.status).toBe(200);

    const code = (await listStepCodes()).find((c) => c.id === id);
    expect(code?.name).toBe("Renamed");
    expect(code?.fields.map((f) => f.label)).toEqual(["Temperature"]);
  });

  it("a PUT with valid fields and an invalid glAccountId applies neither and writes no audit row", async () => {
    const cookie = await signInWith(["admin.edit"]);
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await setStepFields(id, [{ label: "Temperature", type: "NUMBER", sort: 1 }]);
    const auditCountBefore = (await readAudit("processStepCode", id)).length;

    const res = await updateRoute(new Request(`http://t/api/admin/step-codes/${id}`, {
      method: "PUT", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        glAccountId: "does-not-exist",
        fields: [{ label: "Time", type: "NUMBER", sort: 1 }],
      }),
    }), idCtx(id));
    expect(res.status).toBe(400);

    const fields = (await listStepCodes())[0].fields;
    expect(fields.map((f) => f.label)).toEqual(["Temperature"]);
    expect(await readAudit("processStepCode", id)).toHaveLength(auditCountBefore);
  });
});

// Task 7: deleteStepCode adopts deleteReference's guarded shape verbatim (reference.ts:210) —
// Serializable transaction, findBlockers scan, refuse-with-count or auditedSoftDelete. Owner
// ruling (design spec §3.2 / §7): ANY live use blocks — a current-revision step or a
// locked-historical step — while a soft-deleted part's step never does (liveWhere, Task 2).
describe("step-code delete guard", () => {
  beforeEach(async () => await truncateAll());

  it("blocks delete when the code is used by a current-revision step", async () => {
    const { part, codeId } = await stepCodeFixture();
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    await addPartStep(rev.id, codeId);

    const err = await deleteStepCode(codeId).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).message).toBe("That process step code is still in use by 1 record(s)");
    expect(await listStepCodes()).toHaveLength(1);
  });

  it("blocks delete when the code is used ONLY by a locked-historical step (owner ruling §3.2)", async () => {
    const { part, codeId } = await stepCodeFixture();
    const historical = await prisma.partProcessRevision.create({
      data: { partId: part.id, revisionNumber: 1, lockedAt: new Date() },
    });
    await addPartStep(historical.id, codeId);
    // The current revision exists (higher-numbered, unlocked) and does NOT reference the code —
    // the only live reference is the locked, historical one.
    await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 2 } });

    const err = await deleteStepCode(codeId).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).message).toBe("That process step code is still in use by 1 record(s)");
    expect(await listStepCodes()).toHaveLength(1);
  });

  it("does NOT block on a step under a soft-deleted part", async () => {
    const { part, codeId } = await stepCodeFixture();
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    await addPartStep(rev.id, codeId);
    await prisma.part.update({ where: { id: part.id }, data: { deletedAt: new Date() } });

    await expect(deleteStepCode(codeId)).resolves.toBeUndefined();
    expect(await listStepCodes()).toHaveLength(0);
  });

  it("an unused code soft-deletes cleanly, recording a delete audit entry", async () => {
    const { codeId } = await stepCodeFixture();

    await expect(deleteStepCode(codeId)).resolves.toBeUndefined();

    expect(await listStepCodes()).toHaveLength(0);
    // readAudit orders newest-first ({ at: "desc" }, { id: "desc" }) — see audit.ts.
    expect((await readAudit("processStepCode", codeId)).map((e) => e.action)).toEqual(["delete", "create"]);
  });

  it("the 400 count matches the deduped blocker list length across two revisions of one part", async () => {
    const { part, codeId } = await stepCodeFixture();
    const historical = await prisma.partProcessRevision.create({
      data: { partId: part.id, revisionNumber: 1, lockedAt: new Date() },
    });
    const current = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 2 } });
    await addPartStep(historical.id, codeId);
    await addPartStep(current.id, codeId);

    // Same part referenced from both revisions — findBlockers dedupes it to one row (Task 2).
    const blockers = await findBlockers("processStepCode", codeId);
    expect(blockers).toHaveLength(1);

    const err = await deleteStepCode(codeId).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message).toBe(`That process step code is still in use by ${blockers.length} record(s)`);
  });
});

// Mirrors tests/reference-blockers.test.ts's route coverage for
// src/app/api/admin/reference/[kind]/[id]/blockers{,/export}/route.ts — same `mustCan("admin",
// "view")` gating, same toXlsx column shape.
describe("step-code blocker routes", () => {
  beforeEach(async () => await truncateAll());
  const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

  it("401s both routes without a session", async () => {
    const blockers = await stepCodeBlockersRoute(new Request("http://t/x"), idCtx("placeholder"));
    expect(blockers.status).toBe(401);

    const exported = await stepCodeBlockersExportRoute(new Request("http://t/x"), idCtx("placeholder"));
    expect(exported.status).toBe(401);
  });

  it("403s both routes for a session lacking admin.view", async () => {
    const cookie = await signInWith([], "nobody");

    const blockers = await stepCodeBlockersRoute(new Request("http://t/x", { headers: { cookie } }), idCtx("placeholder"));
    expect(blockers.status).toBe(403);

    const exported = await stepCodeBlockersExportRoute(
      new Request("http://t/x", { headers: { cookie } }), idCtx("placeholder"),
    );
    expect(exported.status).toBe(403);
  });

  it("200s the blocker list and a matching xlsx export", async () => {
    const { part, codeId } = await stepCodeFixture();
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    await addPartStep(rev.id, codeId);

    const cookie = await signInWith(["admin.view"]);

    const res = await stepCodeBlockersRoute(new Request("http://t/x", { headers: { cookie } }), idCtx(codeId));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { entityLabel: "Part", name: "AC · P-1", id: part.id, href: `/parts/${part.id}` },
    ]);

    const exported = await stepCodeBlockersExportRoute(new Request("http://t/x", { headers: { cookie } }), idCtx(codeId));
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain("spreadsheetml");

    const row = (await readXlsx(exported, 1)).row(2);
    expect(row).toContain("Part");
    expect(row).toContain("AC · P-1");
  });
});
