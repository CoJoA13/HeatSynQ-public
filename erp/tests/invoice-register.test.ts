import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createOrder, voidOrder } from "@/server/orders";
import { createShipper, voidShipper } from "@/server/shippers";
import { addPartPrice } from "@/server/part-prices";
import { storeDocument } from "@/server/documents";
import {
  createInvoice, finalizeInvoice, unlockInvoice, createCredit, printInvoice,
  listInvoices, invoicesForOrder, readInvoiceRegister, listInvoicesWindow, readInvoiceRegisterWindow,
  type InvoiceRegisterRow,
} from "@/server/invoices";
import { printTickable } from "@/lib/invoice-printed";
import { code } from "./helpers/jsx-source";

// #591 (owner ruling 591-1, 2026-10-20): the Invoicing list's register row carries `printedAt`, the
// newest INVOICE or CREDIT print made at or after the row's current `finalizedAt` (a draft shows its
// newest print), read with the rows in ONE RepeatableRead transaction, the documents filtered
// through the invoice relation rather than by a list of the listed ids. The order hub's
// `invoicesForOrder` keeps the plain list row. The rule itself is the leaf's
// (tests/invoice-printed.test.ts); these cases hold the read to it on real rows.

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

/** Lets the clock pass a millisecond, so two stamps taken either side of it cannot be equal. */
const nextMillisecond = () => new Promise((done) => setTimeout(done, 2));

/** Polls `pg_stat_activity` until at least `count` OTHER backends are blocked on a lock inside a
 *  statement whose text contains every fragment: the proof that a transaction is parked where the
 *  test needs it, in place of a blind sleep. Copied from tests/invoice-pdf.test.ts. */
async function waitForLockWaiters(count: number, ...fragments: string[]): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    const rows = await prisma.$queryRaw<{ query: string }[]>`
      SELECT query FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`;
    if (rows.filter((r) => fragments.every((f) => r.query.includes(f))).length >= count) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

// -------------------------------------------------------------------------------------------
// Fixtures: copied in shape from tests/invoice-pdf.test.ts (copying across test files is this repo's
// convention), every name numbered so one test can raise several invoices.
// -------------------------------------------------------------------------------------------

let seq = 0;

/** A fully-shipped, priced order and its DRAFT invoice. */
async function draftInvoice() {
  seq += 1;
  const customer = await prisma.customer.create({ data: { code: `IRG${seq}`, name: `Register Customer ${seq}` } });
  await prisma.customerAddress.create({
    data: {
      customerId: customer.id, kind: "BILL_TO", name: "Demo Foundry - Columbus LLC", street: "500 Example Street",
      city: "Columbus", state: "GA", zip: "31902-0096", isDefault: true,
    },
  });
  const part = await prisma.part.create({
    data: { customerId: customer.id, partNumber: `P-${seq}`, name: "EQUALIZER-RR SUSP", eachWeight: "21.0000" },
  });
  const stepCode = await prisma.processStepCode.create({ data: { code: `HT-${seq}`, name: "Austemper" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: stepCode.id, instruction: "Austemper at 1650F." },
  });
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber: "89499",
    lines: [{ partId: part.id, qty: 144, weight: "3024.00" }],
  }));
  const { shipper } = await createShipper({
    customerId: order.customerId, shipDate: "2026-07-29",
    orders: [{
      orderId: order.id,
      lines: [{ orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight, lineComplete: true }],
      containers: [], serials: [],
    }],
  }, { canOverrideCreditHold: false });
  const gl = await prisma.glAccount.create({ data: { name: `40${seq}`, description: "Sales" } });
  const priceCode = await prisma.processStepCode.create({ data: { code: `AUST-${seq}`, name: "Austemper", glAccountId: gl.id } });
  await asSystem(() => addPartPrice(part.id, {
    processStepCodeId: priceCode.id, position: 1, unitPrice: "6.5100", minimumCharge: "600.00", pricePer: "EACH",
  }));
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  return { customer, order, shipper, invoice };
}

async function finalizedInvoice() {
  const d = await draftInvoice();
  const invoice = await asSystem(() => finalizeInvoice(d.invoice.id));
  return { ...d, invoice };
}

/** A real print through the service, and the stamp its stored document carries. */
async function print(invoiceId: string): Promise<Date> {
  const { documentId } = await asSystem(() => printInvoice(invoiceId));
  const doc = await prisma.storedDocument.findUniqueOrThrow({ where: { id: documentId }, select: { createdAt: true } });
  return doc.createdAt;
}

/** A stored print at an exact stamp, for the cases a real print's clock cannot place. */
async function printAt(invoiceId: string, createdAt: Date, kind: "INVOICE" | "CREDIT" = "INVOICE"): Promise<void> {
  await prisma.storedDocument.create({ data: { kind, invoiceId, createdAt, fileData: new Uint8Array(Buffer.from("%PDF-")) } });
}

async function finalizedAtOf(invoiceId: string): Promise<Date> {
  const row = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { finalizedAt: true } });
  if (row.finalizedAt === null) throw new Error(`Invoice ${invoiceId} is not finalized`);
  return row.finalizedAt;
}

async function rowOf(invoiceId: string, filter = {}): Promise<InvoiceRegisterRow> {
  const row = (await listInvoices(filter)).find((r) => r.id === invoiceId);
  if (!row) throw new Error(`Invoice ${invoiceId} is not on the list`);
  return row;
}

describe("listInvoices: the register's Printed", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("reads null for a finalized invoice that has never printed", async () => {
    const { invoice } = await finalizedInvoice();
    expect(await rowOf(invoice.id)).toMatchObject({ status: "FINALIZED", printedAt: null, orderVoided: false });
  });

  it("reads the print made after the finalize, through the real print path", async () => {
    const { invoice } = await finalizedInvoice();
    const printed = await print(invoice.id);
    expect((await rowOf(invoice.id)).printedAt).toBe(printed.toISOString());
  });

  it("reads a print stamped in the finalize's own millisecond as printed", async () => {
    const { invoice } = await finalizedInvoice();
    const finalizedAt = await finalizedAtOf(invoice.id);
    await printAt(invoice.id, finalizedAt);
    expect((await rowOf(invoice.id)).printedAt).toBe(finalizedAt.toISOString());
  });

  it("reads a draft's print, then null once the draft is finalized after it", async () => {
    const { invoice } = await draftInvoice();
    const printed = await print(invoice.id);
    expect(await rowOf(invoice.id)).toMatchObject({ status: "DRAFT", printedAt: printed.toISOString() });
    await nextMillisecond();
    await asSystem(() => finalizeInvoice(invoice.id));
    expect(await rowOf(invoice.id)).toMatchObject({ status: "FINALIZED", printedAt: null });
  });

  it("reads the newest print once unlocked, then null once finalized again", async () => {
    const { invoice } = await finalizedInvoice();
    const printed = await print(invoice.id);
    await asSystem(() => unlockInvoice(invoice.id, "correct the PO"));
    expect(await rowOf(invoice.id)).toMatchObject({ status: "DRAFT", finalizedAt: null, printedAt: printed.toISOString() });
    await nextMillisecond();
    await asSystem(() => finalizeInvoice(invoice.id));
    expect(await rowOf(invoice.id)).toMatchObject({ status: "FINALIZED", printedAt: null });
  });

  it("reads the newest of two prints by its stamp, not by which was filed last", async () => {
    const { invoice } = await finalizedInvoice();
    const finalizedAt = await finalizedAtOf(invoice.id);
    const newer = new Date(finalizedAt.getTime() + 120_000);
    await printAt(invoice.id, newer);
    await printAt(invoice.id, new Date(finalizedAt.getTime() + 60_000));
    expect((await rowOf(invoice.id)).printedAt).toBe(newer.toISOString());
  });

  it("reads a credit memo's own print and carries its credit number; the invoice's row carries none", async () => {
    const { invoice } = await finalizedInvoice();
    const draft = await asSystem(() => createCredit(invoice.id));
    const credit = await asSystem(() => finalizeInvoice(draft.id));
    const printed = await print(credit.id);
    expect(await rowOf(credit.id)).toMatchObject({
      kind: "CREDIT", status: "FINALIZED", creditNumber: credit.creditNumber,
      documentNumber: String(credit.creditNumber), printedAt: printed.toISOString(),
    });
    expect(credit.creditNumber).toEqual(expect.any(Number));
    expect(await rowOf(invoice.id)).toMatchObject({ kind: "INVOICE", creditNumber: null, printedAt: null });
  });

  it("keeps the list's filters: a customer's or a status's rows read their own prints and nothing else is listed", async () => {
    const a = await finalizedInvoice();
    const b = await draftInvoice();
    const aPrinted = await print(a.invoice.id);
    const bPrinted = await print(b.invoice.id);

    const byCustomer = await listInvoices({ customerId: a.customer.id });
    expect(byCustomer.map((r) => [r.id, r.printedAt])).toEqual([[a.invoice.id, aPrinted.toISOString()]]);

    const drafts = await listInvoices({ status: "DRAFT" });
    expect(drafts.map((r) => [r.id, r.printedAt])).toEqual([[b.invoice.id, bPrinted.toISOString()]]);
  });

  it("marks a finalized credit memo on a voided order, which then takes no box (owner, 2026-10-21)", async () => {
    // The path that leaves one (whole-branch review, 2026-10-21): an unapplied credit is no A/R
    // activity, so the invoice under it unlocks; with no finalized invoice left, the shipment voids
    // and then the order. The credit stays finalized and live, and every print of it answers the
    // voided refusal.
    const { invoice, order, shipper } = await finalizedInvoice();
    const draft = await asSystem(() => createCredit(invoice.id));
    const credit = await asSystem(() => finalizeInvoice(draft.id));
    await asSystem(() => unlockInvoice(invoice.id, "raised in error"));
    await asSystem(() => voidShipper(shipper.id, "shipped in error"));
    await asSystem(() => voidOrder(order.id, "entered in error"));
    const row = await rowOf(credit.id);
    expect(row).toMatchObject({ kind: "CREDIT", status: "FINALIZED", deletedAt: null, printedAt: null, orderVoided: true });
    expect(printTickable(row)).toBe(false);
  });

  it("leaves the order hub's rows as they were: no printedAt, creditNumber or orderVoided", async () => {
    const { invoice, order } = await finalizedInvoice();
    await print(invoice.id);
    const [row] = await invoicesForOrder(order.id);
    expect(row.id).toBe(invoice.id);
    expect(row).not.toHaveProperty("printedAt");
    expect(row).not.toHaveProperty("creditNumber");
    expect(row).not.toHaveProperty("orderVoided");
  });
});

// #612 PR D (ruling R3): the Invoicing list reads the newest 200 rows of its fixed sort (invoice date
// newest first, then the newest created), and the prints read beside it is bounded with it (owner,
// 2026-10-27): a cut window adds the last kept row's sort key to the list's own `where`, still
// through the invoice relation and never an `in` list of ids.
describe("listInvoices: the Printed filter (the UX redesign PR 6, owner 2026-10-31)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("keeps the rows whose Printed the filter names: not printed since finalized, or printed", async () => {
    const never = (await finalizedInvoice()).invoice;
    const printed = (await finalizedInvoice()).invoice;
    await print(printed.id);
    // #591's own case: printed, unlocked and finalized again reads as not printed since.
    const again = (await finalizedInvoice()).invoice;
    await print(again.id);
    await asSystem(() => unlockInvoice(again.id, "re-finalize"));
    await nextMillisecond();
    await asSystem(() => finalizeInvoice(again.id));
    // A draft reads its newest print, so a draft that printed is "printed".
    const draft = (await draftInvoice()).invoice;
    await print(draft.id);
    const unprinted = (await listInvoices({ printed: "0" })).map((r) => r.id).sort();
    expect(unprinted).toEqual([never.id, again.id].sort());
    const printedRows = (await listInvoices({ printed: "1" })).map((r) => r.id).sort();
    expect(printedRows).toEqual([printed.id, draft.id].sort());
    expect((await listInvoices({})).length).toBe(4);
  });

  it("narrows within the other filters, and the window cuts after the filter, not before", async () => {
    const a = (await draftInvoice()).invoice;
    await nextMillisecond();
    const b = (await draftInvoice()).invoice;
    await print(b.id);
    await nextMillisecond();
    const c = (await draftInvoice()).invoice;
    await nextMillisecond();
    const d = (await draftInvoice()).invoice;
    // The sort is newest first: d, c, b, a. A window of 2 over the unprinted rows holds d and c and
    // cuts (a is past it); a window of 2 over every row would have held d and c and said nothing of b.
    const cut = await listInvoicesWindow({ printed: "0" }, 2);
    expect(cut.rows.map((r) => r.id)).toEqual([d.id, c.id]);
    expect(cut.cut).toBe(true);
    const whole = await listInvoicesWindow({ printed: "0" }, 3);
    expect(whole.rows.map((r) => r.id)).toEqual([d.id, c.id, a.id]);
    expect(whole.cut).toBe(false);
    expect((await listInvoices({ printed: "0", status: "FINALIZED" })).length).toBe(0);
    expect((await listInvoices({ printed: "1", customerId: b.customerId })).map((r) => r.id)).toEqual([b.id]);
  });
});

describe("listInvoicesWindow (#612, ruling R3)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  /** Three invoices: `older` dated a year back, then `b` and `c` today, `c` created last. */
  async function three() {
    const older = (await draftInvoice()).invoice;
    await prisma.invoice.update({ where: { id: older.id }, data: { invoiceDate: new Date("2025-01-02T00:00:00Z") } });
    await nextMillisecond();
    const b = (await draftInvoice()).invoice;
    await nextMillisecond();
    const c = (await draftInvoice()).invoice;
    return { older, b, c };
  }

  it("answers the first rows of the list's sort, their Printed, and whether it cut", async () => {
    const { older, b, c } = await three();
    const printedB = await print(b.id);
    const cut = await listInvoicesWindow({}, 2);
    expect(cut.cut).toBe(true);
    expect(cut.rows.map((r) => r.id)).toEqual([c.id, b.id]);
    expect(cut.rows[1].printedAt).toBe(printedB.toISOString());
    const whole = await listInvoicesWindow({}, 3);
    expect(whole.cut).toBe(false);
    expect(whole.rows.map((r) => r.id)).toEqual([c.id, b.id, older.id]);
    expect((await listInvoices({})).map((r) => r.id)).toEqual([c.id, b.id, older.id]);
  });

  it("bounds the prints read to the window's rows by the last kept row's sort key, on both of its arms", async () => {
    const { older, b, c } = await three();
    /** The `where` the prints read was handed, and the invoices it names. */
    const boundOf = async (window: number) => {
      let printsWhere: unknown;
      const db = {
        invoice: prisma.invoice,
        storedDocument: { groupBy: (args: { where: unknown }) => { printsWhere = args.where; return prisma.storedDocument.groupBy(args as never); } },
      } as unknown as Parameters<typeof readInvoiceRegisterWindow>[0];
      const read = await readInvoiceRegisterWindow(db, {}, "", window);
      const named = await prisma.invoice.findMany({ where: (printsWhere as { invoice: { is: object } }).invoice.is, select: { id: true } });
      return { read, named: named.map((r) => r.id).sort() };
    };
    // Cut inside today's date: the same-date arm, by creation.
    expect(await boundOf(1)).toMatchObject({ read: { cut: true }, named: [c.id] });
    // Cut at the date boundary: today's two, not the older one.
    expect((await boundOf(2)).named).toEqual([b.id, c.id].sort());
    // Not cut: the list's own `where`, every row.
    expect(await boundOf(3)).toMatchObject({ read: { cut: false }, named: [older.id, b.id, c.id].sort() });
  });
});

describe("readInvoiceRegister: one transaction, both reads on it", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("sees a finalize and a print written inside the caller's transaction", async () => {
    const { invoice } = await draftInvoice();
    const rollBack = new Error("roll back");
    let seen: InvoiceRegisterRow | undefined;
    let printedAt: Date | undefined;
    await expect(asSystem(() => prisma.$transaction(async (tx) => {
      await finalizeInvoice(invoice.id, tx);
      const doc = await storeDocument(tx, { kind: "INVOICE", invoiceId: invoice.id }, Buffer.from("%PDF-"));
      printedAt = doc.createdAt;
      seen = (await readInvoiceRegister(tx, {}, "")).find((r) => r.id === invoice.id);
      throw rollBack;
    }))).rejects.toBe(rollBack);
    // Visible only on the transaction that wrote them: the row's status through the invoice read,
    // the print through the document read.
    expect(seen).toMatchObject({ status: "FINALIZED", printedAt: printedAt!.toISOString() });
    expect(await rowOf(invoice.id)).toMatchObject({ status: "DRAFT", printedAt: null });
  });

  it("listInvoices opens ONE RepeatableRead transaction and reaches the invoices and their documents through it", async () => {
    const { invoice } = await finalizedInvoice();
    await print(invoice.id);
    // Plain save/restore of the client's own method, never `vi.spyOn` (CLAUDE.md); the shape of
    // tests/part-process-steps.test.ts's RepeatableRead case. The proxy records the delegates the
    // callback reaches THROUGH the transaction client, so a read on the top-level singleton, a
    // second autocommit snapshot, is a missing name here.
    const client = prisma as unknown as { $transaction: (...args: unknown[]) => unknown };
    const real = client.$transaction;
    const opened: { options: unknown; delegates: string[] }[] = [];
    client.$transaction = function (fn: unknown, options?: unknown) {
      const record = { options, delegates: [] as string[] }; opened.push(record);
      if (typeof fn !== "function") return real.call(prisma, fn, options);
      return real.call(prisma, (tx: Record<string | symbol, unknown>) => fn(new Proxy(tx, {
        get(target, property) { if (typeof property === "string" && !property.startsWith("$")) record.delegates.push(property); return target[property]; },
      })), options);
    };
    let rows;
    try { rows = await listInvoices({}); } finally { client.$transaction = real; }
    expect(rows).toHaveLength(1);
    expect(rows[0].printedAt).not.toBeNull();
    expect(opened).toHaveLength(1);
    expect(opened[0].options).toEqual({ isolationLevel: "RepeatableRead" });
    expect(new Set(opened[0].delegates)).toEqual(new Set(["invoice", "storedDocument"]));
  });

  it("filters the document read through the invoice relation, never by a list of the listed ids", () => {
    // Prisma binds one parameter per id of an `in` list and refuses above about 32,000, and the
    // list has no paging. Dropping this `where` changes no row (the join is by the listed row's
    // id, so a filtered-out invoice's group never lands), so this pin is what holds it. The
    // function is found by the parser and read as its tokens (`code`), so a comment that spells the
    // filter cannot stand in for it.
    const path = new URL("../src/server/invoices.ts", import.meta.url);
    const file = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const declaration = file.statements.find((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "readRegister");
    if (!declaration) throw new Error("Missing production readRegister");
    const body = code(declaration.getText(file));
    expect(body).toContain("tx.storedDocument.groupBy(");
    expect(body).toContain("where:{invoice:{is:printsWhere}}");
    // The list's own `where`, narrowed only by a cut window's sort-key bound (#612 PR D).
    expect(body).toContain("constprintsWhere=cut&&last?{AND:[where,windowBound(last)]}:where;");
    expect(body).not.toMatch(/\bin:/);
  });

  it("rests on a finalize's stamp being taken after its claim: a print made while it waited reads as before it", async () => {
    // The Printed rule's other premise (src/lib/invoice-printed.ts): `finalizeInvoiceInTx` takes its
    // `new Date()` after `claimInvoiceRow`, so a print that held the order while the finalize waited
    // for it is stamped before the finalize, and the row reads not printed since. A gate at Read
    // Committed holds the order row, as a print's claim does, and files a print while the finalize
    // is parked behind it; the gate only locks and inserts, so the finalize wakes with no conflict.
    const { invoice, order } = await draftInvoice();
    let gateHeld!: () => void;
    const held = new Promise<void>((r) => { gateHeld = r; });
    let mayCommit!: () => void;
    const commit = new Promise<void>((r) => { mayCommit = r; });
    const gate = asSystem(() => prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
      gateHeld();
      await commit;
      await nextMillisecond();
      await storeDocument(tx, { kind: "INVOICE", invoiceId: invoice.id }, Buffer.from("%PDF-"));
      await nextMillisecond();
    }, { timeout: 20_000 }));
    await held;

    let finalizing!: Promise<unknown>;
    let parked = false;
    try {
      finalizing = asSystem(() => finalizeInvoice(invoice.id)).then(() => "finalized" as const, (e: unknown) => e);
      parked = await waitForLockWaiters(1, `"Order"`, `"id" = $1`, "FOR UPDATE");
    } finally {
      mayCommit();
      await gate;
    }
    expect(parked).toBe(true);
    expect(await finalizing).toBe("finalized");
    expect(await prisma.storedDocument.count({ where: { invoiceId: invoice.id } })).toBe(1);
    expect(await rowOf(invoice.id)).toMatchObject({ status: "FINALIZED", printedAt: null });
  });

  it("rests on a print's stamp being the insert's clock, not its transaction's start", async () => {
    // The Printed rule's premise (src/lib/invoice-printed.ts): `storeDocument` passes no
    // `createdAt`, and Prisma fills `@default(now())` with a `new Date()` at the insert. Were the
    // column's own `CURRENT_TIMESTAMP` to fill it, the stamp would be the transaction's start.
    const { invoice } = await draftInvoice();
    const { start, createdAt } = await asSystem(() => prisma.$transaction(async (tx) => {
      const [{ began }] = await tx.$queryRaw<{ began: Date }[]>`SELECT transaction_timestamp() AS "began"`;
      await new Promise((done) => setTimeout(done, 50));
      const doc = await storeDocument(tx, { kind: "INVOICE", invoiceId: invoice.id }, Buffer.from("%PDF-"));
      return { start: began, createdAt: doc.createdAt };
    }));
    expect(createdAt.getTime() - start.getTime()).toBeGreaterThanOrEqual(40);
  });
});
