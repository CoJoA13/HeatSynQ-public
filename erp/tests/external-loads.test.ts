import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "../prisma/generated/prisma/client";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { saveRecipeNumber } from "@/server/part-process-steps";
import { appendProcessStep } from "@/server/process-document";
import { saveProcessEdit, setInstruction } from "./helpers/process-edit";
import { createOrder, voidOrder } from "@/server/orders";
import { replaceLoads, resplitLoads } from "@/server/order-loads";

const asSystem = <T>(fn: () => Promise<T>) => runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

async function fixture(number: string | null = "001207", rider = false) {
  const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme Gear" } });
  const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-100", name: "Ring gear", eachWeight: "10", loadQty: 40 } });
  const code = await prisma.processStepCode.create({ data: { code: "HT", name: "Heat" } });
  const { stepId } = await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "Hold" }));
  if (number !== null) await asSystem(() => saveRecipeNumber(part.id, { recipeNumber: number, expectedRecipeNumber: null }));
  const lines = [{ partId: part.id, qty: 100, weight: "1000.00" }];
  if (rider) {
    const other = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-RIDER", name: "Rider", eachWeight: "1" } });
    await asSystem(() => appendProcessStep(other.id, { codeId: code.id, instruction: "Rider only" }));
    await asSystem(() => saveRecipeNumber(other.id, { recipeNumber: "999", expectedRecipeNumber: null }));
    lines.push({ partId: other.id, qty: 1, weight: "1" });
  }
  const { order } = await asSystem(() => createOrder({ customerId: customer.id, lines }));
  const load = await prisma.load.findFirstOrThrow({ where: { orderId: order.id, loadNumber: 1 } });
  const revision = await prisma.partProcessRevision.findUniqueOrThrow({ where: { partId_revisionNumber: { partId: part.id, revisionNumber: 1 } } });
  return { customer, part, order, load, revision, stepId };
}

/** Capture actual rows from every public table, including sessions and AuditLog. Raw
 * Prisma numeric values remain Decimals and serialize as strings; nulls stay null. */
async function allRows() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
  const state: Record<string, unknown> = {};
  for (const { tablename } of tables) {
    const identifier = `"${tablename.replaceAll('"', '""')}"`;
    state[tablename] = await prisma.$queryRawUnsafe(`SELECT * FROM ${identifier} t ORDER BY row_to_json(t)::text`);
  }
  return JSON.stringify(state, (_key, value) => typeof value === "bigint" ? value.toString() : value);
}

beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("external load reader", () => {
  it("returns the exact lead revision, nullable weight and current names even after soft deletion", async () => {
    const { readExternalLoad } = await import("@/server/external-loads");
    const { customer, part, order, load } = await fixture("001207", true);
    await prisma.load.update({ where: { id: load.id }, data: { weight: null } });
    await prisma.part.update({ where: { id: part.id }, data: { name: "Current name", deletedAt: new Date() } });
    await prisma.customer.update({ where: { id: customer.id }, data: { name: "Current customer" } });
    const result = await readExternalLoad(order.orderNumber, 1);
    expect(result).toMatchObject({ schemaVersion: 1, order: { id: order.id, orderNumber: order.orderNumber },
      customer: { id: customer.id, code: "ACME", name: "Current customer" }, leadPart: { id: part.id, partNumber: "P-100", partName: "Current name" } });
    expect(result.load.id).toBe(load.id);
    expect(result.load.weight).toEqual({ value: null, unit: "lb" });
    expect(result.recipe.status).toBe("available");
    if (result.recipe.status === "available") {
      expect(result.recipe.snapshot.recipeNumber).toBe("001207");
      expect(result.recipe.snapshot.revisionNumber).toBe(1);
    }
  });

  it("does not replace an old order's recipe with N+1", async () => {
    const { readExternalLoad } = await import("@/server/external-loads");
    const { part, order, stepId } = await fixture();
    const before = await readExternalLoad(order.orderNumber, 1);
    await asSystem(() => saveProcessEdit(part.id, setInstruction(stepId, "Changed in N+1")));
    const { order: next } = await asSystem(() => createOrder({ customerId: part.customerId, lines: [{ partId: part.id, qty: 1, weight: "1" }] }));
    expect((await readExternalLoad(next.orderNumber, 1)).recipe).toMatchObject({ status: "available", snapshot: { revisionNumber: 2 } });
    expect(await readExternalLoad(order.orderNumber, 1)).toEqual(before);
  });

  it("preserves legacy null quantity and serializes decimal weight as a string", async () => {
    const { readExternalLoad } = await import("@/server/external-loads");
    const { order, load } = await fixture(null);
    await prisma.load.update({ where: { id: load.id }, data: { qty: null, weight: "1234567890.12" } });
    expect(await readExternalLoad(order.orderNumber, 1)).toMatchObject({ load: { qty: null, weight: { value: "1234567890.12", unit: "lb" } },
      recipe: { status: "no_numbered_recipe", snapshot: null } });
  });

  it.each(["numbered", "missing", "null"])("reports unavailable historical snapshot with %s revision metadata", async (mode) => {
    const { readExternalLoad } = await import("@/server/external-loads");
    const { order, revision } = await fixture();
    if (mode === "numbered") await prisma.partProcessRevision.update({ where: { id: revision.id }, data: { recipeSnapshot: Prisma.DbNull } });
    else await prisma.orderLine.update({ where: { orderId_position: { orderId: order.id, position: 1 } }, data: { revisionNumber: mode === "null" ? null : 999 } });
    expect((await readExternalLoad(order.orderNumber, 1)).recipe).toEqual({ status: "legacy_snapshot_unavailable", snapshot: null });
  });

  it("refuses a malformed non-null stored snapshot", async () => {
    const { readExternalLoad } = await import("@/server/external-loads");
    const { order, revision } = await fixture();
    await prisma.partProcessRevision.update({ where: { id: revision.id }, data: { recipeSnapshot: { schemaVersion: 99 } } });
    await expect(readExternalLoad(order.orderNumber, 1)).rejects.toThrow();
  });

  it("does not return another order or a voided order when exact identities are missing", async () => {
    const { readExternalLoad } = await import("@/server/external-loads");
    const { order } = await fixture();
    await expect(readExternalLoad(order.orderNumber + 1, 1)).rejects.toMatchObject({ status: 404 });
    await expect(readExternalLoad(order.orderNumber, 4)).rejects.toMatchObject({ status: 404 });
    await asSystem(() => voidOrder(order.id, "Test void"));
    await expect(readExternalLoad(order.orderNumber, 1)).rejects.toMatchObject({ status: 404 });
  });

  it("resolves the current load row after renumbering and re-splitting", async () => {
    const { readExternalLoad } = await import("@/server/external-loads");
    const { part, order, load } = await fixture();
    const loads = await prisma.load.findMany({ where: { orderId: order.id }, orderBy: { loadNumber: "asc" } });
    await asSystem(() => replaceLoads(order.id, loads.map((row, i) => ({ loadNumber: i === 0 ? 2 : i === 1 ? 1 : 3, qty: row.qty, weight: row.weight?.toString() ?? null }))));
    expect((await readExternalLoad(order.orderNumber, 1)).load.id).toBe(loads[1].id);
    expect((await readExternalLoad(order.orderNumber, 2)).load.id).toBe(load.id);
    await prisma.part.update({ where: { id: part.id }, data: { loadQty: 100 } });
    await asSystem(() => resplitLoads(order.id));
    const current = await prisma.load.findFirstOrThrow({ where: { orderId: order.id, loadNumber: 1 } });
    expect((await readExternalLoad(order.orderNumber, 1)).load).toMatchObject({ id: current.id, qty: 100 });
    expect(await prisma.load.count({ where: { orderId: order.id } })).toBe(1);
    await expect(readExternalLoad(order.orderNumber, 2)).rejects.toMatchObject({ status: 404 });
    await expect(readExternalLoad(order.orderNumber, 3)).rejects.toMatchObject({ status: 404 });
  });

  it("uses PostgreSQL Repeatable Read and read-only mode for the complete projection", async () => {
    const { readExternalLoad } = await import("@/server/external-loads");
    const { order } = await fixture();
    type Run = <R>(fn: (tx: Prisma.TransactionClient) => Promise<R>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel }) => Promise<R>;
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
    await readExternalLoad(order.orderNumber, 1);
    expect(observed).toEqual([{ isolation: "repeatable read", readOnly: "on" }]);
  });

  it("leaves every persisted table unchanged across successful and rejected route reads", async () => {
    const { order } = await fixture();
    const sessionToken = "external-read-session-fixture";
    const user = await prisma.user.create({ data: { username: "external-reader", displayName: "External reader fixture", passwordHash: "unused-fixture-hash" } });
    await prisma.session.create({ data: { userId: user.id, tokenHash: createHash("sha256").update(sessionToken).digest("hex"), expiresAt: new Date(Date.now() + 60_000) } });
    const { GET } = await import("@/app/api/external/orders/[orderNumber]/loads/[loadNumber]/route");
    vi.stubEnv("LOADSYNQ_API_TOKEN", "1".repeat(64));
    const before = await allRows();
    for (const [auth, loadNumber, expected] of [["1".repeat(64), "1", 200], ["wrong", "1", 401], ["1".repeat(64), "99", 404], ["1".repeat(64), "0", 400]] as const) {
      const result = await GET(new Request("http://localhost/api/external/orders/1/loads/1", { headers: { authorization: `Bearer ${auth}`, cookie: `erp_session=${sessionToken}` } }),
        { params: Promise.resolve({ orderNumber: String(order.orderNumber), loadNumber }) });
      expect(result.status).toBe(expected);
    }
    expect(await allRows()).toBe(before);
  });
});
