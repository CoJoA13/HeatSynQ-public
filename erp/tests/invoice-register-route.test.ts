import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { readXlsx } from "./helpers/xlsx";
import { pageCount } from "./helpers/pdf";
import { assertRun, printedPages } from "../e2e/lib/printed-page.mjs";
import { parseDateOnly } from "@/lib/business-days";
import { runWithContext } from "@/server/context";
import { setSetting } from "@/server/settings";
import { listInvoiceRegisterForPdf, readInvoiceRegisterForPdf } from "@/server/invoices";

import { GET as registerRoute } from "@/app/api/invoices/register/route";
import { GET as exportRoute } from "@/app/api/invoices/export/route";
import { GET as listRoute } from "@/app/api/invoices/route";

// GET /api/invoices/register: the Invoicing list's Export to PDF, the Invoice register (#592). The
// same permission, filter parse and rows as the Excel (plan Amendments 3 and 10); a download, never
// stored (ruling 592-2); a pure read (spec §12). An id that names no customer is refused, the PDF's
// alone (Amendment 11). The page's text is the mapping's and the builder's subject
// (tests/invoice-register-pdf.test.ts); these cases hold the route and its read to them.

const noParams = { params: Promise.resolve({}) };
const getReq = (url: string, cookie?: string) =>
  new Request(url, { method: "GET", headers: cookie ? { cookie } : {} });
const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const finalizedAt = new Date("2026-10-20T14:30:00.000Z");

let orderSeq = 1000;

/** An invoice on an order of its own, written directly (the export test's shape): the register
 *  reads rows, and how an invoice came to be finalized is the register read's subject, not this. */
async function writeInvoice(customerId: string, finalized: boolean, invoiceDate = "2026-10-20", total = "100.00") {
  orderSeq += 1;
  const order = await prisma.order.create({
    data: {
      orderNumber: orderSeq, customerId, status: finalized ? "INVOICED" : "SHIPPED",
      receivedDate: parseDateOnly("2026-10-01"), requestDate: parseDateOnly("2026-10-01"),
    },
  });
  return prisma.invoice.create({
    data: {
      kind: "INVOICE", status: finalized ? "FINALIZED" : "DRAFT", orderId: order.id, customerId,
      invoiceDate: parseDateOnly(invoiceDate), finalizedAt: finalized ? finalizedAt : null, total,
    },
  });
}

const customerOf = (code: string, name: string) => prisma.customer.create({ data: { code, name } });

/** The plant's date of an instant, YYYY-MM-DD, worked out here with its own formatter. */
function plantDate(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** The register's answer for a query, and every page's printed lines. */
async function register(query: string, cookie: string) {
  const res = await registerRoute(getReq(`http://t/api/invoices/register${query}`, cookie), noParams);
  expect(res.status).toBe(200);
  const bytes = Buffer.from(await res.arrayBuffer());
  const pages = printedPages(bytes, { pages: pageCount(bytes), what: "the invoice register" });
  return { res, pages };
}

describe("GET /api/invoices/register", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("401s without a session", async () => {
    expect((await registerRoute(getReq("http://t/api/invoices/register"), noParams)).status).toBe(401);
  });

  it("requires invoicing.view", async () => {
    const wrong = await signInWith(["orders.view"], "inv-register-wrong");
    expect((await registerRoute(getReq("http://t/api/invoices/register", wrong), noParams)).status).toBe(403);
  });

  it("answers a PDF download named for the plant's date it was made", async () => {
    const customer = await customerOf("IRG1", "Register Customer");
    await writeInvoice(customer.id, true);
    const viewer = await signInWith(["invoicing.view"], "inv-register-viewer");
    const before = new Date();
    const res = await registerRoute(getReq("http://t/api/invoices/register", viewer), noParams);
    const after = new Date();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    // The call may straddle the plant's midnight: either side's date is right.
    const names = [before, after].map((at) => `attachment; filename="invoice-register-${plantDate(at)}.pdf"`);
    expect(names).toContain(res.headers.get("content-disposition"));
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("is a pure read: it stores no document and writes no audit row", async () => {
    const customer = await customerOf("IRG1", "Register Customer");
    await writeInvoice(customer.id, true);
    const viewer = await signInWith(["invoicing.view"], "inv-register-pure");
    const counts = async () => ({ documents: await prisma.storedDocument.count(), audit: await prisma.auditLog.count() });
    const was = await counts();
    await register("", viewer);
    expect(await counts()).toEqual(was);
  });

  it("prints the rows the Excel exports for the same query, in its order", async () => {
    await asSystem(() => setSetting("invoice_number_prefix", "IR"));
    const mine = await customerOf("IRG1", "Register Customer");
    const other = await customerOf("IRG2", "Other Customer");
    await writeInvoice(mine.id, true, "2026-10-18");
    await writeInvoice(mine.id, true, "2026-10-20");
    await writeInvoice(mine.id, false, "2026-10-19"); // a draft: not Finalized
    await writeInvoice(other.id, true, "2026-10-19");
    const viewer = await signInWith(["invoicing.view"], "inv-register-rows");
    const query = `?customerId=${mine.id}&status=FINALIZED`;

    const sheet = await readXlsx(await exportRoute(getReq(`http://t/api/invoices/export${query}`, viewer), noParams), "Invoices");
    const excel = sheet.rows.slice(1, -2).map((row) => row[0]); // after the header, before the blank and summary rows
    expect(excel).toHaveLength(2);

    const { pages } = await register(query, viewer);
    expect(pages.flat().filter((line) => /^IR - \d+$/.test(line))).toEqual(excel);
    assertRun(pages[0], ["Total of 2 documents", "200.00"], "the summary");
  });

  it("draws the filter it was asked for, its date as parsed", async () => {
    const customer = await customerOf("IRG1", "Register Customer");
    await writeInvoice(customer.id, true, "2026-10-20");
    const viewer = await signInWith(["invoicing.view"], "inv-register-filter");
    const { pages } = await register(`?status=FINALIZED&from=%202026-10-01%20&customerId=${customer.id}`, viewer);
    assertRun(pages[0], [
      "Invoice register",
      "Customer: IRG1 · Register Customer   Status: Finalized   Invoice date: from 10/01/2026",
    ], "the header");
    assertRun(pages[0], ["Total of 1 document", "100.00"], "the summary");
  });

  it("names the Printed filter as a fourth part only when it is set, and the Excel follows it too (PR 6, owner 2026-10-31)", async () => {
    await asSystem(() => setSetting("invoice_number_prefix", "IR"));
    const customer = await customerOf("IRG1", "Register Customer");
    const printed = await writeInvoice(customer.id, true, "2026-10-20");
    await writeInvoice(customer.id, true, "2026-10-19"); // never printed
    await prisma.storedDocument.create({
      data: { kind: "INVOICE", invoiceId: printed.id, createdAt: new Date(finalizedAt.getTime() + 1000), fileData: new Uint8Array(Buffer.from("%PDF-")) },
    });
    const viewer = await signInWith(["invoicing.view"], "inv-register-printed");
    const { pages } = await register("?printed=0", viewer);
    assertRun(pages[0], [
      "Invoice register",
      "Customer: All customers   Status: All statuses   Invoice date: Any date   Printed: Not printed",
    ], "the header");
    assertRun(pages[0], ["Total of 1 document", "100.00"], "the summary");
    const sheet = await readXlsx(await exportRoute(getReq("http://t/api/invoices/export?printed=0", viewer), noParams), "Invoices");
    const excel = sheet.rows.slice(1, -2).map((row) => row[0]);
    expect(excel).toEqual(pages.flat().filter((line) => /^IR - \d+$/.test(line)));
    expect(excel).toHaveLength(1);
    const printedOnly = await register("?printed=1", viewer);
    assertRun(printedOnly.pages[0], ["Customer: All customers   Status: All statuses   Invoice date: Any date   Printed: Printed"], "the header, printed");
    assertRun(printedOnly.pages[0], ["Total of 1 document", "100.00"], "the summary, printed");
    const all = await register("", viewer);
    assertRun(all.pages[0], ["Customer: All customers   Status: All statuses   Invoice date: Any date"], "the three-part line");
    assertRun(all.pages[0], ["Total of 2 documents", "200.00"], "the summary, all");
  });

  it("answers an unknown Printed value with a 400 naming it, on the list, the Excel and the PDF alike", async () => {
    const viewer = await signInWith(["invoicing.view"], "inv-register-printed-bad");
    for (const [route, path] of [[listRoute, "/api/invoices"], [exportRoute, "/api/invoices/export"], [registerRoute, "/api/invoices/register"]] as const) {
      const res = await route(getReq(`http://t${path}?printed=2`, viewer), noParams);
      expect(res.status, path).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('Unknown printed filter "2"');
    }
  });

  it("answers a malformed date with the list's own 400", async () => {
    const viewer = await signInWith(["invoicing.view"], "inv-register-date");
    const res = await registerRoute(getReq("http://t/api/invoices/register?from=2026-13-01", viewer), noParams);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '"2026-13-01" is not a valid date (yyyy-mm-dd) for Invoice date from' });
  });

  it("answers a malformed date's 400 ahead of a customer id that names no customer", async () => {
    const viewer = await signInWith(["invoicing.view"], "inv-register-date-first");
    const res = await registerRoute(getReq("http://t/api/invoices/register?from=2026-13-01&customerId=no-such", viewer), noParams);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '"2026-13-01" is not a valid date (yyyy-mm-dd) for Invoice date from' });
  });

  it("refuses a customer id that names no customer, where the list and the Excel answer no rows", async () => {
    const customer = await customerOf("IRG1", "Register Customer");
    await writeInvoice(customer.id, true);
    const viewer = await signInWith(["invoicing.view"], "inv-register-unknown");
    const res = await registerRoute(getReq("http://t/api/invoices/register?customerId=no-such-customer", viewer), noParams);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unknown customer "no-such-customer"' });
    // The PDF's alone (Amendment 11): for the same query the list answers an empty list, and the
    // Excel the header, the blank row and a summary of no documents.
    const list = await listRoute(getReq("http://t/api/invoices?customerId=no-such-customer", viewer), noParams);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);
    const excel = await exportRoute(getReq("http://t/api/invoices/export?customerId=no-such-customer", viewer), noParams);
    expect(excel.status).toBe(200);
    expect((await readXlsx(excel, "Invoices")).rows.map((row) => row[0]))
      .toEqual(["Document No", null, "Total of 0 documents"]);
  });

  it("still names a soft-deleted customer, whose invoices still list", async () => {
    const customer = await customerOf("IRG1", "Register Customer");
    await writeInvoice(customer.id, true);
    await prisma.customer.update({ where: { id: customer.id }, data: { deletedAt: new Date() } });
    const viewer = await signInWith(["invoicing.view"], "inv-register-deleted");
    const { pages } = await register(`?customerId=${customer.id}`, viewer);
    assertRun(pages[0], [
      "Invoice register", "Customer: IRG1 · Register Customer   Status: All statuses   Invoice date: Any date",
    ], "the header");
    assertRun(pages[0], ["Total of 1 document", "100.00"], "the summary");
  });
});

type Opened = { options: unknown; delegates: string[] };

/** Every transaction `fn` opens on the client, with its options and the model delegates read
 *  through it. Plain save/restore of the client's own method, never `vi.spyOn` (CLAUDE.md): the
 *  tests/invoice-register.test.ts shape. A read on the top-level singleton is a missing name here. */
async function transactionsOpenedBy<T>(fn: () => Promise<T>): Promise<{ result: T; opened: Opened[] }> {
  const client = prisma as unknown as { $transaction: (...args: unknown[]) => unknown };
  const real = client.$transaction;
  const opened: Opened[] = [];
  client.$transaction = function (fn: unknown, options?: unknown) {
    const record: Opened = { options, delegates: [] }; opened.push(record);
    if (typeof fn !== "function") return real.call(prisma, fn, options);
    return real.call(prisma, (tx: Record<string | symbol, unknown>) => fn(new Proxy(tx, {
      get(target, property) { if (typeof property === "string" && !property.startsWith("$")) record.delegates.push(property); return target[property]; },
    })), options);
  };
  try { return { result: await fn(), opened }; } finally { client.$transaction = real; }
}

describe("the register PDF's read: the rows and the customer in one transaction", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("reads the customer on the caller's transaction", async () => {
    const customer = await customerOf("IRG1", "Register Customer");
    await writeInvoice(customer.id, true);
    const rollBack = new Error("roll back");
    let seen: Awaited<ReturnType<typeof readInvoiceRegisterForPdf>> | undefined;
    await expect(prisma.$transaction(async (tx) => {
      await tx.customer.update({ where: { id: customer.id }, data: { name: "Renamed Customer" } });
      seen = await readInvoiceRegisterForPdf(tx, { customerId: customer.id }, "");
      throw rollBack;
    })).rejects.toBe(rollBack);
    // The rename is visible only on the transaction that made it.
    expect(seen?.customer).toEqual({ code: "IRG1", name: "Renamed Customer" });
    expect(seen?.rows).toHaveLength(1);
    expect((await listInvoiceRegisterForPdf({ customerId: customer.id })).customer)
      .toEqual({ code: "IRG1", name: "Register Customer" });
  });

  it("opens ONE RepeatableRead transaction and reaches the invoices, their documents and the customer through it", async () => {
    const customer = await customerOf("IRG1", "Register Customer");
    await writeInvoice(customer.id, true);
    const { result: read, opened } = await transactionsOpenedBy(() => listInvoiceRegisterForPdf({ customerId: customer.id }));
    expect(read.rows).toHaveLength(1);
    expect(read.customer).toEqual({ code: "IRG1", name: "Register Customer" });
    expect(opened).toHaveLength(1);
    expect(opened[0].options).toEqual({ isolationLevel: "RepeatableRead" });
    expect(new Set(opened[0].delegates)).toEqual(new Set(["invoice", "storedDocument", "customer"]));
  });

  it("is the route's read: the route opens that one transaction, and reads the customer through it", async () => {
    const customer = await customerOf("IRG1", "Register Customer");
    await writeInvoice(customer.id, true);
    const viewer = await signInWith(["invoicing.view"], "inv-register-one-read");
    const { result: res, opened } = await transactionsOpenedBy(() =>
      registerRoute(getReq(`http://t/api/invoices/register?customerId=${customer.id}`, viewer), noParams));
    expect(res.status).toBe(200);
    expect(opened).toHaveLength(1);
    expect(opened[0].options).toEqual({ isolationLevel: "RepeatableRead" });
    expect(new Set(opened[0].delegates)).toEqual(new Set(["invoice", "storedDocument", "customer"]));
  });

  it("reads no customer when the filter names none", async () => {
    expect(await listInvoiceRegisterForPdf({})).toEqual({ rows: [], customer: null });
  });
});
