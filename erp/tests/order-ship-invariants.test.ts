import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { storedTareEach } from "./helpers/shipment-rows";
import { runWithContext } from "@/server/context";
import {
  createOrder, addLine, removeLine, updateLine, voidOrder, replaceContainers, replaceSerials, getOrder,
  type OrderDetail,
} from "@/server/orders";
import {
  createShipper, voidShipper, getShipper, updateShipper, overshipWarnings, shipmentWarnings,
  replaceShipperContainers, replaceShipperSerials,
} from "@/server/shippers";
import { readAudit } from "@/server/audit";
import { createCert, getCert } from "@/server/certs";
import { addPartInspection } from "@/server/part-inspections";
import type { Customer, Part } from "../prisma/generated/prisma/client";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

// The shippers.test.ts / ship-ledger.test.ts fixture shape, trimmed to what this file needs.
let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({ data: { code: `C${customerSeq}`, name: `Customer ${customerSeq}` } });
}

let partSeq = 0;
async function makePart(customerId: string): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({ data: { customerId, partNumber: `P-${partSeq}`, eachWeight: "1.0000" } });
}

async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `HT-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

async function savedOrder(opts: { qty?: number } = {}): Promise<{ order: OrderDetail; part: Part; customer: Customer }> {
  const customer = await makeCustomer();
  const part = await makePart(customer.id);
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id,
    lines: [{ partId: part.id, qty: opts.qty ?? 10, weight: "25.00" }],
  }));
  return { order, part, customer };
}

/** A second, live, orderable part for `order`'s own customer — riders are exempt from the
 *  orderability (steps) check (orders.test.ts's `fixture` precedent, spec §12.4). */
async function addRiderLine(order: OrderDetail, opts: { qty: number; weight: string }): Promise<OrderDetail> {
  const rider = await prisma.part.create({
    data: { customerId: order.customerId, partNumber: `R-${order.id}`, eachWeight: "1.0000" },
  });
  return asSystem(() => addLine(order.id, { partId: rider.id, qty: opts.qty, weight: opts.weight }));
}

/** One RIDER order line, shipped `opts.shipped` (default: half of `opts.ordered`) of
 *  `opts.ordered` (default 10) via ONE real shipment through `createShipper` (never raw prisma)
 *  — this file's own coverage is exactly of the invariants `createShipper`'s callers rely on, so
 *  the fixture goes through the same service every real caller does. A RIDER, deliberately, not
 *  the lead (position 1): `removeLine` refuses the lead outright regardless of shipments ("void
 *  the order instead"), which would make the shipment-blocker refusal this fixture exists to
 *  drive unreachable — the lead's own line stays at a trivial qty of 1, never the line under
 *  test. `onLead: true` is the opposite shape: a SINGLE-line order whose one (lead) line is the
 *  one shipped, so the order's status follows that line alone (the quantity-completion tests). */
async function shipmentOfOneLine(opts: { ordered?: number; shipped?: number; onLead?: boolean } = {}): Promise<{
  order: OrderDetail; line: { id: string; orderId: string }; shipper: { id: string; shipperNumber: number };
}> {
  const ordered = opts.ordered ?? 10;
  const shipped = opts.shipped ?? Math.floor(ordered / 2);
  const { order: base } = await savedOrder({ qty: opts.onLead ? ordered : 1 });
  const order = opts.onLead ? base : await addRiderLine(base, { qty: ordered, weight: "25.00" });
  const line = order.lines[opts.onLead ? 0 : 1];

  const { shipper } = await createShipper({
    customerId: order.customerId,
    shipDate: "2026-08-04",
    orders: [{
      orderId: order.id,
      lines: [{ orderLineId: line.id, qty: shipped, weight: "5.00", lineComplete: false }],
      containers: [],
      serials: [],
    }],
  }, { canOverrideCreditHold: false });

  return {
    order, line: { id: line.id, orderId: order.id },
    shipper: { id: shipper.id, shipperNumber: shipper.shipperNumber },
  };
}

describe("order edit invariants after a shipment (spec §5.5)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("refuses removing a line that has shipments, naming the shipment", async () => {
    const { order, line, shipper } = await shipmentOfOneLine();
    await expect(asSystem(() => removeLine(order.id, line.id)))
      .rejects.toThrow(new RegExp(`Packing List ${shipper.shipperNumber}`));
  });

  it("allows removing a rider line that has no shipments", async () => {
    const { order } = await savedOrder();
    const withRider = await addRiderLine(order, { qty: 5, weight: "10.00" });
    const rider = withRider.lines[1];
    await expect(asSystem(() => removeLine(order.id, rider.id))).resolves.toBeTruthy();
  });

  it("refuses reducing a line below its shipped-to-date", async () => {
    const { order, line } = await shipmentOfOneLine({ ordered: 1000, shipped: 400 });
    await expect(asSystem(() => updateLine(order.id, line.id, { qty: 300 })))
      .rejects.toThrow(/400 already shipped/i);
    await expect(asSystem(() => updateLine(order.id, line.id, { qty: 400 }))).resolves.toBeTruthy();
  });

  it("refuses reducing a line's weight below its shipped-to-date", async () => {
    // `shipmentOfOneLine` always ships a flat 5.00 lb (qty is the only thing `opts` varies) — the
    // qty-only mirror of the test above, exercising the SAME `data.weight !== undefined` branch in
    // `updateLine` (orders.ts) that the qty test above never touches.
    const { order, line } = await shipmentOfOneLine({ ordered: 1000, shipped: 400 });
    // The whole sentence, anchored at both ends. The line's label and the tail that names the
    // shipment are the fixture's. Every word between them is written out, with the 5 lb shipped.
    await expect(asSystem(() => updateLine(order.id, line.id, { weight: 4 })))
      .rejects.toThrow(/^.+: cannot reduce net weight below 5 lb already shipped — .+$/);
    await expect(asSystem(() => updateLine(order.id, line.id, { weight: 5 }))).resolves.toBeTruthy();
  });

  it("moves the order to SHIPPED when a quantity is corrected down to what shipped", async () => {
    // order line qty 332; ship 32 with no tick -> PARTIAL_SHIPPED; correct to 32 -> SHIPPED
    const { order, line } = await shipmentOfOneLine({ ordered: 332, shipped: 32, onLead: true });
    expect((await getOrder(order.id)).status).toBe("PARTIAL_SHIPPED");
    await asSystem(() => updateLine(order.id, line.id, { qty: 32 }));
    expect((await getOrder(order.id)).status).toBe("SHIPPED");
  });

  it("moves a SHIPPED order back to PARTIAL_SHIPPED when a quantity is raised", async () => {
    const { order, line } = await shipmentOfOneLine({ ordered: 32, shipped: 32, onLead: true });
    expect((await getOrder(order.id)).status).toBe("SHIPPED");
    await asSystem(() => updateLine(order.id, line.id, { qty: 40 }));
    expect((await getOrder(order.id)).status).toBe("PARTIAL_SHIPPED");
  });

  it("allows increasing a line above its shipped-to-date freely", async () => {
    const { order, line } = await shipmentOfOneLine({ ordered: 1000, shipped: 400 });
    await expect(asSystem(() => updateLine(order.id, line.id, { qty: 2000 }))).resolves.toBeTruthy();
  });

  // Fix-wave (whole-branch review 2026-08-06, Important #2): `shippedTotals` accumulated weight in
  // raw floats, so 0.10 + 0.20 summed to 0.30000000000000004 — turning the §5.5 guard into a hard
  // FALSE refusal of the legal edit-to-exactly-shipped, and making an exactly-complete line warn
  // as over-shipped. The fix sums in integer cents (the `toShipperRow` idiom) and divides once.
  it("0.10 + 0.20 shipped across two shipments: the line edits to exactly 0.30 and no over-ship warning fires", async () => {
    const { order: base } = await savedOrder({ qty: 1 });
    const order = await addRiderLine(base, { qty: 2, weight: "0.30" });
    const line = order.lines[1];

    const shipOnce = (qty: number, weight: string) => asSystem(() => createShipper({
      customerId: order.customerId, shipDate: "2026-08-04",
      orders: [{
        orderId: order.id,
        lines: [{ orderLineId: line.id, qty, weight, lineComplete: false }],
        containers: [], serials: [],
      }],
    }, { canOverrideCreditHold: false }));
    await shipOnce(1, "0.10");
    const second = await shipOnce(1, "0.20");

    // §5.5 permits reducing to EXACTLY the shipped-to-date (the qty/weight tests above pin the
    // same boundary at integer values) — pre-fix this refused with "0.30000000000000004 lbs".
    await expect(asSystem(() => updateLine(order.id, line.id, { weight: 0.3 }))).resolves.toBeTruthy();

    // And the exactly-complete line is NOT over-shipped (§5.7 warns only past the ordered figure)
    // — pre-fix the float artifact pushed shipped-to-date a hair past 0.30 and warned.
    expect(overshipWarnings(await getShipper(second.shipper.id))).toEqual([]);
  });

  it("refuses voiding an order with live shipments, and allows it after the shipment is voided", async () => {
    const { order, shipper } = await shipmentOfOneLine();
    await expect(asSystem(() => voidOrder(order.id, "cancelled"))).rejects.toThrow(/live shipment/i);
    await asSystem(() => voidShipper(shipper.id, "cancelled too"));
    await expect(asSystem(() => voidOrder(order.id, "cancelled"))).resolves.toBeUndefined();
  });

  // Minor 2 (Task 10 review, 2026-08-04): `shipmentBlockerTail`'s pluralized branch ("Packing
  // List X, Packing List Y — void the shipmentS first") was written but never exercised — every
  // other test here blocks on exactly one shipment. Two SEPARATE shipments of the SAME order line
  // (over-shipping only warns, never blocks — spec §5.1/§5.7) is the minimal fixture that puts two
  // live blockers on one `voidOrder` call.
  it("names every live shipment, pluralized, when more than one blocks the same order", async () => {
    const { order } = await savedOrder({ qty: 20 });
    const line = order.lines[0];

    const shipSome = async (qty: number) => {
      const { shipper } = await createShipper({
        customerId: order.customerId,
        shipDate: "2026-08-04",
        orders: [{
          orderId: order.id,
          lines: [{ orderLineId: line.id, qty, weight: "5.00", lineComplete: false }],
          containers: [],
          serials: [],
        }],
      }, { canOverrideCreditHold: false });
      return shipper;
    };

    const first = await shipSome(5);
    const second = await shipSome(5);

    await expect(asSystem(() => voidOrder(order.id, "cancelled"))).rejects.toThrow(
      new RegExp(`Packing List ${first.shipperNumber}.*Packing List ${second.shipperNumber}.*shipments`));
  });
});

// -------------------------------------------------------------------------------------------
// Snapshot + release (owner ruling 2026-08-06, MR !47 review round 2): shipper children snapshot
// the identity they print, and their FKs to the order-side rows release (SET NULL) instead of
// blocking the order-correction APIs. A voided shipment's history survives through the snapshot;
// the order stays correctable through the same APIs it always had.
// -------------------------------------------------------------------------------------------
describe("snapshot + release: order corrections after shipment references", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("removeLine succeeds once every referencing shipment is voided, and the voided shipment still names the part", async () => {
    const { line, shipper } = await shipmentOfOneLine();
    await asSystem(() => voidShipper(shipper.id, "wrong truck"));

    const removed = await asSystem(() => removeLine(line.orderId, line.id));
    expect(removed.lines.map((l) => l.id)).not.toContain(line.id);

    // The voided shipment's grid still renders what shipped — the snapshot, not the dead join.
    const detail = await getShipper(shipper.id);
    const shipLine = detail.orders[0].lines.find((l) => l.qty === 5)!;
    expect(shipLine.partNumber).toMatch(/^R-/);   // the rider part's number, snapshotted
    expect(shipLine.orderLineId).toBeNull();
  });

  it("removeLine succeeds when a cert's frozen requirements reference the line, keeping their identity", async () => {
    // No shipments at all — the FK from CertRequirement alone must not block the removal (round-3
    // finding, 2026-08-06; ruling 23 extended). The requirement keeps rendering from its snapshot.
    const { order } = await savedOrder();
    const withRider = await addRiderLine(order, { qty: 5, weight: "10.00" });
    const rider = withRider.lines[1];
    const code = await prisma.inspectionCode.create({ data: { name: "SSR-Hardness" } });
    await asSystem(() => addPartInspection(rider.partId, { inspectionCodeId: code.id, sort: 0, min: 28, max: 32 }));
    const cert = await asSystem(() => createCert({ orderId: order.id, scope: "ORDER" }));
    expect(cert.requirements.some((r) => r.orderLineId === rider.id)).toBe(true);

    const removed = await asSystem(() => removeLine(order.id, rider.id));
    expect(removed.lines.map((l) => l.id)).not.toContain(rider.id);

    const after = await getCert(cert.id);
    const frozen = after.requirements.find((r) => r.orderLineId === null);
    expect(frozen).toBeTruthy();
    expect(frozen!.partNumber).toMatch(/^R-/);   // the rider part's number, snapshotted at seed
    expect(frozen!.linePosition).toBe(2);
  });

  it("replaceContainers keeps working on an order a live shipment references, and the shipment keeps the container's identity", async () => {
    const { order: base } = await savedOrder({ qty: 10 });
    const containerType = await prisma.containerType.create({ data: { name: "Basket" } });
    const bin = await prisma.orderContainer.create({
      data: { orderId: base.id, position: 1, typeId: containerType.id, count: 2, customerContainerId: "BIN-9" },
    });
    const { shipper } = await createShipper({
      customerId: base.customerId, shipDate: "2026-08-04",
      orders: [{
        orderId: base.id,
        lines: [{ orderLineId: base.lines[0].id, qty: 5, weight: "5.00", lineComplete: false }],
        containers: [{ orderContainerId: bin.id, count: 2 }],
        serials: [],
      }],
    }, { canOverrideCreditHold: false });

    // Pre-Phase-4, container corrections were free at any time — they must stay so.
    await expect(asSystem(() => replaceContainers(base.id, []))).resolves.toBeTruthy();

    const detail = await getShipper(shipper.id);
    expect(detail.orders[0].containers).toHaveLength(1);
    expect(detail.orders[0].containers[0].typeName).toBe("Basket");
    expect(detail.orders[0].containers[0].customerContainerId).toBe("BIN-9");
    expect(detail.orders[0].containers[0].orderContainerId).toBeNull();
  });

  /**
   * Issue #125 — RULED by the owner 2026-08-16: WARN when an already-shipped serial is re-selected,
   * do not block. Open since Phase 4 (ping #2).
   *
   * Nothing recorded that a specific serial had already shipped, so the same serialised part could
   * go out twice with no notice. A hard refusal was explicitly rejected: unblocking the legitimate
   * case (a returned part going back out) would need a return/RMA concept that does not exist, so a
   * block could wedge a real shipment with no way forward.
   *
   * The shipped fact is DERIVED, not stored — the ruling asked for that to be checked first, and
   * live `ShipperSerial` rows joined to non-voided shippers carry it already, so no column was
   * added. Folded into `shipmentWarnings` so it reaches BOTH the idempotent replay and every edit
   * response via `shipperResponse` (the #50/#54 lesson: a warning computed in one path is half-built).
   */
  describe("re-shipping a serial warns and names where it went (#125)", () => {
    /** One order with two serials, and a first shipment that sends `SN-1`. */
    async function shippedOnce() {
      const { order } = await savedOrder({ qty: 10 });
      const s1 = await prisma.orderSerial.create({
        data: { orderId: order.id, lineId: order.lines[0].id, position: 1, serial: "SN-1" },
      });
      const s2 = await prisma.orderSerial.create({
        data: { orderId: order.id, lineId: order.lines[0].id, position: 2, serial: "SN-2" },
      });
      const first = await createShipper({
        customerId: order.customerId, shipDate: "2026-08-04",
        orders: [{
          orderId: order.id,
          lines: [{ orderLineId: order.lines[0].id, qty: 1, weight: "1.00", lineComplete: false }],
          containers: [], serials: [{ orderSerialId: s1.id, printOnShipper: true }],
        }],
      }, { canOverrideCreditHold: false });
      return { order, s1, s2, first: first.shipper };
    }

    function shipAgain(order: OrderDetail, serialId: string) {
      return createShipper({
        customerId: order.customerId, shipDate: "2026-08-06",
        orders: [{
          orderId: order.id,
          lines: [{ orderLineId: order.lines[0].id, qty: 1, weight: "1.00", lineComplete: false }],
          containers: [], serials: [{ orderSerialId: serialId, printOnShipper: true }],
        }],
      }, { canOverrideCreditHold: false });
    }

    it("warns — never refuses — and names WHICH shipment and WHEN", async () => {
      const { order, s1, first } = await shippedOnce();

      const second = await shipAgain(order, s1.id);

      // Not blocked: the shipment exists.
      expect(second.shipper.id).toBeTruthy();
      // §5.14 — the warning names its cause: the serial, the packing list, the date, and a link.
      expect(second.warnings).toContainEqual(
        `Serial SN-1 also appears on Packing List ${first.shipperNumber} ` +
        `(2026-08-04) — see /shipping/${first.id}`);
    });

    it("says nothing about a serial shipping for the first time", async () => {
      const { order, s2 } = await shippedOnce();
      const second = await shipAgain(order, s2.id);
      expect(second.warnings.filter((w) => w.includes("also appears on"))).toEqual([]);
    });

    it("a VOIDED earlier shipment does not count as shipped", async () => {
      const { order, s1, first } = await shippedOnce();
      await asSystem(() => voidShipper(first.id, "wrong truck"));

      const second = await shipAgain(order, s1.id);
      expect(second.warnings.filter((w) => w.includes("also appears on"))).toEqual([]);
    });

    it("does not warn about a serial against the shipment it is currently on", async () => {
      const { first } = await shippedOnce();
      // Re-reading the FIRST shipment must not accuse it of duplicating its own selection.
      const detail = await getShipper(first.id);
      expect((await shipmentWarnings(prisma, detail)).filter((w) => w.includes("also appears on")))
        .toEqual([]);
    });

    /**
     * Codex, MR !130 (three P2s) — and the owner's ruling on how to resolve the conflict between
     * them (2026-08-16).
     *
     * The first draft said "has ALREADY shipped on PL 1001" and excluded only the current shipment,
     * which made the relation SYMMETRIC and reversed history: re-reading the ORIGINAL PL 1000
     * accused it of duplicating its own successor. Bounding on an earlier `shipperNumber` fixed
     * that — and immediately broke the third finding, because packing-list order records DOCUMENT
     * creation, not when a serial was selected during an EDIT: `replaceShipperSerials` on an older
     * ticket could newly add a serial a higher-numbered ticket already held, and the `lt` filter
     * ignored it.
     *
     * True chronology would need a `ShipperSerial.createdAt` column. **Ruled instead: compare
     * against every other live shipment and reword to "also appears on".** That sentence is true
     * from either side, so both documents carrying the advisory is correct rather than a defect —
     * both are involved in the duplication — and no schema change or chronology has to be
     * maintained. It still names which shipment and when, which is what the original ruling
     * required.
     */
    it("warns BOTH documents symmetrically — the sentence is true from either side", async () => {
      const { order, s1, first } = await shippedOnce();
      const second = await shipAgain(order, s1.id);

      // The re-selection names the other shipment...
      expect(second.warnings.some((w) => w.includes(`Packing List ${first.shipperNumber}`))).toBe(true);
      // ...and so does the original, because a duplicate genuinely involves both.
      const original = await shipmentWarnings(prisma, await getShipper(first.id));
      expect(original.some((w) => w.includes(`Packing List ${second.shipper.shipperNumber}`))).toBe(true);
      // Never "already shipped" — that word is what made the symmetric case a lie.
      expect(original.join(" ")).toContain("also appears on");
      expect(original.join(" ").toLowerCase()).not.toContain("already shipped");
    });

    /**
     * Codex, MR !130 (P2) — the identity must survive `replaceSerials`.
     *
     * `replaceSerials` DELETES and recreates every `OrderSerial`, and the earlier
     * `ShipperSerial.orderSerialId` is nulled by snapshot + release. Keying the match on that id
     * therefore lost the prior shipment entirely, so the recreated serial could be shipped again
     * with no warning at all — and my own comment had rationalised it as correct ("a released row no
     * longer refers to a serial anyone can re-select"), which was simply wrong: the recreated serial
     * is the same physical part and IS selectable.
     *
     * Matched on (order line, serial text) instead, which survives the replace. Scoping to the LINE
     * is also what makes the serial text safe to match on — a line belongs to one order, one
     * customer, one part — which was the original objection to using it.
     */
    it("still warns after replaceSerials recreates the serial rows", async () => {
      const { order, s1, first } = await shippedOnce();

      // Recreate the order's serials with the SAME numbers; the shipment's rows are released.
      await asSystem(() => replaceSerials(order.id, order.lines[0].id, [
        { serial: "SN-1", description: "" },
        { serial: "SN-2", description: "" },
      ]));
      const recreated = await prisma.orderSerial.findFirstOrThrow({
        where: { lineId: order.lines[0].id, serial: "SN-1" },
      });
      expect(recreated.id).not.toBe(s1.id); // genuinely a new row

      const second = await shipAgain(order, recreated.id);
      expect(second.warnings.some((w) => w.includes(`Packing List ${first.shipperNumber}`))).toBe(true);
    });

    /**
     * Codex, MR !130 (P2) — a VOIDED current shipment must derive no duplicate advisory.
     *
     * "Voided shipments do not count" was applied to the MATCHED side only: the other shipment is
     * filtered on `deletedAt`, but the CURRENT one never was. So opening a voided packing list whose
     * serial also sits on a live one still produced the warning — telling read-only history to fix
     * something it cannot, and implicating a document that has already been withdrawn.
     */
    it("a VOIDED current shipment derives no duplicate warning at all", async () => {
      const { order, s1, first } = await shippedOnce();
      await shipAgain(order, s1.id); // a live shipment now also holds SN-1

      await asSystem(() => voidShipper(first.id, "wrong truck"));

      const voided = await shipmentWarnings(prisma, await getShipper(first.id));
      expect(voided.filter((w) => w.includes("also appears on"))).toEqual([]);
    });

    /**
     * Codex, MR !130 (P2) — one warning per (serial, packing list), not per matched ROW.
     *
     * `replaceShipperSerials` deliberately PRESERVES a released row while adding the new live one
     * (snapshot + release: the shipment still prints that serial). So one packing list can legitimately
     * hold two rows for the same (line, serial) — and a one-for-one map over matches then emitted the
     * identical sentence twice, with more piling up after each further replacement.
     */
    it("emits ONE warning per shipment even when it holds a released and a live row for the serial", async () => {
      const { order, first } = await shippedOnce();

      // Release the first shipment's selection, then re-select the recreated serial ON THAT SAME
      // shipment — leaving it holding both the released snapshot row and a live row.
      await asSystem(() => replaceSerials(order.id, order.lines[0].id, [
        { serial: "SN-1", description: "" },
        { serial: "SN-2", description: "" },
      ]));
      const recreated = await prisma.orderSerial.findFirstOrThrow({
        where: { lineId: order.lines[0].id, serial: "SN-1" },
      });
      const so = await prisma.shipperOrder.findFirstOrThrow({
        where: { shipperId: first.id, orderId: order.id }, select: { id: true },
      });
      await asSystem(() => replaceShipperSerials(first.id, so.id, [
        { orderSerialId: recreated.id, printOnShipper: true },
      ]));
      expect(await prisma.shipperSerial.count({
        where: { shipperOrder: { shipperId: first.id }, serial: "SN-1" },
      })).toBeGreaterThan(1); // the shape only exists because the released row is preserved

      // A LATER shipment of that serial must be told once, not once per row.
      const second = await shipAgain(order, recreated.id);
      const about = second.warnings.filter((w) => w.includes(`Packing List ${first.shipperNumber}`));
      expect(about).toHaveLength(1);
    });

    /**
     * The SQL narrows, the JS pairs — and this is why both are needed (Codex, MR !130).
     *
     * The query filters `lineId IN (…) AND serial IN (…)`, which is a CROSS PRODUCT: it can return
     * a (line A, serial belonging to line B) row that was never asked for. The `wanted` membership
     * check enforces the exact pairing afterwards. Concretely, the same serial NUMBER on a different
     * line — a different order, a different customer, a different part — must never warn, which is
     * the whole reason the key is (line, serial) rather than serial alone.
     */
    it("never warns across lines that merely share a serial NUMBER", async () => {
      const { order, s1 } = await shippedOnce();
      await shipAgain(order, s1.id); // SN-1 genuinely duplicated on this order's line

      // A DIFFERENT order, different customer, whose line also has a serial called "SN-1".
      const { order: other } = await savedOrder({ qty: 10 });
      const otherSerial = await prisma.orderSerial.create({
        data: { orderId: other.id, lineId: other.lines[0].id, position: 1, serial: "SN-1" },
      });
      const shipped = await createShipper({
        customerId: other.customerId, shipDate: "2026-08-07",
        orders: [{
          orderId: other.id,
          lines: [{ orderLineId: other.lines[0].id, qty: 1, weight: "1.00", lineComplete: false }],
          containers: [], serials: [{ orderSerialId: otherSerial.id, printOnShipper: true }],
        }],
      }, { canOverrideCreditHold: false });

      // Its first shipment ever — the matching number on the OTHER order's line is not its problem.
      expect(shipped.warnings.filter((w) => w.includes("also appears on"))).toEqual([]);
    });

    /**
     * THE CROSS-PRODUCT, and why the JS pairing check is not redundant (Codex, MR !130).
     *
     * The query filters `lineId IN (…) AND serial IN (…)`, which is a cross product: with two lines
     * in play it can return a (line 1, SN-B) row when what was actually asked for is (line 1, SN-A)
     * and (line 2, SN-B). Those are DIFFERENT physical parts — a serial number is only unique
     * within its line — so warning on it would be a false positive. `wanted` enforces the exact
     * pairing after SQL has narrowed the candidates.
     *
     * RED-verified: deleting the `wanted` check makes this warn.
     */
    it("does not warn on a cross-product row — (line 1, SN-B) is not (line 2, SN-B)", async () => {
      const { order: base } = await savedOrder({ qty: 10 });
      const order = await addRiderLine(base, { qty: 10, weight: "25.00" });
      const [line1, line2] = order.lines;

      // Line 1 carries BOTH numbers; line 2 reuses SN-B. Legitimate — serials are per line.
      const l1a = await prisma.orderSerial.create({
        data: { orderId: order.id, lineId: line1.id, position: 1, serial: "SN-A" } });
      const l1b = await prisma.orderSerial.create({
        data: { orderId: order.id, lineId: line1.id, position: 2, serial: "SN-B" } });
      const l2b = await prisma.orderSerial.create({
        data: { orderId: order.id, lineId: line2.id, position: 1, serial: "SN-B" } });

      // Shipment 1 sends (line 1, SN-B) — the row that will match both IN lists below.
      await createShipper({
        customerId: order.customerId, shipDate: "2026-08-04",
        orders: [{
          orderId: order.id,
          lines: [{ orderLineId: line1.id, qty: 1, weight: "1.00", lineComplete: false }],
          containers: [], serials: [{ orderSerialId: l1b.id, printOnShipper: true }],
        }],
      }, { canOverrideCreditHold: false });

      // Shipment 2 asks about (line 1, SN-A) and (line 2, SN-B) — neither of which shipped.
      const second = await createShipper({
        customerId: order.customerId, shipDate: "2026-08-06",
        orders: [{
          orderId: order.id,
          lines: [
            { orderLineId: line1.id, qty: 1, weight: "1.00", lineComplete: false },
            { orderLineId: line2.id, qty: 1, weight: "1.00", lineComplete: false },
          ],
          containers: [],
          serials: [
            { orderSerialId: l1a.id, printOnShipper: true },
            { orderSerialId: l2b.id, printOnShipper: true },
          ],
        }],
      }, { canOverrideCreditHold: false });

      expect(second.warnings.filter((w) => w.includes("also appears on"))).toEqual([]);
    });

    it("reaches an EDIT response too, not just creation — the #50/#54 surface", async () => {
      const { order, s1 } = await shippedOnce();
      const second = await shipAgain(order, s1.id);

      // Every mutating shipment route wraps its response through `shipperResponse`, which recomputes
      // the FULL §5.7 surface via `shipmentWarnings` — so proving the warning lives in that one
      // function is what proves it reaches the edit path. An unrelated header edit must still carry
      // it; a warning computed only at creation is half-built (#50/#54).
      await asSystem(() => updateShipper(second.shipper.id, { comments: "re-ship" }));
      const after = await shipmentWarnings(prisma, await getShipper(second.shipper.id));
      expect(after.filter((w) => w.includes("also appears on"))).toHaveLength(1);
    });
  });

  it("audits released serials in a deterministic order — the snapshot key, not the null FK", async () => {
    const { order: base } = await savedOrder({ qty: 10 });
    // Created "SN-B" FIRST, "SN-A" second: an ordering that leans on insertion order stays RED.
    const sB = await prisma.orderSerial.create({
      data: { orderId: base.id, lineId: base.lines[0].id, position: 1, serial: "SN-B" },
    });
    const sA = await prisma.orderSerial.create({
      data: { orderId: base.id, lineId: base.lines[0].id, position: 2, serial: "SN-A" },
    });
    const { shipper } = await createShipper({
      customerId: base.customerId, shipDate: "2026-08-04",
      orders: [{
        orderId: base.id,
        lines: [{ orderLineId: base.lines[0].id, qty: 5, weight: "5.00", lineComplete: false }],
        containers: [],
        serials: [{ orderSerialId: sB.id, printOnShipper: true }, { orderSerialId: sA.id, printOnShipper: true }],
      }],
    }, { canOverrideCreditHold: false });
    await asSystem(() => replaceSerials(base.id, base.lines[0].id, [])); // releases both

    await asSystem(() => updateShipper(shipper.id, { comments: "audited edit" }));
    const [entry] = await readAudit("shipper", shipper.id);
    const after = entry.after as { orders: { serials: { serial: string }[] }[] };
    expect(after.orders[0].serials.map((s) => s.serial)).toEqual(["SN-A", "SN-B"]);
  });

  it("shipper-side container/serial replaces preserve released snapshot rows", async () => {
    const { order: base } = await savedOrder({ qty: 10 });
    const containerType = await prisma.containerType.create({ data: { name: "Basket" } });
    const bin = await prisma.orderContainer.create({
      data: { orderId: base.id, position: 1, typeId: containerType.id, count: 2, customerContainerId: "BIN-9" },
    });
    const serial = await prisma.orderSerial.create({
      data: { orderId: base.id, lineId: base.lines[0].id, position: 1, serial: "SN-88", description: "Heat B2" },
    });
    const { shipper } = await createShipper({
      customerId: base.customerId, shipDate: "2026-08-04",
      orders: [{
        orderId: base.id,
        lines: [{ orderLineId: base.lines[0].id, qty: 5, weight: "5.00", lineComplete: false }],
        containers: [{ orderContainerId: bin.id, count: 2 }],
        serials: [{ orderSerialId: serial.id, printOnShipper: true }],
      }],
    }, { canOverrideCreditHold: false });

    // Order-side replacement releases both shipment rows to their snapshots.
    await asSystem(() => replaceContainers(base.id, []));
    await asSystem(() => replaceSerials(base.id, base.lines[0].id, []));

    // A fresh order-side container the operator now also selects on the shipment.
    const pallet = await prisma.orderContainer.create({
      data: { orderId: base.id, position: 1, typeId: containerType.id, count: 3, customerContainerId: "PAL-1" },
    });
    const so = shipper.orders[0];
    const afterContainers = await replaceShipperContainers(shipper.id, so.id, [{ orderContainerId: pallet.id, count: 3 }]);
    const kept = afterContainers.orders[0].containers;
    // The released Basket row SURVIVES the replace, alongside the new pick.
    expect(kept).toHaveLength(2);
    expect(kept.some((c) => c.orderContainerId === null && c.typeName === "Basket" && c.customerContainerId === "BIN-9")).toBe(true);
    expect(kept.some((c) => c.orderContainerId === pallet.id && c.typeName === "Basket")).toBe(true);

    const afterSerials = await replaceShipperSerials(shipper.id, so.id, []);
    expect(afterSerials.orders[0].serials).toHaveLength(1);
    expect(afterSerials.orders[0].serials[0]).toMatchObject({ orderSerialId: null, serial: "SN-88" });
  });

  // Weights design §7, §9.4 and §12.2, owner ruling W2 (2026-10-09). A shipment container row's
  // tare each is the shipment's own. A later save of the order's Containers, a later change to the
  // container type's default, and the shipment's own later save with no figure named for the row
  // leave it alone.
  describe("a shipment container row keeps its tare each", () => {
    /** One Basket row on the order, 2 containers at a tare each of 42.50, picked on one shipment
     *  with a tare each of 7.25 typed for it. The type's default is 99.00 on purpose. No two of
     *  the three figures are the same, so each case shows which one a row holds. */
    async function shippedBasketRow() {
      const { order: base } = await savedOrder({ qty: 10 });
      const basket = await prisma.containerType.create({ data: { name: "Basket", tareEach: "99.00" } });
      const bin = await prisma.orderContainer.create({
        data: {
          orderId: base.id, position: 1, typeId: basket.id, count: 2, tareEach: "42.50",
          customerContainerId: "BIN-9",
        },
      });
      const { shipper } = await createShipper({
        customerId: base.customerId, shipDate: "2026-08-04",
        orders: [{
          orderId: base.id,
          lines: [{ orderLineId: base.lines[0].id, qty: 5, weight: "5.00", lineComplete: false }],
          containers: [{ orderContainerId: bin.id, count: 2, tareEach: "7.25" }],
          serials: [],
        }],
      }, { canOverrideCreditHold: false });
      return { base, basket, bin, shipper, so: shipper.orders[0] };
    }

    it("when the order's Containers are saved again with another figure (issue #493), and through the shipment's own save after that", async () => {
      const { base, basket, bin, shipper, so } = await shippedBasketRow();

      // The order's Containers are saved again with a corrected tare each. The row is sent with its
      // id, so it is saved in place: the shipment's row stays linked to it, no kept row is made,
      // and it keeps the figure typed on the shipment.
      const resaved = await asSystem(() => replaceContainers(base.id, [
        { id: bin.id, typeId: basket.id, count: 2, tareEach: "55.00", customerContainerId: "BIN-9" },
      ]));
      expect(resaved.containers.map((c) => c.id)).toEqual([bin.id]);
      const linked = (await getShipper(shipper.id)).orders[0].containers;
      expect(linked.map((c) => [c.orderContainerId, c.tareEach])).toEqual([[bin.id, 7.25]]);
      expect(await storedTareEach(so.id)).toEqual(["7.25"]);

      // Nothing is offered again: the order's one row is the one the shipment already holds.
      const held = new Set(linked.map((c) => c.orderContainerId));
      expect(resaved.containers.filter((c) => !held.has(c.id))).toEqual([]);

      // The shipment's own Containers save names the row with no figure. The shipment already
      // holds it, so it keeps 7.25, not the order row's 55.00.
      const after = await replaceShipperContainers(shipper.id, so.id, [{ orderContainerId: bin.id, count: 2 }]);
      expect(after.orders[0].containers.map((c) => [c.orderContainerId, c.tareEach])).toEqual([[bin.id, 7.25]]);
      expect(await storedTareEach(so.id)).toEqual(["7.25"]);
    });

    it("when its container type's default is changed, and through the shipment's own save with no figure named", async () => {
      const { basket, bin, shipper, so } = await shippedBasketRow();

      await prisma.containerType.update({ where: { id: basket.id }, data: { tareEach: "310.00" } });
      expect((await getShipper(shipper.id)).orders[0].containers[0].tareEach).toBe(7.25);
      expect(await storedTareEach(so.id)).toEqual(["7.25"]);

      // Saving the shipment's Containers with no figure named re-creates its linked row with the
      // figure the shipment held. The order's row still holds 42.50 and the type's default is now
      // 310.00: neither is taken.
      await replaceShipperContainers(shipper.id, so.id, [{ orderContainerId: bin.id, count: 1 }]);
      expect(await storedTareEach(so.id)).toEqual(["7.25"]);
    });
  });

  // Issue #493 (owner answers 2026-10-15). The order's Containers save updates a row it names by id
  // in place, so a shipment row linked to it stays linked; only a removed row releases its shipment
  // rows. A changed Type or Cust Cont Id is the same row, and the copy the shipment row keeps
  // (`typeName`, `customerContainerId`) follows it in the same save. Nothing the shipment owns moves.
  describe("an order's Containers save keeps a shipped row linked (#493)", () => {
    async function shippedRow() {
      const { order: base } = await savedOrder({ qty: 10 });
      const basket = await prisma.containerType.create({ data: { name: "Basket" } });
      const crate = await prisma.containerType.create({ data: { name: "Crate" } });
      const bin = await prisma.orderContainer.create({
        data: { orderId: base.id, position: 1, typeId: basket.id, count: 2, tareEach: "42.50", customerContainerId: "BIN-9" },
      });
      const { shipper } = await createShipper({
        customerId: base.customerId, shipDate: "2026-08-04",
        orders: [{
          orderId: base.id,
          lines: [{ orderLineId: base.lines[0].id, qty: 5, weight: "5.00", lineComplete: false }],
          containers: [{ orderContainerId: bin.id, count: 2, tareEach: "7.25" }],
          serials: [],
        }],
      }, { canOverrideCreditHold: false });
      return { base, basket, crate, bin, shipper, so: shipper.orders[0] };
    }

    /** The shipment order's stored container rows, by raw prisma, in position order. */
    const storedCopy = (shipperOrderId: string) => prisma.shipperContainer.findMany({
      where: { shipperOrderId }, orderBy: { position: "asc" },
      select: { orderContainerId: true, typeName: true, customerContainerId: true, count: true, tareEach: true },
    });

    it("a row saved by its id with a new count, Type and Cust Cont Id stays linked, and the shipment's copy follows", async () => {
      const { base, crate, bin, shipper, so } = await shippedRow();

      await asSystem(() => replaceContainers(base.id, [
        { id: bin.id, typeId: crate.id, count: 4, tareEach: "42.50", customerContainerId: "BIN-10" },
      ]));

      const [row] = (await getShipper(shipper.id)).orders[0].containers;
      expect(row).toMatchObject({
        orderContainerId: bin.id, typeName: "Crate", customerContainerId: "BIN-10", count: 2, tareEach: 7.25,
      });
      const [copy] = await storedCopy(so.id);
      expect(copy.orderContainerId).toBe(bin.id);
      expect(copy.typeName).toBe("Crate");
      expect(copy.customerContainerId).toBe("BIN-10");
      expect(copy.count).toBe(2);
      expect(copy.tareEach?.toFixed(2)).toBe("7.25");
    });

    it("a row saved by its id with neither its Type nor its Cust Cont Id changed leaves the shipment's copy alone", async () => {
      const { base, basket, bin, so } = await shippedRow();
      // A copy that differs from the order row, so a write of it would show.
      await prisma.shipperContainer.updateMany({ where: { shipperOrderId: so.id }, data: { typeName: "As shipped" } });

      await asSystem(() => replaceContainers(base.id, [
        { id: bin.id, typeId: basket.id, count: 4, tareEach: "50.00", customerContainerId: "BIN-9" },
      ]));

      const [copy] = await storedCopy(so.id);
      expect(copy).toMatchObject({ orderContainerId: bin.id, typeName: "As shipped", customerContainerId: "BIN-9", count: 2 });
    });

    // Each half of the condition on its own. A changed Type writes the copy's type name, and a
    // changed Cust Cont Id writes the copy's Cust Cont Id; the save writes both fields of the copy
    // from the order row as it now is, so the other field reads the row's own, unchanged value.
    it("a row saved by its id with only its Type changed writes the copy's type name", async () => {
      const { base, crate, bin, so } = await shippedRow();

      await asSystem(() => replaceContainers(base.id, [
        { id: bin.id, typeId: crate.id, count: 2, tareEach: "42.50", customerContainerId: "BIN-9" },
      ]));

      const [copy] = await storedCopy(so.id);
      expect(copy).toMatchObject({ orderContainerId: bin.id, typeName: "Crate", customerContainerId: "BIN-9", count: 2 });
    });

    it("a row saved by its id with only its Cust Cont Id changed writes the copy's Cust Cont Id", async () => {
      const { base, basket, bin, so } = await shippedRow();

      await asSystem(() => replaceContainers(base.id, [
        { id: bin.id, typeId: basket.id, count: 2, tareEach: "42.50", customerContainerId: "BIN-10" },
      ]));

      const [copy] = await storedCopy(so.id);
      expect(copy).toMatchObject({ orderContainerId: bin.id, typeName: "Basket", customerContainerId: "BIN-10", count: 2 });
    });

    it("a row the save does not name releases its shipment row, which keeps its copy", async () => {
      const { base, crate, bin, shipper, so } = await shippedRow();

      await asSystem(() => replaceContainers(base.id, [{ typeId: crate.id, count: 1, customerContainerId: "NEW-1" }]));

      expect(await prisma.orderContainer.findUnique({ where: { id: bin.id } })).toBeNull();
      const [row] = (await getShipper(shipper.id)).orders[0].containers;
      expect(row).toMatchObject({
        orderContainerId: null, typeName: "Basket", customerContainerId: "BIN-9", count: 2, tareEach: 7.25,
      });
      const [copy] = await storedCopy(so.id);
      expect(copy).toMatchObject({ orderContainerId: null, typeName: "Basket", customerContainerId: "BIN-9" });
    });
  });

  it("replaceSerials keeps working on a line a live shipment's serials reference, and the shipment keeps the serial", async () => {
    const { order: base } = await savedOrder({ qty: 10 });
    const serial = await prisma.orderSerial.create({
      data: { orderId: base.id, lineId: base.lines[0].id, position: 1, serial: "SN-77", description: "Heat A1" },
    });
    const { shipper } = await createShipper({
      customerId: base.customerId, shipDate: "2026-08-04",
      orders: [{
        orderId: base.id,
        lines: [{ orderLineId: base.lines[0].id, qty: 5, weight: "5.00", lineComplete: false }],
        containers: [],
        serials: [{ orderSerialId: serial.id, printOnShipper: true }],
      }],
    }, { canOverrideCreditHold: false });

    await expect(asSystem(() => replaceSerials(base.id, base.lines[0].id, []))).resolves.toBeTruthy();

    const detail = await getShipper(shipper.id);
    expect(detail.orders[0].serials).toHaveLength(1);
    expect(detail.orders[0].serials[0].serial).toBe("SN-77");
    expect(detail.orders[0].serials[0].description).toBe("Heat A1");
    expect(detail.orders[0].serials[0].orderSerialId).toBeNull();
  });
});
