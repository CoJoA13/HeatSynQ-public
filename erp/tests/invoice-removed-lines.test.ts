// #594 and #605 (owner rulings 2026-10-21, 2026-11-02 and 2026-11-03). A computed line the operator
// removes from a draft is remembered (`Invoice.removedLines`), Recalculate leaves it out until
// Restore, and Finalize refuses an invoice Recalculate would add a priced step to. Fixtures are
// copied from tests/invoices.test.ts (copying across test files is this repo's convention).
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createOrder, getOrder } from "@/server/orders";
import { createShipper } from "@/server/shippers";
import { addPartPrice } from "@/server/part-prices";
import { createSurcharge } from "@/server/surcharges";
import { setBillingConfig } from "@/server/billing-config";
import {
  createInvoice, getInvoice, replaceInvoiceLines, recalculateInvoice, restoreRemovedLine,
  finalizeInvoice, unlockInvoice, createCredit, type InvoiceDetail, type InvoiceLineDetail,
} from "@/server/invoices";
import { NOT_REMOVED } from "@/lib/invoice-removed-lines";
import { POST as restoreRoute } from "@/app/api/invoices/[id]/restore-line/route";
import type { Customer, Part } from "../prisma/generated/prisma/client";
import { parseDateOnly } from "@/lib/business-days";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let seq = 0;
async function makeCustomer(): Promise<Customer> {
  seq += 1;
  return prisma.customer.create({ data: { code: `RL${seq}`, name: `Removed Lines ${seq}` } });
}
async function makePart(customerId: string): Promise<Part> {
  seq += 1;
  const part = await prisma.part.create({ data: { customerId, partNumber: `HT-${seq}`, eachWeight: "1.0000" } });
  // An order needs the part's process steps (giveSteps in tests/invoices.test.ts).
  const code = await prisma.processStepCode.create({ data: { code: `STEP-${part.id}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
  return part;
}

/** A one-line order shipped in full (status SHIPPED), its part's steps priced as `steps` lists. */
async function shippedOrder(steps: { code: string; unitPrice: string }[], qty = 100) {
  const customer = await makeCustomer();
  const part = await makePart(customer.id);
  const gl = await prisma.glAccount.create({ data: { name: `40${seq}`, description: "Sales" } });
  const codes = [];
  for (const [i, s] of steps.entries()) {
    const code = await prisma.processStepCode.create({ data: { code: s.code, name: s.code, glAccountId: gl.id } });
    codes.push(code);
    await asSystem(() => addPartPrice(part.id, {
      processStepCodeId: code.id, position: i + 1, unitPrice: s.unitPrice, pricePer: "EACH",
    }));
  }
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber: "", lines: [{ partId: part.id, qty, weight: `${qty}.00` }],
  }));
  await asSystem(() => createShipper({
    customerId: customer.id, shipDate: "2026-08-04",
    orders: [{
      orderId: order.id,
      lines: [{ orderLineId: order.lines[0].id, qty, weight: order.lines[0].weight, lineComplete: false }],
      containers: [], serials: [],
    }],
  }, { canOverrideCreditHold: false }));
  return { order: await getOrder(order.id), part, customer, codes, gl };
}

async function taxAtFourPercent(): Promise<void> {
  const taxGl = await prisma.glAccount.create({ data: { name: "2200", description: "Sales tax payable" } });
  await asSystem(() => setBillingConfig({ salesTaxGlAccountId: taxGl.id, salesTaxRate: "0.040000" }));
}
const smallLot = () => asSystem(() => createSurcharge({
  name: "Small Lot Charge", kind: "FLAT", amount: "25.00", position: 1, scope: "ALL",
}));

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
const kinds = (inv: InvoiceDetail) => inv.lines.map((l) => l.kind);
const identities = (inv: InvoiceDetail) => inv.removedLines.map((m) => m.identity);
/** Save the invoice's lines without the ones `drop` picks, as the grid sends a removal. */
const saveWithout = (inv: InvoiceDetail, drop: (l: InvoiceLineDetail) => boolean) =>
  asSystem(() => replaceInvoiceLines(inv.id, inv.lines.filter((l) => !drop(l)).map(toLineInput)));

beforeEach(async () => {
  await truncateAll();
  await seedOrderGatePrereqs();
});

describe("Save lines remembers a removed computed line (#594)", () => {
  it("remembers the Small Lot Charge, and Recalculate leaves it out (the 1005 case)", async () => {
    const surcharge = await smallLot();
    const { order } = await shippedOrder([{ code: "AUST", unitPrice: "1.0000" }]);
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(kinds(invoice)).toEqual(["PART", "OPERATION", "SURCHARGE"]);
    expect(invoice.total).toBe(125);

    const saved = await saveWithout(invoice, (l) => l.kind === "SURCHARGE");
    expect(saved.total).toBe(100);
    expect(saved.removedLines).toEqual([{
      identity: `SURCHARGE:${surcharge.id}`, kind: "SURCHARGE", label: "Small Lot Charge", amount: 25,
      removedAt: expect.any(String),
    }]);

    const recalculated = await asSystem(() => recalculateInvoice(invoice.id));
    expect(kinds(recalculated)).toEqual(["PART", "OPERATION"]);
    expect(recalculated.total).toBe(100);
    // Twice, as the owner pressed it: the second Recalculate leaves it out too.
    const again = await asSystem(() => recalculateInvoice(invoice.id));
    expect(kinds(again)).toEqual(["PART", "OPERATION"]);
    expect(identities(again)).toEqual([`SURCHARGE:${surcharge.id}`]);
  });

  it("remembers an operation, and its percent surcharge has nothing in scope after it", async () => {
    await asSystem(() => createSurcharge({ name: "Energy", kind: "PERCENT", rate: "0.050000", position: 1, scope: "ALL" }));
    const { order, codes } = await shippedOrder([
      { code: "AUST", unitPrice: "1.0000" }, { code: "TEMP", unitPrice: "2.0000" }]);
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.surchargeTotal).toBe(15); // 5% of 100 + 200

    const saved = await saveWithout(invoice, (l) => l.processStepCodeId === codes[1].id);
    expect(identities(saved)).toEqual([`OPERATION:${order.lines[0].id}:${codes[1].id}`]);
    const recalculated = await asSystem(() => recalculateInvoice(invoice.id));
    expect(recalculated.lines.filter((l) => l.kind === "OPERATION").map((l) => l.amount)).toEqual([100]);
    expect(recalculated.surchargeTotal).toBe(5); // the removed step is out of the surcharge's scope
  });

  it("remembers the Sales tax line and a PART line (every kind)", async () => {
    await taxAtFourPercent();
    const { order } = await shippedOrder([{ code: "AUST", unitPrice: "1.0000" }]);
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(kinds(invoice)).toEqual(["PART", "OPERATION", "TAX"]);

    const saved = await saveWithout(invoice, (l) => l.kind === "TAX" || l.kind === "PART");
    expect(identities(saved).sort()).toEqual([`PART:${order.lines[0].id}`, "TAX"].sort());
    const recalculated = await asSystem(() => recalculateInvoice(invoice.id));
    expect(kinds(recalculated)).toEqual(["OPERATION"]);
    expect(recalculated.taxTotal).toBe(0);
    expect(recalculated.lines[0].parentLineId).toBeNull(); // its part row is out, so it prints flat
  });

  it("does not remember a typed row: removing an override still brings the computed line back", async () => {
    const { order } = await shippedOrder([{ code: "AUST", unitPrice: "1.0000" }]);
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) => (l.kind === "OPERATION"
      ? { ...toLineInput(l), amount: "80.00", priceSource: "MANUAL", needsPrice: false } : toLineInput(l)))));
    const overridden = await asSystem(() => recalculateInvoice(invoice.id));
    expect(overridden.total).toBe(80);

    const saved = await saveWithout(overridden, (l) => l.kind === "OPERATION");
    expect(saved.removedLines).toEqual([]);
    const restored = await asSystem(() => recalculateInvoice(invoice.id));
    expect(restored.lines.find((l) => l.kind === "OPERATION")!.amount).toBe(100);
  });

  it("does not remember a computed line kept and changed, nor one a stale grid still carries", async () => {
    const surcharge = await smallLot();
    const { order } = await shippedOrder([{ code: "AUST", unitPrice: "1.0000" }]);
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    // An edited amount keeps the row: no removal.
    const typed = await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) => (l.kind === "SURCHARGE"
      ? { ...toLineInput(l), amount: "0.00", priceSource: "MANUAL", needsPrice: false } : toLineInput(l)))));
    expect(typed.removedLines).toEqual([]);
    // Every row sent under an id the invoice no longer holds (a grid loaded before a save): each is
    // still carried by its identity, so none is a removal.
    const stale = await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) => ({ ...toLineInput(l), key: `old-${l.id}` }))));
    expect(stale.removedLines).toEqual([]);
    expect(stale.lines.some((l) => l.surchargeId === surcharge.id)).toBe(true);
  });

  it("does not remember a Needs price line turned into a picked step", async () => {
    const { order } = await shippedOrder([]);
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    const tier3 = invoice.lines.find((l) => l.kind === "OPERATION")!;
    expect(tier3.processStepCodeId).toBeNull();
    const code = await prisma.processStepCode.create({ data: { code: "PICK", name: "Picked" } });
    const saved = await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) => (l.id === tier3.id
      ? { ...toLineInput(l), processStepCodeId: code.id, description: "Picked", wordsChosen: true,
        amount: "50.00", priceSource: "MANUAL", needsPrice: false }
      : toLineInput(l)))));
    expect(saved.removedLines).toEqual([]);
  });

  it("does not remember a surcharge Save lines drops for an empty scope (#586)", async () => {
    const { order } = await shippedOrder([{ code: "AUST", unitPrice: "1.0000" }]);
    await smallLot();
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    // Removing the operation empties the surcharge's scope, so Save lines drops the surcharge too:
    // only the operation the operator removed is remembered.
    const saved = await saveWithout(invoice, (l) => l.kind === "OPERATION");
    expect(saved.lines.some((l) => l.kind === "SURCHARGE")).toBe(false);
    expect(identities(saved)).toEqual([`OPERATION:${order.lines[0].id}:${invoice.lines[1].processStepCodeId}`]);
  });

  it("keeps the marks through Unlock, and a credit holds none", async () => {
    const surcharge = await smallLot();
    const { order } = await shippedOrder([{ code: "AUST", unitPrice: "1.0000" }]);
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    await saveWithout(invoice, (l) => l.kind === "SURCHARGE");
    await asSystem(() => finalizeInvoice(invoice.id));
    const credit = await asSystem(() => createCredit(invoice.id));
    expect(credit.removedLines).toEqual([]);
    // A credit's Save remembers nothing either: it never recalculates.
    const creditSaved = await saveWithout(credit, (l) => l.kind === "OPERATION");
    expect(creditSaved.lines.some((l) => l.kind === "OPERATION")).toBe(false);
    expect(creditSaved.removedLines).toEqual([]);
    await asSystem(() => prisma.invoice.update({ where: { id: credit.id }, data: { deletedAt: new Date() } }));
    const unlocked = await asSystem(() => unlockInvoice(invoice.id, "fix"));
    expect(identities(unlocked)).toEqual([`SURCHARGE:${surcharge.id}`]);
  });
});

describe("Restore (#594)", () => {
  it("forgets one removal, and the next Recalculate bills it again; a second Restore is refused", async () => {
    const surcharge = await smallLot();
    const { order } = await shippedOrder([{ code: "AUST", unitPrice: "1.0000" }]);
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    await saveWithout(invoice, (l) => l.kind === "SURCHARGE");

    const restored = await asSystem(() => restoreRemovedLine(invoice.id, { identity: `SURCHARGE:${surcharge.id}` }));
    expect(restored.removedLines).toEqual([]);
    expect(kinds(restored)).toEqual(["PART", "OPERATION"]); // nothing re-priced until Recalculate
    const recalculated = await asSystem(() => recalculateInvoice(invoice.id));
    expect(kinds(recalculated)).toEqual(["PART", "OPERATION", "SURCHARGE"]);
    expect(recalculated.total).toBe(125);

    await expect(asSystem(() => restoreRemovedLine(invoice.id, { identity: `SURCHARGE:${surcharge.id}` })))
      .rejects.toThrow(NOT_REMOVED);
  });

  // Owner answer 2026-11-04: Restore all sends every identity the list shows. Mutation: clear only
  // the first identity asked and the operation stays out at Recalculate; drop the held check and
  // the stale list clears the one line it still names.
  it("Restore all forgets every removal it names; a list naming one not held is refused whole", async () => {
    const surcharge = await smallLot();
    const { order } = await shippedOrder([{ code: "AUST", unitPrice: "1.0000" }]);
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    const emptied = await saveWithout(invoice, () => true);
    const held = emptied.removedLines.map((m) => m.identity);
    expect(held.length).toBeGreaterThan(1);
    expect((await asSystem(() => recalculateInvoice(invoice.id))).lines).toEqual([]);

    await expect(asSystem(() => restoreRemovedLine(invoice.id, { identities: [held[0], "TAX:none"] })))
      .rejects.toThrow(NOT_REMOVED);
    expect((await asSystem(() => getInvoice(invoice.id))).removedLines.map((m) => m.identity)).toEqual(held);

    const restored = await asSystem(() => restoreRemovedLine(invoice.id, { identities: held }));
    expect(restored.removedLines).toEqual([]);
    const recalculated = await asSystem(() => recalculateInvoice(invoice.id));
    expect(kinds(recalculated)).toEqual(["PART", "OPERATION", "SURCHARGE"]);
    expect(recalculated.lines.some((l) => l.surchargeId === surcharge.id)).toBe(true);
  });

  it("is refused on a finalized invoice", async () => {
    const surcharge = await smallLot();
    const { order } = await shippedOrder([{ code: "AUST", unitPrice: "1.0000" }]);
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    await saveWithout(invoice, (l) => l.kind === "SURCHARGE");
    await asSystem(() => finalizeInvoice(invoice.id));
    await expect(asSystem(() => restoreRemovedLine(invoice.id, { identity: `SURCHARGE:${surcharge.id}` })))
      .rejects.toThrow(/finalized and locked/);
  });

  it("is gated on invoicing.edit and change_prices", async () => {
    const { order } = await shippedOrder([{ code: "AUST", unitPrice: "1.0000" }]);
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    const res = await restoreRoute(new Request(`http://x/api/invoices/${invoice.id}/restore-line`, {
      method: "POST", body: JSON.stringify({ identity: "TAX" }),
    }) as never, { params: Promise.resolve({ id: invoice.id }) });
    expect(res.status).toBe(401);
  });
});

describe("Finalize refuses while Recalculate would add a priced step (#605)", () => {
  it("refuses the #587 gap: a typed step picked, the part's other step priced since", async () => {
    const { order, part } = await shippedOrder([]);
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    const gl = await prisma.glAccount.create({ data: { name: "4090", description: "Sales" } });
    const harden = await prisma.processStepCode.create({ data: { code: "HARD", name: "Harden", glAccountId: gl.id } });
    const temper = await prisma.processStepCode.create({ data: { code: "TEMP", name: "Temper", glAccountId: gl.id } });
    await asSystem(() => addPartPrice(part.id, { processStepCodeId: harden.id, position: 1, unitPrice: "1.0000", pricePer: "EACH" }));
    await asSystem(() => addPartPrice(part.id, { processStepCodeId: temper.id, position: 2, unitPrice: "2.0000", pricePer: "EACH" }));
    const tier3 = invoice.lines.find((l) => l.kind === "OPERATION")!;
    await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) => (l.id === tier3.id
      ? { ...toLineInput(l), processStepCodeId: harden.id, description: "Harden", wordsChosen: true,
        amount: "90.00", priceSource: "MANUAL", needsPrice: false }
      : toLineInput(l)))));

    await expect(asSystem(() => finalizeInvoice(invoice.id))).rejects.toThrow(
      `Line 1 · ${part.partNumber} has priced steps not on this invoice — Recalculate before finalizing`);
    const recalculated = await asSystem(() => recalculateInvoice(invoice.id));
    expect(recalculated.lines.filter((l) => l.kind === "OPERATION").map((l) => l.amount)).toEqual([90, 200]);
    await expect(asSystem(() => finalizeInvoice(invoice.id))).resolves.toMatchObject({ status: "FINALIZED" });
  });

  it("refuses a step priced since the last Recalculate, and finalizes once that step is removed", async () => {
    const { order, part } = await shippedOrder([{ code: "AUST", unitPrice: "1.0000" }]);
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    const temper = await prisma.processStepCode.create({ data: { code: "TEMP", name: "Temper" } });
    await asSystem(() => addPartPrice(part.id, { processStepCodeId: temper.id, position: 2, unitPrice: "2.0000", pricePer: "EACH" }));
    await expect(asSystem(() => finalizeInvoice(invoice.id))).rejects.toThrow(/Line 1 · HT-\d+ has priced steps not on this invoice/);

    const recalculated = await asSystem(() => recalculateInvoice(invoice.id));
    await saveWithout(recalculated, (l) => l.processStepCodeId === temper.id);
    // The removed step is not a line Recalculate would add, so it does not count.
    await expect(asSystem(() => finalizeInvoice(invoice.id))).resolves.toMatchObject({ status: "FINALIZED" });
  });

  it("counts a quote-linked line by its quote, never by its part's own prices", async () => {
    // The owner's reason for "a line Recalculate would add" over a comparison with the part's price
    // rows (2026-11-02): a quote-linked line is priced from its quote, so a step the part is priced
    // for and the quote is not is no line Recalculate adds. A step the quote gains is one.
    const { order, part, customer, codes } = await shippedOrder([{ code: "AUST", unitPrice: "1.0000" }]);
    const user = await prisma.user.create({ data: { username: "q605", passwordHash: "x", displayName: "Q605" } });
    const quote = await prisma.quote.create({
      data: {
        quoteNumber: 605001, customerId: customer.id, quotedById: user.id,
        quoteDate: parseDateOnly("2026-08-01"), effectiveDate: parseDateOnly("2026-08-01"),
        expiryDate: parseDateOnly("2026-08-31"),
        lines: { create: [{ position: 1, partId: part.id }] },
      },
      include: { lines: true },
    });
    await prisma.quotePrice.create({
      data: { quoteLineId: quote.lines[0].id, processStepCodeId: codes[0].id, position: 1, unitPrice: "0.5000" } });
    await prisma.orderLine.update({ where: { id: order.lines[0].id }, data: { quoteLineId: quote.lines[0].id } });
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    expect(invoice.lines.filter((l) => l.kind === "OPERATION").map((l) => [l.priceSource, l.amount])).toEqual([["QUOTE", 50]]);

    const temper = await prisma.processStepCode.create({ data: { code: "TEMP", name: "Temper" } });
    await asSystem(() => addPartPrice(part.id, { processStepCodeId: temper.id, position: 2, unitPrice: "2.0000", pricePer: "EACH" }));
    const quench = await prisma.processStepCode.create({ data: { code: "QNCH", name: "Quench" } });
    const gained = await prisma.quotePrice.create({
      data: { quoteLineId: quote.lines[0].id, processStepCodeId: quench.id, position: 2, unitPrice: "0.2500" } });
    await expect(asSystem(() => finalizeInvoice(invoice.id))).rejects.toThrow(/has priced steps not on this invoice/);
    await prisma.quotePrice.update({ where: { id: gained.id }, data: { deletedAt: new Date() } });
    await expect(asSystem(() => finalizeInvoice(invoice.id))).resolves.toMatchObject({ status: "FINALIZED" });
  });

  it("does not refuse a price change on a step already billed, nor a credit", async () => {
    const { order, part, codes } = await shippedOrder([{ code: "AUST", unitPrice: "1.0000" }]);
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
    await prisma.partPrice.updateMany({ where: { partId: part.id, processStepCodeId: codes[0].id }, data: { unitPrice: "3.0000" } });
    const finalized = await asSystem(() => finalizeInvoice(invoice.id));
    expect(finalized.total).toBe(100); // finalize re-prices nothing

    const temper = await prisma.processStepCode.create({ data: { code: "TEMP", name: "Temper" } });
    await asSystem(() => addPartPrice(part.id, { processStepCodeId: temper.id, position: 2, unitPrice: "2.0000", pricePer: "EACH" }));
    const credit = await asSystem(() => createCredit(invoice.id));
    await expect(asSystem(() => finalizeInvoice(credit.id))).resolves.toMatchObject({ status: "FINALIZED" });
    expect((await asSystem(() => getInvoice(credit.id))).kind).toBe("CREDIT");
  });
});
