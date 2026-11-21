import { describe, it, expect, beforeEach } from "vitest";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { measured } from "./helpers/measured";
import { pageCount, paintedImageCounts, paintedImages, textLinesWithY, tinyAlphaPng } from "./helpers/pdf";
import { standardInvoiceLayout } from "./helpers/invoice-canvas-fixtures";
import {
  alreadyPrinted, budgetInvoice, fileIn, finalizedInvoice, invoiceLayoutWithLogo, notFinalized, postReq, publishInvoiceCanvas,
  shippedInvoice, waitForLockWaiters, withParams, withShare,
} from "./helpers/invoice-print-fixtures";
import { runWithContext } from "@/server/context";
import { createOrder } from "@/server/orders";
import { createShipper } from "@/server/shippers";
import { addPartPrice } from "@/server/part-prices";
import { createSurcharge } from "@/server/surcharges";
import { setSetting } from "@/server/settings";
import { createCredit, createInvoice, finalizeInvoice, printInvoice, printSelectedInvoice } from "@/server/invoices";
import { getDocument } from "@/server/documents";
import { HttpError } from "@/server/errors";
import { CUSTOMER_FOLDERS_MARKER } from "@/lib/invoice-folder-entry";
import { PRINT_NOT_CONNECTED } from "@/lib/customer-folder-words";
import { Prisma } from "../prisma/generated/prisma/client";
import { POST as printRoute } from "@/app/api/invoices/[id]/print/route";
import { canvasRefusal } from "@/lib/template-canvas";
import { INVOICE_CONTRACT } from "@/lib/template-contracts/invoice";
import { INVOICE_DEFAULT_CONFIG } from "@/lib/template-contracts/index";
import { seedInvoiceLayout } from "@/server/invoice-canvas-seed";

/**
 * The print path on a canvas template (invoice canvas PR 3, Task 4; design 2026-11-10 §11 "The print
 * path" and "Frozen paper", call 14: the canvas adds no read). Each print case reads the STORED
 * document's bytes and proves it ran on the canvas by its `templateVersionId`, so an assignment that
 * silently resolved to the Standard cannot pass for the right one.
 */

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

/** The stored row of a print: its bytes and its stamp. */
async function storedPrint(documentId: string) {
  const bytes = (await getDocument(documentId)).fileData;
  const row = await prisma.storedDocument.findUniqueOrThrow({ where: { id: documentId }, select: { kind: true, templateVersionId: true } });
  return { bytes, ...row };
}

/** The INVOICE Standard's published version: what an invoice of a customer with nothing assigned prints. */
const standardInvoiceVersionId = async () => (await prisma.documentTemplate.findFirstOrThrow({
  where: { docType: "INVOICE", isDefault: true, deletedAt: null },
})).publishedVersionId;

/** Every printed line of page 1, its text alone. */
const lineTexts = (pdf: Buffer): string[] => textLinesWithY(pdf)[0].map((l) => l.text);

describe("printInvoice with a canvas template", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  // Reds when `printInvoiceInTx`'s logo test goes back to `resolved.config.logo !== null` (the flow's
  // header slot alone): the Logo item's config carries `logo: null`, so no data URI reaches the
  // builder and the page paints nothing ([0]).
  it("a canvas Logo item prints on the stored invoice", async () => {
    const { customer, invoice } = await shippedInvoice();
    const layout = invoiceLayoutWithLogo();
    expect(canvasRefusal(layout, INVOICE_CONTRACT, { pageFooter: false })).toBeNull();
    const versionId = await publishInvoiceCanvas(customer.id, layout, tinyAlphaPng());

    const { documentId } = await asSystem(() => printInvoice(invoice.id));
    const stored = await storedPrint(documentId);
    expect(stored.templateVersionId).toBe(versionId);
    expect(paintedImageCounts(stored.bytes)).toEqual([1]);
    // `logoContent` fits the image to the item's box (`fit: [w, h]`), so a square image in a square
    // box is the whole box, at the item's place (top-down y).
    const [[image]] = paintedImages(stored.bytes);
    expect(Math.abs(image.x - 24)).toBeLessThanOrEqual(1);
    expect(Math.abs(image.y - 72)).toBeLessThanOrEqual(1);
    expect(Math.abs(image.w - 40)).toBeLessThanOrEqual(1);
    expect(Math.abs(image.h - 40)).toBeLessThanOrEqual(1);
  });

  // No mutation of the print line reds this: the old test (`config.logo !== null`) and the conjunct
  // dropped (`logoImage !== null` alone) both paint nothing here, since the builders paint only a
  // placed logo.
  it("(pin) a canvas with no Logo item paints none, an upload on file or not", async () => {
    // Each half on a customer of its own: one published with the upload on file, one with none.
    for (const logo of [tinyAlphaPng(), undefined]) {
      const { customer, invoice } = await shippedInvoice();
      const versionId = await publishInvoiceCanvas(customer.id, standardInvoiceLayout(), logo);

      const { documentId } = await asSystem(() => printInvoice(invoice.id));
      const stored = await storedPrint(documentId);
      const half = logo === undefined ? "no upload" : "an upload on file";
      expect(stored.templateVersionId, half).toBe(versionId);
      expect(paintedImageCounts(stored.bytes), half).toEqual([0]);
    }
  });

  // Design call 10: one canvas prints invoices and credit memos. Reds when `invoicePdfDataFromDetail`
  // titles a credit "Invoice" (its `title` made the constant), and when the print resolves its
  // template on no customer (`resolveTemplateForPrint(tx, "INVOICE", null)`: the Standard's stamp).
  it("a credit prints its canvas", async () => {
    // The credit's number apart from the order's, so the number read below is the credit's own.
    await asSystem(() => setSetting("credit_number_next", 5000));
    const { customer, order, invoice } = await finalizedInvoice();
    const versionId = await publishInvoiceCanvas(customer.id, standardInvoiceLayout());
    const credit = await asSystem(() => createCredit(invoice.id));
    await asSystem(() => finalizeInvoice(credit.id));
    expect(credit.creditNumber).toBe(5000);
    expect(credit.creditNumber).not.toBe(order.orderNumber);

    const { documentId, documentNumber } = await asSystem(() => printInvoice(credit.id));
    expect(documentNumber).toBe("5000");
    const stored = await storedPrint(documentId);
    expect(stored.kind).toBe("CREDIT");
    expect(stored.templateVersionId).toBe(versionId);
    const lines = lineTexts(stored.bytes);
    expect(lines).toContain("Credit");
    expect(lines).not.toContain("Invoice");
    // The bare credit number, where an invoice prints its order's (the order strip still names the order).
    expect(lines).toContain("Invoice No.: 5000");
  });

  describe("frozen paper", () => {
    let seq = 0;

    /** The frozen case's own invoice (tests/invoice-canvas.test.ts's frozen fixture): the part
     *  P-CANVAS-1 priced at $1.00 each by one EACH operation, ten shipped, a BILL_TO row on 500
     *  Example Street, and the one Energy surcharge (5%) made before `createInvoice`, so its line is
     *  $0.50. Answers the ids the live edits after create need. */
    async function frozenInvoice() {
      seq += 1;
      const customer = await prisma.customer.create({ data: { code: `ICF${seq}`, name: "Invoice Canvas Customer" } });
      const address = await prisma.customerAddress.create({
        data: {
          customerId: customer.id, kind: "BILL_TO", name: "Demo Foundry - Columbus LLC", street: "500 Example Street",
          city: "Columbus", state: "GA", zip: "31902-0096", isDefault: true,
        },
      });
      const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-CANVAS-1", name: "EQUALIZER-RR SUSP", eachWeight: "21.0000" } });
      const stepCode = await prisma.processStepCode.create({ data: { code: `HT-${part.id}`, name: "Austemper" } });
      const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
      await prisma.partProcessStep.create({ data: { revisionId: rev.id, position: 1, codeId: stepCode.id, instruction: "Austemper at 1650F." } });
      const { order } = await asSystem(() => createOrder({
        customerId: customer.id, poNumber: "89499", lines: [{ partId: part.id, qty: 10, weight: "210.00" }],
      }));
      await createShipper({
        customerId: customer.id, shipDate: "2026-07-29",
        orders: [{
          orderId: order.id,
          lines: order.lines.map((l) => ({ orderLineId: l.id, qty: l.qty, weight: l.weight, lineComplete: true })),
          containers: [], serials: [],
        }],
      }, { canOverrideCreditHold: false });
      const gl = await prisma.glAccount.create({ data: { name: `ICF-GL-${seq}`, description: "Sales" } });
      const code = await prisma.processStepCode.create({ data: { code: `AUST${seq}`, name: "Austemper", glAccountId: gl.id } });
      await asSystem(() => addPartPrice(part.id, {
        processStepCodeId: code.id, position: 1, unitPrice: "1.0000", minimumCharge: null, pricePer: "EACH",
      }));
      await asSystem(() => createSurcharge({ name: "Energy", kind: "PERCENT", rate: "0.050000", position: 1, scope: "ALL" }));
      const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
      return { customer, part, address, invoice };
    }

    // Reds when the paper reads a live value off the claimed row: measured with
    // `invoicePdfDataFromDetail`'s `billTo` made `[detail.customerName, ...splitAddress(detail.billTo)]`
    // (the claim's include selects the live `customer.name`), under which "Renamed Customer" prints.
    it("a part renamed, a bill-to address changed, a customer renamed and a surcharge rate changed after create print the snapshot through printInvoice under the canvas, as under the flow", async () => {
      const { customer, part, address, invoice } = await frozenInvoice();
      expect(invoice.lines.find((l) => l.kind === "SURCHARGE")?.amount).toBe(0.5);

      await prisma.part.update({ where: { id: part.id }, data: { partNumber: "RENAMED-77", name: "Renamed Part" } });
      await prisma.customerAddress.update({ where: { id: address.id }, data: { street: "999 Moved Avenue" } });
      await prisma.customer.update({ where: { id: customer.id }, data: { name: "Renamed Customer" } });
      await prisma.surcharge.updateMany({ data: { rate: "0.200000", name: "Renamed Surcharge" } });

      // One draft, printed twice (open question 13): under the Standard with nothing assigned, then
      // under the canvas once its customer is assigned the canvas template.
      const flowPrint = await asSystem(() => printInvoice(invoice.id));
      const versionId = await publishInvoiceCanvas(customer.id, standardInvoiceLayout());
      const canvasPrint = await asSystem(() => printInvoice(invoice.id));

      const flow = await storedPrint(flowPrint.documentId);
      const canvas = await storedPrint(canvasPrint.documentId);
      expect(flow.templateVersionId).toBe(await standardInvoiceVersionId());
      expect(canvas.templateVersionId).toBe(versionId);
      for (const paper of [flow.bytes, canvas.bytes]) {
        const lines = lineTexts(paper);
        const text = lines.join("\n");
        expect(text).toContain("P-CANVAS-1");
        expect(text).toContain("EQUALIZER-RR SUSP");
        expect(text).toContain("500 Example Street");
        expect(text).toContain("Invoice Canvas Customer");
        expect(lines).toContain("Energy$0.50");
        for (const live of ["RENAMED-77", "Renamed Part", "999 Moved Avenue", "Renamed Customer", "Renamed Surcharge", "$2.00"]) {
          expect(text, live).not.toContain(live);
        }
      }
    });
  });
});

// -------------------------------------------------------------------------------------------
// Task 5: Print selected (#591) and the customer's folder (#588) on a canvas template. Every
// customer here is assigned a published `standardInvoiceLayout()` template, and every case that
// stores a document asserts the stored row's `templateVersionId` is that version, so a print that
// silently resolved to the Standard reds (the plan's Calls). The cases are copies of
// tests/invoice-pdf.test.ts's, green on arrival (design call 14: the canvas adds no read); each
// names the mutation that reds it.
// -------------------------------------------------------------------------------------------

const selectedUrl = (id: string) => `http://t/api/invoices/${id}/print?selected=1`;
const singleUrl = (id: string) => `http://t/api/invoices/${id}/print`;
const printer = () => signInWith(["invoicing.view", "invoicing.create"], "selected-printer");

/** Every StoredDocument of an invoice row: its stamp alone. */
const storedStamps = async (invoiceId: string) =>
  (await prisma.storedDocument.findMany({ where: { invoiceId }, select: { templateVersionId: true } }))
    .map((d) => d.templateVersionId);

describe("printSelectedInvoice on a canvas template (#591)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  // Reds when `printInvoiceInTx`'s `selectedPrintRefusal` check is deleted, and when
  // `printSelectedInvoice` passes `"single"` for `"selected"`: the draft prints (200) and stores a
  // document. Measured 2026-11-11, each run once and restored. The not-finalized refusals fire
  // before the template is resolved, so the canvas takes no part in them; the already-printed ones
  // are judged against a prior print on the canvas, whose stamp is asserted.
  it("Print selected refuses a draft and an invoice printed since its finalize, on a canvas template, storing nothing", async () => {
    await asSystem(() => setSetting("credit_number_next", 5000)); // apart from the order numbers
    const cookie = await printer();

    // A draft invoice, and a draft credit of a finalized invoice: the not-finalized sentence.
    const draft = await shippedInvoice();
    await publishInvoiceCanvas(draft.customer.id, standardInvoiceLayout());
    const draftRes = await printRoute(postReq(selectedUrl(draft.invoice.id), cookie), withParams({ id: draft.invoice.id }));
    expect(draftRes.status).toBe(400);
    expect(await draftRes.json()).toEqual({ error: notFinalized(draft.order.orderNumber) });
    expect(await storedStamps(draft.invoice.id)).toEqual([]);

    const fin = await finalizedInvoice();
    const versionId = await publishInvoiceCanvas(fin.customer.id, standardInvoiceLayout());
    const draftCredit = await asSystem(() => createCredit(fin.invoice.id));
    const draftCreditRes = await printRoute(postReq(selectedUrl(draftCredit.id), cookie), withParams({ id: draftCredit.id }));
    expect(draftCreditRes.status).toBe(400);
    expect(await draftCreditRes.json()).toEqual({ error: notFinalized(draftCredit.creditNumber!, "Credit") });
    expect(await storedStamps(draftCredit.id)).toEqual([]);

    // A finalized invoice and a finalized credit, each printed once on the canvas since its
    // finalize: the already-printed sentence, and no second document.
    await asSystem(() => printInvoice(fin.invoice.id));
    const printedRes = await printRoute(postReq(selectedUrl(fin.invoice.id), cookie), withParams({ id: fin.invoice.id }));
    expect(printedRes.status).toBe(400);
    expect(await printedRes.json()).toEqual({ error: alreadyPrinted(fin.order.orderNumber) });
    expect(await storedStamps(fin.invoice.id)).toEqual([versionId]);

    await asSystem(() => finalizeInvoice(draftCredit.id));
    await asSystem(() => printInvoice(draftCredit.id));
    const creditRes = await printRoute(postReq(selectedUrl(draftCredit.id), cookie), withParams({ id: draftCredit.id }));
    expect(creditRes.status).toBe(400);
    expect(await creditRes.json()).toEqual({ error: alreadyPrinted(draftCredit.creditNumber!, "Credit") });
    expect(await storedStamps(draftCredit.id)).toEqual([versionId]);
  });

  // DANGEROUS DIRECTION, tests/invoice-pdf.test.ts's case copied whole onto a canvas template (its
  // comment there says why SSI, not the claim, stops the second copy). The template is published
  // and assigned BEFORE the late transaction fixes its snapshot: an assignment written after it
  // would leave the late print resolving the Standard from that snapshot.
  //
  // Measured 2026-11-11 on PostgreSQL 18, each run once and restored (the task 5 report):
  //   - `printSelectedInvoice` at Repeatable Read: the late print files a second copy. RED (two
  //     documents), and the concurrent case below reds with it.
  //   - the selected check's document read on `prisma` instead of `tx`: the late print reads the
  //     first print's committed document outside its snapshot and answers the already-printed 400
  //     where P2034 is expected. RED.
  //   - `"single"` for `"selected"` in `printSelectedInvoice` (both branches): the late print reads
  //     no document, so there is no cycle, and it files a second copy. RED.
  it("DANGEROUS-DIRECTION on a canvas template: a selected print that commits after another fixed its snapshot aborts the other, and one document is stored", async () => {
    const { customer, invoice } = await finalizedInvoice();
    const versionId = await publishInvoiceCanvas(customer.id, standardInvoiceLayout());
    let snapshotFixed!: () => void;
    const fixed = new Promise<void>((r) => { snapshotFixed = r; });
    let mayPrint!: () => void;
    const go = new Promise<void>((r) => { mayPrint = r; });

    const late = asSystem(() => prisma.$transaction(async (tx) => {
      await tx.invoice.findFirst({ where: { id: invoice.id }, select: { id: true } }); // fixes the snapshot
      snapshotFixed();
      await go;
      return printSelectedInvoice(invoice.id, tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000 }))
      .then(() => "printed" as const, (e: unknown) => e);
    await fixed;
    try {
      await asSystem(() => printSelectedInvoice(invoice.id)); // prints and commits
    } finally {
      mayPrint();
    }

    const outcome = await late;
    measured("the late canvas selected print's end", outcome instanceof Prisma.PrismaClientKnownRequestError
      ? { code: outcome.code, meta: outcome.meta } : String(outcome));
    expect(outcome).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((outcome as Prisma.PrismaClientKnownRequestError).code).toBe("P2034");
    expect(await storedStamps(invoice.id)).toEqual([versionId]);
  });

  // What the retry buys (`retryOnSerializationConflict` in `printSelectedInvoice`), which #591's
  // STANDING INVARIANT relies on: tests/invoice-pdf.test.ts's case copied, its comment's reasoning
  // with it. A gate holds the order row so both prints fix their snapshots at the stub read and
  // park on `claimOrder`; the winner holds both claims to its commit, the loser wakes on its old
  // snapshot, inserts, and SSI aborts it; its retry's fresh snapshot answers the owner's sentence.
  // The template is published and assigned before the gate. Measured 2026-11-11, each run once and
  // restored: with the retry removed the loser answers withDbErrors' 409 (RED); with
  // `printSelectedInvoice` at Repeatable Read, with the selected check deleted, and with `"single"`
  // for `"selected"`, both print and two documents are stored (RED). Both
  // prints run on Prisma's five-second interactive-transaction default, the parked wait included,
  // so a slow runner can red here with P2028 (the budget spent), which is not an SSI outcome; the
  // fixture stays at one part so the canvas render stays small.
  it("two selected prints of one canvas invoice at once: one prints, the other answers the already-printed sentence, and one document is stored", async () => {
    const { customer, invoice, order } = await finalizedInvoice();
    const versionId = await publishInvoiceCanvas(customer.id, standardInvoiceLayout());
    let gateHeld!: () => void;
    const held = new Promise<void>((r) => { gateHeld = r; });
    let releaseGate!: () => void;
    const release = new Promise<void>((r) => { releaseGate = r; });
    const gate = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
      gateHeld();
      await release;
    }, { timeout: 30_000 });
    await held;

    // Started inside the `try`, so the gate is released whatever happens here.
    let both!: Promise<PromiseSettledResult<unknown>[]>;
    let parked = false;
    try {
      both = Promise.allSettled([
        asSystem(() => printSelectedInvoice(invoice.id)),
        asSystem(() => printSelectedInvoice(invoice.id)),
      ]);
      parked = await waitForLockWaiters(2, `"Order"`, `"id" = $1`, "FOR UPDATE");
    } finally {
      releaseGate();
      await gate;
    }
    expect(parked).toBe(true);

    const results = await both;
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(HttpError);
    expect((rejected[0].reason as HttpError).status).toBe(400);
    expect((rejected[0].reason as HttpError).message).toBe(alreadyPrinted(order.orderNumber));
    expect(await storedStamps(invoice.id)).toEqual([versionId]);
  });
});

describe("the customer's folder copy on a canvas template (#588)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });
  const dirs = withShare();

  /** What the customer's folder holds, by name: a temp file left behind is a dotfile among them. */
  const filedNames = async () => (await readdir(dirs.acme)).sort();
  /** The stored row a print answered with: its bytes and its stamp. */
  const storedOf = (res: Response) => storedPrint(res.headers.get("x-document-id")!);

  // Each FINALIZED case below reds when the route's `fileCustomerCopy` call is removed (nothing
  // filed, and the refused share's sentence absent), measured 2026-11-11; the draft case, which
  // files nothing either way, instead reds when `filing` is set for any status.
  it("a FINALIZED canvas invoice lands in the customer's folder as Invoice-<order#>.pdf, the stored bytes", async () => {
    const { customer, invoice, order } = await finalizedInvoice();
    const versionId = await publishInvoiceCanvas(customer.id, standardInvoiceLayout());
    await fileIn(customer.id);
    const res = await printRoute(postReq(singleUrl(invoice.id), await signInWith(["invoicing.view"])), withParams({ id: invoice.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-print-warnings")).toBeNull();
    const stored = await storedOf(res);
    expect(stored.templateVersionId).toBe(versionId);
    const name = `Invoice-${order.orderNumber}.pdf`;
    expect(await filedNames()).toEqual([name]);
    expect(Buffer.compare(await readFile(path.join(dirs.acme, name)), stored.bytes)).toBe(0);
    expect(dirs.logSpy).not.toHaveBeenCalled();
  });

  it("a selected print files its copy too", async () => {
    const { customer, invoice, order } = await finalizedInvoice();
    const versionId = await publishInvoiceCanvas(customer.id, standardInvoiceLayout());
    await fileIn(customer.id);
    const res = await printRoute(postReq(selectedUrl(invoice.id), await printer()), withParams({ id: invoice.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-print-warnings")).toBeNull();
    const stored = await storedOf(res);
    expect(stored.templateVersionId).toBe(versionId);
    const name = `Invoice-${order.orderNumber}.pdf`;
    expect(await filedNames()).toEqual([name]);
    expect(Buffer.compare(await readFile(path.join(dirs.acme, name)), stored.bytes)).toBe(0);
    expect(dirs.logSpy).not.toHaveBeenCalled();
  });

  it("a finalized canvas credit lands as Credit-<credit#>.pdf", async () => {
    // Both counters start at 1000 on a fresh database: set apart, a credit filed under its order's
    // number shows.
    await asSystem(() => setSetting("credit_number_next", 7000));
    const { customer, invoice, order } = await finalizedInvoice();
    const versionId = await publishInvoiceCanvas(customer.id, standardInvoiceLayout());
    const credit = await asSystem(() => createCredit(invoice.id));
    await asSystem(() => finalizeInvoice(credit.id));
    expect(credit.creditNumber).not.toBe(order.orderNumber);
    await fileIn(customer.id);
    const res = await printRoute(postReq(singleUrl(credit.id), await signInWith(["invoicing.view"])), withParams({ id: credit.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-print-warnings")).toBeNull();
    const stored = await storedOf(res);
    expect(stored.kind).toBe("CREDIT");
    expect(stored.templateVersionId).toBe(versionId);
    const name = `Credit-${credit.creditNumber}.pdf`;
    expect(await filedNames()).toEqual([name]);
    expect(Buffer.compare(await readFile(path.join(dirs.acme, name)), stored.bytes)).toBe(0);
  });

  // Reds when `printInvoiceInTx` sets `filing` for any status (the FINALIZED test dropped): the
  // draft's print is filed as Invoice-<order#>.pdf. Measured 2026-11-11.
  it("a draft canvas invoice's print files nothing", async () => {
    const { customer, invoice } = await shippedInvoice();
    const versionId = await publishInvoiceCanvas(customer.id, standardInvoiceLayout());
    await fileIn(customer.id);
    const res = await printRoute(postReq(singleUrl(invoice.id), await signInWith(["invoicing.view"])), withParams({ id: invoice.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-print-warnings")).toBeNull();
    expect((await storedOf(res)).templateVersionId).toBe(versionId);
    expect(await filedNames()).toEqual([]);
    expect(dirs.logSpy).not.toHaveBeenCalled();
  });

  it("a second finalized print replaces the filed copy with its own bytes", async () => {
    const { customer, invoice, order } = await finalizedInvoice();
    const versionId = await publishInvoiceCanvas(customer.id, standardInvoiceLayout());
    await fileIn(customer.id);
    const cookie = await signInWith(["invoicing.view"]);
    const name = `Invoice-${order.orderNumber}.pdf`;
    const first = await printRoute(postReq(singleUrl(invoice.id), cookie), withParams({ id: invoice.id }));
    expect(Buffer.compare(await readFile(path.join(dirs.acme, name)), (await storedOf(first)).bytes)).toBe(0);
    // Two renders of one invoice can be byte-identical, so the first copy is overwritten with other
    // bytes: only the second print's own copy can make the file its stored bytes again.
    await writeFile(path.join(dirs.acme, name), "an older copy");
    const second = await printRoute(postReq(singleUrl(invoice.id), cookie), withParams({ id: invoice.id }));
    expect(second.headers.get("x-document-id")).not.toBe(first.headers.get("x-document-id"));
    expect(second.headers.get("x-print-warnings")).toBeNull();
    const stored = await storedOf(second);
    expect(stored.templateVersionId).toBe(versionId);
    expect(await filedNames()).toEqual([name]);
    expect(Buffer.compare(await readFile(path.join(dirs.acme, name)), stored.bytes)).toBe(0);
  });

  // #588's "never fails the print". Reds when the route drops its `x-print-warnings` spread (the
  // header is null), measured 2026-11-11. The marker-missing path answers its sentence from
  // `copyChain`, not from `fileCustomerCopy`'s outer belt (src/server/customer-folders.ts), so making
  // that belt rethrow does not reach this case: the 200-and-stored half holds by construction.
  it("a FINALIZED canvas print whose share refuses the copy still answers 200, stores its document and carries one x-print-warnings sentence", async () => {
    const { customer, invoice, order } = await finalizedInvoice();
    const versionId = await publishInvoiceCanvas(customer.id, standardInvoiceLayout());
    await fileIn(customer.id);
    await rm(path.join(dirs.share, CUSTOMER_FOLDERS_MARKER));
    const res = await printRoute(postReq(singleUrl(invoice.id), await signInWith(["invoicing.view"])), withParams({ id: invoice.id }));
    expect(res.status).toBe(200);
    const stored = await storedOf(res);
    expect(stored.templateVersionId).toBe(versionId);
    expect(Buffer.compare(stored.bytes, Buffer.from(await res.arrayBuffer()))).toBe(0);
    const header = res.headers.get("x-print-warnings");
    expect(header).toBe(encodeURIComponent(JSON.stringify([PRINT_NOT_CONNECTED])));
    expect(JSON.parse(decodeURIComponent(header!))).toEqual([PRINT_NOT_CONNECTED]);
    expect(await filedNames()).toEqual([]);
    expect(dirs.logSpy.mock.calls).toEqual([[`[customer-folders] Invoice-${order.orderNumber}.pdf not filed: the marker file: ENOENT`]]);
  });
});

// The print's budget through both print paths (design 2026-11-10 §5.4 and call 15; invoice canvas
// PR 3, Task 6). Run on purpose, on mains at the Performance profile with both runner slots paused:
// CANVAS_TIMING=1 npx vitest run tests/invoice-canvas-print.test.ts -t "CANVAS timing" --reporter=verbose --silent=false
// The -t filter is what makes A's first figure "the process's first render" (its label below): run
// without it, the file's earlier cases render first and that label is false.
// No time is asserted: every figure is logged as it lands, for the controller to read against 2.5 s
// at §5.4's size (100 part lines, 300 operations, 20 surcharge and 20 charge lines), flow and canvas,
// first print and reprint. The fixture is `budgetInvoice`'s, whose OPERATION lines take a quote source
// and whose surcharge and charge lines are written directly AFTER finalize, so the stored totals omit
// the 40 added lines: a fixture artifact of a timing case (plan open question 6).
describe("the invoice canvas print's budget (design 2026-11-10 §5.4)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  /** Times one whole print call, logging its figure with the stored document's page count as it
   *  lands. A P2028 (an expired transaction, Prisma's five-second default spent) is logged as an
   *  over-5 s figure and answers null, so the figures after it still print; any other throw logs its
   *  time and propagates. */
  async function timed(label: string, run: () => Promise<{ documentId: string }>): Promise<{ documentId: string } | null> {
    const started = performance.now();
    try {
      const result = await run();
      const ms = Math.round(performance.now() - started);
      const pages = pageCount((await getDocument(result.documentId)).fileData);
      console.log(`CANVAS timing: ${label}; ${pages} page(s) in ${ms} ms`);
      return result;
    } catch (error) {
      const ms = Math.round(performance.now() - started);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2028") {
        console.log(`CANVAS timing: ${label}; P2028, the transaction expired (over 5 s) after ${ms} ms: ${error.message}`);
        return null;
      }
      console.log(`CANVAS timing: ${label} threw after ${ms} ms`);
      throw error;
    }
  }

  /** The stored row's version stamp. */
  const stampOf = async (documentId: string) => (await prisma.storedDocument.findUniqueOrThrow({
    where: { id: documentId }, select: { templateVersionId: true },
  })).templateVersionId;

  it.skipIf(process.env.CANVAS_TIMING !== "1")("CANVAS timing: an invoice canvas print through printInvoice and printSelectedInvoice", async () => {
    // Six finalized invoices of §5.4's size (plan open question 5): A and B for the single path, C
    // and C2 on A's customer and D and D2 on B's for the selected path, where one invoice prints once.
    const a = await budgetInvoice();
    const flowCustomer = await prisma.customer.findUniqueOrThrow({ where: { id: a.customerId } });
    const b = await budgetInvoice();
    const canvasCustomer = await prisma.customer.findUniqueOrThrow({ where: { id: b.customerId } });
    const c = await budgetInvoice(flowCustomer);
    const c2 = await budgetInvoice(flowCustomer);
    const d = await budgetInvoice(canvasCustomer);
    const d2 = await budgetInvoice(canvasCustomer);
    for (const inv of [a, b, c, c2, d, d2]) {
      expect(inv.status).toBe("FINALIZED");
      const count = (kind: string) => inv.lines.filter((l) => l.kind === kind).length;
      expect([count("PART"), count("OPERATION"), count("SURCHARGE"), count("CHARGE")]).toEqual([100, 300, 20, 20]);
      expect(inv.lines.filter((l) => l.kind === "OPERATION").every((l) => l.priceSource === "QUOTE")).toBe(true);
    }
    const standard = await standardInvoiceVersionId();
    const results: { label: string; documentId: string | null; expected: "flow" | "canvas" }[] = [];
    const run = async (label: string, expected: "flow" | "canvas", call: () => Promise<{ documentId: string }>) => {
      const result = await timed(label, call);
      results.push({ label, documentId: result?.documentId ?? null, expected });
    };

    // A's two prints come before the seed, whose stand-in render would otherwise be the process's
    // first: so A's first figure is the process's first render (module load, fonts, cold caches).
    await run("100 parts, 300 operations, 20 surcharges, 20 charges; single path; flow (A) print 1, the process's first render", "flow",
      () => asSystem(() => printInvoice(a.id)));
    await run("100 parts, 300 operations, 20 surcharges, 20 charges; single path; flow (A) print 2", "flow",
      () => asSystem(() => printInvoice(a.id)));

    // The canvas: the layout seeded once from a one-part draft, published once and assigned to B's customer.
    const small = await shippedInvoice();
    const layout = await seedInvoiceLayout(small.invoice.id, structuredClone(INVOICE_DEFAULT_CONFIG), undefined);
    const canvas = await publishInvoiceCanvas(canvasCustomer.id, layout);

    // B1 is a warm-path figure, not a cold canvas print: the seed's stand-in render above ran the
    // canvas render path first.
    await run("100 parts, 300 operations, 20 surcharges, 20 charges; single path; canvas (B) print 1", "canvas",
      () => asSystem(() => printInvoice(b.id)));
    await run("100 parts, 300 operations, 20 surcharges, 20 charges; single path; canvas (B) print 2", "canvas",
      () => asSystem(() => printInvoice(b.id)));
    await run("100 parts, 300 operations, 20 surcharges, 20 charges; selected path; flow (C) print 1", "flow",
      () => asSystem(() => printSelectedInvoice(c.id)));
    await run("100 parts, 300 operations, 20 surcharges, 20 charges; selected path; flow (C2) print 2", "flow",
      () => asSystem(() => printSelectedInvoice(c2.id)));
    await run("100 parts, 300 operations, 20 surcharges, 20 charges; selected path; canvas (D) print 1", "canvas",
      () => asSystem(() => printSelectedInvoice(d.id)));
    await run("100 parts, 300 operations, 20 surcharges, 20 charges; selected path; canvas (D2) print 2", "canvas",
      () => asSystem(() => printSelectedInvoice(d2.id)));

    // Each document is stamped with the version it was meant to print: the canvas's, or the Standard's.
    // Red when `publishInvoiceCanvas` assigns nothing (its `assignTemplate` dropped,
    // tests/helpers/invoice-print-fixtures.ts): B, D and D2 then print under the Standard.
    for (const r of results) {
      if (r.documentId === null) continue; // a P2028, logged above: a STOP for the controller
      expect(await stampOf(r.documentId), r.label).toBe(r.expected === "canvas" ? canvas : standard);
    }

    // A selected reprint of C, refused when C's print landed ("printed since it was finalized"):
    // logged, never judged, so no figure above is lost to it.
    const refusedStart = performance.now();
    const refusal = await asSystem(() => printSelectedInvoice(c.id)).then(() => null, (e: unknown) => e);
    const answer = refusal instanceof HttpError ? `${refusal.status}: ${refusal.message}` : refusal === null ? "printed" : String(refusal);
    console.log(`CANVAS timing: selected reprint of C answered (${answer}) in ${Math.round(performance.now() - refusedStart)} ms (not judged)`);
  }, 600_000);
});
