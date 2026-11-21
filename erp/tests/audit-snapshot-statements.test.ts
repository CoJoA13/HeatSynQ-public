// What a header-only blur sends to the database (#617, #616's header half; owner ruling R5 of the
// 2026-10-22 review). `auditedUpdate` snapshots the row before and after through
// `SNAPSHOT_INCLUDE`, the record's whole child tree, so a PO number blur on the hub read every
// line, container, serial, load and charge twice and wrote them twice into the audit row; an
// invoice header blur read its lines four times, a cert notes blur its requirement tree three
// times. Under R5 the three header mutators ask for `SNAPSHOT_HEADER`, children-free, and the
// statements between the audit claim and the AuditLog insert touch no child table. A line edit
// (#616, owner ruling 2026-11-02) asks for `SNAPSHOT_LINES`: the order and its lines alone.
//
// Counted from Prisma's own query log, the order-read-statements.test.ts harness: the client is
// swapped for one built with the log on, so every module this file loads gets that client.
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
import { createOrder, updateLine, updateOrder, type OrderDetail } from "@/server/orders";
import { createShipper } from "@/server/shippers";
import { addPartPrice } from "@/server/part-prices";
import { createInvoice, updateInvoice } from "@/server/invoices";
import { createCert, updateCert } from "@/server/certs";
import type { Customer } from "../prisma/generated/prisma/client";

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

const table = (statement: string) => /\bFROM\s+"public"\."(\w+)"/.exec(statement)?.[1];
function selectsByTable(statements: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of statements) {
    if (!/^\s*SELECT\b/i.test(s)) continue;
    const t = table(s);
    if (t === undefined) continue;
    counts[t] = (counts[t] ?? 0) + 1;
  }
  return counts;
}
/** The statements between the audit claim (`FOR NO KEY UPDATE`) and the AuditLog insert: the two
 *  snapshots and the row's own update, and nothing else. */
function auditSpan(statements: string[]): string[] {
  const claim = statements.findIndex((s) => /FOR NO KEY UPDATE/.test(s));
  const insert = statements.findIndex((s, i) => i > claim && /^\s*INSERT\b[^]*"AuditLog"/i.test(s));
  expect(claim).toBeGreaterThan(-1);
  expect(insert).toBeGreaterThan(claim);
  return statements.slice(claim + 1, insert);
}

let seq = 0;
async function orderWithChildren(customer: Customer): Promise<OrderDetail> {
  seq += 1;
  const gl = await prisma.glAccount.create({ data: { name: `43${seq}`, description: "Sales" } });
  const code = await prisma.processStepCode.create({ data: { code: `ASS-${seq}`, name: "Austenitize", glAccountId: gl.id } });
  const parts: { id: string }[] = [];
  for (const n of [1, 2]) {
    const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: `ASS-P${seq}-${n}`, eachWeight: "1.0000" } });
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    await prisma.partProcessStep.create({ data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Run." } });
    await asSystem(() => addPartPrice(part.id, { processStepCodeId: code.id, position: 1, unitPrice: "6.5100", minimumCharge: "600.00", pricePer: "EACH" }));
    parts.push(part);
  }
  const binType = await prisma.containerType.create({ data: { name: `Bin ${seq}` } });
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id,
    lines: [{ partId: parts[0].id, qty: 10, weight: "5.00" }, { partId: parts[1].id, qty: 10, weight: "5.00" }],
    containers: [{ typeId: binType.id, count: 2 }],
  }));
  return order;
}

describe("header-only blurs snapshot no child rows (#617, R5)", () => {
  let customer: Customer;
  let order: OrderDetail;
  beforeEach(async () => {
    await truncateAll();
    await seedOrderGatePrereqs();
    customer = await prisma.customer.create({ data: { code: "ASS", name: "Audit Snapshot" } });
    order = await orderWithChildren(customer);
  });

  it("updateOrder: the audit span reads the Order row twice and no line, container, serial, load or charge", async () => {
    const statements = await statementsOf(() => asSystem(() => updateOrder(order.id, { poNumber: "PO-HEADER" })));
    const span = selectsByTable(auditSpan(statements));
    expect(span).toEqual({ Order: 2 });
  });

  // A line edit (#616; owner ruling 2026-11-02) reads the order and its lines, each line with its
  // part number and quote number, twice, and no container, serial, load or charge.
  it("updateLine: the audit span reads the Order row and its lines twice, and no container, serial, load or charge", async () => {
    const statements = await statementsOf(() => asSystem(() => updateLine(order.id, order.lines[1].id, { qty: 12 })));
    const span = selectsByTable(auditSpan(statements));
    expect(span).toEqual({ Order: 2, OrderLine: 2, Part: 2, QuoteLine: 2, Quote: 2 });
  });

  it("updateInvoice: the audit span reads the Invoice row twice with its customer and order names, and no line", async () => {
    await createShipper({
      customerId: customer.id, shipDate: "2026-08-04",
      orders: [{ orderId: order.id, lines: order.lines.map((l) => ({ orderLineId: l.id, qty: 10, weight: "5.00", lineComplete: false })), containers: [], serials: [] }],
    }, { canOverrideCreditHold: false });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    const statements = await statementsOf(() => asSystem(() => updateInvoice(invoice.id, { poNumber: "PO-HEADER" })));
    const span = selectsByTable(auditSpan(statements));
    expect(span).toEqual({ Invoice: 2, Customer: 2, Order: 2 });
  });

  it("updateCert: the audit span reads the Cert row twice and no requirement or reading", async () => {
    const cert = await asSystem(() => createCert({ orderId: order.id, scope: "ORDER" }));
    const statements = await statementsOf(() => asSystem(() => updateCert(cert.id, { internalNotes: "checked" })));
    const span = selectsByTable(auditSpan(statements));
    expect(span).toEqual({ Cert: 2 });
  });
});
