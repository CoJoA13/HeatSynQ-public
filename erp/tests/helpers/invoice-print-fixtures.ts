import { beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma } from "./db";
import { layoutOf, logo } from "./canvas-fixtures";
import { standardInvoiceLayout } from "./invoice-canvas-fixtures";
import { runWithContext } from "@/server/context";
import { createOrder, type OrderDetail } from "@/server/orders";
import { createShipper } from "@/server/shippers";
import { addPartPrice } from "@/server/part-prices";
import { createInvoice, finalizeInvoice, getInvoice, type InvoiceDetail } from "@/server/invoices";
import { createTemplate, editDraft, publishDraft, uploadLogo } from "@/server/templates";
import { assignTemplate } from "@/server/template-assignments";
import { INVOICE_DEFAULT_CONFIG } from "@/lib/template-contracts/index";
import type { CanvasLayout } from "@/lib/template-contracts/canvas";
import type { TemplateConfig } from "@/lib/template-contracts/types";
import { CUSTOMER_FOLDERS_MARKER } from "@/lib/invoice-folder-entry";
import type { Customer } from "../../prisma/generated/prisma/client";

/**
 * The print path's fixtures on a canvas template (invoice canvas PR 3, Tasks 4 to 6): the shapes of
 * tests/invoice-pdf.test.ts's `draftFixture` and `finalizedFixture` and tests/invoice-canvas.test.ts's
 * `draftInvoice`, copied (that file keeps its own, the `sampleInvoice` precedent), and the
 * certification's `publishCanvas` (tests/cert-canvas.test.ts). Each runs as the system actor.
 */

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

/** One sequence for every name this module makes, so two calls in one test never collide. */
let seq = 0;

type Shipped = { customer: Customer; order: OrderDetail; invoice: InvoiceDetail };

/** A shipped order of its own customer (a BILL_TO row named "Accounts payable"), `parts` part lines,
 *  each priced by one EACH operation ($1.00, no minimum), and its draft invoice. */
export async function shippedInvoice(options: { parts?: number } = {}): Promise<Shipped> {
  const parts = options.parts ?? 1;
  seq += 1;
  const customer = await prisma.customer.create({ data: { code: `ICP${seq}`, name: `Invoice Print Customer ${seq}` } });
  await prisma.customerAddress.create({
    data: {
      customerId: customer.id, kind: "BILL_TO", name: "Accounts payable", street: "500 Example Street",
      city: "Columbus", state: "GA", zip: "31902-0096", isDefault: true,
    },
  });
  const gl = await prisma.glAccount.create({ data: { name: `ICP-GL-${seq}`, description: "Sales" } });
  const code = await prisma.processStepCode.create({ data: { code: `ICP${seq}`, name: "Austemper", glAccountId: gl.id } });
  const made: { id: string }[] = [];
  for (let p = 0; p < parts; p++) {
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: `ICP-${seq}-${p + 1}`, name: "EQUALIZER-RR SUSP", eachWeight: "21.0000" },
    });
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    await prisma.partProcessStep.create({ data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austemper." } });
    await asSystem(() => addPartPrice(part.id, {
      processStepCodeId: code.id, position: 1, unitPrice: "1.0000", minimumCharge: null, pricePer: "EACH",
    }));
    made.push(part);
  }
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber: "89499", lines: made.map((p) => ({ partId: p.id, qty: 10, weight: "210.00" })),
  }));
  await createShipper({
    customerId: customer.id, shipDate: "2026-07-29",
    orders: [{
      orderId: order.id,
      lines: order.lines.map((l) => ({ orderLineId: l.id, qty: l.qty, weight: l.weight, lineComplete: true })),
      containers: [], serials: [],
    }],
  }, { canOverrideCreditHold: false });
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  return { customer, order, invoice };
}

/** The same, finalized through finalizeInvoice. */
export async function finalizedInvoice(options: { parts?: number } = {}): Promise<Shipped> {
  const shipped = await shippedInvoice(options);
  const invoice = await asSystem(() => finalizeInvoice(shipped.invoice.id));
  return { ...shipped, invoice };
}

/** A published INVOICE template holding `layout` (config.logo null), its version carrying `logo`
 *  bytes when given, assigned to `customerId`; answers the published version id. */
export async function publishInvoiceCanvas(customerId: string, layout: CanvasLayout, logoBytes?: Buffer): Promise<string> {
  seq += 1;
  const t = await asSystem(() => createTemplate("INVOICE", `Canvas invoice ${seq}`));
  const config: TemplateConfig = { ...structuredClone(INVOICE_DEFAULT_CONFIG), logo: null, layout };
  await asSystem(() => editDraft(t.id, { config, updatedAt: t.draft.updatedAt }));
  if (logoBytes !== undefined) await asSystem(() => uploadLogo(t.id, logoBytes, "image/png"));
  const { versionId } = await asSystem(() => publishDraft(t.id));
  await asSystem(() => assignTemplate(customerId, "INVOICE", t.id));
  return versionId;
}

/** `standardInvoiceLayout()` plus a page-top Logo item at x 24, y 72, 40 × 40 (left of the identity
 *  lines at x 96, clear of the title and above the parties at 121), refused by no rule. Square, so
 *  `logoContent`'s `fit` paints the square fixture image at the whole box. */
export function invoiceLayoutWithLogo(): CanvasLayout {
  return layoutOf([...standardInvoiceLayout().items, logo({ box: { x: 24, y: 72, w: 40, h: 40 } })]);
}

// -------------------------------------------------------------------------------------------
// Task 5: the selected print and the customer's folder. Copies of the helpers private to
// tests/invoice-pdf.test.ts that its copied cases call (`withParams` :43, `postReq` :44,
// `waitForLockWaiters` :1175, `alreadyPrinted` :1186) and of its #588 share setup (:1576-1633).
// -------------------------------------------------------------------------------------------

export const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
export const postReq = (url: string, cookie?: string) =>
  new Request(url, { method: "POST", headers: cookie ? { cookie } : {} });

/** Polls `pg_stat_activity` until at least `count` OTHER backends are blocked on a lock inside a
 *  statement whose text contains every fragment: the proof that the prints are parked where the
 *  test needs them, in place of a blind sleep. tests/invoice-pdf.test.ts's, copied. */
export async function waitForLockWaiters(count: number, ...fragments: string[]): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    const rows = await prisma.$queryRaw<{ query: string }[]>`
      SELECT query FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`;
    if (rows.filter((r) => fragments.every((f) => r.query.includes(f))).length >= count) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** `selectedPrintRefusal`'s two sentences (src/lib/invoice-printed.ts), written out as
 *  tests/invoice-pdf.test.ts writes them so a changed word reds too; the label is "Invoice" or "Credit". */
export const alreadyPrinted = (number: string | number, label: "Invoice" | "Credit" = "Invoice") =>
  `${label} ${number} has already printed since it was finalized, so it was not printed again.`;
export const notFinalized = (number: string | number, label: "Invoice" | "Credit" = "Invoice") =>
  `${label} ${number} is not finalized, so it was not printed.`;

export const SHARE_ROOT = "Z:\\";
export const ACME_FOLDER = "Z:\\Customers\\Acme";

/** The customer's Invoice folder, written to the row (which skips the save's check). */
export const fileIn = (customerId: string, folder = ACME_FOLDER) =>
  prisma.customer.update({ where: { id: customerId }, data: { invoiceFolder: folder } });

/**
 * A real temp directory standing in for the office share, holding the marker and `Customers/Acme`,
 * for the cases of the describe it is called in: OFFICE_SHARE_DIR and OFFICE_SHARE_ROOT set before
 * each case and put back after (deleted when they were unset; tests/helpers/setup.ts unsets both),
 * and `console.error` caught, since a copy that did not land logs one line. The answer is read at
 * test time: its fields are written by the hook, so a destructure at describe scope reads nothing.
 */
export function withShare(): { share: string; acme: string; logSpy: MockInstance<typeof console.error> } {
  const dirs = { share: "", acme: "", logSpy: undefined as unknown as MockInstance<typeof console.error> };
  let saved: { dir: string | undefined; root: string | undefined } = { dir: undefined, root: undefined };
  const putBack = (name: "OFFICE_SHARE_DIR" | "OFFICE_SHARE_ROOT", value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  beforeEach(async () => {
    saved = { dir: process.env.OFFICE_SHARE_DIR, root: process.env.OFFICE_SHARE_ROOT };
    dirs.share = await mkdtemp(path.join(tmpdir(), "invoice-canvas-share-"));
    dirs.acme = path.join(dirs.share, "Customers", "Acme");
    await mkdir(dirs.acme, { recursive: true });
    await writeFile(path.join(dirs.share, CUSTOMER_FOLDERS_MARKER), "");
    process.env.OFFICE_SHARE_DIR = dirs.share;
    process.env.OFFICE_SHARE_ROOT = SHARE_ROOT;
    dirs.logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    dirs.logSpy.mockRestore();
    putBack("OFFICE_SHARE_DIR", saved.dir);
    putBack("OFFICE_SHARE_ROOT", saved.root);
    await rm(dirs.share, { recursive: true, force: true });
  });
  return dirs;
}

// -------------------------------------------------------------------------------------------
// Task 6: the print's budget (design 2026-11-10 §5.4; plan open question 6).
// -------------------------------------------------------------------------------------------

/**
 * §5.4's invoice in the database: 100 part lines, each priced by three EACH operations (a unit price,
 * a minimum and a setup on each; tests/invoice-canvas.test.ts's `timingDraft`), shipped whole, its
 * draft created and finalized through the services as they built it. Only THEN, by direct writes:
 * every OPERATION line takes `priceSource: "QUOTE"` and `sourceQuoteNumber: 5000` (a quote-sourced
 * line cannot be typed onto a draft, #98), and 20 SURCHARGE and 20 CHARGE lines are added after the
 * last line, their amounts as PR 2's `bigInvoice` (a surcharge made through `createSurcharge` would
 * reach every invoice of the test). The print reads the claimed row's lines and checks none of them,
 * so nothing refuses the fixture; the stored totals omit the added lines, a fixture artifact of a
 * timing case. Built on `customer` when given, else on a new customer of its own.
 */
export async function budgetInvoice(customer?: Customer): Promise<InvoiceDetail> {
  seq += 1;
  const owner = customer ?? await prisma.customer.create({ data: { code: `ICB${seq}`, name: `Invoice Budget Customer ${seq}` } });
  const gl = await prisma.glAccount.create({ data: { name: `ICB-GL-${seq}`, description: "Sales" } });
  const codes = await Promise.all(["Austemper", "Temper", "Straighten"].map((name, i) =>
    prisma.processStepCode.create({ data: { code: `ICB${seq}-${i + 1}`, name, glAccountId: gl.id } })));
  const made: { id: string }[] = [];
  for (let p = 0; p < 100; p++) {
    const part = await prisma.part.create({
      data: { customerId: owner.id, partNumber: `ICB-${seq}-${p + 1}`, name: `EQUALIZER ${p + 1}`, eachWeight: "21.0000" },
    });
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    for (const [i, code] of codes.entries()) {
      await prisma.partProcessStep.create({ data: { revisionId: rev.id, position: i + 1, codeId: code.id, instruction: `${code.name}.` } });
      await asSystem(() => addPartPrice(part.id, {
        processStepCodeId: code.id, position: i + 1, unitPrice: "1.2500", minimumCharge: "50.00", setupCharge: "15.00", pricePer: "EACH",
      }));
    }
    made.push(part);
  }
  const { order } = await asSystem(() => createOrder({
    customerId: owner.id, poNumber: "89499", lines: made.map((p) => ({ partId: p.id, qty: 10, weight: "210.00" })),
  }));
  await createShipper({
    customerId: owner.id, shipDate: "2026-07-29",
    orders: [{
      orderId: order.id,
      lines: order.lines.map((l) => ({ orderLineId: l.id, qty: l.qty, weight: l.weight, lineComplete: true })),
      containers: [], serials: [],
    }],
  }, { canOverrideCreditHold: false });
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  await asSystem(() => finalizeInvoice(invoice.id));
  // The direct writes after finalize (open question 6): no service wrote these lines.
  await prisma.invoiceLine.updateMany({
    where: { invoiceId: invoice.id, kind: "OPERATION" }, data: { priceSource: "QUOTE", sourceQuoteNumber: 5000 },
  });
  const last = await prisma.invoiceLine.aggregate({ where: { invoiceId: invoice.id }, _max: { position: true } });
  const after = last._max.position ?? 0;
  await prisma.invoiceLine.createMany({
    data: [
      ...Array.from({ length: 20 }, (_, i) => ({
        invoiceId: invoice.id, position: after + 1 + i, kind: "SURCHARGE" as const, description: `Surcharge ${i + 1}`, amount: `${5 + i}.00`,
      })),
      ...Array.from({ length: 20 }, (_, i) => ({
        invoiceId: invoice.id, position: after + 21 + i, kind: "CHARGE" as const, description: `Charge ${i + 1}`, amount: `${10 + i}.00`,
      })),
    ],
  });
  return asSystem(() => getInvoice(invoice.id));
}
