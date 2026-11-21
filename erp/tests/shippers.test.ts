import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { storedTareEach } from "./helpers/shipment-rows";
import { runWithContext } from "@/server/context";
import { readAudit } from "@/server/audit";
import { createOrder, getOrder, updateOrder, updateLine, type OrderDetail } from "@/server/orders";
import {
  createShipper, getShipper, voidShipper, reverseShipper, replaceShipperLines, readShippingTicketData, ticketSettings,
  type ShipperCreateResult,
} from "@/server/shippers";
import { SUPERSEDED_CLOSE_SHORT_REASON } from "@/server/ship-ledger";
import { createInvoice, finalizeInvoice, getInvoice } from "@/server/invoices";
import { reportTurnaround, type TurnaroundDetailRow } from "@/server/reports/turnaround";
import type { Customer, Part } from "../prisma/generated/prisma/client";
import type { CertScopeValue } from "@/lib/cert-constants";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let customerSeq = 0;
async function makeCustomer(opts: { creditHold?: boolean } = {}): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({
    data: { code: `C${customerSeq}`, name: `Customer ${customerSeq}`, creditHold: opts.creditHold ?? false },
  });
}

let partSeq = 0;
async function makePart(customerId: string, opts: {
  certRequired?: boolean | null; certScope?: CertScopeValue | null; serializationRequired?: boolean;
} = {}): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({
    data: {
      customerId, partNumber: `P-${partSeq}`, eachWeight: "1.0000",
      certRequired: opts.certRequired ?? null, certScope: opts.certScope ?? null,
      serializationRequired: opts.serializationRequired ?? false,
    },
  });
}

/** Gives a part revision 1 with one step — the orderability precondition createOrder enforces
 *  (spec §5.3), the certs.test.ts/ship-ledger.test.ts precedent. */
async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `HT-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

/** A live, orderable customer + part, and the ORDER created from it (the certs.test.ts
 *  `savedOrder` precedent). `certScope` defaults to `"LOAD"`, not `null` (which would resolve to
 *  the plant default, `"ORDER"`), whenever `certRequired` is requested: orders.ts's own
 *  `saveNewOrder` creates an ORDER-scope cert automatically at save, which would leave nothing
 *  "missing" for the missing-cert warning tests below to observe. LOAD-scope certs are the one
 *  scope Phase 4 never creates eagerly (spec §6.2, owner ruling §3.17) — the scope that actually
 *  produces the gap spec §5.7's first warning describes. */
async function savedOrder(opts: {
  creditHold?: boolean; certRequired?: boolean; certScope?: CertScopeValue; serializationRequired?: boolean;
  qty?: number; weight?: string; poNumber?: string;
} = {}): Promise<{ order: OrderDetail; part: Part; customer: Customer }> {
  const customer = await makeCustomer({ creditHold: opts.creditHold });
  const part = await makePart(customer.id, {
    certRequired: opts.certRequired ?? null,
    certScope: opts.certRequired ? (opts.certScope ?? "LOAD") : (opts.certScope ?? null),
    serializationRequired: opts.serializationRequired,
  });
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id,
    poNumber: opts.poNumber ?? "",
    lines: [{ partId: part.id, qty: opts.qty ?? 10, weight: opts.weight ?? "25.00" }],
  }));
  return { order, part, customer };
}

/** An order with TWO lines — the add-line picker's own fixture: one line goes on the shipment and
 *  the OTHER stays a candidate for it, which is the case task-14-brief.md's "prefilled to the
 *  remainder" actually turns on (a candidate already partly shipped elsewhere). `savedOrder` above
 *  only ever makes a single-line order, so the candidate case has no fixture without this one. */
async function twoLineOrder(): Promise<{ order: OrderDetail; customer: Customer }> {
  const customer = await makeCustomer();
  const firstPart = await makePart(customer.id);
  const secondPart = await makePart(customer.id);
  await giveSteps(firstPart.id);
  await giveSteps(secondPart.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id,
    lines: [
      { partId: firstPart.id, qty: 10, weight: "25.00" },
      { partId: secondPart.id, qty: 8, weight: "12.00" },
    ],
  }));
  return { order, customer };
}

/** Shape of one `createShipper` input's container/serial entries — typed properly (not
 *  `unknown[]`) so the tests that mutate `input.orders[0].containers`/`.serials` in place stay
 *  type-checked rather than opting out of it (Task 8 review, 2026-08-04). */
type ShipContainerInput = { orderContainerId: string; count: number; tareEach?: number | string | null };
type ShipSerialInput = { orderSerialId: string; printOnShipper?: boolean };

/** The minimal legal `createShipper` input for one order, shipping its one lead line in full —
 *  no containers, no serials. */
function oneOrderInput(order: OrderDetail) {
  return {
    customerId: order.customerId,
    shipDate: "2026-08-04",
    orders: [{
      orderId: order.id,
      lines: [{
        orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight,
        lineComplete: false,
      }],
      containers: [] as ShipContainerInput[],
      serials: [] as ShipSerialInput[],
    }],
  };
}

/** `oneOrderInput` with the caller choosing which of the order's lines ship, and how much — the
 *  multi-line/multi-shipment fixture the ledger tests below need. */
function shipmentOf(order: OrderDetail, lines: { orderLineId: string; qty: number; weight: number }[]) {
  return {
    customerId: order.customerId,
    shipDate: "2026-08-04",
    orders: [{
      orderId: order.id,
      lines: lines.map((l) => ({ ...l, lineComplete: false })),
      containers: [] as ShipContainerInput[],
      serials: [] as ShipSerialInput[],
    }],
  };
}

/** `oneOrderInput`, but the one line ships zero quantity — the "a document about nothing is not a
 *  shipment" refusal (spec §4.2). */
function zeroQtyInput(order: OrderDetail) {
  return {
    customerId: order.customerId,
    shipDate: "2026-08-04",
    orders: [{
      orderId: order.id,
      lines: [{ orderLineId: order.lines[0].id, qty: 0, weight: 0, lineComplete: false }],
      containers: [] as ShipContainerInput[],
      serials: [] as ShipSerialInput[],
    }],
  };
}

describe("createShipper", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("blocks a customer on credit hold and names them", async () => {
    const { order, customer } = await savedOrder({ creditHold: true });
    await expect(createShipper(oneOrderInput(order), { canOverrideCreditHold: false }))
      .rejects.toThrow(new RegExp(`${customer.name}.*credit hold`, "i"));
  });

  it("allows the override with a reason and records it in the audit entry", async () => {
    const { order } = await savedOrder({ creditHold: true });
    const { shipper } = await createShipper(
      { ...oneOrderInput(order), creditHoldReason: "owner approved, cheque in hand" },
      { canOverrideCreditHold: true });
    const entry = await prisma.auditLog.findFirst({ where: { entity: "shipper", entityId: shipper.id } });
    expect(JSON.stringify(entry)).toContain("cheque in hand");
  });

  it("refuses the override with a blank reason", async () => {
    const { order } = await savedOrder({ creditHold: true });
    await expect(createShipper({ ...oneOrderInput(order), creditHoldReason: "  " },
      { canOverrideCreditHold: true })).rejects.toThrow(/reason/i);
  });

  it("returns the first shipment for a repeated clientRequestId", async () => {
    const { order } = await savedOrder();
    const input = { ...oneOrderInput(order), clientRequestId: "nonce-1" };
    const a = await createShipper(input, { canOverrideCreditHold: false });
    const b = await createShipper(input, { canOverrideCreditHold: false });
    expect(b.deduped).toBe(true);
    expect(b.shipper.id).toBe(a.shipper.id);
    expect(await prisma.shipper.count()).toBe(1);
  });

  it("recomputes creation warnings on an idempotent replay (#50)", async () => {
    const { order } = await savedOrder({ certRequired: true }); // LOAD default — no cert exists
    const input = { ...oneOrderInput(order), clientRequestId: "nonce-warn" };
    const a = await createShipper(input, { canOverrideCreditHold: false });
    expect(a.warnings.join(" ")).toMatch(/requires a certification/i);

    // The lost-response retry the nonce exists for must not silently drop the advisory surface.
    const b = await createShipper(input, { canOverrideCreditHold: false });
    expect(b.deduped).toBe(true);
    expect(b.warnings.join(" ")).toMatch(/requires a certification/i);
  });

  it("warns without blocking on a missing cert and unserialised lines", async () => {
    const { order } = await savedOrder({ certRequired: true, serializationRequired: true });
    const { warnings } = await createShipper(oneOrderInput(order), { canOverrideCreditHold: false });
    expect(warnings.join(" ")).toMatch(/requires a certification/i);
    expect(warnings.join(" ")).toMatch(/no serial numbers/i);
  });

  it("warns when the REQUIRED scope's cert is missing though a stale other-scope cert is live (#53)", async () => {
    // ORDER cert auto-created at order save; the scope override to LOAD leaves it live (that is
    // deliberate) — but it must not satisfy a LOAD requirement nothing has created yet.
    const { order } = await savedOrder({ certRequired: true, certScope: "ORDER" });
    await asSystem(() => updateOrder(order.id, { certScope: "LOAD" }));
    const { warnings } = await createShipper(oneOrderInput(order), { canOverrideCreditHold: false });
    expect(warnings.join(" ")).toMatch(/requires a certification/i);
  });

  it("refuses a shipment with no positive quantity", async () => {
    const { order } = await savedOrder();
    await expect(createShipper(zeroQtyInput(order), { canOverrideCreditHold: false }))
      .rejects.toThrow(/at least one line/i);
  });

  it("does not warn once a serial is selected for a serialization-required line", async () => {
    const { order } = await savedOrder({ serializationRequired: true });
    const serial = await prisma.orderSerial.create({
      data: { orderId: order.id, lineId: order.lines[0].id, position: 1, serial: "S-1", description: "" },
    });
    const input = oneOrderInput(order);
    input.orders[0].serials = [{ orderSerialId: serial.id, printOnShipper: true }];
    const { warnings } = await createShipper(input, { canOverrideCreditHold: false });
    expect(warnings.join(" ")).not.toMatch(/no serial numbers/i);
  });

  it("warns, but still saves, when a line ships more than its remaining quantity", async () => {
    const { order } = await savedOrder({ qty: 10 });
    const input = oneOrderInput(order);
    input.orders[0].lines[0].qty = 999;
    const { warnings, shipper } = await createShipper(input, { canOverrideCreditHold: false });
    // The whole sentence. Each weight is as the server prints it. The two `\d+` are the fixture's.
    expect(warnings).toContainEqual(expect.stringMatching(
      /^Order #\d+ line 1 \(P-\d+\): shipping 999 \/ \S+ lb exceeds the remaining 10 \/ \S+ lb on this line$/));
    expect(shipper.orders[0].lines[0].qty).toBe(999);
  });

  // #508: the remaining weight is worked out in whole cents and the sentence prints the screens' figures.
  it("prints the over-ship warning grouped, with two decimals on every weight", async () => {
    const { order, part } = await savedOrder({ qty: 1000, weight: "1299.90" });
    const input = oneOrderInput(order);
    input.orders[0].lines[0].qty = 1200;
    input.orders[0].lines[0].weight = 1562.5;
    const { warnings } = await createShipper(input, { canOverrideCreditHold: false });
    expect(warnings).toContain(
      `Order #${order.orderNumber} line 1 (${part.partNumber}): shipping 1,200 / 1,562.50 lb ` +
      "exceeds the remaining 1,000 / 1,299.90 lb on this line");
  });

  it("does not warn when a line ships exactly the remaining weight (25.00 less 12.10 is 12.90)", async () => {
    const { order } = await savedOrder({ qty: 10, weight: "25.00" });
    const line = order.lines[0].id;
    await createShipper(shipmentOf(order, [{ orderLineId: line, qty: 5, weight: 12.1 }]),
      { canOverrideCreditHold: false });
    const { warnings } = await createShipper(shipmentOf(order, [{ orderLineId: line, qty: 5, weight: 12.9 }]),
      { canOverrideCreditHold: false });
    expect(warnings.join(" ")).not.toMatch(/exceeds the remaining/);
  });

  // 30 - 17.1 is 12.899999999999999 in floating point, so subtracting weights as numbers made
  // shipping exactly the remaining 12.90 a false warning.
  it("does not warn on exactly the remaining weight where float subtraction falls a hair short (30.00 less 17.10)", async () => {
    const { order } = await savedOrder({ qty: 10, weight: "30.00" });
    const line = order.lines[0].id;
    await createShipper(shipmentOf(order, [{ orderLineId: line, qty: 5, weight: 17.1 }]),
      { canOverrideCreditHold: false });
    const { warnings } = await createShipper(shipmentOf(order, [{ orderLineId: line, qty: 5, weight: 12.9 }]),
      { canOverrideCreditHold: false });
    expect(warnings.join(" ")).not.toMatch(/exceeds the remaining/);
  });

  it("warns one cent over the remaining weight", async () => {
    const { order, part } = await savedOrder({ qty: 10, weight: "25.00" });
    const line = order.lines[0].id;
    const label = `Order #${order.orderNumber} line 1 (${part.partNumber})`;
    const first = await createShipper(shipmentOf(order, [{ orderLineId: line, qty: 5, weight: 12.1 }]),
      { canOverrideCreditHold: false });
    expect(first.warnings).toEqual([]);
    const over = await createShipper(shipmentOf(order, [{ orderLineId: line, qty: 5, weight: 12.91 }]),
      { canOverrideCreditHold: false });
    expect(over.warnings).toContain(
      `${label}: shipping 5 / 12.91 lb exceeds the remaining 5 / 12.90 lb on this line`);
  });

  it("prints a negative remaining weight as -5.00", async () => {
    const { order, part } = await savedOrder({ qty: 10, weight: "25.00" });
    const line = order.lines[0].id;
    // 12.10 + 17.90 = 30.00 shipped against 25.00 ordered (the second warns, and still saves).
    await createShipper(shipmentOf(order, [{ orderLineId: line, qty: 5, weight: 12.1 }]),
      { canOverrideCreditHold: false });
    await createShipper(shipmentOf(order, [{ orderLineId: line, qty: 5, weight: 17.9 }]),
      { canOverrideCreditHold: false });
    const { warnings } = await createShipper(shipmentOf(order, [{ orderLineId: line, qty: 1, weight: 1 }]),
      { canOverrideCreditHold: false });
    expect(warnings).toContain(
      `Order #${order.orderNumber} line 1 (${part.partNumber}): shipping 1 / 1.00 lb exceeds the remaining ` +
      "0 / -5.00 lb on this line");
  });

  it("creates a SHIPMENT-scope cert for every order whose resolved scope is SHIPMENT, and none otherwise", async () => {
    const withShipmentCert = await savedOrder({ certRequired: true, certScope: "SHIPMENT" });
    const withoutCert = await savedOrder();

    const { shipper: a } = await createShipper(oneOrderInput(withShipmentCert.order), { canOverrideCreditHold: false });
    expect(await prisma.cert.count({ where: { orderId: withShipmentCert.order.id, shipperId: a.id } })).toBe(1);

    const { shipper: b } = await createShipper(oneOrderInput(withoutCert.order), { canOverrideCreditHold: false });
    expect(await prisma.cert.count({ where: { shipperId: b.id } })).toBe(0);
  });

  it("moves the order to PARTIAL_SHIPPED and stamps sequence 1 and label", async () => {
    const { order } = await savedOrder({ qty: 10 });
    const input = oneOrderInput(order);
    input.orders[0].lines[0].qty = 9; // one short of the ordered 10, so the order is only partly shipped
    const { shipper } = await createShipper(input, { canOverrideCreditHold: false });
    expect(shipper.orders[0].sequence).toBe(1);
    expect(shipper.orders[0].label).toBe(`${order.orderNumber}-1`);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
    expect(after.status).toBe("PARTIAL_SHIPPED");
  });

  it("refuses an unknown order", async () => {
    const { order } = await savedOrder();
    const input = oneOrderInput(order);
    input.orders[0].orderId = "nope";
    await expect(createShipper(input, { canOverrideCreditHold: false })).rejects.toThrow(/not found/i);
  });

  it("refuses a line that does not belong to the named order", async () => {
    const a = await savedOrder();
    const b = await savedOrder();
    const input = oneOrderInput(a.order);
    input.orders[0].lines[0].orderLineId = b.order.lines[0].id;
    await expect(createShipper(input, { canOverrideCreditHold: false }))
      .rejects.toThrow(/does not belong/i);
  });

  // A repeated child id within one order must be refused BY NAME, in the service — never left to
  // fall through to the database's `@@unique` constraint, where `withDbErrors`' generic
  // `conflictField: "shipper number"` would mislabel it as a numbering collision (Task 8 review,
  // 2026-08-04).
  it("refuses a duplicate order line within one shipment, naming it", async () => {
    const { order } = await savedOrder({ qty: 10 });
    const input = oneOrderInput(order);
    input.orders[0].lines.push({ ...input.orders[0].lines[0] });
    await expect(createShipper(input, { canOverrideCreditHold: false }))
      .rejects.toThrow(/line 1.*listed twice/i);
  });

  it("refuses a duplicate container within one shipment, naming it", async () => {
    const { order } = await savedOrder();
    const containerType = await prisma.containerType.create({ data: { name: "Basket" } });
    const container = await prisma.orderContainer.create({
      data: { orderId: order.id, position: 1, typeId: containerType.id, count: 2 },
    });
    const input = oneOrderInput(order);
    input.orders[0].containers = [
      { orderContainerId: container.id, count: 1 },
      { orderContainerId: container.id, count: 1 },
    ];
    await expect(createShipper(input, { canOverrideCreditHold: false }))
      .rejects.toThrow(/Basket.*listed twice/i);
  });

  it("refuses a duplicate serial within one shipment, naming it", async () => {
    const { order } = await savedOrder();
    const serial = await prisma.orderSerial.create({
      data: { orderId: order.id, lineId: order.lines[0].id, position: 1, serial: "S-42", description: "" },
    });
    const input = oneOrderInput(order);
    input.orders[0].serials = [{ orderSerialId: serial.id }, { orderSerialId: serial.id }];
    await expect(createShipper(input, { canOverrideCreditHold: false }))
      .rejects.toThrow(/S-42.*listed twice/i);
  });

  it("writes a create audit entry naming the customer by code, not only by cuid", async () => {
    const { order, customer } = await savedOrder();
    const { shipper } = await createShipper(oneOrderInput(order), { canOverrideCreditHold: false });
    const [entry] = await readAudit("shipper", shipper.id);
    expect(entry.action).toBe("create");
    // The cuid legitimately still rides along (`customerId`, a real reference) — the point is
    // that a human-readable name is ALSO present, not that the id is scrubbed.
    expect((entry.after as { customerCode?: string }).customerCode).toBe(customer.code);
    expect((entry.after as { customerName?: string }).customerName).toBe(customer.name);
  });

  // ---------------------------------------------------------------------------------------
  // Concurrency (spec §5.3, task-8-brief.md Step 7). Both drive `createShipper` itself — the
  // real public API, always Serializable — rather than a manually-opened `tx`: createShipper
  // takes no `tx` parameter (unlike createCert), so there is no way to reproduce certs.test.ts's
  // Read-Committed-holder trick against this function without changing its public signature. See
  // the task report for the hand-verified RED/GREEN transcripts of swapping `claimOrdersInOrder`
  // for an unsorted per-id loop in `saveNewShipper`'s own call site.
  // ---------------------------------------------------------------------------------------

  // Two genuinely concurrent creates through the PUBLIC API, both Serializable, racing on the
  // SAME order row AND the same `shipper_number_next` counter row — both are FOR UPDATE row
  // locks, so the two transactions serialize rather than corrupt each other, but Postgres's own
  // SSI can still abort the second-to-commit side with a 40001 the instant it detects the
  // resulting read/write dependency (`createOrder`'s own docstring, orders.ts, and the
  // `orders.test.ts` `createConcurrently` precedent this file's `ship-ledger.test.ts` sibling
  // cites: "documents this exact, expected 409"). The number/sequence pair is never corrupted
  // either way — this is the `certs.test.ts` "supplementary, production-shape confirmation"
  // shape, not a deterministic row-lock regression guard (see that file's own comment on why): it
  // proves two real double-submits can't duplicate a number or a sequence, honestly allowing for
  // the legitimate 409 retry signal on the losing side.
  it("two concurrent shipments against the SAME order both succeed with distinct packing-list numbers and sequences (not a deterministic row-lock regression guard — see comment)", async () => {
    const { order } = await savedOrder({ qty: 20 });
    const input = oneOrderInput(order);
    input.orders[0].lines[0].qty = 5;

    const settled = await Promise.allSettled([
      createShipper(input, { canOverrideCreditHold: false }),
      createShipper(input, { canOverrideCreditHold: false }),
    ]);

    // Since #115 `createShipper` wraps its save in `retryAllocation`, so the counter-race loser
    // re-runs inside the request instead of surfacing the 409 this test used to tolerate. Both must
    // now succeed — and the paired assertions below are no longer conditional on that having
    // happened, which is what stops this passing vacuously if the retry is ever unwrapped.
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected.map((r) => String(r.reason))).toEqual([]);
    const fulfilled = settled as PromiseFulfilledResult<ShipperCreateResult>[];
    expect(fulfilled).toHaveLength(2);
    expect(fulfilled[0].value.shipper.shipperNumber).not.toBe(fulfilled[1].value.shipper.shipperNumber);
    expect(fulfilled[0].value.shipper.orders[0].sequence).not.toBe(fulfilled[1].value.shipper.orders[0].sequence);
  });

  // The hazard spec §5.3 names directly: two multi-order saves touching {A,B} and {B,A} deadlock
  // if each claims its orders in its OWN (caller) order. `createShipper` claims through
  // `claimOrdersInOrder` (order-locks.ts), already proven deadlock-free by
  // ship-ledger.test.ts's own `claimOrdersInOrder` suite; this test proves THIS service's call
  // site actually uses it, rather than looping `claimOrder` per id in caller order.
  //
  // Verified by hand both ways (task-8 review, 2026-08-04), against a temporary probe that
  // swapped `claimOrdersInOrder` for the exact anti-pattern spec §5.3 names — an unsorted loop of
  // per-id `claimOrder` calls in caller order:
  //  - WITH a 50ms delay inserted between the loop's two claims (to force the interleaving
  //    window open): reliably RED — a genuine Postgres `deadlock detected` (40P01), untranslated,
  //    would surface as a 500 in production.
  //  - WITHOUT that delay: GREEN 5/5 repeats. This local Postgres is fast enough that one side's
  //    whole two-statement loop usually finishes before the other side's first statement lands,
  //    so the naive loop alone is not a reliable trigger — the identical finding
  //    `ship-ledger.test.ts`'s own `claimOrdersInOrder` suite already documented for this exact
  //    shape one level down ("Reproducing it needed a short artificial delay... the plain swap
  //    alone was NOT a reliable RED on its own").
  // This test therefore is NOT a deterministic row-lock regression guard on its own in this
  // environment — an unsorted-loop regression could land here and stay green under ordinary,
  // undelayed CI timing. It is titled accordingly, per the two existing precedents
  // (tests/certs.test.ts:187, tests/ship-ledger.test.ts:290).
  it("two multi-order shipments over {A,B} and {B,A} both complete without deadlocking or a 500 (not a deterministic row-lock regression guard without artificial delay — see comment)", async () => {
    const a = await savedOrder({ qty: 20 });
    // A second order for a's own customer, so a single shipment can legally cover both.
    const bSameCustomer = await (async () => {
      const part = await makePart(a.customer.id);
      await giveSteps(part.id);
      const { order } = await asSystem(() => createOrder({
        customerId: a.customer.id, lines: [{ partId: part.id, qty: 10, weight: "5.00" }],
      }));
      return order;
    })();

    const inputAB = {
      customerId: a.customer.id, shipDate: "2026-08-04",
      orders: [
        { orderId: a.order.id, lines: [{ orderLineId: a.order.lines[0].id, qty: 1, weight: "1.00", lineComplete: false }], containers: [], serials: [] },
        { orderId: bSameCustomer.id, lines: [{ orderLineId: bSameCustomer.lines[0].id, qty: 1, weight: "1.00", lineComplete: false }], containers: [], serials: [] },
      ],
    };
    const inputBA = {
      customerId: a.customer.id, shipDate: "2026-08-04",
      orders: [
        { orderId: bSameCustomer.id, lines: [{ orderLineId: bSameCustomer.lines[0].id, qty: 1, weight: "1.00", lineComplete: false }], containers: [], serials: [] },
        { orderId: a.order.id, lines: [{ orderLineId: a.order.lines[0].id, qty: 1, weight: "1.00", lineComplete: false }], containers: [], serials: [] },
      ],
    };

    const settled = await Promise.allSettled([
      createShipper(inputAB, { canOverrideCreditHold: false }),
      createShipper(inputBA, { canOverrideCreditHold: false }),
    ]);

    // Both must complete. A deadlock — the hazard this test exists to rule out — would hang or
    // surface as an unretryable 40P01, and `retryAllocation` deliberately does NOT absorb that
    // (`isRetryableConflict` matches 40001/P2034/P2002 only), so a real ABBA deadlock still reds this
    // rather than being papered over by the retry. Since #115 the counter-race loser re-runs inside
    // the request, so "one of them may legitimately 409" is no longer an acceptable outcome here.
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected.map((r) => String(r.reason))).toEqual([]);
  });
});

// Final review 2026-10-06: the close-short flag is normalised where it is STORED, not only on the
// screens. A tick on a row that finishes its line by quantity would otherwise keep the line
// complete after the ordered quantity is later raised.
describe("createShipper stores the close-short flag only on a row that ships short", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  const storedFlags = async (shipperId: string) =>
    (await prisma.shipperLine.findMany({
      where: { shipperOrder: { shipperId } }, select: { lineComplete: true }, orderBy: { position: "asc" },
    })).map((l) => l.lineComplete);

  it("stores a ticked row unticked when it ships the full remaining quantity", async () => {
    const { order } = await savedOrder({ qty: 10 });
    const line = order.lines[0];
    // 4 of 10 on a first shipment, so "remaining" is 6 and other shipments are counted.
    await createShipper(shipmentOf(order, [{ orderLineId: line.id, qty: 4, weight: 10 }]), { canOverrideCreditHold: false });
    const input = shipmentOf(order, [{ orderLineId: line.id, qty: 6, weight: 15 }]);
    input.orders[0].lines[0].lineComplete = true;
    const { shipper } = await createShipper(input, { canOverrideCreditHold: false });

    expect(shipper.orders[0].lines[0].lineComplete).toBe(false);
    expect(await storedFlags(shipper.id)).toEqual([false]);
    // The audit entry records what was stored, not what was sent.
    const [entry] = await readAudit("shipper", shipper.id);
    expect((entry.after as { orders: { lines: { lineComplete: boolean }[] }[] }).orders[0].lines[0].lineComplete)
      .toBe(false);
    expect((await getOrder(order.id)).status).toBe("SHIPPED"); // complete by quantity alone
  });

  it("keeps a ticked row ticked when it ships short", async () => {
    const { order } = await savedOrder({ qty: 10 });
    const input = shipmentOf(order, [{ orderLineId: order.lines[0].id, qty: 9, weight: 22 }]);
    input.orders[0].lines[0].lineComplete = true;
    const { shipper } = await createShipper(input, { canOverrideCreditHold: false });

    expect(await storedFlags(shipper.id)).toEqual([true]);
    expect((await getOrder(order.id)).status).toBe("SHIPPED"); // closed short
  });

  it("keeps a ticked zero-quantity row ticked on a line that is still short", async () => {
    const { order } = await twoLineOrder();
    const [lineA, lineB] = order.lines;
    const input = shipmentOf(order, [
      { orderLineId: lineA.id, qty: 10, weight: 25 },
      { orderLineId: lineB.id, qty: 0, weight: 0 },
    ]);
    input.orders[0].lines[1].lineComplete = true;
    const { shipper } = await createShipper(input, { canOverrideCreditHold: false });

    expect(await storedFlags(shipper.id)).toEqual([false, true]);
  });
});

// Owner ruling 2026-10-06 (ruling 3): a close short that a later shipment (or a quantity correction)
// has made unnecessary is cleared automatically. Left set, it would keep the line complete after the
// ordered quantity is later raised. `clearSupersededCloseShorts` runs at the start of every
// `recomputeOrderStatus`, so these go through the real shipment and order-line mutators.
describe("a close short that is no longer needed is cleared", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  type Snap = { orders?: { lines?: { id: string; lineComplete: boolean }[] }[] } | null;
  const flagOf = async (shipperLineId: string) =>
    (await prisma.shipperLine.findUniqueOrThrow({ where: { id: shipperLineId } })).lineComplete;
  const updatesOn = (shipperId: string) =>
    prisma.auditLog.findMany({ where: { entity: "shipper", entityId: shipperId, action: "update" }, orderBy: { at: "asc" } });

  /** Ships `qty` of the order's first line, ticked Close short when `closeShort`. */
  async function ship(order: OrderDetail, qty: number, closeShort = false, shipDate = "2026-08-04") {
    const input = { ...shipmentOf(order, [{ orderLineId: order.lines[0].id, qty, weight: qty }]), shipDate };
    input.orders[0].lines[0].lineComplete = closeShort;
    const { shipper } = await createShipper(input, { canOverrideCreditHold: false });
    return { shipper, lineId: shipper.orders[0].lines[0].id };
  }

  it("clears the first shipment's tick when a second shipment sends the last piece, audited on the FIRST shipment", async () => {
    const { order } = await savedOrder({ qty: 10 });
    const first = await ship(order, 9, true);
    expect(await flagOf(first.lineId)).toBe(true);
    expect((await getOrder(order.id)).status).toBe("SHIPPED"); // closed short

    const second = await asSystem(() => ship(order, 1));

    expect(await flagOf(first.lineId)).toBe(false);
    expect((await getOrder(order.id)).status).toBe("SHIPPED"); // by quantity now
    // One update entry, on the shipment that OWNS the row, showing the flag flip.
    const entries = await updatesOn(first.shipper.id);
    expect(entries).toHaveLength(1);
    const lineIn = (snap: Snap) => snap?.orders?.flatMap((o) => o.lines ?? []).find((l) => l.id === first.lineId);
    expect(lineIn(entries[0].before as Snap)?.lineComplete).toBe(true);
    expect(lineIn(entries[0].after as Snap)?.lineComplete).toBe(false);
    // Nobody clicked anything, so the entry carries the fixed reason that explains it.
    expect(entries[0].reason).toBe(SUPERSEDED_CLOSE_SHORT_REASON);
    expect(SUPERSEDED_CLOSE_SHORT_REASON).toBe("Close short cleared: the line reached its ordered quantity");
    // Nothing was written on the second shipment beyond its own create.
    expect(await updatesOn(second.shipper.id)).toHaveLength(0);
  });

  it("then reopens the order when the ordered quantity is raised past what shipped", async () => {
    const { order } = await savedOrder({ qty: 10 });
    await ship(order, 9, true);
    await ship(order, 1);
    await asSystem(() => updateLine(order.id, order.lines[0].id, { qty: 12 }));
    // The case the ruling exists for: with the stale tick left on the first shipment this is SHIPPED.
    expect((await getOrder(order.id)).status).toBe("PARTIAL_SHIPPED");
  });

  it("keeps the tick on a line that is still short after a later shipment", async () => {
    const { order } = await savedOrder({ qty: 10 });
    const first = await ship(order, 7, true);
    await ship(order, 2);
    expect(await flagOf(first.lineId)).toBe(true); // 9 of 10: still closed short
    expect((await getOrder(order.id)).status).toBe("SHIPPED");
    expect(await updatesOn(first.shipper.id)).toHaveLength(0);
    // And the tick is still what holds it: raising the quantity does not reopen a closed-short line.
    await asSystem(() => updateLine(order.id, order.lines[0].id, { qty: 12 }));
    expect(await flagOf(first.lineId)).toBe(true);
    expect((await getOrder(order.id)).status).toBe("SHIPPED");
  });

  it("clears the tick when the ordered quantity is corrected down to what shipped", async () => {
    const { order } = await savedOrder({ qty: 10 });
    const first = await ship(order, 9, true);
    await asSystem(() => updateLine(order.id, order.lines[0].id, { qty: 9 }));
    expect(await flagOf(first.lineId)).toBe(false);
    expect((await getOrder(order.id)).status).toBe("SHIPPED"); // complete by quantity
    expect(await updatesOn(first.shipper.id)).toHaveLength(1);
  });

  it("clears only the superseded line's tick on a shipment carrying two closed-short lines", async () => {
    const { order } = await twoLineOrder(); // 10 and 8
    const [lineA, lineB] = order.lines;
    const input = shipmentOf(order, [
      { orderLineId: lineA.id, qty: 9, weight: 9 }, { orderLineId: lineB.id, qty: 7, weight: 7 },
    ]);
    input.orders[0].lines[0].lineComplete = true;
    input.orders[0].lines[1].lineComplete = true;
    const { shipper } = await createShipper(input, { canOverrideCreditHold: false });
    await createShipper(shipmentOf(order, [{ orderLineId: lineA.id, qty: 1, weight: 1 }]), { canOverrideCreditHold: false });
    const flags = await prisma.shipperLine.findMany({
      where: { shipperOrder: { shipperId: shipper.id } }, select: { lineComplete: true }, orderBy: { position: "asc" },
    });
    expect(flags.map((f) => f.lineComplete)).toEqual([false, true]);
    expect((await getOrder(order.id)).status).toBe("SHIPPED");
  });

  // The reversal bookkeeping (`reversalClearedLineIds`): voiding a reversal restores the ticks it
  // cleared, except on a line that is complete by quantity by then. Restoring that one would only
  // be cleared again by the recompute that follows, so `voidShipper` skips it: the original's
  // history shows the reversal's own clear and nothing after it.
  it("does not restore a tick on voiding a reversal when the line is complete by quantity by then", async () => {
    const { order } = await savedOrder({ qty: 10 });
    const original = await ship(order, 9, true);
    const { shipper: reversal } = await asSystem(() => reverseShipper(original.shipper.id, { reason: "wrong parts loaded" }));
    expect(await flagOf(original.lineId)).toBe(false); // cleared by the reversal
    await ship(order, 1); // net 1 of 10 while the reversal stands
    expect((await getOrder(order.id)).status).toBe("PARTIAL_SHIPPED");

    await asSystem(() => voidShipper(reversal.id, "mistaken reversal"));

    expect(await flagOf(original.lineId)).toBe(false); // 10 of 10: complete by quantity
    expect((await getOrder(order.id)).status).toBe("SHIPPED");
    const line = (snap: Snap) => snap?.orders?.flatMap((o) => o.lines ?? []).find((l) => l.id === original.lineId);
    const flips = (await updatesOn(original.shipper.id))
      .map((e) => [line(e.before as Snap)?.lineComplete, line(e.after as Snap)?.lineComplete]);
    expect(flips).toEqual([[true, false]]); // the reversal's clear; no restore, no second clear
  });

  // The consequences of the automatic clear the owner accepted (2026-10-06), pinned. One line
  // ordered 10; S1 ships 9 closed short; S2 ships the last 1, which clears S1's tick.
  describe("what the clear leaves behind", () => {
    async function twoShipments() {
      const { order } = await savedOrder({ qty: 10 });
      const s1 = await ship(order, 9, true, "2026-08-04");
      const s2 = await ship(order, 1, false, "2026-08-09");
      return { order, s1, s2 };
    }
    const closeShortAgain = (order: OrderDetail, s1: { shipper: { id: string; orders: { id: string }[] } }) =>
      asSystem(() => replaceShipperLines(s1.shipper.id, s1.shipper.orders[0].id,
        [{ orderLineId: order.lines[0].id, qty: 9, weight: 9, lineComplete: true }]));

    it("S1's shipping ticket no longer reads Shipped Complete once S2 has gone", async () => {
      const { order } = await savedOrder({ qty: 10 });
      const s1 = await ship(order, 9, true);
      const settings = await ticketSettings();
      expect((await readShippingTicketData(prisma, s1.shipper.id, settings))[0].shippedComplete).toBe(true);
      const s2 = await ship(order, 1);
      expect((await readShippingTicketData(prisma, s1.shipper.id, settings))[0].shippedComplete).toBe(false);
      expect((await readShippingTicketData(prisma, s2.shipper.id, settings))[0].shippedComplete).toBe(true);
    });

    it("turnaround takes S2's ship date as the completion date, not S1's", async () => {
      const { order } = await twoShipments();
      expect((await getOrder(order.id)).status).toBe("SHIPPED");
      const rows = (await reportTurnaround({})).rows as TurnaroundDetailRow[];
      const row = rows.find((r) => r.orderNumber === order.orderNumber);
      expect(row?.completionDate).toBe("2026-08-09");
    });

    it("voiding S2 leaves the order Partially shipped with S1 unticked, until S1 is closed short again", async () => {
      const { order, s1, s2 } = await twoShipments();
      await asSystem(() => voidShipper(s2.shipper.id, "shipped in error"));
      expect((await getOrder(order.id)).status).toBe("PARTIAL_SHIPPED");
      expect(await flagOf(s1.lineId)).toBe(false);
      await closeShortAgain(order, s1);
      expect((await getOrder(order.id)).status).toBe("SHIPPED");
    });

    it("reversing S2 leaves the order Partially shipped with S1 unticked, until S1 is closed short again", async () => {
      const { order, s1, s2 } = await twoShipments();
      await asSystem(() => reverseShipper(s2.shipper.id, { reason: "wrong parts loaded" }));
      expect((await getOrder(order.id)).status).toBe("PARTIAL_SHIPPED");
      expect(await flagOf(s1.lineId)).toBe(false);
      await closeShortAgain(order, s1);
      expect((await getOrder(order.id)).status).toBe("SHIPPED");
    });

    it("a draft invoice raised while the order was Shipped is refused at finalize after S2 is voided", async () => {
      const { order, s2 } = await twoShipments();
      const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
      await asSystem(() => voidShipper(s2.shipper.id, "shipped in error"));
      expect((await getOrder(order.id)).status).toBe("PARTIAL_SHIPPED");
      await expect(asSystem(() => finalizeInvoice(invoice.id))).rejects.toMatchObject({
        status: 400, message: expect.stringMatching(new RegExp(`^Order #${order.orderNumber} is Partially shipped — `)),
      });
      expect((await getInvoice(invoice.id)).status).toBe("DRAFT");
      expect((await getOrder(order.id)).status).toBe("PARTIAL_SHIPPED");
    });
  });

  it("writes nothing and audits nothing when no tick is superseded", async () => {
    const { order } = await savedOrder({ qty: 10 });
    const first = await ship(order, 4);
    const second = await ship(order, 6);
    expect(await updatesOn(first.shipper.id)).toHaveLength(0);
    expect(await updatesOn(second.shipper.id)).toHaveLength(0);
    // A header edit that changes nothing about quantities runs the recompute again: still nothing.
    await asSystem(() => updateLine(order.id, order.lines[0].id, { weight: "30.00" }));
    expect(await updatesOn(first.shipper.id)).toHaveLength(0);
    expect(await updatesOn(second.shipper.id)).toHaveLength(0);
  });
});

// Weights design §9.4 and §12.2, owner ruling W2 (2026-10-09). A shipment container row stores its
// own tare each. A new shipment's save stores the figure its row of the request carries, a null as
// none, and the order row's when the row has no `tareEach` key. It is read from the shipment row's
// column from then on.
describe("a shipment container row stores its own tare each", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  /** A new shipment of one order that picks three of its container rows: tare each 42.50, tare
   *  each 0, and none. The type's default is 99.00 on purpose and matches no row: a figure copied
   *  from the type, or a missing figure filled from it, would show. `sent` is what each row of the
   *  request carries beside its order row and its number of containers: nothing, unless a case
   *  says otherwise. */
  async function shipmentOfThreeRows(sent: { tareEach?: number | string | null }[] = [{}, {}, {}]) {
    const { order } = await savedOrder();
    const basket = await prisma.containerType.create({ data: { name: "Basket", tareEach: "99.00" } });
    const withTare = await prisma.orderContainer.create({
      data: {
        orderId: order.id, position: 1, typeId: basket.id, count: 3, tareEach: "42.50",
        customerContainerId: "BIN-1",
      },
    });
    const zeroTare = await prisma.orderContainer.create({
      data: { orderId: order.id, position: 2, typeId: basket.id, count: 2, tareEach: "0" },
    });
    const noTare = await prisma.orderContainer.create({
      data: { orderId: order.id, position: 3, typeId: basket.id, count: 1 },
    });
    const input = oneOrderInput(order);
    input.orders[0].containers = [
      { orderContainerId: withTare.id, count: 3, ...sent[0] },
      { orderContainerId: zeroTare.id, count: 2, ...sent[1] },
      { orderContainerId: noTare.id, count: 1, ...sent[2] },
    ];
    const { shipper } = await createShipper(input, { canOverrideCreditHold: false });
    return { shipper, withTare, zeroTare, noTare };
  }

  it("a row of a new shipment sent with no tareEach key takes the order row's figure: a zero is kept and a missing figure stays empty", async () => {
    const { shipper } = await shipmentOfThreeRows();
    expect(await storedTareEach(shipper.orders[0].id)).toEqual(["42.50", "0.00", null]);
  });

  // 9999999999.99 is the largest figure a Decimal(12, 2) column holds.
  it("a row sent with no tareEach key takes the order row's figure to the cent, at the largest figure the column holds", async () => {
    const { order } = await savedOrder();
    const basket = await prisma.containerType.create({ data: { name: "Basket" } });
    const row = await prisma.orderContainer.create({
      data: { orderId: order.id, position: 1, typeId: basket.id, count: 1, tareEach: "9999999999.99" },
    });
    const input = oneOrderInput(order);
    input.orders[0].containers = [{ orderContainerId: row.id, count: 1 }];
    const { shipper } = await createShipper(input, { canOverrideCreditHold: false });
    expect(await storedTareEach(shipper.orders[0].id)).toEqual(["9999999999.99"]);
  });

  it("the create history entry lists each container's figure, as a number or null", async () => {
    const { shipper, withTare, zeroTare, noTare } = await shipmentOfThreeRows();
    const [entry] = await readAudit("shipper", shipper.id);
    expect(entry.action).toBe("create");
    const after = entry.after as { orders: { containers: unknown[] }[] };
    // Whole entries: a missing key fails, and so does a figure written as text ("42.5").
    expect(after.orders[0].containers).toEqual([
      { orderContainerId: withTare.id, typeName: "Basket", customerContainerId: "BIN-1", count: 3, tareEach: 42.5 },
      { orderContainerId: zeroTare.id, typeName: "Basket", customerContainerId: "", count: 2, tareEach: 0 },
      { orderContainerId: noTare.id, typeName: "Basket", customerContainerId: "", count: 1, tareEach: null },
    ]);
  });

  it("a new shipment stores the figure each row carries, a null as none, and its create entry lists what was stored", async () => {
    // No figure sent is its order row's: those are 42.50, 0 and none.
    const { shipper, withTare, zeroTare, noTare } = await shipmentOfThreeRows(
      [{ tareEach: "7.25" }, { tareEach: null }, { tareEach: 0 }]);
    expect(await storedTareEach(shipper.orders[0].id)).toEqual(["7.25", null, "0.00"]);

    const [entry] = await readAudit("shipper", shipper.id);
    const after = entry.after as { orders: { containers: unknown[] }[] };
    expect(after.orders[0].containers).toEqual([
      { orderContainerId: withTare.id, typeName: "Basket", customerContainerId: "BIN-1", count: 3, tareEach: 7.25 },
      { orderContainerId: zeroTare.id, typeName: "Basket", customerContainerId: "", count: 2, tareEach: null },
      { orderContainerId: noTare.id, typeName: "Basket", customerContainerId: "", count: 1, tareEach: 0 },
    ]);
  });

  it("the read takes each figure from the shipment's own row, never from the order's row", async () => {
    const { shipper, withTare } = await shipmentOfThreeRows();
    const first = (await getShipper(shipper.id)).orders[0].containers;
    expect(first.map((c) => c.tareEach)).toEqual([42.5, 0, null]);

    // The order's row is changed underneath a shipment row that is still linked to it. No service
    // does this (an order-side save deletes and re-creates its rows), so it is done by hand. The
    // read must not follow it.
    await prisma.orderContainer.update({ where: { id: withTare.id }, data: { tareEach: "55.00" } });
    const linked = (await getShipper(shipper.id)).orders[0].containers;
    expect(linked[0].orderContainerId).toBe(withTare.id);
    expect(linked[0].tareEach).toBe(42.5);

    // The shipment's own figure, changed by hand, is what the read returns.
    await prisma.shipperContainer.update({ where: { id: linked[0].id }, data: { tareEach: "7.25" } });
    expect((await getShipper(shipper.id)).orders[0].containers[0].tareEach).toBe(7.25);
  });
});

describe("getShipper", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("returns full detail — label, ordered/shipped-to-date figures, containers and serials", async () => {
    const { order, customer } = await savedOrder({ qty: 10, weight: "25.00" });
    const containerType = await prisma.containerType.create({ data: { name: "Basket" } });
    const container = await prisma.orderContainer.create({
      data: { orderId: order.id, position: 1, typeId: containerType.id, count: 2, customerContainerId: "BIN-1" },
    });
    const serial = await prisma.orderSerial.create({
      data: { orderId: order.id, lineId: order.lines[0].id, position: 1, serial: "S-9", description: "Heat 1" },
    });

    const input = oneOrderInput(order);
    input.orders[0].lines[0].qty = 4;
    input.orders[0].lines[0].weight = 10;
    input.orders[0].containers = [{ orderContainerId: container.id, count: 2 }];
    input.orders[0].serials = [{ orderSerialId: serial.id, printOnShipper: true }];
    const { shipper } = await createShipper(input, { canOverrideCreditHold: false });

    const detail = await getShipper(shipper.id);
    expect(detail.customerCode).toBe(customer.code);
    expect(detail.orders).toHaveLength(1);
    const so = detail.orders[0];
    expect(so.label).toBe(`${order.orderNumber}-1`);
    expect(so.lines[0]).toMatchObject({
      orderedQty: 10, orderedWeight: 25, shippedToDateQty: 4, shippedToDateWeight: 10, qty: 4,
    });
    expect(so.containers[0]).toMatchObject({ typeName: "Basket", customerContainerId: "BIN-1", count: 2 });
    expect(so.serials[0]).toMatchObject({ serial: "S-9", description: "Heat 1", printOnShipper: true });
  });

  it("throws 404 for an unknown id", async () => {
    await expect(getShipper("nope")).rejects.toThrow(/not found/i);
  });

  // Task 14 review, Important #1: the add-line picker's ship-now prefill is `ordered − shipped`
  // (design §5.1), and shipped-to-date for a CANDIDATE line — one not on this shipment yet — is
  // knowable nowhere on the page unless the shipment's own GET carries it. `lines[]` only covers
  // what is already on the shipment, so this second, order-wide ledger is what the picker reads.
  it("carries shipped-to-date for EVERY line of each order, not only the lines on this shipment", async () => {
    const { order } = await twoLineOrder();
    const [lineA, lineB] = order.lines;
    // A PRIOR shipment took 4 of line A and 3 of line B.
    await createShipper(shipmentOf(order, [
      { orderLineId: lineA.id, qty: 4, weight: 10 },
      { orderLineId: lineB.id, qty: 3, weight: 5 },
    ]), { canOverrideCreditHold: false });
    // THIS shipment carries line A only — line B is an add-line candidate on it.
    const { shipper } = await createShipper(shipmentOf(order, [
      { orderLineId: lineA.id, qty: 2, weight: 5 },
    ]), { canOverrideCreditHold: false });

    const so = (await getShipper(shipper.id)).orders[0];
    expect(so.lines).toHaveLength(1);
    const ledger = new Map(so.orderLineShippedToDate.map((e) => [e.orderLineId, e]));
    expect(ledger.size).toBe(2);
    // Every LIVE shipment counts, this one included (spec §5.1) — 4 + 2 and 10 + 5.
    expect(ledger.get(lineA.id)).toMatchObject({ shippedToDateQty: 6, shippedToDateWeight: 15 });
    // The candidate: shipped only on the OTHER shipment, so its remainder here is 8 − 3 / 12 − 5.
    expect(ledger.get(lineB.id)).toMatchObject({ shippedToDateQty: 3, shippedToDateWeight: 5 });
  });

  it("excludes voided shipments from that per-order-line ledger", async () => {
    const { order } = await twoLineOrder();
    const [lineA, lineB] = order.lines;
    const prior = await createShipper(shipmentOf(order, [
      { orderLineId: lineA.id, qty: 4, weight: 10 },
      { orderLineId: lineB.id, qty: 3, weight: 5 },
    ]), { canOverrideCreditHold: false });
    const { shipper } = await createShipper(shipmentOf(order, [
      { orderLineId: lineA.id, qty: 2, weight: 5 },
    ]), { canOverrideCreditHold: false });

    await voidShipper(prior.shipper.id, "loaded onto the wrong truck");

    const so = (await getShipper(shipper.id)).orders[0];
    const ledger = new Map(so.orderLineShippedToDate.map((e) => [e.orderLineId, e]));
    expect(ledger.get(lineA.id)).toMatchObject({ shippedToDateQty: 2, shippedToDateWeight: 5 });
    // A line whose only shipment was voided reports a real 0, not a missing entry — the grid
    // renders the number, and the prefill falls back to the full ordered figure.
    expect(ledger.get(lineB.id)).toMatchObject({ shippedToDateQty: 0, shippedToDateWeight: 0 });
  });
});

// Task 14b: the shipment CREATE page (`/shipping/new`) prefills every grid to the remainder
// (`ordered − shipped`, design §5.1) before any shipper exists — so, unlike the edit page (whose
// `orderLineShippedToDate` rides the shipper's own GET, Task 14 review Important #1), the figure
// has to ride the ORDER's own detail: the same GET the create page already makes per selected
// order for its line/container/serial catalog. Same name, same dense shape, same single
// `shippedTotals` derivation — a widened existing payload, not a new route (spec §9 unchanged).
describe("getOrder shipped-to-date (the /shipping/new prefill seam)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("carries a dense per-line ledger on the order's own detail", async () => {
    const { order } = await twoLineOrder();
    const [lineA, lineB] = order.lines;
    await createShipper(shipmentOf(order, [
      { orderLineId: lineA.id, qty: 4, weight: 10 },
    ]), { canOverrideCreditHold: false });

    const detail = await getOrder(order.id);
    const ledger = new Map(detail.orderLineShippedToDate.map((e) => [e.orderLineId, e]));
    expect(ledger.size).toBe(2);
    expect(ledger.get(lineA.id)).toMatchObject({ shippedToDateQty: 4, shippedToDateWeight: 10 });
    // DENSE: a never-shipped line reports a real 0/0, so the prefill is the full ordered figure
    // rather than an undefined the grid would have to special-case.
    expect(ledger.get(lineB.id)).toMatchObject({ shippedToDateQty: 0, shippedToDateWeight: 0 });
  });

  it("sums every live shipment and excludes voided ones (spec §5.1)", async () => {
    const { order } = await twoLineOrder();
    const [lineA] = order.lines;
    const prior = await createShipper(shipmentOf(order, [
      { orderLineId: lineA.id, qty: 4, weight: 10 },
    ]), { canOverrideCreditHold: false });
    await createShipper(shipmentOf(order, [
      { orderLineId: lineA.id, qty: 2, weight: 5 },
    ]), { canOverrideCreditHold: false });

    let ledger = new Map((await getOrder(order.id)).orderLineShippedToDate.map((e) => [e.orderLineId, e]));
    expect(ledger.get(lineA.id)).toMatchObject({ shippedToDateQty: 6, shippedToDateWeight: 15 });

    await voidShipper(prior.shipper.id, "loaded onto the wrong truck");
    ledger = new Map((await getOrder(order.id)).orderLineShippedToDate.map((e) => [e.orderLineId, e]));
    expect(ledger.get(lineA.id)).toMatchObject({ shippedToDateQty: 2, shippedToDateWeight: 5 });
  });
});
