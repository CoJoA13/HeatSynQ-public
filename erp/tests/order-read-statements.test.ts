// What `getOrder` sends to the database for the hub's invoice fact (#472): one statement on
// `Invoice`, and nothing after it.
//
// Counted from Prisma's own query log, because the statement this file exists to keep out is one
// no delegate call names. A `select` that reaches through a relation (`order: { select: … }`) is
// loaded with a second statement, and Prisma sends that statement even when the first found no
// row. So a counter on `prisma.invoice.findFirst` reads one call either way.
//
// The log is switched on when a client is constructed, so this file swaps the shared client for one
// built with it on, at the same database. Every module this file loads then gets that client, the
// test helpers included.
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

import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createOrder, getOrder } from "@/server/orders";
import { finalizedInvoiceFor, finalizedInvoiceIdFor } from "@/server/invoice-guards";
import { parseDateOnly } from "@/lib/business-days";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

/** Every statement the client has sent, in the order it reported them. */
const sent: string[] = [];
(prisma as unknown as { $on(event: "query", listener: (e: { query: string }) => void): void })
  .$on("query", (e) => sent.push(e.query));

/** The statements `run` sends. One macrotask is left for the log to report the last of them. */
async function statementsOf(run: () => Promise<unknown>): Promise<string[]> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  sent.length = 0;
  await run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return [...sent];
}

/** The table a SELECT reads from: the first one its FROM names. */
const table = (statement: string) => /\bFROM\s+"public"\."(\w+)"/.exec(statement)?.[1];
/** The columns a SELECT asks for, as `Table.column`, in order. */
const columns = (statement: string) =>
  [.../"public"\."(\w+)"\."(\w+)"/g[Symbol.matchAll](statement.slice(0, statement.search(/\bFROM\b/)))]
    .map((m) => `${m[1]}.${m[2]}`);

async function savedOrder() {
  const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme Gear" } });
  const code = await prisma.processStepCode.create({ data: { code: "HT-01", name: "Austenitize" } });
  const lead = await prisma.part.create({
    data: { customerId: customer.id, partNumber: "DEMO-RG-1001", name: "Ring gear", eachWeight: "13.5000", loadQty: 336 },
  });
  const revision = await prisma.partProcessRevision.create({ data: { partId: lead.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: revision.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
  }));
  return { order, customer };
}

const finalizedInvoice = (orderId: string, customerId: string) => prisma.invoice.create({
  data: {
    orderId, customerId, kind: "INVOICE", status: "FINALIZED",
    invoiceDate: parseDateOnly("2026-08-08"), total: 500, finalizedAt: new Date(),
  },
});

describe("getOrder: the statements behind finalizedInvoiceId (#472)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it.each([
    ["an order with no invoice", false],
    ["an order with a finalized invoice", true],
  ])("for %s the read ends with one statement on Invoice, which asks for the id alone", async (_name, invoiced) => {
    const { order, customer } = await savedOrder();
    const invoice = invoiced ? await finalizedInvoice(order.id, customer.id) : null;

    let read: Awaited<ReturnType<typeof getOrder>> | undefined;
    const statements = await statementsOf(async () => { read = await getOrder(order.id); });

    expect(read?.finalizedInvoiceId).toBe(invoice?.id ?? null);
    // One statement on Invoice in the whole read.
    expect(statements.filter((s) => table(s) === "Invoice")).toHaveLength(1);
    // And it is the last thing the read sends: no statement follows it to load the invoice's
    // order, which is what a reader that also selects the order number costs.
    const last = statements[statements.length - 1];
    expect(table(last)).toBe("Invoice");
    expect(columns(last)).toEqual(["Invoice.id"]);
  });

  it("the id-only reader is one statement, with or without a row to find", async () => {
    const { order, customer } = await savedOrder();
    const none = await statementsOf(() => finalizedInvoiceIdFor(prisma, order.id));
    expect(none.map(table)).toEqual(["Invoice"]);
    await finalizedInvoice(order.id, customer.id);
    const one = await statementsOf(() => finalizedInvoiceIdFor(prisma, order.id));
    expect(one.map(table)).toEqual(["Invoice"]);
  });

  // The control. Without it, "one statement" could mean the log never saw a relation load at all.
  // The guard's own reader selects the order number through the relation, and that is a second
  // statement on Order, sent even when no invoice was found.
  it("and the log does see a relation load: the guard's reader, which names the order, sends two", async () => {
    const { order } = await savedOrder();
    const statements = await statementsOf(() => finalizedInvoiceFor(prisma, order.id));
    expect(statements.map(table)).toEqual(["Invoice", "Order"]);
  });
});
