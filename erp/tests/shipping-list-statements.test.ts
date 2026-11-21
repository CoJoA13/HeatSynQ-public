// What `listShippers` sends to the database (#631, ruling R4): the shipment rows and their
// relations, and nothing of the ledger. Before this change the list awaited
// `shipperOrderCompletion` over every listed `ShipperOrder` to build a Complete/Partial tag that
// neither the shipping list nor its Excel export shows; the hub's Shipments section, which does,
// reads `shipmentsForOrder`, and that read keeps the ledger's statements.
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
import { createOrder, type OrderDetail } from "@/server/orders";
import { createShipper, exportShippers, listShippers, shipmentsForOrder } from "@/server/shippers";
import type { Customer } from "../prisma/generated/prisma/client";

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

/** A statement the completion rule needs (`completionOfTargets`, ship-ledger.ts), or that a select
 *  widened for it sends: a read of the order lines' current quantities, or a `ShipperLine` read
 *  selecting `lineComplete`. The list's own `ShipperLine` read selects `qty` and `weight` alone, so
 *  the column is the tell; a count of `ShipperLine` statements is not. */
const isLedgerRead = (statement: string) =>
  table(statement) === "OrderLine" || /"ShipperLine"\."lineComplete"/.test(statement);
/** The tables a run read, as a sorted multiset: Prisma reports the relation loads of one
 *  `findMany` in no fixed order between runs. */
const tablesOf = (statements: string[]) => statements.map(table).sort();

let seq = 0;
async function shippedOrder(customer: Customer, shipDate: string): Promise<OrderDetail> {
  seq += 1;
  const code = await prisma.processStepCode.create({ data: { code: `SLS-${seq}`, name: "Austenitize" } });
  const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: `SLS-P${seq}`, eachWeight: "1.0000" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({ data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize." } });
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, lines: [{ partId: part.id, qty: 10, weight: "5.00" }],
  }));
  await createShipper({
    customerId: customer.id, shipDate,
    orders: [{
      orderId: order.id,
      lines: [{ orderLineId: order.lines[0].id, qty: 10, weight: "5.00", lineComplete: false }],
      containers: [], serials: [],
    }],
  }, { canOverrideCreditHold: false });
  return order;
}

describe("listShippers: the statements behind a list row (#631)", () => {
  let customer: Customer;
  let order: OrderDetail;
  beforeEach(async () => {
    await truncateAll();
    await seedOrderGatePrereqs();
    customer = await prisma.customer.create({ data: { code: "SLS", name: "Statement Customer" } });
    order = await shippedOrder(customer, "2026-08-04");
    await shippedOrder(customer, "2026-08-05");
  });

  it("the list reads the shipment rows and their relations, and nothing of the ledger", async () => {
    const statements = await statementsOf(() => listShippers({}));
    expect(statements.filter(isLedgerRead)).toEqual([]);
    // The measured set, so a statement added to the list's read is a decision: the shipment rows,
    // then one statement per nested relation of ROW_SELECT (customer, carrier, the reversed
    // original, the live reversal, the orders, their order numbers and their lines). Measured on
    // 2026-10-23 over two single-order shipments: 13 statements before #631, these 8 after.
    expect(tablesOf(statements)).toEqual([
      "Carrier", "Customer", "Order", "Shipper", "Shipper", "Shipper", "ShipperLine", "ShipperOrder",
    ]);
  });

  it("the Excel export sends the same statements as the list", async () => {
    const list = await statementsOf(() => listShippers({}));
    const excel = await statementsOf(() => exportShippers({}));
    expect(tablesOf(excel)).toEqual(tablesOf(list));
    expect(excel.filter(isLedgerRead)).toEqual([]);
  });

  // The control: the hub's read is the one that pays for the tag, and the log sees it do so. Its
  // own select carries each line's `lineComplete` and the live line's current quantity (#628:
  // `HUB_ROW_SELECT`, so the rows are read once), then the rule reads the live-row group.
  it("the hub's shipmentsForOrder still sends the reads behind the tag", async () => {
    const statements = await statementsOf(() => shipmentsForOrder(order.id));
    expect(statements.filter(isLedgerRead).map(table)).toEqual(["ShipperLine", "OrderLine", "ShipperLine"]);
    // Exactly one of them is the rule's own read: the live rows on the targets' order lines.
    expect(statements.filter((s) => isLedgerRead(s) && /"shipperOrderId"[\s\S]*"deletedAt"/.test(s))).toHaveLength(1);
    const [row] = await shipmentsForOrder(order.id);
    expect(row.orders[0].complete).toBe(true);
  });
});
