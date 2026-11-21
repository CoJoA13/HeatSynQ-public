import { setTimeout as delay } from "node:timers/promises";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { expiredAtQuery } from "./helpers/expired-transaction";
import { signInWith } from "./helpers/auth";
import { storedTareEach, keptAndLinkedRows } from "./helpers/shipment-rows";
import { cellTexts, tableHeaded } from "./helpers/definition-text";
import { stripRows, totalsRows } from "./helpers/ticket-totals";
import { runWithContext } from "@/server/context";
import { HttpError } from "@/server/errors";
import { createOrder, type OrderDetail } from "@/server/orders";
import { setSetting } from "@/server/settings";
import {
  createShipper, getShipper, voidShipper, printShippingTickets, readShippingTicketData, ticketSettings,
  addOrderToShipper, replaceShipperContainers,
  type ShipperDetail,
} from "@/server/shippers";
import {
  buildShippingTicketDefinition, buildShippingTicketDefinitions, type TicketData,
} from "@/server/pdf/shipping-ticket";
import {
  getDocument, listDocumentsForOrder, listDocumentsForShipper, VOIDED_PRINT,
} from "@/server/documents";
import * as documents from "@/server/documents";
import * as pdfRenderer from "@/server/pdf/render";
import { shipmentTotals, savedShipmentTotalsInput, NO_REPORTS } from "@/lib/shipment-totals";
import { NOT_ENTERED, NOT_AVAILABLE } from "@/lib/order-totals";
import { Prisma, type Customer, type Part } from "../prisma/generated/prisma/client";

import { POST as printRoute } from "@/app/api/shippers/[id]/print/route";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
const postReq = (url: string, cookie?: string) =>
  new Request(url, { method: "POST", headers: cookie ? { cookie } : {} });

/** Every `text` string anywhere in a document definition, flattened — the traveler.test.ts
 *  precedent: the definition is plain JSON (spec §10), so assertions check WHAT the ticket says,
 *  not where pdfmake draws it. */
function allText(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) allText(n, out); return out; }
  if (typeof node === "object") {
    for (const value of Object.values(node as Record<string, unknown>)) allText(value, out);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Fixtures — the shippers.test.ts shapes, plus the addresses the ticket layout reads (a default
// BILL_TO for the Sold To block, a SHIP_TO for the Ship To block).
// -------------------------------------------------------------------------------------------

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({
    data: { code: `TKT${customerSeq}`, name: `Ticket Customer ${customerSeq}` },
  });
}

let partSeq = 0;
async function makePart(customerId: string): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({
    data: {
      customerId, partNumber: `TP-${partSeq}`, name: `Track Shoe ${partSeq}`,
      description: "D-001", eachWeight: "21.5000",
    },
  });
}

async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `TK-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

async function makeAddresses(customerId: string) {
  await prisma.customerAddress.create({
    data: {
      customerId, kind: "BILL_TO", name: "Accounts payable", street: "300 Example Way",
      city: "Anniston", state: "AL", zip: "36201", isDefault: true,
    },
  });
  return prisma.customerAddress.create({
    data: {
      customerId, kind: "SHIP_TO", name: "Demo Components Corporation", street: "300 Example Way",
      city: "Anniston", state: "AL", zip: "36201", isDefault: true,
    },
  });
}

async function orderFor(customer: Customer, opts: { poNumber?: string; qty?: number; weight?: string } = {}): Promise<OrderDetail> {
  const part = await makePart(customer.id);
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id,
    poNumber: opts.poNumber ?? "DEMO-PO-24115",
    customerJobNo: "JOB-9",
    lines: [{ partId: part.id, qty: opts.qty ?? 192, weight: opts.weight ?? "4128.00" }],
  }));
  return order;
}

function shipOrderInput(order: OrderDetail, lineComplete = true) {
  return {
    orderId: order.id,
    lines: [{
      orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight,
      lineComplete,
    }],
    containers: [] as { orderContainerId: string; count: number }[],
    serials: [] as { orderSerialId: string; printOnShipper?: boolean }[],
  };
}

async function oneOrderShipment(): Promise<{ shipper: ShipperDetail; order: OrderDetail; customer: Customer }> {
  const customer = await makeCustomer();
  const shipTo = await makeAddresses(customer.id);
  const order = await orderFor(customer);
  const { shipper } = await asSystem(() => createShipper({
    customerId: customer.id, shipDate: "2026-07-29", shipToAddressId: shipTo.id, route: "South",
    orders: [shipOrderInput(order)],
  }, { canOverrideCreditHold: false }));
  return { shipper, order, customer };
}

async function twoOrderShipment(): Promise<{
  shipper: ShipperDetail; orderA: OrderDetail; orderB: OrderDetail; customer: Customer;
}> {
  const customer = await makeCustomer();
  const shipTo = await makeAddresses(customer.id);
  const orderA = await orderFor(customer, { poNumber: "PO-A" });
  const orderB = await orderFor(customer, { poNumber: "PO-B", qty: 8, weight: "96.00" });
  const { shipper } = await asSystem(() => createShipper({
    customerId: customer.id, shipDate: "2026-07-29", shipToAddressId: shipTo.id,
    orders: [shipOrderInput(orderA), shipOrderInput(orderB, false)],
  }, { canOverrideCreditHold: false }));
  return { shipper, orderA, orderB, customer };
}

/** A hand-built TicketData for the pure-builder assertions — every field carries a distinctive
 *  value so `allText` misses nothing by accident. */
function sampleTicket(overrides: Partial<TicketData> = {}): TicketData {
  return {
    company: {
      name: "Example Heat Treating - Alabama,", address: "1201 Front St", phone: "(256) 555-0100",
      liabilityText: "FIRST LIABILITY PARAGRAPH.\n\nSECOND LIABILITY PARAGRAPH.",
    },
    soldTo: { code: "9054", attn: "", name: "Demo Components Corporation", street: "300 Example Way", city: "Anniston", state: "AL", zip: "36201" },
    shipTo: { code: "", attn: "", name: "Example Coating", street: "88 Dock Rd.", city: "Oxford", state: "AL", zip: "36203" },
    orderLabel: "92036-3", orderNumber: 92036, shipDate: "2026-07-29",
    poNumber: "DEMO-PO-24115", packingListNo: 92826, customerJobNo: "JOB-9", route: "South", carrierName: "Customer",
    lines: [{ qty: 192, partNumber: "DEMO01-HT", partName: "Track Shoe, Vehicular", partDescription: "D-001", pounds: 4128 }],
    containers: [{ typeName: "Bin", count: 3, customerContainerId: "DEMO-COMP-77", tareEach: 42.5 }],
    serials: [{ serial: "SN-0001", description: "Heat A1" }],
    shippedComplete: true, totalQty: 192,
    ...overrides,
  };
}

// -------------------------------------------------------------------------------------------
// The builder — pure, plain-JSON, and it says what the sample says.
// -------------------------------------------------------------------------------------------

describe("buildShippingTicketDefinition", () => {
  it("returns a plain-JSON definition (the template-as-data contract, spec §10)", () => {
    const def = buildShippingTicketDefinition([sampleTicket()]);
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
  });

  it("prints every block the sample carries", () => {
    const text = allText(buildShippingTicketDefinition([sampleTicket()])).join("\n");
    expect(text).toContain("Shipping Ticket");
    expect(text).toContain("Order No.: 92036-3");
    expect(text).toContain("Ship Date: 7/29/2026");
    expect(text).toContain("Sold To:");
    expect(text).toContain("9054");                       // customer code in the Sold To corner
    expect(text).toContain("Ship To:");
    expect(text).toContain("Example Coating");                // the ship-to address's own name
    expect(text).toContain("Purchase Order Number");
    expect(text).toContain("DEMO-PO-24115");
    expect(text).toContain("Packing List No");
    expect(text).toContain("092826");                     // zero-padded exactly as the sample prints it
    expect(text).toContain("Customer Job No");
    expect(text).toContain("JOB-9");
    expect(text).toContain("Route");
    expect(text).toContain("South");
    expect(text).toContain("Carrier");
    expect(text).toContain("Customer");
    expect(text).toContain("DEMO01-HT");
    expect(text).toContain("Track Shoe, Vehicular");
    expect(text).toContain("D-001");
    expect(text).toContain("Container Type");
    // Whole cells, old wording or new: the count column's heading in both halves of the table.
    expect(allText(buildShippingTicketDefinition([sampleTicket()])).filter((t) => t === "Containers" || t === "# Of Containers"))
      .toEqual(["Containers", "Containers"]);
    expect(text).toContain("Cust Cont Id");
    expect(text).toContain("Bin");
    expect(text).toContain("DEMO-COMP-77");
    expect(text).toContain("SN-0001");
    expect(text).toContain("Heat A1");
    expect(text).toContain("FIRST LIABILITY PARAGRAPH.");
    expect(text).toContain("SECOND LIABILITY PARAGRAPH.");
    expect(text).toContain("Shipped Complete");
    expect(text).toContain("Quantity Shipped:");
    // Whole cells, old wording or new: the weight row's label in the totals and on the strip.
    expect(allText(buildShippingTicketDefinition([sampleTicket()])).filter((t) => t === "Net weight:" || t === "Pounds Shipped:"))
      .toEqual(["Net weight:", "Net weight:"]);
    const sheet = buildShippingTicketDefinition([sampleTicket()]);
    expect(totalsRows(sheet)).toContainEqual(["Net weight:", "4,128.00 lb"]);
    expect(stripRows(sheet)).toEqual([["Quantity Shipped:", "192.00"], ["Net weight:", "4,128.00 lb"]]);
    expect(text).toContain("Received By:");
    expect(text).toContain("Order No.: 92036");           // the tear-off's bare order number
    expect(text).toContain("Shipped ON: 07/29/2026");
    expect(text).toContain("Sold To: Demo Components Corporation");
  });

  it("omits Shipped Complete when a line is still open", () => {
    const text = allText(buildShippingTicketDefinition([sampleTicket({ shippedComplete: false })])).join("\n");
    expect(text).not.toContain("Shipped Complete");
  });
});

// -------------------------------------------------------------------------------------------
// The print mechanic — one sheet per order, stored byte-for-byte, voided shipments refuse.
// -------------------------------------------------------------------------------------------

describe("printShippingTickets", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("renders one sheet per order on the shipment", async () => {
    const { shipper } = await twoOrderShipment();
    const { pdf } = await asSystem(() => printShippingTickets(shipper.id));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.toString("latin1")).toContain("/Count 2");     // uncompressed page marker, P3's rule
  });

  it("renders one sheet when a single order is named", async () => {
    const { shipper, orderA } = await twoOrderShipment();
    const { pdf } = await asSystem(() => printShippingTickets(shipper.id, orderA.id));
    expect(pdf.toString("latin1")).toContain("/Count 1");
  });

  it("archives the whole-set print with orderId null and a single-order print with the order id", async () => {
    const { shipper, orderA } = await twoOrderShipment();
    const whole = await asSystem(() => printShippingTickets(shipper.id));
    const single = await asSystem(() => printShippingTickets(shipper.id, orderA.id));

    const wholeDoc = await getDocument(whole.documentId);
    expect(wholeDoc.kind).toBe("SHIPPER");
    expect(wholeDoc.shipperId).toBe(shipper.id);
    expect(wholeDoc.orderId).toBeNull();
    const singleDoc = await getDocument(single.documentId);
    expect(singleDoc.orderId).toBe(orderA.id);

    const listed = await listDocumentsForShipper(shipper.id);
    expect(listed.map((d) => d.id).sort()).toEqual([whole.documentId, single.documentId].sort());
  });

  it("records the archive as an audited create carrying metadata, never the bytes", async () => {
    const { shipper } = await oneOrderShipment();
    const { documentId } = await asSystem(() => printShippingTickets(shipper.id));
    const entry = await prisma.auditLog.findFirst({ where: { entity: "storedDocument", entityId: documentId } });
    expect(entry).not.toBeNull();
    const payload = JSON.stringify(entry!.after);
    expect(payload).toContain("SHIPPER");
    expect(payload).toContain(shipper.id);
    expect(payload).not.toContain("fileData");
  });

  it("reprints stored bytes exactly", async () => {
    const { shipper } = await oneOrderShipment();
    const first = await asSystem(() => printShippingTickets(shipper.id));
    const stored = await getDocument(first.documentId);
    expect(Buffer.compare(stored.fileData, first.pdf)).toBe(0);   // STORED vs original: exact
  });

  it("refuses to print a voided shipment but keeps the stored one readable", async () => {
    const { shipper } = await oneOrderShipment();
    const printed = await asSystem(() => printShippingTickets(shipper.id));
    await asSystem(() => voidShipper(shipper.id, "wrong truck"));
    await expect(asSystem(() => printShippingTickets(shipper.id))).rejects.toThrow(/voided/i);
    await expect(asSystem(() => printShippingTickets(shipper.id))).rejects.toThrow(VOIDED_PRINT);
    expect((await getDocument(printed.documentId)).fileData.length).toBeGreaterThan(0);
  });

  it("404s a shipment that does not exist and an order that is not on the shipment", async () => {
    const { shipper } = await oneOrderShipment();
    const other = await makeCustomer();
    const elsewhere = await orderFor(other);
    await expect(asSystem(() => printShippingTickets("nope"))).rejects.toThrow(/not found/i);
    await expect(asSystem(() => printShippingTickets(shipper.id, elsewhere.id)))
      .rejects.toThrow(/not on this shipment/i);
  });

  // Fix-wave (whole-branch review 2026-08-06, Important #1): the review's genuinely UNPROTECTED
  // interleaving — a print writes only a StoredDocument row nothing in the void ever reads, so no
  // write-write conflict and no SSI cycle could rescue it incidentally, and `Shipper.deletedAt`
  // lives on a row the print's order claims never covered. The voider is scripted at DEFAULT
  // (Read Committed) isolation — the certs.test.ts T5 technique — so the ONLY thing that can stop
  // the print archiving new paper against a voided shipment (§5.6) is the print path's own FOR
  // UPDATE on the Shipper row. Verified RED against the pre-fix code (order claims alone): the
  // print resolved and archived a document against the voided shipment — transcript in the
  // fix-wave report.
  it("racing a Read-Committed voidShipper, a void committed while the print blocked on the order claims archives NOTHING (fix-wave Important #1)", async () => {
    const { shipper, order } = await oneOrderShipment();

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    // voidShipper's own claim-then-void sequence, signalling ONLY once its FOR UPDATE is held
    // (the real happens-before edge — never a sleep).
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
      hasClaimed();
      await release;
      await tx.shipper.update({ where: { id: shipper.id }, data: { deletedAt: new Date() } });
    }, { timeout: 20000 });

    await claimed;
    const printCall = asSystem(() => printShippingTickets(shipper.id));

    // The probe (certs.test.ts race shape): the print must be genuinely blocked on the holder's
    // order lock before the void is released — not itself the discriminator.
    const TIMED_OUT = Symbol("timed out");
    const raceResult = await Promise.race([
      printCall.then(() => "settled" as const, () => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
    ]);
    expect(raceResult).toBe(TIMED_OUT);

    mayRelease();
    await holder;

    // The discriminator: the Serializable print's FOR UPDATE on the now-voided Shipper row raises
    // 40001 → withDbErrors' honest "try again" 409 — and NOTHING was archived. (A retry then gets
    // the ordinary voided-print 400 off a fresh snapshot.) Pre-fix the print resolves: its
    // snapshot fixed before the void committed, so assertPrintable read stale `deletedAt: null`
    // and a NEW document landed against a voided shipment.
    await expect(printCall).rejects.toMatchObject({ status: 409 });
    expect(await listDocumentsForShipper(shipper.id)).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------
// #556 (owner ruling 2026-10-18): a ticket print whose claims expire, its 15-second budget spent
// before its last statement or its commit, is refused with the owner's sentence, the whole set's
// or one order's, and stores and audits nothing. It writes one server log line, which holds the
// shipment number, the orders in the print and the seconds taken, and nothing else.
// -------------------------------------------------------------------------------------------

describe("a ticket print whose claims expire (#556)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  const refusalLine = (shipmentNumber: number, orders: number) => new RegExp(
    `^\\[shipping-ticket\\] print refused, took too long: shipment ${shipmentNumber}, orders ${orders}, (\\d+\\.\\d) s$`);
  const loggedSeconds = (line: unknown, pattern: RegExp) => Number(String(line).match(pattern)?.[1]);

  // The one case on the real clock. The archive is written and then held past the budget, so the
  // expiry surfaces at the commit, which `$transaction` runs after the callback has returned: only
  // a catch outside the transaction sees it. The probes are timed from just before the print
  // starts, so each lands about 14 s and 16 s after Prisma armed its timer at BEGIN, whatever the
  // render costs; the timer can fire late, never early. Held at 14 s (past the 5 s default) and
  // released by 16 s (past the 15 s budget), so the budget lies between them. The archive's row and
  // its audit entry were really written inside the claims, so "nothing stored or audited" is proved
  // against the timer's rollback of a real write.
  // The Order half of each probe proves the order claims: a whole-set archive holds no order id
  // (`orderId` null, `coveredOrderIds` a plain array), so nothing else locks those rows. The Shipper
  // half at 14 s proves only that the transaction still held the Shipper row: the archive's foreign
  // key to it takes a key-share lock that also makes SKIP LOCKED pass the row over.
  // The probes run because `delay` turns the event loop. They prove the budget and the rollback, not
  // when a real render releases its claims (a render of one- or two-page tickets with no logo was
  // measured not to turn the loop until its merged save); the #556 measurement, not this case, is
  // what times that.
  it("refuses a whole-set print whose claims expire at the commit: held at 14 s, released by 16 s, nothing stored or audited (#556)", async () => {
    const { shipper, orderA, orderB } = await twoOrderShipment();
    const auditRows = await prisma.auditLog.count();
    // Autocommit statements outside Prisma's transaction manager: they add nothing to its list of
    // closed transactions, so they cannot push the expired one out of it (db-errors.test.ts (h)).
    const skipLocked = async (table: "Order" | "Shipper", id: string) => (table === "Order"
      ? await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Order" WHERE id = ${id} FOR UPDATE SKIP LOCKED`
      : await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Shipper" WHERE id = ${id} FOR UPDATE SKIP LOCKED`
    ).map((r) => r.id);
    const free = async () => ({
      orders: [...await skipLocked("Order", orderA.id), ...await skipLocked("Order", orderB.id)].sort(),
      shipper: await skipLocked("Shipper", shipper.id),
    });
    let begun = 0;
    const until = (ms: number) => delay(Math.max(0, begun + ms - performance.now()));
    let at14: Awaited<ReturnType<typeof free>> | undefined;
    let at16: Awaited<ReturnType<typeof free>> | undefined;
    const realStore = documents.storeDocument;
    const store = vi.spyOn(documents, "storeDocument").mockImplementationOnce(async (...args) => {
      const doc = await realStore(...args); // the ticket's row and its audit entry, inside the claims
      await until(14_000); at14 = await free(); // past Prisma's 5 s default: the transaction still holds them
      await until(16_000); at16 = await free(); // past the 15 s budget: the timer's ROLLBACK released them
      return doc; // so the commit, after the callback, finds the transaction expired
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      begun = performance.now();
      const refused = asSystem(() => printShippingTickets(shipper.id));
      await expect(refused).rejects.toBeInstanceOf(HttpError);
      const elapsed = (performance.now() - begun) / 1000; // the print, timed here, once it refused
      await expect(refused).rejects.toMatchObject({
        status: 400,
        message: "These shipping tickets took too long to print, so nothing was stored and no certifications were printed. Print each order's ticket from its own panel.",
      });
      expect(store).toHaveBeenCalledTimes(1);
      expect(at14).toEqual({ orders: [], shipper: [] });
      expect(at16).toEqual({ orders: [orderA.id, orderB.id].sort(), shipper: [shipper.id] });
      expect(await listDocumentsForShipper(shipper.id)).toEqual([]);
      expect(await prisma.auditLog.count()).toBe(auditRows);
      // One call with one argument: the line alone, never the error or the PDF beside it.
      const line = refusalLine(shipper.shipperNumber, 2);
      expect(log.mock.calls).toEqual([[expect.stringMatching(line)]]);
      // Seconds, from after the settings read: above the budget, and within 2 s of the print as
      // timed here, which began before that read. `> 15`, not `>= 16`, for that reason.
      const seconds = loggedSeconds(log.mock.calls[0][0], line);
      expect(seconds).toBeGreaterThan(15);
      expect(Math.abs(seconds - elapsed)).toBeLessThanOrEqual(2);
    } finally {
      log.mockRestore();
      store.mockRestore();
    }
  }, 40_000);

  // The cheap cases. The two refusal cases throw the runtime's own expiry (`expiredAtQuery`, raised
  // by an expired transaction of its own) inside the print's live transaction, so Prisma rolls the
  // print back as for any throw: they prove the mapping and its sentences, not the timer. The
  // pass-through case throws a hand-built "Transaction not found" P2028 (db-errors.test.ts (h)
  // pins the runtime's own), and the case inside the budget mocks nothing.
  it("refuses one order's print with the per-order sentence, storing nothing (#556)", async () => {
    const { shipper, orderA } = await twoOrderShipment();
    const render = vi.spyOn(pdfRenderer, "renderSheetGroups").mockRejectedValueOnce(await expiredAtQuery());
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(asSystem(() => printShippingTickets(shipper.id, orderA.id))).rejects.toMatchObject({
        status: 400,
        message: "This shipping ticket took too long to print, so nothing was stored and no certifications were printed.",
      });
      expect(render).toHaveBeenCalledTimes(1);
      expect(await listDocumentsForShipper(shipper.id)).toEqual([]);
      expect(log.mock.calls).toEqual([[expect.stringMatching(refusalLine(shipper.shipperNumber, 1))]]);
    } finally {
      log.mockRestore();
      render.mockRestore();
    }
  });

  it("gives a one-order shipment's whole-set print the whole-set sentence: it follows whether an order is named (#556)", async () => {
    const { shipper } = await oneOrderShipment();
    const render = vi.spyOn(pdfRenderer, "renderSheetGroups").mockRejectedValueOnce(await expiredAtQuery());
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(asSystem(() => printShippingTickets(shipper.id))).rejects.toMatchObject({
        status: 400,
        message: "These shipping tickets took too long to print, so nothing was stored and no certifications were printed. Print each order's ticket from its own panel.",
      });
      expect(render).toHaveBeenCalledTimes(1);
      expect(await listDocumentsForShipper(shipper.id)).toEqual([]);
      expect(log.mock.calls).toEqual([[expect.stringMatching(refusalLine(shipper.shipperNumber, 1))]]);
    } finally {
      log.mockRestore();
      render.mockRestore();
    }
  });

  it("lets a P2028 that is not an expiry (Transaction not found) through unchanged, and logs nothing (#556)", async () => {
    const { shipper } = await twoOrderShipment();
    const notFound = new Prisma.PrismaClientKnownRequestError(
      "Transaction API error: Transaction not found. Transaction ID is invalid, refers to an old closed " +
        "transaction Prisma doesn't have information about anymore, or was obtained before disconnecting.",
      { code: "P2028", clientVersion: "test", meta: {} });
    const render = vi.spyOn(pdfRenderer, "renderSheetGroups").mockRejectedValueOnce(notFound);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(asSystem(() => printShippingTickets(shipper.id))).rejects.toBe(notFound);
      expect(await listDocumentsForShipper(shipper.id)).toEqual([]);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      render.mockRestore();
    }
  });

  it("a print that finishes inside its budget writes no log line (#556)", async () => {
    const { shipper } = await twoOrderShipment();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { documentId } = await asSystem(() => printShippingTickets(shipper.id));
      expect((await listDocumentsForShipper(shipper.id)).map((d) => d.id)).toEqual([documentId]);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});

// -------------------------------------------------------------------------------------------
// #52 — a whole-set ticket covers what it PRINTED, not the shipment's current membership.
// Membership stays editable after a print (owner ruling 2026-08-17): the printed paper is not
// falsified by a later addition — the newcomer's coverage comes from a fresh whole-set print.
// -------------------------------------------------------------------------------------------

describe("printShippingTickets — whole-set print-time coverage (#52)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("an order added after a whole-set print does not list that ticket; at-print members still do", async () => {
    const { shipper, orderA, orderB, customer } = await twoOrderShipment();
    const { documentId } = await asSystem(() => printShippingTickets(shipper.id));

    const orderC = await orderFor(customer, { poNumber: "PO-C", qty: 4, weight: "48.00" });
    await asSystem(() => addOrderToShipper(shipper.id, orderC.id));

    expect((await listDocumentsForOrder(orderA.id)).map((d) => d.id)).toContain(documentId);
    expect((await listDocumentsForOrder(orderB.id)).map((d) => d.id)).toContain(documentId);
    // The defect (#52): deriving coverage from CURRENT membership listed this pre-add whole-set
    // ticket — paper with no sheet for order C — on order C's hub.
    expect((await listDocumentsForOrder(orderC.id)).map((d) => d.id)).not.toContain(documentId);
  });

  it("a fresh whole-set print after the add covers the newcomer", async () => {
    const { shipper, orderA, customer } = await twoOrderShipment();
    await asSystem(() => printShippingTickets(shipper.id));
    const orderC = await orderFor(customer, { poNumber: "PO-C", qty: 4, weight: "48.00" });
    await asSystem(() => addOrderToShipper(shipper.id, orderC.id));

    const second = await asSystem(() => printShippingTickets(shipper.id));
    expect((await listDocumentsForOrder(orderC.id)).map((d) => d.id)).toContain(second.documentId);
    expect((await listDocumentsForOrder(orderA.id)).map((d) => d.id)).toContain(second.documentId);
  });

  it("a whole-set print stores exactly the member order ids; a per-order print stores none", async () => {
    const { shipper, orderA, orderB } = await twoOrderShipment();
    const wholeSet = await asSystem(() => printShippingTickets(shipper.id));
    expect((await prisma.storedDocument.findUniqueOrThrow({
      where: { id: wholeSet.documentId }, select: { coveredOrderIds: true },
    })).coveredOrderIds.slice().sort()).toEqual([orderA.id, orderB.id].sort());

    // A per-order ticket's covered order IS the row's own `orderId` (spec §4.3's sub-scope) — it
    // records no coverage list, and its sibling-exclusion listing (round-4 finding) is untouched.
    const perOrder = await asSystem(() => printShippingTickets(shipper.id, orderA.id));
    expect(await prisma.storedDocument.findUniqueOrThrow({
      where: { id: perOrder.documentId }, select: { orderId: true, coveredOrderIds: true },
    })).toMatchObject({ orderId: orderA.id, coveredOrderIds: [] });
  });
});

// -------------------------------------------------------------------------------------------
// The collector — what the payload says.
// -------------------------------------------------------------------------------------------

describe("readShippingTicketData", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("assembles the sample's blocks: parties, field strip, lines, containers, printable serials", async () => {
    await asSystem(() => setSetting("company_name", "Example Heat Treating - Alabama,"));
    const customer = await makeCustomer();
    const shipTo = await makeAddresses(customer.id);
    const order = await orderFor(customer);

    const binType = await prisma.containerType.create({ data: { name: "Bin" } });
    const container = await prisma.orderContainer.create({
      data: { orderId: order.id, position: 1, typeId: binType.id, count: 3, tareEach: "12.25", customerContainerId: "DEMO-COMP-77" },
    });
    const printable = await prisma.orderSerial.create({
      data: { orderId: order.id, lineId: order.lines[0].id, position: 1, serial: "SN-1", description: "Heat A1" },
    });
    const hidden = await prisma.orderSerial.create({
      data: { orderId: order.id, lineId: order.lines[0].id, position: 2, serial: "SN-2", description: "Heat A2" },
    });

    const { shipper } = await asSystem(() => createShipper({
      customerId: customer.id, shipDate: "2026-07-29", shipToAddressId: shipTo.id,
      route: "South", carrierId: null,
      orders: [{
        ...shipOrderInput(order),
        containers: [{ orderContainerId: container.id, count: 3 }],
        serials: [
          { orderSerialId: printable.id, printOnShipper: true },
          { orderSerialId: hidden.id, printOnShipper: false },
        ],
      }],
    }, { canOverrideCreditHold: false }));

    // The liability text binds at the DATA SEAM (shipper_liability_text retired in Task 14): the
    // collector puts settings.liabilityText onto the ticket, so a seam override proves the wiring.
    const settings = { ...(await ticketSettings()), liabilityText: "LIABILITY TEXT UNDER TEST" };
    const [ticket] = await readShippingTicketData(prisma, shipper.id, settings);

    expect(ticket.company.name).toBe("Example Heat Treating - Alabama,");
    expect(ticket.company.liabilityText).toBe("LIABILITY TEXT UNDER TEST");
    expect(ticket.soldTo.code).toBe(customer.code);
    expect(ticket.soldTo.name).toBe(customer.name);
    expect(ticket.soldTo.attn).toBe("Accounts payable"); // R14 (#671): the bill-to row's name, stacked above the customer's
    expect(ticket.soldTo.street).toBe("300 Example Way");   // the default BILL_TO address
    expect(ticket.shipTo.name).toBe("Demo Components Corporation");
    expect(ticket.shipTo.zip).toBe("36201");
    expect(ticket.orderLabel).toBe(`${order.orderNumber}-1`);
    expect(ticket.shipDate).toBe("2026-07-29");
    expect(ticket.poNumber).toBe("DEMO-PO-24115");
    expect(ticket.packingListNo).toBe(shipper.shipperNumber);
    expect(ticket.customerJobNo).toBe("JOB-9");
    expect(ticket.route).toBe("South");
    expect(ticket.lines).toEqual([{
      qty: 192, partNumber: order.lines[0].part.partNumber, partName: order.lines[0].part.name,
      partDescription: "D-001", pounds: 4128,
    }]);
    expect(ticket.containers).toEqual([{ typeName: "Bin", count: 3, customerContainerId: "DEMO-COMP-77", tareEach: 12.25 }]);
    expect(ticket.serials).toEqual([{ serial: "SN-1", description: "Heat A1" }]);  // printOnShipper only
    expect(ticket.shippedComplete).toBe(true);
    expect(ticket.totalQty).toBe(192);
  });

  it("marks the ticket incomplete when any line is still open", async () => {
    // Task 3 (quantity corrections): a line is open when it shipped under its ordered quantity and
    // nobody closed it short, so the second order ships 4 of 8 here.
    const customer = await makeCustomer();
    const shipTo = await makeAddresses(customer.id);
    const orderA = await orderFor(customer, { poNumber: "PO-A" });
    const orderB = await orderFor(customer, { poNumber: "PO-B", qty: 8, weight: "96.00" });
    const partialB = shipOrderInput(orderB, false);
    partialB.lines[0].qty = 4;
    const { shipper } = await asSystem(() => createShipper({
      customerId: customer.id, shipDate: "2026-07-29", shipToAddressId: shipTo.id,
      orders: [shipOrderInput(orderA), partialB],
    }, { canOverrideCreditHold: false }));
    const settings = await ticketSettings();
    const tickets = await readShippingTicketData(prisma, shipper.id, settings);
    expect(tickets).toHaveLength(2);
    expect(tickets[0].shippedComplete).toBe(true);
    expect(tickets[1].shippedComplete).toBe(false);
  });

  it("prints Shipped Complete for a full shipment with no tick", async () => {
    const customer = await makeCustomer();
    const shipTo = await makeAddresses(customer.id);
    const order = await orderFor(customer);
    const { shipper } = await asSystem(() => createShipper({
      customerId: customer.id, shipDate: "2026-07-29", shipToAddressId: shipTo.id,
      orders: [shipOrderInput(order, false)], // ships the line's full quantity, no tick
    }, { canOverrideCreditHold: false }));
    const data = await readShippingTicketData(prisma, shipper.id, await ticketSettings());
    expect(data[0].shippedComplete).toBe(true);
  });

  // Weights design §13.2: the ticket's container rows carry the shipment row's own tare each, a
  // kept row's included, and never the order row's. After the save below the order's one live row
  // still holds 55.00, and the kept row has no order row at all.
  it("a Containers save that changes only tare each figures changes the ticket's Tare cells, and nothing else it is built from", async () => {
    const { shipper, order } = await oneOrderShipment();
    const so = shipper.orders[0];
    const basket = await prisma.containerType.create({ data: { name: "Basket" } });
    const { keptId, orderRowId } = await keptAndLinkedRows({
      shipperId: shipper.id, shipperOrderId: so.id, orderId: order.id, typeId: basket.id });
    const settings = await ticketSettings();
    const paper = async () => {
      const [data] = await readShippingTicketData(prisma, shipper.id, settings);
      const [, row] = tableHeaded(buildShippingTicketDefinitions([data])[0], "Container Type").body;
      return {
        // Two rows fold into one printed row: the kept row on the left, the linked row on the
        // right. Tare is the third cell of each half of four.
        tareCells: [cellTexts(row[2]), cellTexts(row[6])],
        rest: { ...data, containers: data.containers.map((c) => ({ ...c, tareEach: null })) },
      };
    };
    const before = await paper();

    await replaceShipperContainers(shipper.id, so.id, {
      containers: [{ orderContainerId: orderRowId, count: 2, tareEach: "7.75" }],
      kept: [{ id: keptId, tareEach: "3.05" }],
    });
    expect(await storedTareEach(so.id)).toEqual(["3.05", "7.75"]); // they were 42.50 and 55.00
    const after = await paper();
    // 3 at 3.05 and 2 at 7.75. The order's row would give 110 lb over 55 lb each, and nothing for the kept row.
    expect(after.tareCells).toEqual([["9.15 lb", "3.05 lb each"], ["15.5 lb", "7.75 lb each"]]);
    expect(after.rest).toEqual(before.rest);
  });

  // Owner answer 1 of 2026-10-11: a ticket prints the gross the shipment page shows. The order's
  // own container row holds 55.00, so only the shipment's rows give these figures.
  it("each sheet's totals are that order's cells of the shipment page's totals, with the unit, and an order with no gross there has no Tare and no Gross weight row", async () => {
    const { shipper, orderA } = await twoOrderShipment();
    const so = shipper.orders[0];
    const basket = await prisma.containerType.create({ data: { name: "Basket" } });
    const { keptId, orderRowId } = await keptAndLinkedRows({
      shipperId: shipper.id, shipperOrderId: so.id, orderId: orderA.id, typeId: basket.id });
    await replaceShipperContainers(shipper.id, so.id, {
      containers: [{ orderContainerId: orderRowId, count: 2, tareEach: "7.75" }],
      kept: [{ id: keptId, tareEach: "3.05" }],
    });

    const detail = await getShipper(shipper.id);
    const page = shipmentTotals(savedShipmentTotalsInput(detail.orders, NO_REPORTS)).orders;
    const sheets = buildShippingTicketDefinitions(
      await readShippingTicketData(prisma, shipper.id, await ticketSettings()), "MOS_SHIPPER");
    // The page's cells are written out, so the fixture is seen to tell: a tare that is no whole
    // number of pounds (3 at 3.05 on a kept row, 2 at 7.75), a gross that is not the net, and a
    // second order with no gross. The paper's rows are built from those cells.
    expect({ page: page.map((t) => [t.net, t.tare, t.gross]), paper: sheets.map(totalsRows) }).toEqual({
      page: [["4,128.00", "24.65", "4,152.65"], ["96.00", NOT_ENTERED, NOT_AVAILABLE]],
      paper: [
        [["Quantity Shipped:", "192"], ["Net weight:", `${page[0].net} lb`],
          ["Tare:", `${page[0].tare} lb`], ["Gross weight:", `${page[0].gross} lb`]],
        [["Quantity Shipped:", "8"], ["Net weight:", `${page[1].net} lb`]],
      ],
    });
    expect(sheets.map(stripRows)).toEqual([
      [["Quantity Shipped:", "192.00"], ["Net weight:", `${page[0].net} lb`]],
      [["Quantity Shipped:", "8.00"], ["Net weight:", `${page[1].net} lb`]],
    ]);
  });
});

// -------------------------------------------------------------------------------------------
// The route — POST /api/shippers/[id]/print, gated shipping.view (spec §9).
// -------------------------------------------------------------------------------------------

describe("POST /api/shippers/[id]/print", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("requires shipping.view", async () => {
    const { shipper } = await oneOrderShipment();
    const cookie = await signInWith(["orders.view"]);
    const res = await printRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=ticket`, cookie), withParams({ id: shipper.id }));
    expect(res.status).toBe(403);
  });

  it("streams the whole-set ticket PDF with a friendly filename and the stored document id", async () => {
    const { shipper } = await oneOrderShipment();
    const cookie = await signInWith(["shipping.view"]);
    const res = await printRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=ticket`, cookie), withParams({ id: shipper.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition"))
      .toBe(`inline; filename="ticket-${shipper.shipperNumber}.pdf"`);
    const documentId = res.headers.get("x-document-id")!;
    const stored = await getDocument(documentId);
    expect(Buffer.compare(stored.fileData, Buffer.from(await res.arrayBuffer()))).toBe(0);
  });

  it("prints one order's ticket when ?order names it", async () => {
    const { shipper, orderA } = await twoOrderShipment();
    const cookie = await signInWith(["shipping.view"]);
    const res = await printRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=ticket&order=${orderA.id}`, cookie),
      withParams({ id: shipper.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition"))
      .toBe(`inline; filename="ticket-${shipper.shipperNumber}-order-${orderA.orderNumber}.pdf"`);
    expect(Buffer.from(await res.arrayBuffer()).toString("latin1")).toContain("/Count 1");
  });

  // The Task 18 version of this test also pinned the temporary bol/cert refusals; those became
  // the real print paths with Task 19 and are covered in tests/bol.test.ts / tests/cert-pdf.test.ts.
  it("rejects an unknown or missing doc kind, archiving nothing", async () => {
    const { shipper } = await oneOrderShipment();
    const cookie = await signInWith(["shipping.view"]);

    const missing = await printRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print`, cookie), withParams({ id: shipper.id }));
    expect(missing.status).toBe(400);

    const unknown = await printRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=nope`, cookie), withParams({ id: shipper.id }));
    expect(unknown.status).toBe(400);

    // The refusal archived nothing: an honest no is a no.
    expect(await listDocumentsForShipper(shipper.id)).toEqual([]);
  });

  it("refuses a voided shipment with the shared refusal", async () => {
    const { shipper } = await oneOrderShipment();
    await asSystem(() => voidShipper(shipper.id, "wrong truck"));
    const cookie = await signInWith(["shipping.view"]);
    const res = await printRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=ticket`, cookie), withParams({ id: shipper.id }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(VOIDED_PRINT);
  });
});
