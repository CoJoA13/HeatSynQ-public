import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createOrder, getOrder, type OrderDetail } from "@/server/orders";
import { createShipper } from "@/server/shippers";
import { addPartPrice } from "@/server/part-prices";
import {
  createSurcharge, listSurcharges, setCustomerSurcharge, setSurchargeStepCodes, updateSurcharge,
} from "@/server/surcharges";
import { setSetting } from "@/server/settings";
import {
  createCredit, createInvoice, discardInvoice, finalizeInvoice, replaceInvoiceLines,
  type InvoiceDetail, type InvoiceLineDetail,
} from "@/server/invoices";
import { applyPayment, voidApplication } from "@/server/applications";
import { surchargeOnLines } from "@/server/pricing";
import { parseDateOnly } from "@/lib/business-days";
import type { Customer, Part, Prisma } from "../prisma/generated/prisma/client";

// The read-only listing of invoices whose computed surcharge differs from their lines (#586), run
// on the test database through Prisma. No case starts psql. Every invoice is raised and edited through the services; after #586 those leave no
// stale figure, so where a row must be stale its surcharge line's pre-#586 amount is written back
// with Prisma afterwards (the listing reads lines only, so the invoice's totals are left alone).

const sql = readFileSync(join(process.cwd(), "scripts/surcharge-differs.sql"), "utf8");
const FIRST_LINE = "computed surcharge(s) differ from the invoice's lines (scope and minimum as Admin holds them today)";

/** Runs `run` in a transaction PostgreSQL has been told is read-only. */
const readOnly = <T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    return run(tx);
  });
/** The committed file's whole answer. */
const answer = () => readOnly((tx) => tx.$queryRawUnsafe<{ listing: string }[]>(sql));

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

// -------------------------------------------------------------------------------------------
// Fixtures. `makeCustomer`, `makePart`, `giveSteps`, `savedOrder`, `oneOrderInput`, `shippedOrder`,
// `applyAPayment`, `toLineInput` and `overrideAmount` are copied from tests/invoices.test.ts
// (copying across test files is this repo's convention: a test file imported by another registers
// its suites twice). `pricedOrder` stands in for its `pricedShippedOrder`, which mints a live-unique
// step code and GL account and so runs once per case; this file raises a dozen invoices in one.
// -------------------------------------------------------------------------------------------

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

async function savedOrder(qty: number): Promise<{ order: OrderDetail; part: Part; customer: Customer }> {
  const customer = await makeCustomer();
  const part = await makePart(customer.id);
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber: "", lines: [{ partId: part.id, qty, weight: "3024.00" }],
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

/** An order whose one line ships its full ordered quantity -> status SHIPPED. No pricing, so its
 *  invoice carries the tier-3 Needs price line, which has no step code. */
async function shippedOrder(qty = 144) {
  const { order, part, customer } = await savedOrder(qty);
  await createShipper(oneOrderInput(order), { canOverrideCreditHold: false });
  return { order: await getOrder(order.id), part, customer };
}

/** `shippedOrder` at 100 pieces, priced under `operations` step codes of its own, each $1.00 × 100
 *  with no minimum: one OPERATION line of $100 per step code. */
let codeSeq = 0;
async function pricedOrder(operations = 1) {
  const fixture = await shippedOrder(100);
  const codes = [];
  for (let i = 0; i < operations; i += 1) {
    codeSeq += 1;
    const code = await prisma.processStepCode.create({ data: { code: `OP-${codeSeq}`, name: `Operation ${codeSeq}` } });
    await asSystem(() => addPartPrice(fixture.part.id, {
      processStepCodeId: code.id, position: i + 1, unitPrice: "1.0000", pricePer: "EACH" }));
    codes.push(code);
  }
  return { ...fixture, codes };
}

/** Applies a real PAYMENT against a finalized invoice and returns the application's id. */
let paySeq = 0;
async function applyAPayment(customerId: string, invoiceId: string, amount: number): Promise<string> {
  paySeq += 1;
  const batch = await prisma.receiptBatch.create({
    data: { batchNumber: 720000 + paySeq, depositDate: parseDateOnly("2026-08-08") },
  });
  const paymentType = await prisma.paymentType.create({ data: { name: `PT-listing-${paySeq}` } });
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

/** Maps a stored line back to a `replaceInvoiceLines` payload item. */
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

/** An amount typed on the invoice, the shape the grid sends: MANUAL, no longer needing a price. */
function overrideAmount(l: InvoiceLineDetail, amount: string) {
  return { ...toLineInput(l), amount, priceSource: "MANUAL" as const, needsPrice: false };
}

// -------------------------------------------------------------------------------------------
// The seed's own helpers.
// -------------------------------------------------------------------------------------------

/** Every surcharge made so far in this case. A surcharge lands on every invoice raised after it, so
 *  `invoiceWith` opts each new invoice's customer out of all of them but its own. */
const made: string[] = [];
let surchargePosition = 0;
async function surcharge(name: string, over: Record<string, unknown> = {}): Promise<string> {
  surchargePosition += 1;
  const { id } = await asSystem(() => createSurcharge(percentRow(name, over)));
  made.push(id);
  return id;
}
/** A whole Admin row (`updateSurcharge` takes the whole row: a field left out resets to its
 *  default), 5% on every operation unless `over` says otherwise. */
const rows = new Map<string, Record<string, unknown>>();
function percentRow(name: string, over: Record<string, unknown> = {}) {
  const row = rows.get(name) ?? {
    name, kind: "PERCENT", rate: "0.050000", position: surchargePosition, scope: "ALL", ...over,
  };
  rows.set(name, row);
  return row;
}
/** Changes the named surcharge in Admin, the rest of its row as it was made. */
async function changeSurcharge(id: string, name: string, change: Record<string, unknown>): Promise<void> {
  const row = { ...rows.get(name)!, ...change };
  rows.set(name, row);
  await asSystem(() => updateSurcharge(id, row));
}

async function invoiceWith(fixture: { order: OrderDetail; customer: Customer }, own: string[]): Promise<InvoiceDetail> {
  for (const id of made) {
    if (!own.includes(id)) await asSystem(() => setCustomerSurcharge(fixture.customer.id, id, { optOut: true }));
  }
  const { invoice } = await asSystem(() => createInvoice({ orderId: fixture.order.id }));
  return invoice;
}

const save = (inv: InvoiceDetail, lines: unknown[]) => asSystem(() => replaceInvoiceLines(inv.id, lines));
/** The invoice's lines with every OPERATION typed to `amount`. */
const typedOperations = (inv: InvoiceDetail, amount: string) =>
  inv.lines.map((l) => (l.kind === "OPERATION" ? overrideAmount(l, amount) : toLineInput(l)));
const lineOf = (inv: InvoiceDetail, surchargeId: string) => inv.lines.find((l) => l.surchargeId === surchargeId)!;
/** Writes back the figure a pre-#586 Save lines left on a surcharge line. */
const stale = (line: InvoiceLineDetail, amount: string) =>
  prisma.invoiceLine.update({ where: { id: line.id }, data: { amount } });

/**
 * What Save lines would now make a computed surcharge line, by the engine's own rule: kind, rate
 * and amount from the line, scope and minimum from Admin as it holds them now, over the invoice's
 * stored lines; a flat line keeps its own figure (replaceInvoiceLines' `computedSurcharges`).
 * `removed` when no operation line is in its scope.
 */
async function saveLinesFigure(lineId: string): Promise<string> {
  const line = await prisma.invoiceLine.findUniqueOrThrow({ where: { id: lineId } });
  const admin = (await listSurcharges({ includeInactive: true })).find((s) => s.id === line.surchargeId)!;
  const stored = await prisma.invoiceLine.findMany({ where: { invoiceId: line.invoiceId } });
  const rate = line.rate === null ? null : line.rate.toNumber();
  const figure = surchargeOnLines({
    kind: rate !== null ? "PERCENT" : "FLAT", rate, amount: line.amount.toNumber(),
    minimumAmount: admin.minimumAmount, scope: admin.scope, stepCodeIds: admin.stepCodeIds,
  }, stored.map((l) => ({ kind: l.kind, processStepCodeId: l.processStepCodeId, amount: l.amount.toNumber() })));
  if (figure === null) return "removed";
  return (rate !== null ? figure : line.amount.toNumber()).toFixed(2);
}

/**
 * Raises what an install can hold: computed surcharges left stale by the pre-#586 rule (a typed
 * price, a removed operation line) or by Admin since (a raised minimum, an emptied scope), on
 * drafts and on finalized invoices with money applied and with a voided application, beside rows
 * the listing must leave out (a matching one, a flat one under a minimum raised above it, a credit,
 * a discarded draft, a typed surcharge). Answers the lines the query must give, in its order, with
 * each listed line's id and re-figured figure, and each matching line's id and stored figure.
 */
async function anInstall() {
  const listed: { lineId: string; refigured: string }[] = [];

  // 1. A draft with a typed operation price and two percent surcharges, each still at its figure
  //    over the engine's $100: listed by line position.
  const fiveId = await surcharge("Typed draft 5%");
  const twoId = await surcharge("Typed draft 2%", { rate: "0.020000" });
  const typedDraft = await pricedOrder();
  let inv = await invoiceWith(typedDraft, [fiveId, twoId]);
  inv = await save(inv, typedOperations(inv, "150.00"));
  expect([lineOf(inv, fiveId).amount, lineOf(inv, twoId).amount]).toEqual([7.5, 3]);
  await stale(lineOf(inv, fiveId), "5.00");
  await stale(lineOf(inv, twoId), "2.00");
  listed.push({ lineId: lineOf(inv, fiveId).id, refigured: "7.50" }, { lineId: lineOf(inv, twoId).id, refigured: "3.00" });

  // 2. Finalized, a live payment applied, finalized at 03:00 UTC on 1 August: its month is August
  //    (UTC), though it is still 31 July in the plant's time zone.
  const paidId = await surcharge("Paid");
  const paid = await pricedOrder();
  inv = await invoiceWith(paid, [paidId]);
  inv = await save(inv, typedOperations(inv, "150.00"));
  await asSystem(() => finalizeInvoice(inv.id));
  await applyAPayment(paid.customer.id, inv.id, 50);
  await stale(lineOf(inv, paidId), "5.00");
  await prisma.invoice.update({ where: { id: inv.id }, data: { finalizedAt: new Date("2026-08-01T03:00:00.000Z") } });
  listed.push({ lineId: lineOf(inv, paidId).id, refigured: "7.50" });

  // 3. Finalized, its only application voided.
  const voidedId = await surcharge("Payment voided");
  const voided = await pricedOrder();
  inv = await invoiceWith(voided, [voidedId]);
  inv = await save(inv, typedOperations(inv, "150.00"));
  await asSystem(() => finalizeInvoice(inv.id));
  const applicationId = await applyAPayment(voided.customer.id, inv.id, 50);
  await asSystem(() => voidApplication(applicationId, "keyed to the wrong invoice"));
  await stale(lineOf(inv, voidedId), "5.00");
  await prisma.invoice.update({ where: { id: inv.id }, data: { finalizedAt: new Date("2026-09-15T12:00:00.000Z") } });
  listed.push({ lineId: lineOf(inv, voidedId).id, refigured: "7.50" });

  // 4. All except these, over a typed Needs price line (no step code, so never listed): the 1001 case.
  const unrelated = await prisma.processStepCode.create({ data: { code: "UNREL", name: "Unrelated" } });
  const excludeId = await surcharge("Exclude", { rate: "0.040000", scope: "EXCLUDE" });
  await asSystem(() => setSurchargeStepCodes(excludeId, [unrelated.id]));
  const needsPrice = await shippedOrder();
  inv = await invoiceWith(needsPrice, [excludeId]);
  expect(lineOf(inv, excludeId).amount).toBe(0);
  inv = await save(inv, typedOperations(inv, "175.00"));
  await stale(lineOf(inv, excludeId), "0.00");
  listed.push({ lineId: lineOf(inv, excludeId).id, refigured: "7.00" });

  // 5. A minimum Admin set after the line was figured, which binds: 5% of $100 floored at $10.
  const minimumId = await surcharge("Minimum");
  const minimum = await pricedOrder();
  inv = await invoiceWith(minimum, [minimumId]);
  await changeSurcharge(minimumId, "Minimum", { minimumAmount: "10.00" });
  listed.push({ lineId: lineOf(inv, minimumId).id, refigured: "10.00" });

  // 6. A negative typed price and no minimum: re-figured at zero, never below it.
  const negativeId = await surcharge("Negative");
  const negative = await pricedOrder();
  inv = await invoiceWith(negative, [negativeId]);
  inv = await save(inv, typedOperations(inv, "-50.00"));
  await stale(lineOf(inv, negativeId), "5.00");
  listed.push({ lineId: lineOf(inv, negativeId).id, refigured: "0.00" });

  // 7. A flat amount whose scope Admin has since emptied: Save lines would remove it.
  const flatId = await surcharge("Flat", { kind: "FLAT", rate: null, amount: "25.00" });
  const flat = await pricedOrder();
  inv = await invoiceWith(flat, [flatId]);
  const other = await prisma.processStepCode.create({ data: { code: "OTHER", name: "Other" } });
  await asSystem(() => setSurchargeStepCodes(flatId, [other.id]));
  await changeSurcharge(flatId, "Flat", { scope: "INCLUDE" });
  listed.push({ lineId: lineOf(inv, flatId).id, refigured: "removed" });

  // 8. No typed price: one of two operation lines removed at Save lines, and a charge typed on the
  //    invoice, which is no operation price.
  const removedId = await surcharge("Operation removed");
  const twoOperations = await pricedOrder(2);
  inv = await invoiceWith(twoOperations, [removedId]);
  expect(lineOf(inv, removedId).amount).toBe(10);
  inv = await save(inv, [
    ...inv.lines.filter((l) => l.processStepCodeId !== twoOperations.codes[1].id).map(toLineInput),
    { kind: "CHARGE" as const, description: "Expedite", amount: "50.00", priceSource: "MANUAL" as const },
  ]);
  await stale(lineOf(inv, removedId), "10.00");
  listed.push({ lineId: lineOf(inv, removedId).id, refigured: "5.00" });

  // 9. A surcharge switched off in Admin since: Save lines still re-figures it (ruling Q-B).
  const offId = await surcharge("Switched off");
  const off = await pricedOrder();
  inv = await invoiceWith(off, [offId]);
  inv = await save(inv, typedOperations(inv, "150.00"));
  await stale(lineOf(inv, offId), "5.00");
  await changeSurcharge(offId, "Switched off", { active: false });
  listed.push({ lineId: lineOf(inv, offId).id, refigured: "7.50" });

  // Left out. 10. A typed price whose surcharge already matches it.
  const matchingId = await surcharge("Matching");
  const matching = await pricedOrder();
  inv = await invoiceWith(matching, [matchingId]);
  inv = await save(inv, typedOperations(inv, "150.00"));
  const alreadyMatching = [{ lineId: lineOf(inv, matchingId).id, stored: "7.50" }];

  // 11. A credit: its copied -5.00 would re-figure to 0.00 under the zero floor.
  const creditedId = await surcharge("Credited");
  const credited = await pricedOrder();
  inv = await invoiceWith(credited, [creditedId]);
  await asSystem(() => finalizeInvoice(inv.id));
  const credit = await asSystem(() => createCredit(inv.id));
  expect(lineOf(credit, creditedId)).toMatchObject({ amount: -5, priceSource: null });

  // 12. A discarded draft, left stale.
  const discardedId = await surcharge("Discarded");
  const discarded = await pricedOrder();
  inv = await invoiceWith(discarded, [discardedId]);
  inv = await save(inv, typedOperations(inv, "150.00"));
  await stale(lineOf(inv, discardedId), "5.00");
  await asSystem(() => discardInvoice(inv.id, "raised in error"));

  // 13. A typed surcharge, 9.99 where the rule would give 5.00.
  const typedId = await surcharge("Typed surcharge");
  const typed = await pricedOrder();
  inv = await invoiceWith(typed, [typedId]);
  inv = await save(inv, inv.lines.map((l) => (l.kind === "SURCHARGE" ? overrideAmount(l, "9.99") : toLineInput(l))));
  expect(lineOf(inv, typedId)).toMatchObject({ amount: 9.99, priceSource: "MANUAL" });

  // 14. Only these operations and All except these on one invoice, each judged by its own step codes:
  //     both operations typed (X 150.00, Y 120.00), so each surcharge's base is X's 150.00 alone.
  const onlyXId = await surcharge("Only X", { scope: "INCLUDE" });
  const allButYId = await surcharge("All but Y", { scope: "EXCLUDE" });
  const scoped = await pricedOrder(2);
  const [x, y] = scoped.codes;
  await asSystem(() => setSurchargeStepCodes(onlyXId, [x.id]));
  await asSystem(() => setSurchargeStepCodes(allButYId, [y.id]));
  inv = await invoiceWith(scoped, [onlyXId, allButYId]);
  expect([lineOf(inv, onlyXId).amount, lineOf(inv, allButYId).amount]).toEqual([5, 5]);
  inv = await save(inv, inv.lines.map((l) => {
    if (l.processStepCodeId === x.id) return overrideAmount(l, "150.00");
    return l.processStepCodeId === y.id ? overrideAmount(l, "120.00") : toLineInput(l);
  }));
  expect([lineOf(inv, onlyXId).amount, lineOf(inv, allButYId).amount]).toEqual([7.5, 7.5]);
  await stale(lineOf(inv, onlyXId), "5.00");
  await stale(lineOf(inv, allButYId), "5.00");
  listed.push({ lineId: lineOf(inv, onlyXId).id, refigured: "7.50" }, { lineId: lineOf(inv, allButYId).id, refigured: "7.50" });

  // 15. A half cent: 5% of a typed 100.10 is 5.005, which rounds half away from zero to 5.01.
  const halfId = await surcharge("Half cent");
  const half = await pricedOrder();
  inv = await invoiceWith(half, [halfId]);
  inv = await save(inv, typedOperations(inv, "100.10"));
  expect(lineOf(inv, halfId).amount).toBe(5.01);
  await stale(lineOf(inv, halfId), "5.00");
  listed.push({ lineId: lineOf(inv, halfId).id, refigured: "5.01" });

  // Left out. 16. A flat amount in scope whose minimum Admin has since raised above it: Save lines
  //     keeps a flat line's own figure, so it already matches.
  const flatMinimumId = await surcharge("Flat minimum", { kind: "FLAT", rate: null, amount: "25.00" });
  const flatMinimum = await pricedOrder();
  inv = await invoiceWith(flatMinimum, [flatMinimumId]);
  await changeSurcharge(flatMinimumId, "Flat minimum", { minimumAmount: "30.00" });
  alreadyMatching.push({ lineId: lineOf(inv, flatMinimumId).id, stored: "25.00" });

  const n = (fixture: { order: OrderDetail }) => fixture.order.orderNumber;
  const lines = [
    `${n(typedDraft)} | draft | typed price | no money applied | Typed draft 5% | stored 5.00 | re-figured 7.50`,
    `${n(typedDraft)} | draft | typed price | no money applied | Typed draft 2% | stored 2.00 | re-figured 3.00`,
    `${n(paid)} | finalized 2026-08 | typed price | money applied | Paid | stored 5.00 | re-figured 7.50`,
    `${n(voided)} | finalized 2026-09 | typed price | no money applied | Payment voided | stored 5.00 | re-figured 7.50`,
    `${n(needsPrice)} | draft | typed price | no money applied | Exclude | stored 0.00 | re-figured 7.00`,
    `${n(minimum)} | draft | no typed price | no money applied | Minimum | stored 5.00 | re-figured 10.00`,
    `${n(negative)} | draft | typed price | no money applied | Negative | stored 5.00 | re-figured 0.00`,
    `${n(flat)} | draft | no typed price | no money applied | Flat | stored 25.00 | re-figured: removed`,
    `${n(twoOperations)} | draft | no typed price | no money applied | Operation removed | stored 10.00 | re-figured 5.00`,
    `${n(off)} | draft | typed price | no money applied | Switched off | stored 5.00 | re-figured 7.50`,
    `${n(scoped)} | draft | typed price | no money applied | Only X | stored 5.00 | re-figured 7.50`,
    `${n(scoped)} | draft | typed price | no money applied | All but Y | stored 5.00 | re-figured 7.50`,
    `${n(half)} | draft | typed price | no money applied | Half cent | stored 5.00 | re-figured 5.01`,
  ];
  return { lines, listed, alreadyMatching };
}

/** Every row the listing reads, so a run can be shown to change none. */
async function snapshot() {
  return {
    orders: await prisma.order.findMany({ orderBy: { id: "asc" } }),
    invoices: await prisma.invoice.findMany({ orderBy: { id: "asc" } }),
    lines: await prisma.invoiceLine.findMany({ orderBy: { id: "asc" } }),
    surcharges: await prisma.surcharge.findMany({ orderBy: { id: "asc" } }),
    stepCodes: await prisma.surchargeStepCode.findMany({ orderBy: { id: "asc" } }),
    applications: await prisma.application.findMany({ orderBy: { id: "asc" } }),
    settings: await prisma.setting.findMany({ orderBy: { key: "asc" } }),
  };
}

describe("scripts/surcharge-differs.sql on the test database", () => {
  beforeEach(async () => {
    await truncateAll();
    await seedOrderGatePrereqs();
    made.length = 0;
    rows.clear();
  });

  it("with no computed surcharge that differs, answers the count line alone", async () => {
    expect(await answer()).toEqual([{ listing: `0 ${FIRST_LINE}` }]);
  });

  it("lists every computed surcharge that differs, by order number and line position, and nothing else", async () => {
    const { lines } = await anInstall();
    expect(await answer()).toEqual([{ listing: [`13 ${FIRST_LINE}`, ...lines].join("\n") }]);
  });

  it("re-figures each listed line as the engine's rule does, and leaves out the lines that match it", async () => {
    const { listed, alreadyMatching } = await anInstall();
    for (const { lineId, refigured } of listed) expect(await saveLinesFigure(lineId)).toBe(refigured);
    for (const { lineId, stored } of alreadyMatching) expect(await saveLinesFigure(lineId)).toBe(stored);
  });

  it("numbers each invoice as its paper does: the prefix when set, the bare order number when blank", async () => {
    const id = await surcharge("Typed draft");
    const fixture = await pricedOrder();
    let inv = await invoiceWith(fixture, [id]);
    inv = await save(inv, typedOperations(inv, "150.00"));
    await stale(lineOf(inv, id), "5.00");
    const line = `| draft | typed price | no money applied | Typed draft | stored 5.00 | re-figured 7.50`;

    await setSetting("invoice_number_prefix", "7");
    expect(await answer()).toEqual([{ listing: `1 ${FIRST_LINE}\n7 - ${fixture.order.orderNumber} ${line}` }]);
    await setSetting("invoice_number_prefix", "");
    expect(await answer()).toEqual([{ listing: `1 ${FIRST_LINE}\n${fixture.order.orderNumber} ${line}` }]);
  });

  it("changes no row, run outside any read-only transaction", async () => {
    await anInstall();
    await setSetting("invoice_number_prefix", "7");
    const before = await snapshot();
    await prisma.$queryRawUnsafe(sql);
    expect(await snapshot()).toEqual(before);
  });

  it("the read-only transaction the cases run it in refuses a write", async () => {
    const insert = `INSERT INTO "Setting" ("key", "value", "updatedAt") VALUES ('written', '""', now())`;
    await expect(readOnly((tx) => tx.$executeRawUnsafe(insert))).rejects.toThrow(/read-only transaction|25006/);
  });
});

describe("scripts/surcharge-differs.sql, the file", () => {
  // What PostgreSQL is sent, without its comment lines.
  const statement = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n").trim();

  it("is one statement, a SELECT or a WITH", () => {
    expect(statement).toMatch(/^(SELECT|WITH)\b/);
    expect(statement.replace(/;$/, "")).not.toContain(";");
  });

  it.each([
    "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "DROP", "ALTER", "CREATE", "GRANT", "REVOKE", "COPY", "CALL",
    "DO", "SET", "INTO", "LOCK", "VACUUM", "REFRESH", "REINDEX", "EXECUTE", "NEXTVAL", "SETVAL", "SHARE",
  ])("holds no word that writes: %s", (word) => {
    expect(statement).not.toMatch(new RegExp(`\\b${word}\\b`, "i"));
  });

  // `"Setting"` is not on this list, as it is on stored-negatives.sql's: the listing numbers each
  // invoice as its paper does, so it reads the invoice_number_prefix setting, and only that one
  // (the case below). No secret lives in a setting (SETTINGS, src/server/settings.ts).
  it.each(['"User"', '"Session"', "password"])("names no user or session column: %s", (name) => {
    expect(statement.toLowerCase()).not.toContain(name.toLowerCase());
  });

  it("reads one setting, the invoice number prefix", () => {
    expect(statement.match(/"Setting"/g)).toHaveLength(1);
    expect(statement).toMatch(/FROM "Setting" s\n\s*WHERE s\."key" = 'invoice_number_prefix'\n/);
  });
});
