import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { readXlsx, xlsxParts } from "./helpers/xlsx";
import { parseDateOnly } from "@/lib/business-days";

import { GET as exportRoute } from "@/app/api/invoices/export/route";

// GET /api/invoices/export: the Invoicing list's Excel, its rows `listInvoices`'. #591 (owner rulings
// 591-9/10, 2026-10-20): Printed is its tenth column, after Finalized, written the way
// Finalized is, as the ISO text the list row carries: the newest print since the row was finalized
// (a draft: its newest print), empty when there is none. #592 (owner rulings, 2026-10-20 and
// 2026-10-21): after the rows, a blank row, then one summary row: the count in words under Document
// No and the sum of every row's Total under Total (`registerSummary`), nothing else on it.

const noParams = { params: Promise.resolve({}) };
const getReq = (url: string, cookie?: string) =>
  new Request(url, { method: "GET", headers: cookie ? { cookie } : {} });

const finalizedAt = new Date("2026-10-20T14:30:00.123Z");

const exportCustomer = () => prisma.customer.create({ data: { code: "IEX1", name: "Export Customer" } });

/** An invoice on an order of its own, written directly (the receivables export test's shape): the
 *  export reads rows, and how an invoice came to be finalized is the register test's subject, not
 *  this one's. */
async function writeInvoice(customerId: string, orderNumber: number, finalized: boolean, total = "100.00") {
  const order = await prisma.order.create({
    data: {
      orderNumber, customerId, status: finalized ? "INVOICED" : "SHIPPED",
      receivedDate: parseDateOnly("2026-10-01"), requestDate: parseDateOnly("2026-10-01"),
    },
  });
  return prisma.invoice.create({
    data: {
      kind: "INVOICE", status: finalized ? "FINALIZED" : "DRAFT", orderId: order.id, customerId,
      invoiceDate: parseDateOnly("2026-10-20"), finalizedAt: finalized ? finalizedAt : null, total,
    },
  });
}

/** Two finalized invoices and a draft, each for 100.00. The first finalized invoice and the draft
 *  each carry a stored print. */
async function exportedInvoices() {
  const customer = await exportCustomer();
  const print = (invoiceId: string, createdAt: Date) => prisma.storedDocument.create({
    data: { kind: "INVOICE", invoiceId, createdAt, fileData: new Uint8Array(Buffer.from("%PDF-")) },
  });
  const printed = await writeInvoice(customer.id, 1001, true);
  await writeInvoice(customer.id, 1002, true); // finalized, never printed
  const draft = await writeInvoice(customer.id, 1003, false);
  const printedAt = new Date(finalizedAt.getTime() + 60_000);
  await print(printed.id, printedAt);
  const draftPrintedAt = new Date(finalizedAt.getTime() - 60_000);
  await print(draft.id, draftPrintedAt);
  return { printedAt, draftPrintedAt };
}

describe("GET /api/invoices/export", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("401s without a session", async () => {
    expect((await exportRoute(getReq("http://t/api/invoices/export"), noParams)).status).toBe(401);
  });

  it("requires invoicing.view", async () => {
    const wrong = await signInWith(["orders.view"], "inv-export-wrong");
    expect((await exportRoute(getReq("http://t/api/invoices/export", wrong), noParams)).status).toBe(403);
  });

  it("writes Printed after Finalized, as the ISO text, empty for a row not printed since it was finalized and a draft's newest print", async () => {
    const { printedAt, draftPrintedAt } = await exportedInvoices();
    const viewer = await signInWith(["invoicing.view"], "inv-export-viewer");
    const res = await exportRoute(getReq("http://t/api/invoices/export", viewer), noParams);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="Invoices.xlsx"');

    const sheet = await readXlsx(res, "Invoices");
    expect(sheet.row(1)).toEqual([
      "Document No", "Kind", "Order No", "Customer Code", "Customer Name",
      "Invoice Date", "Status", "Total", "Finalized", "Printed",
    ]);
    const byOrder = new Map(sheet.rows.slice(1).map((r) => [r[2], r]));
    expect(byOrder.get(1001)?.slice(8)).toEqual(["2026-10-20T14:30:00.123Z", printedAt.toISOString()]);
    expect(byOrder.get(1002)?.slice(8)).toEqual(["2026-10-20T14:30:00.123Z", null]);
    expect(byOrder.get(1003)?.slice(8)).toEqual([null, draftPrintedAt.toISOString()]);
  });

  describe("the summary row (#592)", () => {
    /** The export's bytes, read once: a Response body can be read only once, and both readers want it. */
    async function exported(): Promise<Buffer> {
      const viewer = await signInWith(["invoicing.view"], "inv-export-summary");
      const res = await exportRoute(getReq("http://t/api/invoices/export", viewer), noParams);
      expect(res.status).toBe(200);
      return Buffer.from(await res.arrayBuffer());
    }

    /** The row elements after the header and `dataRows` rows, from the XML: a reader drops a
     *  trailing empty row and cannot tell an absent cell from an empty one. Counted first, so a
     *  missing row is a failed count rather than an index past the end. */
    function afterRows(bytes: Buffer, dataRows: number) {
      const parts = xlsxParts(bytes);
      expect(parts.rows).toHaveLength(dataRows + 3);
      return parts.rows.slice(dataRows + 1);
    }

    /** A summary cell as `xlsxParts` reads it: plain, neither bold nor italic. */
    const plain = (ref: string, type: string, text: string) => ({ ref, type, text, bold: false, italic: false });

    it("writes a blank row after the rows, then the count in words under Document No and the sum under Total, and nothing else", async () => {
      await exportedInvoices();
      const bytes = await exported();
      expect(afterRows(bytes, 3)).toEqual([
        { number: 5, cells: [] },
        { number: 6, cells: [plain("A6", "s", "Total of 3 documents"), plain("H6", "n", "300")] },
      ]);
      // What a spreadsheet user sees: the blank row, then the label in A and the sum in H.
      const sheet = await readXlsx(bytes, "Invoices");
      expect(sheet.rows).toHaveLength(6);
      expect(sheet.row(5)).toEqual(Array(10).fill(null));
      expect(sheet.row(6)).toEqual(["Total of 3 documents", null, null, null, null, null, null, 300, null, null]);
    });

    it("words one row in the singular: Total of 1 document", async () => {
      const customer = await exportCustomer();
      await writeInvoice(customer.id, 1001, true, "1250.00");
      const bytes = await exported();
      expect(afterRows(bytes, 1)).toEqual([
        { number: 3, cells: [] },
        { number: 4, cells: [plain("A4", "s", "Total of 1 document"), plain("H4", "n", "1250")] },
      ]);
    });

    it("sums the totals in cents, so 0.10 and 0.20 write 0.3", async () => {
      const customer = await exportCustomer();
      await writeInvoice(customer.id, 1001, true, "0.10");
      await writeInvoice(customer.id, 1002, true, "0.20");
      const bytes = await exported();
      // The cell's literal <v>: summed as floats it would be 0.30000000000000004.
      expect(afterRows(bytes, 2)[1]).toEqual({
        number: 5, cells: [plain("A5", "s", "Total of 2 documents"), plain("H5", "n", "0.3")],
      });
    });

    it("nets a credit memo's negative total against the invoice", async () => {
      const customer = await exportCustomer();
      const invoice = await writeInvoice(customer.id, 1001, true, "1250.00");
      // A credit memo's total is stored already negated (`negateMoney`, src/server/invoices.ts).
      await prisma.invoice.create({
        data: {
          kind: "CREDIT", status: "FINALIZED", orderId: invoice.orderId, customerId: customer.id,
          sourceInvoiceId: invoice.id, creditNumber: 5001, invoiceDate: parseDateOnly("2026-10-21"),
          finalizedAt, total: "-157.50",
        },
      });
      const bytes = await exported();
      expect(afterRows(bytes, 2)[1]).toEqual({
        number: 5, cells: [plain("A5", "s", "Total of 2 documents"), plain("H5", "n", "1092.5")],
      });
    });

    it("writes the header, the blank row and a summary of 0 documents and 0 for an empty export", async () => {
      const bytes = await exported();
      expect(afterRows(bytes, 0)).toEqual([
        { number: 2, cells: [] },
        { number: 3, cells: [plain("A3", "s", "Total of 0 documents"), plain("H3", "n", "0")] },
      ]);
      expect((await readXlsx(bytes, "Invoices")).row(3))
        .toEqual(["Total of 0 documents", null, null, null, null, null, null, 0, null, null]);
    });
  });
});
