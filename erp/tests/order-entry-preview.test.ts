import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { Prisma } from "../prisma/generated/prisma/client";
import { prisma, seedOrderGatePrereqs, truncateAll } from "./helpers/db";
import { entryFixture } from "./helpers/order-entry";
import { runWithContext } from "@/server/context";
import { previewOrderEntry } from "@/server/order-entry-preview";
import { createOrder } from "@/server/orders";
import { saveRecipeNumber } from "@/server/part-process-steps";

async function persistedPreviewBoundary() {
  return Promise.all([
    prisma.setting.findMany({ orderBy: { key: "asc" } }),
    prisma.orderDraft.findMany({ orderBy: { id: "asc" } }),
    prisma.auditLog.findMany({ orderBy: { id: "asc" } }),
    prisma.cert.findMany({ orderBy: { id: "asc" } }),
    prisma.order.findMany({ orderBy: { id: "asc" } }),
    prisma.load.findMany({ orderBy: [{ orderId: "asc" }, { loadNumber: "asc" }] }),
    prisma.part.findMany({ orderBy: { id: "asc" } }),
    prisma.partProcessRevision.findMany({ orderBy: { id: "asc" } }),
    prisma.partProcessStep.findMany({ orderBy: { id: "asc" } }),
    prisma.partProcessStepParameter.findMany({ orderBy: { id: "asc" } }),
    prisma.partRecipe.findMany({ orderBy: { id: "asc" } }),
    prisma.recipeSnapshotField.findMany({ orderBy: [{ revisionId: "asc" }, { fieldDefId: "asc" }] }),
  ]);
}

const inputFor = (customerId: string, partId: string) => ({
  customerId,
  lines: [{ partId, qty: 30, weight: 3810 }],
});

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

type InvalidInput = [string, (customerId: string, partId: string) => unknown];
const invalidInputs: InvalidInput[] = [
  ["zero quantity", (customerId, partId) => ({ customerId, lines: [{ partId, qty: 0, weight: 1 }] })],
  ["negative quantity", (customerId, partId) => ({ customerId, lines: [{ partId, qty: -1, weight: 1 }] })],
  ["NaN quantity", (customerId, partId) => ({ customerId, lines: [{ partId, qty: Number.NaN, weight: 1 }] })],
  ["fractional quantity", (customerId, partId) => ({ customerId, lines: [{ partId, qty: 1.5, weight: 1 }] })],
  ["quantity above the shared line bound", (customerId, partId) => ({ customerId, lines: [{ partId, qty: 10_000_001, weight: 1 }] })],
  ["zero weight", (customerId, partId) => ({ customerId, lines: [{ partId, qty: 1, weight: 0 }] })],
  ["negative weight", (customerId, partId) => ({ customerId, lines: [{ partId, qty: 1, weight: -1 }] })],
  ["NaN weight", (customerId, partId) => ({ customerId, lines: [{ partId, qty: 1, weight: Number.NaN }] })],
  ["junk weight", (customerId, partId) => ({ customerId, lines: [{ partId, qty: 1, weight: "junk" }] })],
  ["over-precise weight", (customerId, partId) => ({ customerId, lines: [{ partId, qty: 1, weight: "1.001" }] })],
  ["zero quantity cap", (customerId, partId) => ({ customerId, lines: [{ partId, qty: 1, weight: 1 }], loadAdjustment: { source: "order", loadQty: 0, loadWeight: null } })],
  ["negative quantity cap", (customerId, partId) => ({ customerId, lines: [{ partId, qty: 1, weight: 1 }], loadAdjustment: { source: "order", loadQty: -1, loadWeight: null } })],
  ["fractional quantity cap", (customerId, partId) => ({ customerId, lines: [{ partId, qty: 1, weight: 1 }], loadAdjustment: { source: "order", loadQty: 1.5, loadWeight: null } })],
  ["zero weight cap", (customerId, partId) => ({ customerId, lines: [{ partId, qty: 1, weight: 1 }], loadAdjustment: { source: "order", loadQty: null, loadWeight: 0 } })],
  ["negative weight cap", (customerId, partId) => ({ customerId, lines: [{ partId, qty: 1, weight: 1 }], loadAdjustment: { source: "order", loadQty: null, loadWeight: -1 } })],
  ["NaN weight cap", (customerId, partId) => ({ customerId, lines: [{ partId, qty: 1, weight: 1 }], loadAdjustment: { source: "order", loadQty: null, loadWeight: Number.NaN } })],
  ["junk weight cap", (customerId, partId) => ({ customerId, lines: [{ partId, qty: 1, weight: 1 }], loadAdjustment: { source: "order", loadQty: null, loadWeight: "junk" } })],
];

beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateAll();
  await seedOrderGatePrereqs();
});

describe("previewOrderEntry", () => {
  it("previews two loads without writing", async () => {
    const { customer, lead } = await entryFixture();
    const user = await prisma.user.create({
      data: { username: "preview-draft", displayName: "Preview Draft", passwordHash: "fixture" },
    });
    await prisma.orderDraft.create({
      data: { userId: user.id, payload: { customerId: customer.id, note: "keep me" } },
    });
    const sentinel = await prisma.order.create({
      data: {
        orderNumber: 8008,
        customerId: customer.id,
        receivedDate: new Date("2026-09-21T00:00:00.000Z"),
        requestDate: new Date("2026-09-22T00:00:00.000Z"),
      },
    });
    await prisma.cert.create({ data: { orderId: sentinel.id, scope: "ORDER" } });
    const beforeCount = await prisma.order.count();
    const before = await persistedPreviewBoundary();

    const preview = await previewOrderEntry({
      customerId: customer.id,
      lines: [{ partId: lead.id, qty: 30, weight: 3810 }],
    });

    expect(preview.loads).toEqual([
      { loadNumber: 1, qty: 15, weight: 1905 },
      { loadNumber: 2, qty: 15, weight: 1905 },
    ]);
    expect(preview.totalWeightCents).toBe("381000");
    expect(await prisma.order.count()).toBe(beforeCount);
    expect(await persistedPreviewBoundary()).toEqual(before);
    expect(await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: lead.id } }))
      .toMatchObject({ revisionNumber: 1, lockedAt: null, recipeSnapshot: null });
  });

  it("includes rider totals and puts a 31st piece in its own remainder load", async () => {
    const { customer, lead, rider } = await entryFixture();

    const preview = await previewOrderEntry({
      customerId: customer.id,
      lines: [
        { partId: lead.id, qty: 30, weight: "3810.00" },
        { partId: rider.id, qty: 1, weight: "127.00" },
      ],
    });

    expect(preview.totalQty).toBe(31);
    expect(preview.totalWeightCents).toBe("393700");
    expect(preview.loads).toEqual([
      { loadNumber: 1, qty: 15, weight: 1905 },
      { loadNumber: 2, qty: 15, weight: 1905 },
      { loadNumber: 3, qty: 1, weight: 127 },
    ]);
  });

  it("uses explicit weight-only, both-cap and uncapped order adjustments", async () => {
    const { customer, lead, rider } = await entryFixture();
    const lines = [
      { partId: lead.id, qty: 30, weight: 3810 },
      { partId: rider.id, qty: 1, weight: 127 },
    ];

    const weightOnly = await previewOrderEntry({
      customerId: customer.id,
      lines,
      loadAdjustment: { source: "order", loadQty: null, loadWeight: 2000 },
    });
    expect(weightOnly).toMatchObject({
      source: "order",
      defaults: { loadQty: 15, loadWeight: null },
      effective: { loadQty: null, loadWeight: 2000 },
      loads: [
        { loadNumber: 1, qty: 15, weight: 1905 },
        { loadNumber: 2, qty: 15, weight: 1905 },
        { loadNumber: 3, qty: 1, weight: 127 },
      ],
    });

    const both = await previewOrderEntry({
      customerId: customer.id,
      lines,
      loadAdjustment: { source: "order", loadQty: 20, loadWeight: "1270.00" },
    });
    expect(both.effective).toEqual({ loadQty: 20, loadWeight: 1270 });
    expect(both.loads).toEqual([
      { loadNumber: 1, qty: 10, weight: 1270 },
      { loadNumber: 2, qty: 10, weight: 1270 },
      { loadNumber: 3, qty: 10, weight: 1270 },
      { loadNumber: 4, qty: 1, weight: 127 },
    ]);

    const uncapped = await previewOrderEntry({
      customerId: customer.id,
      lines,
      loadAdjustment: { source: "order", loadQty: null, loadWeight: null },
    });
    expect(uncapped.effective).toEqual({ loadQty: null, loadWeight: null });
    expect(uncapped.loads).toEqual([{ loadNumber: 1, qty: 31, weight: 3937 }]);
  });

  it.each(invalidInputs)("rejects %s through the shared input bounds", async (_label, build) => {
    const { customer, lead } = await entryFixture();
    await expect(previewOrderEntry(build(customer.id, lead.id))).rejects.toBeInstanceOf(ZodError);
  });

  it("maps the MAX_LOADS refusal to a clean 400 without writing", async () => {
    const { customer, lead } = await entryFixture();
    const before = await persistedPreviewBoundary();

    await expect(previewOrderEntry({
      customerId: customer.id,
      lines: [{ partId: lead.id, qty: 10_001, weight: "10001.00" }],
      loadAdjustment: { source: "order", loadQty: 1, loadWeight: null },
    })).rejects.toMatchObject({
      status: 400,
      message: "This split would produce 10001 loads (max 10,000) — check the part's load quantity",
    });
    expect(await persistedPreviewBoundary()).toEqual(before);
  });

  it("rejects aggregate load quantity and weight overflows at the destination column bounds", async () => {
    const { customer, lead } = await entryFixture();
    const uncapped = { source: "order" as const, loadQty: null, loadWeight: null };
    const qtyLines = Array.from({ length: 215 }, () => ({
      partId: lead.id,
      qty: 10_000_000,
      weight: "1.00",
    }));

    await expect(previewOrderEntry({
      customerId: customer.id,
      lines: qtyLines,
      loadAdjustment: uncapped,
    })).rejects.toMatchObject({
      status: 400,
      message: "Load 1's quantity 2,150,000,000 exceeds the database maximum 2,147,483,647 — check the line quantities",
    });
    await expect(previewOrderEntry({
      customerId: customer.id,
      lines: [
        { partId: lead.id, qty: 1, weight: "9999999999.99" },
        { partId: lead.id, qty: 1, weight: "9999999999.99" },
      ],
      loadAdjustment: uncapped,
    })).rejects.toMatchObject({
      status: 400,
      message: "Load 1's weight 19,999,999,999.98 exceeds the database maximum 9,999,999,999.99 — check the line weights",
    });
  });

  it("preserves exact-cent cumulative rounding in the preview projection", async () => {
    const { customer, lead } = await entryFixture();
    const preview = await previewOrderEntry({
      customerId: customer.id,
      lines: [{ partId: lead.id, qty: 5, weight: "0.03" }],
      loadAdjustment: { source: "order", loadQty: 1, loadWeight: null },
    });

    expect(preview.totalWeightCents).toBe("3");
    expect(preview.loads).toEqual([
      { loadNumber: 1, qty: 1, weight: 0.01 },
      { loadNumber: 2, qty: 1, weight: 0 },
      { loadNumber: 3, qty: 1, weight: 0.01 },
      { loadNumber: 4, qty: 1, weight: 0 },
      { loadNumber: 5, qty: 1, weight: 0.01 },
    ]);
  });

  it("fingerprints ordered line semantics, normalized decimals, and both default and effective caps", async () => {
    const { customer, lead, rider } = await entryFixture();
    const adjustment = { source: "order" as const, loadQty: 15, loadWeight: null };
    const first = await previewOrderEntry({
      customerId: customer.id,
      lines: [
        { partId: lead.id, qty: 10, weight: 1270 },
        { partId: rider.id, qty: 20, weight: 2540 },
      ],
      loadAdjustment: adjustment,
    });
    const normalized = await previewOrderEntry({
      customerId: customer.id,
      lines: [
        { partId: lead.id, qty: 10, weight: "1270.00" },
        { partId: rider.id, qty: 20, weight: "2540" },
      ],
      loadAdjustment: adjustment,
    });
    const redistributed = await previewOrderEntry({
      customerId: customer.id,
      lines: [
        { partId: lead.id, qty: 20, weight: 2540 },
        { partId: rider.id, qty: 10, weight: 1270 },
      ],
      loadAdjustment: adjustment,
    });
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(normalized.fingerprint).toBe(first.fingerprint);
    expect(redistributed.loads).toEqual(first.loads);
    expect(redistributed.fingerprint).not.toBe(first.fingerprint);

    await prisma.part.update({ where: { id: lead.id }, data: { loadQty: 14 } });
    const changedDefault = await previewOrderEntry({
      customerId: customer.id,
      lines: [
        { partId: lead.id, qty: 10, weight: 1270 },
        { partId: rider.id, qty: 20, weight: 2540 },
      ],
      loadAdjustment: adjustment,
    });
    expect(changedDefault.effective).toEqual(first.effective);
    expect(changedDefault.loads).toEqual(first.loads);
    expect(changedDefault.fingerprint).not.toBe(first.fingerprint);
  });

  it("projects each step's own rows, empty as null, and fingerprints same-revision row edits but never a suggestion edit", async () => {
    const { customer, lead, code } = await entryFixture();
    const revision = await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: lead.id } });
    const steps = await prisma.partProcessStep.findMany({
      where: { revisionId: revision.id },
      orderBy: { position: "asc" },
    });
    const recipe = await prisma.partRecipe.create({
      data: { partId: lead.id, number: "R-008", numberKey: "R-008" },
    });
    await prisma.partProcessRevision.update({ where: { id: revision.id }, data: { recipeId: recipe.id } });
    // Rows are the part's own (spec 2026-09-26 §3.1): step 1 carries an EMPTY temperature, step 2
    // a filled one, step 3 a checked box; a suggestion the steps never copied is not projected.
    await prisma.processStepFieldDef.create({
      data: { codeId: code.id, label: "Never copied", type: "TEXT", unit: null, sort: 1 },
    });
    await prisma.partProcessStepParameter.createMany({
      data: [
        { stepId: steps[0].id, position: 0, key: "k-temp", label: "Temperature", type: "NUMBER", unit: "F", value: "" },
        { stepId: steps[1].id, position: 0, key: "k-temp", label: "Temperature", type: "NUMBER", unit: "F", value: "1650.000000" },
        { stepId: steps[2].id, position: 0, key: "k-approved", label: "Approved", type: "CHECKBOX", unit: null, value: "true" },
      ],
    });
    const input = inputFor(customer.id, lead.id);

    const shown = await previewOrderEntry(input, { includeProcess: true });
    const hidden = await previewOrderEntry(input);
    expect(hidden.fingerprint).toBe(shown.fingerprint);
    expect(hidden).not.toHaveProperty("process");
    expect(shown.process).toEqual({
      recipeNumber: "R-008",
      steps: [
        {
          position: 1,
          code: "HT-008",
          codeName: "Demo heat treatment",
          instruction: "Preheat to 900F.",
          fields: [{ label: "Temperature", type: "NUMBER", unit: "F", value: null }],
        },
        {
          position: 2,
          code: "HT-008",
          codeName: "Demo heat treatment",
          instruction: "Austenitize at 1650F.",
          fields: [{ label: "Temperature", type: "NUMBER", unit: "F", value: "1650.000000" }],
        },
        {
          position: 3,
          code: "HT-008",
          codeName: "Demo heat treatment",
          instruction: "Quench in oil.",
          fields: [{ label: "Approved", type: "CHECKBOX", unit: null, value: true }],
        },
      ],
    });

    await prisma.partProcessStep.update({
      where: { id: steps[1].id },
      data: { instruction: "Austenitize at 1675F." },
    });
    const instructionEdit = await previewOrderEntry(input, { includeProcess: true });
    expect(instructionEdit.revisionNumber).toBe(1);
    expect(instructionEdit.fingerprint).not.toBe(shown.fingerprint);

    // A suggestion edit changes neither the projection nor the fingerprint (spec §3.2).
    await prisma.processStepFieldDef.create({
      data: { codeId: code.id, label: "Optional note", type: "TEXT", unit: "minutes", sort: 2 },
    });
    const suggestionEdit = await previewOrderEntry(input, { includeProcess: true });
    expect(suggestionEdit.fingerprint).toBe(instructionEdit.fingerprint);
    expect(suggestionEdit.process).toEqual(instructionEdit.process);

    // A row's unit is content; its key is identity: an identical row under a new key fingerprints
    // differently while projecting the same public content.
    const row = await prisma.partProcessStepParameter.findFirstOrThrow({ where: { stepId: steps[1].id } });
    await prisma.partProcessStepParameter.update({ where: { id: row.id }, data: { unit: "C" } });
    const unitEdit = await previewOrderEntry(input, { includeProcess: true });
    expect(unitEdit.fingerprint).not.toBe(instructionEdit.fingerprint);
    expect(unitEdit.process?.steps[1].fields).toEqual([{ label: "Temperature", type: "NUMBER", unit: "C", value: "1650.000000" }]);

    await prisma.partProcessStepParameter.update({ where: { id: row.id }, data: { key: "k-temp-again" } });
    const identityEdit = await previewOrderEntry(input, { includeProcess: true });
    expect(identityEdit.process).toEqual(unitEdit.process);
    expect(identityEdit.fingerprint).not.toBe(unitEdit.fingerprint);
  });

  it("uses captured semantics for a locked revision after its live catalog changes", async () => {
    const { customer, lead, code } = await entryFixture();
    const revision = await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: lead.id } });
    const steps = await prisma.partProcessStep.findMany({
      where: { revisionId: revision.id },
      orderBy: { position: "asc" },
    });
    const recipe = await prisma.partRecipe.create({
      data: { partId: lead.id, number: "CAP-008", numberKey: "CAP-008", usedAt: new Date("2026-09-21T00:00:00.000Z") },
    });
    const field = await prisma.processStepFieldDef.create({
      data: { codeId: code.id, label: "Captured temperature", type: "NUMBER", unit: "F", sort: 1 },
    });
    const snapshot = {
      schemaVersion: 1 as const,
      recipeId: recipe.id,
      recipeNumber: "CAP-008",
      partId: lead.id,
      revisionNumber: 1,
      steps: steps.map((step) => ({
        stepId: step.id,
        position: step.position,
        codeId: code.id,
        code: "HT-008",
        codeName: "Captured heat treatment",
        instruction: `Captured instruction ${step.position}`,
        fields: [{
          fieldDefId: field.id,
          label: "Captured temperature",
          type: "NUMBER" as const,
          unit: "F",
          position: 1,
          value: null,
        }],
      })),
    };
    await prisma.partProcessRevision.update({
      where: { id: revision.id },
      data: {
        recipeId: recipe.id,
        lockedAt: new Date("2026-09-21T00:00:00.000Z"),
        recipeSnapshot: snapshot,
      },
    });
    await prisma.recipeSnapshotField.create({ data: { revisionId: revision.id, fieldDefId: field.id } });

    const first = await previewOrderEntry(inputFor(customer.id, lead.id), { includeProcess: true });
    await prisma.processStepCode.update({ where: { id: code.id }, data: { name: "Changed live name" } });
    await prisma.processStepFieldDef.update({
      where: { id: field.id },
      data: { label: "Changed live label", unit: "C" },
    });
    await prisma.partProcessStep.update({
      where: { id: steps[0].id },
      data: { instruction: "Changed live instruction" },
    });
    await prisma.partRecipe.update({
      where: { id: recipe.id },
      data: { number: "LIVE-CHANGED", numberKey: "LIVE-CHANGED" },
    });
    const second = await previewOrderEntry(inputFor(customer.id, lead.id), { includeProcess: true });

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.process).toEqual(first.process);
    expect(second.process?.recipeNumber).toBe("CAP-008");
    expect(second.process?.steps[0]).toMatchObject({
      codeName: "Captured heat treatment",
      instruction: "Captured instruction 1",
      fields: [{ label: "Captured temperature", unit: "F", value: null }],
    });
  });

  it("keeps the same fingerprint when the first legacy order captures a numbered live revision", async () => {
    const { customer, lead, code } = await entryFixture();
    await prisma.processStepFieldDef.create({
      data: { codeId: code.id, label: "Unset captured field", type: "TEXT", unit: null, sort: 1 },
    });
    await asSystem(() => saveRecipeNumber(lead.id, {
      recipeNumber: "FIRST-008",
      expectedRecipeNumber: null,
    }));
    const input = inputFor(customer.id, lead.id);
    const before = await previewOrderEntry(input, { includeProcess: true });

    await asSystem(() => createOrder({
      customerId: customer.id,
      lines: [{ partId: lead.id, qty: 30, weight: "3810.00" }],
    }));

    const captured = await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: lead.id } });
    const identity = await prisma.partRecipe.findUniqueOrThrow({ where: { partId: lead.id } });
    expect(captured.lockedAt).not.toBeNull();
    expect(captured.recipeSnapshot).not.toBeNull();
    expect(identity.usedAt).not.toBeNull();
    const after = await previewOrderEntry(input, { includeProcess: true });
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.process).toEqual(before.process);
  });

  it("keeps the same fingerprint across the first capture when a step carries an empty and a CHECKBOX parameter", async () => {
    // The live branch and the captured branch project rows through one function and one key
    // order; order creation captures and THEN compares (order-create.ts), so a drift here would
    // 412 the first order of every numbered part with a parameter. The fixture's steps carry no
    // rows, so this case supplies them: an empty value (null once captured) and a checkbox.
    const { customer, lead } = await entryFixture();
    const step = await prisma.partProcessStep.findFirstOrThrow({ where: { revision: { partId: lead.id }, position: 1 } });
    await prisma.partProcessStepParameter.createMany({ data: [
      { stepId: step.id, position: 0, key: "k-note", label: "Note", type: "TEXT", unit: null, value: "" },
      { stepId: step.id, position: 1, key: "k-approved", label: "Approved", type: "CHECKBOX", unit: null, value: "true" },
    ] });
    await asSystem(() => saveRecipeNumber(lead.id, { recipeNumber: "ROWS-008", expectedRecipeNumber: null }));
    const input = inputFor(customer.id, lead.id);
    const before = await previewOrderEntry(input, { includeProcess: true });
    expect(before.process?.steps[0].fields).toEqual([
      { label: "Note", type: "TEXT", unit: null, value: null },
      { label: "Approved", type: "CHECKBOX", unit: null, value: true },
    ]);

    await asSystem(() => createOrder({
      customerId: customer.id,
      lines: [{ partId: lead.id, qty: 30, weight: "3810.00" }],
      expectedPreviewFingerprint: before.fingerprint,
    }));

    const captured = await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: lead.id } });
    expect((captured.recipeSnapshot as { steps: { fields: unknown[] }[] }).steps[0].fields).toEqual([
      { fieldDefId: "k-note", label: "Note", type: "TEXT", unit: null, position: 0, value: null },
      { fieldDefId: "k-approved", label: "Approved", type: "CHECKBOX", unit: null, position: 1, value: true },
    ]);
    const after = await previewOrderEntry(input, { includeProcess: true });
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.process).toEqual(before.process);
  });

  it("uses one PostgreSQL repeatable-read, read-only transaction for the complete projection", async () => {
    const { customer, lead } = await entryFixture();
    type Run = <R>(
      fn: (tx: Prisma.TransactionClient) => Promise<R>,
      options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
    ) => Promise<R>;
    const original = prisma.$transaction.bind(prisma) as Run;
    let observed: { isolation: string; readOnly: string }[] | undefined;
    const intercept: Run = (fn, options) => original(async (tx) => {
      const result = await fn(tx);
      observed = await tx.$queryRaw<{ isolation: string; readOnly: string }[]>`
        SELECT current_setting('transaction_isolation') AS isolation,
               current_setting('transaction_read_only') AS "readOnly"`;
      return result;
    }, options);
    vi.spyOn(prisma, "$transaction").mockImplementationOnce(intercept as typeof prisma.$transaction);

    await previewOrderEntry(inputFor(customer.id, lead.id), { includeProcess: true });

    expect(observed).toEqual([{ isolation: "repeatable read", readOnly: "on" }]);
  });
});
