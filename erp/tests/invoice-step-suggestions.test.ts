import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createOrder, type OrderDetail } from "@/server/orders";
import { createShipper } from "@/server/shippers";
import { createInvoice, discardInvoice, type InvoiceDetail } from "@/server/invoices";
import { invoiceStepSuggestions } from "@/server/invoice-step-suggestions";
import type { Customer, Part, ProcessStepCode } from "../prisma/generated/prisma/client";

// #587 (Amendment 22): the step suggestions an invoice's operation lines offer. The lead order line
// lists the revision its order saved, under its captured names where the saved revision carries a
// numbered recipe (its names as captured at its first lock), as the lead case here does; every other
// line its part's latest revision, under the codes' current names; then every live, active step
// code.

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let seq = 0;
async function makeCustomer(): Promise<Customer> {
  seq += 1;
  return prisma.customer.create({ data: { code: `ISS${seq}`, name: `Suggestions Customer ${seq}` } });
}

async function makePart(customerId: string): Promise<Part> {
  seq += 1;
  return prisma.part.create({ data: { customerId, partNumber: `ISS-${seq}`, eachWeight: "1.0000" } });
}

async function makeCode(
  code: string, name: string, opts: { active?: boolean; deleted?: boolean } = {},
): Promise<ProcessStepCode> {
  return prisma.processStepCode.create({
    data: { code, name, active: opts.active ?? true, deletedAt: opts.deleted ? new Date() : null },
  });
}

/** A revision of the part whose steps carry these codes, in this order. Returns its id. */
async function giveRevision(partId: string, revisionNumber: number, codes: ProcessStepCode[]): Promise<string> {
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber } });
  for (const [i, code] of codes.entries()) {
    await prisma.partProcessStep.create({
      data: { revisionId: rev.id, position: i + 1, codeId: code.id, instruction: `Step ${i + 1}.` },
    });
  }
  return rev.id;
}

/** A recipe number on the revision, so locking it captures a snapshot (`captureRecipeSnapshot`
 *  captures nothing for a revision with no recipe). */
async function giveRecipe(partId: string, revisionId: string, number: string): Promise<void> {
  const recipe = await prisma.partRecipe.create({ data: { partId, number, numberKey: number } });
  await prisma.partProcessRevision.update({ where: { id: revisionId }, data: { recipeId: recipe.id } });
}

async function capturedSnapshot(revisionId: string) {
  return (await prisma.partProcessRevision.findUniqueOrThrow({ where: { id: revisionId } })).recipeSnapshot;
}

/** An order on these parts (the first the lead), every line shipped complete, then its DRAFT
 *  invoice, all through the services. */
async function invoiceFor(customerId: string, parts: Part[]): Promise<{ invoice: InvoiceDetail; order: OrderDetail }> {
  const { order } = await asSystem(() => createOrder({
    customerId, lines: parts.map((p) => ({ partId: p.id, qty: 10, weight: "25.00" })),
  }));
  await asSystem(() => createShipper({
    customerId, shipDate: "2026-08-04",
    orders: [{
      orderId: order.id,
      lines: order.lines.map((l) => ({ orderLineId: l.id, qty: l.qty, weight: l.weight, lineComplete: true })),
      containers: [], serials: [],
    }],
  }, { canOverrideCreditHold: false }));
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  return { invoice, order };
}

const suggestion = (c: ProcessStepCode, name = c.name) => ({ id: c.id, code: c.code, name });

describe("invoiceStepSuggestions (#587)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("lists the lead line's saved revision, captured under its numbered recipe: a later revision and a rename change nothing", async () => {
    const customer = await makeCustomer();
    const lead = await makePart(customer.id);
    const quench = await makeCode("QN", "Quench");
    const temper = await makeCode("TM", "Temper");
    const saved = await giveRevision(lead.id, 1, [quench, temper]);
    await giveRecipe(lead.id, saved, "R-ISS-1");
    const { invoice, order } = await invoiceFor(customer.id, [lead]);
    expect(await capturedSnapshot(saved)).not.toBeNull(); // the order's save locked and captured it

    // After the order saved revision 1: the part gains a revision 2 with another step, and one of
    // the saved steps' codes is renamed.
    const nitride = await makeCode("NT", "Nitride");
    await giveRevision(lead.id, 2, [nitride]);
    await prisma.processStepCode.update({ where: { id: quench.id }, data: { name: "Oil quench" } });

    const { byOrderLine } = await invoiceStepSuggestions(invoice.id);
    expect(byOrderLine).toEqual({ [order.lines[0].id]: [suggestion(quench, "Quench"), suggestion(temper)] });
  });

  it("lists a rider line's part's latest revision, under the codes' current names", async () => {
    const customer = await makeCustomer();
    const lead = await makePart(customer.id);
    const rider = await makePart(customer.id);
    const quench = await makeCode("QN", "Quench");
    const anneal = await makeCode("AN", "Anneal");
    const temper = await makeCode("TM", "Temper");
    const nitride = await makeCode("NT", "Nitride");
    await giveRevision(lead.id, 1, [quench]);
    await giveRevision(rider.id, 1, [anneal]);
    const latest = await giveRevision(rider.id, 2, [temper, nitride]);
    await giveRecipe(rider.id, latest, "R-ISS-2");
    // An order that leads with the rider's part locks its revision 2 and captures "Temper".
    await asSystem(() => createOrder({ customerId: customer.id, lines: [{ partId: rider.id, qty: 1, weight: "1.00" }] }));
    expect(await capturedSnapshot(latest)).not.toBeNull();
    const { invoice, order } = await invoiceFor(customer.id, [lead, rider]);
    await prisma.processStepCode.update({ where: { id: temper.id }, data: { name: "Double temper" } });

    const { byOrderLine } = await invoiceStepSuggestions(invoice.id);
    expect(byOrderLine).toEqual({
      [order.lines[0].id]: [suggestion(quench)],
      [order.lines[1].id]: [suggestion(temper, "Double temper"), suggestion(nitride)],
    });
  });

  it("lists none for a line whose part has no revision", async () => {
    const customer = await makeCustomer();
    const lead = await makePart(customer.id);
    const rider = await makePart(customer.id); // no revision at all
    const quench = await makeCode("QN", "Quench");
    await giveRevision(lead.id, 1, [quench]);
    const { invoice, order } = await invoiceFor(customer.id, [lead, rider]);

    const { byOrderLine } = await invoiceStepSuggestions(invoice.id);
    expect(byOrderLine).toEqual({ [order.lines[0].id]: [suggestion(quench)], [order.lines[1].id]: [] });
  });

  it("names a step code repeated in a revision once, where it first appears", async () => {
    const customer = await makeCustomer();
    const lead = await makePart(customer.id);
    const rider = await makePart(customer.id);
    const quench = await makeCode("QN", "Quench");
    const temper = await makeCode("TM", "Temper");
    const anneal = await makeCode("AN", "Anneal");
    await giveRevision(lead.id, 1, [quench, temper, quench]);
    await giveRevision(rider.id, 1, [temper, temper, anneal]);
    const { invoice, order } = await invoiceFor(customer.id, [lead, rider]);

    const { byOrderLine } = await invoiceStepSuggestions(invoice.id);
    expect(byOrderLine).toEqual({
      [order.lines[0].id]: [suggestion(quench), suggestion(temper)],
      [order.lines[1].id]: [suggestion(temper), suggestion(anneal)],
    });
  });

  it("offers every live, active step code as others, ordered by code", async () => {
    const zinc = await makeCode("ZZ", "Zinc plate");
    const anneal = await makeCode("AA", "Anneal");
    await makeCode("BB", "Retired", { active: false });
    await makeCode("CC", "Deleted", { deleted: true });
    const customer = await makeCustomer();
    const lead = await makePart(customer.id);
    const quench = await makeCode("QN", "Quench");
    await giveRevision(lead.id, 1, [quench]);
    const { invoice } = await invoiceFor(customer.id, [lead]);

    const { others } = await invoiceStepSuggestions(invoice.id);
    // The line's own step is in the list too: the page leaves it out, not the server.
    expect(others).toEqual([suggestion(anneal), suggestion(quench), suggestion(zinc)]);
  });

  it("still answers once the order's parts are deleted (no part-liveness gate)", async () => {
    const customer = await makeCustomer();
    const lead = await makePart(customer.id);
    const rider = await makePart(customer.id);
    const quench = await makeCode("QN", "Quench");
    const temper = await makeCode("TM", "Temper");
    await giveRevision(lead.id, 1, [quench]);
    await giveRevision(rider.id, 1, [temper]);
    const { invoice, order } = await invoiceFor(customer.id, [lead, rider]);
    await prisma.part.updateMany({ where: { id: { in: [lead.id, rider.id] } }, data: { deletedAt: new Date() } });

    const { byOrderLine } = await invoiceStepSuggestions(invoice.id);
    expect(byOrderLine).toEqual({
      [order.lines[0].id]: [suggestion(quench)],
      [order.lines[1].id]: [suggestion(temper)],
    });
  });

  it("answers 404 for an invoice that does not exist or was discarded", async () => {
    await expect(invoiceStepSuggestions("nope")).rejects.toMatchObject({ status: 404, message: "Invoice not found" });

    const customer = await makeCustomer();
    const lead = await makePart(customer.id);
    await giveRevision(lead.id, 1, [await makeCode("QN", "Quench")]);
    const { invoice } = await invoiceFor(customer.id, [lead]);
    await expect(invoiceStepSuggestions(invoice.id)).resolves.toBeDefined();
    await asSystem(() => discardInvoice(invoice.id, "discarded for the test"));
    await expect(invoiceStepSuggestions(invoice.id))
      .rejects.toMatchObject({ status: 404, message: "Invoice not found" });
  });
});
