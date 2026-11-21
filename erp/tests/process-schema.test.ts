import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";

describe("process steps schema", () => {
  beforeEach(truncateAll);

  it("stores a revision -> step -> parameter-row graph whose rows reference no suggestion (spec 2026-09-26 §3.1)", async () => {
    const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "P-1", eachWeight: 1 },
    });
    const code = await prisma.processStepCode.create({ data: { code: "HT-01", name: "Austenitize" } });
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    const step = await prisma.partProcessStep.create({
      data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "per spec" },
    });
    const row = { stepId: step.id, position: 0, key: "any-key", label: "Temperature", type: "NUMBER" as const, unit: "F", value: "1650" };
    await prisma.partProcessStepParameter.create({ data: row });
    // One position and one key per step; a row on another step may reuse both.
    await expect(prisma.partProcessStepParameter.create({ data: { ...row, key: "other" } })).rejects.toThrow();
    await expect(prisma.partProcessStepParameter.create({ data: { ...row, position: 1 } })).rejects.toThrow();
    const other = await prisma.partProcessStep.create({
      data: { revisionId: rev.id, position: 2, codeId: code.id, instruction: "" },
    });
    await prisma.partProcessStepParameter.create({ data: { ...row, stepId: other.id } });

    const back = await prisma.partProcessRevision.findFirst({
      where: { partId: part.id }, include: { steps: { orderBy: { position: "asc" }, include: { parameters: true } } },
    });
    expect(back?.steps[0]?.parameters[0]).toMatchObject({ key: "any-key", label: "Temperature", type: "NUMBER", unit: "F", value: "1650" });
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'PartProcessStepValue'`;
    expect(tables).toEqual([]);
  });

  it("has no process template tables (spec 2026-09-26 §3.6)", async () => {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('ProcessTemplate', 'ProcessTemplateStep')`;
    expect(rows).toEqual([]);
  });

  it("enforces recipe identifier format and canonical key at the database boundary", async () => {
    const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
    const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-1", eachWeight: 1 } });
    for (const number of ["", " A", "A ", "A\n", "A_B", "é", "a".repeat(21)]) {
      await expect(prisma.partRecipe.create({ data: { partId: part.id, number, numberKey: number.toUpperCase() } }))
        .rejects.toThrow();
    }
    await expect(prisma.partRecipe.create({ data: { partId: part.id, number: "Ab-01", numberKey: "Ab-01" } }))
      .rejects.toThrow();
    expect(await prisma.partRecipe.count()).toBe(0);
    await prisma.partRecipe.create({ data: { partId: part.id, number: "Ab-01", numberKey: "AB-01" } });
    await expect(prisma.partRecipe.create({ data: { partId: part.id, number: "OTHER", numberKey: "OTHER" } }))
      .rejects.toThrow();
    const other = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-2", eachWeight: 1 } });
    await prisma.part.update({ where: { id: part.id }, data: { deletedAt: new Date() } });
    await expect(prisma.partRecipe.create({ data: { partId: other.id, number: "ab-01", numberKey: "AB-01" } }))
      .rejects.toThrow();
  });

  it("stores nullable legacy revision data and indexed snapshot membership without a live definition FK", async () => {
    const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
    const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-1", eachWeight: 1 } });
    const revision = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    expect(revision.recipeId).toBeNull();
    expect(revision.recipeSnapshot).toBeNull();
    await prisma.recipeSnapshotField.create({ data: { revisionId: revision.id, fieldDefId: "preserved-field-identity" } });
    await expect(prisma.recipeSnapshotField.create({ data: { revisionId: revision.id, fieldDefId: "preserved-field-identity" } }))
      .rejects.toThrow();
    await expect(prisma.recipeSnapshotField.create({ data: { revisionId: "missing-revision", fieldDefId: "other" } }))
      .rejects.toThrow();
    const index = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'RecipeSnapshotField'
      AND indexname = 'RecipeSnapshotField_fieldDefId_idx'`;
    expect(index[0]?.indexdef).toContain('("fieldDefId")');
  });

});
