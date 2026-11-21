// Global search's order read runs with JIT off (#888; owner ruling 2026-11-04: per search
// transaction, never for the database or Compose). `SET LOCAL` lasts to the end of its
// transaction, so it does nothing unless the read shares one with it: outside a transaction
// Postgres answers it with a warning and no effect, and a plain `SET` would stay on the pooled
// connection for every query after it.
//
// Prisma's query log (the audit-snapshot-statements.test.ts harness) records the COMMIT but not the
// BEGIN, and names no connection. So this file's client has a pool of ONE: the log is then that one
// connection's sequence, the SET and the read before the COMMIT are inside the transaction it ends,
// a read sent on the top-level client while the transaction holds the connection would wait for it
// and fail, and a `SHOW jit` after the search reads the very connection the SET ran on.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", async () => {
  const { PrismaClient } = await import("../prisma/generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  return {
    prisma: new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }),
      log: [{ emit: "event", level: "query" }],
    }),
  };
});

import { prisma, truncateAll } from "./helpers/db";
import { globalSearch } from "@/server/search";
import type { SessionUser } from "@/server/sessions";

const sent: string[] = [];
(prisma as unknown as { $on(event: "query", listener: (e: { query: string }) => void): void })
  .$on("query", (e) => sent.push(e.query));

async function statementsOf(run: () => Promise<unknown>): Promise<string[]> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  sent.length = 0;
  await run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return [...sent];
}

const user = { role: { permissions: ["orders.view", "parts.view", "customers.view"].map((permission) => ({ permission })) }, overrides: [] } as unknown as SessionUser;

describe("global search's order read runs with JIT off (#888)", () => {
  beforeEach(truncateAll);

  it("sends SET LOCAL jit = off and the order read inside one transaction, and only those", async () => {
    const customer = await prisma.customer.create({ data: { code: "JIT", name: "Jit" } });
    const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "JIT-1", eachWeight: "1.0000" } });
    await prisma.order.create({
      data: {
        orderNumber: 88801, customerId: customer.id, poNumber: "PO-JIT",
        receivedDate: new Date("2026-08-01"), requestDate: new Date("2026-08-05"),
        lines: { create: [{ position: 1, partId: part.id, qty: 1, weight: "1.00" }] },
      },
    });

    const statements = await statementsOf(async () => {
      const result = await globalSearch(user, "PO-JIT");
      expect(result.orders.map((o) => o.orderNumber)).toEqual([88801]);
    });

    const set = statements.findIndex((s) => /^\s*SET LOCAL jit = off\s*$/i.test(s));
    const orderRead = statements.findIndex((s) => /^\s*SELECT\b[^]*\bFROM\s+"public"\."Order"\s+WHERE\b[^]*\bILIKE\b/i.test(s));
    const commit = statements.findIndex((s) => /^\s*COMMIT\b/i.test(s));
    expect(set).toBeGreaterThan(-1);
    expect(orderRead).toBeGreaterThan(set);
    expect(commit).toBeGreaterThan(orderRead);
    // One transaction, holding the order read and its relation reads (customer code, lead line,
    // part number) and nothing else: the part and customer groups run outside it.
    expect(statements.filter((s) => /^\s*COMMIT\b/i.test(s))).toHaveLength(1);
    const inside = statements.slice(set + 1, commit);
    expect(inside.every((s) => /^\s*SELECT\b/i.test(s))).toBe(true);
    expect(inside.some((s) => /FROM\s+"public"\."Part"\s+WHERE\b[^]*\bILIKE\b/i.test(s))).toBe(false);
    expect(inside.some((s) => /FROM\s+"public"\."Customer"\s+WHERE\b[^]*\bILIKE\b/i.test(s))).toBe(false);

    // The setting ended with the transaction: the pool's one connection reads JIT as the server has it.
    const [{ jit }] = await prisma.$queryRaw<{ jit: string }[]>`SELECT current_setting('jit') AS jit`;
    const [{ server }] = await prisma.$queryRaw<{ server: string }[]>`SELECT reset_val AS server FROM pg_settings WHERE name = 'jit'`;
    expect(server).toBe("on"); // postgres:18's default; off, this check would prove nothing
    expect(jit).toBe(server);
  });
});
