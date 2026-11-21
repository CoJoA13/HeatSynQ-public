import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { storedTareEach, keptAndLinkedRows } from "./helpers/shipment-rows";
import { readXlsx } from "./helpers/xlsx";
import { runWithContext } from "@/server/context";
import { readAudit } from "@/server/audit";
import { createOrder, getOrder, voidOrder, type OrderDetail } from "@/server/orders";
import { storeDocument } from "@/server/documents";
import {
  createShipper, updateShipper, addOrderToShipper, removeOrderFromShipper,
  replaceShipperLines, replaceShipperContainers, replaceShipperSerials,
  overshipWarnings, listShippers, exportShippers, shipmentsForOrder, reverseShipper, voidShipper,
  readPrintedOrders, readShipToAddress,
  type ShipperDetail, type ShipperOrderDetail,
} from "@/server/shippers";
import { removeOrderRefusal, type RemoveOrderFacts } from "@/lib/shipment-remove-order";
import type { Customer, Part } from "../prisma/generated/prisma/client";

// House-legal module-boundary mock (CLAUDE.md: never `vi.spyOn` a Prisma delegate — this wraps a
// LEAF service module instead, the `tests/fetcher.test.ts` / `tests/request-context.test.ts`
// precedent for mocking at a boundary rather than a Prisma model method). The wrapped functions
// still run their REAL implementation (`vi.fn(actual.fn)`) — this only adds a call recorder, it
// never changes behaviour, so every ordinary (non-composition) test below exercises the genuine
// row-lock code path.
vi.mock("@/server/order-locks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/order-locks")>();
  return {
    ...actual,
    claimOrdersInOrder: vi.fn(actual.claimOrdersInOrder),
    claimOrder: vi.fn(actual.claimOrder),
  };
});
import * as orderLocks from "@/server/order-locks";

const claimOrdersInOrderMock = vi.mocked(orderLocks.claimOrdersInOrder);
const claimOrderMock = vi.mocked(orderLocks.claimOrder);

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({ data: { code: `SC${customerSeq}`, name: `Ship Customer ${customerSeq}` } });
}

let partSeq = 0;
async function makePart(customerId: string): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({ data: { customerId, partNumber: `SP-${partSeq}`, eachWeight: "1.0000" } });
}

/** Gives a part revision 1 with one step — the orderability precondition createOrder enforces
 *  (spec §5.3), the shippers.test.ts `giveSteps` precedent. */
async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `SHT-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

async function orderForCustomer(
  customer: Customer, opts: { qty?: number; weight?: string } = {},
): Promise<OrderDetail> {
  const part = await makePart(customer.id);
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, lines: [{ partId: part.id, qty: opts.qty ?? 10, weight: opts.weight ?? "5.00" }],
  }));
  return order;
}

async function savedOrder(
  opts: { qty?: number; weight?: string } = {},
): Promise<{ order: OrderDetail; customer: Customer }> {
  const customer = await makeCustomer();
  const order = await orderForCustomer(customer, opts);
  return { order, customer };
}

type ShipContainerInput = { orderContainerId: string; count: number };
type ShipSerialInput = { orderSerialId: string; printOnShipper?: boolean };

/** One order's worth of `createShipper` input, shipping its lead line in full. */
function orderInput(order: OrderDetail) {
  return {
    orderId: order.id,
    lines: [{
      orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight, lineComplete: false,
    }],
    containers: [] as ShipContainerInput[],
    serials: [] as ShipSerialInput[],
  };
}

function oneOrderInput(order: OrderDetail) {
  return { customerId: order.customerId, shipDate: "2026-08-04", orders: [orderInput(order)] };
}

function multiOrderInput(customerId: string, orders: OrderDetail[]) {
  return { customerId, shipDate: "2026-08-04", orders: orders.map(orderInput) };
}

async function oneOrderShipment(): Promise<{ shipper: ShipperDetail; orderA: OrderDetail; customer: Customer }> {
  const { order, customer } = await savedOrder({ qty: 10 });
  const { shipper } = await createShipper(oneOrderInput(order), { canOverrideCreditHold: false });
  return { shipper, orderA: order, customer };
}

async function twoOrderShipment(): Promise<{
  shipper: ShipperDetail; first: ShipperOrderDetail; second: ShipperOrderDetail;
  customer: Customer; orders: OrderDetail[];
}> {
  const customer = await makeCustomer();
  const a = await orderForCustomer(customer);
  const b = await orderForCustomer(customer);
  const { shipper } = await createShipper(multiOrderInput(customer.id, [a, b]), { canOverrideCreditHold: false });
  return { shipper, first: shipper.orders[0], second: shipper.orders[1], customer, orders: [a, b] };
}

async function threeOrderShipment(): Promise<{
  shipper: ShipperDetail; first: ShipperOrderDetail; second: ShipperOrderDetail; third: ShipperOrderDetail;
  customer: Customer;
}> {
  const customer = await makeCustomer();
  const a = await orderForCustomer(customer);
  const b = await orderForCustomer(customer);
  const c = await orderForCustomer(customer);
  const { shipper } = await createShipper(multiOrderInput(customer.id, [a, b, c]), { canOverrideCreditHold: false });
  return { shipper, first: shipper.orders[0], second: shipper.orders[1], third: shipper.orders[2], customer };
}

async function shipmentPlusSpareOrder(): Promise<{ shipper: ShipperDetail; orderB: OrderDetail }> {
  const { shipper, customer } = await oneOrderShipment();
  const orderB = await orderForCustomer(customer);
  return { shipper, orderB };
}

async function shipmentPlusForeignOrder(): Promise<{ shipper: ShipperDetail; foreignOrder: OrderDetail }> {
  const { shipper } = await oneOrderShipment();
  const { order: foreignOrder } = await savedOrder();
  return { shipper, foreignOrder };
}

/** A TWO-order shipment whose first order's single line is shipped in full, so that order starts
 *  out SHIPPED by quantity — the brief's own fixture, adapted two ways from its sample code: (1)
 *  the self-referential `orderA` argument its sample passed (`const { orderA } = await
 *  completeShipmentOf(orderA)` reads its own binding before initialization) is dropped, this
 *  fixture takes none; (2) a SECOND order is added so the removal the test performs is never the
 *  shipment's LAST order — spec §4.2's "at least one line with qty > 0 across all its orders",
 *  enforced at the document level in `removeOrderFromShipper` (coordinator review, this task):
 *  a one-order version of this fixture would make the test exercise the now-forbidden
 *  remove-the-last-order state instead of the status recompute it was written to prove. */
async function completeShipmentOf(): Promise<{
  shipper: ShipperDetail; orderA: OrderDetail; shipperOrderA: ShipperOrderDetail;
}> {
  const customer = await makeCustomer();
  const orderA = await orderForCustomer(customer, { qty: 10 });
  const orderSpare = await orderForCustomer(customer);
  const input = multiOrderInput(customer.id, [orderA, orderSpare]);
  const { shipper } = await createShipper(input, { canOverrideCreditHold: false });
  return { shipper, orderA, shipperOrderA: shipper.orders[0] };
}

beforeEach(async () => {
  await truncateAll();
  await seedOrderGatePrereqs();
  claimOrdersInOrderMock.mockClear();
  claimOrderMock.mockClear();
});

describe("addOrderToShipper", () => {
  it("adds another order of the same customer and gives it its own sequence", async () => {
    const { shipper, orderB } = await shipmentPlusSpareOrder();
    const after = await addOrderToShipper(shipper.id, orderB.id);
    expect(after.orders).toHaveLength(2);
    expect(after.orders[1].sequence).toBe(1); // orderB's FIRST shipment
    expect(after.orders[1].position).toBe(2); // second ticket on this shipment
  });

  it("creates the shipment-scope cert for a cert-requiring order, like the initial save", async () => {
    const { shipper, customer } = await oneOrderShipment();
    const part = await makePart(customer.id);
    await prisma.part.update({ where: { id: part.id }, data: { certRequired: true, certScope: "SHIPMENT" } });
    await giveSteps(part.id);
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: part.id, qty: 5, weight: "5.00" }],
    }));

    await addOrderToShipper(shipper.id, order.id);

    const cert = await prisma.cert.findFirst({
      where: { orderId: order.id, shipperId: shipper.id, deletedAt: null },
    });
    expect(cert).not.toBeNull();
  });

  it("refuses an order belonging to a different customer", async () => {
    const { shipper, foreignOrder } = await shipmentPlusForeignOrder();
    await expect(addOrderToShipper(shipper.id, foreignOrder.id)).rejects.toThrow(/same customer/i);
  });

  it("refuses the same order twice on one shipment", async () => {
    const { shipper, orderA } = await oneOrderShipment();
    await expect(addOrderToShipper(shipper.id, orderA.id)).rejects.toThrow(/already on this shipment/i);
  });

  it("refuses a voided order", async () => {
    const { shipper, orderB } = await shipmentPlusSpareOrder();
    await asSystem(() => voidOrder(orderB.id, "wrong part"));
    await expect(addOrderToShipper(shipper.id, orderB.id)).rejects.toThrow(/voided/i);
  });

  it("404s on a voided shipment — a voided shipment is read-only", async () => {
    const { shipper, orderB } = await shipmentPlusSpareOrder();
    await prisma.shipper.update({ where: { id: shipper.id }, data: { deletedAt: new Date() } });
    await expect(addOrderToShipper(shipper.id, orderB.id)).rejects.toThrow(/not found/i);
  });

  it("404s on an unknown shipment id", async () => {
    const { order } = await savedOrder();
    await expect(addOrderToShipper("nope", order.id)).rejects.toThrow(/not found/i);
  });
});

describe("removeOrderFromShipper", () => {
  it("recomputes status when an order is removed", async () => {
    const { shipper, orderA, shipperOrderA } = await completeShipmentOf();
    expect((await getOrder(orderA.id)).status).toBe("SHIPPED");
    await removeOrderFromShipper(shipper.id, shipperOrderA.id);
    expect((await getOrder(orderA.id)).status).toBe("OPEN");
  });

  it("closes positions after a removal", async () => {
    const { shipper, second } = await threeOrderShipment();
    const after = await removeOrderFromShipper(shipper.id, second.id);
    expect(after.orders.map((o) => o.position)).toEqual([1, 2]);
  });

  it("refuses to remove an order whose ticket has printed, and allows it before", async () => {
    const { shipper, second } = await twoOrderShipment();
    await expect(removeOrderFromShipper(shipper.id, second.id)).resolves.toBeTruthy(); // nothing printed

    const { shipper: s2, second: sec2 } = await twoOrderShipment();
    await prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "SHIPPER", shipperId: s2.id, orderId: sec2.orderId }, Buffer.from("%PDF-1.4 t")));
    await expect(removeOrderFromShipper(s2.id, sec2.id)).rejects.toThrow(/already printed|void the shipment/i);
  });

  it("refuses to remove the order carrying the shipment's only positive-qty line", async () => {
    // Order B joins with NO lines (addOrderToShipper creates only the shell) — removing order A
    // would leave a live shipment with no positive quantity, the §4.2 invariant creation and
    // replaceShipperLines both enforce.
    const { shipper, orderB } = await shipmentPlusSpareOrder();
    await addOrderToShipper(shipper.id, orderB.id);
    await expect(removeOrderFromShipper(shipper.id, shipper.orders[0].id))
      .rejects.toThrow(/positive quantity/i);
  });

  it("refuses to remove an order whose shipment-scope cert has printed", async () => {
    const { shipper, second } = await twoOrderShipment();
    const cert = await prisma.cert.create({
      data: { orderId: second.orderId, shipperId: shipper.id, scope: "SHIPMENT" },
    });
    // The cert printed BEFORE any ticket — the printed paper carries orderNumber-sequence
    // permanently, so the sequence must stay claimed exactly as a printed ticket's would.
    await prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "CERT", certId: cert.id }, Buffer.from("%PDF-1.4 c")));
    await expect(removeOrderFromShipper(shipper.id, second.id))
      .rejects.toThrow(/certification.*printed|void the shipment/i);
  });

  it("refuses to remove an order once the BOL has printed — the BOL names its order number permanently", async () => {
    const { shipper, first, second } = await twoOrderShipment();
    await prisma.$transaction((tx) => storeDocument(tx,
      { kind: "BOL", shipperId: shipper.id, coveredOrderIds: [first.orderId, second.orderId] },
      Buffer.from("%PDF-1.4 b")));
    await expect(removeOrderFromShipper(shipper.id, second.id))
      .rejects.toThrow(/already printed|void the shipment/i);
  });

  it("treats a whole-set ticket print as covering every order on the shipment", async () => {
    const { shipper, first, second } = await twoOrderShipment();
    await prisma.$transaction((tx) => storeDocument(tx,
      { kind: "SHIPPER", shipperId: shipper.id, orderId: null, coveredOrderIds: [first.orderId, second.orderId] },
      Buffer.from("%PDF-1.4 t")));
    await expect(removeOrderFromShipper(shipper.id, second.id)).rejects.toThrow(/already printed/i);
  });

  // #140 (owner ruling 2026-08-18): a whole-set document blocks a removal only when its RECORDED
  // coverage (`coveredOrderIds`, #52) actually NAMES the order — never by treating `orderId: null`
  // as covering the shipment's current membership wholesale.
  it("an order added after a whole-set print removes freely — the recorded coverage excludes it (#140)", async () => {
    const { shipper, first, second, customer } = await twoOrderShipment();
    await prisma.$transaction((tx) => storeDocument(tx,
      { kind: "SHIPPER", shipperId: shipper.id, orderId: null, coveredOrderIds: [first.orderId, second.orderId] },
      Buffer.from("%PDF-1.4 t")));
    const late = await orderForCustomer(customer);
    const grown = await addOrderToShipper(shipper.id, late.id);
    const soLate = grown.orders.find((so) => so.orderId === late.id)!;
    const after = await removeOrderFromShipper(shipper.id, soLate.id);
    expect(after.orders.map((o) => o.orderId)).toEqual([first.orderId, second.orderId]);
  });

  it("a whole-set print still blocks exactly the orders its coverage names (#140)", async () => {
    const { shipper, first, second } = await twoOrderShipment();
    await prisma.$transaction((tx) => storeDocument(tx,
      { kind: "SHIPPER", shipperId: shipper.id, orderId: null, coveredOrderIds: [second.orderId] },
      Buffer.from("%PDF-1.4 t")));
    await expect(removeOrderFromShipper(shipper.id, second.id)).rejects.toThrow(/already printed/i);
    // ...while the sibling the coverage does NOT name removes freely under the same document.
    await expect(removeOrderFromShipper(shipper.id, first.id)).resolves.toBeTruthy();
  });

  // Interplay with #139: on a pair-live shipment the freeze (inside `claimLiveShipper`) fires
  // BEFORE the printed-paper guard — the pair is the operative blocker, and its refusal names the
  // correction that actually unblocks (void the reversal), not one the freeze would still refuse.
  it("on a pair-live shipment the #139 freeze fires before the printed-paper guard", async () => {
    const { shipper, first, second } = await twoOrderShipment();
    await prisma.$transaction((tx) => storeDocument(tx,
      { kind: "SHIPPER", shipperId: shipper.id, orderId: null, coveredOrderIds: [first.orderId, second.orderId] },
      Buffer.from("%PDF-1.4 t")));
    const { shipper: reversal } = await asSystem(() =>
      reverseShipper(shipper.id, { reason: "returned" }));
    await expect(removeOrderFromShipper(shipper.id, second.id)).rejects.toMatchObject({
      status: 400,
      message: `This shipment has been reversed by Packing List ${reversal.shipperNumber} — void the reversal first, then edit, then re-reverse`,
    });
  });

  it("404s for a shipperOrderId that belongs to a different shipment", async () => {
    const { shipper: s1 } = await oneOrderShipment();
    const { shipper: s2 } = await oneOrderShipment();
    await expect(removeOrderFromShipper(s1.id, s2.orders[0].id)).rejects.toThrow(/not on this shipment/i);
  });

  // Coordinator review (this task): spec §4.2's "at least one line with qty > 0 across all its
  // orders" is a DOCUMENT-level invariant — removing a shipment's last order would leave
  // `orders: []`, exactly the "document about nothing" the invariant forbids. Refused, naming the
  // real remedy (void the shipment, §5.6 — the correction that keeps every sequence claimed).
  it("refuses to remove the shipment's last remaining order", async () => {
    const { shipper } = await oneOrderShipment();
    await expect(removeOrderFromShipper(shipper.id, shipper.orders[0].id))
      .rejects.toThrow(/void the shipment/i);
  });

  it("allows removing an order that is not the last one on the shipment", async () => {
    const { shipper, second } = await twoOrderShipment();
    await expect(removeOrderFromShipper(shipper.id, second.id)).resolves.toBeTruthy();
  });

  // Step 6 (Task 2's review): assert ShipperOrder's two remaining uniques as BEHAVIOUR, not just
  // trust the service check — a service refactor that dropped the pre-check would still be caught
  // by these.
  it("the database rejects two ShipperOrder rows sharing (shipperId, orderId)", async () => {
    const { shipper, orderA } = await oneOrderShipment();
    await expect(prisma.shipperOrder.create({
      data: { shipperId: shipper.id, orderId: orderA.id, sequence: 99, position: 99 },
    })).rejects.toThrow();
  });

  it("(shipperId, position) stays unique through the two-phase renumber a removal triggers", async () => {
    const { shipper, second } = await threeOrderShipment();
    const after = await removeOrderFromShipper(shipper.id, second.id);
    const positions = after.orders.map((o) => o.position);
    expect(new Set(positions).size).toBe(positions.length); // no duplicate position survived

    const spare = await orderForCustomer(await prisma.customer.findUniqueOrThrow({ where: { id: after.customerId } }));
    await expect(prisma.shipperOrder.create({
      data: { shipperId: shipper.id, orderId: spare.id, sequence: 1, position: after.orders[0].position },
    })).rejects.toThrow();
  });
});

// #472: Remove order's refusals are one rule, `removeOrderRefusal` (src/lib/shipment-remove-order.ts),
// which the shipment page also calls to grey the button out before the click. These cases pin the
// mutator to that rule word for word, and pin `readPrintedOrders`, the read behind the page's copy
// of the printed-paper facts, to what the mutator then does.
describe("removeOrderFromShipper decides with the shared rule (#472)", () => {
  /** Two orders, nothing printed, no invoice, the other order ships something: nothing refuses. */
  const free = (shipper: ShipperDetail): RemoveOrderFacts => ({
    shipperNumber: shipper.shipperNumber, orderCount: 2, paperPrinted: false, invoice: null,
    survivorHasPositiveLine: true, certPrinted: false,
  });
  const refusedWith = (facts: RemoveOrderFacts) => ({ status: 400, message: removeOrderRefusal(facts) });
  const pdf = (mark: string) => Buffer.from(`%PDF-1.4 ${mark}`);

  it("refuses the only order with the only-order sentence", async () => {
    const { shipper } = await oneOrderShipment();
    await expect(removeOrderFromShipper(shipper.id, shipper.orders[0].id))
      .rejects.toMatchObject(refusedWith({ ...free(shipper), orderCount: 1 }));
  });

  it("refuses an order its own printed ticket names with the paper sentence, and the reader says so first", async () => {
    const { shipper, first, second } = await twoOrderShipment();
    await prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "SHIPPER", shipperId: shipper.id, orderId: second.orderId }, pdf("t")));

    expect(await readPrintedOrders(prisma, shipper.id, [first.orderId, second.orderId]))
      .toEqual({ paperOrderIds: [second.orderId], certOrderIds: [] });
    await expect(removeOrderFromShipper(shipper.id, second.id))
      .rejects.toMatchObject(refusedWith({ ...free(shipper), paperPrinted: true }));
    // The order the reader does not name removes freely.
    await expect(removeOrderFromShipper(shipper.id, first.id)).resolves.toBeTruthy();
  });

  it("refuses an order whose shipment certification has printed with the certification sentence, a voided certification's print included", async () => {
    const { shipper, first, second } = await twoOrderShipment();
    const cert = await prisma.cert.create({
      data: { orderId: second.orderId, shipperId: shipper.id, scope: "SHIPMENT" },
    });
    // A certification that exists and has not printed pins nothing.
    expect(await readPrintedOrders(prisma, shipper.id, [first.orderId, second.orderId]))
      .toEqual({ paperOrderIds: [], certOrderIds: [] });
    await prisma.$transaction((tx) => storeDocument(tx, { kind: "CERT", certId: cert.id }, pdf("c")));
    await prisma.cert.update({ where: { id: cert.id }, data: { deletedAt: new Date() } });

    expect(await readPrintedOrders(prisma, shipper.id, [first.orderId, second.orderId]))
      .toEqual({ paperOrderIds: [], certOrderIds: [second.orderId] });
    await expect(removeOrderFromShipper(shipper.id, second.id))
      .rejects.toMatchObject(refusedWith({ ...free(shipper), certPrinted: true }));
    await expect(removeOrderFromShipper(shipper.id, first.id)).resolves.toBeTruthy();
  });

  it("reads whole-set paper by its recorded coverage, for every order asked about at once (#140)", async () => {
    const { shipper, first, second, customer } = await twoOrderShipment();
    await prisma.$transaction((tx) => storeDocument(tx,
      { kind: "BOL", shipperId: shipper.id, coveredOrderIds: [first.orderId, second.orderId] }, pdf("b")));
    const late = await orderForCustomer(customer);
    const grown = await addOrderToShipper(shipper.id, late.id);

    // The shape `shipperResponse` asks in: every order on the shipment, in position order.
    expect(await readPrintedOrders(prisma, shipper.id, grown.orders.map((o) => o.orderId)))
      .toEqual({ paperOrderIds: [first.orderId, second.orderId], certOrderIds: [] });
  });

  it("reads only this shipment's paper: a traveler, another shipment's ticket and an order-scope certification pin nothing", async () => {
    const { shipper, first, second } = await twoOrderShipment();
    const { shipper: other } = await oneOrderShipment();
    const orderCert = await prisma.cert.create({ data: { orderId: first.orderId, scope: "ORDER" } });
    await prisma.$transaction(async (tx) => {
      await storeDocument(tx, { kind: "TRAVELER", orderId: first.orderId, loadNumber: null }, pdf("v"));
      await storeDocument(tx, { kind: "SHIPPER", shipperId: other.id, orderId: second.orderId }, pdf("t"));
      await storeDocument(tx, { kind: "CERT", certId: orderCert.id }, pdf("c"));
    });

    expect(await readPrintedOrders(prisma, shipper.id, [first.orderId, second.orderId]))
      .toEqual({ paperOrderIds: [], certOrderIds: [] });
    await expect(removeOrderFromShipper(shipper.id, second.id)).resolves.toBeTruthy();
  });

  it("asks nothing for an empty list of orders", async () => {
    const noDb = new Proxy({}, {
      get() { throw new Error("readPrintedOrders queried for an empty list"); },
    }) as unknown as Parameters<typeof readPrintedOrders>[0];
    expect(await readPrintedOrders(noDb, "any-shipment", [])).toEqual({ paperOrderIds: [], certOrderIds: [] });
  });

  // The #60 shape, for the reader. A read of its two that strayed onto the top-level client would
  // run on another connection: outside the caller's snapshot, and outside the read-set its
  // serialization check covers. Proven without a race. A row written inside a transaction and
  // never committed is visible only to a read made on that transaction, so each of the two reads
  // is given one such row to find. This proves the reader reads on the client it is HANDED. Which
  // client `removeOrderFromShipper` hands it is the next case's.
  it("makes both reads on the client it is handed: paper and a certification print written in the caller's own transaction are seen before any commit", async () => {
    const { shipper, first, second } = await twoOrderShipment();
    const rollBack = new Error("roll back");
    let seen: Awaited<ReturnType<typeof readPrintedOrders>> | undefined;
    await expect(prisma.$transaction(async (tx) => {
      // For the first read: a ticket naming the second order.
      await storeDocument(tx, { kind: "SHIPPER", shipperId: shipper.id, orderId: second.orderId }, pdf("t"));
      // For the second read: a printed shipment certification of the first order.
      const cert = await tx.cert.create({ data: { orderId: first.orderId, shipperId: shipper.id, scope: "SHIPMENT" } });
      await storeDocument(tx, { kind: "CERT", certId: cert.id }, pdf("c"));
      seen = await readPrintedOrders(tx, shipper.id, [first.orderId, second.orderId]);
      throw rollBack;
    })).rejects.toBe(rollBack);

    expect(seen).toEqual({ paperOrderIds: [second.orderId], certOrderIds: [first.orderId] });
    // Nothing was committed, so nothing but the transaction itself could have shown those rows.
    expect(await readPrintedOrders(prisma, shipper.id, [first.orderId, second.orderId]))
      .toEqual({ paperOrderIds: [], certOrderIds: [] });
  });

  // The other half. The reader's client is an argument, so `readPrintedOrders(prisma, …)` inside
  // the mutator compiles, and every case in this file that runs the mutator stays green with it:
  // none races a print against a removal. Before #472 these reads were written on `tx` inline and
  // could not stray. So the hand-off is pinned from the source, parsed (#188): the mutator calls
  // the reader once, inside its own `$transaction` callback, with that callback's client.
  it("removeOrderFromShipper hands the reader its own transaction: one call, with the client its $transaction callback was given", () => {
    const file = fileURLToPath(new URL("../src/server/shippers.ts", import.meta.url));
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const all = <T extends ts.Node>(root: ts.Node, is: (node: ts.Node) => node is T): T[] => {
      const out: T[] = [];
      const walk = (node: ts.Node): void => { if (is(node)) out.push(node); ts.forEachChild(node, walk); };
      walk(root);
      return out;
    };
    const mutators = all(source, ts.isFunctionDeclaration).filter((f) => f.name?.text === "removeOrderFromShipper");
    expect(mutators).toHaveLength(1);
    const reads = all(mutators[0], ts.isCallExpression)
      .filter((c) => ts.isIdentifier(c.expression) && c.expression.text === "readPrintedOrders");
    expect(reads.map((c) => c.arguments[0]?.getText(source))).toEqual(["tx"]);

    // And `tx` there is the transaction's client: the one parameter of the callback handed to the
    // mutator's one `prisma.$transaction(…)`, with the read written inside that callback.
    const transactions = all(mutators[0], ts.isCallExpression)
      .filter((c) => c.expression.getText(source) === "prisma.$transaction");
    expect(transactions).toHaveLength(1);
    const callback = transactions[0].arguments[0];
    if (!ts.isArrowFunction(callback)) throw new Error("$transaction must take an arrow function");
    expect(callback.parameters.map((p) => p.name.getText(source))).toEqual(["tx"]);
    expect(reads[0].pos >= callback.body.pos && reads[0].end <= callback.body.end).toBe(true);
    // No inner function re-declares the name between the callback and the read.
    const shadows = all(callback.body, ts.isParameter).filter((p) => p.name.getText(source) === "tx");
    expect(shadows).toHaveLength(0);
  });
});

// #484 (owner ruling 2026-10-15): each shipment answer carries the shipment's ship-to address,
// read by id after commit on the top-level client beside `printed`. `readShipToAddress` is that
// read. tests/shipper-routes.test.ts pins what the answers carry and when the read runs; these
// cases pin the reader, and pin from the source where it is called and where it is not.
describe("readShipToAddress (#484)", () => {
  const DOCK_7 = { name: "Dock 7", street: "1 Main St", city: "Springfield", state: "IL", zip: "62701" };

  it("asks nothing for a shipment with no address", async () => {
    const noDb = new Proxy({}, {
      get() { throw new Error("readShipToAddress queried for no address"); },
    }) as unknown as Parameters<typeof readShipToAddress>[0];
    expect(await readShipToAddress(noDb, null)).toBeNull();
  });

  // The #60 shape: an address written inside a transaction and never committed is visible only to
  // a read made on that transaction, so finding it proves the reader reads on the client it is
  // handed.
  it("reads on the client it is handed: an address written in the caller's own transaction is found before any commit", async () => {
    const rollBack = new Error("roll back");
    let id = "";
    let seen: Awaited<ReturnType<typeof readShipToAddress>> | undefined;
    await expect(prisma.$transaction(async (tx) => {
      const customer = await tx.customer.create({ data: { code: "SHIPTO-484", name: "Ship-to Customer" } });
      const address = await tx.customerAddress.create({ data: { customerId: customer.id, kind: "SHIP_TO", ...DOCK_7 } });
      id = address.id;
      seen = await readShipToAddress(tx, address.id);
      throw rollBack;
    })).rejects.toBe(rollBack);

    expect(seen).toEqual(DOCK_7);
    // Nothing was committed, so nothing but the transaction itself could have shown that row.
    expect(await readShipToAddress(prisma, id)).toBeNull();
  });

  // The reader's client is an argument, so a call on a transaction's client compiles, and so does
  // one written into a read that runs inside the mutators' and the prints' transactions; the
  // interception case in tests/shipper-routes.test.ts watches the PATCH's request alone. So it is
  // pinned from the source, parsed (#188): one call, in `shipperResponse`, on the top-level
  // `prisma`; and the direct text of `DETAIL_INCLUDE`, `readShipperDetail` and `toDetail`, which run
  // at the tail of every shipment mutator's transaction and inside both print transactions, does
  // not name `shipToAddress`, nor do the two functions' bodies name `customerAddress`.
  // `shipToAddressId`, the shipment's own column, stays allowed in them. Only that text is read: a
  // spread into the include's literal, or a helper either function calls, is not followed.
  it("is called once, by shipperResponse on the top-level client, and the direct text of DETAIL_INCLUDE, readShipperDetail and toDetail does not name the shipToAddress relation", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const files = readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" })
      .filter((rel) => (rel.endsWith(".ts") || rel.endsWith(".tsx")) && !rel.endsWith(".d.ts"))
      .map((rel) => `src/${rel.split(sep).join("/")}`);
    const parse = (file: string): ts.SourceFile => ts.createSourceFile(
      file, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest, /* setParentNodes */ true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const all = <T extends ts.Node>(node: ts.Node, is: (n: ts.Node) => n is T): T[] => {
      const out: T[] = [];
      const walk = (n: ts.Node): void => { if (is(n)) out.push(n); ts.forEachChild(n, walk); };
      walk(node);
      return out;
    };
    const named = (name: string) => (n: ts.Node): n is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(n) && n.name?.text === name;
    const isCallOf = (name: string) => (n: ts.Node): n is ts.CallExpression =>
      ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name;

    const parsed = files.map((file) => ({ file, source: parse(file) }));
    // Not vacuous: the walk found the tree, and the reader declared once, in shippers.ts.
    expect(parsed.map((p) => p.file)).toEqual(expect.arrayContaining(["src/server/shippers.ts", "src/app/api/shippers/response.ts"]));
    expect(parsed.flatMap((p) => all(p.source, named("readShipToAddress")).map(() => p.file)))
      .toEqual(["src/server/shippers.ts"]);

    const calls = parsed.flatMap((p) => all(p.source, isCallOf("readShipToAddress")).map((call) => ({ ...p, call })));
    expect(calls.map((c) => c.file)).toEqual(["src/app/api/shippers/response.ts"]);
    const [{ call, source }] = calls;
    // Its nearest enclosing function is `shipperResponse` itself, not a callback inside it.
    let enclosing: ts.Node | undefined = call.parent;
    while (enclosing !== undefined && !ts.isFunctionLike(enclosing)) enclosing = enclosing.parent;
    expect(enclosing !== undefined && ts.isFunctionDeclaration(enclosing) && enclosing.name?.text).toBe("shipperResponse");
    const first = call.arguments[0];
    expect(first !== undefined && ts.isIdentifier(first) && first.text).toBe("prisma");
    // And `prisma` there is the top-level client: imported under that name from the db module, and
    // declared nowhere inside the function.
    const prismaImports = all(source, ts.isImportDeclaration)
      .filter((d) => ts.isStringLiteral(d.moduleSpecifier) && d.moduleSpecifier.text === "@/server/db")
      .flatMap((d) => {
        const bindings = d.importClause?.namedBindings;
        return bindings !== undefined && ts.isNamedImports(bindings) ? [...bindings.elements] : [];
      })
      .filter((e) => e.name.text === "prisma");
    expect(prismaImports.map((e) => e.propertyName?.getText(source) ?? e.name.text)).toEqual(["prisma"]);
    expect(all(enclosing!, (n): n is ts.NamedDeclaration => (ts.isVariableDeclaration(n) || ts.isParameter(n))
      && n.name !== undefined && ts.isIdentifier(n.name) && n.name.text === "prisma")).toHaveLength(0);

    const shippers = parsed.find((p) => p.file === "src/server/shippers.ts")!.source;
    // Identifiers and string literals both, so `db["customerAddress"]` is seen as well.
    const words = (node: ts.Node): string[] => all(node, (n): n is ts.Identifier | ts.StringLiteral =>
      ts.isIdentifier(n) || ts.isStringLiteral(n)).map((n) => n.text);

    const includes = all(shippers, (n): n is ts.VariableDeclaration =>
      ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "DETAIL_INCLUDE");
    expect(includes).toHaveLength(1);
    let init: ts.Expression | undefined = includes[0].initializer;
    while (init !== undefined && (ts.isSatisfiesExpression(init) || ts.isAsExpression(init) || ts.isParenthesizedExpression(init))) {
      init = init.expression;
    }
    expect(init !== undefined && ts.isObjectLiteralExpression(init)).toBe(true);
    const propertyNames = all(init!, ts.isPropertyAssignment).map((p) => p.name.getText(shippers))
      .concat(all(init!, ts.isShorthandPropertyAssignment).map((p) => p.name.text));
    // Not vacuous: the walk reads the include's relations.
    expect(propertyNames).toEqual(expect.arrayContaining(["customer", "reversedBy", "orders"]));
    expect(propertyNames).not.toContain("shipToAddress");
    expect(words(init!)).not.toContain("shipToAddress");

    for (const name of ["readShipperDetail", "toDetail"]) {
      const declarations = all(shippers, named(name));
      expect(declarations).toHaveLength(1);
      const inBody = words(declarations[0].body!);
      expect(inBody).not.toContain("customerAddress");
      expect(inBody).not.toContain("shipToAddress");
    }
    // Not vacuous: the walk sees property names, the shipment's own column among them.
    expect(words(all(shippers, named("toDetail"))[0].body!)).toContain("shipToAddressId");
  });
});

/** One order's lines in a shipper history snapshot, cut to quantity and close-short flag. The
 *  order is found by its id, never by its place on the shipment. */
function snapshotLines(snapshot: unknown, orderId: string): { qty: number; lineComplete: boolean }[] {
  const orders = (snapshot as { orders: { orderId: string; lines: { qty: number; lineComplete: boolean }[] }[] }).orders;
  return orders.find((o) => o.orderId === orderId)!.lines.map((l) => ({ qty: l.qty, lineComplete: l.lineComplete }));
}

describe("replaceShipperLines", () => {
  it("replaces the line grid for one order", async () => {
    const { shipper, orderA } = await oneOrderShipment();
    const so = shipper.orders[0];
    const after = await replaceShipperLines(shipper.id, so.id, [
      { orderLineId: orderA.lines[0].id, qty: 3, weight: 7.5, lineComplete: true },
    ]);
    expect(after.orders[0].lines[0]).toMatchObject({ qty: 3, weight: 7.5, lineComplete: true });
  });

  it("refuses a line that does not belong to this order", async () => {
    const { shipper } = await oneOrderShipment();
    const { order: other } = await savedOrder();
    const so = shipper.orders[0];
    await expect(replaceShipperLines(shipper.id, so.id, [
      { orderLineId: other.lines[0].id, qty: 1, weight: 1, lineComplete: false },
    ])).rejects.toThrow(/does not belong/i);
  });

  it("refuses a duplicate line within the replacement set, naming it", async () => {
    const { shipper, orderA } = await oneOrderShipment();
    const so = shipper.orders[0];
    const line = { orderLineId: orderA.lines[0].id, qty: 1, weight: 1, lineComplete: false };
    await expect(replaceShipperLines(shipper.id, so.id, [line, { ...line }]))
      .rejects.toThrow(/line 1.*listed twice/i);
  });

  // Coordinator review (this task): spec §4.2's "at least one line with qty > 0 across all its
  // orders" is a DOCUMENT-level invariant, not a per-line one — a single zeroed line (`qty: 0`,
  // `lineComplete: true`) stays legal ON ITS OWN ("close the line"), but a shipment where EVERY
  // line across EVERY order is zero is a document about nothing.
  it("refuses zeroing a shipment's only line across all its orders", async () => {
    const { shipper, orderA } = await oneOrderShipment();
    const so = shipper.orders[0];
    await expect(replaceShipperLines(shipper.id, so.id, [
      { orderLineId: orderA.lines[0].id, qty: 0, weight: 0, lineComplete: true },
    ])).rejects.toThrow(/at least one line/i);
  });

  it("allows zeroing one order's lines when another order on the shipment still ships something", async () => {
    const { shipper, second, orders } = await twoOrderShipment();
    const orderB = orders[1];
    const save = replaceShipperLines(shipper.id, second.id, [
      { orderLineId: orderB.lines[0].id, qty: 0, weight: 0, lineComplete: true },
    ]);
    await expect(save).resolves.toBeTruthy();
    const after = await save;

    // Nothing of orderB's line ships elsewhere, so the zero-quantity row is short: its tick is stored.
    expect(after.orders.find((o) => o.orderId === orderB.id)!.lines).toMatchObject([{ qty: 0, lineComplete: true }]);
    expect((await prisma.shipperLine.findMany({ where: { shipperOrderId: second.id }, select: { lineComplete: true } }))
      .map((l) => l.lineComplete)).toEqual([true]);
    // 10 of 10 before the save, closed short after it: a zero-quantity row is still a live shipment.
    expect((await getOrder(orderB.id)).status).toBe("SHIPPED");

    // The replace's entry is the only one after the create's: recompute clears no close short here.
    const entries = await readAudit("shipper", shipper.id); // newest first
    expect(entries.map((e) => [e.action, e.reason])).toEqual([["update", null], ["create", null]]);
    expect(snapshotLines(entries[0].before, orderB.id)).toEqual([{ qty: 10, lineComplete: false }]);
    expect(snapshotLines(entries[0].after, orderB.id)).toEqual([{ qty: 0, lineComplete: true }]);
  });

  // Step 7: over-ship still warns, never blocks. `replaceShipperLines` itself returns a bare
  // `ShipperDetail` (task-9-brief.md's own literal interface) — `overshipWarnings` is the small,
  // additional pure export that derives the warning straight off that detail's own
  // shippedToDateQty/orderedQty fields (see its doc comment in shippers.ts), so a caller does not
  // need a second `shippedTotals` read to report it.
  it("allows shipping over the remaining quantity, and the warning surfaces via overshipWarnings", async () => {
    const { shipper, orderA } = await oneOrderShipment(); // 10 qty / 5.00 weight ordered
    const so = shipper.orders[0];
    const after = await replaceShipperLines(shipper.id, so.id, [
      { orderLineId: orderA.lines[0].id, qty: 999, weight: 999, lineComplete: false },
    ]);
    expect(after.orders[0].lines[0].qty).toBe(999); // the save still succeeds
    // The whole sentence. Each weight is as the server prints it. The two `\d+` are the fixture's.
    expect(overshipWarnings(after)).toContainEqual(expect.stringMatching(
      /^Order #\d+ line 1 \(SP-\d+\): shipped-to-date 999 \/ \S+ lb exceeds the 10 \/ \S+ lb ordered$/));
  });

  // #508: the shipped-to-date sentence prints the screens' figures (commas, two decimals).
  it("prints the shipped-to-date warning's figures grouped with two decimals", async () => {
    const { shipper, orderA } = await oneOrderShipment(); // 10 qty / 5.00 weight ordered
    const after = await replaceShipperLines(shipper.id, shipper.orders[0].id, [
      { orderLineId: orderA.lines[0].id, qty: 1500, weight: 1234.5, lineComplete: false },
    ]);
    expect(overshipWarnings(after)).toEqual([
      `Order #${orderA.orderNumber} line 1 (${after.orders[0].lines[0].partNumber}): shipped-to-date ` +
      "1,500 / 1,234.50 lb exceeds the 10 / 5.00 lb ordered",
    ]);
  });

  it("does not warn when shipped-to-date equals the ordered weight to the cent", async () => {
    const { shipper, orderA } = await oneOrderShipment(); // 10 qty / 5.00 weight ordered
    const after = await replaceShipperLines(shipper.id, shipper.orders[0].id, [
      { orderLineId: orderA.lines[0].id, qty: 10, weight: 5, lineComplete: false },
    ]);
    expect(overshipWarnings(after)).toEqual([]);
  });

  it("does not warn when shipped-to-date stays within what was ordered", async () => {
    const { shipper, orderA } = await oneOrderShipment();
    const so = shipper.orders[0];
    const after = await replaceShipperLines(shipper.id, so.id, [
      { orderLineId: orderA.lines[0].id, qty: 4, weight: 4, lineComplete: false },
    ]);
    expect(overshipWarnings(after)).toEqual([]);
  });
});

// Final review 2026-10-06: the close-short flag is normalised where it is STORED. A tick on a row
// that finishes its line by quantity is stored unticked; the quantity on OTHER live shipments counts
// and this shipment's own rows, which the replace deletes, do not count twice.
describe("replaceShipperLines stores the close-short flag only on a row that ships short", () => {
  const storedFlag = async (shipperOrderId: string) =>
    (await prisma.shipperLine.findFirstOrThrow({ where: { shipperOrderId }, select: { lineComplete: true } }))
      .lineComplete;

  it("stores a ticked row unticked when it ships the full ordered quantity", async () => {
    const { shipper, orderA } = await oneOrderShipment(); // 10 ordered
    const so = shipper.orders[0];
    const after = await replaceShipperLines(shipper.id, so.id, [
      { orderLineId: orderA.lines[0].id, qty: 10, weight: 5, lineComplete: true },
    ]);
    expect(after.orders[0].lines[0].lineComplete).toBe(false);
    expect(await storedFlag(so.id)).toBe(false);
    expect((await getOrder(orderA.id)).status).toBe("SHIPPED"); // complete by quantity alone

    // The audit entry records what was stored, not what was sent. A tick stored on this row would
    // be cleared in the same transaction by `clearSupersededCloseShorts`, under an entry of its own,
    // and the flag, the detail and the status above would read the same: the entries are listed
    // whole, so the replace's own entry is the one read.
    const entries = await readAudit("shipper", shipper.id); // newest first
    expect(entries.map((e) => [e.action, e.reason])).toEqual([["update", null], ["create", null]]);
    expect(snapshotLines(entries[0].after, orderA.id)).toEqual([{ qty: 10, lineComplete: false }]);
  });

  it("keeps a ticked row ticked when it ships short", async () => {
    // The shipment's own saved row is 10 of 10. Counted again beside the new 9 it would read 19
    // and the tick would be dropped: this is the own-rows-not-double-counted proof.
    const { shipper, orderA } = await oneOrderShipment();
    const so = shipper.orders[0];
    await replaceShipperLines(shipper.id, so.id, [
      { orderLineId: orderA.lines[0].id, qty: 9, weight: 4.5, lineComplete: true },
    ]);
    expect(await storedFlag(so.id)).toBe(true);
    expect((await getOrder(orderA.id)).status).toBe("SHIPPED"); // closed short

    const entries = await readAudit("shipper", shipper.id); // newest first
    expect(entries.map((e) => [e.action, e.reason])).toEqual([["update", null], ["create", null]]);
    expect(snapshotLines(entries[0].before, orderA.id)).toEqual([{ qty: 10, lineComplete: false }]);
    expect(snapshotLines(entries[0].after, orderA.id)).toEqual([{ qty: 9, lineComplete: true }]);
  });

  it("stores a second shipment's ticked row unticked when it brings the line to its ordered quantity", async () => {
    const { order } = await savedOrder({ qty: 10 });
    const line = order.lines[0];
    const ship = (qty: number) => createShipper({
      customerId: order.customerId, shipDate: "2026-08-04",
      orders: [{ orderId: order.id, lines: [{ orderLineId: line.id, qty, weight: qty, lineComplete: false }], containers: [], serials: [] }],
    }, { canOverrideCreditHold: false });
    await ship(4);
    const { shipper: second } = await ship(1);
    const so = second.orders[0];

    // 4 elsewhere + 5 here = 9 of 10: still short, the tick stays.
    await replaceShipperLines(second.id, so.id, [{ orderLineId: line.id, qty: 5, weight: 5, lineComplete: true }]);
    expect(await storedFlag(so.id)).toBe(true);

    // 4 elsewhere + 6 here = 10 of 10: the other shipment is counted, the tick is dropped. This
    // shipment's own saved 5 is not counted with it (4 + 5 + 6 would also read complete, so the
    // short case above is what rules out double counting; this one rules out ignoring the 4).
    await replaceShipperLines(second.id, so.id, [{ orderLineId: line.id, qty: 6, weight: 6, lineComplete: true }]);
    expect(await storedFlag(so.id)).toBe(false);
    expect((await getOrder(order.id)).status).toBe("SHIPPED");
  });
});

describe("replaceShipperContainers", () => {
  it("replaces the container grid for one order", async () => {
    const { shipper, orderA } = await oneOrderShipment();
    const containerType = await prisma.containerType.create({ data: { name: "Basket" } });
    const container = await prisma.orderContainer.create({
      data: { orderId: orderA.id, position: 1, typeId: containerType.id, count: 2 },
    });
    const so = shipper.orders[0];
    const after = await replaceShipperContainers(shipper.id, so.id, [{ orderContainerId: container.id, count: 2 }]);
    expect(after.orders[0].containers[0]).toMatchObject({ typeName: "Basket", count: 2 });
  });

  it("refuses a container that does not belong to this order", async () => {
    const { shipper } = await oneOrderShipment();
    const { order: other } = await savedOrder();
    const containerType = await prisma.containerType.create({ data: { name: "Basket" } });
    const container = await prisma.orderContainer.create({
      data: { orderId: other.id, position: 1, typeId: containerType.id, count: 2 },
    });
    const so = shipper.orders[0];
    await expect(replaceShipperContainers(shipper.id, so.id, [{ orderContainerId: container.id, count: 1 }]))
      .rejects.toThrow(/does not belong/i);
  });
});

// Weights design §12.2 (owner ruling W2 of 2026-10-09, and the answers of 2026-10-10). Both saves
// store the tare each a container row carries, a null as none. A row sent with no `tareEach` key
// keeps what the shipment holds for it, and takes the order row's figure only when it is new to
// the shipment.
describe("a shipment container row's tare each: both saves store the figure a row carries, and Save containers keeps the shipment's", () => {
  /** A saved one-order shipment with no container rows, and three container rows on its order:
   *  tare each 42.50, tare each 0, and none. The type's default is 99.00 on purpose and matches no
   *  row: a figure copied from the type, or a missing figure filled from it, would show. */
  async function shipmentAndThreeOrderRows() {
    const { shipper, orderA } = await oneOrderShipment();
    const basket = await prisma.containerType.create({ data: { name: "Basket", tareEach: "99.00" } });
    const withTare = await prisma.orderContainer.create({
      data: { orderId: orderA.id, position: 1, typeId: basket.id, count: 3, tareEach: "42.50" },
    });
    const zeroTare = await prisma.orderContainer.create({
      data: { orderId: orderA.id, position: 2, typeId: basket.id, count: 2, tareEach: "0" },
    });
    const noTare = await prisma.orderContainer.create({
      data: { orderId: orderA.id, position: 3, typeId: basket.id, count: 1 },
    });
    return { shipper, so: shipper.orders[0], withTare, zeroTare, noTare };
  }

  it("a row new to the shipment, sent with no tareEach key, takes the order row's figure: a zero is kept and a missing figure stays empty", async () => {
    const { shipper, so, withTare, zeroTare, noTare } = await shipmentAndThreeOrderRows();
    await replaceShipperContainers(shipper.id, so.id, [
      { orderContainerId: withTare.id, count: 3 },
      { orderContainerId: zeroTare.id, count: 2 },
      { orderContainerId: noTare.id, count: 1 },
    ]);
    expect(await storedTareEach(so.id)).toEqual(["42.50", "0.00", null]);
  });

  // Was "refuses a figure sent with a container row: no request sets it yet". The key is taken
  // now, so the case holds what is stored for it. No figure sent is its order row's.
  it("stores the figure each row carries, a null as none: on rows new to the shipment from a bare list, then on rows it holds from the new body", async () => {
    const { shipper, so, withTare, zeroTare, noTare } = await shipmentAndThreeOrderRows();
    await replaceShipperContainers(shipper.id, so.id, [
      { orderContainerId: withTare.id, count: 3, tareEach: null },
      { orderContainerId: zeroTare.id, count: 2, tareEach: "12.5" },
      { orderContainerId: noTare.id, count: 1, tareEach: 7.25 },
    ]);
    expect(await storedTareEach(so.id)).toEqual([null, "12.50", "7.25"]);

    await replaceShipperContainers(shipper.id, so.id, { containers: [
      { orderContainerId: withTare.id, count: 3, tareEach: 0 },
      { orderContainerId: zeroTare.id, count: 2, tareEach: null },
      { orderContainerId: noTare.id, count: 1, tareEach: "310" },
    ] });
    expect(await storedTareEach(so.id)).toEqual(["0.00", null, "310.00"]);
  });

  // The other door. Was "refuses a figure sent with a container row of a new shipment too". A new
  // shipment's save takes its container rows through the same item shape, and this case holds the
  // key taken there too, should the two shapes ever part.
  it("a new shipment's save stores the figure a row carries too, and not the order row's", async () => {
    const { order } = await savedOrder({ qty: 10 });
    const basket = await prisma.containerType.create({ data: { name: "Basket", tareEach: "99.00" } });
    const row = await prisma.orderContainer.create({
      data: { orderId: order.id, position: 1, typeId: basket.id, count: 3, tareEach: "42.50" },
    });
    const { shipper } = await createShipper({
      ...oneOrderInput(order),
      orders: [{ ...orderInput(order), containers: [{ orderContainerId: row.id, count: 3, tareEach: "7.25" }] }],
    }, { canOverrideCreditHold: false });
    expect(await storedTareEach(shipper.orders[0].id)).toEqual(["7.25"]);
  });

  it("a row sent with no tareEach key keeps the shipment's figure, on a bare list and on the new body", async () => {
    const { shipper, so, withTare, zeroTare, noTare } = await shipmentAndThreeOrderRows();
    await replaceShipperContainers(shipper.id, so.id, [
      { orderContainerId: withTare.id, count: 3, tareEach: "7.25" },
      { orderContainerId: zeroTare.id, count: 2, tareEach: "12.5" },
      { orderContainerId: noTare.id, count: 1, tareEach: 0 },
    ]);
    // What a tab loaded before this pull request sends: the list, and no figure. Only the first
    // row's number of containers differs.
    await replaceShipperContainers(shipper.id, so.id, [
      { orderContainerId: withTare.id, count: 1 },
      { orderContainerId: zeroTare.id, count: 2 },
      { orderContainerId: noTare.id, count: 1 },
    ]);
    expect(await storedTareEach(so.id)).toEqual(["7.25", "12.50", "0.00"]);

    // The new body, the rows in another order: each figure follows its order row, not its place.
    await replaceShipperContainers(shipper.id, so.id, { containers: [
      { orderContainerId: noTare.id, count: 1 },
      { orderContainerId: withTare.id, count: 1 },
      { orderContainerId: zeroTare.id, count: 2 },
    ] });
    expect(await storedTareEach(so.id)).toEqual(["0.00", "7.25", "12.50"]);
  });

  it("a row the shipment holds with no figure, sent with no key, stays with none whatever its order row holds", async () => {
    const { shipper, so, withTare } = await shipmentAndThreeOrderRows();
    await replaceShipperContainers(shipper.id, so.id, [{ orderContainerId: withTare.id, count: 3, tareEach: null }]);
    await replaceShipperContainers(shipper.id, so.id, [{ orderContainerId: withTare.id, count: 2 }]);
    expect(await storedTareEach(so.id)).toEqual([null]); // the order's row holds 42.50
  });
});

// Weights design §12.2. A kept row is a shipment container row whose order-side row was since
// corrected away. Save containers writes its tare each by the row's own id and renumbers its
// position as before. It writes nothing else of the row and never deletes it.
describe("a kept container row's tare each: Save containers writes it by the row's id", () => {
  /** A two-order shipment. Each order's part holds what `keptAndLinkedRows` gives it: a kept row
   *  (BIN-1, 3 at 42.50) and a linked row (BIN-2, 2 at 55.00). The ids are the first order's,
   *  but for `otherKeptId`, the second order's kept row. */
  async function shipmentWithKeptRows() {
    const { shipper, first, second, orders } = await twoOrderShipment();
    const basket = await prisma.containerType.create({ data: { name: "Basket", tareEach: "99.00" } });
    const mine = await keptAndLinkedRows({
      shipperId: shipper.id, shipperOrderId: first.id, orderId: orders[0].id, typeId: basket.id });
    const others = await keptAndLinkedRows({
      shipperId: shipper.id, shipperOrderId: second.id, orderId: orders[1].id, typeId: basket.id });
    return { shipper, so: first, second, order: orders[0], basket, ...mine, otherKeptId: others.keptId };
  }
  type KeptRows = Awaited<ReturnType<typeof shipmentWithKeptRows>>;

  /** One shipment order's container rows as stored, in position order, without their ids. */
  const storedRows = async (shipperOrderId: string) =>
    (await prisma.shipperContainer.findMany({ where: { shipperOrderId }, orderBy: { position: "asc" } }))
      .map((row) => ({
        kept: row.orderContainerId === null, position: row.position, count: row.count, typeName: row.typeName,
        customerContainerId: row.customerContainerId, tareEach: row.tareEach === null ? null : row.tareEach.toFixed(2),
      }));

  it("writes the figure a kept row is named with, and leaves the rest of the row as it was", async () => {
    const { shipper, so, keptId, orderRowId } = await shipmentWithKeptRows();
    await replaceShipperContainers(shipper.id, so.id, {
      containers: [{ orderContainerId: orderRowId, count: 2 }], kept: [{ id: keptId, tareEach: "7.75" }],
    });
    expect(await storedRows(so.id)).toEqual([
      { kept: true, position: 1, count: 3, typeName: "Basket", customerContainerId: "BIN-1", tareEach: "7.75" },
      { kept: false, position: 2, count: 2, typeName: "Basket", customerContainerId: "BIN-2", tareEach: "55.00" },
    ]);
  });

  // Each body drops the linked row, so the kept row is the one row left.
  it.each<[string, string | null, (rows: KeptRows) => unknown]>([
    ["named with no tareEach key", "42.50", (rows) => ({ containers: [], kept: [{ id: rows.keptId }] })],
    ["not named", "42.50", () => ({ containers: [] })],
    ["under a bare list, as an open tab sends", "42.50", () => []],
    ["named with a null", null, (rows) => ({ containers: [], kept: [{ id: rows.keptId, tareEach: null }] })],
    ["named with a zero", "0.00", (rows) => ({ containers: [], kept: [{ id: rows.keptId, tareEach: 0 }] })],
  ])("a kept row %s stays on the shipment and reads %j", async (_how, figure, body) => {
    const rows = await shipmentWithKeptRows();
    await replaceShipperContainers(rows.shipper.id, rows.so.id, body(rows));
    expect(await storedTareEach(rows.so.id)).toEqual([figure]);
  });

  it.each<[string, (rows: KeptRows) => string]>([
    ["an id that is no row", () => "no-such-row"],
    ["a row still linked to an order row", (rows) => rows.linkedId],
    ["another order's kept row on the same shipment", (rows) => rows.otherKeptId],
  ])("refuses %s named as a kept container", async (_what, id) => {
    const rows = await shipmentWithKeptRows();
    await expect(replaceShipperContainers(rows.shipper.id, rows.so.id, {
      containers: [{ orderContainerId: rows.orderRowId, count: 2 }], kept: [{ id: id(rows), tareEach: "7.75" }],
    })).rejects.toMatchObject({
      status: 400, message: `Order #${rows.order.orderNumber}: that kept container is not on this shipment`,
    });
  });

  it("refuses the same kept container named twice, by the type the row itself stored", async () => {
    const rows = await shipmentWithKeptRows();
    // Renamed after the row was kept: the sentence names what the row stored, not the type today.
    await prisma.containerType.update({ where: { id: rows.basket.id }, data: { name: "Tote" } });
    await expect(replaceShipperContainers(rows.shipper.id, rows.so.id, {
      containers: [], kept: [{ id: rows.keptId, tareEach: "7.75" }, { id: rows.keptId, tareEach: "8" }],
    })).rejects.toMatchObject({
      status: 400,
      message: `Order #${rows.order.orderNumber}: kept container "Basket" is listed twice on this shipment`,
    });
  });

  // Weights design §12.2: the `containers` list is checked before `kept`.
  it("a body wrong in both lists is answered with the container's sentence, not the kept row's", async () => {
    const rows = await shipmentWithKeptRows();
    const theirs = await prisma.orderContainer.create({
      data: { orderId: rows.second.orderId, position: 2, typeId: rows.basket.id, count: 1 },
    });
    await expect(replaceShipperContainers(rows.shipper.id, rows.so.id, {
      containers: [{ orderContainerId: theirs.id, count: 1 }], kept: [{ id: "no-such-row", tareEach: "7.75" }],
    })).rejects.toMatchObject({
      status: 400, message: `Order #${rows.order.orderNumber}: that container does not belong to this order`,
    });
  });

  it("one history entry carries the save: a kept row's tare each and a linked row's, before and after", async () => {
    const { shipper, so, keptId, orderRowId } = await shipmentWithKeptRows();
    await replaceShipperContainers(shipper.id, so.id, {
      containers: [{ orderContainerId: orderRowId, count: 2, tareEach: "12.25" }],
      kept: [{ id: keptId, tareEach: "7.75" }],
    });
    const [entry] = await readAudit("shipper", shipper.id); // newest first
    const figures = (snapshot: unknown) =>
      (snapshot as { orders: { containers: { tareEach: string | null }[] }[] }).orders[0].containers.map((c) => c.tareEach);
    // As the audit layer writes a stored figure in an update entry: text, with no trailing zero.
    expect([entry.action, figures(entry.before), figures(entry.after)])
      .toEqual(["update", ["42.5", "55"], ["7.75", "12.25"]]);
  });

  it("removing an order drops that order's container rows, its kept row with its tare each included, and no other order's", async () => {
    const { shipper, so, second } = await shipmentWithKeptRows();
    await removeOrderFromShipper(shipper.id, so.id);
    expect(await storedTareEach(second.id)).toEqual(["42.50", "55.00"]);
  });
});

// The request shapes of `shippers.ts` that carry a container row's tare each are strict: a
// container row (`SHIP_CONTAINER`, one shape at both doors), an entry of `kept` (`KEPT_CONTAINER`)
// and the body of Save containers that holds both lists (`REPLACE_CONTAINERS`). A key a shape does
// not name is refused, with zod's code for it and the place of the object that holds it.
describe("a shipment container row's tare each: each request shape refuses a key it does not name", () => {
  /** A one-order shipment whose part holds what `keptAndLinkedRows` gives it: a kept row (3 at
   *  42.50) and a linked row (2 at 55.00). */
  async function shipmentWithBothRows() {
    const { shipper, orderA } = await oneOrderShipment();
    const so = shipper.orders[0];
    const basket = await prisma.containerType.create({ data: { name: "Basket" } });
    const rows = await keptAndLinkedRows({
      shipperId: shipper.id, shipperOrderId: so.id, orderId: orderA.id, typeId: basket.id });
    return { shipper, so, ...rows };
  }
  type BothRows = Awaited<ReturnType<typeof shipmentWithBothRows>>;

  // Each body names the fixture's own rows and carries one key its shape does not name:
  // `tareeach`, or `kep`. Each also carries, under a key its shape does name, a figure that differs
  // from the stored one, so a save that went through with the unknown key dropped would show in the
  // read below. The bare list has no `kept` to carry one, so its row carries it, with another
  // number of containers.
  it.each<[string, string, (string | number)[], (rows: BothRows) => unknown]>([
    ["on a row of a bare list", "tareeach", [0],
      (rows) => [{ orderContainerId: rows.orderRowId, count: 5, tareEach: "7.75", tareeach: "9.5" }]],
    ["on a row of the new body", "tareeach", ["containers", 0], (rows) => ({
      containers: [{ orderContainerId: rows.orderRowId, count: 2, tareeach: "7.75" }],
      kept: [{ id: rows.keptId, tareEach: "3.05" }],
    })],
    ["on an entry of kept", "tareeach", ["kept", 0], (rows) => ({
      containers: [{ orderContainerId: rows.orderRowId, count: 2, tareEach: "7.75" }],
      kept: [{ id: rows.keptId, tareeach: "3.05" }],
    })],
    ["beside containers and kept at the top of the body", "kep", [], (rows) => ({
      containers: [{ orderContainerId: rows.orderRowId, count: 2, tareEach: "7.75" }],
      kept: [], kep: [{ id: rows.keptId, tareEach: "3.05" }],
    })],
  ])("Save containers refuses a key %s, and writes nothing", async (_where, key, path, body) => {
    const rows = await shipmentWithBothRows();
    await expect(replaceShipperContainers(rows.shipper.id, rows.so.id, body(rows)))
      .rejects.toMatchObject({ issues: [{ code: "unrecognized_keys", keys: [key], path }] });
    expect(await storedTareEach(rows.so.id)).toEqual(["42.50", "55.00"]);
  });

  it("a new shipment's save refuses a key on a container row, and writes nothing", async () => {
    const { order } = await savedOrder({ qty: 10 });
    const basket = await prisma.containerType.create({ data: { name: "Basket" } });
    const row = await prisma.orderContainer.create({
      data: { orderId: order.id, position: 1, typeId: basket.id, count: 3, tareEach: "42.50" },
    });
    await expect(createShipper({
      ...oneOrderInput(order),
      orders: [{ ...orderInput(order), containers: [{ orderContainerId: row.id, count: 3, tareeach: "7.25" }] }],
    }, { canOverrideCreditHold: false })).rejects.toMatchObject({
      issues: [{ code: "unrecognized_keys", keys: ["tareeach"], path: ["orders", 0, "containers", 0] }],
    });
    expect(await prisma.shipper.count()).toBe(0);
  });
});

// Weights design §12.2: the shipment's other writers. Each one named here leaves a typed tare each
// on its row, and a reversal is given no container row. One of them does write container rows:
// removing an order deletes the removed order's, so its case removes the other order.
describe("a typed tare each and the shipment's other writers", () => {
  /** A two-order shipment whose first order holds one container row with a typed 12.25, while its
   *  order's row holds 42.50. `spare` is a third order of the customer, on no shipment. */
  async function typedShipment() {
    const { shipper, first, second, customer, orders } = await twoOrderShipment();
    const basket = await prisma.containerType.create({ data: { name: "Basket" } });
    const row = await prisma.orderContainer.create({
      data: { orderId: orders[0].id, position: 1, typeId: basket.id, count: 3, tareEach: "42.50" },
    });
    await replaceShipperContainers(shipper.id, first.id, [{ orderContainerId: row.id, count: 3, tareEach: "12.25" }]);
    return { shipper, first, second, orders, spare: await orderForCustomer(customer) };
  }
  type Typed = Awaited<ReturnType<typeof typedShipment>>;

  it.each<[string, (t: Typed) => Promise<unknown>]>([
    ["a Lines save", (t) => replaceShipperLines(t.shipper.id, t.first.id, [
      { orderLineId: t.orders[0].lines[0].id, qty: 1, weight: 1, lineComplete: false }])],
    ["a Serials save", (t) => replaceShipperSerials(t.shipper.id, t.first.id, [])],
    ["a header edit", (t) => updateShipper(t.shipper.id, { route: "North" })],
    ["another order added", (t) => addOrderToShipper(t.shipper.id, t.spare.id)],
    ["another order removed", (t) => removeOrderFromShipper(t.shipper.id, t.second.id)],
    ["a void", (t) => asSystem(() => voidShipper(t.shipper.id, "wrong truck"))],
  ])("%s leaves the figure on its row", async (_writer, write) => {
    const t = await typedShipment();
    await write(t);
    expect(await storedTareEach(t.first.id)).toEqual(["12.25"]);
  });

  it("a reversal has no container row, and the shipment it reverses keeps its figure", async () => {
    const t = await typedShipment();
    const { shipper: reversal } = await asSystem(() => reverseShipper(t.shipper.id, { reason: "wrong parts loaded" }));
    expect({
      reversal: await prisma.shipperContainer.count({ where: { shipperOrder: { shipperId: reversal.id } } }),
      original: await storedTareEach(t.first.id),
    }).toEqual({ reversal: 0, original: ["12.25"] });
  });
});

describe("replaceShipperSerials", () => {
  it("replaces the serial grid for one order", async () => {
    const { shipper, orderA } = await oneOrderShipment();
    const serial = await prisma.orderSerial.create({
      data: { orderId: orderA.id, lineId: orderA.lines[0].id, position: 1, serial: "S-1", description: "Heat 1" },
    });
    const so = shipper.orders[0];
    const after = await replaceShipperSerials(shipper.id, so.id, [{ orderSerialId: serial.id, printOnShipper: false }]);
    expect(after.orders[0].serials[0]).toMatchObject({ serial: "S-1", printOnShipper: false });
  });

  it("refuses a serial that does not belong to this order", async () => {
    const { shipper } = await oneOrderShipment();
    const { order: other } = await savedOrder();
    const serial = await prisma.orderSerial.create({
      data: { orderId: other.id, lineId: other.lines[0].id, position: 1, serial: "S-2", description: "" },
    });
    const so = shipper.orders[0];
    await expect(replaceShipperSerials(shipper.id, so.id, [{ orderSerialId: serial.id }]))
      .rejects.toThrow(/does not belong/i);
  });
});

describe("updateShipper", () => {
  it("patches header fields, leaving the rest untouched", async () => {
    const { shipper } = await oneOrderShipment();
    const carrier = await prisma.carrier.create({ data: { name: "ACME Freight" } });
    const after = await updateShipper(shipper.id, { carrierId: carrier.id, route: "I-80 west", proNumber: "PRO-1" });
    expect(after.carrierName).toBe("ACME Freight");
    expect(after.route).toBe("I-80 west");
    expect(after.proNumber).toBe("PRO-1");
    expect(after.comments).toBe(shipper.comments); // untouched
  });

  it("refuses a ship-to address that does not belong to this customer", async () => {
    const { shipper } = await oneOrderShipment();
    const { customer: other } = await savedOrder();
    const addr = await prisma.customerAddress.create({ data: { customerId: other.id, kind: "SHIP_TO", name: "Dock 1" } });
    await expect(updateShipper(shipper.id, { shipToAddressId: addr.id })).rejects.toThrow(/ship-to address/i);
  });

  it("404s on missing or voided shipments", async () => {
    await expect(updateShipper("nope", { route: "x" })).rejects.toThrow(/not found/i);
    const { shipper } = await oneOrderShipment();
    await prisma.shipper.update({ where: { id: shipper.id }, data: { deletedAt: new Date() } });
    await expect(updateShipper(shipper.id, { route: "x" })).rejects.toThrow(/not found/i);
  });

  it("refuses an unknown carrierId", async () => {
    const { shipper } = await oneOrderShipment();
    await expect(updateShipper(shipper.id, { carrierId: "nope" })).rejects.toThrow(/carrier/i);
  });

  // Step 5b (carried from Task 8's review): `updateShipper` is `SNAPSHOT_INCLUDE.shipper`'s FIRST
  // real consumer — `auditedCreate` writes a hand-built payload and never reads the include.
  // Assert the snapshot's actual CONTENT: the customer by CODE, the carrier and ship-to by NAME —
  // raw cuids in a history diff are the unreadable-history shape issue #24 exists to prevent.
  it("the update audit snapshot names the customer by code and the carrier/ship-to by name", async () => {
    const { shipper, customer } = await oneOrderShipment();
    const carrier = await prisma.carrier.create({ data: { name: "ACME Freight" } });
    const address = await prisma.customerAddress.create({ data: { customerId: customer.id, kind: "SHIP_TO", name: "Dock 4" } });

    await updateShipper(shipper.id, { carrierId: carrier.id, shipToAddressId: address.id, route: "I-80 west" });

    const [entry] = await readAudit("shipper", shipper.id); // newest first
    expect(entry.action).toBe("update");
    const after = entry.after as { customer?: { code?: string }; carrier?: { name?: string }; shipToAddress?: { name?: string } };
    expect(after.customer?.code).toBe(customer.code);
    expect(after.carrier?.name).toBe("ACME Freight");
    expect(after.shipToAddress?.name).toBe("Dock 4");
  });
});

describe("listShippers / exportShippers / shipmentsForOrder", () => {
  it("filters by customer, search term and includeVoided", async () => {
    const { shipper: a, customer: customerA } = await oneOrderShipment();
    const { shipper: b } = await oneOrderShipment();
    await prisma.shipper.update({ where: { id: b.id }, data: { deletedAt: new Date() } });

    const byCustomer = await listShippers({ customerId: customerA.id });
    expect(byCustomer.map((r) => r.id)).toEqual([a.id]);

    const bySearch = await listShippers({ search: customerA.code });
    expect(bySearch.map((r) => r.id)).toEqual([a.id]);

    const withoutVoided = await listShippers({});
    expect(withoutVoided.map((r) => r.id)).not.toContain(b.id);

    const withVoided = await listShippers({ includeVoided: true });
    expect(withVoided.map((r) => r.id)).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it("reports order labels, count and totals", async () => {
    const { shipper } = await oneOrderShipment(); // ships its one line in full: qty 10 / weight 5.00
    const [row] = await listShippers({});
    expect(row.orderCount).toBe(1);
    expect(row.orderLabels).toEqual(shipper.orders.map((o) => o.label));
    expect(row.totalQty).toBe(10);
    expect(row.totalWeight).toBe(5);
  });

  it("orders a multi-order shipment's labels by print position, not scan order", async () => {
    const { shipper } = await twoOrderShipment();
    const [row] = await listShippers({});
    expect(row.orderLabels).toEqual(shipper.orders.map((o) => o.label));
    expect(row.orderCount).toBe(2);
  });

  it("exportShippers writes its own headers on the sheet Shipments, and a shipment's figures under Qty and Net weight (lb)", async () => {
    await oneOrderShipment(); // ships its one line in full: qty 10 / weight 5.00
    const sheet = await readXlsx(await exportShippers({}), "Shipments");
    expect(sheet.row(1)).toEqual([
      "Packing List No", "BOL No", "Customer code", "Customer name", "Ship date", "Orders", "Carrier", "Qty",
      "Net weight (lb)", "Freight amount", "Voided",
    ]);
    // The shipment's own figures sit under Qty and under Net weight (lb).
    expect([sheet.cell(2, 8), sheet.cell(2, 9)]).toEqual([10, 5]);
  });

  it("shipmentsForOrder returns every shipment for that order, voided included", async () => {
    const { shipper, orderA } = await oneOrderShipment();
    await prisma.shipper.update({ where: { id: shipper.id }, data: { deletedAt: new Date() } });
    const rows = await shipmentsForOrder(orderA.id);
    expect(rows.map((r) => r.id)).toEqual([shipper.id]);
    expect(rows[0].deletedAt).not.toBeNull();
  });

  // Task 17 (order hub Shipments section): the hub row shows THIS order's own label (`92036-3`),
  // its own quantities, and whether its lines shipped complete — none of which the shipment-wide
  // totals can answer for a multi-order shipment. The per-order breakdown is additive on
  // `ShipperRow`, in print (position) order like `orderLabels`.
  it("rows carry a per-order breakdown: id, number, sequence, quantities and the complete flag", async () => {
    const { shipper, orders } = await twoOrderShipment();
    const [row] = await shipmentsForOrder(orders[0].id);
    expect(row.orders).toHaveLength(2);
    // Each order shipped its full quantity (10 of 10), so both stand complete with no tick.
    expect(row.orders[0]).toMatchObject({
      orderId: orders[0].id, orderNumber: orders[0].orderNumber, sequence: 1,
      qty: 10, weight: 5, complete: true,
    });
    expect(row.orders[1]).toMatchObject({ orderId: orders[1].id, sequence: 1, complete: true });

    // Cutting the first order's line to 4 of 10 flips ITS flag and only its flag.
    await replaceShipperLines(shipper.id, shipper.orders[0].id, [
      { orderLineId: orders[0].lines[0].id, qty: 4, weight: 5, lineComplete: false },
    ]);
    const [short] = await shipmentsForOrder(orders[0].id);
    expect(short.orders[0].complete).toBe(false);
    expect(short.orders[1].complete).toBe(true);

    // Closing that line short completes it again (the tick, quantity corrections design §3.1).
    await replaceShipperLines(shipper.id, shipper.orders[0].id, [
      { orderLineId: orders[0].lines[0].id, qty: 4, weight: 5, lineComplete: true },
    ]);
    const [closed] = await shipmentsForOrder(orders[0].id);
    expect(closed.orders[0].complete).toBe(true);
    expect(closed.orders[1].complete).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------
// Step 5a (carried from Task 8's review): lock the claim CALL SITE, not concurrency timing —
// timing cannot discriminate ABBA deadlock at this layer (the sorted claim is one statement), so
// what's deterministically testable is that each mutator claims through `claimOrdersInOrder` with
// the full affected id set, as the FIRST lock call. `createShipper` also calls `certs.ts`'s
// `claimOrder` (via `createCert`, for a SHIPMENT-scope cert) — asserted here as "first call comes
// before claimOrder", never "claimOrder is never called".
// -------------------------------------------------------------------------------------------
describe("composition: claim discipline (module-boundary mock)", () => {
  it("createShipper claims through claimOrdersInOrder before certs.ts's claimOrder", async () => {
    const customer = await makeCustomer();
    const part = await makePart(customer.id);
    await prisma.part.update({ where: { id: part.id }, data: { certRequired: true, certScope: "SHIPMENT" } });
    await giveSteps(part.id);
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: part.id, qty: 5, weight: "5.00" }],
    }));

    await createShipper(oneOrderInput(order), { canOverrideCreditHold: false });

    expect(claimOrdersInOrderMock).toHaveBeenCalled();
    expect(claimOrderMock).toHaveBeenCalled(); // createCert's own claim, transitively
    expect(claimOrdersInOrderMock.mock.invocationCallOrder[0])
      .toBeLessThan(claimOrderMock.mock.invocationCallOrder[0]);
    expect(claimOrdersInOrderMock.mock.calls[0][1]).toEqual([order.id]);
  });

  it("updateShipper's first lock call claims every order on the shipment", async () => {
    const { shipper, orders } = await twoOrderShipment();
    claimOrdersInOrderMock.mockClear();
    await updateShipper(shipper.id, { route: "x" });
    expect(claimOrdersInOrderMock.mock.calls[0][1].slice().sort())
      .toEqual(orders.map((o) => o.id).sort());
  });

  it("addOrderToShipper's first lock call claims the existing order plus the new one", async () => {
    const { shipper, orderB } = await shipmentPlusSpareOrder();
    const existingOrderId = shipper.orders[0].orderId;
    claimOrdersInOrderMock.mockClear();
    await addOrderToShipper(shipper.id, orderB.id);
    expect(claimOrdersInOrderMock.mock.calls[0][1].slice().sort())
      .toEqual([existingOrderId, orderB.id].sort());
  });

  it("removeOrderFromShipper's first lock call claims every order on the shipment", async () => {
    const { shipper, orders } = await twoOrderShipment();
    claimOrdersInOrderMock.mockClear();
    await removeOrderFromShipper(shipper.id, shipper.orders[0].id);
    expect(claimOrdersInOrderMock.mock.calls[0][1].slice().sort())
      .toEqual(orders.map((o) => o.id).sort());
  });

  it("replaceShipperLines' first lock call claims every order on the shipment", async () => {
    const { shipper, orders } = await twoOrderShipment();
    claimOrdersInOrderMock.mockClear();
    await replaceShipperLines(shipper.id, shipper.orders[0].id, [
      { orderLineId: orders[0].lines[0].id, qty: 1, weight: 1, lineComplete: false },
    ]);
    expect(claimOrdersInOrderMock.mock.calls[0][1].slice().sort())
      .toEqual(orders.map((o) => o.id).sort());
  });

  it("replaceShipperContainers' first lock call claims every order on the shipment", async () => {
    const { shipper, orders } = await twoOrderShipment();
    claimOrdersInOrderMock.mockClear();
    await replaceShipperContainers(shipper.id, shipper.orders[0].id, []);
    expect(claimOrdersInOrderMock.mock.calls[0][1].slice().sort())
      .toEqual(orders.map((o) => o.id).sort());
  });

  it("replaceShipperSerials' first lock call claims every order on the shipment", async () => {
    const { shipper, orders } = await twoOrderShipment();
    claimOrdersInOrderMock.mockClear();
    await replaceShipperSerials(shipper.id, shipper.orders[0].id, []);
    expect(claimOrdersInOrderMock.mock.calls[0][1].slice().sort())
      .toEqual(orders.map((o) => o.id).sort());
  });
});

// -------------------------------------------------------------------------------------------
// Credit hold gates shipment EXTENSION (owner ruling 2026-08-06, MR !47 round 3): a hold set
// after a shipment exists must not be bypassable by adding orders or replacing lines — the two
// paths that add shipped work. Same §5.4 shape as creation: named + linked refusal;
// override_credit_hold + a reason (recorded in the audit entry) proceeds.
// -------------------------------------------------------------------------------------------
describe("credit hold gates shipment extension", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  async function heldShipmentPlusSpare() {
    const { shipper, orderB } = await shipmentPlusSpareOrder();
    await prisma.customer.update({
      where: { id: (await prisma.shipper.findUniqueOrThrow({ where: { id: shipper.id } })).customerId },
      data: { creditHold: true },
    });
    return { shipper, orderB };
  }

  it("addOrderToShipper refuses on a held customer without the override, naming the customer", async () => {
    const { shipper, orderB } = await heldShipmentPlusSpare();
    await expect(addOrderToShipper(shipper.id, orderB.id)).rejects.toThrow(/credit hold/i);
  });

  it("addOrderToShipper proceeds with the override and records the reason in the audit entry", async () => {
    const { shipper, orderB } = await heldShipmentPlusSpare();
    const after = await addOrderToShipper(shipper.id, orderB.id,
      { canOverrideCreditHold: true }, "owner approved by phone");
    expect(after.orders).toHaveLength(2);
    const [entry] = await readAudit("shipper", shipper.id);
    expect(entry.reason).toBe("owner approved by phone");
  });

  it("addOrderToShipper with the override still requires a reason", async () => {
    const { shipper, orderB } = await heldShipmentPlusSpare();
    await expect(addOrderToShipper(shipper.id, orderB.id, { canOverrideCreditHold: true }))
      .rejects.toThrow(/reason/i);
  });

  it("replaceShipperLines refuses on a held customer without the override", async () => {
    const { shipper } = await heldShipmentPlusSpare();
    const so = shipper.orders[0];
    await expect(replaceShipperLines(shipper.id, so.id,
      [{ orderLineId: so.lines[0].orderLineId!, qty: 9, weight: "9.00", lineComplete: false }]))
      .rejects.toThrow(/credit hold/i);
  });

  it("replaceShipperLines proceeds with the override + reason, recording it", async () => {
    const { shipper } = await heldShipmentPlusSpare();
    const so = shipper.orders[0];
    const after = await replaceShipperLines(shipper.id, so.id, {
      lines: [{ orderLineId: so.lines[0].orderLineId!, qty: 9, weight: "9.00", lineComplete: false }],
      creditHoldReason: "owner approved",
    }, { canOverrideCreditHold: true });
    expect(after.orders[0].lines[0].qty).toBe(9);
    const [entry] = await readAudit("shipper", shipper.id);
    expect(entry.reason).toBe("owner approved");
  });

  // Round-6 finding, the order-locks.ts house rule applied to the hold: `creditHold` lives on
  // the Customer row, which the gate read WITHOUT a claim — a hold committed concurrently (its
  // own transaction touches no claimed row) was invisible, and the extension slipped through
  // un-overridden. The gate now claims the Customer row (always LAST: Orders → Shipper →
  // Customer), so this holder-transaction race is deterministic: the extension must BLOCK on the
  // held customer lock and then refuse — under Serializable the post-commit read raises the
  // honest 40001→409, and a Read Committed caller would see the fresh hold's 400. Pre-fix, the
  // extension sails through and COMMITS while the holder still holds the customer row.
  it("blocks the extension until a concurrent hold-set commits, then refuses (row-lock discipline)", async () => {
    const { shipper, orderB } = await shipmentPlusSpareOrder();
    const { customerId } = await prisma.shipper.findUniqueOrThrow({
      where: { id: shipper.id }, select: { customerId: true },
    });

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${customerId} FOR UPDATE`;
      hasClaimed();
      await release;
      await tx.customer.update({ where: { id: customerId }, data: { creditHold: true } });
    }, { timeout: 20000 });

    await claimed;
    const addCall = addOrderToShipper(shipper.id, orderB.id)
      .then(() => "resolved" as const, (e: unknown) => e as Error);
    await new Promise((r) => setTimeout(r, 300)); // ample time to reach the gate either way
    mayRelease();
    await holder;

    const settled = await addCall;
    expect(settled).not.toBe("resolved");
    expect(await prisma.shipperOrder.count({ where: { shipperId: shipper.id, orderId: orderB.id } })).toBe(0);
  });

  it("stays un-gated for a customer not on hold", async () => {
    const { shipper, orderB } = await shipmentPlusSpareOrder();
    await expect(addOrderToShipper(shipper.id, orderB.id)).resolves.toBeTruthy();
  });
});
