import { describe, expect, it } from "vitest";
import { createPublicClient } from "../scripts/lib/public-client";

describe("public client transaction interception", () => {
  it("allows save, intercept and restore without recursively entering the interceptor", async () => {
    const { prisma } = createPublicClient(process.env.DATABASE_URL_TEST!);
    const client = prisma as unknown as { $transaction: (...args: unknown[]) => Promise<unknown> };
    const original = client.$transaction;
    const seen: unknown[] = [];
    let calls = 0;
    try {
      client.$transaction = (...args) => {
        calls++;
        // Bound the original defect before asynchronous recursion can exhaust memory.
        if (calls >= 3) throw new Error("Transaction interceptor recursively re-entered");
        seen.push(args[1]);
        return original.apply(prisma, args);
      };
      const result = await prisma.$transaction(async tx => {
        const rows = await tx.$queryRaw<Array<{ value: number }>>`SELECT 42::integer AS value`;
        return rows[0].value;
      }, { isolationLevel: "Serializable" });
      expect(result).toBe(42);
      expect(calls).toBe(1);
      expect(seen).toEqual([{ isolationLevel: "Serializable" }]);
      client.$transaction = original;
      expect(client.$transaction).toBe(original);
      expect(await prisma.$transaction(async tx => {
        const rows = await tx.$queryRaw<Array<{ value: number }>>`SELECT 43::integer AS value`;
        return rows[0].value;
      })).toBe(43);
      expect(calls).toBe(1);
    } finally {
      client.$transaction = original;
      await prisma.$disconnect();
    }
  }, 15_000);

  it("admits a fresh client before twenty concurrent transactions acquire connections", async () => {
    const { prisma } = createPublicClient(process.env.DATABASE_URL_TEST!);
    try {
      const counts = await Promise.all(Array.from({ length: 20 }, () =>
        prisma.$transaction(tx => tx.publicInstallation.count())));
      expect(counts).toEqual(Array(20).fill(1));
    } finally { await prisma.$disconnect(); }
  }, 15_000);
});
