import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { setSetting } from "@/server/settings";
import { createOrder, removeLine, type OrderDetail } from "@/server/orders";
import { shipperOrderCompletion, inChunks } from "@/server/ship-ledger";
import {
  addOrderToShipper, createShipper, listShippers, listShippersWindow, shipmentsForOrder, reverseShipper, voidShipper, type ShipperDetail,
} from "@/server/shippers";
import type { Customer, Part } from "../prisma/generated/prisma/client";

// Task 13's own service-level coverage of the shipping list's filter contract (spec §11): customer,
// ship-date range, includeVoided defaulting off, and search over packing-list number / BOL number /
// order number / customer code. `listShippers` itself was built in Task 9 (shippers.ts's own header
// comment) and shipper-children.test.ts already exercises customer/basic-search/includeVoided in
// passing — this file is the dedicated, exhaustive pass the page (ShippingList.tsx) leans on.

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({ data: { code: `SL${customerSeq}`, name: `Ship List Customer ${customerSeq}` } });
}

let partSeq = 0;
async function makePart(customerId: string): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({ data: { customerId, partNumber: `SLP-${partSeq}`, eachWeight: "1.0000" } });
}

/** Gives a part revision 1 with one step — the orderability precondition createOrder enforces
 *  (spec §5.3), the shipper-children.test.ts `giveSteps` precedent. */
async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `SL-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

async function orderForCustomer(customer: Customer): Promise<OrderDetail> {
  const part = await makePart(customer.id);
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, lines: [{ partId: part.id, qty: 10, weight: "5.00" }],
  }));
  return order;
}

/** One order's worth of `createShipper` input, shipping its lead line in full — the
 *  shipper-children.test.ts `orderInput` precedent. */
async function shipmentFor(customer: Customer, order: OrderDetail, shipDate: string): Promise<ShipperDetail> {
  const { shipper } = await createShipper({
    customerId: customer.id,
    shipDate,
    orders: [{
      orderId: order.id,
      lines: [{
        orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight, lineComplete: false,
      }],
      containers: [],
      serials: [],
    }],
  }, { canOverrideCreditHold: false });
  return shipper;
}

beforeEach(async () => {
  await truncateAll();
  await seedOrderGatePrereqs();
});

// #612 PR C (ruling R3): the shipping list's window is the first rows of its fixed sort (newest ship
// date first, the packing-list number breaking a tie), read one past the window; `listShippers`
// stays unbounded for the export and every bare reader.
describe("listShippersWindow (#612, ruling R3)", () => {
  it("answers the first rows of the list's sort and whether it cut", async () => {
    const customer = await makeCustomer();
    const older = await shipmentFor(customer, await orderForCustomer(customer), "2026-08-01");
    const newerA = await shipmentFor(customer, await orderForCustomer(customer), "2026-08-10");
    const newerB = await shipmentFor(customer, await orderForCustomer(customer), "2026-08-10");

    const cut = await listShippersWindow({}, 2);
    expect(cut.cut).toBe(true);
    expect(cut.rows.map((r) => r.id)).toEqual([newerB.id, newerA.id]);

    const whole = await listShippersWindow({}, 3);
    expect(whole.cut).toBe(false);
    expect(whole.rows.map((r) => r.id)).toEqual([newerB.id, newerA.id, older.id]);

    expect((await listShippers({})).map((r) => r.id)).toEqual([newerB.id, newerA.id, older.id]);
  });
});

describe("listShippers filters (spec §11 shipping list)", () => {
  it("filters by customerId", async () => {
    const customerA = await makeCustomer();
    const customerB = await makeCustomer();
    const shipperA = await shipmentFor(customerA, await orderForCustomer(customerA), "2026-08-04");
    await shipmentFor(customerB, await orderForCustomer(customerB), "2026-08-04");

    const rows = await listShippers({ customerId: customerA.id });
    expect(rows.map((r) => r.id)).toEqual([shipperA.id]);
  });

  it("filters by ship-date range (from/to inclusive)", async () => {
    const customer = await makeCustomer();
    const early = await shipmentFor(customer, await orderForCustomer(customer), "2026-08-01");
    const mid = await shipmentFor(customer, await orderForCustomer(customer), "2026-08-10");
    const late = await shipmentFor(customer, await orderForCustomer(customer), "2026-08-20");

    const midOnly = await listShippers({ from: "2026-08-05", to: "2026-08-15" });
    expect(midOnly.map((r) => r.id)).toEqual([mid.id]);

    const fromOnly = await listShippers({ from: "2026-08-10" });
    expect(fromOnly.map((r) => r.id).sort()).toEqual([late.id, mid.id].sort());

    const toOnly = await listShippers({ to: "2026-08-10" });
    expect(toOnly.map((r) => r.id).sort()).toEqual([early.id, mid.id].sort());
  });

  it("excludes voided shipments by default and includes them only with includeVoided", async () => {
    const customer = await makeCustomer();
    const live = await shipmentFor(customer, await orderForCustomer(customer), "2026-08-04");
    const voided = await shipmentFor(customer, await orderForCustomer(customer), "2026-08-04");
    await prisma.shipper.update({ where: { id: voided.id }, data: { deletedAt: new Date() } });

    const defaultRows = await listShippers({});
    expect(defaultRows.map((r) => r.id)).toEqual([live.id]);

    const explicitOff = await listShippers({ includeVoided: false });
    expect(explicitOff.map((r) => r.id)).toEqual([live.id]);

    const withVoided = await listShippers({ includeVoided: true });
    expect(withVoided.map((r) => r.id).sort()).toEqual([live.id, voided.id].sort());
  });

  it("search matches the packing-list number", async () => {
    const customer = await makeCustomer();
    const shipper = await shipmentFor(customer, await orderForCustomer(customer), "2026-08-04");

    const rows = await listShippers({ search: String(shipper.shipperNumber) });
    expect(rows.map((r) => r.id)).toEqual([shipper.id]);
  });

  it("search matches the BOL number", async () => {
    const customer = await makeCustomer();
    const shipper = await shipmentFor(customer, await orderForCustomer(customer), "2026-08-04");
    // No BOL print flow exists yet in this branch (only shippers.ts reads/writes bolNumber) — set
    // it directly, the certs-schema.test.ts precedent for exercising a bolNumber-bearing row.
    await prisma.shipper.update({ where: { id: shipper.id }, data: { bolNumber: 88123 } });

    const rows = await listShippers({ search: "88123" });
    expect(rows.map((r) => r.id)).toEqual([shipper.id]);
  });

  it("search matches an order number carried on the shipment", async () => {
    const customer = await makeCustomer();
    const order = await orderForCustomer(customer);
    const shipper = await shipmentFor(customer, order, "2026-08-04");

    const rows = await listShippers({ search: String(order.orderNumber) });
    expect(rows.map((r) => r.id)).toEqual([shipper.id]);
  });

  it("search matches the customer code", async () => {
    const customer = await makeCustomer();
    const shipper = await shipmentFor(customer, await orderForCustomer(customer), "2026-08-04");

    const rows = await listShippers({ search: customer.code });
    expect(rows.map((r) => r.id)).toEqual([shipper.id]);
  });

  it("search does not cross customers — a different customer's number does not match", async () => {
    const customerA = await makeCustomer();
    const customerB = await makeCustomer();
    await shipmentFor(customerA, await orderForCustomer(customerA), "2026-08-04");
    await shipmentFor(customerB, await orderForCustomer(customerB), "2026-08-04");

    const rows = await listShippers({ search: customerA.code });
    expect(rows.every((r) => r.customerCode === customerA.code)).toBe(true);
  });
});

describe("listShippers carries no Complete/Partial tag (#631, ruling R4)", () => {
  // The shipping list and its Excel export show no Complete/Partial tag, so the list does not
  // compute one: a row's order slice carries NO `complete` key (not `undefined`: `toHaveProperty`
  // sees that as present). The hub's Shipments section is the one renderer, and it reads
  // `shipmentsForOrder`, whose assertions below are the pin for the other direction.
  it("a listed row's order slice has no `complete` key, in full or in part", async () => {
    const customer = await makeCustomer();
    const order = await orderForCustomer(customer);
    await shipmentFor(customer, order, "2026-08-04");
    const rows = await listShippers({});
    expect(rows).toHaveLength(1);
    expect(rows[0].orders).toHaveLength(1);
    expect(rows[0].orders[0]).not.toHaveProperty("complete");
    const [hubRow] = await shipmentsForOrder(order.id);
    expect(hubRow.orders[0].complete).toBe(true);
  });
});

describe("listShippers reversal identity (#232)", () => {
  beforeEach(async () => {
    // Search intentionally spans both packing-list and order numbers. Keep their number series
    // distinct here so searching the original cannot also match every shipment on its order.
    await asSystem(() => setSetting("shipper_number_next", 1015));
  });

  it("names the live counterpart even when search returns only the original", async () => {
    const customer = await makeCustomer();
    const original = await shipmentFor(customer, await orderForCustomer(customer), "2026-08-04");
    const { shipper: reversal } = await asSystem(() => reverseShipper(original.id, { reason: "returned" }));

    const originalOnly = await listShippers({ search: String(original.shipperNumber) });
    expect(originalOnly).toHaveLength(1);
    expect(originalOnly[0]).toMatchObject({
      id: original.id, reversesShipperNumber: null, reversedByShipperNumber: reversal.shipperNumber,
    });
    const reversalOnly = await listShippers({ search: String(reversal.shipperNumber) });
    expect(reversalOnly).toHaveLength(1);
    expect(reversalOnly[0]).toMatchObject({
      id: reversal.id, reversesShipperNumber: original.shipperNumber, reversedByShipperNumber: null,
    });
  });

  it("clears the original's counterpart after voiding but keeps the reversal's identity", async () => {
    const customer = await makeCustomer();
    const original = await shipmentFor(customer, await orderForCustomer(customer), "2026-08-04");
    const { shipper: reversal } = await asSystem(() => reverseShipper(original.id, { reason: "returned" }));
    await asSystem(() => voidShipper(reversal.id, "undo reversal"));

    const live = await listShippers({});
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      id: original.id, reversesShipperNumber: null, reversedByShipperNumber: null,
    });
    const withVoided = await listShippers({ includeVoided: true });
    expect(withVoided).toHaveLength(2);
    expect(withVoided.find((r) => r.id === original.id)).toMatchObject({ reversedByShipperNumber: null });
    expect(withVoided.find((r) => r.id === reversal.id)).toMatchObject({
      deletedAt: expect.any(String), reversesShipperNumber: original.shipperNumber, reversedByShipperNumber: null,
    });
  });

  it("names the new live reversal after re-reversing, never the earlier voided one", async () => {
    const customer = await makeCustomer();
    const original = await shipmentFor(customer, await orderForCustomer(customer), "2026-08-04");
    const { shipper: oldReversal } = await asSystem(() => reverseShipper(original.id, { reason: "returned" }));
    await asSystem(() => voidShipper(oldReversal.id, "undo reversal"));
    const { shipper: newReversal } = await asSystem(() => reverseShipper(original.id, { reason: "corrected return" }));
    expect(newReversal.shipperNumber).not.toBe(oldReversal.shipperNumber);

    for (const includeVoided of [false, true]) {
      const rows = await listShippers({ search: String(original.shipperNumber), includeVoided });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: original.id, reversesShipperNumber: null, reversedByShipperNumber: newReversal.shipperNumber,
      });
    }
  });
});

describe("the Complete tag follows shipped quantity (quantity corrections design §3.4)", () => {
  /** One shipment of `qty` on the order's lead line, with no tick. */
  async function shipQty(customer: Customer, order: OrderDetail, qty: number, shipDate: string): Promise<ShipperDetail> {
    const { shipper } = await createShipper({
      customerId: customer.id, shipDate,
      orders: [{
        orderId: order.id,
        lines: [{ orderLineId: order.lines[0].id, qty, weight: "1.00", lineComplete: false }],
        containers: [], serials: [],
      }],
    }, { canOverrideCreditHold: false });
    return shipper;
  }

  it("tags a shipment Complete when it finishes the line, with no tick", async () => {
    const customer = await makeCustomer();
    const order = await orderForCustomer(customer);
    await shipQty(customer, order, order.lines[0].qty, "2026-08-04");
    const [row] = await shipmentsForOrder(order.id);
    expect(row.orders[0].complete).toBe(true);
  });

  it("tags the first of two shipments Partial and the second Complete", async () => {
    const customer = await makeCustomer();
    const order = await orderForCustomer(customer);
    await shipQty(customer, order, 1, "2026-08-04");
    await shipQty(customer, order, order.lines[0].qty - 1, "2026-08-05");
    const rows = await shipmentsForOrder(order.id);
    const bySeq = new Map(rows.map((r) => [r.orders[0].sequence, r.orders[0].complete]));
    expect(bySeq.get(1)).toBe(false);
    expect(bySeq.get(2)).toBe(true);
  });

  // Owner ruling 2026-10-06, the accepted consequence of the automatic clear: a shipment that
  // closed its line short reads Complete until a later shipment sends the rest. That shipment
  // clears the tick, so the earlier one then reads Partial and the later one Complete.
  it("re-tags a closed-short shipment Partial once a later shipment brings the line to its quantity", async () => {
    const customer = await makeCustomer();
    const order = await orderForCustomer(customer); // one line of 10
    await createShipper({
      customerId: customer.id, shipDate: "2026-08-04",
      orders: [{
        orderId: order.id,
        lines: [{ orderLineId: order.lines[0].id, qty: 9, weight: "1.00", lineComplete: true }],
        containers: [], serials: [],
      }],
    }, { canOverrideCreditHold: false });
    const tags = async () =>
      new Map((await shipmentsForOrder(order.id)).map((r) => [r.orders[0].sequence, r.orders[0].complete]));
    expect((await tags()).get(1)).toBe(true); // closed short

    await shipQty(customer, order, 1, "2026-08-05");
    const after = await tags();
    expect(after.get(1)).toBe(false);
    expect(after.get(2)).toBe(true);
  });

  /** Each shipment's tag by its sequence, for an order that is the only order on each shipment.
   *  `shipmentsForOrder` lists voided shipments too. The value is the wire's `complete`, optional
   *  since #631 (absent on the list's rows), so each `toBe(true|false)` below also proves the hub's
   *  rows carry it. */
  async function tagsBySequence(orderId: string): Promise<Map<number, boolean | undefined>> {
    return new Map((await shipmentsForOrder(orderId)).map((r) => [r.orders[0].sequence, r.orders[0].complete]));
  }

  // Each shipment is judged on its own row plus the live rows below its sequence. A voided
  // shipment's own row is not among the live rows, so it counts only as its own row. Summing the
  // live rows through the shipment's own sequence instead gives the same answer for a live
  // shipment and loses a voided one's own row.
  it("tags a voided shipment on its own row plus the live shipments below it", async () => {
    const customer = await makeCustomer();
    const order = await orderForCustomer(customer); // one line of 10
    await shipQty(customer, order, 4, "2026-08-04");
    const second = await shipQty(customer, order, 6, "2026-08-05");
    await asSystem(() => voidShipper(second.id, "shipped in error"));
    const tags = await tagsBySequence(order.id);
    expect(tags.size).toBe(2);
    expect(tags.get(1)).toBe(false); // 4 of 10
    expect(tags.get(2)).toBe(true); // voided: its own 6 on the live 4 below it
  });

  it("counts no voided shipment below a live one", async () => {
    const customer = await makeCustomer();
    const order = await orderForCustomer(customer); // one line of 10
    const first = await shipQty(customer, order, 9, "2026-08-04");
    await asSystem(() => voidShipper(first.id, "shipped in error"));
    await shipQty(customer, order, 1, "2026-08-05");
    const tags = await tagsBySequence(order.id);
    expect(tags.size).toBe(2);
    expect(tags.get(2)).toBe(false); // 1 of 10: the voided 9 below it is not counted
    expect(tags.get(1)).toBe(false); // voided: its own 9, with nothing live below it
  });

  /** A lead line of 10 and a rider line of 8. Only the lead needs process steps. */
  async function twoLineOrder(customer: Customer): Promise<OrderDetail> {
    const lead = await makePart(customer.id);
    await giveSteps(lead.id);
    const rider = await makePart(customer.id);
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id,
      lines: [{ partId: lead.id, qty: 10, weight: "5.00" }, { partId: rider.id, qty: 8, weight: "4.00" }],
    }));
    return order;
  }

  // A released row is a shipper line whose order line has been removed since (`orderLineId` null).
  // `removeLine` refuses a line on a live shipment, so such a row is on a voided shipment. It is
  // judged on its own row alone, against the ordered quantity it stored. Deleting the released-row
  // branch leaves these cases green: a null id finds no live rows and no order line, so the general
  // case falls back to the same row and the same stored quantity. They test what the branch
  // computes, not whether it is there.
  it.each([
    [8, false, true],
    [3, false, false],
    [3, true, true],
  ])("tags a voided shipment by a released row on its own: rider %d of 8, ticked %s, Complete %s",
    async (riderQty, ticked, complete) => {
      const customer = await makeCustomer();
      const order = await twoLineOrder(customer);
      const lead = order.lines.find((l) => l.position === 1)!;
      const rider = order.lines.find((l) => l.position === 2)!;
      const { shipper } = await createShipper({
        customerId: customer.id, shipDate: "2026-08-04",
        orders: [{
          orderId: order.id,
          lines: [
            { orderLineId: lead.id, qty: 10, weight: "5.00", lineComplete: false },
            { orderLineId: rider.id, qty: riderQty, weight: "1.00", lineComplete: ticked },
          ],
          containers: [], serials: [],
        }],
      }, { canOverrideCreditHold: false });
      const riderRow = shipper.orders[0].lines.find((l) => l.orderLineId === rider.id)!;
      expect(riderRow.lineComplete).toBe(ticked);
      await asSystem(() => voidShipper(shipper.id, "shipped in error"));
      await asSystem(() => removeLine(order.id, rider.id));
      // The row is released: this is what sends it down the released-row branch.
      expect((await prisma.shipperLine.findUniqueOrThrow({ where: { id: riderRow.id } })).orderLineId).toBeNull();

      const [row] = await shipmentsForOrder(order.id);
      expect(row.id).toBe(shipper.id);
      expect(row.orders[0].complete).toBe(complete);
    });

  it("tags an order on a shipment with no lines of its own Partial", async () => {
    const customer = await makeCustomer();
    const orderA = await orderForCustomer(customer);
    const orderB = await orderForCustomer(customer);
    const shipper = await shipQty(customer, orderA, orderA.lines[0].qty, "2026-08-04");
    const detail = await asSystem(() => addOrderToShipper(shipper.id, orderB.id));
    const soB = detail.orders.find((o) => o.orderId === orderB.id)!;
    expect(soB.lines).toEqual([]);

    const [row] = await shipmentsForOrder(orderB.id);
    expect(row.id).toBe(shipper.id);
    expect(row.orders.find((o) => o.orderId === orderB.id)!.complete).toBe(false);
    // Read on the map itself, because the row reads a missing id as false as well (`toShipperRow`).
    expect(await shipperOrderCompletion(prisma, [soB.id])).toEqual(new Map([[soB.id, false]]));
  });
});

describe("shipperOrderCompletion reads its id lists in bounded chunks (#470)", () => {
  it("answers the same at chunk size 1 as at the default, for three shipments across two orders", async () => {
    const customer = await makeCustomer();
    const orderA = await orderForCustomer(customer); // one line of 10
    const orderB = await orderForCustomer(customer);
    const ship = async (order: OrderDetail, qty: number, shipDate: string) => createShipper({
      customerId: customer.id, shipDate,
      orders: [{
        orderId: order.id,
        lines: [{ orderLineId: order.lines[0].id, qty, weight: "1.00", lineComplete: false }],
        containers: [], serials: [],
      }],
    }, { canOverrideCreditHold: false });
    await ship(orderA, 1, "2026-08-04");  // A sequence 1: Partial
    await ship(orderA, 9, "2026-08-05");  // A sequence 2: Complete
    await ship(orderB, 10, "2026-08-05"); // B sequence 1: Complete
    const ids = (await prisma.shipperOrder.findMany({ select: { id: true } })).map((r) => r.id);
    expect(ids).toHaveLength(3);

    const byDefault = await shipperOrderCompletion(prisma, ids);
    const byOne = await shipperOrderCompletion(prisma, ids, 1);
    expect([...byOne.entries()].sort()).toEqual([...byDefault.entries()].sort());
    const seq = new Map((await prisma.shipperOrder.findMany({ select: { id: true, orderId: true, sequence: true } }))
      .map((r) => [r.id, `${r.orderId === orderA.id ? "A" : "B"}${r.sequence}`]));
    expect(new Map([...byOne].map(([id, v]) => [seq.get(id), v]))).toEqual(
      new Map([["A1", false], ["A2", true], ["B1", true]]));
  });

  it("splits five ids at size 2 into reads of 2, 2 and 1 and keeps every row in order", async () => {
    const calls: string[][] = [];
    const rows = await inChunks(["a", "b", "c", "d", "e"], 2, async (chunk) => {
      calls.push(chunk);
      return chunk.map((id) => id.toUpperCase());
    });
    expect(calls).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(rows).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("issues no read for an empty id list", async () => {
    let reads = 0;
    expect(await inChunks([], 2, async () => { reads += 1; return []; })).toEqual([]);
    expect(reads).toBe(0);
  });
});
