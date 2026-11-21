// What Export to GL sends to the database for its postings (#707): the per-event `GlPosting` rows
// go in as ONE insert, and the export reads none of them back.
//
// Measured on 2026-11-02 (Prisma 7 with the pg driver adapter), before the change: the nested
// `postings: { create: [...] }` under `glExportBatch.create` already sent ONE multi-row INSERT for
// the 11 postings below, so #707's per-row premise did not hold and `createMany` would add nothing.
// What it did send beside it was a SELECT reading every posting back for an answer the screen drops;
// that read is gone. Counted from Prisma's own query log, the `order-read-statements` harness's
// shape: the log is switched on when a client is constructed, so this file swaps the shared client
// for one built with it on. The one SELECT on `GlPosting` left is the delta's own read of the
// month's prior postings (`buildPriorNet`, bounded by `glDate`).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", async () => {
  const { PrismaClient } = await import("../prisma/generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  return {
    prisma: new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
      log: [{ emit: "event", level: "query" }],
    }),
  };
});

import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { closePeriod } from "@/server/close-periods";
import { exportClose } from "@/server/gl-export";
import { parseDateOnly } from "@/lib/business-days";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

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

beforeEach(truncateAll);

/** A closed July 2026 holding three invoices (one taxed) and two payments: 11 postings. */
async function closedJuly(): Promise<string> {
  const mk = (name: string) => prisma.glAccount.create({ data: { name } });
  const [ar, rev, cash, tax] = [await mk("1200-AR"), await mk("4010-REV"), await mk("1000-CASH"), await mk("2200-TAX")];
  const step = await prisma.processStepCode.create({ data: { code: "HT", name: "Heat Treat", glAccountId: rev.id } });
  await prisma.billingConfig.update({ where: { id: "singleton" }, data: { arGlAccountId: ar.id, salesTaxGlAccountId: tax.id } });
  const paymentType = await prisma.paymentType.create({ data: { name: "Check", glAccountId: cash.id } });
  const july = parseDateOnly("2026-07-05");
  for (let i = 0; i < 3; i++) {
    const customer = await prisma.customer.create({ data: { code: `GLS${i}`, name: `GL Statements ${i}` } });
    const order = await prisma.order.create({
      data: { orderNumber: 990000 + i, customerId: customer.id, status: "SHIPPED", receivedDate: july, requestDate: july },
    });
    const taxTotal = i === 0 ? 7 : 0;
    const invoice = await prisma.invoice.create({
      data: {
        kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: customer.id, invoiceDate: july, dueDate: july,
        total: 100 + taxTotal, taxTotal, subtotal: 100, finalizedAt: july,
        lines: { create: [
          { position: 1, kind: "OPERATION", processStepCodeId: step.id, glAccountId: rev.id, glAccountName: "4010-REV", description: "Heat Treat", amount: 100 },
          ...(taxTotal ? [{ position: 2, kind: "TAX" as const, glAccountId: tax.id, glAccountName: "2200-TAX", description: "Sales tax", amount: taxTotal }] : []),
        ] },
      },
    });
    if (i < 2) {
      const batch = await prisma.receiptBatch.create({ data: { batchNumber: 991000 + i, depositDate: july, status: "POSTED" } });
      const payment = await prisma.payment.create({
        data: { batchId: batch.id, customerId: customer.id, paymentTypeId: paymentType.id, amount: 50, receivedDate: july },
      });
      await prisma.application.create({ data: { invoiceId: invoice.id, amount: 50, type: "PAYMENT", paymentId: payment.id, appliedDate: july } });
    }
  }
  await asSystem(() => closePeriod(2026, 7));
  return (await prisma.closePeriod.findFirstOrThrow({ where: { year: 2026, month: 7 } })).id;
}

describe("Export to GL writes its postings in one statement and reads none back (#707)", () => {
  it("one INSERT for every posting, and no read of them back", async () => {
    const periodId = await closedJuly();
    let postingCount = 0;
    const statements = await statementsOf(async () => { postingCount = (await asSystem(() => exportClose(periodId))).postings.length; });
    expect(postingCount).toBe(11);
    expect(await prisma.glPosting.count()).toBe(11);
    const inserts = statements.filter((s) => /^INSERT INTO "public"\."GlPosting"/.test(s));
    expect(inserts).toHaveLength(1);
    expect(statements.filter((s) => /^SELECT\b/.test(s) && /\bFROM "public"\."GlPosting"/.test(s) && !/"glDate"\s*>=/.test(s))).toEqual([]);
  });
});
