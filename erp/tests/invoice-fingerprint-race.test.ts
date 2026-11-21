import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import type { Prisma } from "../prisma/generated/prisma/client";
import { runWithContext } from "@/server/context";
import { HttpError } from "@/server/errors";
import { createOrder, getOrder } from "@/server/orders";
import {
  addOrderToShipper, createShipper, removeOrderFromShipper, replaceShipperLines, reverseShipper,
  updateShipper, voidShipper,
} from "@/server/shippers";
import { addPartPrice } from "@/server/part-prices";
import { createInvoice, finalizeInvoice } from "@/server/invoices";

// The stale-draft guard's DANGEROUS DIRECTION (review finding on the 2026-10-06 fingerprint check,
// the `close-periods.test.ts` "DANGEROUS-DIRECTION" precedent). `claimInvoiceRow` reads the invoice
// (to learn its order) BEFORE `claimOrder`, so a Serializable finalize fixes its snapshot before it
// holds the order claim. A shipment edit that keeps the order SHIPPED (a line closed short at 8 of
// 10, edited to 10) writes no `Order` row, so a finalize parked on that claim wakes with no error
// and reads the OLD shipper lines from its snapshot: the fingerprint matches. What stops the stale
// draft from finalizing is therefore NOT the order claim; this file measures what is.

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

/** One line of 10 priced at $5 each, shipped 8 and closed short -> SHIPPED, with a DRAFT invoice
 *  calculated at 8 (the fixture `tests/invoices.test.ts` calls `closedShortAtEight`, copied: copying
 *  across test files is this repo's convention). */
async function draftAtEightOfTen() {
  const customer = await prisma.customer.create({ data: { code: "RACE", name: "Race Customer" } });
  const part = await prisma.part.create({
    data: { customerId: customer.id, partNumber: "P-RACE", eachWeight: "1.0000" },
  });
  const step = await prisma.processStepCode.create({ data: { code: "HT-RACE", name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: step.id, instruction: "Austenitize at 1650F." },
  });
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber: "", lines: [{ partId: part.id, qty: 10, weight: "25.00" }],
  }));
  const gl = await prisma.glAccount.create({ data: { name: "4010", description: "Sales" } });
  const code = await prisma.processStepCode.create({ data: { code: "AUST", name: "Austemper", glAccountId: gl.id } });
  await asSystem(() => addPartPrice(part.id, {
    processStepCodeId: code.id, position: 1, unitPrice: "5.0000", pricePer: "EACH",
  }));
  const { shipper } = await createShipper({
    customerId: customer.id, shipDate: "2026-08-04",
    orders: [{
      orderId: order.id, containers: [], serials: [],
      lines: [{ orderLineId: order.lines[0].id, qty: 8, weight: 20, lineComplete: true }],
    }],
  }, { canOverrideCreditHold: false });
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  return { order, shipper, invoice };
}

/** Two orders of one customer and part, each one line of 10 priced at $5. Shipment B ships O 7,
 *  closed short. Shipment A then ships O 1 and P 10, neither ticked. 7 + 1 < 10, so B's tick
 *  stands: O is SHIPPED, and the DRAFT invoice for O is calculated at 8. The races that use this
 *  fixture edit A, not B: an edit of B's tick would move O's status, so it would write O's `Order`
 *  row, the row finalize claims and writes. That conflict aborts finalize whatever the fingerprint
 *  says, and O would not stay SHIPPED. Each edit of A leaves O SHIPPED at 7 closed short, so it
 *  writes no `Order` row of O's and only O's fingerprint moves (8 shipped -> 7). P keeps a second
 *  order with a positive line on A, which `removeOrderFromShipper` needs before it allows the
 *  removal. */
async function draftAtEightOverTwoShipments() {
  const customer = await prisma.customer.create({ data: { code: "RACE2", name: "Race Customer Two" } });
  const part = await prisma.part.create({
    data: { customerId: customer.id, partNumber: "P-RACE2", eachWeight: "1.0000" },
  });
  const step = await prisma.processStepCode.create({ data: { code: "HT-RACE2", name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: step.id, instruction: "Austenitize at 1650F." },
  });
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber: "", lines: [{ partId: part.id, qty: 10, weight: "25.00" }],
  }));
  const { order: other } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber: "", lines: [{ partId: part.id, qty: 10, weight: "25.00" }],
  }));
  const gl = await prisma.glAccount.create({ data: { name: "4010", description: "Sales" } });
  const code = await prisma.processStepCode.create({ data: { code: "AUST2", name: "Austemper", glAccountId: gl.id } });
  await asSystem(() => addPartPrice(part.id, {
    processStepCodeId: code.id, position: 1, unitPrice: "5.0000", pricePer: "EACH",
  }));
  await createShipper({
    customerId: customer.id, shipDate: "2026-08-03",
    orders: [{
      orderId: order.id, containers: [], serials: [],
      lines: [{ orderLineId: order.lines[0].id, qty: 7, weight: 17.5, lineComplete: true }],
    }],
  }, { canOverrideCreditHold: false });
  const { shipper } = await createShipper({
    customerId: customer.id, shipDate: "2026-08-04",
    orders: [
      {
        orderId: order.id, containers: [], serials: [],
        lines: [{ orderLineId: order.lines[0].id, qty: 1, weight: 2.5, lineComplete: false }],
      },
      {
        orderId: other.id, containers: [], serials: [],
        lines: [{ orderLineId: other.lines[0].id, qty: 10, weight: 25, lineComplete: false }],
      },
    ],
  }, { canOverrideCreditHold: false });
  const soA = shipper.orders.find((so) => so.orderId === order.id);
  expect(soA).toBeDefined();
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  return { order, shipper, soA: soA!, invoice };
}

/** Polls `pg_stat_activity` until some OTHER backend is blocked on a lock inside a statement whose
 *  text contains every fragment. This is the proof a transaction is parked where the test needs it
 *  (the `order-link-locks.test.ts` technique), in place of a blind sleep. */
async function waitForLockWaiter(...fragments: string[]): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    const rows = await prisma.$queryRaw<{ query: string }[]>`
      SELECT query FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`;
    if (rows.some((r) => fragments.every((f) => r.query.includes(f)))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

beforeEach(async () => {
  await truncateAll();
  await seedOrderGatePrereqs();
});

type Fixture = Awaited<ReturnType<typeof draftAtEightOfTen>>;

/**
 * Runs the REAL `finalizeInvoice` against a REAL shipment mutator that commits while finalize is
 * parked on the order claim, with no sleep deciding the order:
 *
 *   1. GATE (Read Committed, raw) holds `FOR UPDATE` a row the mutator locks or writes AFTER its
 *      order claim. It takes no SIREAD lock and writes nothing, so it forms no SSI edge with
 *      either real transaction.
 *   2. The mutator (its own transaction, at the isolation the service really runs at, as a route
 *      runs it) claims the order, then PARKS on the gated row. It now HOLDS the order claim.
 *   3. `finalizeInvoice` (Serializable) fixes its snapshot at `claimInvoiceRow`'s unlocked invoice
 *      read, then PARKS at `claimOrder`, behind the mutator.
 *   4. The gate releases. The mutator writes, leaves the invoice's order SHIPPED (so writes no
 *      Order row of that order's; another order on the shipment may change status) and COMMITS.
 *      Finalize acquires the order claim with no error, on its older snapshot.
 *
 * Returns how finalize ended, after asserting the mutator committed.
 */
async function finalizeWhileEditCommits(f: Fixture, opts: {
  gate: (tx: Prisma.TransactionClient) => Promise<unknown>;
  edit: () => Promise<unknown>;
  editParksOn: string[];
}): Promise<unknown> {
  let gateHeld!: () => void;
  const held = new Promise<void>((r) => { gateHeld = r; });
  let releaseGate!: () => void;
  const release = new Promise<void>((r) => { releaseGate = r; });
  const gate = prisma.$transaction(async (tx) => {
    await opts.gate(tx);
    gateHeld();
    await release;
  }, { timeout: 30_000 });
  await held;

  let finalizeProm: Promise<unknown>;
  let editProm: Promise<unknown>;
  try {
    editProm = asSystem(opts.edit).then(() => "resolved" as const, (e: unknown) => e);
    // The mutator is parked on the gated row, i.e. AFTER it claimed the order.
    expect(await waitForLockWaiter(...opts.editParksOn)).toBe(true);

    finalizeProm = asSystem(() => finalizeInvoice(f.invoice.id))
      .then(() => "resolved" as const, (e: unknown) => e);
    // Finalize is parked at `claimOrder`, i.e. AFTER the read that fixed its snapshot.
    expect(await waitForLockWaiter(`"Order"`, `"id" = $1`, "FOR UPDATE")).toBe(true);
  } finally {
    releaseGate();
    await gate;
  }
  expect(await editProm).toBe("resolved"); // the edit committed while finalize was parked
  return finalizeProm;
}

/** THE DATA OUTCOME, whichever way finalize ended: the draft is still a draft and nothing wrote
 *  INVOICED to the order. Then how it ended: a serialization abort (409) or the fingerprint refusal
 *  (400), logged so a change of mechanism is visible (`--silent=false`). */
async function expectStillDraft(f: Fixture, outcome: unknown, label: string): Promise<void> {
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoice.id } });
  expect(inv.status).toBe("DRAFT");
  expect(inv.finalizedAt).toBeNull();
  expect((await getOrder(f.order.id)).status).toBe("SHIPPED"); // never INVOICED
  expect(await prisma.auditLog.count({
    where: { entity: "order", entityId: f.order.id, after: { path: ["status"], equals: "INVOICED" } },
  })).toBe(0);

  expect(outcome).toBeInstanceOf(HttpError);
  const err = outcome as HttpError;
  console.info(`[fingerprint-race] ${label}: finalize ended ${err.status}: ${err.message}`);
  expect([400, 409]).toContain(err.status);
  if (err.status === 400) expect(err.message).toMatch(/have changed since this invoice was calculated/);
}

/** NON-VACUITY, after the race: finalize run again, alone, refuses on the fingerprint (400). A 409
 *  in the race shows only that the two transactions conflicted; this shows the edit really moved
 *  what the draft was calculated from, which is what the race case rests on. */
async function expectFingerprintRefusal(f: Fixture): Promise<void> {
  const outcome = await asSystem(() => finalizeInvoice(f.invoice.id))
    .then(() => "resolved" as const, (e: unknown) => e);
  expect(outcome).toBeInstanceOf(HttpError);
  expect((outcome as HttpError).status).toBe(400);
  expect((outcome as HttpError).message).toMatch(/have changed since this invoice was calculated/);
}

describe("finalizeInvoice vs a shipment change that commits while it waits for the order claim", () => {
  // Measured 2026-10-06 on PostgreSQL 18, both sides Serializable: finalize's fingerprint read sees
  // the OLD shipment rows on its snapshot and MATCHES, and Postgres SSI then aborts finalize
  // (40001 -> 409). The two transactions form a read/write cycle: the mutator read state finalize
  // writes (the finalized-invoice check, the claimed Order row), and finalize's FINGERPRINT READ
  // read rows the mutator wrote. Mutations of the first case, each run and restored:
  //   - `replaceShipperLines` at Read Committed: nothing aborts; the stale draft FINALIZES at 8
  //     with 10 shipped and the order goes INVOICED. RED. (`saveNewShipper` and `updateShipper`
  //     at Read Committed red the second and third case the same way, each alone.)
  //   - fingerprint comparison removed (both still Serializable): finalize never reads the shipper
  //     lines, so there is no cycle and nothing aborts; it FINALIZES. RED. The comparison's read is
  //     one half of what SSI needs, not a spare.
  //   - `finalizeInvoice` at Read Committed: its reads follow the claim, see 10, and the
  //     fingerprint refuses (400). GREEN, and not kept: finalize stays Serializable for the period
  //     lock.
  // Measured 2026-10-17 on PostgreSQL 18 the same way, for the last four cases (#471): with every
  // side Serializable, each ends 409. Mutations, each run and restored:
  //   - `addOrderToShipper`, `removeOrderFromShipper`, `voidShipper` or `reverseShipper` at Read
  //     Committed (its `isolationLevel` option deleted; `reverseShipper` keeps `retryAllocation`):
  //     the stale draft FINALIZES and the order goes INVOICED. RED, that mutator's own case alone.
  //   - freight left out of `readShipmentInputs` (every side still Serializable): each race still
  //     ends 409, and the add case REDS only at `expectFingerprintRefusal`, where finalize run again
  //     alone now finalizes. That step closes each of the last four cases: a 409 shows only that
  //     the two transactions conflicted, and its 400 shows the edit moved what the draft was
  //     calculated from. The first three cases do not take it, and the third stays GREEN under this
  //     mutation.
  // Measured 2026-10-17 again, all seven cases each time (the #471 residual). Mutations, each run
  // and restored:
  //   - `finalizeInvoice` at Read Committed, every mutator Serializable: each case GREEN, finalize
  //     ending 400 on the fingerprint, as the first case's measurement above found.
  //   - `finalizeInvoice` at Repeatable Read, which fixes its snapshot before the claim as
  //     Serializable does but takes no part in SSI: each case RED, the stale draft FINALIZED.
  //   - each mutator alone at Repeatable Read: its own case RED, the stale draft FINALIZED, as at
  //     Read Committed.
  //   So finalize's downgrade breaks this guard at Repeatable Read and not at Read Committed;
  //   finalize stays Serializable for the period lock either way.
  it("DANGEROUS-DIRECTION: a line edit from 8 to 10 commits mid-finalize and the draft calculated at 8 is NOT finalized", async () => {
    const f = await draftAtEightOfTen();
    const shipperOrderId = f.shipper.orders[0].id;
    const outcome = await finalizeWhileEditCommits(f, {
      gate: (tx) => tx.$queryRaw`SELECT "id" FROM "ShipperLine" WHERE "shipperOrderId" = ${shipperOrderId} FOR UPDATE`,
      edit: () => replaceShipperLines(f.shipper.id, shipperOrderId,
        [{ orderLineId: f.order.lines[0].id, qty: 10, weight: 25, lineComplete: false }]),
      editParksOn: [`"ShipperLine"`, "DELETE"],
    });
    expect((await prisma.shipperLine.findMany({ where: { shipperOrderId } })).map((l) => l.qty)).toEqual([10]);
    await expectStillDraft(f, outcome, "replaceShipperLines");
  }, 60_000);

  // `createShipper` is the one shipment mutator with no finalized-invoice check of its own: its
  // edge to finalize is the claimed Order row it reads and finalize writes INVOICED to.
  it("DANGEROUS-DIRECTION: a second shipment of the last 2 commits mid-finalize and the draft is NOT finalized", async () => {
    const f = await draftAtEightOfTen();
    const outcome = await finalizeWhileEditCommits(f, {
      gate: (tx) => tx.$queryRaw`SELECT "key" FROM "Setting" WHERE "key" = 'shipper_number_next' FOR UPDATE`,
      edit: () => createShipper({
        customerId: f.order.customerId, shipDate: "2026-08-05",
        orders: [{
          orderId: f.order.id, containers: [], serials: [],
          lines: [{ orderLineId: f.order.lines[0].id, qty: 2, weight: 5, lineComplete: false }],
        }],
      }, { canOverrideCreditHold: false }),
      editParksOn: [`"Setting"`, "FOR UPDATE"],
    });
    expect(await prisma.shipper.count({ where: { deletedAt: null } })).toBe(2);
    await expectStillDraft(f, outcome, "createShipper");
  }, 60_000);

  it("DANGEROUS-DIRECTION: billed freight added mid-finalize and the draft calculated without it is NOT finalized", async () => {
    const f = await draftAtEightOfTen();
    const outcome = await finalizeWhileEditCommits(f, {
      gate: (tx) => tx.$queryRaw`SELECT "id" FROM "Shipper" WHERE "id" = ${f.shipper.id} FOR UPDATE`,
      edit: () => updateShipper(f.shipper.id, { billFreight: true, freightAmount: "100.00" }),
      editParksOn: [`"Shipper"`, "FOR UPDATE"],
    });
    expect((await prisma.shipper.findUniqueOrThrow({ where: { id: f.shipper.id } })).freightAmount?.toNumber()).toBe(100);
    await expectStillDraft(f, outcome, "updateShipper freight");
  }, 60_000);

  it("DANGEROUS-DIRECTION: an order removed from a shipment mid-finalize and the draft calculated with that shipment is NOT finalized", async () => {
    const f = await draftAtEightOverTwoShipments();
    const outcome = await finalizeWhileEditCommits(f, {
      gate: (tx) => tx.$queryRaw`SELECT "id" FROM "Shipper" WHERE "id" = ${f.shipper.id} FOR UPDATE`,
      edit: () => removeOrderFromShipper(f.shipper.id, f.soA.id),
      editParksOn: [`"Shipper"`, "FOR UPDATE"],
    });
    expect(await prisma.shipperOrder.count({ where: { shipperId: f.shipper.id, orderId: f.order.id } })).toBe(0);
    await expectStillDraft(f, outcome, "removeOrderFromShipper");
    await expectFingerprintRefusal(f);
  }, 60_000);

  it("DANGEROUS-DIRECTION: a shipment voided mid-finalize and the draft calculated with it is NOT finalized", async () => {
    const f = await draftAtEightOverTwoShipments();
    const outcome = await finalizeWhileEditCommits(f, {
      gate: (tx) => tx.$queryRaw`SELECT "id" FROM "Shipper" WHERE "id" = ${f.shipper.id} FOR UPDATE`,
      edit: () => voidShipper(f.shipper.id, "shipped in error"),
      editParksOn: [`"Shipper"`, "FOR UPDATE"],
    });
    expect((await prisma.shipper.findUniqueOrThrow({ where: { id: f.shipper.id } })).deletedAt).not.toBeNull();
    await expectStillDraft(f, outcome, "voidShipper");
    await expectFingerprintRefusal(f);
  }, 60_000);

  it("DANGEROUS-DIRECTION: a shipment reversed mid-finalize and the draft calculated before the reversal is NOT finalized", async () => {
    const f = await draftAtEightOverTwoShipments();
    const outcome = await finalizeWhileEditCommits(f, {
      gate: (tx) => tx.$queryRaw`SELECT "id" FROM "Shipper" WHERE "id" = ${f.shipper.id} FOR UPDATE`,
      edit: () => reverseShipper(f.shipper.id, { reason: "wrong parts loaded" }),
      editParksOn: [`"Shipper"`, "FOR UPDATE"],
    });
    expect(await prisma.shipper.count({ where: { reversesShipperId: f.shipper.id, deletedAt: null } })).toBe(1);
    await expectStillDraft(f, outcome, "reverseShipper");
    await expectFingerprintRefusal(f);
  }, 60_000);

  // `addOrderToShipper` creates a `ShipperOrder` with no lines, so the one fingerprint input it can
  // move is freight: `readShipmentInputs` takes freight from every live shipment carrying the order.
  // S3 bills freight and does not carry O until the add, so O's draft is fresh before it.
  it("DANGEROUS-DIRECTION: an order added mid-finalize to a shipment that bills freight, and the draft calculated without that freight is NOT finalized", async () => {
    const f = await draftAtEightOfTen();
    const { order: other } = await asSystem(() => createOrder({
      customerId: f.order.customerId, poNumber: "",
      lines: [{ partId: f.order.lines[0].partId, qty: 10, weight: "25.00" }],
    }));
    const { shipper: s3 } = await createShipper({
      customerId: f.order.customerId, shipDate: "2026-08-05",
      orders: [{
        orderId: other.id, containers: [], serials: [],
        lines: [{ orderLineId: other.lines[0].id, qty: 10, weight: 25, lineComplete: false }],
      }],
    }, { canOverrideCreditHold: false });
    await asSystem(() => updateShipper(s3.id, { billFreight: true, freightAmount: "100.00" }));
    const outcome = await finalizeWhileEditCommits(f, {
      gate: (tx) => tx.$queryRaw`SELECT "id" FROM "Shipper" WHERE "id" = ${s3.id} FOR UPDATE`,
      edit: () => addOrderToShipper(s3.id, f.order.id),
      editParksOn: [`"Shipper"`, "FOR UPDATE"],
    });
    expect(await prisma.shipperOrder.count({ where: { shipperId: s3.id, orderId: f.order.id } })).toBe(1);
    await expectStillDraft(f, outcome, "addOrderToShipper");
    await expectFingerprintRefusal(f);
  }, 60_000);
});
