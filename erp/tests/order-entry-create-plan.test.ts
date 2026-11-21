import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { Prisma } from "../prisma/generated/prisma/client";
import { prisma, seedOrderGatePrereqs, truncateAll } from "./helpers/db";
import { entryFixture } from "./helpers/order-entry";
import { runWithContext } from "@/server/context";
import { previewOrderEntry } from "@/server/order-entry-preview";
import * as entryPreview from "@/server/order-entry-preview";
import { createOrder } from "@/server/orders";
import { readAudit } from "@/server/audit";
import { printExpectationFor } from "@/server/traveler-identity";
import { setSetting } from "@/server/settings";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const inputFor = (customerId: string, partId: string) => ({
  customerId, lines: [{ partId, qty: 30, weight: 3810 }],
});
const NONCE = "3f6a1b2c-1111-4d22-8e33-9f0a1b2c3d4e";

async function assignRecipe(partId: string) {
  const recipe = await prisma.partRecipe.create({
    data: { partId, number: "DEMO-RECIPE-008", numberKey: "DEMO-RECIPE-008" },
  });
  await prisma.partProcessRevision.updateMany({ where: { partId }, data: { recipeId: recipe.id } });
  return recipe;
}

async function persistedSaveBoundary() {
  return Promise.all([
    prisma.setting.findMany({ orderBy: { key: "asc" } }),
    prisma.orderDraft.findMany({ orderBy: { id: "asc" } }),
    prisma.auditLog.findMany({ orderBy: { id: "asc" } }),
    prisma.order.findMany({ orderBy: { id: "asc" } }),
    prisma.load.findMany({ orderBy: [{ orderId: "asc" }, { loadNumber: "asc" }] }),
    prisma.cert.findMany({ orderBy: { id: "asc" } }),
    prisma.part.findMany({ orderBy: { id: "asc" } }),
    prisma.partProcessRevision.findMany({ orderBy: { id: "asc" } }),
    prisma.partProcessStep.findMany({ orderBy: { id: "asc" } }),
    prisma.partProcessStepParameter.findMany({ orderBy: { id: "asc" } }),
    prisma.partRecipe.findMany({ orderBy: { id: "asc" } }),
    prisma.recipeSnapshotField.findMany({ orderBy: [{ revisionId: "asc" }, { fieldDefId: "asc" }] }),
  ]);
}

beforeEach(async () => {
  await truncateAll();
  await seedOrderGatePrereqs();
});
afterEach(() => vi.restoreAllMocks());

describe("reviewed order-only load plans", () => {
  it("saves three reviewed loads with an order-only cap of ten", async () => {
    const { customer, lead, rider } = await entryFixture();
    const beforeParts = await prisma.part.findMany({ orderBy: { id: "asc" } });
    const beforeSteps = await prisma.partProcessStep.findMany({ orderBy: { id: "asc" } });
    const input = {
      customerId: customer.id,
      lines: [{ partId: lead.id, qty: 30, weight: 3810 }],
      loadAdjustment: { source: "order" as const, loadQty: 10, loadWeight: null },
    };
    const preview = await previewOrderEntry(input);

    const { order, printExpectation } = await asSystem(() => createOrder({
      ...input, expectedPreviewFingerprint: preview.fingerprint,
    }));

    expect(order.loads.map(({ loadNumber, qty, weight }) => ({ loadNumber, qty, weight })))
      .toEqual([
        { loadNumber: 1, qty: 10, weight: 1270 },
        { loadNumber: 2, qty: 10, weight: 1270 },
        { loadNumber: 3, qty: 10, weight: 1270 },
      ]);
    expect(await prisma.part.findUniqueOrThrow({ where: { id: lead.id } }))
      .toMatchObject({ loadQty: 15, loadWeight: null });
    expect(await prisma.part.findMany({ orderBy: { id: "asc" } })).toEqual(beforeParts);
    expect(await prisma.partProcessStep.findMany({ orderBy: { id: "asc" } })).toEqual(beforeSteps);
    expect(await prisma.partProcessRevision.count({ where: { partId: rider.id } })).toBe(0);
    expect(printExpectation).toBe(printExpectationFor(order));
    const [audit] = await readAudit("order", order.id);
    expect(audit.after).toMatchObject({
      loadPlan: { source: "order", effective: { loadQty: 10, loadWeight: null } },
      loads: preview.loads,
    });
  });

  it("requires review after a part limit changes and rolls back every save effect", async () => {
    const { customer, lead, code } = await entryFixture();
    const recipe = await assignRecipe(lead.id);
    const actor = await prisma.user.create({
      data: { username: "reviewed-save", displayName: "Reviewed Save", passwordHash: "fixture" },
    });
    await prisma.orderDraft.create({
      data: { userId: actor.id, payload: { customerId: customer.id, note: "keep this draft" } },
    });
    await prisma.processStepFieldDef.create({
      data: { codeId: code.id, label: "Optional note", type: "TEXT", sort: 1 },
    });
    const input = { customerId: customer.id, lines: [{ partId: lead.id, qty: 30, weight: 3810 }] };
    const preview = await previewOrderEntry(input);
    await prisma.part.update({ where: { id: lead.id }, data: { loadQty: 10 } });
    const before = await persistedSaveBoundary();

    await expect(runWithContext({ actor: { id: actor.id, name: actor.displayName }, user: null },
      () => createOrder({ ...input, expectedPreviewFingerprint: preview.fingerprint })))
      .rejects.toMatchObject({ status: 412 });

    expect(await prisma.order.count()).toBe(0);
    expect(await persistedSaveBoundary()).toEqual(before);
    expect(await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: lead.id } }))
      .toMatchObject({ lockedAt: null, recipeSnapshot: null });
    expect(await prisma.partRecipe.findUniqueOrThrow({ where: { id: recipe.id } }))
      .toMatchObject({ usedAt: null });
    expect(await prisma.recipeSnapshotField.count()).toBe(0);
  });

  it("resetting the adjustment uses the part default and preserves captured recipe bytes", async () => {
    const { customer, lead, code } = await entryFixture();
    const recipe = await assignRecipe(lead.id);
    await prisma.processStepFieldDef.create({
      data: { codeId: code.id, label: "Temperature", type: "NUMBER", unit: "F", sort: 1 },
    });
    const base = inputFor(customer.id, lead.id);
    const overridden = { ...base, loadAdjustment: { source: "order" as const, loadQty: 10, loadWeight: null } };
    const firstPreview = await previewOrderEntry(overridden);
    await asSystem(() => createOrder({ ...overridden, expectedPreviewFingerprint: firstPreview.fingerprint }));
    const captured = await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: lead.id } });
    expect(captured.lockedAt).not.toBeNull();
    expect(captured.recipeSnapshot).toMatchObject({ recipeNumber: recipe.number });
    expect((await prisma.partRecipe.findUniqueOrThrow({ where: { id: recipe.id } })).usedAt).not.toBeNull();
    expect(await prisma.recipeSnapshotField.count()).toBe(0); // capture writes no membership rows (spec 2026-09-26 §3.3)
    expect((await previewOrderEntry(overridden)).fingerprint).toBe(firstPreview.fingerprint);
    const recipeBefore = await prisma.partRecipe.findUniqueOrThrow({ where: { id: recipe.id } });
    const capturedBytes = JSON.stringify(captured.recipeSnapshot);

    const reset = { ...base, loadAdjustment: { source: "part" as const } };
    const preview = await previewOrderEntry(reset);
    const { order } = await asSystem(() => createOrder({ ...reset, expectedPreviewFingerprint: preview.fingerprint }));

    expect(order.loads.map(({ qty, weight }) => ({ qty, weight })))
      .toEqual([{ qty: 15, weight: 1905 }, { qty: 15, weight: 1905 }]);
    const after = await prisma.partProcessRevision.findUniqueOrThrow({ where: { id: captured.id } });
    expect(JSON.stringify(after.recipeSnapshot)).toBe(capturedBytes);
    expect(after).toEqual(captured);
    expect(await prisma.partRecipe.findUniqueOrThrow({ where: { id: recipe.id } })).toEqual(recipeBefore);
    const [audit] = await readAudit("order", order.id);
    expect(audit.after).toMatchObject({ loadPlan: { source: "part", effective: { loadQty: 15, loadWeight: null } } });
  });

  it.each(["instruction", "empty parameter row"])("refuses a same-revision %s change", async (change) => {
    const { customer, lead } = await entryFixture();
    await assignRecipe(lead.id);
    const input = inputFor(customer.id, lead.id);
    const preview = await previewOrderEntry(input);
    const step = await prisma.partProcessStep.findFirstOrThrow({ where: { revision: { partId: lead.id } } });
    if (change === "instruction") {
      await prisma.partProcessStep.update({ where: { id: step.id }, data: { instruction: "Preheat to 925F." } });
    } else {
      // A new row is content even while empty (spec 2026-09-26 §3.1); a suggestion added to the
      // code would not be, since rows are the part's own.
      await prisma.partProcessStepParameter.create({
        data: { stepId: step.id, position: 0, key: "k-dwell", label: "Optional dwell", type: "NUMBER", unit: "minutes", value: "" },
      });
    }
    const before = await persistedSaveBoundary();

    await expect(asSystem(() => createOrder({ ...input, expectedPreviewFingerprint: preview.fingerprint })))
      .rejects.toMatchObject({ status: 412, message: expect.stringContaining("Review") });
    expect(await persistedSaveBoundary()).toEqual(before);
  });

  it("refuses a changed part default even when the explicit adjustment gives the same loads", async () => {
    const { customer, lead } = await entryFixture();
    const input = {
      ...inputFor(customer.id, lead.id),
      loadAdjustment: { source: "order" as const, loadQty: 10, loadWeight: null },
    };
    const preview = await previewOrderEntry(input);
    await prisma.part.update({ where: { id: lead.id }, data: { loadQty: 20 } });
    expect((await previewOrderEntry(input)).loads).toEqual(preview.loads);
    await expect(asSystem(() => createOrder({ ...input, expectedPreviewFingerprint: preview.fingerprint })))
      .rejects.toMatchObject({ status: 412 });
    expect(await prisma.order.count()).toBe(0);
  });

  it("returns 412 when changed defaults make a reviewed plan exceed MAX_LOADS", async () => {
    const { customer, lead } = await entryFixture();
    await assignRecipe(lead.id);
    const input = { customerId: customer.id, lines: [{ partId: lead.id, qty: 10_001, weight: 10_001 }] };
    const preview = await previewOrderEntry(input);
    expect(preview.loads).toHaveLength(667);
    await prisma.part.update({ where: { id: lead.id }, data: { loadQty: 1 } });
    const before = await persistedSaveBoundary();

    await expect(asSystem(() => createOrder({ ...input, expectedPreviewFingerprint: preview.fingerprint })))
      .rejects.toMatchObject({ status: 412, message: expect.stringContaining("Review") });
    expect(await persistedSaveBoundary()).toEqual(before);
    // Initial preview validation retains its specific invalid-plan error.
    await expect(previewOrderEntry(input)).rejects.toMatchObject({ status: 400 });
  });

  it("replays a lost successful response before stale preview and setup checks using current saved detail", async () => {
    const { customer, lead } = await entryFixture();
    const base = inputFor(customer.id, lead.id);
    const preview = await previewOrderEntry(base);
    const request = { ...base, clientRequestId: NONCE, expectedPreviewFingerprint: preview.fingerprint };
    // Model the transport losing its successful response after the service has committed.
    const lost = new Error("Connection closed after commit");
    await expect((async () => { await asSystem(() => createOrder(request)); throw lost; })()).rejects.toBe(lost);
    const persisted = await prisma.order.findUniqueOrThrow({ where: { clientRequestId: NONCE } });
    await prisma.part.update({ where: { id: lead.id }, data: { loadQty: 10 } });
    await prisma.load.updateMany({ where: { orderId: persisted.id, loadNumber: 1 }, data: { weight: "1904.99" } });
    await asSystem(() => setSetting("company_name", ""));
    const before = await persistedSaveBoundary();

    const replay = await asSystem(() => createOrder(request));

    expect(replay).toMatchObject({ deduped: true, warnings: [], order: { id: persisted.id } });
    expect(replay.order.loads[0].weight).toBe(1904.99);
    expect(replay.printExpectation).toBe(printExpectationFor(replay.order));
    expect(await prisma.order.count()).toBe(1);
    expect(await persistedSaveBoundary()).toEqual(before);
  });

  it("two concurrent reviewed submissions with the same nonce return one order and one replay", async () => {
    const { customer, lead } = await entryFixture();
    await assignRecipe(lead.id);
    const base = inputFor(customer.id, lead.id);
    const preview = await previewOrderEntry(base);
    const request = { ...base, clientRequestId: NONCE, expectedPreviewFingerprint: preview.fingerprint };
    const results = await Promise.all([
      asSystem(() => createOrder(request)), asSystem(() => createOrder(request)),
    ]);

    expect(new Set(results.map((result) => result.order.id)).size).toBe(1);
    expect(results.filter((result) => result.deduped)).toHaveLength(1);
    expect(results.map((result) => result.printExpectation))
      .toEqual([printExpectationFor(results[0].order), printExpectationFor(results[0].order)]);
    expect(await prisma.order.count()).toBe(1);
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: "order_number_next" } })).value).toBe(1001);
  });

  it("retries serialization after capture with a fresh transaction and consumes one number", async () => {
    const { customer, lead } = await entryFixture();
    await assignRecipe(lead.id);
    const base = inputFor(customer.id, lead.id);
    const preview = await previewOrderEntry(base);
    const resolve = entryPreview.resolveEntryPlan;
    const attempts: Prisma.TransactionClient[] = [];
    vi.spyOn(entryPreview, "resolveEntryPlan").mockImplementation(async (tx, input, options) => {
      attempts.push(tx);
      const plan = await resolve(tx, input, options);
      if (attempts.length === 1) {
        const captured = await tx.partProcessRevision.findFirstOrThrow({ where: { partId: lead.id } });
        expect(captured.recipeSnapshot).not.toBeNull();
        throw new Prisma.PrismaClientKnownRequestError("Simulated serialization abort after capture", {
          code: "P2034", clientVersion: "test",
        });
      }
      return plan;
    });

    const result = await asSystem(() => createOrder({
      ...base, clientRequestId: NONCE, expectedPreviewFingerprint: preview.fingerprint,
    }));

    expect(attempts).toHaveLength(2);
    // Identity as a boolean: when toBe's objects differ, vitest still deep-compares them, and an extended
    // Prisma client's transaction proxy (the public source's) throws in that comparison.
    expect(attempts[0] === attempts[1]).toBe(false);
    expect(result.order.orderNumber).toBe(1000);
    expect(result.printExpectation).toBe(printExpectationFor(result.order));
    expect(await prisma.order.count()).toBe(1);
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: "order_number_next" } })).value).toBe(1001);
    expect(await readAudit("order", result.order.id)).toHaveLength(1);
    const revision = await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: lead.id } });
    expect(await readAudit("partProcessRevision", revision.id)).toHaveLength(1);
  });

  it("replays a nonce committed before a serialization retry even when its preview is now stale", async () => {
    const { customer, lead } = await entryFixture();
    const base = inputFor(customer.id, lead.id);
    const preview = await previewOrderEntry(base);
    const request = { ...base, clientRequestId: NONCE, expectedPreviewFingerprint: preview.fingerprint };
    let winningId: string | undefined;
    // Before the loser's first snapshot completes, the other tab commits this nonce and a
    // subsequent part edit invalidates the reviewed plan. Its allocation abort must retry to
    // the existing order, not reach the newly added freshness check first.
    vi.spyOn(prisma, "$transaction").mockImplementationOnce(async () => {
      const winner = await asSystem(() => createOrder(request));
      winningId = winner.order.id;
      await prisma.part.update({ where: { id: lead.id }, data: { loadQty: 10 } });
      throw new Prisma.PrismaClientKnownRequestError("Simulated concurrent allocation abort", {
        code: "P2034", clientVersion: "test",
      });
    });

    const replay = await asSystem(() => createOrder(request));

    expect(replay).toMatchObject({ deduped: true, warnings: [], order: { id: winningId } });
    expect(replay.printExpectation).toBe(printExpectationFor(replay.order));
    expect(await prisma.order.count()).toBe(1);
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: "order_number_next" } })).value).toBe(1001);
  });

  it.each([
    { loadAdjustment: { source: "order", loadQty: 0, loadWeight: null } },
    { loadAdjustment: { source: "order", loadQty: 1, loadWeight: "1.001" } },
    { loadAdjustment: { source: "part", loadQty: 10 } },
    { expectedPreviewFingerprint: "A".repeat(64) },
    { expectedPreviewFingerprint: "a".repeat(63) },
  ])("rejects malformed optional fields without saving: %j", async (extra) => {
    const { customer, lead } = await entryFixture();
    await expect(asSystem(() => createOrder({ ...inputFor(customer.id, lead.id), ...extra })))
      .rejects.toBeInstanceOf(ZodError);
    expect(await prisma.order.count()).toBe(0);
  });

  it("keeps exact cents when an order-only weight cap is passed as a decimal string", async () => {
    const { customer, lead } = await entryFixture();
    const input = {
      customerId: customer.id,
      lines: [{ partId: lead.id, qty: 5, weight: "0.03" }],
      loadAdjustment: { source: "order" as const, loadQty: 1, loadWeight: "0.01" },
    };
    const preview = await previewOrderEntry(input);
    const { order } = await asSystem(() => createOrder({ ...input, expectedPreviewFingerprint: preview.fingerprint }));
    expect(order.loads.map(({ loadNumber, qty, weight }) => ({ loadNumber, qty, weight }))).toEqual(preview.loads);
    expect(order.loads.map(({ weight }) => weight)).toEqual([0.01, 0, 0.01, 0, 0.01]);
    const [audit] = await readAudit("order", order.id);
    expect(audit.after).toMatchObject({ loadPlan: { source: "order", effective: { loadQty: 1, loadWeight: 0.01 } } });
  });

  it.each([
    { label: "weight only", loadQty: null, loadWeight: 1270, quantities: [10, 10, 10] },
    { label: "both limits", loadQty: 6, loadWeight: 1270, quantities: [6, 6, 6, 6, 6] },
    { label: "explicitly uncapped", loadQty: null, loadWeight: null, quantities: [30] },
  ])("accepts a $label adjustment without requiring a preview field", async ({ loadQty, loadWeight, quantities }) => {
    const { customer, lead } = await entryFixture();
    const { order } = await asSystem(() => createOrder({
      ...inputFor(customer.id, lead.id),
      loadAdjustment: { source: "order", loadQty, loadWeight },
    }));
    expect(order.loads.map((load) => load.qty)).toEqual(quantities);
    expect(order.loads.map((load) => load.weight)).toEqual(quantities.map((qty) => qty * 127));
    expect((await prisma.part.findUniqueOrThrow({ where: { id: lead.id } })).loadQty).toBe(15);
  });
});
