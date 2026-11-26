import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { pageCount } from "./helpers/pdf";
import { printedPages } from "../e2e/lib/printed-page.mjs";
import { runWithContext } from "@/server/context";
import { createOrder } from "@/server/orders";
import { createShipper } from "@/server/shippers";
import { addPartPrice } from "@/server/part-prices";
import { setSetting } from "@/server/settings";
import { createInvoice, finalizeInvoice, printInvoice, JOIN_NOT_AN_INVOICE } from "@/server/invoices";
import { POST as joinedRoute } from "@/app/api/invoices/joined/route";

// #1057 (owner rulings 2026-11-26 and the build answers of the same day): Print as one PDF joins the
// stored prints a Print selected run filed, in the order the page names them, into one download that
// is never stored. These cases hold the route to that: the pages are the stored bytes' pages in the
// named order, nothing is written, and an id that names anything but an invoice or credit print, or
// names one twice, refuses the whole join.

const noParams = { params: Promise.resolve({}) };
const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);
const post = (body: unknown, cookie?: string) => joinedRoute(new Request("http://t/api/invoices/joined", {
  method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
}), noParams);

// Fixtures copied in shape from tests/invoice-register.test.ts (the repo's convention).
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

beforeEach(async () => {
  await truncateAll();
  await seedOrderGatePrereqs();
  await asSystem(() => setSetting("invoice_number_prefix", "JN"));
});

/** A finalized invoice printed through the service, and its stored document's id and order number. */
async function printed() {
  const { invoice, order } = await finalizedInvoice();
  const { documentId } = await asSystem(() => printInvoice(invoice.id));
  return { documentId, orderNumber: order.orderNumber };
}

/** Each page's lines that name an invoice number, in page order. */
function numbersOn(bytes: Buffer): string[] {
  const pages = printedPages(bytes, { pages: pageCount(bytes), what: "the joined invoices" });
  return pages.map((lines) => lines.find((line) => line.startsWith("Invoice No.:")) ?? "");
}

describe("POST /api/invoices/joined (#1057)", () => {
  it("401s without a session and 403s without invoicing.view", async () => {
    expect((await post({ documentIds: ["x"] })).status).toBe(401);
    const wrong = await signInWith(["orders.view"], "inv-joined-wrong");
    expect((await post({ documentIds: ["x"] }, wrong)).status).toBe(403);
  });

  it("joins the stored prints in the order named, and stores and audits nothing", async () => {
    const a = await printed();
    const b = await printed();
    const viewer = await signInWith(["invoicing.view"], "inv-joined-viewer");
    const counts = async () => ({ documents: await prisma.storedDocument.count(), audit: await prisma.auditLog.count() });
    const was = await counts();
    const res = await post({ documentIds: [b.documentId, a.documentId] }, viewer);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(pageCount(bytes)).toBe(2);
    expect(numbersOn(bytes)).toEqual([`Invoice No.:  JN - ${b.orderNumber}`, `Invoice No.:  JN - ${a.orderNumber}`]);
    expect(await counts()).toEqual(was);
  });

  it("refuses the whole join when an id names no invoice or credit print, or one is named twice", async () => {
    const a = await printed();
    const viewer = await signInWith(["invoicing.view"], "inv-joined-refusals");
    const other = await prisma.storedDocument.create({
      data: { kind: "STATEMENT", customerId: (await prisma.customer.findFirstOrThrow()).id, fileData: new Uint8Array(Buffer.from("%PDF-")) },
    });
    for (const ids of [[a.documentId, other.id], [a.documentId, "no-such-document"]]) {
      const res = await post({ documentIds: ids }, viewer);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(JOIN_NOT_AN_INVOICE);
    }
    const twice = await post({ documentIds: [a.documentId, a.documentId] }, viewer);
    expect(twice.status).toBe(400);
    expect(await post({ documentIds: [] }, viewer).then((r) => r.status)).toBe(400);
  });
});
