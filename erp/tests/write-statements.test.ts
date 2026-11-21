// What the child-row writers send to the database (#712 step 1): the baseline the set-based
// rewrites of #623, #624, #625 and #626 are measured against.
//
// Counted from Prisma's own query log, the `order-read-statements` harness's shape: the log is
// switched on when a client is constructed, so this file swaps the shared client for one built with
// it on, at the same database. A write is matched by its verb and its table, schema-qualified or
// not, so a hand-written `UPDATE "Load"` counts as surely as the client's `UPDATE "public"."Load"`.
//
// Each case pins the statements on the tables its rewrite is about, as `{ "VERB Table": n }`. A
// rewrite that lands moves its own case's figures, and nothing else's.
//
// Measured on 2026-11-05 (Prisma 7.10.1, pg driver adapter), the baseline these pins hold:
// - A nested `create: [...]` is already ONE multi-row INSERT per parent row and child table, as
//   `gl-export-statements` found for the postings. So `createOrder`'s lines, containers, loads,
//   charges and serials are one INSERT each, and a shipment's lines, containers and serials one
//   INSERT per order. `createMany` would send the same: #623 step 1 and #626 step 1 have nothing to
//   remove. Only the parent tier is per row (one `ShipperOrder` INSERT per order), because each
//   child INSERT needs its parent's id.
// - What was per row: `applyLoads`' park and rewrite (two UPDATEs per load, #623), each invoice
//   writer's `parentLineId` pass (one UPDATE per operation line, #624), the cert seeders'
//   reference checks and INSERTs (#625), and the shipment's per-order sequence aggregate and the
//   ticket print's per-order cert read (#626). A case whose rewrite has landed says so beside its
//   figures, with what it was.
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
import { measured } from "./helpers/measured";
import { runWithContext } from "@/server/context";
import { createOrder, addLine, type OrderDetail } from "@/server/orders";
import { replaceLoads } from "@/server/order-loads";
import { MAX_LOADS } from "@/lib/load-split";
import { createShipper, reverseShipper, printShippingTickets } from "@/server/shippers";
import { addPartPrice } from "@/server/part-prices";
import { addPartInspection } from "@/server/part-inspections";
import { createCert } from "@/server/certs";
import {
  createInvoice, replaceInvoiceLines, recalculateInvoice, finalizeInvoice, createCredit,
  type InvoiceLineDetail,
} from "@/server/invoices";
import { invoiceStepSuggestions } from "@/server/invoice-step-suggestions";
import { addAttachment, deleteAttachment } from "@/server/attachments";
import { setSignature, updateUser } from "@/server/users";
import type { Customer } from "../prisma/generated/prisma/client";
import { addDays, todayDateOnly } from "@/lib/business-days";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

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

/** A statement's verb and table, as `"INSERT Load"`. A SELECT names the first table its FROM does,
 *  an aggregate over one (`SELECT MAX(…) FROM (SELECT … FROM "T" …)`) reads `"AGGREGATE T"`, and
 *  a grouped one (`… GROUP BY …`) `"GROUPBY T"`. */
export function verbAndTable(statement: string): string | undefined {
  const name = String.raw`(?:"public"\.)?"(\w+)"`;
  const write = new RegExp(String.raw`^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+${name}`, "i").exec(statement);
  if (write) return `${statement.trim().split(/\s+/)[0].toUpperCase()} ${write[1]}`;
  const select = new RegExp(String.raw`^\s*SELECT\b[\s\S]*?\bFROM\s+${name}`, "i").exec(statement);
  if (!select) return undefined;
  if (/\bGROUP\s+BY\b/i.test(statement)) return `GROUPBY ${select[1]}`;
  return /^\s*SELECT\s+(?:MAX|MIN|SUM|COUNT|AVG)\(/i.test(statement) ? `AGGREGATE ${select[1]}` : `SELECT ${select[1]}`;
}

/** How many statements of each `"VERB Table"` the run sent, kept to the ones named. */
function counts(statements: string[], keys: string[]): Record<string, number> {
  const out = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const s of statements) {
    const k = verbAndTable(s);
    if (k !== undefined && k in out) out[k] += 1;
  }
  return out;
}

describe("the matcher", () => {
  it("reads the client's schema-qualified statements and a hand-written unqualified one alike", () => {
    expect(verbAndTable('INSERT INTO "public"."Load" ("id") VALUES ($1)')).toBe("INSERT Load");
    expect(verbAndTable('UPDATE "public"."Load" SET "loadNumber" = $1 WHERE "id" = $2')).toBe("UPDATE Load");
    expect(verbAndTable('UPDATE "Load" AS l SET "qty" = v.qty FROM unnest($1::text[]) v')).toBe("UPDATE Load");
    expect(verbAndTable('DELETE FROM "public"."Load" WHERE "orderId" = $1')).toBe("DELETE Load");
    expect(verbAndTable('SELECT "public"."Load"."id" FROM "public"."Load" WHERE 1=1')).toBe("SELECT Load");
    expect(verbAndTable('SELECT MAX("sequence") AS "_max$sequence" FROM (SELECT "public"."ShipperOrder"."sequence" FROM "public"."ShipperOrder" WHERE 1=1) AS "sub"'))
      .toBe("AGGREGATE ShipperOrder");
    expect(verbAndTable('SELECT "public"."ShipperOrder"."orderId", MAX("public"."ShipperOrder"."sequence") FROM "public"."ShipperOrder" WHERE 1=1 GROUP BY "public"."ShipperOrder"."orderId"'))
      .toBe("GROUPBY ShipperOrder");
    expect(verbAndTable("BEGIN")).toBeUndefined();
  });
});

let seq = 0;
async function stepCode(glAccountId?: string) {
  seq += 1;
  return prisma.processStepCode.create({ data: { code: `WS-${seq}`, name: `Step ${seq}`, glAccountId } });
}

/** A part with revision 1 of `steps` steps, each priced when `priced`. */
async function part(customer: Customer, opts: { steps?: number; priced?: boolean; loadQty?: number } = {}) {
  seq += 1;
  const gl = await prisma.glAccount.create({ data: { name: `4${seq}`, description: "Sales" } });
  const p = await prisma.part.create({
    data: { customerId: customer.id, partNumber: `WS-P${seq}`, name: `Part ${seq}`, eachWeight: "1.0000", loadQty: opts.loadQty ?? null },
  });
  const rev = await prisma.partProcessRevision.create({ data: { partId: p.id, revisionNumber: 1 } });
  for (let i = 1; i <= (opts.steps ?? 1); i++) {
    const code = await stepCode(gl.id);
    await prisma.partProcessStep.create({ data: { revisionId: rev.id, position: i, codeId: code.id, instruction: "Run." } });
    if (opts.priced) {
      await asSystem(() => addPartPrice(p.id, {
        processStepCodeId: code.id, position: i, unitPrice: "6.5100", minimumCharge: "0.00", pricePer: "EACH",
      }));
    }
  }
  return p;
}

let customer: Customer;
beforeEach(async () => {
  await truncateAll();
  await seedOrderGatePrereqs();
  customer = await prisma.customer.create({ data: { code: "WS", name: "Write Statements Customer" } });
});

describe("createOrder's children (#623 step 1)", () => {
  it("a new order with 3 lines, 4 container rows, 5 loads, 3 charges and 6 serials", async () => {
    // The lead's load quantity splits its 10 pieces into 5 loads.
    const lead = await part(customer, { loadQty: 2 });
    const riders = [await part(customer), await part(customer)];
    const basket = await prisma.containerType.create({ data: { name: "Basket" } });
    const statements = await statementsOf(() => asSystem(() => createOrder({
      customerId: customer.id,
      lines: [lead, ...riders].map((p, i) => ({
        partId: p.id, qty: 10, weight: "5.00",
        serials: [{ serial: `S${i}A` }, { serial: `S${i}B` }],
      })),
      containers: [1, 2, 3, 4].map(() => ({ typeId: basket.id, count: 1 })),
      charges: [1, 2, 3].map((i) => ({ description: `Charge ${i}`, amount: "1.00" })),
    })));
    const figures = counts(statements, [
      "INSERT OrderLine", "INSERT OrderContainer", "INSERT Load", "INSERT OrderCharge", "INSERT OrderSerial",
    ]);
    measured("createOrder", figures);
    expect(figures).toEqual({
      "INSERT OrderLine": 1, "INSERT OrderContainer": 1, "INSERT Load": 1, "INSERT OrderCharge": 1, "INSERT OrderSerial": 1,
    });
  });
});

describe("replaceLoads (#623 step 2)", () => {
  it("renumbers 100 loads in place", async () => {
    const lead = await part(customer, { loadQty: 2 });
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 200, weight: "100.00" }],
    }));
    expect(order.loads).toHaveLength(100);
    const statements = await statementsOf(() => asSystem(() => replaceLoads(
      order.id, Array.from({ length: 100 }, (_, i) => ({ loadNumber: i + 1, qty: i < 50 ? 3 : 1, weight: "1.00" })),
    )));
    const figures = counts(statements, ["UPDATE Load", "INSERT Load", "DELETE Load"]);
    measured("replaceLoads 100", figures);
    // The park and the rewrite, one statement each (#623); it was two UPDATEs per load, 200.
    expect(figures).toEqual({ "UPDATE Load": 2, "INSERT Load": 0, "DELETE Load": 0 });
  });

  it("grows 100 loads to 150 and shrinks them to 40, a statement for each kind of change", async () => {
    const lead = await part(customer, { loadQty: 2 });
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 200, weight: "100.00" }],
    }));
    const set = (n: number) => Array.from({ length: n }, (_, i) => ({ loadNumber: i + 1, qty: 1, weight: "1.00" }));
    const grow = await statementsOf(() => asSystem(() => replaceLoads(order.id, set(150))));
    expect(counts(grow, ["UPDATE Load", "INSERT Load", "DELETE Load"])).toEqual({ "UPDATE Load": 2, "INSERT Load": 1, "DELETE Load": 0 });
    const shrink = await statementsOf(() => asSystem(() => replaceLoads(order.id, set(40))));
    expect(counts(shrink, ["UPDATE Load", "INSERT Load", "DELETE Load"])).toEqual({ "UPDATE Load": 2, "INSERT Load": 0, "DELETE Load": 1 });
    expect(await prisma.load.count({ where: { orderId: order.id } })).toBe(40);
  });

  it("renumbers MAX_LOADS loads in the same statements", async () => {
    const lead = await part(customer, { loadQty: 1 });
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: MAX_LOADS, weight: "100.00" }],
    }));
    expect(order.loads).toHaveLength(MAX_LOADS);
    const reversed = Array.from({ length: MAX_LOADS }, (_, i) => ({ loadNumber: MAX_LOADS - i, qty: 1, weight: "0.01" }));
    const started = Date.now();
    const statements = await statementsOf(() => asSystem(() => replaceLoads(order.id, reversed)));
    measured("replaceLoads MAX_LOADS ms", Date.now() - started);
    expect(counts(statements, ["UPDATE Load", "INSERT Load", "DELETE Load"])).toEqual({ "UPDATE Load": 2, "INSERT Load": 0, "DELETE Load": 0 });
  }, 60_000);
});

/** Two lines with two serials each, two container rows: an order a shipment can carry all of. */
async function shippableOrder(): Promise<OrderDetail> {
  const lead = await part(customer);
  const rider = await part(customer);
  const basket = await prisma.containerType.create({ data: { name: `Basket ${++seq}` } });
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id,
    lines: [lead, rider].map((p, i) => ({
      partId: p.id, qty: 10, weight: "5.00", serials: [{ serial: `X${seq}-${i}A` }, { serial: `X${seq}-${i}B` }],
    })),
    containers: [{ typeId: basket.id, count: 1 }, { typeId: basket.id, count: 2 }],
  }));
  return order;
}

const shipAll = (o: OrderDetail) => ({
  orderId: o.id,
  lines: o.lines.map((l) => ({ orderLineId: l.id, qty: 10, weight: "5.00", lineComplete: false })),
  containers: o.containers.map((c) => ({ orderContainerId: c.id, count: c.count })),
  serials: o.serials.map((s) => ({ orderSerialId: s.id })),
});

const SHIPMENT_KEYS = [
  "INSERT ShipperOrder", "INSERT ShipperLine", "INSERT ShipperContainer", "INSERT ShipperSerial", "AGGREGATE ShipperOrder",
  "GROUPBY ShipperOrder",
];

describe("saveNewShipper and reverseShipperInTx (#626 steps 1 and 2)", () => {
  it("a shipment of three orders, each with 2 lines, 2 container rows and 4 serials", async () => {
    const orders = [await shippableOrder(), await shippableOrder(), await shippableOrder()];
    const statements = await statementsOf(() => createShipper({
      customerId: customer.id, shipDate: "2026-08-04", orders: orders.map(shipAll),
    }, { canOverrideCreditHold: false }));
    const figures = counts(statements, SHIPMENT_KEYS);
    measured("saveNewShipper 3 orders", figures);
    expect(figures).toEqual({
      "INSERT ShipperOrder": 3, "INSERT ShipperLine": 3, "INSERT ShipperContainer": 3, "INSERT ShipperSerial": 3,
      // The three orders' sequences in one `groupBy` (#626); it was one aggregate per order.
      "AGGREGATE ShipperOrder": 0, "GROUPBY ShipperOrder": 1,
    });
  });

  it("its reversal", async () => {
    const orders = [await shippableOrder(), await shippableOrder(), await shippableOrder()];
    const { shipper } = await createShipper({
      customerId: customer.id, shipDate: "2026-08-04", orders: orders.map(shipAll),
    }, { canOverrideCreditHold: false });
    const statements = await statementsOf(() => asSystem(() => reverseShipper(shipper.id, { reason: "Returned" })));
    const figures = counts(statements, SHIPMENT_KEYS);
    measured("reverseShipper 3 orders", figures);
    expect(figures).toEqual({
      "INSERT ShipperOrder": 3, "INSERT ShipperLine": 3, "INSERT ShipperContainer": 0, "INSERT ShipperSerial": 0,
      "AGGREGATE ShipperOrder": 0, "GROUPBY ShipperOrder": 1,
    });
  });
});

describe("resolveShipmentCerts (#626 step 3)", () => {
  it("a whole-shipment print with certifications, three orders on it", async () => {
    const orders = [await shippableOrder(), await shippableOrder(), await shippableOrder()];
    for (const o of orders) await prisma.order.update({ where: { id: o.id }, data: { certRequired: true, certScope: "ORDER" } });
    const { shipper } = await createShipper({
      customerId: customer.id, shipDate: "2026-08-04", orders: orders.map(shipAll),
    }, { canOverrideCreditHold: false });
    for (const o of orders) await asSystem(() => createCert({ orderId: o.id, scope: "ORDER" }));
    const statements = await statementsOf(() => asSystem(() => printShippingTickets(shipper.id, undefined, { withCerts: true })));
    const figures = counts(statements, ["SELECT Cert"]);
    measured("printShippingTickets withCerts 3 orders", figures);
    // One read for the three orders (#626); it was one per order.
    expect(figures).toEqual({ "SELECT Cert": 1 });
  });
});

/** Maps a stored line back to a `replaceInvoiceLines` payload item, `invoices.test.ts`'s shape. */
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

/** A shipped order of 4 lines, each part priced on 3 steps: 12 operation lines under 4 part lines. */
async function shippedForInvoice(): Promise<string> {
  const parts = [await part(customer, { steps: 3, priced: true })];
  for (let i = 0; i < 3; i++) parts.push(await part(customer, { steps: 3, priced: true }));
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, lines: parts.map((p) => ({ partId: p.id, qty: 10, weight: "5.00" })),
  }));
  await createShipper({
    customerId: customer.id, shipDate: "2026-08-04",
    orders: [{ orderId: order.id, lines: order.lines.map((l) => ({ orderLineId: l.id, qty: 10, weight: "5.00", lineComplete: false })) }],
  }, { canOverrideCreditHold: false });
  return order.id;
}

const INVOICE_KEYS = ["INSERT InvoiceLine", "UPDATE InvoiceLine"];

describe("the invoice line writers (#624)", () => {
  it("createInvoice, replaceInvoiceLines, recalculateInvoice and createCredit on 12 operation lines", async () => {
    const orderId = await shippedForInvoice();
    let invoiceId = "";
    const create = await statementsOf(() => asSystem(async () => {
      invoiceId = (await createInvoice({ orderId })).invoice.id;
    }));
    const stored = await prisma.invoiceLine.findMany({ where: { invoiceId }, orderBy: { position: "asc" } });
    expect(stored.filter((l) => l.kind === "OPERATION")).toHaveLength(12);
    const detail = (await asSystem(() => recalculateInvoice(invoiceId))).lines;
    const save = await statementsOf(() => asSystem(() => replaceInvoiceLines(invoiceId, detail.map(toLineInput))));
    const recalc = await statementsOf(() => asSystem(() => recalculateInvoice(invoiceId)));
    await asSystem(() => finalizeInvoice(invoiceId));
    const credit = await statementsOf(() => asSystem(() => createCredit(invoiceId)));
    const figures = {
      create: counts(create, INVOICE_KEYS), save: counts(save, INVOICE_KEYS),
      recalc: counts(recalc, INVOICE_KEYS), credit: counts(credit, INVOICE_KEYS),
    };
    measured("invoice writers", figures);
    // One INSERT each, carrying the parents (#624); each writer sent 12 `parentLineId` UPDATEs.
    expect(figures).toEqual({
      create: { "INSERT InvoiceLine": 1, "UPDATE InvoiceLine": 0 },
      save: { "INSERT InvoiceLine": 1, "UPDATE InvoiceLine": 0 },
      recalc: { "INSERT InvoiceLine": 1, "UPDATE InvoiceLine": 0 },
      credit: { "INSERT InvoiceLine": 1, "UPDATE InvoiceLine": 0 },
    });
    // And the parents are there: every operation line, on the invoice and on its credit, sits under
    // a part line of its own invoice.
    for (const id of [invoiceId, (await prisma.invoice.findFirstOrThrow({ where: { sourceInvoiceId: invoiceId } })).id]) {
      const lines = await prisma.invoiceLine.findMany({ where: { invoiceId: id } });
      const parts = new Set(lines.filter((l) => l.kind === "PART").map((l) => l.id));
      const operations = lines.filter((l) => l.kind === "OPERATION");
      expect(operations).toHaveLength(12);
      expect(operations.every((l) => l.parentLineId !== null && parts.has(l.parentLineId))).toBe(true);
    }
  });
});

/** A part carrying `n` inspections, each on its own code and a shared scale. */
async function inspectedPart(n: number, scaleId: string, steps = 0) {
  const p = steps ? await part(customer, { steps }) : await prisma.part.create({
    data: { customerId: customer.id, partNumber: `WS-I${++seq}`, eachWeight: "1.0000" },
  });
  for (let i = 0; i < n; i++) {
    const code = await prisma.inspectionCode.create({ data: { name: `Hardness ${++seq}` } });
    await asSystem(() => addPartInspection(p.id, { inspectionCodeId: code.id, scaleId, sort: i }));
  }
  return p;
}

/** The cert seeders' figures: requirement INSERTs, and `assertRefExists`' own reads (a `findFirst`
 *  on a live row: `… "deletedAt" IS NULL) LIMIT`), counted apart from the reads around them. */
function certFigures(statements: string[]) {
  const guard = (t: string) => statements.filter((x) =>
    verbAndTable(x) === `SELECT ${t}` && new RegExp(String.raw`"${t}"\."deletedAt" IS NULL\) LIMIT`).test(x)).length;
  return {
    ...counts(statements, ["INSERT CertRequirement"]),
    "guard InspectionCode": guard("InspectionCode"), "guard InspectionScale": guard("InspectionScale"),
  };
}

describe("seedRequirements and seedLineIntoLiveCerts (#625)", () => {
  it("a cert on 5 lines of one part with 4 inspections: 20 requirements", async () => {
    const scale = await prisma.inspectionScale.create({ data: { name: "HRC" } });
    const p = await inspectedPart(4, scale.id, 1);
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [1, 2, 3, 4, 5].map(() => ({ partId: p.id, qty: 1, weight: "1.00" })),
    }));
    const statements = await statementsOf(() => asSystem(() => createCert({ orderId: order.id, scope: "ORDER" })));
    const figures = certFigures(statements);
    measured("seedRequirements 20", figures);
    // One INSERT, and each of the 4 distinct codes and the 1 scale checked once (#625); it was 20
    // INSERTs and 20 checks of each.
    expect(figures).toEqual({ "INSERT CertRequirement": 1, "guard InspectionCode": 4, "guard InspectionScale": 1 });
  });

  it("a line added to an order with two live certs, its part carrying 4 inspections", async () => {
    const scale = await prisma.inspectionScale.create({ data: { name: "HRB" } });
    const lead = await part(customer, { loadQty: 1 });
    const rider = await inspectedPart(4, scale.id);
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 2, weight: "1.00" }],
    }));
    expect(order.loads).toHaveLength(2);
    await asSystem(() => createCert({ orderId: order.id, scope: "LOAD", loadNumber: 1 }));
    await asSystem(() => createCert({ orderId: order.id, scope: "LOAD", loadNumber: 2 }));
    const statements = await statementsOf(() => asSystem(() => addLine(order.id, { partId: rider.id, qty: 1, weight: "1.00" })));
    const figures = certFigures(statements);
    measured("seedLineIntoLiveCerts 2 certs x 4", figures);
    // One INSERT per cert, and the checks once for both (#625); it was 8 INSERTs and 8 checks of each.
    expect(figures).toEqual({ "INSERT CertRequirement": 2, "guard InspectionCode": 4, "guard InspectionScale": 1 });
  });
});

/** A shipped order for the pricing reads: a lead of its own part, three unlinked riders on two
 *  parts (two lines share one), and two riders linked to two lines of one quote. Each priced line
 *  bills 2 operations: 12 operation lines. */
async function shippedForPricing(): Promise<string> {
  const lead = await part(customer, { steps: 2, priced: true });
  const shared = await part(customer, { steps: 2, priced: true });
  const other = await part(customer, { steps: 2, priced: true });
  const quoted = [await part(customer, { steps: 2 }), await part(customer, { steps: 2 })];
  const parts = [lead, shared, shared, other, ...quoted];
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, lines: parts.map((p) => ({ partId: p.id, qty: 10, weight: "5.00" })),
  }));
  // The quote is written after the order, and each link set by hand: the fixture decides which lines
  // are linked, not the order save's auto-link.
  const user = await prisma.user.create({ data: { username: "ws-quoter", passwordHash: "x", displayName: "Quoter" } });
  const today = todayDateOnly();
  const quote = await prisma.quote.create({
    data: {
      quoteNumber: 1006, customerId: customer.id, quotedById: user.id,
      quoteDate: today, effectiveDate: addDays(today, -5), expiryDate: addDays(today, 30),
      lines: { create: quoted.map((p, i) => ({ position: i + 1, partId: p.id })) },
    },
    include: { lines: { orderBy: { position: "asc" } } },
  });
  for (const [i, quoteLine] of quote.lines.entries()) {
    for (const position of [1, 2]) {
      const code = await stepCode();
      await prisma.quotePrice.create({ data: {
        quoteLineId: quoteLine.id, processStepCodeId: code.id, position, unitPrice: "7.2500", pricePer: "EACH",
        breaks: { create: [{ threshold: "5", price: "7.0000" }] },
      } });
    }
    await prisma.orderLine.update({ where: { id: order.lines[4 + i].id }, data: { quoteLineId: quoteLine.id } });
  }
  await createShipper({
    customerId: customer.id, shipDate: "2026-08-04",
    orders: [{ orderId: order.id, lines: order.lines.map((l) => ({ orderLineId: l.id, qty: 10, weight: "5.00", lineComplete: false })) }],
  }, { canOverrideCreditHold: false });
  return order.id;
}

const PRICING_KEYS = [
  "SELECT PartPrice", "SELECT PartPriceBreak", "SELECT QuoteLine", "SELECT Quote", "SELECT QuotePrice", "SELECT QuotePriceBreak",
];

describe("the pricing reads (#622)", () => {
  it("createInvoice and recalculateInvoice read each price table once for 6 lines, 2 of them linked", async () => {
    const orderId = await shippedForPricing();
    let invoiceId = "";
    const create = await statementsOf(() => asSystem(async () => {
      invoiceId = (await createInvoice({ orderId })).invoice.id;
    }));
    const recalc = await statementsOf(() => asSystem(() => recalculateInvoice(invoiceId)));
    // Not vacuous: every line was priced, the linked ones from their quote rows.
    const operations = (await prisma.invoiceLine.findMany({ where: { invoiceId, kind: "OPERATION" } }));
    expect(operations).toHaveLength(12);
    expect(operations.filter((l) => l.priceSource === "QUOTE")).toHaveLength(4);
    const figures = { create: counts(create, PRICING_KEYS), recalc: counts(recalc, PRICING_KEYS) };
    measured("invoice pricing reads", figures);
    // One read per table whatever the line count (#622). It was one per line: 4 PartPrice reads (a
    // shared part read twice), and 2 of each quote table.
    const once = Object.fromEntries(PRICING_KEYS.map((k) => [k, 1]));
    expect(figures).toEqual({ create: once, recalc: once });
  });

  it("invoiceStepSuggestions reads the riders' latest revisions in a fixed number of statements", async () => {
    const orderId = await shippedForPricing();
    const { invoice } = await asSystem(() => createInvoice({ orderId }));
    const lines = await prisma.orderLine.findMany({ where: { orderId }, orderBy: { position: "asc" } });
    let answer: Awaited<ReturnType<typeof invoiceStepSuggestions>> | undefined;
    const statements = await statementsOf(async () => { answer = await invoiceStepSuggestions(invoice.id); });
    // Every line lists its part's 2 steps, and the two lines of one part the same 2.
    expect(lines.map((l) => answer!.byOrderLine[l.id].length)).toEqual([2, 2, 2, 2, 2, 2]);
    expect(answer!.byOrderLine[lines[2].id]).toEqual(answer!.byOrderLine[lines[1].id]);
    const figures = counts(statements, ["SELECT PartProcessRevision", "SELECT PartProcessStep"]);
    measured("invoice step suggestions", figures);
    // The lead's saved revision (one of each), then the 5 riders together: one read of their
    // revisions and one of those revisions' steps (#622). It was one of each per rider.
    expect(figures).toEqual({ "SELECT PartProcessRevision": 2, "SELECT PartProcessStep": 2 });
  });
});

/** The columns a statement sends BACK: a SELECT's list before its FROM, a write's RETURNING list. A
 *  column a write only stores (an INSERT's column list, an UPDATE's SET) is not sent back. */
export function returnedColumns(statement: string): string {
  const returning = /\bRETURNING\b([\s\S]*)$/i.exec(statement);
  if (returning) return returning[1];
  if (/^\s*SELECT\b/i.test(statement)) return statement.slice(0, statement.search(/\bFROM\b/i));
  return "";
}

/** The statements of `run` that send `column` back. */
async function sentBack(column: string, run: () => Promise<unknown>): Promise<string[]> {
  return (await statementsOf(run)).filter((x) => returnedColumns(x).includes(`"${column}"`));
}

describe("writes that return stored bytes (#686)", () => {
  it("the matcher reads a SELECT's list and a write's RETURNING, never what a write stores", () => {
    expect(returnedColumns('INSERT INTO "public"."PartAttachment" ("fileData") VALUES ($1) RETURNING "public"."PartAttachment"."id"')).not.toContain('"fileData"');
    expect(returnedColumns('INSERT INTO "public"."PartAttachment" ("fileData") VALUES ($1) RETURNING "public"."PartAttachment"."fileData"')).toContain('"fileData"');
    expect(returnedColumns('SELECT "public"."PartAttachment"."fileData" FROM "public"."PartAttachment" WHERE 1=1')).toContain('"fileData"');
    expect(returnedColumns('UPDATE "public"."User" SET "signatureImage" = $1 WHERE "id" = $2')).toBe("");
  });

  it("an attachment upload and delete never read the file back, on either owner", async () => {
    const p = await part(customer);
    const { order } = await asSystem(() => createOrder({ customerId: customer.id, lines: [{ partId: p.id, qty: 1, weight: "1.00" }] }));
    for (const [owner, ownerId] of [["part", p.id], ["order", order.id]] as const) {
      let id = "";
      const upload = await sentBack("fileData", () => asSystem(async () => {
        id = (await addAttachment(owner, ownerId, { filename: "drawing.png", mimeType: "image/png", data: Buffer.alloc(4096, 7) })).id;
      }));
      const remove = await sentBack("fileData", () => asSystem(() => deleteAttachment(owner, ownerId, id)));
      // Each sent the stored file back once: the upload's RETURNING and the delete's existence check.
      expect({ owner, upload, remove }).toEqual({ owner, upload: [], remove: [] });
    }
  });

  it("a user edit and a signature upload never read the signature or the password hash back", async () => {
    const role = await prisma.role.create({ data: { name: "WS role" } });
    const user = await prisma.user.create({ data: { username: "ws-user", passwordHash: "x", displayName: "WS", roleId: role.id } });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const signature = await sentBack("signatureImage", () => asSystem(() => setSignature(user.id, png, "image/png")));
    const edit = await statementsOf(() => asSystem(() => updateUser(user.id, { displayName: "WS edited" })));
    const editBack = edit.filter((x) => /"(signatureImage|passwordHash)"/.test(returnedColumns(x)) && !/^\s*SELECT\b/i.test(x));
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ displayName: "WS edited" });
    // Each UPDATE sent the whole row back, the 2 MB image and the hash included.
    expect({ signature: signature.filter((x) => !/^\s*SELECT\b/i.test(x)), editBack }).toEqual({ signature: [], editBack: [] });
  });
});
