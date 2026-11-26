import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createOrder, getOrder, replaceCharges, addLine, updateLine, type OrderDetail } from "@/server/orders";
import {
  createShipper, voidShipper, replaceShipperLines, updateShipper, reverseShipper,
} from "@/server/shippers";
import { addPartPrice } from "@/server/part-prices";
import {
  createSurcharge, setCustomerSurcharge, updateSurcharge, setSurchargeStepCodes,
} from "@/server/surcharges";
import { setSetting } from "@/server/settings";
import { setBillingConfig } from "@/server/billing-config";
import {
  createInvoice, listInvoiceCandidates, getInvoice,
  updateInvoice, replaceInvoiceLines, recalculateInvoice, discardInvoice,
  finalizeInvoice, unlockInvoice, createCredit, invoiceWarnings, restoreRemovedLine,
  type InvoiceDetail, type InvoiceLineDetail,
} from "@/server/invoices";
import { applyPayment, voidApplication } from "@/server/applications";
import { readAudit } from "@/server/audit";
import type { Customer, Part } from "../prisma/generated/prisma/client";
import type { CertScopeValue } from "@/lib/cert-constants";
import { addDays, formatDateOnly, parseDateOnly, todayDateOnly } from "@/lib/business-days";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

// -------------------------------------------------------------------------------------------
// Fixtures. `asSystem`, `makeCustomer`, `makePart`, `giveSteps`, `savedOrder` and `oneOrderInput`
// are copied from tests/shippers.test.ts:1-143 (copying across test files is this repo's
// convention). The invoicing-specific helpers below are the six task-11-brief.md Step 1 defines;
// the ones whose bodies call Task 12-15 exports (finalizeInvoice / replaceInvoiceLines) are added
// by those tasks, in a shared tests/helpers/invoicing.ts, when a second file first needs them.
// -------------------------------------------------------------------------------------------

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

async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `HT-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

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
      containers: [] as { orderContainerId: string; count: number }[],
      serials: [] as { orderSerialId: string; printOnShipper?: boolean }[],
    }],
  };
}

/** An order whose one line ships its full ordered quantity -> status SHIPPED, by quantity
 *  (line-completion.ts). No pricing. */
async function shippedOrder(opts: { qty?: number } = {}) {
  const { order, part, customer } = await savedOrder({ qty: opts.qty ?? 144, weight: "3024.00" });
  const input = oneOrderInput(order);
  const { shipper } = await createShipper(input, { canOverrideCreditHold: false });
  return { order: await getOrder(order.id), part, customer, shipper };
}

/** Ships 10 of the 144 ordered and does not close the line short -> status PARTIAL_SHIPPED. */
async function partiallyShippedOrder() {
  const { order, part, customer } = await savedOrder({ qty: 144, weight: "3024.00" });
  const input = oneOrderInput(order);
  input.orders[0].lines[0].qty = 10;
  const { shipper } = await createShipper(input, { canOverrideCreditHold: false });
  return { order: await getOrder(order.id), part, customer, shipper };
}

/** `shippedOrder`, plus one PartPrice row on its part and a GL account behind the step code.
 *  `minimumCharge: null` means NO minimum (distinct from omitting it, which defaults to 600). */
async function pricedShippedOrder(opts: {
  qty?: number; unitPrice?: string; minimumCharge?: string | null; setupCharge?: string;
  pricePer?: string; glAccount?: string | null;
} = {}) {
  const fixture = await shippedOrder({ qty: opts.qty });
  const gl = opts.glAccount === null ? null
    : await prisma.glAccount.create({ data: { name: opts.glAccount ?? "4010", description: "Sales" } });
  const code = await prisma.processStepCode.create({
    data: { code: "AUST", name: "Austemper", glAccountId: gl?.id ?? null } });
  const minimumCharge = opts.minimumCharge === undefined ? "600.00" : opts.minimumCharge;
  await asSystem(() => addPartPrice(fixture.part.id, {
    processStepCodeId: code.id, position: 1,
    unitPrice: opts.unitPrice ?? "6.5100",
    ...(minimumCharge !== null ? { minimumCharge } : {}),
    ...(opts.setupCharge ? { setupCharge: opts.setupCharge } : {}),
    pricePer: opts.pricePer ?? "EACH",
  }));
  return { ...fixture, stepCode: code, glAccount: gl };
}

beforeEach(async () => {
  await truncateAll();
  await seedOrderGatePrereqs();
});

describe("listInvoiceCandidates", () => {
  it("lists only orders at SHIPPED with no live invoice", async () => {
    const { order } = await shippedOrder();
    expect((await listInvoiceCandidates({})).map((c) => c.orderNumber)).toEqual([order.orderNumber]);
    await asSystem(() => createInvoice({ orderId: order.id }));
    expect(await listInvoiceCandidates({})).toEqual([]);
  });

  it("excludes a partially shipped order and a voided one", async () => {
    await partiallyShippedOrder();
    expect(await listInvoiceCandidates({})).toEqual([]);
    const { order: voided } = await shippedOrder();
    await prisma.order.update({ where: { id: voided.id }, data: { deletedAt: new Date() } });
    expect(await listInvoiceCandidates({})).toEqual([]);
  });

  // #1057 ruling 6a (owner, 2026-11-26): the ship-date range applies to each order's LAST live
  // shipment, the figure the Last Ship Date column shows, never to any shipment of the order.
  it("keeps an order by its last live shipment's date, not by an earlier shipment in the range", async () => {
    const { order, shipper: first } = await partiallyShippedOrder();
    const rest = oneOrderInput(order);
    rest.shipDate = "2026-09-02";
    rest.orders[0].lines[0].qty = order.lines[0].qty - 10;
    await createShipper(rest, { canOverrideCreditHold: false });
    await prisma.shipper.update({ where: { id: first.id }, data: { shipDate: parseDateOnly("2026-08-04") } });
    const listed = (filter: { from?: string; to?: string }) =>
      listInvoiceCandidates(filter).then((rows) => rows.map((c) => c.orderNumber));
    expect(await listed({ from: "2026-08-01", to: "2026-08-31" })).toEqual([]);
    expect(await listed({ to: "2026-08-31" })).toEqual([]);
    expect(await listed({ from: "2026-09-02", to: "2026-09-02" })).toEqual([order.orderNumber]);
    expect(await listed({ from: "2026-09-01" })).toEqual([order.orderNumber]);
    expect(await listed({ from: "2026-09-03" })).toEqual([]);
    // The range reads the figure the column shows.
    const [row] = await listInvoiceCandidates({});
    expect(row.lastShipDate).toBe("2026-09-02");
  });

  it("keeps only the named customer's orders", async () => {
    const { order: a } = await shippedOrder();
    const { order: b } = await shippedOrder();
    const listed = (customerId: string) =>
      listInvoiceCandidates({ customerId }).then((rows) => rows.map((c) => c.orderNumber));
    expect(await listed(a.customerId)).toEqual([a.orderNumber]);
    expect(await listed(b.customerId)).toEqual([b.orderNumber]);
  });
});

describe("createInvoice", () => {
  it("snapshots shipped quantities, part identity and the resolved price", async () => {
    const { order } = await pricedShippedOrder({ qty: 144, unitPrice: "6.5100", minimumCharge: "600.00" });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    const part = invoice.lines.find((l) => l.kind === "PART")!;
    const op = invoice.lines.find((l) => l.kind === "OPERATION")!;
    expect(part.qty).toBe(144);
    expect(op.amount).toBe(937.44);
    expect(op.unitPrice).toBe(6.51);
    expect(op.minimumCharge).toBe(600);
    expect(op.priceSource).toBe("PART_PRICE");
    expect(op.glAccountName).toBe("4010");
    expect(op.parentLineId).toBe(part.id); // the OPERATION hangs off its PART line (second-pass patch)
    expect(invoice.total).toBe(937.44);
  });

  it("bills an active surcharge with its own GL account and rate (seam #2)", async () => {
    const surGl = await prisma.glAccount.create({ data: { name: "4500", description: "Energy surcharge" } });
    await asSystem(() => createSurcharge({
      name: "EnergySur", kind: "PERCENT", rate: "0.050000", position: 1, glAccountId: surGl.id, scope: "ALL",
    }));
    // 5% of a $100 operation -> $5, posting to the surcharge's own GL, snapshotting its rate.
    const { order } = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    const surLine = invoice.lines.find((l) => l.kind === "SURCHARGE")!;
    expect(surLine.amount).toBe(5);
    expect(surLine.glAccountName).toBe("4500");
    expect(surLine.rate).toBe(0.05);
    expect(invoice.surchargeTotal).toBe(5);
  });

  it("suppresses a surcharge for a customer who has opted out of it", async () => {
    const { id: surchargeId } = await asSystem(() => createSurcharge({
      name: "EnergySur", kind: "PERCENT", rate: "0.050000", position: 1, scope: "ALL",
    }));
    const { order, customer } = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
    await asSystem(() => setCustomerSurcharge(customer.id, surchargeId, { optOut: true }));
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.lines.some((l) => l.kind === "SURCHARGE")).toBe(false);
    expect(invoice.surchargeTotal).toBe(0);
  });

  it("numbers an invoice by its order and carries the prefix", async () => {
    await setSetting("invoice_number_prefix", "7");
    const { order } = await pricedShippedOrder();
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.documentNumber).toBe(`7 - ${order.orderNumber}`);
    expect(invoice.creditNumber).toBeNull();
  });

  it("refuses a second live invoice for one order", async () => {
    const { order } = await pricedShippedOrder();
    await asSystem(() => createInvoice({ orderId: order.id }));
    await expect(asSystem(() => createInvoice({ orderId: order.id })))
      .rejects.toThrow(/already has an invoice/i);
  });

  it("allows a new invoice after the first draft is discarded", async () => {
    const { order } = await pricedShippedOrder();
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    await prisma.invoice.update({ where: { id: invoice.id }, data: { deletedAt: new Date() } });
    const second = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(second.invoice.id).not.toBe(invoice.id);
  });

  it("returns the first invoice for a repeated clientRequestId", async () => {
    const { order } = await pricedShippedOrder();
    const input = { orderId: order.id, clientRequestId: "nonce-1" };
    const a = await asSystem(() => createInvoice(input));
    const b = await asSystem(() => createInvoice(input));
    expect(b.deduped).toBe(true);
    expect(b.invoice.id).toBe(a.invoice.id);
    expect(await prisma.invoice.count()).toBe(1);
  });

  it("answers a repeated clientRequestId with the invoice it made after that invoice was discarded (a recorded residual of #568, not a contract)", async () => {
    // The Invoicing list keeps an order's key until an answer lands (#568). If another session
    // discards the invoice that key made before the list's reload shows the order gone, the next
    // run sends the kept key again. Under the order claim no LIVE invoice matches, so the create
    // inserts, collides on the plain `@unique` clientRequestId a discarded row keeps, and the
    // backstop outside the transaction reads the invoice by that key alone, whatever its
    // deletedAt. HANDOFF §4's #568 entry records this; nothing is stored, and the list's next run
    // makes a fresh key and creates. Pinned so that record is checked against the code.
    const { order } = await pricedShippedOrder();
    const input = { orderId: order.id, clientRequestId: "nonce-568" };
    const { invoice } = await asSystem(() => createInvoice(input));
    await prisma.invoice.update({ where: { id: invoice.id }, data: { deletedAt: new Date() } });
    const again = await asSystem(() => createInvoice(input));
    expect(again.deduped).toBe(true);
    expect(again.invoice.id).toBe(invoice.id);
    expect(again.invoice.deletedAt).not.toBeNull();
    expect(await prisma.invoice.count()).toBe(1);
  });

  it("warns, never blocks, on a line with no price", async () => {
    const { order } = await shippedOrder();
    const { invoice, warnings } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.lines.some((l) => l.needsPrice)).toBe(true);
    expect(warnings.join(" ")).toMatch(/needs a price/i);
  });

  it("never bills a line whose net shipped total is zero", async () => {
    const customer = await makeCustomer();
    const partA = await makePart(customer.id);
    const partB = await makePart(customer.id);
    await giveSteps(partA.id);
    await giveSteps(partB.id);
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id,
      lines: [
        { partId: partA.id, qty: 100, weight: "100.00" },
        { partId: partB.id, qty: 100, weight: "100.00" },
      ],
    }));
    const gl = await prisma.glAccount.create({ data: { name: "4010", description: "Sales" } });
    const codeA = await prisma.processStepCode.create({ data: { code: "OPA", name: "OpA", glAccountId: gl.id } });
    const codeB = await prisma.processStepCode.create({ data: { code: "OPB", name: "OpB", glAccountId: gl.id } });
    // Line A: no minimum, so it bills its real $100 (100 × $1). Line B: a $600 minimum, so if a
    // zero-net line reached the engine it would bill the FULL $600 — making the total $700, not $100.
    await asSystem(() => addPartPrice(partA.id, {
      processStepCodeId: codeA.id, position: 1, unitPrice: "1.0000", pricePer: "EACH" }));
    await asSystem(() => addPartPrice(partB.id, {
      processStepCodeId: codeB.id, position: 1, unitPrice: "1.0000", minimumCharge: "600.00", pricePer: "EACH" }));
    // Line A ships in full and complete; line B ships zero but is also marked complete, so the
    // ORDER reaches SHIPPED while line B has a net shipped total of zero.
    await asSystem(() => createShipper({
      customerId: customer.id, shipDate: "2026-08-04",
      orders: [{
        orderId: order.id,
        lines: [
          { orderLineId: order.lines[0].id, qty: 100, weight: 100, lineComplete: true },
          { orderLineId: order.lines[1].id, qty: 0, weight: 0, lineComplete: true },
        ],
        containers: [], serials: [],
      }],
    }, { canOverrideCreditHold: false }));
    expect((await getOrder(order.id)).status).toBe("SHIPPED");

    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    // Line B contributed no lines at all, so the total is line A's $100 — never $100 + line B's $600.
    expect(invoice.lines.some((l) => l.orderLineId === order.lines[1].id)).toBe(false);
    expect(invoice.total).toBe(100);
  });

  it("bills freight, an extra charge, the cert charge and tax, each with its own GL account", async () => {
    const freightGl = await prisma.glAccount.create({ data: { name: "4300", description: "Freight" } });
    const otherGl = await prisma.glAccount.create({ data: { name: "4400", description: "Other charges" } });
    const taxGl = await prisma.glAccount.create({ data: { name: "2200", description: "Sales tax payable" } });
    const certCode = await prisma.processStepCode.create({
      data: { code: "CERT", name: "Certification", glAccountId: otherGl.id } });
    await asSystem(() => setBillingConfig({
      freightGlAccountId: freightGl.id, otherChargeGlAccountId: otherGl.id,
      salesTaxGlAccountId: taxGl.id, salesTaxRate: "0.040000",
      certChargeStepCodeId: certCode.id, certChargeDefault: "25.00", billForCertDefault: true,
    }));

    const { order, part, shipper } = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
    await prisma.part.update({ where: { id: part.id }, data: { billForCert: true } });
    await prisma.order.update({ where: { id: order.id }, data: { certRequired: true } });
    await prisma.shipper.update({
      where: { id: shipper.id }, data: { billFreight: true, freightAmount: "150.00" } });
    await asSystem(() => replaceCharges(order.id, [{ description: "Rush", amount: "10.00" }]));

    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    const byKind = new Map(invoice.lines.map((l) => [l.kind, l]));
    expect(byKind.get("FREIGHT")!.amount).toBe(150);
    expect(byKind.get("FREIGHT")!.glAccountName).toBe("4300");
    expect(byKind.get("CHARGE")!.amount).toBe(10);
    expect(byKind.get("CHARGE")!.glAccountName).toBe("4400");
    expect(byKind.get("CERT")!.amount).toBe(25);
    expect(byKind.get("CERT")!.glAccountName).toBe("4400");
    // 4% of (100 operations + 10 charge + 25 cert) — freight excluded (ruling 8).
    expect(byKind.get("TAX")!.amount).toBe(5.4);
    expect(byKind.get("TAX")!.glAccountName).toBe("2200");
    expect(invoice.total).toBe(290.4); // 100 + 10 + 25 + 150 + 5.40
  });

  it("prints no tax line for a customer who is not taxable", async () => {
    const taxGl = await prisma.glAccount.create({ data: { name: "2200", description: "Sales tax payable" } });
    await asSystem(() => setBillingConfig({ salesTaxGlAccountId: taxGl.id, salesTaxRate: "0.040000" }));
    const { order, customer } = await pricedShippedOrder();
    await prisma.customer.update({ where: { id: customer.id }, data: { taxable: false } });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.lines.some((l) => l.kind === "TAX")).toBe(false);
    expect(invoice.taxTotal).toBe(0);
  });

  it("prefers the customer's own tax rate over the plant rate", async () => {
    await asSystem(() => setBillingConfig({ salesTaxRate: "0.040000" }));
    const { order, customer } = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
    await prisma.customer.update({ where: { id: customer.id }, data: { salesTaxRate: "0.100000" } });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.taxTotal).toBe(10);
    expect(invoice.taxRate).toBe(0.1); // snapshotted on the header
  });

  it("suppresses the certification charge for a customer flagged for it", async () => {
    const certCode = await prisma.processStepCode.create({ data: { code: "CERT", name: "Certification" } });
    await asSystem(() => setBillingConfig({
      certChargeStepCodeId: certCode.id, certChargeDefault: "25.00", billForCertDefault: true }));
    const { order, customer } = await pricedShippedOrder();
    await prisma.order.update({ where: { id: order.id }, data: { certRequired: true } });
    await prisma.customer.update({ where: { id: customer.id }, data: { certChargeSuppressed: true } });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.lines.some((l) => l.kind === "CERT")).toBe(false);
  });

  it("audits the create with the lines in the snapshot", async () => {
    const { order } = await pricedShippedOrder();
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    const entry = await prisma.auditLog.findFirst({ where: { entity: "invoice", entityId: invoice.id } });
    expect(entry!.action).toBe("create");
    expect(JSON.stringify(entry!.after)).toContain("937.44");
  });

  // Fix wave 1, Fix 1: the writer's Serializable isolation exists specifically to pair with
  // `assertRefExists` on every registered FK it assigns (CLAUDE.md's FK-writer pattern) — closing
  // the staleness window between `loadInvoiceDeps`' outside-tx reads and this transaction's own
  // commit. A GL account is the easiest FK to exercise: the priced fixture's operation line posts
  // to `glAccount`, and soft-deleting it out from under the create must refuse, not silently post
  // an OPERATION line to a dead account.
  it("refuses to create an invoice whose GL account was soft-deleted before creation (assertRefExists)", async () => {
    const { order, glAccount } = await pricedShippedOrder();
    await prisma.glAccount.update({ where: { id: glAccount!.id }, data: { deletedAt: new Date() } });
    await expect(asSystem(() => createInvoice({ orderId: order.id })))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/that gl account does not exist/i) });
    expect(await prisma.invoice.count()).toBe(0);
  });

  // Fix wave 1, Fix 2: a CHARGE line carries a blank `partNumber`, so the old
  // `${partNumber} — ${description} needs a price` template rendered a dangling "·  — Rush" with
  // nothing before the dash. The fix uses the line's own label (its description) in that slot.
  it("formats a CHARGE needsPrice warning off its own label, not a blank part number", async () => {
    const { order } = await pricedShippedOrder();
    await asSystem(() => replaceCharges(order.id, [{ description: "Rush" }])); // no amount -> needsPrice
    const { warnings } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(warnings).toContain("Line 3 · Rush — needs a price");
  });

  // Fix wave 1, Fix 4: `renderAddress` (default-address pick, name fallback, blank-line drop) had
  // no direct coverage. Exercised here through `createInvoice`'s billTo/shipTo, the only way it is
  // reachable — the function itself is a private helper.
  it("renders billTo/shipTo — default address pick, name fallback, and blank-line drop", async () => {
    const { order, customer } = await pricedShippedOrder();
    // BILL_TO: two rows: the alphabetically-first one is NOT the default, so picking it correctly
    // requires honoring `isDefault` rather than the `listAddresses` name ordering. The default
    // row's own name is blank (-> customer name fallback) and its zip is blank (-> blank-line drop
    // inside the city/state/zip line, no trailing gap).
    await prisma.customerAddress.create({
      data: { customerId: customer.id, kind: "BILL_TO", name: "AAA Not Default",
        street: "1 Alt St", city: "Alt City", state: "OH", zip: "44444" },
    });
    await prisma.customerAddress.create({
      data: { customerId: customer.id, kind: "BILL_TO", name: "",
        street: "100 Main St", city: "Springfield", state: "OH", zip: "", isDefault: true },
    });
    // SHIP_TO: one row with no street/city/state/zip at all -> only the name line prints.
    await prisma.customerAddress.create({
      data: { customerId: customer.id, kind: "SHIP_TO", name: "Dock 4", isDefault: true },
    });

    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.billTo).toBe(`${customer.name}\n100 Main St\nSpringfield, OH`);
    expect(invoice.shipTo).toBe("Dock 4");
  });

  // #671 (owner ruling R14, 2026-10-22): a named default BILL_TO row stacks above the customer's
  // name, frozen into the invoice at create; the ship-to keeps its own rule (the row's name alone).
  it("stacks a named default bill-to row above the customer's name; ship-to keeps the row's name alone (R14, #671)", async () => {
    const { order, customer } = await pricedShippedOrder();
    await prisma.customerAddress.create({
      data: { customerId: customer.id, kind: "BILL_TO", name: "Accounts Payable",
        street: "100 Main St", city: "Springfield", state: "OH", zip: "45501", isDefault: true },
    });
    await prisma.customerAddress.create({
      data: { customerId: customer.id, kind: "SHIP_TO", name: "Dock 4", street: "9 Dock Rd", isDefault: true },
    });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.billTo).toBe(`Accounts Payable\n${customer.name}\n100 Main St\nSpringfield, OH 45501`);
    expect(invoice.shipTo).toBe("Dock 4\n9 Dock Rd");
  });

  // The discriminating concurrency test, copied in shape from tests/certs.test.ts:110-177 —
  // including the reasoning for why the competing caller must be pinned to Read Committed.
  //
  // Every uniqueness case above is SEQUENTIAL, which proves the business-rule 400 but never
  // exercises `claimOrder`'s row lock — nothing above ever has two transactions open on the same
  // order at once. With BOTH callers Serializable and both doing the same clash-check SELECT then
  // INSERT, Postgres's own SSI would detect the write-skew on that predicate ALONE and the row
  // lock would never have to do anything. Taking Serializable off the competing caller (call the
  // internal path directly against a manually-opened Read Committed tx) removes SSI from the
  // picture, so `claimOrder`'s row lock is the only thing that can serialize the two. Verified by
  // hand: RED with the claim removed, GREEN with it restored (see the task report for transcripts).
  // #96. `buildPricingInput` skips a zero-net line BEFORE the quote/part fork (seam #3), while the
  // lead-line header read used to resolve `orderLines[0]`'s quote link unconditionally. So the
  // identical corrupt link threw on a zero-net LEAD line and was silently skipped on a zero-net
  // RIDER. The asymmetry was the finding; throwing is the safe direction on corrupt state, so both
  // throw, from the pricing loop's own zero-net branch (since #622 the header read is skipped for
  // a priced lead and for a non-blank processName, so that branch is where the lead's link is judged).
  it("throws on a corrupt quote link on a ZERO-NET rider, as it already did on the lead (#96)", async () => {
    const customer = await makeCustomer();
    const partA = await makePart(customer.id);
    const partB = await makePart(customer.id);
    await giveSteps(partA.id);
    await giveSteps(partB.id);
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id,
      lines: [
        { partId: partA.id, qty: 100, weight: "100.00" },
        { partId: partB.id, qty: 100, weight: "100.00" },
      ],
    }));

    // A quote line that quotes partA, linked onto the partB order line — the part-mismatch
    // corruption §5.14 makes unreachable through the services, written here directly.
    const user = await prisma.user.create({
      data: { username: "q96-user", passwordHash: "x", displayName: "Q96" } });
    const quote = await prisma.quote.create({
      data: {
        quoteNumber: 960001, customerId: customer.id, quotedById: user.id,
        quoteDate: parseDateOnly("2026-08-01"), effectiveDate: parseDateOnly("2026-08-01"),
        expiryDate: parseDateOnly("2026-08-31"),
        lines: { create: [{ position: 1, partId: partA.id }] },
      },
      include: { lines: true },
    });
    await prisma.orderLine.update({
      where: { id: order.lines[1].id }, data: { quoteLineId: quote.lines[0].id } });

    // The rider ships ZERO but is marked complete, so the order reaches SHIPPED with a zero-net
    // line — the exact state the skip fires on.
    await asSystem(() => createShipper({
      customerId: customer.id, shipDate: "2026-08-04",
      orders: [{
        orderId: order.id,
        lines: [
          { orderLineId: order.lines[0].id, qty: 100, weight: 100, lineComplete: true },
          { orderLineId: order.lines[1].id, qty: 0, weight: 0, lineComplete: true },
        ],
        containers: [], serials: [],
      }],
    }, { canOverrideCreditHold: false }));
    expect((await getOrder(order.id)).status).toBe("SHIPPED");

    // Before the fix this created a perfectly ordinary invoice, silently ignoring the corruption.
    await expect(asSystem(() => createInvoice({ orderId: order.id })))
      .rejects.toThrow(/quotes a different part/i);
  });

  // #60. `listPartPrices` read through the top-level `prisma` singleton while being called from
  // INSIDE the Serializable invoice transaction, per order line and again for the lead line's
  // process names. A second-connection read sits outside that transaction's snapshot AND its
  // read-set, so a concurrent price edit was invisible to SSI — no 40001, no retry — and the several
  // per-line calls could tear across a mid-flight change. Pinning it the deterministic way: a row
  // written inside the caller's transaction is visible to the pricing read only if that read really
  // is on the caller's transaction. Before the fix this priced "Needs price" off a stale connection.
  it("prices from the CALLER's transaction, not a second connection (#60)", async () => {
    const fixture = await shippedOrder({ qty: 100 });
    const gl = await prisma.glAccount.create({ data: { name: "4010", description: "Sales" } });
    const code = await prisma.processStepCode.create({
      data: { code: "AUST-60", name: "Austemper", glAccountId: gl.id } });

    const invoice = await prisma.$transaction(async (tx) => {
      await tx.partPrice.create({
        data: {
          partId: fixture.part.id, processStepCodeId: code.id, position: 1,
          unitPrice: "2.0000", pricePer: "EACH",
        },
      });
      const created = await asSystem(() => createInvoice({ orderId: fixture.order.id }, tx));
      return created.invoice;
    });

    const op = invoice.lines.find((l) => l.kind === "OPERATION")!;
    expect(op.needsPrice).toBe(false);
    expect(op.amount).toBe(200); // 100 × $2.00, from the uncommitted row
    expect(op.glAccountName).toBe("4010");
    // The header names the operation from the pricing read's own rows on that transaction (#622),
    // so it sees the same uncommitted row.
    expect(invoice.processNames).toBe("Austemper");
  });

  it("blocks a concurrent create under Read Committed until the holder commits, then refuses (row-lock discipline)", async () => {
    const { order } = await pricedShippedOrder();

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    // Holder: default (Read Committed) isolation. Claims the Order row, commits a live INVOICE for
    // it while still holding the lock.
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
      hasClaimed();
      await release;
      await tx.invoice.create({
        data: { orderId: order.id, customerId: order.customerId, invoiceDate: new Date() },
      });
    }, { timeout: 20000 });

    await claimed;
    // Read Committed — createInvoice called against a manually-opened tx rather than through the
    // public no-`tx` API (which always forces Serializable).
    const createCall = asSystem(() =>
      prisma.$transaction((tx) => createInvoice({ orderId: order.id }, tx)));

    const TIMED_OUT = Symbol("timed out");
    const raceResult = await Promise.race([
      createCall.then(() => "settled" as const, () => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
    ]);
    expect(raceResult).toBe(TIMED_OUT);

    mayRelease();
    await holder;

    await expect(createCall).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/already has an invoice/i),
    });
    expect(await prisma.invoice.count({ where: { orderId: order.id, deletedAt: null } })).toBe(1);
  });
});

// -------------------------------------------------------------------------------------------
// Task 12: draft edits, recalculate, discard. These extend the create surface above, so they
// reuse `pricedShippedOrder` and add four invoicing-specific helpers.
// -------------------------------------------------------------------------------------------

/** A priced, shipped order with a DRAFT invoice already created against it. `priced: false` skips
 *  the price row, so every operation line lands `needsPrice` (finalize refuses it); `glAccount`
 *  passes through to the step code's GL account (`null` -> a step code with no GL account). */
async function draftFixture(opts: { qty?: number; priced?: boolean; glAccount?: string | null } = {}) {
  if (opts.priced === false) {
    const fixture = await shippedOrder({ qty: opts.qty ?? 144 });
    const { invoice } = await asSystem(() => createInvoice({ orderId: fixture.order.id }));
    return { ...fixture, stepCode: null, glAccount: null, invoice };
  }
  const fixture = await pricedShippedOrder({
    qty: opts.qty ?? 144, unitPrice: "6.5100", minimumCharge: "600.00",
    ...(opts.glAccount !== undefined ? { glAccount: opts.glAccount } : {}),
  });
  const { invoice } = await asSystem(() => createInvoice({ orderId: fixture.order.id }));
  return { ...fixture, invoice };
}

/** The same, then flipped to FINALIZED directly (Task 13 builds `finalizeInvoice`). */
async function finalizedFixture() {
  const fixture = await draftFixture();
  await prisma.invoice.update({
    where: { id: fixture.invoice.id }, data: { status: "FINALIZED", finalizedAt: new Date() },
  });
  return { ...fixture, invoice: await asSystem(() => getInvoice(fixture.invoice.id)) };
}

/** Applies a real PAYMENT against a finalized invoice and returns the created application's id, so a
 *  test can then void it. Receipt-batch / payment-type / payment scaffolding is the
 *  applications.test.ts shape. */
let paySeq = 0;
async function applyAPayment(customerId: string, invoiceId: string, amount: number): Promise<string> {
  paySeq += 1;
  const batch = await prisma.receiptBatch.create({
    data: { batchNumber: 710000 + paySeq, depositDate: parseDateOnly("2026-08-08") },
  });
  const paymentType = await prisma.paymentType.create({ data: { name: `PT-inv-${paySeq}` } });
  const payment = await prisma.payment.create({
    data: {
      batchId: batch.id, customerId, paymentTypeId: paymentType.id,
      amount, receivedDate: parseDateOnly("2026-08-08"),
    },
  });
  await asSystem(() => applyPayment({ paymentId: payment.id, lines: [{ invoiceId, type: "PAYMENT", amount }] }));
  const app = await prisma.application.findFirstOrThrow({ where: { invoiceId, deletedAt: null } });
  return app.id;
}

/** Ships `addQty` more of the order's single line — additive over the ledger (spec: over-ship
 *  warns, never blocks), so the recalculated invoice sees a higher shipped total. */
async function shipMore(order: OrderDetail, addQty: number): Promise<void> {
  await asSystem(() => createShipper({
    customerId: order.customerId, shipDate: "2026-08-05",
    orders: [{
      orderId: order.id,
      lines: [{ orderLineId: order.lines[0].id, qty: addQty, weight: addQty, lineComplete: false }],
      containers: [], serials: [],
    }],
  }, { canOverrideCreditHold: false }));
}

/** Maps a stored line back to a `replaceInvoiceLines` payload item. `key`/`parentKey` carry the
 *  grouping across the whole-array replace (positions are reassigned, ids are reminted). */
function toLineInput(l: InvoiceLineDetail) {
  return {
    key: l.id, parentKey: l.parentLineId, kind: l.kind,
    orderLineId: l.orderLineId, processStepCodeId: l.processStepCodeId,
    surchargeId: l.surchargeId, orderChargeId: l.orderChargeId, glAccountId: l.glAccountId,
    partNumber: l.partNumber, partName: l.partName, partDescription: l.partDescription,
    description: l.description, glAccountName: l.glAccountName,
    qty: l.qty, weight: l.weight, eachWeight: l.eachWeight,
    pricePer: l.pricePer, unitPrice: l.unitPrice,
    setupCharge: l.setupCharge, minimumCharge: l.minimumCharge,
    breakThreshold: l.breakThreshold, minimumApplied: l.minimumApplied,
    rate: l.rate, priceSource: l.priceSource, needsPrice: l.needsPrice, wordsChosen: l.wordsChosen,
    amount: l.amount,
  };
}

describe("updateInvoice", () => {
  it("refuses every draft edit on a finalized invoice, naming the state", async () => {
    const { invoice } = await finalizedFixture();
    await expect(asSystem(() => updateInvoice(invoice.id, { poNumber: "X" })))
      .rejects.toThrow(/finalized/i);
    await expect(asSystem(() => replaceInvoiceLines(invoice.id, [])))
      .rejects.toThrow(/finalized/i);
    await expect(asSystem(() => recalculateInvoice(invoice.id))).rejects.toThrow(/finalized/i);
    await expect(asSystem(() => discardInvoice(invoice.id, "wrong one"))).rejects.toThrow(/finalized/i);
  });

  it("edits header fields on a draft and audits the before/after diff", async () => {
    const { invoice } = await draftFixture();
    const updated = await asSystem(() => updateInvoice(invoice.id, {
      poNumber: "PO-99", termsName: "Net 30", invoiceDate: "2026-08-10",
    }));
    expect(updated.poNumber).toBe("PO-99");
    expect(updated.termsName).toBe("Net 30");
    expect(updated.invoiceDate).toBe("2026-08-10");
    expect((await asSystem(() => getInvoice(invoice.id))).poNumber).toBe("PO-99");

    const entry = await prisma.auditLog.findFirst({
      where: { entity: "invoice", entityId: invoice.id, action: "update" } });
    expect((entry!.before as Record<string, unknown>).poNumber).toBe("");
    expect((entry!.after as Record<string, unknown>).poNumber).toBe("PO-99");
    // A header patch's pair is children-free (R5, #617): no lines on either side, while the
    // customer and order names still ride along so the diff never shows a cuid.
    for (const side of [entry!.before, entry!.after] as Record<string, unknown>[]) {
      expect(side).not.toHaveProperty("lines");
      expect(side.customer).toMatchObject({ code: expect.any(String) });
      expect(side.order).toMatchObject({ orderNumber: expect.any(Number) });
    }
  });
});

describe("replaceInvoiceLines", () => {
  it("recomputes the totals after a line edit", async () => {
    const { invoice } = await draftFixture();
    const edited = await asSystem(() => replaceInvoiceLines(invoice.id,
      invoice.lines.map((l) => (l.kind === "OPERATION" ? { ...toLineInput(l), amount: "100.00" } : toLineInput(l)))));
    expect(edited.subtotal).toBe(100);
    expect(edited.total).toBe(100);
  });

  it("refuses a replaced line that references a soft-deleted GL account (assertRefExists)", async () => {
    const { invoice, glAccount } = await draftFixture();
    await prisma.glAccount.update({ where: { id: glAccount!.id }, data: { deletedAt: new Date() } });
    await expect(asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map(toLineInput))))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/that gl account does not exist/i) });
  });

  // The one thing the payload's `key`/`parentKey` exist FOR, and nothing asserted it through this
  // entry point: every `parentLineId` assertion in this file is on createInvoice, recalculate or
  // createCredit instead. Found while fixing #281, which changed what the grid puts in `key`.
  //
  // It has to survive a replace specifically because the replace REMINTS every row id — an
  // id-based parent link could not possibly survive, so `lineIdentities` re-derives the
  // relation from the caller's own opaque tokens. Mutation-proof: drop the parents `lineIdentities`
  // resolves from `replaceInvoiceLines`' insert, or send `parentKey: null`, and the OPERATION line
  // comes back flat.
  it("re-wires the OPERATION -> PART self-relation from the caller's key/parentKey", async () => {
    const { invoice } = await draftFixture();
    const part = invoice.lines.find((l) => l.kind === "PART");
    const operation = invoice.lines.find((l) => l.kind === "OPERATION");
    expect(part, "fixture must carry a PART line").toBeDefined();
    expect(operation?.parentLineId, "fixture's OPERATION must already hang off the PART")
      .toBe(part!.id);

    const replaced = await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map(toLineInput)));
    const newPart = replaced.lines.find((l) => l.kind === "PART")!;
    const newOperation = replaced.lines.find((l) => l.kind === "OPERATION")!;

    // Ids really were reminted — otherwise the parent link could have survived by accident and
    // this would prove nothing about the wiring.
    expect(newPart.id).not.toBe(part!.id);
    expect(newOperation.parentLineId).toBe(newPart.id);
  });
});

describe("recalculateInvoice", () => {
  it("recalculates from the order and preserves manual lines", async () => {
    const { order, invoice } = await draftFixture({ qty: 144 });
    await asSystem(() => replaceInvoiceLines(invoice.id, [
      ...invoice.lines.map(toLineInput),
      { kind: "CHARGE", description: "Hand-typed", amount: "25.00", priceSource: "MANUAL" },
    ]));
    await shipMore(order, 6); // ship 6 more of the line -> 150 net
    const after = await asSystem(() => recalculateInvoice(invoice.id));
    expect(after.lines.find((l) => l.kind === "PART")!.qty).toBe(150);
    expect(after.lines.some((l) => l.description === "Hand-typed")).toBe(true);
    // Manual line rides at the end, after the regenerated derived lines.
    expect(after.lines[after.lines.length - 1].description).toBe("Hand-typed");
  });

  it("produces the same derived lines as a fresh create for the same order (no drift)", async () => {
    const { order, invoice } = await draftFixture({ qty: 144 });
    await asSystem(() => replaceInvoiceLines(invoice.id, [
      ...invoice.lines.map(toLineInput),
      { kind: "CHARGE", description: "Manual note", amount: "25.00", priceSource: "MANUAL" },
    ]));
    await shipMore(order, 6);
    const recalced = await asSystem(() => recalculateInvoice(invoice.id));

    // Baseline: discard and re-create, i.e. exactly what a fresh createInvoice yields for this
    // order in its current state. Recalculate's derived lines must equal it, or the two pricing
    // paths have drifted.
    await asSystem(() => discardInvoice(invoice.id, "rebaseline for comparison"));
    const { invoice: fresh } = await asSystem(() => createInvoice({ orderId: order.id }));

    const derived = (inv: InvoiceDetail) =>
      inv.lines.filter((l) => l.priceSource !== "MANUAL")
        .map((l) => ({ kind: l.kind, qty: l.qty, amount: l.amount, description: l.description, gl: l.glAccountName }));
    expect(derived(recalced)).toEqual(derived(fresh));
    expect(recalced.subtotal).toBe(fresh.subtotal);
  });

  // Whole-branch review Fix 1 (CRITICAL, money-inverting): a credit's lines are copied from its
  // finalized source with the sign FLIPPED (§5.6) — there is no order pricing that should ever
  // replace them. Without the guard, recalculate re-derives from the order at ordinary POSITIVE
  // prices via the same shared `buildPricingInput`/`priceOrder`/mapper path an invoice uses, and
  // silently overwrites the credit's negated lines/total with a positive re-price — a "Credit"
  // that finalizes and prints as money owed TO the shop rather than a reduction.
  it("names the invoice a credit was raised from (PR 6: the credit's title), and nothing for an invoice", async () => {
    const { invoice } = await finalizedFixture();
    const credit = await asSystem(() => createCredit(invoice.id));
    expect(credit.sourceInvoiceId).toBe(invoice.id);
    expect(credit.sourceInvoiceNumber).toBe(invoice.documentNumber);
    expect(invoice.sourceInvoiceNumber).toBeNull();
    expect((await asSystem(() => getInvoice(credit.id))).sourceInvoiceNumber).toBe(invoice.documentNumber);
  });

  it("refuses to recalculate a credit — its negated lines/total are unchanged", async () => {
    const { invoice } = await finalizedFixture(); // default op amount = 144 × 6.51 = 937.44
    const credit = await asSystem(() => createCredit(invoice.id));
    expect(credit.subtotal).toBe(-937.44);
    expect(credit.total).toBe(-937.44);

    await expect(asSystem(() => recalculateInvoice(credit.id)))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/credit cannot be recalculated/i) });

    const after = await asSystem(() => getInvoice(credit.id));
    expect(after.kind).toBe("CREDIT");
    expect(after.subtotal).toBe(-937.44);
    expect(after.total).toBe(-937.44);
    expect(after.lines).toEqual(credit.lines);
  });
});

// -------------------------------------------------------------------------------------------
// The manual-line seam — issues #61 / #62 / #64, one defect surface with three faces. Owner
// rulings 2026-08-17: the override WINS silently (no revert control — remove-and-recalculate is
// the undo, pinned below), and a manual charge's GL account is defaulted SERVER-SIDE (no operator
// picker). Every case here failed before the fix; each is RED-verified.
// -------------------------------------------------------------------------------------------

/** A manual override of a stored line, the shape `InvoiceDetail.tsx`'s `patchRow` produces: editing
 *  an amount stamps `priceSource=MANUAL` and clears `needsPrice` so recalculate keeps it. */
function overrideAmount(l: InvoiceLineDetail, amount: string) {
  return { ...toLineInput(l), amount, priceSource: "MANUAL" as const, needsPrice: false };
}

/** Words chosen for a stored line (#587): its description set and the line marked `wordsChosen`,
 *  everything else as stored, so a derived line stays derived. */
function chooseWords(l: InvoiceLineDetail, text: string) {
  return { ...toLineInput(l), description: text, wordsChosen: true };
}

describe("recalculateInvoice — the manual-line seam", () => {
  it("suppresses the regenerated twin of an overridden operation, in place (#61)", async () => {
    const { invoice } = await draftFixture({ qty: 144 }); // 144 × 6.51 = 937.44
    expect(invoice.lines.find((l) => l.kind === "OPERATION")!.amount).toBe(937.44);
    await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) =>
      (l.kind === "OPERATION" ? overrideAmount(l, "100.00") : toLineInput(l)))));

    const after = await asSystem(() => recalculateInvoice(invoice.id));
    // Before the fix this billed BOTH the regenerated $937.44 and the preserved $100.
    const ops = after.lines.filter((l) => l.kind === "OPERATION");
    expect(ops).toHaveLength(1);
    expect(ops[0].amount).toBe(100);
    expect(ops[0].priceSource).toBe("MANUAL");
    expect(after.subtotal).toBe(100);
    expect(after.total).toBe(100);
    // Substituted IN PLACE, not appended: it keeps its slot under the regenerated PART line rather
    // than becoming the standalone trailing line the issue describes.
    expect(ops[0].parentLineId).toBe(after.lines.find((l) => l.kind === "PART")!.id);
    // The whole set is exactly what a derived recalculate produces — the override occupies the
    // operation's own slot rather than adding a trailing line.
    expect(after.lines.map((l) => l.kind)).toEqual(["PART", "OPERATION"]);
    expect(after.lines.map((l) => l.position)).toEqual([1, 2]);
  });

  // Review round 1 — a step-EXACT identity was not enough. Both cases below double-billed exactly
  // as the original #61 did: the derived line regenerated under a step code the override does not
  // name, so the pairing missed and the override rode along beside it.
  it("suppresses the derived operation when the override PREDATES the part price (#61)", async () => {
    // The invoice is raised before the part is priced, so the engine emits the tier-3 "needs price"
    // OPERATION with NO step code at all. The operator types a price to get the paper out. THEN the
    // shop sets the part price up properly — and the regenerated line now carries a step code.
    const fixture = await shippedOrder({ qty: 144 });
    const { invoice } = await asSystem(() => createInvoice({ orderId: fixture.order.id }));
    const op = invoice.lines.find((l) => l.kind === "OPERATION")!;
    expect(op.needsPrice).toBe(true);
    expect(op.processStepCodeId).toBeNull(); // the tier-3 line this pairing has to cope with
    await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) =>
      (l.kind === "OPERATION" ? overrideAmount(l, "100.00") : toLineInput(l)))));

    const gl = await prisma.glAccount.create({ data: { name: "4010", description: "Sales" } });
    const code = await prisma.processStepCode.create({
      data: { code: "AUST-61a", name: "Austemper", glAccountId: gl.id } });
    await asSystem(() => addPartPrice(fixture.part.id, {
      processStepCodeId: code.id, position: 1, unitPrice: "6.5100", minimumCharge: "600.00",
      pricePer: "EACH",
    }));

    const after = await asSystem(() => recalculateInvoice(invoice.id));
    const ops = after.lines.filter((l) => l.kind === "OPERATION");
    expect(ops).toHaveLength(1); // not the typed $100 PLUS a regenerated $937.44
    expect(ops[0].amount).toBe(100);
    expect(after.total).toBe(100);
  });

  it("suppresses the derived operation when the part's STEP CODE is replaced under an override (#61)", async () => {
    const { invoice, part } = await draftFixture({ qty: 144 });
    await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) =>
      (l.kind === "OPERATION" ? overrideAmount(l, "100.00") : toLineInput(l)))));

    // The priced operation is retired and re-added under a different step code — an ordinary
    // process-vocabulary correction, which must not resurrect the line the operator overrode.
    await prisma.partPrice.updateMany({ where: { partId: part.id }, data: { deletedAt: new Date() } });
    const gl = await prisma.glAccount.create({ data: { name: "4011", description: "Sales" } });
    const code = await prisma.processStepCode.create({
      data: { code: "AUST-61b", name: "Austemper II", glAccountId: gl.id } });
    await asSystem(() => addPartPrice(part.id, {
      processStepCodeId: code.id, position: 1, unitPrice: "6.5100", minimumCharge: "600.00",
      pricePer: "EACH",
    }));

    const after = await asSystem(() => recalculateInvoice(invoice.id));
    const ops = after.lines.filter((l) => l.kind === "OPERATION");
    expect(ops).toHaveLength(1);
    expect(ops[0].amount).toBe(100);
    expect(after.total).toBe(100);
  });

  /** An order line priced under TWO operations, the first overridden to $40. Returns both, so a test
   *  can then disturb one and assert the other survives. */
  async function twoOperationsOneOverridden() {
    const gl = await prisma.glAccount.create({ data: { name: "4012", description: "Sales" } });
    const fixture = await shippedOrder({ qty: 100 });
    const codes = [];
    for (const [i, spec] of [["A", "Op A"], ["B", "Op B"]].entries()) {
      const code = await prisma.processStepCode.create({
        data: { code: `TWO-${spec[0]}`, name: spec[1], glAccountId: gl.id } });
      await asSystem(() => addPartPrice(fixture.part.id, {
        processStepCodeId: code.id, position: i + 1, unitPrice: "1.0000", pricePer: "EACH" }));
      codes.push(code);
    }
    const { invoice } = await asSystem(() => createInvoice({ orderId: fixture.order.id }));
    const ops = invoice.lines.filter((l) => l.kind === "OPERATION");
    expect(ops).toHaveLength(2);
    await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) =>
      (l.id === ops[0].id ? overrideAmount(l, "40.00") : toLineInput(l)))));
    return { ...fixture, invoice, codes, gl };
  }

  it("keeps a SECOND priced operation billed when only the first is overridden (#61's limit)", async () => {
    // Suppression is per-operation: overriding one of two priced operations must not drop the
    // other's revenue. NOTE this exercises the step-EXACT path — the fallback below is separate.
    const { invoice } = await twoOperationsOneOverridden();
    const after = await asSystem(() => recalculateInvoice(invoice.id));
    expect(after.lines.filter((l) => l.kind === "OPERATION")).toHaveLength(2);
    expect(after.subtotal).toBe(140); // the $40 override + the untouched $100 operation
  });

  // Review round 2: the order-line fallback must not become the mirror of the bug it fixed. With a
  // SIBLING operation on the same order line, re-homing the override onto it would erase that
  // sibling's revenue from customer paper — a double bill traded for an under-bill.
  it("never re-homes an override onto a PRE-EXISTING sibling operation (#61)", async () => {
    const { invoice, part, codes } = await twoOperationsOneOverridden();
    // The overridden operation stops being priced — its part-price row is retired. Operation B is
    // untouched and was ALREADY on the invoice as its own derived line.
    await prisma.partPrice.updateMany({
      where: { partId: part.id, processStepCodeId: codes[0].id }, data: { deletedAt: new Date() } });

    const after = await asSystem(() => recalculateInvoice(invoice.id));
    const ops = after.lines.filter((l) => l.kind === "OPERATION");
    // B keeps its own line at its own price; the stale override rides as an addition, visible to the
    // operator, rather than silently swallowing B.
    expect(ops.map((l) => l.amount).sort((a, b) => a - b)).toEqual([40, 100]);
    expect(after.subtotal).toBe(140);
    // ...and the $100 is genuinely B's REGENERATED line, not the override wearing B's amount — the
    // one alternative shape those two numbers alone cannot rule out.
    const hundred = ops.find((l) => l.amount === 100)!;
    expect(hundred.priceSource).toBe("PART_PRICE");
    expect(hundred.processStepCodeId).toBe(codes[1].id);
    expect(ops.find((l) => l.amount === 40)!.priceSource).toBe("MANUAL");
  });

  it("warns that a typed price with no step code stands in for the whole part (review round 3)", async () => {
    // The ruling's own limit, surfaced rather than guessed at: a tier-3 override covers every priced
    // operation on its order line, INCLUDING work priced afterwards, and the stored state cannot
    // tell that work apart from what the price was typed for. So it says so.
    const fixture = await shippedOrder({ qty: 144 });
    const { invoice } = await asSystem(() => createInvoice({ orderId: fixture.order.id }));
    await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) =>
      (l.kind === "OPERATION" ? overrideAmount(l, "100.00") : toLineInput(l)))));

    const warnings = await asSystem(async () => invoiceWarnings(await getInvoice(invoice.id)));
    expect(warnings.join(" ")).toMatch(/standing in for every priced operation/i);

    // A typed price that DOES name its step code is an ordinary override of that one operation, and
    // must not draw the warning.
    const { invoice: priced } = await draftFixture({ qty: 144 });
    await asSystem(() => replaceInvoiceLines(priced.id, priced.lines.map((l) =>
      (l.kind === "OPERATION" ? overrideAmount(l, "100.00") : toLineInput(l)))));
    const none = await asSystem(async () => invoiceWarnings(await getInvoice(priced.id)));
    expect(none.join(" ")).not.toMatch(/standing in for/i);
  });

  it("recomputes tax on a lines SAVE, not only on recalculate (#64)", async () => {
    // Review round 1: Save lines and Recalculate are independent buttons — nothing makes an operator
    // recalculate after typing a charge, and finalize freezes whatever is there. So the save seam
    // has to re-derive tax too, or a taxable charge goes out on paper under-taxed.
    const taxGl = await prisma.glAccount.create({ data: { name: "2200", description: "Sales tax payable" } });
    const otherGl = await prisma.glAccount.create({ data: { name: "4400", description: "Other charges" } });
    await asSystem(() => setBillingConfig({
      salesTaxGlAccountId: taxGl.id, salesTaxRate: "0.040000", otherChargeGlAccountId: otherGl.id }));
    const { order } = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.taxTotal).toBe(4);

    const saved = await asSystem(() => replaceInvoiceLines(invoice.id, [
      ...invoice.lines.map(toLineInput),
      { kind: "CHARGE" as const, description: "Expedite", amount: "50.00", priceSource: "MANUAL" as const },
    ]));
    expect(saved.taxTotal).toBe(6); // 4% of (100 + 50), without anyone pressing Recalculate
    expect(saved.total).toBe(156);
  });

  it("re-derives a partial CREDIT's tax proportionally on a lines save (#64 reaches credits)", async () => {
    // Review round 2 named this as an untested extension: `createCredit` copies both `taxRate` and
    // the negated lines, so editing a credit down to a partial amount now re-derives its tax instead
    // of keeping the full copied figure. That is what an operator wants, and the arithmetic is
    // sign-symmetric — but it was neither tested nor written down, so it is both now.
    const taxGl = await prisma.glAccount.create({ data: { name: "2200", description: "Sales tax payable" } });
    await asSystem(() => setBillingConfig({ salesTaxGlAccountId: taxGl.id, salesTaxRate: "0.040000" }));
    const { order } = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    await asSystem(() => finalizeInvoice(invoice.id));

    const credit = await asSystem(() => createCredit(invoice.id));
    expect(credit.taxTotal).toBe(-4); // the full invoice's tax, negated and copied

    // Credit only half the work.
    const halved = await asSystem(() => replaceInvoiceLines(credit.id, credit.lines.map((l) =>
      (l.kind === "OPERATION" ? overrideAmount(l, "-50.00") : toLineInput(l)))));
    expect(halved.subtotal).toBe(-50);
    expect(halved.taxTotal).toBe(-2); // 4% of -50, not the copied -4
    expect(halved.total).toBe(-52);
  });

  it("leaves a manually overridden TAX line alone on a lines SAVE too (#64)", async () => {
    const taxGl = await prisma.glAccount.create({ data: { name: "2200", description: "Sales tax payable" } });
    await asSystem(() => setBillingConfig({ salesTaxGlAccountId: taxGl.id, salesTaxRate: "0.040000" }));
    const { order } = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));

    const saved = await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) =>
      (l.kind === "TAX" ? overrideAmount(l, "9.99") : toLineInput(l)))));
    expect(saved.taxTotal).toBe(9.99);
  });

  it("restores the computed operation once the override row is removed (#61's undo path)", async () => {
    const { invoice } = await draftFixture({ qty: 144 });
    await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) =>
      (l.kind === "OPERATION" ? overrideAmount(l, "100.00") : toLineInput(l)))));
    const overridden = await asSystem(() => recalculateInvoice(invoice.id));
    expect(overridden.total).toBe(100);

    // The ruling took this instead of a per-line "revert to computed" control, so it is a contract:
    // drop the override row, save, recalculate, and the computed line comes back.
    await asSystem(() => replaceInvoiceLines(invoice.id,
      overridden.lines.filter((l) => l.kind !== "OPERATION").map(toLineInput)));
    const restored = await asSystem(() => recalculateInvoice(invoice.id));
    const ops = restored.lines.filter((l) => l.kind === "OPERATION");
    expect(ops).toHaveLength(1);
    expect(ops[0].amount).toBe(937.44);
    expect(ops[0].priceSource).toBe("PART_PRICE");
  });

  it("recomputes tax over a preserved manual charge (#64)", async () => {
    const taxGl = await prisma.glAccount.create({ data: { name: "2200", description: "Sales tax payable" } });
    const otherGl = await prisma.glAccount.create({ data: { name: "4400", description: "Other charges" } });
    await asSystem(() => setBillingConfig({
      salesTaxGlAccountId: taxGl.id, salesTaxRate: "0.040000", otherChargeGlAccountId: otherGl.id }));
    const { order } = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.taxTotal).toBe(4); // 4% of the $100 operation

    await asSystem(() => replaceInvoiceLines(invoice.id, [
      ...invoice.lines.map(toLineInput),
      { kind: "CHARGE" as const, description: "Expedite", amount: "50.00", priceSource: "MANUAL" as const },
    ]));
    const after = await asSystem(() => recalculateInvoice(invoice.id));
    // A CHARGE is in the tax base (pricing.ts §5), so tax is 4% of $150 — before the fix the engine
    // priced tax over the order-derived lines only, leaving the $50 charge untaxed at $4.
    expect(after.chargeTotal).toBe(50);
    expect(after.taxTotal).toBe(6);
    expect(after.total).toBe(156);
  });

  it("recomputes tax over an OVERRIDDEN operation, not the computed one (#61 + #64)", async () => {
    const taxGl = await prisma.glAccount.create({ data: { name: "2200", description: "Sales tax payable" } });
    await asSystem(() => setBillingConfig({ salesTaxGlAccountId: taxGl.id, salesTaxRate: "0.040000" }));
    const { order } = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.taxTotal).toBe(4);

    await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) =>
      (l.kind === "OPERATION" ? overrideAmount(l, "50.00") : toLineInput(l)))));
    const after = await asSystem(() => recalculateInvoice(invoice.id));
    expect(after.subtotal).toBe(50);
    expect(after.taxTotal).toBe(2); // 4% of the override, not of the $100 the engine recomputed
    expect(after.total).toBe(52);
  });

  it("leaves a MANUALLY overridden tax line alone (the override wins, uniformly)", async () => {
    const taxGl = await prisma.glAccount.create({ data: { name: "2200", description: "Sales tax payable" } });
    await asSystem(() => setBillingConfig({ salesTaxGlAccountId: taxGl.id, salesTaxRate: "0.040000" }));
    const { order } = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));

    await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) =>
      (l.kind === "TAX" ? overrideAmount(l, "9.99") : toLineInput(l)))));
    const after = await asSystem(() => recalculateInvoice(invoice.id));
    const tax = after.lines.filter((l) => l.kind === "TAX");
    expect(tax).toHaveLength(1); // never the derived line PLUS the override
    expect(tax[0].amount).toBe(9.99);
    expect(after.taxTotal).toBe(9.99);
  });

  it("defaults a manually added charge to the configured other-charge account (#62)", async () => {
    const otherGl = await prisma.glAccount.create({ data: { name: "4400", description: "Other charges" } });
    await asSystem(() => setBillingConfig({ otherChargeGlAccountId: otherGl.id }));
    const { invoice } = await draftFixture();

    const saved = await asSystem(() => replaceInvoiceLines(invoice.id, [
      ...invoice.lines.map(toLineInput),
      { kind: "CHARGE" as const, description: "Expedite", amount: "50.00", priceSource: "MANUAL" as const },
    ]));
    // The grid renders the GL cell read-only and sends it blank, so the SERVER has to assign it —
    // the same account `mapComputedLines` gives an engine-generated charge (seam #1).
    const charge = saved.lines.find((l) => l.description === "Expedite")!;
    expect(charge.glAccountId).toBe(otherGl.id);
    expect(charge.glAccountName).toBe("4400");

    const after = await asSystem(() => recalculateInvoice(invoice.id));
    expect(after.lines.find((l) => l.description === "Expedite")!.glAccountId).toBe(otherGl.id);
  });

  it("warns about ANY account-bearing line with no GL account, not only operations (#62)", async () => {
    // No other-charge account is configured, so the server default cannot fill one in. The line must
    // then be WARNED about rather than slipping silently into 5C's export (#89 is the same hole,
    // one step later, on the readiness side).
    const { invoice } = await draftFixture();
    await asSystem(() => replaceInvoiceLines(invoice.id, [
      ...invoice.lines.map(toLineInput),
      { kind: "CHARGE" as const, description: "Expedite", amount: "50.00", priceSource: "MANUAL" as const },
    ]));
    const warnings = await asSystem(async () => invoiceWarnings(await getInvoice(invoice.id)));
    expect(warnings.join(" ")).toMatch(/Expedite.*no GL account/i);
  });
});

// -------------------------------------------------------------------------------------------
// #586 (owner rulings 2026-10-20, the plan's Amendments): Save lines re-figures each COMPUTED
// surcharge line over the operation lines it saves, typed prices included, before it re-figures tax.
// The rate is the line's own; the scope and minimum are Admin's, read just before the save. A
// computed surcharge whose scope is now empty is removed, percent or flat; none is ever added; a
// flat amount's figure and a typed surcharge stay as they are; a credit's surcharge lines stay as
// copied. One `it` per invoice: `pricedShippedOrder` creates live-unique rows.
// -------------------------------------------------------------------------------------------

describe("replaceInvoiceLines — a computed surcharge follows the lines (#586)", () => {
  async function taxAtFourPercent(): Promise<void> {
    const taxGl = await prisma.glAccount.create({ data: { name: "2200", description: "Sales tax payable" } });
    await asSystem(() => setBillingConfig({ salesTaxGlAccountId: taxGl.id, salesTaxRate: "0.040000" }));
  }

  /** A whole Admin row for a 5% surcharge on every operation (`updateSurcharge` takes the whole row:
   *  a field left out resets to its default), with `over` changing what a case names. */
  const percentRow = (over: Record<string, unknown> = {}) => ({
    name: "Energy", kind: "PERCENT", rate: "0.050000", position: 1, scope: "ALL", ...over,
  });
  const flatRow = (over: Record<string, unknown> = {}) => ({
    name: "Handling", kind: "FLAT", amount: "25.00", position: 2, scope: "ALL", ...over,
  });
  const newSurcharge = async (row: Record<string, unknown>) => (await asSystem(() => createSurcharge(row))).id;

  /** One operation at $100 (100 × $1.00, no minimum), invoiced. Surcharges must exist first. */
  async function invoiceAt100() {
    const fixture = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
    const { invoice } = await asSystem(() => createInvoice({ orderId: fixture.order.id }));
    return { ...fixture, invoice };
  }

  const surcharges = (inv: InvoiceDetail) => inv.lines.filter((l) => l.kind === "SURCHARGE");
  const amounts = (inv: InvoiceDetail) => surcharges(inv).map((l) => l.amount);
  /** The invoice's lines with every OPERATION typed to `amount`, as the grid sends them. */
  const typedOperations = (inv: InvoiceDetail, amount: string) =>
    inv.lines.map((l) => (l.kind === "OPERATION" ? overrideAmount(l, amount) : toLineInput(l)));
  const save = (inv: InvoiceDetail, lines: unknown[]) => asSystem(() => replaceInvoiceLines(inv.id, lines));

  it("re-figures a percent surcharge over a typed operation price, then tax", async () => {
    await taxAtFourPercent();
    await newSurcharge(percentRow());
    const { invoice } = await invoiceAt100();
    expect(amounts(invoice)).toEqual([5]);
    expect(invoice.taxTotal).toBe(4.2);

    const saved = await save(invoice, typedOperations(invoice, "150.00"));
    expect(amounts(saved)).toEqual([7.5]); // 5% of the typed 150.00, not of the engine's 100.00
    // Still the computed line, at its own rate, so the next Save re-figures it again.
    expect(surcharges(saved).map((l) => [l.priceSource, l.rate])).toEqual([[null, 0.05]]);
    expect(saved.surchargeTotal).toBe(7.5);
    expect(saved.taxTotal).toBe(6.3); // 4% of 157.50: the surcharge is re-figured first, then tax
    expect(saved.total).toBe(163.8);
  });

  it("counts a typed Needs price line under All operations", async () => {
    await newSurcharge(percentRow({ rate: "0.040000" }));
    const { order } = await shippedOrder({ qty: 144 });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.lines.find((l) => l.kind === "OPERATION")!.processStepCodeId).toBeNull();
    expect(amounts(invoice)).toEqual([0]); // the tier-3 line counts, at zero

    const saved = await save(invoice, typedOperations(invoice, "175.00"));
    expect(amounts(saved)).toEqual([7]); // 4% of 175.00
  });

  it("counts a typed Needs price line under All except these", async () => {
    // The 1001 case: the Needs price line has no step code, so it is never listed (ruling 586-2).
    const unrelated = await prisma.processStepCode.create({ data: { code: "UNREL", name: "Unrelated" } });
    const id = await newSurcharge(percentRow({ rate: "0.040000", scope: "EXCLUDE" }));
    await asSystem(() => setSurchargeStepCodes(id, [unrelated.id]));
    const { order } = await shippedOrder({ qty: 144 });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(amounts(invoice)).toEqual([0]);

    const saved = await save(invoice, typedOperations(invoice, "175.00"));
    expect(amounts(saved)).toEqual([7]);
  });

  it("re-figures above the minimum when the typed price clears it", async () => {
    await newSurcharge(percentRow({ minimumAmount: "10.00" }));
    const { invoice } = await invoiceAt100();
    expect(amounts(invoice)).toEqual([10]); // 5.00 floored at 10.00

    const saved = await save(invoice, typedOperations(invoice, "300.00"));
    expect(amounts(saved)).toEqual([15]); // 5% of 300.00
  });

  // A pin on T1's head: the create already floors at 10.00. What it holds is that Save reads
  // Admin's minimum under a negative base: without it the rule floors 5% of -50.00 at zero.
  it("floors the re-figured surcharge at its minimum under a negative typed price", async () => {
    await newSurcharge(percentRow({ minimumAmount: "10.00" }));
    const { invoice } = await invoiceAt100();

    const saved = await save(invoice, typedOperations(invoice, "-50.00"));
    expect(amounts(saved)).toEqual([10]);
  });

  it("keeps the line at zero under a negative typed price with no minimum", async () => {
    await newSurcharge(percentRow());
    const { invoice } = await invoiceAt100();

    const saved = await save(invoice, typedOperations(invoice, "-50.00"));
    expect(amounts(saved)).toEqual([0]); // a line, at zero: never below it, never dropped
  });

  it("removes a computed surcharge, percent and flat, when nothing is left in its scope", async () => {
    await newSurcharge(percentRow());
    await newSurcharge(flatRow());
    const { invoice } = await invoiceAt100();
    expect(amounts(invoice)).toEqual([5, 25]);

    const saved = await save(invoice, invoice.lines.filter((l) => l.kind !== "OPERATION").map(toLineInput));
    expect(saved.lines.map((l) => l.kind)).toEqual(["PART"]);
    expect(saved.surchargeTotal).toBe(0);
  });

  // A pin on T1's head: Save lines writes the payload, and nothing ever added a line to it.
  it("never adds one", async () => {
    await newSurcharge(percentRow());
    const { invoice } = await invoiceAt100();

    const saved = await save(invoice, invoice.lines.filter((l) => l.kind !== "SURCHARGE").map(toLineInput));
    expect(saved.lines.map((l) => l.kind)).toEqual(["PART", "OPERATION"]);
    expect(saved.surchargeTotal).toBe(0);
  });

  // A pin on T1's head (which re-figures no surcharge): each half is held by its own mutation.
  it("leaves a typed surcharge amount and a flat amount's figure as they are", async () => {
    await taxAtFourPercent();
    const flatId = await newSurcharge(flatRow({ position: 1 }));
    const percentId = await newSurcharge(percentRow({ position: 2 }));
    const { invoice } = await invoiceAt100();
    // Admin's minimum now sits above the flat amount: the rule would floor it at 30.00.
    await asSystem(() => updateSurcharge(flatId, flatRow({ position: 1, minimumAmount: "30.00" })));

    const saved = await save(invoice, invoice.lines.map((l) => {
      if (l.kind === "OPERATION") return overrideAmount(l, "150.00");
      return l.surchargeId === percentId ? overrideAmount(l, "9.99") : toLineInput(l);
    }));
    const line = (surchargeId: string) => saved.lines.find((l) => l.surchargeId === surchargeId)!;
    expect(line(flatId).amount).toBe(25);
    expect(line(percentId).amount).toBe(9.99); // typed: never 7.50, 5% of 150.00
    expect(line(percentId).priceSource).toBe("MANUAL");
    expect(saved.taxTotal).toBe(7.4); // 4% of 184.99
    expect(saved.total).toBe(192.39);
  });

  it("reads the minimum from Admin at Save; the rate stays the line's own", async () => {
    const id = await newSurcharge(percentRow());
    const { invoice } = await invoiceAt100();
    expect(amounts(invoice)).toEqual([5]);
    await asSystem(() => updateSurcharge(id, percentRow({ rate: "0.100000", minimumAmount: "7.00" })));

    const saved = await save(invoice, invoice.lines.map(toLineInput));
    // 5% of 100.00 floored at Admin's 7.00; Admin's 10% would give 10.00.
    expect(surcharges(saved).map((l) => [l.amount, l.rate])).toEqual([[7, 0.05]]);
  });

  it("reads the scope from Admin at Save", async () => {
    const id = await newSurcharge(percentRow());
    const { invoice, stepCode } = await invoiceAt100();
    expect(amounts(invoice)).toEqual([5]);
    await asSystem(() => setSurchargeStepCodes(id, [stepCode.id]));
    await asSystem(() => updateSurcharge(id, percentRow({ scope: "EXCLUDE" })));

    const saved = await save(invoice, invoice.lines.map(toLineInput));
    expect(saved.lines.map((l) => l.kind)).toEqual(["PART", "OPERATION"]);
    expect(saved.surchargeTotal).toBe(0);
  });

  it("a rate sent on the line wins over Admin's", async () => {
    await newSurcharge(percentRow());
    const { invoice } = await invoiceAt100();

    const saved = await save(invoice, invoice.lines.map((l) =>
      (l.kind === "SURCHARGE" ? { ...toLineInput(l), rate: "0.200000" } : toLineInput(l))));
    expect(surcharges(saved).map((l) => [l.amount, l.rate])).toEqual([[20, 0.2]]);
  });

  // A pin on T1's head: the credit guard's mutation reds it (the rule would floor -2.50 at zero).
  it("leaves a credit's surcharge lines as copied, and re-figures its tax", async () => {
    await taxAtFourPercent();
    await newSurcharge(percentRow());
    const { invoice } = await invoiceAt100();
    await asSystem(() => finalizeInvoice(invoice.id));
    const credit = await asSystem(() => createCredit(invoice.id));
    expect(amounts(credit)).toEqual([-5]);
    expect(credit.taxTotal).toBe(-4.2);

    const halved = await save(credit, typedOperations(credit, "-50.00"));
    expect(amounts(halved)).toEqual([-5]); // as copied (ruling 586-5)
    expect(halved.taxTotal).toBe(-2.2); // 4% of (-50.00 + -5.00)
  });

  it("keeps the parent links when a removed surcharge line comes first", async () => {
    const id = await newSurcharge(percentRow());
    const { invoice } = await invoiceAt100();
    // The surcharge's scope now names only another step code, so the save removes its line.
    const other = await prisma.processStepCode.create({ data: { code: "OTHER", name: "Other" } });
    await asSystem(() => setSurchargeStepCodes(id, [other.id]));
    await asSystem(() => updateSurcharge(id, percentRow({ scope: "INCLUDE" })));
    const byKind = (kind: InvoiceLineDetail["kind"]) => invoice.lines.find((l) => l.kind === kind)!;

    const saved = await save(invoice, [byKind("SURCHARGE"), byKind("PART"), byKind("OPERATION")].map(toLineInput));
    expect(saved.lines.map((l) => l.kind)).toEqual(["PART", "OPERATION"]);
    const [part, operation] = saved.lines;
    expect(part.id).not.toBe(byKind("PART").id); // reminted, so the link below was re-wired
    expect(operation.parentLineId).toBe(part.id);
  });

  it("re-figures a switched-off surcharge until Recalculate removes it", async () => {
    const id = await newSurcharge(percentRow());
    const { invoice } = await invoiceAt100();
    await asSystem(() => updateSurcharge(id, percentRow({ active: false })));

    const saved = await save(invoice, typedOperations(invoice, "150.00"));
    expect(amounts(saved)).toEqual([7.5]); // ruling Q-B: still re-figured at Save

    const recalculated = await asSystem(() => recalculateInvoice(invoice.id));
    expect(recalculated.lines.some((l) => l.kind === "SURCHARGE")).toBe(false);
  });

  it("re-figures tax over the lines left once a computed surcharge is removed", async () => {
    await taxAtFourPercent();
    const id = await newSurcharge(percentRow());
    const { invoice, stepCode } = await invoiceAt100();
    expect(invoice.lines.map((l) => l.kind)).toEqual(["PART", "OPERATION", "SURCHARGE", "TAX"]);
    expect(invoice.taxTotal).toBe(4.2);
    await asSystem(() => setSurchargeStepCodes(id, [stepCode.id]));
    await asSystem(() => updateSurcharge(id, percentRow({ scope: "EXCLUDE" })));

    const saved = await save(invoice, invoice.lines.map(toLineInput));
    expect(saved.lines.map((l) => l.kind)).toEqual(["PART", "OPERATION", "TAX"]);
    expect(saved.taxTotal).toBe(4); // 4% of 100.00: the removed surcharge's 5.00 is not in its base
    expect(saved.total).toBe(104);
  });

  // The rule's kind is the line's (a rate means percent), never Admin's: both cases are held by the
  // mutation that reads the kind from Admin. The first is a pin on T1's head, which re-figured nothing.
  it("keeps a flat line's figure after Admin makes its surcharge a percent one", async () => {
    const id = await newSurcharge(flatRow());
    const { invoice } = await invoiceAt100();
    expect(surcharges(invoice).map((l) => [l.amount, l.rate])).toEqual([[25, null]]);
    await asSystem(() => updateSurcharge(id, {
      name: "Handling", kind: "PERCENT", rate: "0.100000", position: 2, scope: "ALL" }));

    const saved = await save(invoice, invoice.lines.map(toLineInput));
    expect(surcharges(saved).map((l) => [l.amount, l.rate])).toEqual([[25, null]]);
  });

  it("re-figures a percent line at its own rate after Admin makes its surcharge a flat one", async () => {
    const id = await newSurcharge(percentRow());
    const { invoice } = await invoiceAt100();
    await asSystem(() => updateSurcharge(id, {
      name: "Energy", kind: "FLAT", amount: "25.00", position: 1, scope: "ALL" }));

    const saved = await save(invoice, typedOperations(invoice, "150.00"));
    // 5% of the typed 150.00; as a flat line it would keep its 5.00.
    expect(surcharges(saved).map((l) => [l.amount, l.rate])).toEqual([[7.5, 0.05]]);
  });

  // Save lines reads no customer, so no mutation of its code brings the opt-out in: the Save half
  // pins that. The Recalculate half is held by `buildSurcharges`' opt-out.
  it("leaves a customer's opt-out to Recalculate", async () => {
    const id = await newSurcharge(percentRow());
    const { invoice, customer } = await invoiceAt100();
    await asSystem(() => setCustomerSurcharge(customer.id, id, { optOut: true }));

    const saved = await save(invoice, typedOperations(invoice, "150.00"));
    expect(amounts(saved)).toEqual([7.5]); // ruling 586-6: an opt-out waits for Recalculate

    const recalculated = await asSystem(() => recalculateInvoice(invoice.id));
    expect(recalculated.lines.some((l) => l.kind === "SURCHARGE")).toBe(false);
    expect(recalculated.total).toBe(150); // the typed operation alone
  });
});

// -------------------------------------------------------------------------------------------
// #586 at Recalculate (owner rulings 2026-10-20, the plan's Amendments): each surcharge the engine
// would bill is figured over the operation lines as they will print, an override in its slot and a
// typed operation riding at the end included, and appears only when one of them is in its scope. A
// typed surcharge takes that rebuilt line's slot, or rides at the end when there is none. Tax is
// figured after it, over the final set. One `it` per invoice: the fixtures create live-unique rows.
// -------------------------------------------------------------------------------------------

/** One order line priced under two operations, step codes A and B, each $1.00 × 100 with no minimum,
 *  on its own GL account; invoiced. Surcharges and tax must be set up first. */
async function twoPricedOperations() {
  const gl = await prisma.glAccount.create({ data: { name: "4020", description: "Sales" } });
  const fixture = await shippedOrder({ qty: 100 });
  const codes = [];
  for (const [i, letter] of ["A", "B"].entries()) {
    const code = await prisma.processStepCode.create({
      data: { code: `PAIR-${letter}`, name: `Op ${letter}`, glAccountId: gl.id } });
    await asSystem(() => addPartPrice(fixture.part.id, {
      processStepCodeId: code.id, position: i + 1, unitPrice: "1.0000", pricePer: "EACH" }));
    codes.push(code);
  }
  const { invoice } = await asSystem(() => createInvoice({ orderId: fixture.order.id }));
  return { ...fixture, invoice, codes, gl };
}

describe("recalculateInvoice — surcharges over the final set (#586)", () => {
  async function taxAtFourPercent(): Promise<void> {
    const taxGl = await prisma.glAccount.create({ data: { name: "2200", description: "Sales tax payable" } });
    await asSystem(() => setBillingConfig({ salesTaxGlAccountId: taxGl.id, salesTaxRate: "0.040000" }));
  }

  /** Whole Admin rows (`updateSurcharge` takes the whole row), with `over` changing what a case names. */
  const percentRow = (over: Record<string, unknown> = {}) => ({
    name: "Energy", kind: "PERCENT", rate: "0.050000", position: 1, scope: "ALL", ...over,
  });
  const flatRow = (over: Record<string, unknown> = {}) => ({
    name: "Handling", kind: "FLAT", amount: "25.00", position: 2, scope: "ALL", ...over,
  });
  const newSurcharge = async (row: Record<string, unknown>) => (await asSystem(() => createSurcharge(row))).id;
  const priceUnder = (partId: string, processStepCodeId: string) => asSystem(() => addPartPrice(partId, {
    processStepCodeId, position: 1, unitPrice: "1.0000", pricePer: "EACH" }));

  /** One operation at $100 (100 × $1.00, no minimum), invoiced. Surcharges must exist first. */
  async function invoiceAt100() {
    const fixture = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
    const { invoice } = await asSystem(() => createInvoice({ orderId: fixture.order.id }));
    return { ...fixture, invoice };
  }

  /** R3's and R4's invoice: a 5% surcharge on step code A only, raised before the part is priced,
   *  so its one operation is the Needs price line, which no list names: no surcharge line. */
  async function needsPriceUnderIncludeA() {
    const codeA = await prisma.processStepCode.create({ data: { code: "INCL-A", name: "Op A" } });
    const surchargeId = await newSurcharge(percentRow({ scope: "INCLUDE" }));
    await asSystem(() => setSurchargeStepCodes(surchargeId, [codeA.id]));
    const fixture = await shippedOrder({ qty: 100 });
    const { invoice } = await asSystem(() => createInvoice({ orderId: fixture.order.id }));
    expect(invoice.lines.some((l) => l.kind === "SURCHARGE")).toBe(false);
    return { ...fixture, invoice, codeA, surchargeId };
  }

  const kinds = (inv: InvoiceDetail) => inv.lines.map((l) => l.kind);
  const surcharges = (inv: InvoiceDetail) => inv.lines.filter((l) => l.kind === "SURCHARGE");
  const amounts = (inv: InvoiceDetail) => surcharges(inv).map((l) => l.amount);
  /** The invoice's lines with every OPERATION typed to `amount`, as the grid sends them. */
  const typedOperations = (inv: InvoiceDetail, amount: string) =>
    inv.lines.map((l) => (l.kind === "OPERATION" ? overrideAmount(l, amount) : toLineInput(l)));
  /** The invoice's lines with every SURCHARGE typed to `amount`. */
  const typedSurcharges = (inv: InvoiceDetail, amount: string) =>
    inv.lines.map((l) => (l.kind === "SURCHARGE" ? overrideAmount(l, amount) : toLineInput(l)));
  const save = (inv: InvoiceDetail, lines: unknown[]) => asSystem(() => replaceInvoiceLines(inv.id, lines));
  const recalculate = (inv: InvoiceDetail) => asSystem(() => recalculateInvoice(inv.id));

  /** Every column a recalculate and a fresh create must agree on, line by line, a line's parent
   *  named by its position. */
  const derived = (inv: InvoiceDetail) => inv.lines.map((l) => ({
    kind: l.kind, qty: l.qty, amount: l.amount, description: l.description, rate: l.rate,
    surchargeId: l.surchargeId, glAccountId: l.glAccountId, glAccountName: l.glAccountName,
    priceSource: l.priceSource, position: l.position,
    orderLineId: l.orderLineId, processStepCodeId: l.processStepCodeId, orderChargeId: l.orderChargeId,
    needsPrice: l.needsPrice,
    parent: inv.lines.find((p) => p.id === l.parentLineId)?.position ?? null,
  }));

  /** Ships 6 more (106 shipped) and recalculates, then discards the draft and raises the invoice
   *  afresh: what a create writes for the order as it now stands. */
  async function recalculatedAndFresh(order: OrderDetail, invoice: InvoiceDetail) {
    await shipMore(order, 6);
    const recalced = await recalculate(invoice);
    await asSystem(() => discardInvoice(invoice.id, "rebaseline for comparison"));
    const { invoice: fresh } = await asSystem(() => createInvoice({ orderId: order.id }));
    return { recalced, fresh };
  }

  /** `createInvoice`'s freight, cert charge and tax case above, with a 5% surcharge on every
   *  operation on its own GL account: the cert charge 25.00 on a cert-required order, freight 150.00
   *  billed on the shipment when `freight` is set, tax 4%. */
  async function freightAndCert(opts: { freight: boolean }) {
    const freightGl = await prisma.glAccount.create({ data: { name: "4300", description: "Freight" } });
    const otherGl = await prisma.glAccount.create({ data: { name: "4400", description: "Other charges" } });
    const taxGl = await prisma.glAccount.create({ data: { name: "2200", description: "Sales tax payable" } });
    const certCode = await prisma.processStepCode.create({
      data: { code: "CERT", name: "Certification", glAccountId: otherGl.id } });
    await asSystem(() => setBillingConfig({
      freightGlAccountId: freightGl.id, otherChargeGlAccountId: otherGl.id,
      salesTaxGlAccountId: taxGl.id, salesTaxRate: "0.040000",
      certChargeStepCodeId: certCode.id, certChargeDefault: "25.00", billForCertDefault: true,
    }));
    const surGl = await prisma.glAccount.create({ data: { name: "4500", description: "Energy surcharge" } });
    await newSurcharge(percentRow({ glAccountId: surGl.id }));
    const { order, part, shipper } = await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
    await prisma.part.update({ where: { id: part.id }, data: { billForCert: true } });
    await prisma.order.update({ where: { id: order.id }, data: { certRequired: true } });
    if (opts.freight) {
      await prisma.shipper.update({
        where: { id: shipper.id }, data: { billFreight: true, freightAmount: "150.00" } });
    }
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    return { order, invoice };
  }

  // A pin on T2's head (the engine's block, unchanged): what it holds is that the rebuilt block is
  // the engine's own, line for line, when there is no manual line.
  it("a recalculate with surcharges and no manual line writes what a fresh create writes", async () => {
    const taxGl = await prisma.glAccount.create({ data: { name: "2200", description: "Sales tax payable" } });
    const otherGl = await prisma.glAccount.create({ data: { name: "4400", description: "Other charges" } });
    await asSystem(() => setBillingConfig({
      salesTaxGlAccountId: taxGl.id, salesTaxRate: "0.040000", otherChargeGlAccountId: otherGl.id }));
    const surGl = await prisma.glAccount.create({ data: { name: "4500", description: "Energy surcharge" } });
    const percentId = await newSurcharge(percentRow({ glAccountId: surGl.id }));
    const flatId = await newSurcharge(flatRow({ scope: "INCLUDE", minimumAmount: "30.00" }));
    const { order, customer, stepCode } =
      await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
    await asSystem(() => setSurchargeStepCodes(flatId, [stepCode.id]));
    await asSystem(() => setCustomerSurcharge(customer.id, percentId, { rate: "0.030000" }));
    await asSystem(() => replaceCharges(order.id, [{ description: "Rush", amount: "10.00" }]));
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(amounts(invoice)).toEqual([3, 30]);

    const { recalced, fresh } = await recalculatedAndFresh(order, invoice);

    // Not vacuous: the recalculate moved the percent figure, and both surcharges are on it.
    expect(kinds(recalced)).toEqual(["PART", "OPERATION", "SURCHARGE", "SURCHARGE", "CHARGE", "TAX"]);
    expect(surcharges(recalced).map((l) => [l.amount, l.rate, l.glAccountName]))
      .toEqual([[3.18, 0.03, "4500"], [30, null, ""]]);
    expect(derived(recalced)).toEqual(derived(fresh));
    expect([recalced.surchargeTotal, recalced.taxTotal, recalced.total])
      .toEqual([fresh.surchargeTotal, fresh.taxTotal, fresh.total]);
  });

  // Pins on T2's head, as the case above. The block goes in above the first freight, charge, cert or
  // tax line, the list `priceOrder`'s push order is restated in; the case above has a charge first,
  // and these hold the freight and the cert entries of that list.
  it("a recalculate with freight writes what a fresh create writes, the surcharge above the freight", async () => {
    const { order, invoice } = await freightAndCert({ freight: true });

    const { recalced, fresh } = await recalculatedAndFresh(order, invoice);
    expect(kinds(recalced)).toEqual(["PART", "OPERATION", "SURCHARGE", "FREIGHT", "CERT", "TAX"]);
    expect(amounts(recalced)).toEqual([5.3]); // 5% of 106.00
    expect(derived(recalced)).toEqual(derived(fresh));
    expect([recalced.surchargeTotal, recalced.taxTotal, recalced.total])
      .toEqual([fresh.surchargeTotal, fresh.taxTotal, fresh.total]);
  });

  it("a recalculate with a cert charge and no freight or charge writes what a fresh create writes", async () => {
    const { order, invoice } = await freightAndCert({ freight: false });

    const { recalced, fresh } = await recalculatedAndFresh(order, invoice);
    expect(kinds(recalced)).toEqual(["PART", "OPERATION", "SURCHARGE", "CERT", "TAX"]);
    expect(amounts(recalced)).toEqual([5.3]);
    expect(derived(recalced)).toEqual(derived(fresh));
    expect([recalced.surchargeTotal, recalced.taxTotal, recalced.total])
      .toEqual([fresh.surchargeTotal, fresh.taxTotal, fresh.total]);
  });

  it("re-figures a percent surcharge over a typed operation, then tax", async () => {
    await taxAtFourPercent();
    const surGl = await prisma.glAccount.create({ data: { name: "4500", description: "Energy surcharge" } });
    await newSurcharge(percentRow({ glAccountId: surGl.id }));
    const { invoice } = await invoiceAt100();
    await save(invoice, typedOperations(invoice, "150.00"));

    const after = await recalculate(invoice);
    expect(kinds(after)).toEqual(["PART", "OPERATION", "SURCHARGE", "TAX"]);
    expect(surcharges(after).map((l) => ({
      amount: l.amount, glAccountId: l.glAccountId, glAccountName: l.glAccountName,
      rate: l.rate, priceSource: l.priceSource, description: l.description,
    }))).toEqual([{
      amount: 7.5, glAccountId: surGl.id, glAccountName: "4500",
      rate: 0.05, priceSource: null, description: "Energy",
    }]); // 5% of the typed 150.00, not of the engine's 100.00
    expect(after.taxTotal).toBe(6.3); // 4% of 157.50
    expect(after.total).toBe(163.8);
  });

  it("counts a typed Needs price line under All operations (the 1001 case)", async () => {
    await newSurcharge(percentRow({ rate: "0.040000" }));
    const { order } = await shippedOrder({ qty: 144 });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(amounts(invoice)).toEqual([0]);
    await save(invoice, typedOperations(invoice, "175.00"));

    const after = await recalculate(invoice);
    expect(amounts(after)).toEqual([7]); // 4% of the typed 175.00, as Save lines left it
  });

  it("brings in a flat surcharge the final set puts in scope", async () => {
    await taxAtFourPercent();
    const { invoice, part, codes } = await twoPricedOperations();
    const opB = invoice.lines.find((l) => l.processStepCodeId === codes[1].id)!;
    await save(invoice, invoice.lines.map((l) => (l.id === opB.id ? overrideAmount(l, "40.00") : toLineInput(l))));
    // B's price retired: the engine no longer prices B, so the typed B rides at the end (#61).
    await prisma.partPrice.updateMany({
      where: { partId: part.id, processStepCodeId: codes[1].id }, data: { deletedAt: new Date() } });
    const id = await newSurcharge(flatRow({ scope: "INCLUDE" }));
    await asSystem(() => setSurchargeStepCodes(id, [codes[1].id]));

    const after = await recalculate(invoice);
    // The surcharge keeps the engine's place, above the tax; the typed B it is billed over rides last.
    expect(kinds(after)).toEqual(["PART", "OPERATION", "SURCHARGE", "TAX", "OPERATION"]);
    expect(amounts(after)).toEqual([25]);
    expect(after.taxTotal).toBe(6.6); // 4% of (100.00 + 25.00 + 40.00)
    const last = after.lines[after.lines.length - 1];
    expect([last.processStepCodeId, last.amount, last.priceSource]).toEqual([codes[1].id, 40, "MANUAL"]);
  });

  it("leaves out the engine's surcharge the final set takes out of scope", async () => {
    const { invoice, part, codeA } = await needsPriceUnderIncludeA();
    await save(invoice, typedOperations(invoice, "100.00"));
    await priceUnder(part.id, codeA.id);

    const after = await recalculate(invoice);
    // The typed Needs price line takes A's slot and keeps its own empty step code: nothing in scope.
    expect(kinds(after)).toEqual(["PART", "OPERATION"]);
    expect(after.lines[1].processStepCodeId).toBeNull();
    expect(after.surchargeTotal).toBe(0);
    expect(after.total).toBe(100);
  });

  it("removes a stored computed surcharge whose scope is empty in the final set", async () => {
    const codeA = await prisma.processStepCode.create({ data: { code: "OUT-A", name: "Op A" } });
    const codeB = await prisma.processStepCode.create({ data: { code: "OUT-B", name: "Op B" } });
    const surchargeId = await newSurcharge(percentRow({ scope: "INCLUDE" }));
    await asSystem(() => setSurchargeStepCodes(surchargeId, [codeB.id]));
    const { order, part } = await shippedOrder({ qty: 100 });
    await priceUnder(part.id, codeB.id);
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    const saved = await save(invoice, typedOperations(invoice, "100.00"));
    expect(kinds(saved)).toEqual(["PART", "OPERATION", "SURCHARGE"]);
    expect(surcharges(saved).map((l) => [l.amount, l.priceSource])).toEqual([[5, null]]); // stored, computed
    // B's price retired, A priced, and the surcharge now names A alone: the typed B takes A's slot
    // keeping step code B, so nothing in the final set is in scope, though the engine's A is.
    await prisma.partPrice.updateMany({
      where: { partId: part.id, processStepCodeId: codeB.id }, data: { deletedAt: new Date() } });
    await priceUnder(part.id, codeA.id);
    await asSystem(() => setSurchargeStepCodes(surchargeId, [codeA.id]));

    const after = await recalculate(invoice);
    expect(kinds(after)).toEqual(["PART", "OPERATION"]);
    expect([after.lines[1].processStepCodeId, after.lines[1].amount]).toEqual([codeB.id, 100]);
    expect(after.total).toBe(100);
  });

  it("a typed surcharge whose surcharge the final set leaves out of scope rides at the end", async () => {
    await taxAtFourPercent();
    const { invoice, part, codeA, surchargeId } = await needsPriceUnderIncludeA();
    await save(invoice, [
      ...typedOperations(invoice, "100.00"),
      { kind: "SURCHARGE" as const, surchargeId, description: "Energy", priceSource: "MANUAL" as const, amount: "9.99" },
    ]);
    await priceUnder(part.id, codeA.id);

    const after = await recalculate(invoice);
    expect(kinds(after)).toEqual(["PART", "OPERATION", "TAX", "SURCHARGE"]);
    expect(surcharges(after).map((l) => [l.amount, l.priceSource])).toEqual([[9.99, "MANUAL"]]);
  });

  it("a typed surcharge takes the slot the final set brings in", async () => {
    await taxAtFourPercent();
    const gl = await prisma.glAccount.create({ data: { name: "4030", description: "Sales" } });
    const codeA = await prisma.processStepCode.create({ data: { code: "SLOT-A", name: "Op A", glAccountId: gl.id } });
    const codeB = await prisma.processStepCode.create({ data: { code: "SLOT-B", name: "Op B", glAccountId: gl.id } });
    const surchargeId = await newSurcharge(percentRow({ scope: "INCLUDE" }));
    await asSystem(() => setSurchargeStepCodes(surchargeId, [codeA.id]));
    const { order, part } = await shippedOrder({ qty: 100 });
    await priceUnder(part.id, codeA.id);
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(amounts(invoice)).toEqual([5]);
    await save(invoice, invoice.lines.map((l) => {
      if (l.kind === "OPERATION") return overrideAmount(l, "80.00");
      return l.kind === "SURCHARGE" ? overrideAmount(l, "9.99") : toLineInput(l);
    }));
    // A's price retired and B priced: the typed A falls onto B's new slot, keeping step code A, so
    // the final set holds a line in the surcharge's scope that the engine's own lines do not.
    await prisma.partPrice.updateMany({
      where: { partId: part.id, processStepCodeId: codeA.id }, data: { deletedAt: new Date() } });
    await priceUnder(part.id, codeB.id);

    const after = await recalculate(invoice);
    expect(kinds(after)).toEqual(["PART", "OPERATION", "SURCHARGE", "TAX"]);
    const operation = after.lines[1];
    expect([operation.processStepCodeId, operation.amount]).toEqual([codeA.id, 80]);
    expect(surcharges(after).map((l) => [l.amount, l.priceSource])).toEqual([[9.99, "MANUAL"]]);
  });

  // A pin on T2's head (the typed line pairs with the engine's own, as it did). Held by the mutation
  // that pairs a typed surcharge against the engine's keys, which the final set no longer emits.
  it("a typed surcharge keeps its slot when nothing changed", async () => {
    await newSurcharge(percentRow());
    const { invoice } = await invoiceAt100();
    await save(invoice, typedSurcharges(invoice, "9.99"));

    const after = await recalculate(invoice);
    expect(kinds(after)).toEqual(["PART", "OPERATION", "SURCHARGE"]);
    expect(surcharges(after).map((l) => [l.amount, l.priceSource])).toEqual([[9.99, "MANUAL"]]);
  });

  // A pin on T2's head (its one pass kept the first claimant too). The first claimant takes the
  // block's slot; the second, finding it claimed, rides at the end. Held by the guard that keeps a
  // claimed slot (`isClaimed`) in the surcharge pairing loop.
  it("keeps a second typed surcharge of one surcharge, the first taking the slot", async () => {
    const id = await newSurcharge(percentRow());
    const { invoice } = await invoiceAt100();
    await save(invoice, [
      ...typedSurcharges(invoice, "9.99"),
      { kind: "SURCHARGE" as const, surchargeId: id, description: "Energy", priceSource: "MANUAL" as const, amount: "1.11" },
    ]);

    const after = await recalculate(invoice);
    expect(kinds(after)).toEqual(["PART", "OPERATION", "SURCHARGE", "SURCHARGE"]);
    expect(surcharges(after).map((l) => [l.amount, l.priceSource])).toEqual([[9.99, "MANUAL"], [1.11, "MANUAL"]]);
    expect(after.total).toBe(111.1);
  });

  // A pin on T2's head (one pass over the manual lines). Held by the mutation that collects the
  // additions in two passes, every other kind first and the typed surcharges after; the next case
  // holds the other order.
  it("additions keep their previous order", async () => {
    await taxAtFourPercent();
    const id = await newSurcharge(percentRow());
    const { invoice } = await invoiceAt100();
    await save(invoice, [
      ...typedSurcharges(invoice, "9.99"),
      { kind: "CHARGE" as const, description: "Expedite", amount: "50.00", priceSource: "MANUAL" as const },
    ]);
    await asSystem(() => updateSurcharge(id, percentRow({ active: false })));

    const after = await recalculate(invoice);
    expect(kinds(after)).toEqual(["PART", "OPERATION", "TAX", "SURCHARGE", "CHARGE"]);
    expect(after.lines.slice(-2).map((l) => [l.kind, l.amount, l.priceSource]))
      .toEqual([["SURCHARGE", 9.99, "MANUAL"], ["CHARGE", 50, "MANUAL"]]);
  });

  // A pin on T2's head, as the case above. Held by the mutation that collects the additions in two
  // passes, the typed surcharges first.
  it("additions keep their previous order, a charge saved above a typed surcharge", async () => {
    await taxAtFourPercent();
    const id = await newSurcharge(percentRow());
    const { invoice } = await invoiceAt100();
    const sent = typedSurcharges(invoice, "9.99");
    const at = invoice.lines.findIndex((l) => l.kind === "SURCHARGE");
    const saved = await save(invoice, [
      ...sent.slice(0, at),
      { kind: "CHARGE" as const, description: "Expedite", amount: "50.00", priceSource: "MANUAL" as const },
      ...sent.slice(at),
    ]);
    expect(kinds(saved)).toEqual(["PART", "OPERATION", "CHARGE", "SURCHARGE", "TAX"]);
    await asSystem(() => updateSurcharge(id, percentRow({ active: false })));

    const after = await recalculate(invoice);
    expect(kinds(after)).toEqual(["PART", "OPERATION", "TAX", "CHARGE", "SURCHARGE"]);
    expect(after.lines.slice(-2).map((l) => [l.kind, l.amount, l.priceSource]))
      .toEqual([["CHARGE", 50, "MANUAL"], ["SURCHARGE", 9.99, "MANUAL"]]);
  });

  // Beyond the plan's R0-R7, added in T3: no case there held its Behaviour step 3's "each absorbed
  // one dropped" (the mutation that counts absorbed operations stayed green).
  it("leaves out of the base an operation a typed Needs price line stands in for", async () => {
    await newSurcharge(percentRow());
    const { order, part } = await shippedOrder({ qty: 100 });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    await save(invoice, typedOperations(invoice, "100.00"));
    const gl = await prisma.glAccount.create({ data: { name: "4040", description: "Sales" } });
    for (const [i, letter] of ["A", "B"].entries()) {
      const code = await prisma.processStepCode.create({
        data: { code: `COVER-${letter}`, name: `Op ${letter}`, glAccountId: gl.id } });
      await asSystem(() => addPartPrice(part.id, {
        processStepCodeId: code.id, position: i + 1, unitPrice: "1.0000", pricePer: "EACH" }));
    }

    const after = await recalculate(invoice);
    // The typed line takes A's slot and covers B (#61): B is not billed, so it is not in the base.
    expect(kinds(after)).toEqual(["PART", "OPERATION", "SURCHARGE"]);
    expect(amounts(after)).toEqual([5]); // 5% of the typed 100.00, never of 100.00 + B's 100.00
    expect(after.total).toBe(105);
  });
});

describe("discardInvoice", () => {
  it("discards a draft with a reason and frees the order to be invoiced again", async () => {
    const { order, invoice } = await draftFixture();
    await expect(asSystem(() => discardInvoice(invoice.id, "  "))).rejects.toThrow(/reason/i);
    await asSystem(() => discardInvoice(invoice.id, "keyed against the wrong order"));
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "invoice", entityId: invoice.id, action: "delete" } });
    expect(entry!.reason).toBe("keyed against the wrong order");
    const again = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(again.invoice.id).not.toBe(invoice.id);
  });

  it("refuses to discard a draft that has printed", async () => {
    const { invoice } = await draftFixture();
    await prisma.storedDocument.create({
      data: { kind: "INVOICE", invoiceId: invoice.id, fileData: new Uint8Array([1]) } });
    await expect(asSystem(() => discardInvoice(invoice.id, "mistake")))
      .rejects.toThrow(/has already printed/i);
  });

  // Task 9 (§5.3): the discard A/R guard is DEFENSE-IN-DEPTH and UNREACHABLE by construction. A
  // draft can never carry real A/R activity through the services — `applyPayment`/`applyCredit`
  // require FINALIZED invoices/credits, so no application row that references a DRAFT can be created
  // through the service layer. To prove the guard is WIRED we raw-insert an `Application` naming a
  // DRAFT credit's id: the FK only needs an `Invoice` row and `Application_source_check` does not
  // check finalized status, so the DB accepts it — and `discardInvoice` must then refuse.
  it("refuses to discard a draft that has an application against it (defense-in-depth — unreachable via the services)", async () => {
    const fx = await finalizedFixture(); // a live FINALIZED invoice for the application's non-null invoiceId FK
    const draftCredit = await prisma.invoice.create({
      data: {
        orderId: fx.order.id, customerId: fx.order.customerId, kind: "CREDIT", status: "DRAFT",
        creditNumber: 9200, invoiceDate: parseDateOnly("2026-08-08"),
      },
    });
    await prisma.application.create({
      data: {
        invoiceId: fx.invoice.id, creditInvoiceId: draftCredit.id, amount: "25.00", type: "CREDIT",
        appliedDate: parseDateOnly("2026-08-08"),
      },
    });

    await expect(asSystem(() => discardInvoice(draftCredit.id, "raised in error")))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/payments, credits or write-offs applied/i) });
    // Refused, not discarded.
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: draftCredit.id } })).deletedAt).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------
// Task 13: finalize, unlock, and the INVOICED/REOPENED status ownership. Finalize and unlock both
// route through the SAME order-claim-then-invoice-lock helper Task 12's `claimLiveInvoice` uses, so
// they serialize against every order/shipment mutator whose Task 10 guard reads the finalized-invoice
// state under its own order claim (§5.7).
// -------------------------------------------------------------------------------------------

describe("finalizeInvoice", () => {
  it("refuses to finalize while a line needs a price", async () => {
    const { invoice } = await draftFixture({ priced: false });
    await expect(asSystem(() => finalizeInvoice(invoice.id))).rejects.toThrow(/needs a price/i);
  });

  // #63. The line editor lets an operator remove every row, and `replaceInvoiceLines` accepts an
  // empty array. Finalize's only block was `needsPrice`, which a `.find` over zero lines passes
  // VACUOUSLY — so an emptied invoice finalized into a $0 INVOICED order, which then drops out of
  // `listInvoiceCandidates` and can never be billed again. Owner ruling 2026-08-17: block the EMPTY
  // LINE SET, not a zero total (a warranty/rework invoice legitimately goes out at $0), and block at
  // FINALIZE so a draft may still be emptied mid-rebuild.
  it("refuses to finalize an invoice with no lines at all (#63)", async () => {
    const { order, invoice } = await draftFixture();
    await asSystem(() => replaceInvoiceLines(invoice.id, [])); // still allowed — the draft is mid-edit
    await expect(asSystem(() => finalizeInvoice(invoice.id)))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/no lines/i) });
    // Refused, not half-applied: the invoice is still an editable draft and the order has NOT been
    // stranded at INVOICED.
    expect((await getInvoice(invoice.id)).status).toBe("DRAFT");
    expect((await getOrder(order.id)).status).toBe("SHIPPED");
    // And the way out: since #594 the emptying Save remembers every computed line it no longer sent,
    // so Recalculate alone leaves them out. Restore each, then Recalculate rebuilds the derived lines,
    // and it bills.
    const emptied = await getInvoice(invoice.id);
    expect(emptied.removedLines.length).toBe(invoice.lines.length);
    expect((await asSystem(() => recalculateInvoice(invoice.id))).lines).toEqual([]);
    for (const m of emptied.removedLines) {
      await asSystem(() => restoreRemovedLine(invoice.id, { identity: m.identity }));
    }
    const rebuilt = await asSystem(() => recalculateInvoice(invoice.id));
    expect(rebuilt.lines.length).toBeGreaterThan(0);
    expect((await asSystem(() => finalizeInvoice(invoice.id))).status).toBe("FINALIZED");
  });

  it("finalizes a legitimately $0 invoice that still carries its lines (#63's other half)", async () => {
    // The ruling's point: zero DOLLARS is real paper — a no-charge rework still lists what was done.
    // Only zero LINES is the integrity hole.
    const { order, invoice } = await draftFixture();
    await asSystem(() => replaceInvoiceLines(invoice.id,
      invoice.lines.map((l) => (l.kind === "OPERATION" ? overrideAmount(l, "0.00") : toLineInput(l)))));
    const done = await asSystem(() => finalizeInvoice(invoice.id));
    expect(done.status).toBe("FINALIZED");
    expect(done.total).toBe(0);
    expect((await getOrder(order.id)).status).toBe("INVOICED");
  });

  // #79. `termsName` always snapshotted the label; the NUMBERS behind it are frozen here too, beside
  // `dueDate` and for the same reason — an invoice is frozen paper (§5.4). Without this write the
  // frozen columns would be null and every newly finalized invoice would silently offer no
  // early-pay discount at all, which is the opposite of the bug being fixed.
  it("freezes the issued early-pay terms at finalize, and gives a CREDIT none (#79)", async () => {
    const terms = await prisma.terms.create({
      data: { name: "2/10 Net 30", netDays: 30, discountPercent: "2.00", discountDays: 10 } });
    const { order, invoice } = await draftFixture();
    await prisma.customer.update({ where: { id: order.customerId }, data: { termsId: terms.id } });

    await asSystem(() => finalizeInvoice(invoice.id));
    const frozen = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(frozen.termsDiscountPercent?.toNumber()).toBe(2);
    expect(frozen.termsDiscountDays).toBe(10);

    // Moving the customer off those terms afterwards must not touch what the invoice froze.
    const plain = await prisma.terms.create({ data: { name: "Net 30", netDays: 30 } });
    await prisma.customer.update({ where: { id: order.customerId }, data: { termsId: plain.id } });
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.termsDiscountPercent?.toNumber()).toBe(2);
    expect(after.termsDiscountDays).toBe(10);

    // A CREDIT offers no early-pay discount, exactly as it gets no due date.
    const credit = await asSystem(() => createCredit(invoice.id));
    await asSystem(() => finalizeInvoice(credit.id));
    const frozenCredit = await prisma.invoice.findUniqueOrThrow({ where: { id: credit.id } });
    expect(frozenCredit.termsDiscountPercent).toBeNull();
    expect(frozenCredit.termsDiscountDays).toBeNull();
    expect(frozenCredit.dueDate).toBeNull();
  });

  // Review round 2 (#79). `termsName` is stamped at CREATE and is editable on a draft, while the
  // figures behind it — `dueDate` and now the discount pair — are stamped at FINALIZE from the
  // customer's live terms. So the finalized paper could say "2/10 Net 30" while the frozen pair was
  // null and payment application refused the advertised discount, or say "Net 30" while quietly
  // granting one. The label and the money have to describe the same terms.
  it("re-stamps the terms LABEL from the same terms as the figures at finalize (#79)", async () => {
    const rich = await prisma.terms.create({
      data: { name: "2/10 Net 30", netDays: 30, discountPercent: "2.00", discountDays: 10 } });
    const { order, invoice } = await draftFixture();
    await prisma.customer.update({ where: { id: order.customerId }, data: { termsId: rich.id } });
    // Re-create the draft so it picks the label up at create time, as a real one would.
    await asSystem(() => discardInvoice(invoice.id, "re-draft under the new terms"));
    const { invoice: drafted } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(drafted.termsName).toBe("2/10 Net 30");

    // The customer moves to plain Net 30 BEFORE the invoice is finalized.
    const plain = await prisma.terms.create({ data: { name: "Net 30", netDays: 30 } });
    await prisma.customer.update({ where: { id: order.customerId }, data: { termsId: plain.id } });

    const done = await asSystem(() => finalizeInvoice(drafted.id));
    const frozen = await prisma.invoice.findUniqueOrThrow({ where: { id: drafted.id } });
    // Before the fix: label "2/10 Net 30" over a null pair — paper promising a discount the save
    // would refuse.
    expect(done.termsName).toBe("Net 30");
    expect(frozen.termsDiscountPercent).toBeNull();
    expect(frozen.termsDiscountDays).toBeNull();
  });

  // REVERSED in review round 3, and the reversal is the point. Round 2 kept the label when the
  // customer had no terms, to protect operator-typed text. That exception then produced the EXACT
  // bug it was added to prevent: a draft created under `2/10 Net 30` whose customer's terms are
  // cleared before finalize kept the inherited label over a null pair — paper promising a discount
  // `applyPayment` refuses. Nothing distinguishes an INHERITED label from a TYPED one without new
  // state, so the label now always follows the terms, blank included. The paper never lying about
  // money outranks preserving free text; see the thread on MR !135 for the alternative if the shop
  // wants the typed label back.
  it("CLEARS a stale terms label when the customer's terms are removed before finalize (#79)", async () => {
    const rich = await prisma.terms.create({
      data: { name: "2/10 Net 30", netDays: 30, discountPercent: "2.00", discountDays: 10 } });
    const { order, invoice } = await draftFixture();
    await prisma.customer.update({ where: { id: order.customerId }, data: { termsId: rich.id } });
    await asSystem(() => discardInvoice(invoice.id, "re-draft under the new terms"));
    const { invoice: drafted } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(drafted.termsName).toBe("2/10 Net 30"); // inherited at create

    // The customer's terms are removed entirely before the invoice is finalized.
    await prisma.customer.update({ where: { id: order.customerId }, data: { termsId: null } });

    const done = await asSystem(() => finalizeInvoice(drafted.id));
    // Before this reversal: "2/10 Net 30" over a null pair.
    expect(done.termsName).toBe("");
    const frozen = await prisma.invoice.findUniqueOrThrow({ where: { id: drafted.id } });
    expect(frozen.termsDiscountPercent).toBeNull();
    expect(frozen.termsDiscountDays).toBeNull();
  });

  // Owner ruling 2026-10-06 (ruling 1). Quantity decides completion, so a draft's order can leave
  // SHIPPED after the draft was raised: `createInvoice` checked the status once, and finalize did
  // not check it again. Finalize now refuses unless the order is SHIPPED at that moment.
  async function expectUntouchedDraft(orderId: string, invoiceId: string, status: string) {
    expect((await getInvoice(invoiceId)).status).toBe("DRAFT");
    expect((await getInvoice(invoiceId)).finalizedAt).toBeNull();
    expect((await getOrder(orderId)).status).toBe(status);
    // Nothing was written on either history: no FINALIZED entry, no INVOICED entry.
    const invoiceEntries = await prisma.auditLog.findMany({ where: { entity: "invoice", entityId: invoiceId, action: "update" } });
    expect(invoiceEntries.filter((e) => (e.after as Record<string, unknown>).status === "FINALIZED")).toHaveLength(0);
    const orderEntries = await prisma.auditLog.findMany({ where: { entity: "order", entityId: orderId, action: "update" } });
    expect(orderEntries.filter((e) => (e.after as Record<string, unknown>).status === "INVOICED")).toHaveLength(0);
  }

  it("refuses to finalize once a line's quantity is raised past what shipped (ruling 1)", async () => {
    const { order, invoice } = await draftFixture();
    await asSystem(() => updateLine(order.id, order.lines[0].id, { qty: 150 }));
    expect((await getOrder(order.id)).status).toBe("PARTIAL_SHIPPED");
    await expect(asSystem(() => finalizeInvoice(invoice.id))).rejects.toMatchObject({
      status: 400,
      message: `Order #${order.orderNumber} is Partially shipped — ship the rest or close the line short, then finalize`,
    });
    await expectUntouchedDraft(order.id, invoice.id, "PARTIAL_SHIPPED");
    // The way out is the one the message names: correct the quantity back (or ship the rest).
    await asSystem(() => updateLine(order.id, order.lines[0].id, { qty: 144 }));
    expect((await asSystem(() => finalizeInvoice(invoice.id))).status).toBe("FINALIZED");
    expect((await getOrder(order.id)).status).toBe("INVOICED");
  });

  it("refuses to finalize once a rider line joins the order unshipped (ruling 1)", async () => {
    const { order, customer, invoice } = await draftFixture();
    const rider = await makePart(customer.id);
    await asSystem(() => addLine(order.id, { partId: rider.id, qty: 5, weight: "5.00" }));
    expect((await getOrder(order.id)).status).toBe("PARTIAL_SHIPPED");
    await expect(asSystem(() => finalizeInvoice(invoice.id))).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(new RegExp(`^Order #${order.orderNumber} is Partially shipped — `)),
    });
    await expectUntouchedDraft(order.id, invoice.id, "PARTIAL_SHIPPED");
  });

  it("names an order with no live shipment as Open (ruling 1)", async () => {
    const { order, shipper, invoice } = await draftFixture();
    await asSystem(() => voidShipper(shipper.id, "shipped in error"));
    expect((await getOrder(order.id)).status).toBe("OPEN");
    await expect(asSystem(() => finalizeInvoice(invoice.id))).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(new RegExp(`^Order #${order.orderNumber} is Open — `)),
    });
    await expectUntouchedDraft(order.id, invoice.id, "OPEN");
  });

  it("re-finalizes after an unlock while the order is still Shipped, and a CREDIT is not held to it (ruling 1)", async () => {
    const { order, invoice } = await draftFixture();
    await asSystem(() => finalizeInvoice(invoice.id));
    await asSystem(() => unlockInvoice(invoice.id, "wrong PO"));
    expect((await getOrder(order.id)).status).toBe("SHIPPED");
    expect((await asSystem(() => finalizeInvoice(invoice.id))).status).toBe("FINALIZED");
    // A credit memo is finalized while its order sits at INVOICED: the guard is INVOICE-only.
    const credit = await asSystem(() => createCredit(invoice.id));
    expect((await getOrder(order.id)).status).toBe("INVOICED");
    expect((await asSystem(() => finalizeInvoice(credit.id))).status).toBe("FINALIZED");
  });

  it("finalizes, stamps the finalizer, and sets the order INVOICED", async () => {
    const { order, invoice } = await draftFixture();
    const done = await asSystem(() => finalizeInvoice(invoice.id));
    expect(done.status).toBe("FINALIZED");
    expect(done.finalizedAt).not.toBeNull();
    expect((await getOrder(order.id)).status).toBe("INVOICED");
  });

  it("audits the finalize with the status before and after, on both the invoice and the order", async () => {
    const { order, invoice } = await draftFixture();
    await asSystem(() => finalizeInvoice(invoice.id));
    const inv = await prisma.auditLog.findFirst({
      where: { entity: "invoice", entityId: invoice.id, action: "update" }, orderBy: { at: "desc" } });
    expect((inv!.before as Record<string, unknown>).status).toBe("DRAFT");
    expect((inv!.after as Record<string, unknown>).status).toBe("FINALIZED");
    const ord = await prisma.auditLog.findFirst({
      where: { entity: "order", entityId: order.id, action: "update" }, orderBy: { at: "desc" } });
    expect((ord!.before as Record<string, unknown>).status).toBe("SHIPPED");
    expect((ord!.after as Record<string, unknown>).status).toBe("INVOICED");
  });

  it("finalizing twice is a 400, never a second write", async () => {
    const { invoice } = await draftFixture();
    const first = await asSystem(() => finalizeInvoice(invoice.id));
    await expect(asSystem(() => finalizeInvoice(invoice.id))).rejects.toThrow(/already finalized/i);
    // Never a second write: the finalize stamp is unchanged and there is exactly one FINALIZED entry.
    expect((await asSystem(() => getInvoice(invoice.id))).finalizedAt).toBe(first.finalizedAt);
    const finalizes = (await prisma.auditLog.findMany({
      where: { entity: "invoice", entityId: invoice.id, action: "update" } }))
      .filter((e) => (e.after as Record<string, unknown>).status === "FINALIZED");
    expect(finalizes).toHaveLength(1);
  });

  it("finalizes with a step code that has no GL account (5C's export refuses, not this)", async () => {
    const { invoice } = await draftFixture({ glAccount: null });
    await expect(asSystem(() => finalizeInvoice(invoice.id))).resolves.toBeTruthy();
  });

  it("freezes the current lines — finalize re-prices nothing", async () => {
    const { invoice } = await draftFixture();
    // Hand-edit the operation line down to $1, then finalize: a finalize that re-ran pricing would
    // restore the $937.44 the part price computes. It must NOT — finalize locks what is there.
    const edited = await asSystem(() => replaceInvoiceLines(invoice.id,
      invoice.lines.map((l) => (l.kind === "OPERATION" ? { ...toLineInput(l), amount: "1.00" } : toLineInput(l)))));
    expect(edited.total).toBe(1);
    const done = await asSystem(() => finalizeInvoice(invoice.id));
    expect(done.total).toBe(1);
    expect(done.lines.find((l) => l.kind === "OPERATION")!.amount).toBe(1);
  });

  // Note #1 (folded in from Task 10): finalize must `claimOrder` before it reads or writes invoice
  // state. Discriminating shape copied from `createInvoice`'s own concurrency test: the competing
  // caller runs at Read Committed (via a manually-opened tx) so ONLY `claimOrder`'s row lock — not
  // SSI — can order the two. The holder claims the order row and, while holding it, voids the order,
  // then commits. WITH the claim, finalize blocks on the order row, then reads the freshly-voided
  // state and refuses. WITHOUT it (RED), finalize reads the order through an unlocked snapshot (still
  // live), sails past the guard, and finalizes a voided order — resolving instead of rejecting.
  it("reads the order under the claim: a void by an order-lock holder makes finalize refuse (row-lock discipline)", async () => {
    const { order, invoice } = await draftFixture();

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
      await tx.order.update({ where: { id: order.id }, data: { deletedAt: new Date() } });
      hasClaimed();
      await release;
    }, { timeout: 20000 });

    await claimed;
    const finalizeCall = asSystem(() =>
      prisma.$transaction((tx) => finalizeInvoice(invoice.id, tx)));

    const TIMED_OUT = Symbol("timed out");
    const raceResult = await Promise.race([
      finalizeCall.then(() => "settled" as const, () => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
    ]);
    expect(raceResult).toBe(TIMED_OUT); // blocked on the holder's order-row claim

    mayRelease();
    await holder;

    await expect(finalizeCall).rejects.toThrow(/voided/i);
  });

  // Task 3/§4.3: finalizing an INVOICE stamps `dueDate = invoiceDate + terms.netDays`. `netDays` is
  // `Int @default(30)` on `Terms` now — never null — so the null case is a customer with NO terms
  // assigned at all (`Customer.termsId` null), not a null `netDays`.
  it("sets dueDate = invoiceDate + terms.netDays for a customer on Net 30 terms", async () => {
    const { order, customer } = await pricedShippedOrder();
    const terms = await prisma.terms.create({ data: { name: "Net 30", netDays: 30 } });
    await prisma.customer.update({ where: { id: customer.id }, data: { termsId: terms.id } });
    const { invoice } = await asSystem(() =>
      createInvoice({ orderId: order.id, invoiceDate: "2026-08-01" }));
    const done = await asSystem(() => finalizeInvoice(invoice.id));
    expect(done.dueDate).toBe("2026-08-31");
  });

  it("leaves dueDate null when the customer has no terms assigned", async () => {
    const { order } = await pricedShippedOrder(); // makeCustomer never sets termsId
    const { invoice } = await asSystem(() =>
      createInvoice({ orderId: order.id, invoiceDate: "2026-08-01" }));
    const done = await asSystem(() => finalizeInvoice(invoice.id));
    expect(done.dueDate).toBeNull();
  });
});

// Owner ruling 2026-10-06: finalize refuses a draft whose shipments changed since it was calculated.
// Shipments stay editable under a draft; the invoice stores a fingerprint of the shipment-side
// inputs its lines were calculated from (create and Recalculate write it) and finalize compares.
describe("finalizeInvoice — the shipment fingerprint", () => {
  const STALE = (orderNumber: number) => ({
    status: 400,
    message: `The shipments for order #${orderNumber} have changed since this invoice was calculated — `
      + "Recalculate, review the lines, then finalize",
  });
  const finalize = (id: string) => asSystem(() => finalizeInvoice(id));
  const recalc = (id: string) => asSystem(() => recalculateInvoice(id));
  const fingerprintOf = async (id: string) =>
    (await prisma.invoice.findUniqueOrThrow({ where: { id } })).shipmentFingerprint;
  const partQty = (inv: InvoiceDetail) => inv.lines.find((l) => l.kind === "PART")!.qty;

  /** One line of 10 priced at $5 each, shipped 8 and closed short -> SHIPPED. */
  async function closedShortAtEight() {
    const { order, part } = await savedOrder({ qty: 10, weight: "25.00" });
    const gl = await prisma.glAccount.create({ data: { name: "4010", description: "Sales" } });
    const code = await prisma.processStepCode.create({ data: { code: "AUST", name: "Austemper", glAccountId: gl.id } });
    await asSystem(() => addPartPrice(part.id, { processStepCodeId: code.id, position: 1, unitPrice: "5.0000", pricePer: "EACH" }));
    const input = oneOrderInput(order);
    input.orders[0].lines[0].qty = 8;
    input.orders[0].lines[0].lineComplete = true;
    const { shipper } = await createShipper(input, { canOverrideCreditHold: false });
    return { order, shipper };
  }

  it("the reviewer's sequence: the shipment is edited under the draft, finalize refuses until Recalculate, then bills 10", async () => {
    const { order, shipper } = await closedShortAtEight();
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(partQty(invoice)).toBe(8);
    expect(await fingerprintOf(invoice.id)).toMatch(/^[0-9a-f]{64}$/);

    // Shipments are editable under a draft.
    await asSystem(() => replaceShipperLines(shipper.id, shipper.orders[0].id,
      [{ orderLineId: order.lines[0].id, qty: 10, weight: 25, lineComplete: false }]));
    expect((await getOrder(order.id)).status).toBe("SHIPPED");

    await expect(finalize(invoice.id)).rejects.toMatchObject(STALE(order.orderNumber));
    expect((await getInvoice(invoice.id)).status).toBe("DRAFT");
    expect((await getOrder(order.id)).status).toBe("SHIPPED");

    expect(partQty(await recalc(invoice.id))).toBe(10);
    const done = await finalize(invoice.id);
    expect(done.status).toBe("FINALIZED");
    expect(partQty(done)).toBe(10);
    expect(done.total).toBe(50);
  });

  it("a new shipment after the draft, and a void, each refuse until Recalculate", async () => {
    const { order, invoice } = await draftFixture({ qty: 144 });
    await shipMore(order, 6); // 150 of 144: still SHIPPED
    await expect(finalize(invoice.id)).rejects.toMatchObject(STALE(order.orderNumber));
    expect(partQty(await recalc(invoice.id))).toBe(150);

    const extra = await prisma.shipper.findFirstOrThrow({ orderBy: { shipperNumber: "desc" } });
    await asSystem(() => voidShipper(extra.id, "shipped twice"));
    expect((await getOrder(order.id)).status).toBe("SHIPPED");
    await expect(finalize(invoice.id)).rejects.toMatchObject(STALE(order.orderNumber));
    expect(partQty(await recalc(invoice.id))).toBe(144);
    expect((await finalize(invoice.id)).status).toBe("FINALIZED");
  });

  it("does not refuse over a shipment edit that changes nothing the invoice reads", async () => {
    const { order, shipper, invoice } = await draftFixture({ qty: 144 });
    const before = await fingerprintOf(invoice.id);
    await asSystem(() => updateShipper(shipper.id, { comments: "carrier called ahead", route: "North" }));
    // Re-saving the same quantity and weight replaces the rows (new ids) and changes no total.
    await asSystem(() => replaceShipperLines(shipper.id, shipper.orders[0].id,
      [{ orderLineId: order.lines[0].id, qty: 144, weight: 3024, lineComplete: false }]));
    expect((await finalize(invoice.id)).status).toBe("FINALIZED");
    expect(await fingerprintOf(invoice.id)).toBe(before);
  });

  it("refuses over a freight amount change on a bill-freight shipment", async () => {
    const { order, shipper } = await pricedShippedOrder({ qty: 144 });
    await asSystem(() => updateShipper(shipper.id, { billFreight: true, freightAmount: "100.00" }));
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.freightTotal).toBe(100);
    await asSystem(() => updateShipper(shipper.id, { freightAmount: "125.00" }));
    await expect(finalize(invoice.id)).rejects.toMatchObject(STALE(order.orderNumber));
    expect((await recalc(invoice.id)).freightTotal).toBe(125);
    expect((await finalize(invoice.id)).freightTotal).toBe(125);
  });

  // The `deletedAt` arm of `readShipmentInputs`' freight read, isolated: the voided shipment
  // carries this order at quantity 0 (the goods on it belong to a second order), so the void
  // changes NO shipped quantity or weight of this order and leaves it SHIPPED. Only the billed
  // freight leaves the fingerprint. Mutation-proven: with that arm removed the voided shipment's
  // freight stays in both the fingerprint and the price, and finalize bills freight for a
  // shipment that no longer exists.
  it("refuses when a freight-billing shipment is voided after the draft was calculated", async () => {
    const { order, part, customer } = await pricedShippedOrder({ qty: 144 });
    const { order: other } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: "", lines: [{ partId: part.id, qty: 5, weight: "10.00" }],
    }));
    const { shipper: second } = await createShipper({
      customerId: customer.id, shipDate: "2026-08-05",
      orders: [
        { orderId: order.id, containers: [], serials: [],
          lines: [{ orderLineId: order.lines[0].id, qty: 0, weight: 0, lineComplete: false }] },
        { orderId: other.id, containers: [], serials: [],
          lines: [{ orderLineId: other.lines[0].id, qty: 5, weight: 10, lineComplete: false }] },
      ],
    }, { canOverrideCreditHold: false });
    await asSystem(() => updateShipper(second.id, { billFreight: true, freightAmount: "40.00" }));
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.freightTotal).toBe(40);
    expect(partQty(invoice)).toBe(144);

    await asSystem(() => voidShipper(second.id, "booked on the wrong carrier"));
    expect((await getOrder(order.id)).status).toBe("SHIPPED");

    await expect(finalize(invoice.id)).rejects.toMatchObject(STALE(order.orderNumber));
    expect((await getInvoice(invoice.id)).status).toBe("DRAFT");
    const recalculated = await recalc(invoice.id);
    expect(recalculated.freightTotal).toBe(0);
    expect(partQty(recalculated)).toBe(144); // the void moved no quantity of this order
    expect((await finalize(invoice.id)).freightTotal).toBe(0);
  });

  it("a hand edit of the lines does not clear the refusal", async () => {
    const { order, invoice } = await draftFixture({ qty: 144 });
    const before = await fingerprintOf(invoice.id);
    await shipMore(order, 6);
    await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map(toLineInput)));
    await asSystem(() => updateInvoice(invoice.id, { poNumber: "PO-EDITED" }));
    expect(await fingerprintOf(invoice.id)).toBe(before); // neither write re-reads the shipments
    await expect(finalize(invoice.id)).rejects.toMatchObject(STALE(order.orderNumber));
  });

  // The order's status flips are header scalars, so each is a children-free pair (R5; R26, #711
  // step 5): the shipment's SHIPPED (recomputeOrderStatus), finalize's INVOICED and the
  // reversal's REOPENED.
  it("audits SHIPPED, INVOICED and REOPENED on the order as children-free pairs", async () => {
    const { order, shipper, invoice } = await draftFixture({ qty: 144 });
    await finalize(invoice.id);
    await asSystem(() => reverseShipper(shipper.id, { reason: "wrong parts loaded" }));

    const flips = (await readAudit("order", order.id))
      .filter((e) => e.action === "update")
      .map((e) => ({ before: e.before as Record<string, unknown>, after: e.after as Record<string, unknown> }))
      .filter((e) => e.before.status !== e.after.status);
    expect(flips.map((e) => e.after.status).sort()).toEqual(["INVOICED", "REOPENED", "SHIPPED"]);
    for (const flip of flips) {
      for (const side of [flip.before, flip.after]) {
        for (const child of ["lines", "containers", "serials", "loads", "charges"]) expect(side).not.toHaveProperty(child);
      }
    }
  });

  // The correction path a shipment freeze under a draft would have broken: reverse under the
  // finalized invoice, unlock, then put the shipments right UNDER the draft.
  it("after reverse and unlock, voiding the reversal restores what was calculated and finalizes as it stands", async () => {
    const { order, shipper, invoice } = await draftFixture({ qty: 144 });
    await finalize(invoice.id);
    const atFinalize = await fingerprintOf(invoice.id);
    const { shipper: reversal } = await asSystem(() => reverseShipper(shipper.id, { reason: "wrong parts loaded" }));
    expect((await getOrder(order.id)).status).toBe("REOPENED");
    await asSystem(() => unlockInvoice(invoice.id, "correcting the shipment"));
    expect(await fingerprintOf(invoice.id)).toBe(atFinalize); // unlock leaves the stored value alone
    expect((await getOrder(order.id)).status).toBe("PARTIAL_SHIPPED");

    await asSystem(() => voidShipper(reversal.id, "mistaken reversal"));
    expect((await getOrder(order.id)).status).toBe("SHIPPED");
    // The shipments are again exactly what the lines were calculated from: nothing is stale.
    const done = await finalize(invoice.id);
    expect(done.status).toBe("FINALIZED");
    expect(partQty(done)).toBe(144);
  });

  it("after reverse and unlock, re-shipping a different quantity refuses as stale until Recalculate", async () => {
    const { order, shipper, invoice } = await draftFixture({ qty: 144 });
    await finalize(invoice.id);
    await asSystem(() => reverseShipper(shipper.id, { reason: "wrong parts loaded" }));
    await asSystem(() => unlockInvoice(invoice.id, "correcting the shipment"));
    // Re-ship 140 and close the line short, under the draft.
    await asSystem(() => createShipper({
      customerId: order.customerId, shipDate: "2026-08-06",
      orders: [{
        orderId: order.id, containers: [], serials: [],
        lines: [{ orderLineId: order.lines[0].id, qty: 140, weight: 2940, lineComplete: true }],
      }],
    }, { canOverrideCreditHold: false }));
    expect((await getOrder(order.id)).status).toBe("SHIPPED");

    await expect(finalize(invoice.id)).rejects.toMatchObject(STALE(order.orderNumber));
    expect(partQty(await recalc(invoice.id))).toBe(140);
    expect(partQty(await finalize(invoice.id))).toBe(140);
    expect((await getOrder(order.id)).status).toBe("INVOICED");
  });

  it("refuses a draft with no fingerprint, then finalizes after Recalculate", async () => {
    const { order, invoice } = await draftFixture({ qty: 144 });
    await prisma.invoice.update({ where: { id: invoice.id }, data: { shipmentFingerprint: null } }); // predates the column
    await expect(finalize(invoice.id)).rejects.toMatchObject(STALE(order.orderNumber));
    await recalc(invoice.id);
    expect(await fingerprintOf(invoice.id)).not.toBeNull();
    expect((await finalize(invoice.id)).status).toBe("FINALIZED");
  });

  it("does not check a credit memo, which carries no fingerprint", async () => {
    const { invoice } = await draftFixture({ qty: 144 });
    await finalize(invoice.id);
    const credit = await asSystem(() => createCredit(invoice.id));
    expect(await fingerprintOf(credit.id)).toBeNull();
    expect((await finalize(credit.id)).status).toBe("FINALIZED");
  });
});

// #1055 (owner ruling 2026-11-25): a new invoice's Ship-to is the latest live, non-reversal
// shipment's own ship-to row, else the customer's default SHIP_TO row; set at create only. The
// leaf's ordering is pinned in tests/invoice-ship-to.test.ts; these cases prove the wiring.
describe("createInvoice — the shipment's ship-to (#1055)", () => {
  const finalize = (id: string) => asSystem(() => finalizeInvoice(id));
  const recalc = (id: string) => asSystem(() => recalculateInvoice(id));

  async function shipTo(customerId: string, name: string, street: string, isDefault = false) {
    return prisma.customerAddress.create({
      data: { customerId, kind: "SHIP_TO", name, street, city: "Tulsa", state: "OK", zip: "74101", isDefault },
    });
  }

  /** Ships `qty` of the order's single line on `shipDate`, to `shipToAddressId` when given. */
  async function ship(order: OrderDetail, qty: number, shipDate: string, shipToAddressId?: string) {
    const { shipper } = await asSystem(() => createShipper({
      customerId: order.customerId, shipDate, ...(shipToAddressId ? { shipToAddressId } : {}),
      orders: [{
        orderId: order.id,
        lines: [{ orderLineId: order.lines[0].id, qty, weight: qty, lineComplete: false }],
        containers: [], serials: [],
      }],
    }, { canOverrideCreditHold: false }));
    return shipper;
  }

  it("takes the shipment's ship-to, not the customer's default SHIP_TO row (the owner's case)", async () => {
    const { order, customer, shipper } = await pricedShippedOrder();
    await shipTo(customer.id, "Home Plant", "1 Main St", true);
    const coater = await shipTo(customer.id, "Outside Coater", "9 Coat Rd");
    await asSystem(() => updateShipper(shipper.id, { shipToAddressId: coater.id }));
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.shipTo).toBe("Outside Coater\n9 Coat Rd\nTulsa, OK 74101");
  });

  it("prints the customer's name when the shipment's row has none", async () => {
    const { order, customer, shipper } = await pricedShippedOrder();
    await shipTo(customer.id, "Home Plant", "1 Main St", true);
    const dock = await shipTo(customer.id, "", "9 Coat Rd");
    await asSystem(() => updateShipper(shipper.id, { shipToAddressId: dock.id }));
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.shipTo).toBe(`${customer.name}\n9 Coat Rd\nTulsa, OK 74101`);
  });

  it("takes the later ship date over the later-created shipment", async () => {
    const { order, customer } = await savedOrder({ qty: 144, weight: "3024.00" });
    await shipTo(customer.id, "Default Dock", "0 Default Rd", true); // created first, and the default
    const north = await shipTo(customer.id, "North Plant", "1 North Rd");
    const south = await shipTo(customer.id, "South Plant", "2 South Rd");
    await ship(order, 100, "2026-08-06", north.id);
    await ship(order, 44, "2026-08-05", south.id); // created later, shipped earlier
    expect((await getOrder(order.id)).status).toBe("SHIPPED");
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.shipTo).toBe("North Plant\n1 North Rd\nTulsa, OK 74101");
  });

  it("on one ship date, takes the later-created shipment", async () => {
    const { order, customer } = await savedOrder({ qty: 144, weight: "3024.00" });
    await shipTo(customer.id, "Default Dock", "0 Default Rd", true); // created first, and the default
    const north = await shipTo(customer.id, "North Plant", "1 North Rd");
    const south = await shipTo(customer.id, "South Plant", "2 South Rd");
    const first = await ship(order, 100, "2026-08-05", north.id);
    const second = await ship(order, 44, "2026-08-05", south.id);
    // Set apart by a second, so the case does not rest on the clock's resolution or the id tie-break.
    await prisma.shipper.update({ where: { id: first.id }, data: { createdAt: new Date("2026-08-05T08:00:00Z") } });
    await prisma.shipper.update({ where: { id: second.id }, data: { createdAt: new Date("2026-08-05T08:00:01Z") } });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.shipTo).toBe("South Plant\n2 South Rd\nTulsa, OK 74101");
  });

  it("skips a voided shipment and one that names no ship-to", async () => {
    const { order, customer } = await savedOrder({ qty: 144, weight: "3024.00" });
    await shipTo(customer.id, "Default Dock", "0 Default Rd", true); // created first, and the default
    const north = await shipTo(customer.id, "North Plant", "1 North Rd");
    const south = await shipTo(customer.id, "South Plant", "2 South Rd");
    await ship(order, 144, "2026-08-04", north.id);
    const voided = await ship(order, 6, "2026-08-07", south.id);
    await asSystem(() => voidShipper(voided.id, "shipped twice"));
    await ship(order, 6, "2026-08-08"); // no ship-to
    expect((await getOrder(order.id)).status).toBe("SHIPPED");
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.shipTo).toBe("North Plant\n1 North Rd\nTulsa, OK 74101");
  });

  it("skips a reversal, though it is the latest and names a ship-to", async () => {
    const { order, customer } = await savedOrder({ qty: 144, weight: "3024.00" });
    await shipTo(customer.id, "Default Dock", "0 Default Rd", true); // created first, and the default
    const north = await shipTo(customer.id, "North Plant", "1 North Rd");
    const south = await shipTo(customer.id, "South Plant", "2 South Rd");
    const returned = await shipTo(customer.id, "Returns Dock", "3 Return Rd");
    const original = await ship(order, 144, "2026-08-04", north.id);
    const { shipper: reversal } = await asSystem(() => reverseShipper(original.id, { reason: "wrong parts loaded" }));
    // A reversal copies its original's ship-to; another, on a later date, makes the case discriminate.
    await prisma.shipper.update({
      where: { id: reversal.id }, data: { shipToAddressId: returned.id, shipDate: parseDateOnly("2026-09-01") },
    });
    await ship(order, 144, "2026-08-04", south.id); // the re-ship, created after the original
    expect((await getOrder(order.id)).status).toBe("SHIPPED");
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.shipTo).toBe("South Plant\n2 South Rd\nTulsa, OK 74101");
  });

  it("prints the shipment's row after the address is deleted, as the ticket and bill of lading do", async () => {
    const { order, customer, shipper } = await pricedShippedOrder();
    await shipTo(customer.id, "Home Plant", "1 Main St", true);
    const coater = await shipTo(customer.id, "Outside Coater", "9 Coat Rd");
    await asSystem(() => updateShipper(shipper.id, { shipToAddressId: coater.id }));
    await prisma.customerAddress.update({ where: { id: coater.id }, data: { deletedAt: new Date(), active: false } });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.shipTo).toBe("Outside Coater\n9 Coat Rd\nTulsa, OK 74101");
  });

  it("is set at create only: Recalculate leaves it, and a later ship-to change does not stop Finalize", async () => {
    const { order, customer, shipper } = await pricedShippedOrder();
    await shipTo(customer.id, "Default Dock", "0 Default Rd", true); // created first, and the default
    const north = await shipTo(customer.id, "North Plant", "1 North Rd");
    const south = await shipTo(customer.id, "South Plant", "2 South Rd");
    await asSystem(() => updateShipper(shipper.id, { shipToAddressId: north.id }));
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.shipTo).toBe("North Plant\n1 North Rd\nTulsa, OK 74101");

    await asSystem(() => updateShipper(shipper.id, { shipToAddressId: south.id }));
    expect((await recalc(invoice.id)).shipTo).toBe("North Plant\n1 North Rd\nTulsa, OK 74101");

    await asSystem(() => updateInvoice(invoice.id, { shipTo: "Typed by hand" }));
    expect((await recalc(invoice.id)).shipTo).toBe("Typed by hand");
    await asSystem(() => updateShipper(shipper.id, { shipToAddressId: north.id }));
    const done = await finalize(invoice.id); // the ship-to is not in the shipment fingerprint
    expect(done.status).toBe("FINALIZED");
    expect(done.shipTo).toBe("Typed by hand");
  });
});

describe("unlockInvoice", () => {
  it("unlocks with a reason, records it in the audit entry, and returns the order to SHIPPED", async () => {
    const { order, invoice } = await draftFixture();
    await asSystem(() => finalizeInvoice(invoice.id));
    await expect(asSystem(() => unlockInvoice(invoice.id, "  "))).rejects.toThrow(/reason/i);
    await asSystem(() => unlockInvoice(invoice.id, "wrong PO on the paper"));
    expect((await getInvoice(invoice.id)).status).toBe("DRAFT");
    expect((await getOrder(order.id)).status).toBe("SHIPPED");
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "invoice", entityId: invoice.id, action: "update" }, orderBy: { at: "desc" } });
    expect(entry!.reason).toBe("wrong PO on the paper");
  });

  // #59. `finalizeInvoiceInTx` branches on `kind` — only an INVOICE owns the order's status (§5.2) —
  // but `unlockInvoice` did not, so unlocking a CREDIT passed the order in the `released` set and
  // recomputed it to a ship-derived status. The source INVOICE stayed FINALIZED, still owning
  // INVOICED, while the order silently fell back to SHIPPED.
  it("unlocking a CREDIT leaves the order's invoice-owned status alone (#59)", async () => {
    const { order, invoice } = await draftFixture();
    await asSystem(() => finalizeInvoice(invoice.id));
    expect((await getOrder(order.id)).status).toBe("INVOICED");

    const credit = await asSystem(() => createCredit(invoice.id));
    await asSystem(() => finalizeInvoice(credit.id));
    expect((await getOrder(order.id)).status).toBe("INVOICED"); // finalizing a credit never wrote it

    await asSystem(() => unlockInvoice(credit.id, "credited the wrong amount"));
    expect((await getInvoice(credit.id)).status).toBe("DRAFT");
    // Before the fix: SHIPPED, while the source invoice was still FINALIZED.
    expect((await getOrder(order.id)).status).toBe("INVOICED");
    // ...and no order-status audit entry was written by the credit unlock at all.
    const ord = await prisma.auditLog.findFirst({
      where: { entity: "order", entityId: order.id, action: "update" }, orderBy: { at: "desc" } });
    expect((ord!.after as Record<string, unknown>).status).toBe("INVOICED");
  });

  it("unlock stays available after the invoice has printed", async () => {
    const { invoice } = await draftFixture();
    await asSystem(() => finalizeInvoice(invoice.id));
    await prisma.storedDocument.create({
      data: { kind: "INVOICE", invoiceId: invoice.id, fileData: new Uint8Array([1]) } });
    await expect(asSystem(() => unlockInvoice(invoice.id, "customer disputed a line"))).resolves.toBeTruthy();
  });

  it("refuses to unlock an invoice that is not finalized", async () => {
    const { invoice } = await draftFixture();
    await expect(asSystem(() => unlockInvoice(invoice.id, "nothing to do"))).rejects.toThrow(/not finalized/i);
  });

  // Task 9 (§5.3): a FINALIZED invoice with a live payment applied cannot be unlocked — unlocking
  // would leave editable paper that money has already been applied to. Void the application first.
  it("refuses to unlock once a payment has been applied, then re-permits once the application is voided", async () => {
    const fx = await finalizedFixture();
    const applicationId = await applyAPayment(fx.order.customerId, fx.invoice.id, 100);

    await expect(asSystem(() => unlockInvoice(fx.invoice.id, "correct a line")))
      .rejects.toMatchObject({
        status: 400,
        // #179: blocked purely by a PAYMENT (no standalone write-off in scope) and no closed month,
        // so the tail carries no route clause — a payment is not voided from the Receivables section.
        message: `Invoice #${fx.order.orderNumber} has payments, credits or write-offs applied — `
          + "void them before unlocking",
      });
    // Refused, not half-applied: still FINALIZED.
    expect((await getInvoice(fx.invoice.id)).status).toBe("FINALIZED");

    // Voiding the application drops the A/R activity; the unlock is now permitted and audited.
    await asSystem(() => voidApplication(applicationId, "keyed to the wrong invoice"));
    const unlocked = await asSystem(() => unlockInvoice(fx.invoice.id, "customer disputed a line"));
    expect(unlocked.status).toBe("DRAFT");
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "invoice", entityId: fx.invoice.id, action: "update" }, orderBy: { at: "desc" } });
    expect(entry!.reason).toBe("customer disputed a line");
    expect((entry!.before as Record<string, unknown>).status).toBe("FINALIZED");
    expect((entry!.after as Record<string, unknown>).status).toBe("DRAFT");
  });

  // Note #2 (folded in from Task 12): unlock MUST return the invoice to DRAFT, or every Task 12
  // mutator keeps refusing it and "unlock" does nothing. Prove all four edit paths work again after.
  it("returns the invoice to DRAFT — every draft edit works again", async () => {
    const { invoice } = await draftFixture();
    await asSystem(() => finalizeInvoice(invoice.id));
    // Finalized: the four refuse.
    await expect(asSystem(() => updateInvoice(invoice.id, { poNumber: "X" }))).rejects.toThrow(/finalized/i);
    await asSystem(() => unlockInvoice(invoice.id, "reopen to correct"));
    // DRAFT again: the four succeed.
    await expect(asSystem(() => updateInvoice(invoice.id, { poNumber: "PO-7" }))).resolves.toBeTruthy();
    const currentLines = (await asSystem(() => getInvoice(invoice.id))).lines.map(toLineInput);
    await expect(asSystem(() => replaceInvoiceLines(invoice.id, currentLines))).resolves.toBeTruthy();
    await expect(asSystem(() => recalculateInvoice(invoice.id))).resolves.toBeTruthy();
    await expect(asSystem(() => discardInvoice(invoice.id, "done"))).resolves.toBeUndefined();
  });
});

// -------------------------------------------------------------------------------------------
// Task 14: credits. A credit is the correction for an already-FINALIZED invoice — it copies the
// source's header and lines with the MONEY sign flipped (quantities unchanged), carries its own
// `credit_number_next`, and has its own draft->finalized lifecycle. Finalizing a CREDIT writes no
// order status: INVOICED/REOPENED are invoice-owned, and a credit owns none of them.
// -------------------------------------------------------------------------------------------

/** -0 reads back from Postgres as +0, and `toBe` uses Object.is, so a zero line's negation must be
 *  compared as +0, not -0. Non-zero amounts negate as expected. */
const flipped = (n: number) => (n === 0 ? 0 : -n);

describe("createCredit", () => {
  it("derives a credit from a finalized invoice with the sign flipped", async () => {
    const { invoice } = await finalizedFixture(); // default op amount = 144 × 6.51 = 937.44
    const credit = await asSystem(() => createCredit(invoice.id));
    expect(credit.kind).toBe("CREDIT");
    expect(credit.status).toBe("DRAFT");
    expect(credit.sourceInvoiceId).toBe(invoice.id);
    expect(credit.creditNumber).toBe(1000);
    expect(credit.documentNumber).toBe("1000"); // the credit number, NOT the order/invoice number
    expect(credit.total).toBe(-937.44);
    expect(credit.subtotal).toBe(-937.44);

    const op = credit.lines.find((l) => l.kind === "OPERATION")!;
    const part = credit.lines.find((l) => l.kind === "PART")!;
    expect(op.amount).toBe(-937.44);        // money negates
    expect(part.qty).toBe(144);             // quantity does NOT negate — the paper says what was billed
    expect(op.parentLineId).toBe(part.id);  // the OPERATION still hangs off its PART line (parents rewired)
  });

  it("copies the header and reuses the invoice's exact lines, only the money flipped (no drift)", async () => {
    await setSetting("invoice_number_prefix", "7");
    const { invoice } = await finalizedFixture();
    const source = await asSystem(() => getInvoice(invoice.id));
    const credit = await asSystem(() => createCredit(invoice.id));

    // Header snapshots copied verbatim from the source. `invoiceDate` is the deliberate EXCEPTION —
    // a credit takes its own raise date (Task 3/§4.3), never the source's — and is not asserted
    // equal here for that reason (see the dedicated test below; it isn't asserted `not.toBe` here
    // either, since this fixture's source invoice is itself dated "today", same as the credit).
    expect(credit.orderId).toBe(source.orderId);
    expect(credit.customerId).toBe(source.customerId);
    expect(credit.poNumber).toBe(source.poNumber);
    expect(credit.termsName).toBe(source.termsName);
    expect(credit.billTo).toBe(source.billTo);
    expect(credit.shipTo).toBe(source.shipTo);
    expect(credit.materialName).toBe(source.materialName);
    expect(credit.processNames).toBe(source.processNames);
    expect(credit.taxRate).toBe(source.taxRate);

    // Lines are the invoice's lines, position-for-position, with amount negated and everything else
    // (kind, part identity, gl, qty, weight) untouched. This is the anti-drift guarantee.
    expect(credit.lines.length).toBe(source.lines.length);
    credit.lines.forEach((cl, i) => {
      const sl = source.lines[i];
      expect(cl.kind).toBe(sl.kind);
      expect(cl.description).toBe(sl.description);
      expect(cl.glAccountName).toBe(sl.glAccountName);
      expect(cl.qty).toBe(sl.qty);       // unchanged
      expect(cl.weight).toBe(sl.weight); // unchanged
      expect(cl.amount).toBe(flipped(sl.amount)); // money flipped
    });
  });

  it("stamps the credit's own creation date, not the source invoice's date (Task 3/§4.3)", async () => {
    const fixture = await pricedShippedOrder({ qty: 144, unitPrice: "6.5100", minimumCharge: "600.00" });
    const thirtyDaysAgo = formatDateOnly(addDays(todayDateOnly(), -30));
    const { invoice } = await asSystem(() =>
      createInvoice({ orderId: fixture.order.id, invoiceDate: thirtyDaysAgo }));
    await asSystem(() => finalizeInvoice(invoice.id));

    const credit = await asSystem(() => createCredit(invoice.id));
    expect(credit.invoiceDate).toBe(formatDateOnly(todayDateOnly()));
    expect(credit.invoiceDate).not.toBe(thirtyDaysAgo);

    // The audit `after` snapshot carries the credit's OWN date too, not the source's.
    const entry = await prisma.auditLog.findFirst({ where: { entity: "invoice", entityId: credit.id } });
    expect((entry!.after as Record<string, unknown>).invoiceDate).toBe(formatDateOnly(todayDateOnly()));
  });

  it("refuses a credit against a draft", async () => {
    const { invoice } = await draftFixture();
    await expect(asSystem(() => createCredit(invoice.id))).rejects.toThrow(/finalized/i);
  });

  it("refuses to credit a credit, naming it not an invoice", async () => {
    const { invoice } = await finalizedFixture();
    const credit = await asSystem(() => createCredit(invoice.id));
    await expect(asSystem(() => createCredit(credit.id))).rejects.toThrow(/not an invoice/i);
  });

  it("refuses a credit when the order has been voided", async () => {
    const { order, invoice } = await finalizedFixture();
    await prisma.order.update({ where: { id: order.id }, data: { deletedAt: new Date() } });
    await expect(asSystem(() => createCredit(invoice.id))).rejects.toThrow(/voided/i);
  });

  it("allows a second credit against the same invoice, with its own number", async () => {
    const { invoice } = await finalizedFixture();
    const a = await asSystem(() => createCredit(invoice.id));
    const b = await asSystem(() => createCredit(invoice.id));
    expect(b.creditNumber).toBe(a.creditNumber! + 1);
  });

  it("keeps the source invoice live and finalized alongside its credit", async () => {
    const { order, invoice } = await finalizedFixture();
    await asSystem(() => createCredit(invoice.id));
    // The one-live-invoice-per-order partial index is scoped to kind='INVOICE', so a CREDIT never
    // collides with its source — both are live on the same order.
    const live = await prisma.invoice.count({ where: { orderId: order.id, deletedAt: null } });
    expect(live).toBe(2);
    expect((await getInvoice(invoice.id)).status).toBe("FINALIZED");
  });

  it("audits the create with the negated lines and total in the snapshot", async () => {
    const { invoice } = await finalizedFixture();
    const credit = await asSystem(() => createCredit(invoice.id));
    const entry = await prisma.auditLog.findFirst({ where: { entity: "invoice", entityId: credit.id } });
    expect(entry!.action).toBe("create");
    expect(JSON.stringify(entry!.after)).toContain("-937.44");
  });

  it("can be reduced to a partial amount and finalized without touching the order status", async () => {
    const { order, invoice } = await finalizedFixture();
    expect((await getOrder(order.id)).status).toBe("SHIPPED"); // precondition — untouched by finalizing the credit
    const credit = await asSystem(() => createCredit(invoice.id));
    const reduced = await asSystem(() => replaceInvoiceLines(credit.id,
      credit.lines.map((l) => (l.kind === "OPERATION" ? { ...toLineInput(l), amount: "-100.00" } : toLineInput(l)))));
    expect(reduced.total).toBe(-100);
    const finalized = await asSystem(() => finalizeInvoice(credit.id));
    expect((await getInvoice(credit.id)).status).toBe("FINALIZED");
    expect(finalized.dueDate).toBeNull(); // a CREDIT never gets a due date (Task 3/§4.3)
    expect((await getOrder(order.id)).status).toBe("SHIPPED"); // a credit finalize writes NO order status
  });

  it("finalizing a credit writes no order-status audit entry", async () => {
    const { order, invoice } = await finalizedFixture();
    const credit = await asSystem(() => createCredit(invoice.id));
    // The order already carries update entries from shipping — measure the DELTA around the credit
    // finalize, which must add none (an INVOICE finalize would add one setting the order INVOICED).
    const before = await prisma.auditLog.count({
      where: { entity: "order", entityId: order.id, action: "update" } });
    await asSystem(() => finalizeInvoice(credit.id));
    const after = await prisma.auditLog.count({
      where: { entity: "order", entityId: order.id, action: "update" } });
    expect(after).toBe(before); // finalizing the credit touched only the credit, never the order
  });

  it("never frees a credit number when the draft is discarded", async () => {
    const { invoice } = await finalizedFixture();
    const credit = await asSystem(() => createCredit(invoice.id));
    await asSystem(() => discardInvoice(credit.id, "raised in error"));
    const next = await asSystem(() => createCredit(invoice.id));
    expect(next.creditNumber).toBe(credit.creditNumber! + 1);
  });
});

// -------------------------------------------------------------------------------------------
// #587: words chosen for a line. `wordsChosen` marks a line whose words were typed or picked on
// it. These pin the column at every site that writes or reads it: Save lines, create, Recalculate's
// kept MANUAL line, and the credit's copy.
// -------------------------------------------------------------------------------------------

describe("words chosen for a line (#587)", () => {
  // Mutation-proof: drop `wordsChosen` from `lineColumns` and the saved line reads false.
  it("a Save carrying the mark on an OPERATION line reads it back", async () => {
    const { invoice } = await draftFixture();
    const saved = await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) =>
      (l.kind === "OPERATION" ? chooseWords(l, "Age Harden") : toLineInput(l)))));

    const op = saved.lines.find((l) => l.kind === "OPERATION")!;
    expect(op.description).toBe("Age Harden");
    expect(op.wordsChosen).toBe(true);
    expect(saved.lines.find((l) => l.kind === "PART")!.wordsChosen).toBe(false);
    const read = await asSystem(() => getInvoice(invoice.id));
    expect(read.lines.find((l) => l.kind === "OPERATION")!.wordsChosen).toBe(true);
  });

  // An older client, or a payload with no `wordsChosen` key, is still a valid Save, and it writes
  // the column as false: the replace writes whole rows, so a mark the payload omits is gone.
  it("a Save without the mark is accepted and reads false", async () => {
    const { invoice } = await draftFixture();
    const marked = await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) =>
      (l.kind === "OPERATION" ? chooseWords(l, "Age Harden") : toLineInput(l)))));
    expect(marked.lines.find((l) => l.kind === "OPERATION")!.wordsChosen).toBe(true);

    const saved = await asSystem(() => replaceInvoiceLines(invoice.id, marked.lines.map((l) => {
      const { wordsChosen: _drop, ...older } = toLineInput(l); void _drop;
      return older;
    })));
    expect(saved.lines.find((l) => l.kind === "OPERATION")!.description).toBe("Age Harden");
    expect(saved.lines.map((l) => l.wordsChosen)).toEqual(saved.lines.map(() => false));
  });

  // #587 fix wave (F4): only an operation line's words can be chosen, so Save writes the mark false
  // on any other kind, whatever the payload sent. Mutation-proof: write `l.wordsChosen ?? false` for
  // every kind in `lineColumns` and the PART and CHARGE lines read true.
  it("a Save writes the mark false on every line but an operation, whatever it sent", async () => {
    const { invoice } = await draftFixture();
    const saved = await asSystem(() => replaceInvoiceLines(invoice.id, [
      ...invoice.lines.map((l) => chooseWords(l, l.kind === "OPERATION" ? "Age Harden" : "Part words")),
      { kind: "CHARGE" as const, description: "Expedite", amount: "50.00", priceSource: "MANUAL" as const, wordsChosen: true },
    ]));

    expect(saved.lines.map((l) => [l.kind, l.description, l.wordsChosen])).toEqual([
      ["PART", "Part words", false], ["OPERATION", "Age Harden", true], ["CHARGE", "Expedite", false],
    ]);
  });

  // Mutation-proof: write `wordsChosen: true` in `mapComputedLines` and every line here reads true.
  it("a fresh create writes the column false on every line", async () => {
    const { invoice } = await draftFixture();
    expect(invoice.lines.map((l) => l.kind)).toEqual(["PART", "OPERATION"]);
    expect(invoice.lines.map((l) => l.wordsChosen)).toEqual([false, false]);
  });

  // Mutation-proof: drop `wordsChosen` from `manualWrite` and the kept override reads false.
  it("a MANUAL line keeps the mark through Recalculate", async () => {
    const { order, invoice } = await draftFixture({ qty: 144 });
    await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) =>
      (l.kind === "OPERATION"
        ? { ...overrideAmount(l, "100.00"), description: "Age Harden", wordsChosen: true }
        : toLineInput(l)))));
    await shipMore(order, 6);

    const after = await asSystem(() => recalculateInvoice(invoice.id));
    const op = after.lines.find((l) => l.kind === "OPERATION")!;
    expect(op.priceSource).toBe("MANUAL");
    expect(op.description).toBe("Age Harden");
    expect(op.wordsChosen).toBe(true);
    expect(after.lines.find((l) => l.kind === "PART")!.wordsChosen).toBe(false);
  });

  // Mutation-proof: drop `wordsChosen` from `createCredit`'s line copy and the credit's line reads
  // false. The source is finalized through Prisma (the `finalizedFixture` shape) after its Save,
  // because Save lines refuses a finalized invoice.
  it("a credit copies the mark from the invoice it corrects", async () => {
    const { invoice } = await draftFixture();
    await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) =>
      (l.kind === "OPERATION" ? chooseWords(l, "Age Harden") : toLineInput(l)))));
    await prisma.invoice.update({
      where: { id: invoice.id }, data: { status: "FINALIZED", finalizedAt: new Date() },
    });

    const credit = await asSystem(() => createCredit(invoice.id));
    const op = credit.lines.find((l) => l.kind === "OPERATION")!;
    expect(op.description).toBe("Age Harden");
    expect(op.wordsChosen).toBe(true);
    expect(credit.lines.find((l) => l.kind === "PART")!.wordsChosen).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
// #587 at Recalculate (the plan's T2; Amendments 17-19). The words chosen on a derived operation
// line, and its mark, carry onto the regenerated line with the same identity (order line and step
// code), or, from a line with no step code, onto its order line's one operation when exactly one now
// appears; nothing else carries. A picked Needs price line (MANUAL, a step code, no price row) takes
// its exact twin, else only its order line's tier-3 slot, else rides at the end; its GL account is
// read from its step code. Every carry asserts the words AND the mark. One `it` per invoice.
// -------------------------------------------------------------------------------------------

describe("recalculateInvoice — chosen words and a picked step (#587)", () => {
  const save = (inv: InvoiceDetail, lines: unknown[]) => asSystem(() => replaceInvoiceLines(inv.id, lines));
  const recalculate = (inv: InvoiceDetail) => asSystem(() => recalculateInvoice(inv.id));
  const operations = (inv: InvoiceDetail) => inv.lines.filter((l) => l.kind === "OPERATION");
  /** Each operation's step code, words, mark, amount and source, in order. */
  const words = (inv: InvoiceDetail) => operations(inv)
    .map((l) => [l.processStepCodeId, l.description, l.wordsChosen, l.amount, l.priceSource]);

  const stepCode = (code: string, name: string, glAccountId: string | null = null) =>
    prisma.processStepCode.create({ data: { code, name, glAccountId } });
  /** A price row of $1.00 each, no minimum: 100 shipped bills 100.00. */
  const priceUnder = (partId: string, processStepCodeId: string, position = 1) =>
    asSystem(() => addPartPrice(partId, { processStepCodeId, position, unitPrice: "1.0000", pricePer: "EACH" }));

  /** 100 shipped of an unpriced part, invoiced: its one operation is the tier-3 Needs price line. */
  async function needsPriceInvoice() {
    const fixture = await shippedOrder({ qty: 100 });
    const { invoice } = await asSystem(() => createInvoice({ orderId: fixture.order.id }));
    const op = operations(invoice)[0];
    expect([op.description, op.processStepCodeId, op.pricePer, op.needsPrice])
      .toEqual(["Needs price", null, null, true]);
    return { ...fixture, invoice };
  }

  /** Words typed on the Needs price line, no price: the line stays derived, with no step code. */
  const typedWords = (inv: InvoiceDetail) =>
    inv.lines.map((l) => (l.kind === "OPERATION" ? chooseWords(l, "Age Harden") : toLineInput(l)));
  /** A step picked on the Needs price line before any price is typed: derived, step X, no price
   *  row, marked, its words the operator's own. */
  const pickedBeforePrice = (inv: InvoiceDetail, codeId: string) => inv.lines.map((l) =>
    (l.kind === "OPERATION" ? { ...chooseWords(l, "Age Harden"), processStepCodeId: codeId } : toLineInput(l)));
  /** A picked Needs price line: a price typed (MANUAL) and step X picked, `pricePer` still the
   *  Needs price line's null. */
  const picked = (inv: InvoiceDetail, codeId: string, extra: Record<string, unknown> = {}) => inv.lines.map((l) =>
    (l.kind === "OPERATION"
      ? { ...overrideAmount(l, "175.00"), processStepCodeId: codeId, description: "Op X", wordsChosen: true, ...extra }
      : toLineInput(l)));
  /** The saved picked line is what the cases below mean by one. */
  function expectPicked(inv: InvoiceDetail, codeId: string) {
    expect(operations(inv).map((l) => [l.priceSource, l.processStepCodeId, l.pricePer, l.amount]))
      .toEqual([["MANUAL", codeId, null, 175]]);
  }

  // Red before the carry. Held by the mutation that drops the carry, and by the one that carries
  // every derived line's words, marked or not (B's would read true).
  it("(a) keeps the words chosen on one of two priced operations, the other its default, both re-priced", async () => {
    const { order, invoice, codes } = await twoPricedOperations();
    const opA = invoice.lines.find((l) => l.processStepCodeId === codes[0].id)!;
    const saved = await save(invoice, invoice.lines.map((l) =>
      (l.id === opA.id ? chooseWords(l, "Age Harden") : toLineInput(l))));
    expect(words(saved)).toEqual([
      [codes[0].id, "Age Harden", true, 100, "PART_PRICE"], [codes[1].id, "Op B", false, 100, "PART_PRICE"],
    ]);
    await shipMore(order, 6);

    const after = await recalculate(invoice);
    expect(words(after)).toEqual([
      [codes[0].id, "Age Harden", true, 106, "PART_PRICE"], [codes[1].id, "Op B", false, 106, "PART_PRICE"],
    ]);
  });

  // Red before the carry. Held by the mutation that drops the carry.
  it("(b) carries words typed on a Needs price line onto the one operation the part is then priced under", async () => {
    const { part, invoice } = await needsPriceInvoice();
    const saved = await save(invoice, typedWords(invoice));
    expect(words(saved)).toEqual([[null, "Age Harden", true, 0, null]]); // still derived
    const codeS = await stepCode("SOLE-S", "Op S");
    await priceUnder(part.id, codeS.id);

    const after = await recalculate(invoice);
    expect(words(after)).toEqual([[codeS.id, "Age Harden", true, 100, "PART_PRICE"]]);
  });

  // Green before the carry (nothing carried then). Held by the mutation that drops the exactly-one
  // test from the carry of a line with no step code.
  it("(c) carries them nowhere when the part is then priced under two operations", async () => {
    const { part, invoice } = await needsPriceInvoice();
    await save(invoice, typedWords(invoice));
    const codeA = await stepCode("TWO-A", "Op A");
    const codeB = await stepCode("TWO-B", "Op B");
    await priceUnder(part.id, codeA.id, 1);
    await priceUnder(part.id, codeB.id, 2);

    const after = await recalculate(invoice);
    expect(words(after)).toEqual([
      [codeA.id, "Op A", false, 100, "PART_PRICE"], [codeB.id, "Op B", false, 100, "PART_PRICE"],
    ]);
  });

  // Red before the change: the picked line took Y's slot, and the total was 175. Held by the
  // mutation that gives a picked line the old fallback, `free.slice(0, 1)`.
  it("(d) bills a step priced since, other than the one picked, on its own line, the picked line at the end", async () => {
    const { part, invoice } = await needsPriceInvoice();
    const codeX = await stepCode("PICK-X", "Op X");
    const codeY = await stepCode("PICK-Y", "Op Y");
    expectPicked(await save(invoice, picked(invoice, codeX.id)), codeX.id);
    await priceUnder(part.id, codeY.id);

    const after = await recalculate(invoice);
    expect(after.lines.map((l) => l.kind)).toEqual(["PART", "OPERATION", "OPERATION"]);
    expect(words(after)).toEqual([
      [codeY.id, "Op Y", false, 100, "PART_PRICE"], [codeX.id, "Op X", true, 175, "MANUAL"],
    ]);
    expect(after.lines[1].parentLineId).toBe(after.lines[0].id); // Y's own line, under its PART
    expect(after.total).toBe(275);
  });

  // A pin: the exact twin was taken before #587 too.
  it("(e) takes the picked step's own slot once that step is priced", async () => {
    const { part, invoice } = await needsPriceInvoice();
    const codeX = await stepCode("PICK-X", "Op X");
    expectPicked(await save(invoice, picked(invoice, codeX.id)), codeX.id);
    await priceUnder(part.id, codeX.id);

    const after = await recalculate(invoice);
    expect(after.lines.map((l) => l.kind)).toEqual(["PART", "OPERATION"]);
    expect(words(after)).toEqual([[codeX.id, "Op X", true, 175, "MANUAL"]]);
    expect(after.lines[1].parentLineId).toBe(after.lines[0].id);
    expect(after.total).toBe(175);
  });

  // A pin: the old fallback took the tier-3 slot too, as the order line's only operation.
  it("(f) keeps the tier-3 slot under its PART line while the part is still unpriced", async () => {
    const { invoice } = await needsPriceInvoice();
    const codeX = await stepCode("PICK-X", "Op X");
    expectPicked(await save(invoice, picked(invoice, codeX.id)), codeX.id);

    const after = await recalculate(invoice);
    expect(after.lines.map((l) => l.kind)).toEqual(["PART", "OPERATION"]);
    expect(words(after)).toEqual([[codeX.id, "Op X", true, 175, "MANUAL"]]);
    expect(after.lines[1].parentLineId).toBe(after.lines[0].id);
    expect(after.total).toBe(175);
  });

  // Green before the carry. Held by the mutation that lets a line with a step code carry by the
  // exactly-one rule (X's words would land on the Needs price line).
  it("(g i) rebuilds a step picked before the price was typed as Needs price while the part is unpriced", async () => {
    const { invoice } = await needsPriceInvoice();
    const codeX = await stepCode("EARLY-X", "Op X");
    const saved = await save(invoice, pickedBeforePrice(invoice, codeX.id));
    expect(words(saved)).toEqual([[codeX.id, "Age Harden", true, 0, null]]); // derived, step X

    const after = await recalculate(invoice);
    expect(operations(after).map((l) => [l.processStepCodeId, l.description, l.wordsChosen, l.needsPrice]))
      .toEqual([[null, "Needs price", false, true]]);
  });

  // Red before the carry. Held by the mutation that drops the carry.
  it("(g ii) carries a step picked before the price was typed onto that step's line once it is priced", async () => {
    const { part, invoice } = await needsPriceInvoice();
    const codeX = await stepCode("EARLY-X", "Op X");
    await save(invoice, pickedBeforePrice(invoice, codeX.id));
    await priceUnder(part.id, codeX.id);

    const after = await recalculate(invoice);
    expect(words(after)).toEqual([[codeX.id, "Age Harden", true, 100, "PART_PRICE"]]);
  });

  // Green before the carry. Held by the mutation that lets a line with a step code carry by the
  // exactly-one rule.
  it("(g iii) never carries them onto another step priced instead", async () => {
    const { part, invoice } = await needsPriceInvoice();
    const codeX = await stepCode("EARLY-X", "Op X");
    const codeY = await stepCode("EARLY-Y", "Op Y");
    await save(invoice, pickedBeforePrice(invoice, codeX.id));
    await priceUnder(part.id, codeY.id);

    const after = await recalculate(invoice);
    expect(words(after)).toEqual([[codeY.id, "Op Y", false, 100, "PART_PRICE"]]);
  });

  // Red before the change. Held by the mutation that keeps the stored account.
  it("(h) reads a picked line's GL account from its step code at Recalculate, not the one stored", async () => {
    const { invoice } = await needsPriceInvoice();
    const first = await prisma.glAccount.create({ data: { name: "4101", description: "Sales" } });
    const second = await prisma.glAccount.create({ data: { name: "4102", description: "Sales" } });
    const codeX = await stepCode("GL-X", "Op X", first.id);
    const saved = await save(invoice, picked(invoice, codeX.id, { glAccountId: first.id, glAccountName: "4101" }));
    expectPicked(saved, codeX.id);
    expect(operations(saved).map((l) => [l.glAccountId, l.glAccountName])).toEqual([[first.id, "4101"]]);
    await prisma.processStepCode.update({ where: { id: codeX.id }, data: { glAccountId: second.id } });

    const after = await recalculate(invoice);
    expect(operations(after).map((l) => [l.priceSource, l.glAccountId, l.glAccountName]))
      .toEqual([["MANUAL", second.id, "4102"]]);
  });

  // #587 fix wave (F10): words typed on a Needs price line, the part still unpriced. The line is
  // rebuilt as the tier-3 line, whose identity (its order line, no step code) is the typed line's
  // own, so the words and the mark carry by identity. Green before this wave (a pin); held by the
  // mutation that drops the carry.
  it("keeps words typed on a Needs price line while the part is still unpriced", async () => {
    const { invoice } = await needsPriceInvoice();
    await save(invoice, typedWords(invoice));

    const after = await recalculate(invoice);
    expect(words(after)).toEqual([[null, "Age Harden", true, 0, null]]);
    expect(operations(after).map((l) => l.needsPrice)).toEqual([true]);
  });

  // #587 fix wave (F11): the carry from a line with no step code is its own order line's. Two
  // unpriced parts, words typed on the first's Needs price line, then each part priced under a step
  // of its own: each order line now has exactly one operation, and only the first takes the words.
  // Held by the mutation that keys the stepless carry off one value rather than per order line.
  it("carries words typed on one part line's Needs price line onto that part line's operation alone", async () => {
    const customer = await makeCustomer();
    const [partOne, partTwo] = [await makePart(customer.id), await makePart(customer.id)];
    await giveSteps(partOne.id);
    await giveSteps(partTwo.id);
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id,
      lines: [
        { partId: partOne.id, qty: 10, weight: "10.00" },
        { partId: partTwo.id, qty: 10, weight: "10.00" },
      ],
    }));
    await asSystem(() => createShipper({
      customerId: customer.id, shipDate: "2026-08-04",
      orders: [{
        orderId: order.id,
        lines: order.lines.map((l) => ({ orderLineId: l.id, qty: 10, weight: 10, lineComplete: true })),
        containers: [], serials: [],
      }],
    }, { canOverrideCreditHold: false }));
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(operations(invoice).map((l) => [l.orderLineId, l.description, l.processStepCodeId]))
      .toEqual([[order.lines[0].id, "Needs price", null], [order.lines[1].id, "Needs price", null]]);
    await save(invoice, invoice.lines.map((l) => (l.kind === "OPERATION" && l.orderLineId === order.lines[0].id
      ? chooseWords(l, "Age Harden") : toLineInput(l))));
    const codeOne = await stepCode("LINE-S1", "Op S1");
    const codeTwo = await stepCode("LINE-S2", "Op S2");
    await priceUnder(partOne.id, codeOne.id);
    await priceUnder(partTwo.id, codeTwo.id);

    const after = await recalculate(invoice);
    expect(words(after)).toEqual([
      [codeOne.id, "Age Harden", true, 10, "PART_PRICE"], [codeTwo.id, "Op S2", false, 10, "PART_PRICE"],
    ]);
  });

  // #587 fix wave (F4): Recalculate carries an operation line's words only. Save now writes any other
  // line's mark false, so the PART line's mark is written through Prisma, as a Save could before.
  // Held by the mutation that drops `l.kind === "OPERATION"` from the carry's filter: the PART line,
  // with no step code, would carry its words onto its order line's one operation.
  it("never carries words marked on a PART line onto its operation", async () => {
    const { part, invoice } = await needsPriceInvoice();
    const partLine = invoice.lines.find((l) => l.kind === "PART")!;
    await prisma.invoiceLine.update({ where: { id: partLine.id }, data: { wordsChosen: true, description: "Part words" } });
    const codeS = await stepCode("PARTWORDS-S", "Op S");
    await priceUnder(part.id, codeS.id);

    const after = await recalculate(invoice);
    expect(words(after)).toEqual([[codeS.id, "Op S", false, 100, "PART_PRICE"]]);
  });

  // Beyond the plan's (a)-(h): none held the carry's "derived" (only words chosen on a derived line
  // carry; the mutation that lets a typed line's words carry stayed green). A typed line with no
  // step code rides at the end beside an operation already billed (#61's round 2), and its words
  // stay on it alone, though that operation is its order line's only one. Green before the carry.
  it("never carries a typed line's words onto a derived line", async () => {
    const { order, stepCode: code } =
      await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    await save(invoice, [
      ...invoice.lines.map(toLineInput),
      {
        kind: "OPERATION" as const, orderLineId: order.lines[0].id, description: "Age Harden",
        wordsChosen: true, priceSource: "MANUAL" as const, amount: "50.00",
      },
    ]);

    const after = await recalculate(invoice);
    expect(words(after)).toEqual([
      [code.id, "Austemper", false, 100, "PART_PRICE"], [null, "Age Harden", true, 50, "MANUAL"],
    ]);
    expect(after.total).toBe(150);
  });
});

// -------------------------------------------------------------------------------------------
// #587 at Save lines and Finalize (the plan's T3; rulings 587-10 b and 587-13, Amendments 17 and
// 21). On an INVOICE, Save lines gives an OPERATION line with a step code and no price row (a step
// picked on a Needs price line) its step code's GL account, whatever the payload sent; a credit's
// lines keep the account they were copied with. Finalize refuses, on an INVOICE and after the
// needs-price refusal, a typed price on an operation line with no step code that bills (not $0).
// One `it` per invoice.
// -------------------------------------------------------------------------------------------

describe("Save lines and Finalize — a picked step's GL account, an unpicked typed price (#587)", () => {
  const save = (inv: InvoiceDetail, lines: unknown[]) => asSystem(() => replaceInvoiceLines(inv.id, lines));
  const finalize = (inv: InvoiceDetail) => asSystem(() => finalizeInvoice(inv.id));
  const operations = (inv: InvoiceDetail) => inv.lines.filter((l) => l.kind === "OPERATION");
  /** Each operation's step code and GL account, in order. */
  const glOf = (inv: InvoiceDetail) => operations(inv).map((l) => [l.processStepCodeId, l.glAccountId, l.glAccountName]);

  const glAccount = (name: string) => prisma.glAccount.create({ data: { name, description: "Sales" } });
  const stepCode = (code: string, name: string, glAccountId: string | null = null) =>
    prisma.processStepCode.create({ data: { code, name, glAccountId } });

  /** 100 shipped of an unpriced part, invoiced: its one operation is the tier-3 Needs price line. */
  async function needsPriceInvoice() {
    const fixture = await shippedOrder({ qty: 100 });
    const { invoice } = await asSystem(() => createInvoice({ orderId: fixture.order.id }));
    expect(operations(invoice).map((l) => [l.processStepCodeId, l.pricePer, l.needsPrice, l.glAccountId]))
      .toEqual([[null, null, true, null]]);
    return { ...fixture, invoice };
  }
  /** The invoice's lines with a price typed on each operation line, and `over` (a step picked, an
   *  account sent) on it too, as the grid sends them. */
  const typed = (inv: InvoiceDetail, amount: string, over: Record<string, unknown> = {}) => inv.lines.map((l) =>
    (l.kind === "OPERATION" ? { ...overrideAmount(l, amount), ...over } : toLineInput(l)));

  // Red before the derivation: the line kept the payload's empty account.
  it("gives a step picked on a typed Needs price line its step code's GL account", async () => {
    const { invoice } = await needsPriceInvoice();
    const gl = await glAccount("4201");
    const codeX = await stepCode("SAVE-X", "Op X", gl.id);

    const saved = await save(invoice, typed(invoice, "175.00", {
      processStepCodeId: codeX.id, description: "Op X", wordsChosen: true }));
    expect(glOf(saved)).toEqual([[codeX.id, gl.id, "4201"]]);
    expect(glOf(await asSystem(() => getInvoice(invoice.id)))).toEqual([[codeX.id, gl.id, "4201"]]);
  });

  // Red before the derivation: the line kept the old account the payload sent.
  it("gives a re-picked line the new step code's account, though the payload still names the old one", async () => {
    const { invoice } = await needsPriceInvoice();
    const first = await glAccount("4202");
    const second = await glAccount("4203");
    const codeX = await stepCode("REPICK-X", "Op X", first.id);
    const codeY = await stepCode("REPICK-Y", "Op Y", second.id);
    const pickedX = await save(invoice, typed(invoice, "175.00", { processStepCodeId: codeX.id }));
    expect(glOf(pickedX)).toEqual([[codeX.id, first.id, "4202"]]);

    // The row as the screen holds it, re-picked: the new step code beside the old account.
    const pickedY = await save(pickedX, pickedX.lines.map((l) => (l.kind === "OPERATION"
      ? { ...toLineInput(l), processStepCodeId: codeY.id, description: "Op Y", glAccountId: first.id, glAccountName: "4202" }
      : toLineInput(l))));
    expect(glOf(pickedY)).toEqual([[codeY.id, second.id, "4203"]]);
  });

  // Red before the derivation: the line kept the account the payload sent.
  it("leaves a picked line with no account when its step code has none, whatever the payload sent", async () => {
    const { invoice } = await needsPriceInvoice();
    const sent = await glAccount("4204");
    const codeZ = await stepCode("NOGL-Z", "Op Z");

    const saved = await save(invoice, typed(invoice, "175.00", {
      processStepCodeId: codeZ.id, glAccountId: sent.id, glAccountName: "4204" }));
    expect(glOf(saved)).toEqual([[codeZ.id, null, ""]]);
    // On the export's readiness list, as an engine line with no account is (ruling 587-10 b).
    expect((await invoiceWarnings(saved)).join(" ")).toMatch(/has no GL account/);
  });

  // #587 fix wave (F2): a step picked before any price is typed (a derived line: no price row, not
  // MANUAL) takes its step code's account at Save too. Held by the mutation that asks the Save's
  // derivation of MANUAL lines only.
  it("gives a step picked on an untyped Needs price line its step code's GL account", async () => {
    const { invoice } = await needsPriceInvoice();
    const gl = await glAccount("4209");
    const codeX = await stepCode("EARLY-X", "Op X", gl.id);

    const saved = await save(invoice, invoice.lines.map((l) => (l.kind === "OPERATION"
      ? { ...chooseWords(l, "Op X"), processStepCodeId: codeX.id } : toLineInput(l))));
    expect(glOf(saved)).toEqual([[codeX.id, gl.id, gl.name]]);
    expect(operations(saved).map((l) => [l.priceSource, l.needsPrice])).toEqual([[null, true]]);
  });

  // #587 fix wave (F3): the standing-in warning is about a TYPED price: the engine's own Needs price
  // line, untyped, stands in for nothing. Held by the mutation that drops `priceSource === "MANUAL"`
  // from `typedPriceStandingIn`.
  it("does not warn that an untyped Needs price line stands in for every priced operation", async () => {
    const { invoice } = await needsPriceInvoice();
    expect((await invoiceWarnings(invoice)).join(" ")).not.toMatch(/standing in/);
  });

  // A pin: nothing touched a priced line's account before. Held by the mutation that drops the
  // derivation's `pricePer` test (the line has a price row, so it is no picked step): the first
  // Save would take the code's new account. The second, an account sent, is written as sent, so a
  // mutation that gave the line the derivation's "none" reds it too.
  it("never touches the account of a line with a price row", async () => {
    const { order, stepCode: code } =
      await pricedShippedOrder({ qty: 100, unitPrice: "1.0000", minimumCharge: null, glAccount: null });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(glOf(invoice)).toEqual([[code.id, null, ""]]);
    const gl = await glAccount("4205");
    await prisma.processStepCode.update({ where: { id: code.id }, data: { glAccountId: gl.id } });

    const saved = await save(invoice, typed(invoice, "150.00"));
    expect(operations(saved).map((l) => [l.priceSource, l.pricePer])).toEqual([["MANUAL", "EACH"]]);
    expect(glOf(saved)).toEqual([[code.id, null, ""]]);

    const sent = await glAccount("4208");
    const resaved = await save(saved, typed(saved, "150.00", { glAccountId: sent.id, glAccountName: "4208" }));
    expect(glOf(resaved)).toEqual([[code.id, sent.id, "4208"]]);
  });

  // A pin: nothing touched a credit's account before. Held by the mutation that drops the
  // derivation's INVOICE-only test (the copied line would take the step code's new account).
  it("leaves a credit's copied picked line with the account it was copied with", async () => {
    const { invoice } = await needsPriceInvoice();
    const first = await glAccount("4206");
    const second = await glAccount("4207");
    const codeX = await stepCode("CREDIT-X", "Op X", first.id);
    await save(invoice, typed(invoice, "175.00", {
      processStepCodeId: codeX.id, glAccountId: first.id, glAccountName: "4206" }));
    await finalize(invoice);
    await prisma.processStepCode.update({ where: { id: codeX.id }, data: { glAccountId: second.id } });

    const credit = await asSystem(() => createCredit(invoice.id));
    expect(glOf(credit)).toEqual([[codeX.id, first.id, "4206"]]);
    const saved = await save(credit, credit.lines.map(toLineInput));
    expect(operations(saved).map((l) => [l.pricePer, l.amount])).toEqual([[null, -175]]);
    expect(glOf(saved)).toEqual([[codeX.id, first.id, "4206"]]);
  });

  // Red before the refusal: Finalize issued the invoice.
  it("refuses to finalize a typed price with no step picked, naming the line, and changes nothing", async () => {
    const { order, part, invoice } = await needsPriceInvoice();
    const saved = await save(invoice, typed(invoice, "175.00"));
    expect(operations(saved).map((l) => [l.position, l.description])).toEqual([[2, "Needs price"]]);

    await expect(finalize(saved)).rejects.toMatchObject({
      status: 400,
      message: `Line 2 · ${part.partNumber} — Needs price is a typed price with no step picked — pick its step `
        + "in the description box, then Save lines and Recalculate before finalizing",
    });
    expect(await asSystem(() => getInvoice(invoice.id))).toEqual(saved);
    expect((await getOrder(order.id)).status).toBe("SHIPPED");
    // The draft still warns that the line stands in for every priced operation (Amendment 21).
    expect((await invoiceWarnings(saved)).join(" ")).toMatch(/standing in for every priced operation/);
  });

  // A pin: a $0 line posts nothing, and $0 is real paper (#63). Held by the mutation that drops the
  // refusal's non-zero test.
  it("finalizes a typed $0 price with no step picked", async () => {
    const { order, invoice } = await needsPriceInvoice();
    const saved = await save(invoice, typed(invoice, "0.00"));

    const done = await finalize(saved);
    expect(done.status).toBe("FINALIZED");
    expect(done.total).toBe(0);
    expect((await getOrder(order.id)).status).toBe("INVOICED");
  });

  // Held by the mutation that puts the new refusal before the needs-price one.
  it("names a line that needs a price first, though a typed price with no step picked is there too", async () => {
    const { part, invoice } = await needsPriceInvoice();
    const saved = await save(invoice, [
      ...invoice.lines.map(toLineInput),
      {
        kind: "OPERATION" as const, orderLineId: invoice.lines[0].orderLineId, description: "Age Harden",
        priceSource: "MANUAL" as const, amount: "50.00",
      },
    ]);
    expect(operations(saved).map((l) => [l.position, l.needsPrice, l.priceSource, l.processStepCodeId]))
      .toEqual([[2, true, null, null], [3, false, "MANUAL", null]]);

    await expect(finalize(saved)).rejects.toMatchObject({
      status: 400,
      message: `Line 2 · ${part.partNumber} — Needs price needs a price — price every line before finalizing`,
    });
  });

  // A pin: a credit copies its source's paper and gets no suggestions (Amendment 21). Held by the
  // mutation that drops the refusal's INVOICE-only test. The source is finalized through Prisma
  // (the `finalizedFixture` shape), as Finalize now refuses it.
  it("finalizes a credit holding a typed price with no step picked", async () => {
    const { invoice } = await needsPriceInvoice();
    await save(invoice, typed(invoice, "175.00"));
    await prisma.invoice.update({
      where: { id: invoice.id }, data: { status: "FINALIZED", finalizedAt: new Date() },
    });

    const credit = await asSystem(() => createCredit(invoice.id));
    expect(operations(credit).map((l) => [l.priceSource, l.processStepCodeId, l.amount]))
      .toEqual([["MANUAL", null, -175]]);
    expect((await finalize(credit)).status).toBe("FINALIZED");
  });

  // A pin: nothing refused it before. Held, with the warning beside it, by the mutation that drops
  // the shared helper's step-code test: the refusal and the warning both read that one helper.
  it("finalizes a typed price with a step picked, which the draft does not warn stands in", async () => {
    const { order, invoice } = await needsPriceInvoice();
    const codeX = await stepCode("FIN-X", "Op X");
    const saved = await save(invoice, typed(invoice, "175.00", {
      processStepCodeId: codeX.id, description: "Op X", wordsChosen: true }));
    expect((await invoiceWarnings(saved)).join(" ")).not.toMatch(/standing in for/);

    const done = await finalize(saved);
    expect(done.status).toBe("FINALIZED");
    expect(done.total).toBe(175);
    expect((await getOrder(order.id)).status).toBe("INVOICED");
  });

  // A pin of #586's ruling 586-4 with a picked step: the surcharge's scope reads the step code.
  it("drops a computed surcharge that excludes the step picked, at Save", async () => {
    const codeX = await stepCode("EXCL-X", "Op X");
    const { id } = await asSystem(() => createSurcharge({
      name: "Energy", kind: "PERCENT", rate: "0.040000", position: 1, scope: "EXCLUDE" }));
    await asSystem(() => setSurchargeStepCodes(id, [codeX.id]));
    const { invoice } = await needsPriceInvoice();
    expect(invoice.lines.map((l) => l.kind)).toEqual(["PART", "OPERATION", "SURCHARGE"]);
    const unpicked = await save(invoice, typed(invoice, "175.00"));
    expect(unpicked.surchargeTotal).toBe(7); // the line with no step code is never excluded

    const picked = await save(unpicked, typed(unpicked, "175.00", { processStepCodeId: codeX.id }));
    expect(picked.lines.map((l) => l.kind)).toEqual(["PART", "OPERATION"]);
    expect(picked.total).toBe(175);
  });
});
