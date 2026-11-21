import { prisma } from "./db";
import { runWithContext } from "@/server/context";
import { addDays, formatDateOnly, parseDateOnly, todayDateOnly } from "@/lib/business-days";
import { createTemplate, editDraft, publishDraft, uploadLogo } from "@/server/templates";
import { assignTemplate } from "@/server/template-assignments";
import { STATEMENT_DEFAULT_CONFIG } from "@/lib/template-contracts/index";
import type { CanvasLayout } from "@/lib/template-contracts/canvas";
import type { TemplateConfig } from "@/lib/template-contracts/types";
import { layoutOf, logo } from "./canvas-fixtures";
import { standardStatementLayout } from "./statement-canvas-fixtures";
import type { Customer } from "../../prisma/generated/prisma/client";

/**
 * The customers, open items and bill-to rows the statement's canvas cases print (since statement
 * canvas PR 2: the seed's and the preview's customers; the print path and the budget, which extend
 * this file: the payments and credits applied to an invoice, and the published
 * templates). The shapes are tests/statements.test.ts's, copied once here (that file
 * keeps its own and is not edited): direct writes of an order and a FINALIZED invoice per open item,
 * a finalized credit, an on-account payment on a real receipt, and the customer's default BILL_TO
 * row. Every date is counted back from TODAY (`todayDateOnly`), the `asOf` a statement defaults to,
 * so a statement built with no `asOf` lists them; a case that builds at another `asOf` dates its own.
 * Every write runs as the system actor.
 */

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let seq = 0;
/** A date `n` days before today, as a statement's `asOf` and its open items' dates are spelled. */
export const daysBack = (n: number): string => formatDateOnly(addDays(todayDateOnly(), -n));

/** A live customer, `STP<n>` / "Statement Print Customer <n>" unless `code` or `name` is given, a
 *  division of `parentId` when given. */
export async function makeCustomer(opts: { parentId?: string; code?: string; name?: string } = {}): Promise<Customer> {
  seq += 1;
  return asSystem(() => prisma.customer.create({
    data: {
      code: opts.code ?? `STP${seq}`, name: opts.name ?? `Statement Print Customer ${seq}`,
      ...(opts.parentId !== undefined ? { parentId: opts.parentId } : {}),
    },
  }));
}

/** A FINALIZED invoice of `total` on an order of its own, dated and finalized 70 days back, due on
 *  `dueDate`. */
export async function finalizedInvoice(customerId: string, opts: { total: number; dueDate: string }): Promise<{ id: string }> {
  seq += 1;
  return asSystem(async () => {
    const order = await prisma.order.create({
      data: {
        orderNumber: 810000 + seq, customerId, status: "SHIPPED",
        receivedDate: parseDateOnly(daysBack(70)), requestDate: parseDateOnly(daysBack(70)),
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId,
        invoiceDate: parseDateOnly(daysBack(70)), dueDate: parseDateOnly(opts.dueDate),
        total: opts.total, finalizedAt: parseDateOnly(daysBack(70)),
      },
    });
    return { id: invoice.id };
  });
}

/** A FINALIZED credit memo of `total` (negative) on an order of its own, dated 20 days back. */
export async function finalizedCredit(customerId: string, opts: { total: number }): Promise<{ id: string }> {
  seq += 1;
  return asSystem(async () => {
    const order = await prisma.order.create({
      data: {
        orderNumber: 850000 + seq, customerId, status: "SHIPPED",
        receivedDate: parseDateOnly(daysBack(20)), requestDate: parseDateOnly(daysBack(20)),
      },
    });
    const credit = await prisma.invoice.create({
      data: {
        kind: "CREDIT", status: "FINALIZED", orderId: order.id, customerId,
        invoiceDate: parseDateOnly(daysBack(20)), total: opts.total,
        finalizedAt: parseDateOnly(daysBack(20)), creditNumber: 920000 + seq,
      },
    });
    return { id: credit.id };
  });
}

/** A payment of `amount` received 10 days back with nothing applied, so all of it sits on account;
 *  `reference` is the check number. */
export async function onAccountPayment(customerId: string, opts: { amount: number; reference?: string }): Promise<void> {
  seq += 1;
  await asSystem(async () => {
    const batch = await prisma.receiptBatch.create({ data: { batchNumber: 990000 + seq, depositDate: parseDateOnly(daysBack(10)) } });
    const paymentType = await prisma.paymentType.create({ data: { name: `STPOA-${seq}` } });
    await prisma.payment.create({
      data: {
        batchId: batch.id, customerId, paymentTypeId: paymentType.id,
        amount: opts.amount, reference: opts.reference ?? "", receivedDate: parseDateOnly(daysBack(10)),
      },
    });
  });
}

/** How many days past due each of the five buckets' invoices fall (a negative figure: not yet due). */
const BUCKET_DAYS_PAST_DUE = [-10, 15, 45, 75, 120];

/** `n` open finalized invoices by createMany (open question 6), one order each, their due dates
 *  spread across the five buckets in turn, each of a distinct total, dated and finalized 30 days
 *  before it falls due (or 70 days back, whichever is earlier, so every one is finalized by today). */
export async function bulkOpenItems(customerId: string, n: number): Promise<void> {
  const first = seq + 1;
  seq += n;
  await asSystem(async () => {
    const orders = await prisma.order.createManyAndReturn({
      data: Array.from({ length: n }, (_, i) => ({
        orderNumber: 1_000_000 + first + i, customerId, status: "SHIPPED" as const,
        receivedDate: parseDateOnly(daysBack(160)), requestDate: parseDateOnly(daysBack(160)),
      })),
      select: { id: true },
    });
    await prisma.invoice.createMany({
      data: orders.map((order, i) => {
        const pastDue = BUCKET_DAYS_PAST_DUE[i % BUCKET_DAYS_PAST_DUE.length];
        const dated = Math.max(70, pastDue + 30);
        return {
          kind: "INVOICE" as const, status: "FINALIZED" as const, orderId: order.id, customerId,
          invoiceDate: parseDateOnly(daysBack(dated)), dueDate: parseDateOnly(daysBack(pastDue)),
          total: 100 + i, finalizedAt: parseDateOnly(daysBack(dated)),
        };
      }),
    });
  });
}

/** The customer's default BILL_TO address row, created or replaced: R14's Name line when `name` is
 *  given (stacked above the customer's name on the statement), then the street and the city. */
export async function setDefaultBillTo(customerId: string, opts: { name?: string; street: string; city?: string }): Promise<void> {
  await asSystem(async () => {
    await prisma.customerAddress.updateMany({
      where: { customerId, kind: "BILL_TO", isDefault: true, deletedAt: null }, data: { isDefault: false, deletedAt: new Date() },
    });
    await prisma.customerAddress.create({
      data: {
        customerId, kind: "BILL_TO", name: opts.name ?? "", street: opts.street, city: opts.city ?? "",
        isDefault: true,
      },
    });
  });
}

/** A PAYMENT application of `amount` to the invoice, applied 10 days back on a real receipt for the
 *  invoice's own customer (a PAYMENT application must name its payment, Application_source_check):
 *  tests/statements.test.ts's `payInvoice`, copied. */
export async function payInvoice(invoiceId: string, amount: number): Promise<void> {
  seq += 1;
  await asSystem(async () => {
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { customerId: true } });
    const batch = await prisma.receiptBatch.create({ data: { batchNumber: 960000 + seq, depositDate: parseDateOnly(daysBack(10)) } });
    const paymentType = await prisma.paymentType.create({ data: { name: `STPPI-${seq}` } });
    const payment = await prisma.payment.create({
      data: {
        batchId: batch.id, customerId: invoice.customerId, paymentTypeId: paymentType.id,
        amount, receivedDate: parseDateOnly(daysBack(10)),
      },
    });
    await prisma.application.create({
      data: { invoiceId, amount, type: "PAYMENT", paymentId: payment.id, appliedDate: parseDateOnly(daysBack(10)) },
    });
  });
}

/** A CREDIT application of the finalized credit memo `creditId` to the invoice, applied 5 days back
 *  (Application_source_check's credit arm: no payment, the credit invoice named). */
export async function applyCredit(creditId: string, invoiceId: string, amount: number): Promise<void> {
  await asSystem(() => prisma.application.create({
    data: { invoiceId, amount, type: "CREDIT", creditInvoiceId: creditId, appliedDate: parseDateOnly(daysBack(5)) },
  }));
}

/** A published STATEMENT template named `name`, holding `layout` (null: a flow template) with
 *  `config.logo` null, its version carrying `logo` bytes (PNG) when given, assigned to each of
 *  `customerIds`; answers the published version id. tests/helpers/invoice-print-fixtures.ts's
 *  `publishInvoiceCanvas`, for any number of customers and a flow config too. */
export async function publishStatementTemplate(
  name: string, customerIds: string[], layout: CanvasLayout | null, logoBytes?: Buffer,
): Promise<string> {
  const t = await asSystem(() => createTemplate("STATEMENT", name));
  const config: TemplateConfig = { ...structuredClone(STATEMENT_DEFAULT_CONFIG), logo: null, layout };
  await asSystem(() => editDraft(t.id, { config, updatedAt: t.draft.updatedAt }));
  if (logoBytes !== undefined) await asSystem(() => uploadLogo(t.id, logoBytes, "image/png"));
  const { versionId } = await asSystem(() => publishDraft(t.id));
  for (const customerId of customerIds) await asSystem(() => assignTemplate(customerId, "STATEMENT", t.id));
  return versionId;
}

/** `standardStatementLayout()` plus a page-top Logo item at x 24, y 99, 36 × 36: left of the statement
 *  date and the Bill To (both at x 64), below the customer line and the "(continued)" box (both end at
 *  84), ending at 135, above the open items (148.5). Refused by no rule and named by no warning. Square,
 *  so `logoContent`'s `fit` paints the square fixture image at the whole box. */
export function statementLayoutWithLogo(): CanvasLayout {
  return layoutOf([...standardStatementLayout().items, logo({ box: { x: 24, y: 99, w: 36, h: 36 } })]);
}
