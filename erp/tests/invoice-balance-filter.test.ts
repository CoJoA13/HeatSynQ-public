import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { readXlsx } from "./helpers/xlsx";
import { pageCount } from "./helpers/pdf";
import { assertRun, printedPages } from "../e2e/lib/printed-page.mjs";
import { parseDateOnly } from "@/lib/business-days";
import { runWithContext } from "@/server/context";
import { setSetting } from "@/server/settings";
import { listInvoices, listInvoicesWindow } from "@/server/invoices";

import { GET as registerRoute } from "@/app/api/invoices/register/route";
import { GET as exportRoute } from "@/app/api/invoices/export/route";
import { GET as listRoute } from "@/app/api/invoices/route";

// #1057 ruling 4 (owner, 2026-11-26) and the build answer of 2026-11-26: the register's Open filter
// keeps the finalized INVOICES whose open balance is above $0 (unpaid or part-paid), never a credit
// memo, never a draft. A balance is never stored: each row's is derived from its live applications
// through `invoiceOpenBalance` (src/server/ar-balances.ts). It is parsed once for the list, the
// Excel and the register PDF (`parseInvoiceFilter`), narrows within the other filters, and, being a
// derived figure like Printed, is applied before the window is cut.

const noParams = { params: Promise.resolve({}) };
const getReq = (url: string, cookie?: string) =>
  new Request(url, { method: "GET", headers: cookie ? { cookie } : {} });
const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let orderSeq = 2000;
let customer: { id: string };

/** An invoice or credit on an order of its own, written directly (the register route test's shape):
 *  the filter reads rows, and how an invoice came to be finalized or paid is not its subject. */
async function writeInvoice(opts: {
  finalized?: boolean; total?: string; kind?: "INVOICE" | "CREDIT"; invoiceDate?: string; createdAt?: Date;
} = {}) {
  orderSeq += 1;
  const finalized = opts.finalized ?? true;
  const order = await prisma.order.create({
    data: {
      orderNumber: orderSeq, customerId: customer.id, status: finalized ? "INVOICED" : "SHIPPED",
      receivedDate: parseDateOnly("2026-10-01"), requestDate: parseDateOnly("2026-10-01"),
    },
  });
  return prisma.invoice.create({
    data: {
      kind: opts.kind ?? "INVOICE", status: finalized ? "FINALIZED" : "DRAFT", orderId: order.id,
      customerId: customer.id, invoiceDate: parseDateOnly(opts.invoiceDate ?? "2026-10-20"),
      finalizedAt: finalized ? new Date("2026-10-20T14:30:00.000Z") : null, total: opts.total ?? "100.00",
      ...(opts.kind === "CREDIT" ? { creditNumber: orderSeq } : {}),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
}

let paymentId: string;

/** An application against `invoiceId`, written directly; `voided` sets its `deletedAt`. A payment or
 *  discount names the one payment (the `Application_source_check`), a write-off none. */
async function apply(invoiceId: string, amount: string, type: "PAYMENT" | "DISCOUNT" | "WRITE_OFF" = "PAYMENT", voided = false) {
  await prisma.application.create({
    data: {
      invoiceId, amount, type, appliedDate: parseDateOnly("2026-10-21"),
      ...(type === "WRITE_OFF" ? {} : { paymentId }),
      ...(voided ? { deletedAt: new Date() } : {}),
    },
  });
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

beforeEach(async () => {
  await truncateAll();
  await seedOrderGatePrereqs();
  customer = await prisma.customer.create({ data: { code: "OPN1", name: "Open Customer" } });
  const batch = await prisma.receiptBatch.create({ data: { batchNumber: 1, depositDate: parseDateOnly("2026-10-21") } });
  const paymentType = await prisma.paymentType.create({ data: { name: "Check" } });
  paymentId = (await prisma.payment.create({
    data: { batchId: batch.id, customerId: customer.id, paymentTypeId: paymentType.id, amount: "1000.00", receivedDate: parseDateOnly("2026-10-21") },
  })).id;
});

describe("listInvoices: the Open filter (#1057)", () => {
  it("keeps the finalized invoices that still carry a balance, unpaid or part-paid", async () => {
    const unpaid = await writeInvoice();
    const partPaid = await writeInvoice();
    await apply(partPaid.id, "40.00");
    const paid = await writeInvoice();
    await apply(paid.id, "90.00");
    await apply(paid.id, "10.00", "DISCOUNT");
    const writtenOff = await writeInvoice();
    await apply(writtenOff.id, "100.00", "WRITE_OFF");
    const voidedPayment = await writeInvoice();
    await apply(voidedPayment.id, "100.00", "PAYMENT", true); // voided: the invoice still owes it all
    const overpaid = await writeInvoice();
    await apply(overpaid.id, "120.00");
    await writeInvoice({ finalized: false }); // a draft carries no balance
    await writeInvoice({ kind: "CREDIT", total: "-50.00" }); // a credit memo is never "open" here

    expect(ids(await listInvoices({ balance: "open" }))).toEqual(ids([unpaid, partPaid, voidedPayment]));
    expect((await listInvoices({})).length).toBe(8);
  });

  it("narrows within the other filters", async () => {
    const open = await writeInvoice({ invoiceDate: "2026-10-20" });
    await writeInvoice({ invoiceDate: "2026-09-20" });
    expect(await listInvoices({ balance: "open", status: "DRAFT" })).toEqual([]);
    expect(ids(await listInvoices({ balance: "open", status: "FINALIZED", from: "2026-10-01" }))).toEqual([open.id]);
    const other = await prisma.customer.create({ data: { code: "OPN2", name: "Other" } });
    expect(await listInvoices({ balance: "open", customerId: other.id })).toEqual([]);
    expect(await listInvoices({ balance: "open", printed: "1" })).toEqual([]);
    expect((await listInvoices({ balance: "open", printed: "0" })).length).toBe(2);
  });

  it("cuts the window after the filter, not before", async () => {
    // Newest first: d, c, b, a; b is paid. A window of 2 over the open rows holds d and c and cuts
    // (a is past it); cut before the filter, b would have taken a place.
    const at = (n: number) => new Date(Date.UTC(2026, 9, 20, 15, n));
    const a = await writeInvoice({ createdAt: at(1) });
    const b = await writeInvoice({ createdAt: at(2) });
    await apply(b.id, "100.00");
    const c = await writeInvoice({ createdAt: at(3) });
    const d = await writeInvoice({ createdAt: at(4) });
    const cut = await listInvoicesWindow({ balance: "open" }, 2);
    expect(cut.rows.map((r) => r.id)).toEqual([d.id, c.id]);
    expect(cut.cut).toBe(true);
    const whole = await listInvoicesWindow({ balance: "open" }, 3);
    expect(whole.rows.map((r) => r.id)).toEqual([d.id, c.id, a.id]);
    expect(whole.cut).toBe(false);
  });
});

describe("the Open filter on the routes (#1057)", () => {
  it("is parsed once: the list, the Excel and the register PDF answer the same rows, the PDF naming it", async () => {
    await asSystem(() => setSetting("invoice_number_prefix", "OP"));
    await writeInvoice();
    const paid = await writeInvoice();
    await apply(paid.id, "100.00");
    const viewer = await signInWith(["invoicing.view"], "inv-balance-routes");

    const list = await listRoute(getReq("http://t/api/invoices?balance=open", viewer), noParams);
    expect(list.status).toBe(200);
    expect(((await list.json()) as unknown[]).length).toBe(1);

    const sheet = await readXlsx(await exportRoute(getReq("http://t/api/invoices/export?balance=open", viewer), noParams), "Invoices");
    expect(sheet.rows.slice(1, -2)).toHaveLength(1);

    const res = await registerRoute(getReq("http://t/api/invoices/register?balance=open", viewer), noParams);
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    const pages = printedPages(bytes, { pages: pageCount(bytes), what: "the invoice register" });
    assertRun(pages[0], [
      "Invoice register",
      "Customer: All customers   Status: All statuses   Invoice date: Any date   Balance: Open",
    ], "the header");
    assertRun(pages[0], ["Total of 1 document", "100.00"], "the summary");
  });

  it("answers an unknown Balance value with a 400 naming it, on the list, the Excel and the PDF alike", async () => {
    const viewer = await signInWith(["invoicing.view"], "inv-balance-bad");
    for (const [route, path] of [[listRoute, "/api/invoices"], [exportRoute, "/api/invoices/export"], [registerRoute, "/api/invoices/register"]] as const) {
      const res = await route(getReq(`http://t${path}?balance=paid`, viewer), noParams);
      expect(res.status, path).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('Unknown balance filter "paid"');
    }
  });
});
