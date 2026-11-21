// Rows read a second time inside one request (#628, the 2026-10-22 review's P4): a helper called
// under a claim, or after a first read, used to fetch by id what its caller already held. Each
// case here counts the statements one path sends, per root table, from Prisma's own query log (the
// order-read-statements.test.ts harness), and pins the count after the second read was removed.
// Per table and never a total, so a later `relationJoins` change moves fewer pins. A mutation that
// puts a removed read back reds its pin.
//
// The log is switched on when a client is constructed, so this file swaps the shared client for one
// built with it on, at the same database; every module this file loads gets that client.
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
import { createOrder, updateLine, type OrderDetail } from "@/server/orders";
import { recomputeOrderStatus } from "@/server/ship-ledger";
import { createShipper, readShippingTicketData, shipmentsForOrder, ticketSettings, type ShipperDetail } from "@/server/shippers";
import { addPartPrice } from "@/server/part-prices";
import { createInvoice, finalizeInvoice, printInvoice, printSelectedInvoice, recalculateInvoice } from "@/server/invoices";
import { getLockedRevision } from "@/server/order-edit";
import { pasteParts } from "@/server/parts";
import { pasteReference } from "@/server/paste";
import { paymentCandidates } from "@/server/applications";
import { listOrders, listOrdersWindow } from "@/server/order-board";
import { listShippers, listShippersWindow } from "@/server/shippers";
import { listInvoices, listInvoicesWindow } from "@/server/invoices";
import { PART_PASTE_COLUMNS } from "@/lib/part-constants";
import { signInWith } from "./helpers/auth";
import { standardInvoiceLayout } from "./helpers/invoice-canvas-fixtures";
import { publishInvoiceCanvas } from "./helpers/invoice-print-fixtures";
import { standardStatementLayout } from "./helpers/statement-canvas-fixtures";
import { publishStatementTemplate } from "./helpers/statement-print-fixtures";
import { printStatement } from "@/server/statements";
import { POST as printInvoiceRoute } from "@/app/api/invoices/[id]/print/route";
import { POST as printStatementRoute } from "@/app/api/receivables/statements/route";
import { getRevision, readRevisionRows, saveRecipeNumber } from "@/server/part-process-steps";
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
/** How many SELECTs read each table, as `{ Table: n }`, tables with none left out. */
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

let seq = 0;
async function shippedOrder(customer: Customer, shipDate: string, qty = 10): Promise<{ order: OrderDetail; shipper: ShipperDetail }> {
  seq += 1;
  const gl = await prisma.glAccount.create({ data: { name: `40${seq}`, description: "Sales" } });
  const code = await prisma.processStepCode.create({ data: { code: `SRR-${seq}`, name: "Austenitize", glAccountId: gl.id } });
  const part = await prisma.part.create({
    data: { customerId: customer.id, partNumber: `SRR-P${seq}`, name: `Part ${seq}`, description: `Desc ${seq}`, eachWeight: "1.0000" },
  });
  await asSystem(() => addPartPrice(part.id, {
    processStepCodeId: code.id, position: 1, unitPrice: "6.5100", minimumCharge: "600.00", pricePer: "EACH",
  }));
  const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({ data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize." } });
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, lines: [{ partId: part.id, qty: 10, weight: "5.00" }],
  }));
  const { shipper } = await createShipper({
    customerId: customer.id, shipDate,
    orders: [{
      orderId: order.id,
      lines: [{ orderLineId: order.lines[0].id, qty, weight: "5.00", lineComplete: false }],
      containers: [], serials: [],
    }],
  }, { canOverrideCreditHold: false });
  return { order, shipper };
}

describe("rows read once per request (#628)", () => {
  let customer: Customer;
  let order: OrderDetail;
  let shipper: ShipperDetail;
  beforeEach(async () => {
    await truncateAll();
    await seedOrderGatePrereqs();
    customer = await prisma.customer.create({ data: { code: "SRR", name: "Same Request Customer" } });
    ({ order, shipper } = await shippedOrder(customer, "2026-08-04"));
  });

  // Where the derived status equals the stored one and no tick is superseded, so no write and no
  // audit snapshot adds a read of its own: the order and its lines once, then the live shipper
  // lines once, read by the clear and handed to the derivation (it used to read the order lines
  // and the shipper lines a second time each).
  it("recomputeOrderStatus reads the order lines once and the shipper lines once", async () => {
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("SHIPPED");
    const statements = await statementsOf(() =>
      prisma.$transaction((tx) => recomputeOrderStatus(tx, [order.id])));
    const counts = selectsByTable(statements);
    expect(counts.OrderLine).toBe(1);
    expect(counts.ShipperLine).toBe(1);
    expect(statements.some((s) => /^\s*UPDATE\b/i.test(s))).toBe(false);
  });

  // The ticket takes its part descriptions and its completion targets from the detail its claim
  // read (`readShipperDetail` answers both live-first); only the ledger's live-row group is read
  // on top of it (`ShipperLine` with its `ShipperOrder` sequence). It used to read `OrderLine`
  // and `Part` again for the descriptions, and `ShipperOrder` and `ShipperLine` again for the
  // targets and `OrderLine` for their current quantities.
  // `OrderLine` is read twice by the detail itself (each order's own line set, and the live line
  // behind each shipper line) and `ShipperLine` three times (the shipment's lines, shipped-to-date,
  // then the live-row group); neither count has a read of the ticket's own on top.
  it("readShippingTicketData reads no row twice: Part once, ShipperOrder twice, OrderLine twice", async () => {
    const settings = await ticketSettings();
    const statements = await statementsOf(() => readShippingTicketData(prisma, shipper.id, settings));
    const counts = selectsByTable(statements);
    expect(counts.Part).toBe(1);
    expect(counts.ShipperOrder).toBe(2);
    expect(counts.OrderLine).toBe(2);
    expect(counts.ShipperLine).toBe(3);
    // Live-first still: the description prints as the part reads now, not as it was captured.
    await prisma.part.updateMany({ where: { customerId: customer.id }, data: { description: "Renamed since" } });
    const [ticket] = await readShippingTicketData(prisma, shipper.id, settings);
    expect(ticket.shippedComplete).toBe(true);
    expect(ticket.lines[0].partDescription).toBe("Renamed since");
  });

  // The hub's Shipments read widens its own select by the three columns and the order line's
  // current quantity that the completion rule needs, and hands those rows to the rule, so the
  // `ShipperOrder` rows and their lines are read once: the rows, then the ledger's live-row group.
  it("shipmentsForOrder reads the ShipperOrder rows once: ShipperOrder twice, ShipperLine twice", async () => {
    const statements = await statementsOf(() => shipmentsForOrder(order.id));
    const counts = selectsByTable(statements);
    expect(counts.ShipperOrder).toBe(2);
    expect(counts.ShipperLine).toBe(2);
    expect(counts.OrderLine).toBe(1);
    const [row] = await shipmentsForOrder(order.id);
    expect(row.orders[0].complete).toBe(true);
  });

  // The hub's rows judge a live line against its CURRENT ordered quantity, as the ledger always
  // has (#473): the wider select carries the snapshot `orderedQty` too, and a target built from the
  // snapshot would hold a corrected-down order Partial for good.
  it("shipmentsForOrder judges a live line by its current ordered quantity, not the snapshot", async () => {
    const short = await shippedOrder(customer, "2026-08-05", 4);
    expect((await shipmentsForOrder(short.order.id))[0].orders[0].complete).toBe(false);
    await asSystem(() => updateLine(short.order.id, short.order.lines[0].id, { qty: 4 }));
    expect((await shipmentsForOrder(short.order.id))[0].orders[0].complete).toBe(true);
    expect((await prisma.shipperLine.findFirstOrThrow({ where: { shipperOrderId: short.shipper.orders[0].id } })).orderedQty).toBe(10);
  });
});

describe("invoice rows read once per request (#627)", () => {
  let customer: Customer;
  let order: OrderDetail;
  beforeEach(async () => {
    await truncateAll();
    await seedOrderGatePrereqs();
    customer = await prisma.customer.create({ data: { code: "SRI", name: "Same Request Invoicing" } });
    ({ order } = await shippedOrder(customer, "2026-08-04"));
  });

  /** The SELECTs on `InvoiceLine` sent before the first DELETE: the claim's include is one, the
   *  audit's before-snapshot another; a read of the previous line set on top was the third. */
  const lineSelectsBeforeDelete = (statements: string[]) => {
    const firstDelete = statements.findIndex((s) => /^\s*DELETE\b/i.test(s));
    return selectsByTable(statements.slice(0, firstDelete === -1 ? statements.length : firstDelete)).InvoiceLine ?? 0;
  };

  it("recalculateInvoice takes the previous line set from its claim, not a second read", async () => {
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    const statements = await statementsOf(() => asSystem(() => recalculateInvoice(invoice.id)));
    expect(lineSelectsBeforeDelete(statements)).toBe(2);
  });

  // The stub read and the claim are the two `Invoice` SELECTs; the paper renders from the claimed
  // row, so no third read of the same include (its lines among them) runs under the claim. The
  // `Setting` reads are the print settings outside the transaction and the number prefix once on
  // `tx`, for the refusal and the paper alike; the selected print used to read the prefix twice.
  it.each([
    ["printInvoice", (id: string) => printInvoice(id)],
    ["printSelectedInvoice", (id: string) => printSelectedInvoice(id)],
  ])("%s reads the Invoice row twice (stub and claim) and the prefix once", async (_name, print) => {
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    await asSystem(() => finalizeInvoice(invoice.id));
    const statements = await statementsOf(() => asSystem(() => print(invoice.id)));
    const counts = selectsByTable(statements);
    expect(counts.Invoice).toBe(2);
    expect(counts.InvoiceLine).toBe(1);
    expect(counts.Setting).toBe(2);
  });

  // The same counts on a canvas template (invoice canvas PR 3; design 2026-11-10 §11, call 14: the
  // canvas adds no read). The customer is assigned a published canvas template, and the stored
  // document's stamp proves the print ran on it. Reds when the paper is read again under the claim
  // (a second `tx.invoice.findFirst` with the claim's include: `Invoice` 3).
  it.each([
    ["printInvoice", (id: string) => printInvoice(id)],
    ["printSelectedInvoice", (id: string) => printSelectedInvoice(id)],
  ])("%s under a canvas template reads the Invoice row twice (stub and claim) and the prefix once", async (_name, print) => {
    const versionId = await publishInvoiceCanvas(customer.id, standardInvoiceLayout());
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    await asSystem(() => finalizeInvoice(invoice.id));
    let documentId = "";
    const statements = await statementsOf(async () => { ({ documentId } = await asSystem(() => print(invoice.id))); });
    const counts = selectsByTable(statements);
    expect(counts.Invoice).toBe(2);
    expect(counts.InvoiceLine).toBe(1);
    expect(counts.Setting).toBe(2);
    expect((await prisma.storedDocument.findUniqueOrThrow({ where: { id: documentId } })).templateVersionId).toBe(versionId);
  });
});

describe("a locked revision's captured snapshot is read without its step tree (G1-6)", () => {
  let customer: Customer;
  beforeEach(async () => {
    await truncateAll();
    await seedOrderGatePrereqs();
    customer = await prisma.customer.create({ data: { code: "G16", name: "Snapshot First" } });
  });

  /** A part with one step, and an order on it, which locks revision 1 at save. With a recipe
   *  number the lock captures the snapshot; without one the revision locks and captures none. */
  async function lockedOrder(recipeNumber: string | null) {
    seq += 1;
    const code = await prisma.processStepCode.create({ data: { code: `G16-${seq}`, name: "Austenitize" } });
    const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: `G16-P${seq}`, eachWeight: "1.0000" } });
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    await prisma.partProcessStep.create({ data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." } });
    if (recipeNumber !== null) await asSystem(() => saveRecipeNumber(part.id, { recipeNumber, expectedRecipeNumber: null }));
    const { order } = await asSystem(() => createOrder({ customerId: customer.id, lines: [{ partId: part.id, qty: 10, weight: "5.00" }] }));
    const stored = await prisma.partProcessRevision.findUniqueOrThrow({ where: { id: rev.id } });
    expect(stored.lockedAt).not.toBeNull();
    expect(stored.recipeSnapshot === null).toBe(recipeNumber === null);
    return { part, order };
  }

  // The hub's Process section and the traveler print read the captured projection; the step,
  // code and parameter rows it used to load first were discarded.
  it.each([
    ["getLockedRevision (the hub's Process section)", (part: { id: string }, order: { id: string }) => asSystem(() => getLockedRevision(order.id))],
    ["getRevision (the traveler print)", (part: { id: string }) => getRevision(part.id, 1)],
  ])("%s reads the revision row alone for a captured snapshot", async (_name, read) => {
    const { part, order } = await lockedOrder("G16R");
    const statements = await statementsOf(() => read(part, order));
    const counts = selectsByTable(statements);
    expect(counts.PartProcessRevision).toBe(1);
    expect(counts.PartProcessStep).toBeUndefined();
    expect(counts.PartProcessStepParameter).toBeUndefined();
    expect(counts.ProcessStepCode).toBeUndefined();
    const detail = await read(part, order);
    expect(detail.recipeNumber).toBe("G16R");
    expect(detail.recipeSnapshot?.recipeNumber).toBe("G16R");
    expect(detail.steps.map((s) => [s.position, s.code, s.instruction])).toEqual([[1, `G16-${seq}`, "Austenitize at 1650F."]]);
  });

  // The control: a locked revision that captured no snapshot (no recipe number) still reads its
  // tree, and answers what the editor's rows read answers.
  it("getLockedRevision reads the step tree for a locked revision with no snapshot, as before", async () => {
    const { part, order } = await lockedOrder(null);
    const statements = await statementsOf(() => asSystem(() => getLockedRevision(order.id)));
    const counts = selectsByTable(statements);
    expect(counts.PartProcessRevision).toBe(1);
    expect(counts.PartProcessStep).toBe(1);
    expect(counts.PartProcessStepParameter).toBe(1);
    const detail = await asSystem(() => getLockedRevision(order.id));
    expect(detail.recipeSnapshot).toBeNull();
    expect(detail).toEqual(await readRevisionRows(part.id, 1));
  });
});

describe("create takes the lead line's price rows from the pricing read (#622, its lead-line half)", () => {
  let customer: Customer;
  beforeEach(async () => {
    await truncateAll();
    await seedOrderGatePrereqs();
    customer = await prisma.customer.create({ data: { code: "SRL", name: "Lead Line Prices" } });
  });

  /** A priced part with one step; `processName` blank unless given. */
  async function pricedPart(processName = "") {
    seq += 1;
    const gl = await prisma.glAccount.create({ data: { name: `41${seq}`, description: "Sales" } });
    const code = await prisma.processStepCode.create({ data: { code: `SRL-${seq}`, name: `Step ${seq}`, glAccountId: gl.id } });
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: `SRL-P${seq}`, eachWeight: "1.0000", processName },
    });
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    await prisma.partProcessStep.create({ data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Run." } });
    await asSystem(() => addPartPrice(part.id, {
      processStepCodeId: code.id, position: 1, unitPrice: "6.5100", minimumCharge: "600.00", pricePer: "EACH",
    }));
    return { part, stepName: `Step ${seq}` };
  }

  /** Lead and rider, the lead shipping `leadQty` (0 means closed short with nothing shipped). */
  async function shippedPair(leadProcessName: string, leadQty: number) {
    const lead = await pricedPart(leadProcessName);
    const rider = await pricedPart();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id,
      lines: [{ partId: lead.part.id, qty: 10, weight: "5.00" }, { partId: rider.part.id, qty: 10, weight: "5.00" }],
    }));
    await createShipper({
      customerId: customer.id, shipDate: "2026-08-04",
      orders: [{
        orderId: order.id,
        lines: [
          { orderLineId: order.lines[0].id, qty: leadQty, weight: leadQty === 0 ? "0.00" : "5.00", lineComplete: leadQty === 0 },
          { orderLineId: order.lines[1].id, qty: 10, weight: "5.00", lineComplete: false },
        ],
        containers: [], serials: [],
      }],
    }, { canOverrideCreditHold: false });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("SHIPPED");
    return { order, lead, rider };
  }

  it("a priced lead with a blank processName: one PartPrice read for every priced line (#622), the header from the same rows", async () => {
    const { order, lead, rider } = await shippedPair("", 10);
    let created: Awaited<ReturnType<typeof createInvoice>> | undefined;
    const statements = await statementsOf(() => asSystem(async () => { created = await createInvoice({ orderId: order.id }); }));
    expect(selectsByTable(statements).PartPrice).toBe(1);
    expect(created?.invoice.processNames).toBe(lead.stepName);
    expect(created?.invoice.lines.filter((l) => l.kind === "OPERATION").map((l) => l.description).sort())
      .toEqual([lead.stepName, rider.stepName].sort());
  });

  it("a lead with a processName: the header is that name and its rows are not read for it", async () => {
    const { order } = await shippedPair("MARQUENCH", 10);
    let created: Awaited<ReturnType<typeof createInvoice>> | undefined;
    const statements = await statementsOf(() => asSystem(async () => { created = await createInvoice({ orderId: order.id }); }));
    expect(selectsByTable(statements).PartPrice).toBe(1);
    expect(created?.invoice.processNames).toBe("MARQUENCH");
  });

  // A zero-net lead is skipped by the pricing loop (#96's seam), so its rows are not in the
  // pricing read; the header still names its priced operations, from the one read kept for it.
  it("a zero-net lead with a blank processName still names its operations, from a read of its own", async () => {
    const { order, lead, rider } = await shippedPair("", 0);
    let created: Awaited<ReturnType<typeof createInvoice>> | undefined;
    const statements = await statementsOf(() => asSystem(async () => { created = await createInvoice({ orderId: order.id }); }));
    expect(selectsByTable(statements).PartPrice).toBe(2);
    expect(created?.invoice.processNames).toBe(lead.stepName);
    expect(created?.invoice.lines.filter((l) => l.kind === "OPERATION").map((l) => l.description)).toEqual([rider.stepName]);
  });
});

describe("spreadsheet paste resolves each distinct name once before its loop (G5-7)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  const partRow = (vals: Partial<Record<(typeof PART_PASTE_COLUMNS)[number], string>>) =>
    PART_PASTE_COLUMNS.map((c) => vals[c] ?? "").join("\t");

  // Three rows naming one customer and one material: the paste reads each once, then each row's
  // own Serializable create re-checks both on its transaction (the TOCTOU rule, kept). It used to
  // read the customer and the material again per row before the create, two statements a row.
  it("pasteParts: three rows, one customer and one material, read the customer 4 times and the material 4 times", async () => {
    await prisma.customer.create({ data: { code: "ACME", name: "Acme Foundry" } });
    await prisma.material.create({ data: { name: "Ductile iron" } });
    const text = [1, 2, 3].map((n) =>
      partRow({ customerCode: "ACME", partNumber: `P${n}`, materialName: "Ductile iron", eachWeight: "1" })).join("\n");
    let result: Awaited<ReturnType<typeof pasteParts>> | undefined;
    const statements = await statementsOf(async () => { result = await pasteParts(text); });
    expect(result).toEqual({ created: 3, errors: [] });
    const counts = selectsByTable(statements);
    expect(counts.Customer).toBe(4);
    expect(counts.Material).toBe(4);
  });

  it("pasteParts: an unknown customer and an unknown material keep their per-row sentences", async () => {
    await prisma.customer.create({ data: { code: "ACME", name: "Acme Foundry" } });
    const text = [
      partRow({ customerCode: "ZZZ", partNumber: "1", eachWeight: "1" }),
      partRow({ customerCode: "ACME", partNumber: "2", eachWeight: "1", materialName: "Unobtainium" }),
      partRow({ customerCode: "ACME", partNumber: "3", eachWeight: "1" }),
    ].join("\n");
    const result = await pasteParts(text);
    expect(result.created).toBe(1);
    expect(result.errors).toEqual([
      { row: 1, message: 'Customer "ZZZ" does not exist' },
      { row: 2, message: 'Material "Unobtainium" does not exist' },
    ]);
  });

  // The reference paste's link columns the same way: three inspection codes naming one default
  // scale read the scale once for the names, then once per row inside the create (`assertRefExists`).
  it("pasteReference: three inspection codes on one default scale read the scale 4 times", async () => {
    await prisma.inspectionScale.create({ data: { name: "HRC" } });
    const text = ["IC-1\tHRC", "IC-2\t HRC ", "IC-3\tHRC"].join("\n");
    let result: Awaited<ReturnType<typeof pasteReference>> | undefined;
    const statements = await statementsOf(async () => { result = await pasteReference("inspectionCode", text); });
    expect(result).toEqual({ created: 3, errors: [] });
    expect(selectsByTable(statements).InspectionScale).toBe(4);
    const rows = await prisma.inspectionCode.findMany({ select: { defaultScale: { select: { name: true } } } });
    expect(rows.map((r) => r.defaultScale?.name)).toEqual(["HRC", "HRC", "HRC"]);
  });

  it("pasteReference: an unknown default scale keeps its per-row sentence", async () => {
    const result = await pasteReference("inspectionCode", "IC-1\tNOPE\nIC-2\t");
    expect(result.created).toBe(1);
    expect(result.errors).toEqual([{ row: 1, message: 'Default scale "NOPE" does not exist' }]);
  });
});

describe("the print routes name their file from the stored row's metadata, not its bytes (2026-10-22 review, coverage gap (a))", () => {
  let customer: Customer;
  let order: OrderDetail;
  beforeEach(async () => {
    await truncateAll();
    await seedOrderGatePrereqs();
    customer = await prisma.customer.create({ data: { code: "SRD", name: "Document Meta" } });
    ({ order } = await shippedOrder(customer, "2026-08-04"));
  });

  const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
  /** The `StoredDocument` SELECTs sent after the print's INSERT, split by whether they read the bytes. */
  function storedDocumentReadsAfterInsert(statements: string[]) {
    const insertAt = statements.findIndex((s) => /^\s*INSERT\b[^]*"StoredDocument"/i.test(s));
    expect(insertAt).toBeGreaterThan(-1);
    const after = statements.slice(insertAt + 1).filter((s) => /^\s*SELECT\b/i.test(s) && table(s) === "StoredDocument");
    const readsBytes = (s: string) => /"StoredDocument"\."fileData"/.test(s.slice(0, s.search(/\bFROM\b/)));
    return { withBytes: after.filter(readsBytes), metaOnly: after.filter((s) => !readsBytes(s)) };
  }

  // After the print commits, each route reads the stored row back to name the download. That read
  // used to be `getDocument`, which selects `fileData`: the whole PDF pulled out of the database
  // again, per print and per Print selected row, to build a filename from the row's metadata.
  it("the invoice print route reads the stored row's metadata once and its bytes never", async () => {
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    const cookie = await signInWith(["invoicing.view", "invoicing.create"], "doc-meta-inv");
    let res: Response | undefined;
    const statements = await statementsOf(async () => {
      res = await printInvoiceRoute(new Request(`http://t/api/invoices/${invoice.id}/print`, { method: "POST", headers: { cookie } }), withParams({ id: invoice.id }));
    });
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-disposition")).toBe(`inline; filename="Invoice-${order.orderNumber}.pdf"`);
    const reads = storedDocumentReadsAfterInsert(statements);
    expect(reads.withBytes).toEqual([]);
    expect(reads.metaOnly).toHaveLength(1);
  });

  it("the statement print route reads the stored row's metadata once and its bytes never", async () => {
    const cookie = await signInWith(["receivables.view"], "doc-meta-stmt");
    let res: Response | undefined;
    const statements = await statementsOf(async () => {
      res = await printStatementRoute(new Request("http://t/api/receivables/statements", {
        method: "POST", headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ customerId: customer.id, asOf: "2026-08-08" }),
      }), withParams({}));
    });
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-disposition")).toBe(`inline; filename="statement-${customer.code}.pdf"`);
    const reads = storedDocumentReadsAfterInsert(statements);
    expect(reads.withBytes).toEqual([]);
    expect(reads.metaOnly).toHaveLength(1);
  });

  // The statement's canvas adds no read (since statement canvas PR 2; design 2026-11-11 §5.1): the
  // customer printed on the Standard, then on a canvas assigned to it, reads every table the same
  // number of times, but for the three template-resolution tables, left out because an assignment
  // changes what resolution reads. No count is retyped: each is the Standard print's own. Reds when
  // the canvas path reads anything more (a second `buildStatementInTx` under the canvas branch, say).
  it("a statement printed on a canvas template reads what the Standard's print reads", async () => {
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    await asSystem(() => finalizeInvoice(invoice.id));
    const opts = { combineFamily: false, assessFinanceCharges: false };
    const standard = (await prisma.documentTemplate.findFirstOrThrow({
      where: { docType: "STATEMENT", isDefault: true, deletedAt: null },
    })).publishedVersionId;

    let flowDocumentId = "";
    const flowCounts = selectsByTable(await statementsOf(async () => {
      ({ documentId: flowDocumentId } = await asSystem(() => printStatement(customer.id, opts)));
    }));
    const canvas = await publishStatementTemplate("Same reads canvas", [customer.id], standardStatementLayout());
    let canvasDocumentId = "";
    const canvasCounts = selectsByTable(await statementsOf(async () => {
      ({ documentId: canvasDocumentId } = await asSystem(() => printStatement(customer.id, opts)));
    }));

    const resolution = new Set(["DocumentTemplate", "DocumentTemplateVersion", "CustomerTemplateAssignment"]);
    const tables = [...new Set([...Object.keys(flowCounts), ...Object.keys(canvasCounts)])].filter((t) => !resolution.has(t));
    expect(tables).toContain("Invoice");
    for (const t of tables) expect(canvasCounts[t], t).toBe(flowCounts[t]);
    const stamp = async (id: string) => (await prisma.storedDocument.findUniqueOrThrow({ where: { id } })).templateVersionId;
    expect(await stamp(flowDocumentId)).toBe(standard);
    expect(await stamp(canvasDocumentId)).toBe(canvas);
  });
});

// #613 (landing unit 21): the Apply panel's batched read is a fixed number of statements, however
// many open invoices the family holds. Before it the panel sent one request per invoice, each
// reading the invoice and its applications twice (`discountOffer` and `invoiceOpenBalanceById`) and
// the payment once more. The counts are pinned per table, and the second case must equal the first.
describe("the Apply panel's candidates are read once per request (#613)", () => {
  beforeEach(truncateAll);

  async function payerWith(invoices: number): Promise<{ customerId: string; paymentId: string }> {
    seq += 1;
    const customer = await prisma.customer.create({ data: { code: `BAT${seq}`, name: `Batched ${seq}` } });
    const type = await prisma.paymentType.create({ data: { name: `PT-BAT-${seq}` } });
    const batch = await prisma.receiptBatch.create({ data: { batchNumber: 700000 + seq, depositDate: new Date("2026-08-08T00:00:00Z") } });
    const payment = await prisma.payment.create({
      data: { batchId: batch.id, customerId: customer.id, paymentTypeId: type.id, amount: 1000, receivedDate: new Date("2026-08-08T00:00:00Z") },
    });
    for (let i = 0; i < invoices; i += 1) {
      seq += 1;
      const order = await prisma.order.create({
        data: { orderNumber: 710000 + seq, customerId: customer.id, status: "SHIPPED", receivedDate: new Date("2026-08-01T00:00:00Z"), requestDate: new Date("2026-08-01T00:00:00Z") },
      });
      await prisma.invoice.create({
        data: { kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: customer.id, invoiceDate: new Date("2026-08-08T00:00:00Z"), total: 100 + i, finalizedAt: new Date() },
      });
    }
    return { customerId: customer.id, paymentId: payment.id };
  }

  it("reads the payment, the family, the prefix and the invoices once, whatever the row count", async () => {
    const one = await payerWith(1);
    const six = await payerWith(6);
    const first = selectsByTable(await statementsOf(() => asSystem(() => paymentCandidates(one.paymentId, one.customerId))));
    const second = selectsByTable(await statementsOf(() => asSystem(() => paymentCandidates(six.paymentId, six.customerId))));
    // The payment and its applications; the payer and the family (`familyCustomerIds`); the prefix;
    // the invoices, with Prisma's one statement per selected relation (order, customer, applications).
    expect(first).toEqual({ Payment: 1, Application: 2, Customer: 3, Setting: 1, Invoice: 1, Order: 1 });
    expect(second).toEqual(first);
  });
});

// #612 PR B: the board's windowed read is bounded in the database, one past the window, where the
// unbounded read has no bound; read off the statement itself, since a read that returns every row
// and cuts in memory answers the same rows.
describe("the board's windowed read is bounded in the database (#612)", () => {
  beforeEach(truncateAll);

  it("listOrdersWindow sends LIMIT window + 1, and listOrders sends no LIMIT", async () => {
    const orderSelect = (statements: string[]) => statements.find((st) => /^\s*SELECT\b/i.test(st) && table(st) === "Order");
    const windowed = orderSelect(await statementsOf(() => listOrdersWindow({}, 5)));
    const unbounded = orderSelect(await statementsOf(() => listOrders({})));
    expect(windowed).toMatch(/\bLIMIT\b/);
    expect(unbounded).toBeDefined();
    expect(unbounded).not.toMatch(/\bLIMIT\b/);
  });
});

// #612 PR C: the shipping list's windowed read is bounded the same way.
describe("the shipping list's windowed read is bounded in the database (#612)", () => {
  beforeEach(truncateAll);

  it("listShippersWindow sends LIMIT window + 1, and listShippers sends no LIMIT", async () => {
    const shipperSelect = (statements: string[]) => statements.find((st) => /^\s*SELECT\b/i.test(st) && table(st) === "Shipper");
    const windowed = shipperSelect(await statementsOf(() => listShippersWindow({}, 5)));
    const unbounded = shipperSelect(await statementsOf(() => listShippers({})));
    expect(windowed).toMatch(/\bLIMIT\b/);
    expect(unbounded).toBeDefined();
    expect(unbounded).not.toMatch(/\bLIMIT\b/);
  });
});

// #612 PR D: the Invoicing list's windowed read is bounded the same way.
describe("the Invoicing list's windowed read is bounded in the database (#612)", () => {
  beforeEach(truncateAll);

  it("listInvoicesWindow sends LIMIT window + 1, and listInvoices sends no LIMIT", async () => {
    const invoiceSelect = (statements: string[]) => statements.find((st) => /^\s*SELECT\b/i.test(st) && table(st) === "Invoice");
    const windowed = invoiceSelect(await statementsOf(() => listInvoicesWindow({}, 5)));
    const unbounded = invoiceSelect(await statementsOf(() => listInvoices({})));
    expect(windowed).toMatch(/\bLIMIT\b/);
    expect(unbounded).toBeDefined();
    expect(unbounded).not.toMatch(/\bLIMIT\b/);
  });
});
