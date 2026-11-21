import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { pageCount, paintedImageCounts, paintedImages, textLinesWithY, tinyAlphaPng } from "./helpers/pdf";
import { standardQuoteLayout } from "./helpers/quote-canvas-fixtures";
import {
  makeBillTo, makeCustomer, makeSurcharge, publishQuoteTemplate, quoteFor, quoteLayoutWithLogo,
} from "./helpers/quote-print-fixtures";
import { runWithContext } from "@/server/context";
import { closeQuote, deleteQuote, getQuote, printQuote, quotePrintSettings, readQuotePdfData, updateQuote } from "@/server/quotes";
import { getDocument, VOIDED_PRINT } from "@/server/documents";
import { seedQuoteLayout } from "@/server/quote-canvas-seed";
import { renderPreview } from "@/server/template-preview";
import { isExpiredTransaction } from "@/server/db-errors";
import { Prisma } from "../prisma/generated/prisma/client";
import { renderPdf } from "@/server/pdf/render";
import { buildQuoteDefinition } from "@/server/pdf/quote";
import { POST as printQuoteRoute } from "@/app/api/quotes/[id]/print/route";
import { canvasRefusal, canvasWarnings } from "@/lib/template-canvas";
import { QUOTE_CONTRACT } from "@/lib/template-contracts/quote";
import { QUOTE_DEFAULT_CONFIG } from "@/lib/template-contracts/index";
import { addDays, todayDateOnly } from "@/lib/business-days";
import type { CanvasBox, CanvasLayout } from "@/lib/template-contracts/canvas";

/**
 * The print path on a canvas template (since quote canvas PR 2; design 2026-11-12 §5.1 and §11: the
 * canvas adds no read and no data source, and `printQuote` changes in its `templatePlacesLogo` import,
 * its logo line and that line's comment alone). Each print case reads the STORED document's bytes and
 * proves which template produced it by its `templateVersionId`, asserted EQUAL to the specific
 * published version it expects (never `.not.toBe(...)`, which a null passes), so an assignment that
 * silently resolved to another template cannot pass for the right one.
 *
 * Every stamp below is red when `printQuote` resolves its template on no customer
 * (`resolveTemplateForPrint(tx, "QUOTE", null)`: the Standard's stamp), the task's mutation 3, which
 * is the witness for every case whose paint or lines no mutation of the logo line reds.
 */

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

/** The stored row of a print: its bytes and its stamp. */
async function storedPrint(documentId: string) {
  const bytes = (await getDocument(documentId)).fileData;
  const row = await prisma.storedDocument.findUniqueOrThrow({
    where: { id: documentId }, select: { kind: true, quoteId: true, templateVersionId: true },
  });
  return { bytes, ...row };
}

/** Every printed line of every page, in page order, its text alone. */
const lineTexts = (pdf: Buffer): string[] => textLinesWithY(pdf).flat().map((l) => l.text);

/** The default QUOTE template's published version (the Standard's). */
async function standardVersionId(): Promise<string | null> {
  return (await prisma.documentTemplate.findFirstOrThrow({
    where: { docType: "QUOTE", isDefault: true, deletedAt: null },
  })).publishedVersionId;
}

/** The Logo item's drawn box in a layout. */
function logoBox(layout: CanvasLayout): CanvasBox {
  const item = layout.items.find((i) => i.kind === "logo");
  if (item === undefined) throw new Error("the layout holds no Logo item");
  return item.box;
}

/** A customer of its own with its default bill-to and a one-line quote. */
async function quotedCustomer(opts: { surchargeOptOut?: boolean; lines?: number } = {}) {
  const customer = await makeCustomer({ surchargeOptOut: opts.surchargeOptOut });
  await makeBillTo(customer.id);
  const quote = await quoteFor(customer, { lines: opts.lines });
  return { customer, quote };
}

/** The image painted on page 1 sits at `box`, within 1 pt (`logoContent` fits the image to the item's
 *  box, so a square image in a square box is the whole box; top-down y). */
function expectImageAt(bytes: Buffer, box: CanvasBox) {
  expect(paintedImageCounts(bytes)).toEqual([1]);
  const [[image]] = paintedImages(bytes);
  expect(Math.abs(image.x - box.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(image.y - box.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(image.w - box.w)).toBeLessThanOrEqual(1);
  expect(Math.abs(image.h - box.h)).toBeLessThanOrEqual(1);
}

describe("printQuote with a canvas template", () => {
  beforeEach(async () => { await truncateAll(); });

  // Reds when `printQuote`'s logo test goes back to `resolved.config.logo !== null` (the flow's header
  // slot alone): the Logo item's config carries `logo: null`, so no data URI reaches the builder and
  // the page paints nothing ([0]).
  it("a canvas Logo item prints on the stored quote", async () => {
    const layout = quoteLayoutWithLogo();
    const options = { pageFooter: QUOTE_DEFAULT_CONFIG.pageFooter, fonts: QUOTE_DEFAULT_CONFIG.fonts };
    expect(canvasRefusal(layout, QUOTE_CONTRACT, options)).toBeNull();
    expect(canvasWarnings(layout, QUOTE_CONTRACT, undefined, options).filter((w) => w.itemIds.includes("logo"))).toEqual([]);
    const { customer, quote } = await quotedCustomer();
    const versionId = await publishQuoteTemplate("Canvas logo", [customer.id], layout, tinyAlphaPng());

    const { documentId } = await asSystem(() => printQuote(quote.id));
    const stored = await storedPrint(documentId);
    expect(stored.kind).toBe("QUOTE");
    expect(stored.quoteId).toBe(quote.id);
    expect(stored.templateVersionId).toBe(versionId);
    expectImageAt(stored.bytes, logoBox(layout));
  }, 60_000);

  // Its paint is a pin: no mutation of the print's logo line reds it, the old test
  // (`config.logo !== null`) and the conjunct dropped (`logoImage !== null` alone) both painting
  // nothing here, since the canvas paints only a placed Logo item. Its stamps are mutation 3's
  // witness (resolved on no customer: the Standard's stamp).
  it("a canvas with no Logo item paints none, for a template that carries an upload and one that carries none, the paint a pin", async () => {
    // Each half on a customer and a template of its own: one published with the upload on file, one with none.
    for (const [name, logo] of [["upload", tinyAlphaPng()], ["no upload", undefined]] as const) {
      const { customer, quote } = await quotedCustomer();
      const versionId = await publishQuoteTemplate(`Canvas ${name}`, [customer.id], standardQuoteLayout(), logo);

      const { documentId } = await asSystem(() => printQuote(quote.id));
      const stored = await storedPrint(documentId);
      expect(stored.templateVersionId, name).toBe(versionId);
      expect(paintedImageCounts(stored.bytes), name).toEqual([0]);
    }
  }, 60_000);

  // The flow side of the logo line: on a flow config (`layout` null) `templatePlacesLogo` is
  // `config.logo !== null`, so an upload the config does not place converts nothing and paints nothing.
  // Its paint is a pin (no mutation of the logo line reds it); its stamp is mutation 3's witness.
  it("a flow template with an upload on file and `logo` null paints none, the paint a pin", async () => {
    const { customer, quote } = await quotedCustomer();
    const versionId = await publishQuoteTemplate("Flow upload", [customer.id], null, tinyAlphaPng());

    const { documentId } = await asSystem(() => printQuote(quote.id));
    const stored = await storedPrint(documentId);
    expect(stored.templateVersionId).toBe(versionId);
    expect(paintedImageCounts(stored.bytes)).toEqual([0]);
  }, 60_000);

  // Reds when `printQuote` resolves its template on no customer (the canvas customer's print then
  // stamps the Standard's version).
  it("the stamp: a canvas print carries the canvas version, and a customer with no assignment prints the Standard's", async () => {
    const onCanvas = await quotedCustomer();
    const unassigned = await quotedCustomer();
    const canvas = await publishQuoteTemplate("Stamp canvas", [onCanvas.customer.id], standardQuoteLayout());
    const standard = await standardVersionId();
    expect(standard).not.toBeNull();
    expect(canvas).not.toBe(standard);

    const printedCanvas = await storedPrint((await asSystem(() => printQuote(onCanvas.quote.id))).documentId);
    expect(printedCanvas.templateVersionId).toBe(canvas);
    const printedStandard = await storedPrint((await asSystem(() => printQuote(unassigned.quote.id))).documentId);
    expect(printedStandard.templateVersionId).toBe(standard);
  }, 60_000);

  // (pin) The claim and `assertPrintable` are untouched: a deleted quote is refused on a canvas as in
  // the flow, before anything renders, stores or audits.
  it("(pin) a deleted quote on a canvas is refused in the shared voided-print 400, storing and auditing nothing", async () => {
    const { customer, quote } = await quotedCustomer();
    await publishQuoteTemplate("Deleted canvas", [customer.id], quoteLayoutWithLogo(), tinyAlphaPng());
    await asSystem(() => deleteQuote(quote.id, "typo"));

    await expect(asSystem(() => printQuote(quote.id))).rejects.toThrow(VOIDED_PRINT);
    await expect(asSystem(() => printQuote(quote.id))).rejects.toMatchObject({ status: 400 });
    expect(await prisma.storedDocument.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { entity: "storedDocument" } })).toBe(0);
  }, 60_000);

  // Closing forbids edits, not the paper, and "expired" is derived from the expiry date, never a
  // status: each prints on the canvas. Their stamps are mutation 3's witness.
  it("a closed quote and an expired quote each print on the canvas", async () => {
    const closed = await quotedCustomer();
    const expired = await quotedCustomer();
    const versionId = await publishQuoteTemplate(
      "Closed and expired", [closed.customer.id, expired.customer.id], standardQuoteLayout(),
    );
    await asSystem(() => closeQuote(closed.quote.id, "won the business"));
    // A test write: the quote's dates moved into the past, so its expiry is behind today.
    await prisma.quote.update({
      where: { id: expired.quote.id },
      data: {
        quoteDate: addDays(todayDateOnly(), -60), effectiveDate: addDays(todayDateOnly(), -60),
        expiryDate: addDays(todayDateOnly(), -30),
      },
    });
    expect((await asSystem(() => getQuote(closed.quote.id))).status).toBe("CLOSED");
    expect((await asSystem(() => getQuote(expired.quote.id))).expired).toBe(true);

    for (const [name, quoteId] of [["closed", closed.quote.id], ["expired", expired.quote.id]] as const) {
      const stored = await storedPrint((await asSystem(() => printQuote(quoteId))).documentId);
      expect(stored.templateVersionId, name).toBe(versionId);
      expect(lineTexts(stored.bytes), name).toContain("Customer part name");
    }
  }, 60_000);

  // Through the route (design §11: "through `printQuote` and its route"). Its paint reds with the old
  // logo test restored, as the Logo item case does; its stamp is mutation 3's witness.
  it("the route prints a canvas quote: 200, its document stamped with the canvas and painting the Logo item", async () => {
    const layout = quoteLayoutWithLogo();
    const { customer, quote } = await quotedCustomer();
    const versionId = await publishQuoteTemplate("Route canvas", [customer.id], layout, tinyAlphaPng());
    const cookie = await signInWith(["quotes.view"], "quote-canvas-route");

    const res = await printQuoteRoute(new Request(`http://t/api/quotes/${quote.id}/print`, {
      method: "POST", headers: { cookie },
    }), { params: Promise.resolve({ id: quote.id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const documentId = res.headers.get("x-document-id");
    expect(documentId).not.toBeNull();
    const stored = await storedPrint(documentId!);
    expect(stored.templateVersionId).toBe(versionId);
    expectImageAt(stored.bytes, logoBox(layout));
  }, 60_000);

  // The customer's surcharge settings reach the canvas (design §11): the estimate rows come from the
  // same `readQuotePdfData`, so a customer taking Admin's surcharge prints its row under each line's
  // last price row, and an opted-out customer prints none. The rows are a pin (the canvas adds no
  // read); the stamps are mutation 3's witness.
  it("the customer's surcharge settings reach the canvas: a customer taking EnergySur prints its estimate under each line, one opted out prints none", async () => {
    await makeSurcharge("EnergySur", "0.040000");
    const taking = await quotedCustomer({ lines: 2 });
    const optedOut = await quotedCustomer({ lines: 2, surchargeOptOut: true });
    const versionId = await publishQuoteTemplate(
      "Surcharge canvas", [taking.customer.id, optedOut.customer.id], standardQuoteLayout(),
    );

    const stored = await storedPrint((await asSystem(() => printQuote(taking.quote.id))).documentId);
    expect(stored.templateVersionId).toBe(versionId);
    const [page] = textLinesWithY(stored.bytes);
    const estimates = page.filter((l) => l.text.startsWith("EnergySur 4% (estimate):"));
    expect(estimates.map((l) => l.text)).toEqual(["EnergySur 4% (estimate):$4.08", "EnergySur 4% (estimate):$4.08"]);
    // Each line's one price row (its step, Bake) prints above its own estimate, and the second line's
    // price row below the first line's estimate: price 1, estimate 1, price 2, estimate 2, top down
    // (a PDF's y grows upward, so the baselines fall).
    const prices = page.filter((l) => l.text.startsWith("Bake"));
    expect(prices).toHaveLength(2);
    const ys = [prices[0].y, estimates[0].y, prices[1].y, estimates[1].y];
    expect([...ys].sort((a, b) => b - a)).toEqual(ys);
    expect(new Set(ys).size).toBe(4);

    const none = await storedPrint((await asSystem(() => printQuote(optedOut.quote.id))).documentId);
    expect(none.templateVersionId).toBe(versionId);
    expect(lineTexts(none.bytes).filter((l) => l.includes("EnergySur"))).toEqual([]);
    expect(lineTexts(none.bytes).filter((l) => l.startsWith("Bake"))).toHaveLength(2);
  }, 60_000);

  // The quote is live paper on a canvas as in the flow: the second print reads the customer's current
  // bill-to and the quote's current notes, the lines a flow print of the same moment prints. Its lines
  // are a pin (no mutation of the logo line changes them, and the canvas adds no read and no data
  // source); its stamps are mutation 3's witness.
  it("a canvas quote is live paper: a second print carries the new street and notes, as a flow print of the same moment does, the lines a pin", async () => {
    const { customer, quote } = await quotedCustomer();
    const versionId = await publishQuoteTemplate("Live canvas", [customer.id], standardQuoteLayout());

    const first = await storedPrint((await asSystem(() => printQuote(quote.id))).documentId);
    expect(first.templateVersionId).toBe(versionId);
    expect(lineTexts(first.bytes)).toContain("700 Demo Drive");
    expect(lineTexts(first.bytes)).toContain("Our terms are net 30");

    // A test write of the default bill-to's street, and the quote's notes through its own mutator.
    await prisma.customerAddress.updateMany({
      where: { customerId: customer.id, kind: "BILL_TO", isDefault: true }, data: { street: "12 New Street" },
    });
    await asSystem(() => updateQuote(quote.id, { notes: "Prices firm for 60 days" }));

    const second = await storedPrint((await asSystem(() => printQuote(quote.id))).documentId);
    expect(second.templateVersionId).toBe(versionId);
    const lines = lineTexts(second.bytes);
    expect(lines).toContain("12 New Street");
    expect(lines).not.toContain("700 Demo Drive");
    expect(lines).toContain("Prices firm for 60 days");
    expect(lines).not.toContain("Our terms are net 30");

    // The flow's paper of the same moment prints the same two lines.
    const settings = await quotePrintSettings();
    const flowData = await readQuotePdfData(prisma, quote.id, {
      ...settings,
      introText: QUOTE_DEFAULT_CONFIG.textBlocks.quote_intro_text,
      liabilityText: QUOTE_DEFAULT_CONFIG.textBlocks.quote_liability_text,
    });
    const flowLines = lineTexts(await renderPdf(buildQuoteDefinition(flowData, QUOTE_DEFAULT_CONFIG)));
    expect(flowLines).toContain("12 New Street");
    expect(flowLines).toContain("Prices firm for 60 days");
  }, 60_000);
});

// The print's budget (design 2026-11-12 §5.4; since quote canvas PR 2). Run on purpose, on mains at the
// Performance profile with both runner slots paused and nothing else on `erp_test` or the host:
// CANVAS_TIMING=1 npx vitest run tests/quote-canvas-print.test.ts -t "CANVAS timing" --reporter=verbose --silent=false
// The -t filter is what makes pass F's first figure the process's first quote render: run without it,
// the file's earlier cases render first.
// ONE data set, built once (plan open question 6): a customer taking Admin's one PERCENT surcharge and
// three quotes of 1, 40 and 200 lines, each line two price rows (one EACH, one LB with two breaks) on
// two step codes, so every line prints one estimate row. Pass F prints each quote twice on the Standard
// (nothing assigned); then the canvas is seeded from the 1-line quote, published and assigned to the
// customer, and pass C prints the same quotes twice again. Each quote's preview, flow and canvas (the
// canvas's with its measure), is timed once beside them. Each print's Serializable transaction is
// timed by a property save/restore wrapper of `prisma.$transaction` (never `vi.spyOn`, CLAUDE.md),
// installed around the timed call alone. No time is asserted: every figure is logged for the
// controller to read against the plan's STOP rule (any one `printQuote` transaction over 2,500 ms, or
// an expired one, P2028). A P2028 ends its pass and fails the case as a STOP, with every figure taken
// so far logged; a print over 2,500 ms is logged as a STOP and the pass goes on. A preview over
// 2,500 ms is logged, never a STOP (the design's STOP names prints).
describe("the quote canvas print's budget (design 2026-11-12 §5.4)", () => {
  beforeEach(async () => { await truncateAll(); });

  const LINE_COUNTS = [1, 40, 200] as const;
  const STOP_MS = 2_500;

  type Pass = "F" | "C";
  /** One print's Serializable transaction, as the wrapper saw it. */
  type TxFigure = { pass: Pass; lines: number; print: number; pages: number | null; ms: number; outcome: string };
  /** A STOP raised inside a pass: it ends the pass, and the case fails on it after logging. */
  class StopSignal extends Error {}

  /**
   * Replaces `prisma.$transaction` with a wrapper that times every INTERACTIVE call whose options carry
   * `isolationLevel: Serializable` (the print's own: never the preview's RepeatableRead read, an
   * array-form call, the fixture writes or the publish), reporting each to `sink` once it settles: the
   * printed quote's page count, read from the transaction's own answer after the clock stops (no buffer
   * is kept), or, when it threw, the error. Answers the restore, which puts the client back as it was
   * found (the own property deleted when the method was the prototype's).
   */
  function recordSerializable(sink: (f: { pages: number | null; ms: number; error: unknown }) => void): () => void {
    const client = prisma as unknown as Record<string, unknown>;
    const hadOwn = Object.hasOwn(client, "$transaction");
    const original = client.$transaction as (...args: unknown[]) => Promise<unknown>;
    client.$transaction = (...args: unknown[]) => {
      const [first, options] = args as [unknown, { isolationLevel?: unknown } | undefined];
      if (typeof first !== "function" || options?.isolationLevel !== Prisma.TransactionIsolationLevel.Serializable) {
        return original.apply(prisma, args);
      }
      const body = first as (tx: unknown) => Promise<unknown>;
      let printed: { pdf: Buffer } | undefined;
      const started = performance.now();
      return original.apply(prisma, [async (tx: unknown) => {
        const answer = await body(tx);
        printed = answer as { pdf: Buffer };
        return answer;
      }, options]).then(
        (answer) => {
          const ms = performance.now() - started;
          sink({ pages: printed ? pageCount(printed.pdf) : null, ms, error: null });
          printed = undefined;
          return answer;
        },
        (error: unknown) => {
          const ms = performance.now() - started;
          sink({ pages: printed ? pageCount(printed.pdf) : null, ms, error });
          printed = undefined;
          throw error;
        },
      );
    };
    return () => {
      if (hadOwn) client.$transaction = original;
      else delete client.$transaction;
    };
  }

  it.skipIf(process.env.CANVAS_TIMING !== "1")("CANVAS timing: a quote canvas print at 1, 40 and 200 lines", async () => {
    // The one data set.
    await makeSurcharge("EnergySur", "0.040000");
    const customer = await makeCustomer();
    await makeBillTo(customer.id);
    const quotes: { lines: number; id: string }[] = [];
    for (const lines of LINE_COUNTS) quotes.push({ lines, ...(await quoteFor(customer, { lines, prices: 2 })) });
    const standard = await standardVersionId();
    expect(standard).not.toBeNull();

    const txFigures: TxFigure[] = [];
    const previews: { pass: Pass; lines: number; pages: number; ms: number; measured: boolean }[] = [];
    const stops: string[] = [];
    const documents: { pass: Pass; lines: number; print: number; documentId: string }[] = [];

    /** Times one `printQuote` whole and its Serializable transaction, logging the figure as it lands.
     *  A transaction over `STOP_MS` is recorded as a STOP and the pass goes on; a P2028 is recorded as
     *  a STOP and ends the pass once the print has thrown; any other throw propagates. */
    async function timedPrint(pass: Pass, lines: number, print: number, quoteId: string): Promise<void> {
      const stopsBefore = stops.length;
      let expiredStop = false;
      const restore = recordSerializable(({ pages, ms, error }) => {
        const expired = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2028";
        const outcome = error === null ? "ok" : expired ? `P2028${isExpiredTransaction(error) ? " (expired)" : ""}` : "threw";
        txFigures.push({ pass, lines, print, pages, ms, outcome });
        console.log(`CANVAS timing: pass ${pass}; ${lines} line(s); print ${print}; ${pages ?? "?"} page(s); transaction ${Math.round(ms)} ms${outcome === "ok" ? "" : `; ${outcome}`}`);
        if (expired) {
          expiredStop = true;
          stops.push(`pass ${pass}; ${lines} line(s); print ${print}; ${pages ?? "?"} page(s); ${Math.round(ms)} ms; P2028: ${(error as Error).message}`);
        } else if (ms > STOP_MS) {
          stops.push(`pass ${pass}; ${lines} line(s); print ${print}; ${pages ?? "?"} page(s); transaction ${Math.round(ms)} ms, over ${STOP_MS} ms`);
        }
      });
      let thrown: unknown = null;
      try {
        const { documentId } = await asSystem(() => printQuote(quoteId));
        documents.push({ pass, lines, print, documentId });
      } catch (error) {
        thrown = error;
      } finally {
        restore();
      }
      if (expiredStop) throw new StopSignal(stops.slice(stopsBefore).join(" | "));
      if (thrown !== null) throw thrown;
    }

    /** Times one preview of the quote under `config` (wall clock, no transaction of its own to time:
     *  its read is RepeatableRead), logging its pages and whether it answered a measure. */
    async function timedPreview(pass: Pass, lines: number, quoteId: string, config: unknown): Promise<void> {
      const started = performance.now();
      const { pdf, measure } = await renderPreview(
        { docType: "QUOTE", logoImage: null, logoMimeType: null }, { recordId: quoteId, config }, "nobody",
      );
      const ms = performance.now() - started;
      const pages = pageCount(pdf);
      previews.push({ pass, lines, pages, ms, measured: measure !== null });
      console.log(`CANVAS timing: preview ${pass}; ${lines} line(s); ${pages} page(s); ${Math.round(ms)} ms; measure ${measure === null ? "none" : "answered"}${ms > STOP_MS ? `; over ${STOP_MS} ms (recorded, not a STOP)` : ""}`);
    }

    /** Runs a pass's prints, each quote twice, ending the pass on a P2028 (logged) and propagating
     *  anything else. */
    async function guardedPass(pass: Pass): Promise<void> {
      try {
        for (const q of quotes) for (const print of [1, 2]) await timedPrint(pass, q.lines, print, q.id);
      } catch (error) {
        if (!(error instanceof StopSignal)) throw error;
        console.log(`CANVAS timing: STOP, pass ${pass} ended: ${error.message}`);
      }
    }

    let canvas: string | null = null;
    try {
      // Pass F: nothing assigned, the Standard. Its first figure is the process's first quote render
      // (module load, fonts, cold caches).
      await guardedPass("F");
      for (const q of quotes) await timedPreview("F", q.lines, q.id, structuredClone(QUOTE_DEFAULT_CONFIG));

      // The canvas: seeded once from the 1-line quote (a stand-in laid out at its least), published
      // once and assigned to the customer. The seed's render runs the canvas modules before pass C, so
      // C runs warm.
      const seedStarted = performance.now();
      const layout = await seedQuoteLayout(quotes[0].id, structuredClone(QUOTE_DEFAULT_CONFIG), undefined);
      console.log(`CANVAS timing: the seed (stand-in render, not judged) in ${Math.round(performance.now() - seedStarted)} ms`);
      canvas = await publishQuoteTemplate("Budget canvas", [customer.id], layout);

      // Pass C: the same quotes on the canvas, then each one's canvas preview with its measure. The
      // preview's config is the published one (`publishQuoteTemplate`'s: the Standard's, its logo
      // null, the seeded layout).
      await guardedPass("C");
      const canvasConfig = { ...structuredClone(QUOTE_DEFAULT_CONFIG), logo: null, layout };
      for (const q of quotes) await timedPreview("C", q.lines, q.id, canvasConfig);
    } finally {
      // Every figure, each canvas figure beside its flow figure, logged whatever ended the case.
      console.log("CANVAS timing: SUMMARY on erp_test. Pass F (the Standard) ran first and cold; then the flow previews; then the seed's stand-in render; then pass C (the canvas), warm; then the canvas previews.");
      for (const lines of LINE_COUNTS) {
        for (const print of [1, 2]) {
          const at = (pass: Pass) => txFigures.find((t) => t.pass === pass && t.lines === lines && t.print === print);
          const f = at("F");
          const c = at("C");
          const show = (t: TxFigure | undefined) => (t ? `${Math.round(t.ms)} ms, ${t.pages ?? "?"} page(s)${t.outcome === "ok" ? "" : `, ${t.outcome}`}` : "-");
          const ratio = f && c ? ` (C/F ${(c.ms / f.ms).toFixed(2)})` : "";
          console.log(`CANVAS timing: SUMMARY print; ${lines} line(s); print ${print}; F ${show(f)} | C ${show(c)}${ratio}`);
        }
        const pf = previews.find((p) => p.pass === "F" && p.lines === lines);
        const pc = previews.find((p) => p.pass === "C" && p.lines === lines);
        const showP = (p: typeof pf) => (p ? `${Math.round(p.ms)} ms, ${p.pages} page(s), measure ${p.measured ? "answered" : "none"}` : "-");
        console.log(`CANVAS timing: SUMMARY preview; ${lines} line(s); F ${showP(pf)} | C ${showP(pc)}`);
      }
      console.log(`CANVAS timing: SUMMARY STOPs: ${stops.length === 0 ? "none" : stops.join(" | ")}`);
    }

    // Each document is stamped with the version it was meant to print: the canvas's in pass C, the
    // Standard's in pass F. And every line prints its one estimate row on both papers (the fixture's
    // premise: a line count with no estimate rows would time a lighter quote than the plan's).
    expect(canvas).not.toBeNull();
    for (const d of documents) {
      const label = `pass ${d.pass}; ${d.lines} line(s); print ${d.print}`;
      const stored = await storedPrint(d.documentId);
      expect(stored.templateVersionId, label).toBe(d.pass === "C" ? canvas : standard);
      if (d.print === 1) {
        expect(lineTexts(stored.bytes).filter((l) => l.startsWith("EnergySur 4% (estimate):")), label).toHaveLength(d.lines);
      }
    }
    for (const p of previews) expect(p.measured, `preview ${p.pass}; ${p.lines} line(s)`).toBe(p.pass === "C");
    // No time is asserted. An expired transaction (P2028) fails the case, after every figure is logged;
    // a transaction over 2,500 ms is a STOP the log names, for the controller to read.
    expect(stops.filter((s) => s.includes("P2028"))).toEqual([]);
  }, 600_000);
});
