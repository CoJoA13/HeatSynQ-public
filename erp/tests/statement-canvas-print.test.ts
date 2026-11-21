import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { pageCount, paintedImageCounts, paintedImages, textLinesWithY, tinyAlphaPng } from "./helpers/pdf";
import { standardStatementLayout } from "./helpers/statement-canvas-fixtures";
import {
  applyCredit, bulkOpenItems, daysBack, finalizedCredit, finalizedInvoice, makeCustomer, payInvoice,
  publishStatementTemplate, setDefaultBillTo, statementLayoutWithLogo,
} from "./helpers/statement-print-fixtures";
import { runWithContext } from "@/server/context";
import {
  buildStatement, printStatement, printStatementsPerDivision, runStatements, type StatementData, type StatementOpts,
} from "@/server/statements";
import { seedStatementLayout } from "@/server/statement-canvas-seed";
import { isExpiredTransaction } from "@/server/db-errors";
import { Prisma } from "../prisma/generated/prisma/client";
import { getDocument } from "@/server/documents";
import { renderPdf } from "@/server/pdf/render";
import { buildStatementDefinition } from "@/server/pdf/statement";
import { POST as printStatementRoute } from "@/app/api/receivables/statements/route";
import { canvasRefusal, canvasWarnings } from "@/lib/template-canvas";
import { STATEMENT_CONTRACT } from "@/lib/template-contracts/statement";
import { STATEMENT_DEFAULT_CONFIG } from "@/lib/template-contracts/index";

/**
 * The print path on a canvas template (since statement canvas PR 2; design 2026-11-11 §5.1: the
 * canvas adds no read and no data source, and `printStatementInTx` changes in its logo line alone).
 * Each print case reads the STORED document's bytes and proves which template produced it by its
 * `templateVersionId`, asserted EQUAL to the specific published version it expects (never
 * `.not.toBe(...)`, which a null passes: the cert PR 2 Task 7 lesson), so an assignment that
 * silently resolved to another template cannot pass for the right one.
 */

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const UNCOMBINED: StatementOpts = { combineFamily: false, assessFinanceCharges: false };
const COMBINED: StatementOpts = { combineFamily: true, assessFinanceCharges: false };

/** The stored row of a print: its bytes and its stamp. */
async function storedPrint(documentId: string) {
  const bytes = (await getDocument(documentId)).fileData;
  const row = await prisma.storedDocument.findUniqueOrThrow({
    where: { id: documentId }, select: { kind: true, customerId: true, templateVersionId: true },
  });
  return { bytes, ...row };
}

/** Every printed line of page 1, its text alone. */
const lineTexts = (pdf: Buffer): string[] => textLinesWithY(pdf)[0].map((l) => l.text);

/** A customer of its own with one open invoice, so its statement has something to print. */
async function owingCustomer(code: string, total = 250) {
  const customer = await makeCustomer({ code });
  await finalizedInvoice(customer.id, { total, dueDate: daysBack(40) });
  return customer;
}

describe("printStatement with a canvas template", () => {
  beforeEach(async () => { await truncateAll(); });

  // Reds when `printStatementInTx`'s logo test goes back to `resolved.config.logo !== null` (the flow's
  // header slot alone): the Logo item's config carries `logo: null`, so no data URI reaches the
  // builder and the page paints nothing ([0]).
  it("a canvas Logo item prints on the stored statement", async () => {
    const layout = statementLayoutWithLogo();
    expect(canvasRefusal(layout, STATEMENT_CONTRACT, { pageFooter: false })).toBeNull();
    const named = canvasWarnings(layout, STATEMENT_CONTRACT, undefined, { pageFooter: false })
      .filter((w) => w.itemIds.includes("logo"));
    expect(named).toEqual([]);
    const customer = await owingCustomer("LOGO");
    const versionId = await publishStatementTemplate("Canvas logo", [customer.id], layout, tinyAlphaPng());

    const { documentId } = await asSystem(() => printStatement(customer.id, UNCOMBINED));
    const stored = await storedPrint(documentId);
    expect(stored.templateVersionId).toBe(versionId);
    expect(paintedImageCounts(stored.bytes)).toEqual([1]);
    // `logoContent` fits the image to the item's box (`fit: [w, h]`), so a square image in a square
    // box is the whole box, at the item's place (top-down y).
    const [[image]] = paintedImages(stored.bytes);
    expect(Math.abs(image.x - 24)).toBeLessThanOrEqual(1);
    expect(Math.abs(image.y - 99)).toBeLessThanOrEqual(1);
    expect(Math.abs(image.w - 36)).toBeLessThanOrEqual(1);
    expect(Math.abs(image.h - 36)).toBeLessThanOrEqual(1);
  });

  // Its paint is a pin: no mutation of the print's logo line reds it, the old test
  // (`config.logo !== null`) and the conjunct dropped (`logoImage !== null` alone) both painting
  // nothing here, since the canvas paints only a placed Logo item. Its stamps are red when
  // `printStatementInTx` resolves its template on no customer (`resolveTemplateForPrint(tx,
  // "STATEMENT", null)`: the Standard's stamp).
  it("a canvas with no Logo item paints none, for a customer whose template carries an upload and one whose carries none, the paint a pin", async () => {
    // Each half on a customer and a template of its own: one published with the upload on file, one with none.
    for (const [code, logo] of [["UPL", tinyAlphaPng()], ["NOUPL", undefined]] as const) {
      const customer = await owingCustomer(code);
      const versionId = await publishStatementTemplate(`Canvas ${code}`, [customer.id], standardStatementLayout(), logo);

      const { documentId } = await asSystem(() => printStatement(customer.id, UNCOMBINED));
      const stored = await storedPrint(documentId);
      expect(stored.templateVersionId, code).toBe(versionId);
      expect(paintedImageCounts(stored.bytes), code).toEqual([0]);
    }
  });

  // The flow side of the logo line: on a flow config (`layout` null) `templatePlacesLogo` is
  // `config.logo !== null`, so an upload the config does not place converts nothing and paints nothing.
  // Its paint is a pin (no mutation of the logo line reds it); its stamp is red when
  // `printStatementInTx` resolves its template on no customer (the Standard's stamp).
  it("a flow template with an upload on file and `logo` null paints none, the paint a pin", async () => {
    const customer = await owingCustomer("FLOWUPL");
    const versionId = await publishStatementTemplate("Flow upload", [customer.id], null, tinyAlphaPng());

    const { documentId } = await asSystem(() => printStatement(customer.id, UNCOMBINED));
    const stored = await storedPrint(documentId);
    expect(stored.templateVersionId).toBe(versionId);
    expect(paintedImageCounts(stored.bytes)).toEqual([0]);
  });

  // Reds when `printStatementInTx` resolves its template on no customer
  // (`resolveTemplateForPrint(tx, "STATEMENT", null)`: the Standard's stamp), when it resolves on a
  // division (on its first division by code, FAM-A, which carries a flow template of its own: that
  // template's stamp; the whole-branch review's finding 5, measured), and when the combined print
  // builds the parent alone (the divisions' open items and the summed aging row go).
  it("the combined print prints the family on the parent's canvas", async () => {
    const parent = await makeCustomer({ code: "FAM" });
    const divisionA = await makeCustomer({ code: "FAM-A", parentId: parent.id });
    const divisionB = await makeCustomer({ code: "FAM-B", parentId: parent.id });
    await setDefaultBillTo(parent.id, { street: "1 Parent Street", city: "Anniston" });
    await finalizedInvoice(divisionA.id, { total: 300, dueDate: daysBack(40) }); // 31-60
    await finalizedInvoice(divisionB.id, { total: 700, dueDate: daysBack(5) }); // 1-30
    const versionId = await publishStatementTemplate("Family canvas", [parent.id], standardStatementLayout());
    // A division assigned a template of its own, so a print resolved on that division's id stamps
    // another version than the parent's (with the parent's alone, both divisions inherit it).
    const divisionVersionId = await publishStatementTemplate("Division flow", [divisionA.id], null);
    expect(divisionVersionId).not.toBe(versionId);

    const { documentId } = await asSystem(() => printStatement(parent.id, COMBINED));
    const stored = await storedPrint(documentId);
    expect(stored.templateVersionId).toBe(versionId);
    expect(stored.customerId).toBe(parent.id);
    const lines = lineTexts(stored.bytes);
    expect(lines).toContain(`Customer: FAM — ${parent.name}`);
    expect(lines).toContain(parent.name);
    expect(lines).toContain("1 Parent Street");
    // Both divisions' invoices, each open in full, and the family's aging summed across them.
    expect(lines.filter((l) => /^\d+.*\$300\.00\$300\.00$/.test(l))).toHaveLength(1);
    expect(lines.filter((l) => /^\d+.*\$700\.00\$700\.00$/.test(l))).toHaveLength(1);
    expect(lines).toContain("$0.00$700.00$300.00$0.00$0.00$0.00$1,000.00");
    expect(lines).toContain("Total Due:$1,000.00");
  });

  // Reds when `printStatementInTx` resolves its template on no customer (every stamp the Standard's),
  // and when the run prints a settled customer (`cents(row.net) === 0` no longer skipped: four documents).
  it("the run stamps each statement with its own customer's version and skips a settled customer", async () => {
    const onCanvas1 = await owingCustomer("RUN1");
    const onCanvas2 = await owingCustomer("RUN2", 400);
    const onStandard = await owingCustomer("RUN3", 600);
    // Settled: an invoice paid in full, so the run's discovery finds it and its zero net skips it.
    const settled = await makeCustomer({ code: "RUN4" });
    const paid = await finalizedInvoice(settled.id, { total: 500, dueDate: daysBack(40) });
    await payInvoice(paid.id, 500);
    const canvas = await publishStatementTemplate("Run canvas", [onCanvas1.id, onCanvas2.id], standardStatementLayout());
    const standard = (await prisma.documentTemplate.findFirstOrThrow({
      where: { docType: "STATEMENT", isDefault: true, deletedAt: null },
    })).publishedVersionId;

    const results = await asSystem(() => runStatements({ assessFinanceCharges: false }));
    expect(results.map((r) => r.customerId).sort()).toEqual([onCanvas1.id, onCanvas2.id, onStandard.id].sort());
    const expected = new Map([[onCanvas1.id, canvas], [onCanvas2.id, canvas], [onStandard.id, standard]]);
    for (const r of results) {
      const stored = await storedPrint(r.documentId);
      expect(stored.customerId).toBe(r.customerId);
      expect(stored.templateVersionId, r.customerId).toBe(expected.get(r.customerId));
    }
    expect(await prisma.storedDocument.count({ where: { customerId: settled.id } })).toBe(0);
  });

  // Reds when `printStatementInTx` resolves the parent's template for every member (division B then
  // stamps the canvas), and when it resolves on no customer (every stamp the Standard's).
  it("the per-division set stamps each member with the version its own customer resolves to", async () => {
    const parent = await owingCustomer("DIV");
    const divisionA = await makeCustomer({ code: "DIV-A", parentId: parent.id });
    const divisionB = await makeCustomer({ code: "DIV-B", parentId: parent.id });
    await finalizedInvoice(divisionA.id, { total: 300, dueDate: daysBack(40) });
    await finalizedInvoice(divisionB.id, { total: 700, dueDate: daysBack(5) });
    const canvas = await publishStatementTemplate("Division canvas", [parent.id], standardStatementLayout());
    const flow = await publishStatementTemplate("Division B flow", [divisionB.id], null);

    const results = await asSystem(() => printStatementsPerDivision(parent.id, UNCOMBINED));
    expect(results.map((r) => [r.customerId, r.error])).toEqual([
      [parent.id, null], [divisionA.id, null], [divisionB.id, null],
    ]);
    const stamps = [];
    for (const r of results) stamps.push((await storedPrint(r.documentId!)).templateVersionId);
    expect(stamps).toEqual([canvas, canvas, flow]);
  });

  // #136: the route refuses an uncombined print of a customer with divisions before it prints, a
  // canvas assigned or not, and stores nothing.
  it("(pin) the route's uncombined print of a parent on a canvas still answers 409", async () => {
    const parent = await owingCustomer("REF");
    await makeCustomer({ code: "REF-A", parentId: parent.id });
    await publishStatementTemplate("Refused canvas", [parent.id], standardStatementLayout());
    const cookie = await signInWith(["receivables.view"], "stmt-canvas-136");

    const res = await printStatementRoute(new Request("http://t/api/receivables/statements", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ customerId: parent.id }),
    }), { params: Promise.resolve({}) });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("That customer has divisions — use Print per division, or tick Combine family");
    expect(await prisma.storedDocument.count()).toBe(0);
  });

  // The statement is a fully live rebuild on a canvas as in the flow: the second print reads the
  // customer's current bill-to and A/R, and prints the lines a flow print of the same moment prints.
  // Its lines are a pin (no mutation of the print's logo line changes them, and the canvas adds no
  // read and no data source); its stamps are red when `printStatementInTx` resolves its template on
  // no customer (the Standard's stamp).
  it("a canvas statement is live paper: a second print carries the new bill-to, open amounts and aging, the lines a pin", async () => {
    const customer = await makeCustomer({ code: "LIVE" });
    await setDefaultBillTo(customer.id, { street: "1 Old Street", city: "Anniston" });
    const invoice = await finalizedInvoice(customer.id, { total: 1000, dueDate: daysBack(40) }); // 31-60
    const credit = await finalizedCredit(customer.id, { total: -200 });
    const versionId = await publishStatementTemplate("Live canvas", [customer.id], standardStatementLayout());

    const first = await storedPrint((await asSystem(() => printStatement(customer.id, UNCOMBINED))).documentId);
    expect(first.templateVersionId).toBe(versionId);
    const firstLines = lineTexts(first.bytes);
    expect(firstLines).toContain("1 Old Street");
    expect(firstLines.filter((l) => /^\d+.*\$1,000\.00\$1,000\.00$/.test(l))).toHaveLength(1);
    expect(firstLines).toContain("$0.00$0.00$1,000.00$0.00$0.00$200.00$800.00");

    await setDefaultBillTo(customer.id, { street: "2 New Street", city: "Anniston" });
    await payInvoice(invoice.id, 300);
    await applyCredit(credit.id, invoice.id, 200);

    const second = await storedPrint((await asSystem(() => printStatement(customer.id, UNCOMBINED))).documentId);
    expect(second.templateVersionId).toBe(versionId);
    const lines = lineTexts(second.bytes);
    expect(lines).toContain("2 New Street");
    expect(lines).not.toContain("1 Old Street");
    expect(lines.filter((l) => /^\d+.*\$1,000\.00\$500\.00$/.test(l))).toHaveLength(1);
    expect(lines).toContain("$0.00$0.00$500.00$0.00$0.00$0.00$500.00");
    expect(lines).toContain("Total Due:$500.00");

    // The flow's paper of the same moment: from the Bill To through Total Due, each of its lines is
    // printed on the canvas too.
    const flowPdf = await renderPdf(buildStatementDefinition(
      await buildStatement(customer.id, UNCOMBINED), STATEMENT_DEFAULT_CONFIG,
    ));
    const flowLines = lineTexts(flowPdf);
    const body = flowLines.slice(flowLines.indexOf("Bill To"), flowLines.findIndex((l) => l.startsWith("Total Due")) + 1);
    expect(body).toContain("2 New Street");
    for (const line of body) expect(lines, line).toContain(line);
  });
});

// The print's budget through all three paths (design 2026-11-11 §5.4; since statement canvas PR 2).
// Run on purpose, on mains at the Performance profile with both runner slots paused:
// CANVAS_TIMING=1 npx vitest run tests/statement-canvas-print.test.ts -t "CANVAS timing" --reporter=verbose --silent=false
// The -t filter is what makes pass F's first figure the process's first statement render: run without
// it, the file's earlier cases render first.
// ONE data set at §5.4's sizes, built once (plan open question 6): one customer of 300 open items, a
// parent (no items of its own) with five divisions of 60 each, and 20 customers of 100 each. They are
// the only customers with A/R history (the case truncates first, and the seed's customer has none), so
// `runStatements` prints the same 26 statements in both passes: the 20, the 300-item customer and the
// five divisions. Pass F prints everything on the Standard; then the canvas is seeded, published and
// assigned (the 300-item customer, the 20 and the parent, whose divisions inherit it) and pass C prints
// the same calls on the same customers. Each call runs twice per pass, timed whole; each statement's
// own Serializable transaction is timed by a property save/restore wrapper of `prisma.$transaction`
// (never `vi.spyOn`, CLAUDE.md), installed around the timed call alone. No time is asserted: every
// figure is logged for the controller to read against the plan's STOP rule (2,500 ms a statement, or a
// canvas run's or per-division set's wall clock more than half again its flow counterpart's). A P2028
// ends its pass and fails the case as a STOP, with every figure taken so far logged.
describe("the statement canvas print's budget (design 2026-11-11 §5.4)", () => {
  beforeEach(async () => { await truncateAll(); });

  const SIZES = { single: 300, divisions: 5, perDivision: 60, runCustomers: 20, perRunCustomer: 100 };

  type Pass = "F" | "C";
  /** One statement's Serializable transaction, as the wrapper saw it. */
  type TxFigure = { pass: Pass; call: string; print: number; index: number; code: string; pages: number | null; ms: number; outcome: string };
  /** A STOP raised inside a pass: it ends the pass, and the case fails on it after logging. */
  class StopSignal extends Error {}

  /** The printed statement a print transaction resolves to, on all three paths (`printStatementInTx`). */
  type Printed = { documentId: string; pdf: Buffer; data: StatementData };

  /**
   * Replaces `prisma.$transaction` with a wrapper that times every INTERACTIVE call whose options carry
   * `isolationLevel: Serializable` (the per-statement prints: never the run's RepeatableRead discovery,
   * an array-form call, the fixture writes or the publish), reporting each to `sink` once it settles:
   * the statement's customer code and page count, read from the transaction's own answer after the clock
   * stops (no buffer is kept), or, when it threw, the error. Answers the restore, which puts the client
   * back as it was found (the own property deleted when the method was the prototype's).
   */
  function recordSerializable(sink: (f: { code: string; pages: number | null; ms: number; error: unknown }) => void): () => void {
    const client = prisma as unknown as Record<string, unknown>;
    const hadOwn = Object.hasOwn(client, "$transaction");
    const original = client.$transaction as (...args: unknown[]) => Promise<unknown>;
    client.$transaction = (...args: unknown[]) => {
      const [first, options] = args as [unknown, { isolationLevel?: unknown } | undefined];
      if (typeof first !== "function" || options?.isolationLevel !== Prisma.TransactionIsolationLevel.Serializable) {
        return original.apply(prisma, args);
      }
      const body = first as (tx: unknown) => Promise<unknown>;
      let printed: Printed | undefined;
      const started = performance.now();
      return original.apply(prisma, [async (tx: unknown) => {
        const answer = await body(tx);
        printed = answer as Printed;
        return answer;
      }, options]).then(
        (answer) => {
          const ms = performance.now() - started;
          sink({ code: printed?.data.customer.code ?? "?", pages: printed ? pageCount(printed.pdf) : null, ms, error: null });
          printed = undefined;
          return answer;
        },
        (error: unknown) => {
          const ms = performance.now() - started;
          sink({ code: printed?.data.customer.code ?? "(no answer)", pages: printed ? pageCount(printed.pdf) : null, ms, error });
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

  /** The stored row's version stamp. */
  const stampOf = async (documentId: string) => (await prisma.storedDocument.findUniqueOrThrow({
    where: { id: documentId }, select: { templateVersionId: true },
  })).templateVersionId;

  it.skipIf(process.env.CANVAS_TIMING !== "1")("CANVAS timing: a statement canvas print through all three paths", async () => {
    // The one data set.
    const single = await makeCustomer({ code: "BUDGET-300" });
    await bulkOpenItems(single.id, SIZES.single);
    const parent = await makeCustomer({ code: "BUDGET-FAM" });
    const divisions = [];
    for (let i = 1; i <= SIZES.divisions; i++) {
      const division = await makeCustomer({ code: `BUDGET-FAM-${i}`, parentId: parent.id });
      await bulkOpenItems(division.id, SIZES.perDivision);
      divisions.push(division);
    }
    const runCustomers = [];
    for (let i = 1; i <= SIZES.runCustomers; i++) {
      const customer = await makeCustomer({ code: `BUDGET-RUN-${String(i).padStart(2, "0")}` });
      await bulkOpenItems(customer.id, SIZES.perRunCustomer);
      runCustomers.push(customer);
    }
    // The seed's customer: no A/R history, so the run never finds it (the seed lays out a stand-in).
    const seedCustomer = await makeCustomer({ code: "BUDGET-SEED" });
    const runSet = [single.id, ...divisions.map((d) => d.id), ...runCustomers.map((c) => c.id)].sort();
    const memberSet = [parent.id, ...divisions.map((d) => d.id)];
    const standard = (await prisma.documentTemplate.findFirstOrThrow({
      where: { docType: "STATEMENT", isDefault: true, deletedAt: null },
    })).publishedVersionId;

    const txFigures: TxFigure[] = [];
    const walls = new Map<string, { ms: number; statements: number }>();
    const stops: string[] = [];
    const documents: { pass: Pass; label: string; documentId: string }[] = [];
    const runCustomerIds: Record<Pass, string[][]> = { F: [], C: [] };

    /** Times one whole call (its wall clock) and each statement transaction inside it, logging every
     *  figure as it lands. A P2028 inside it is recorded as a STOP and ends the pass once the call
     *  returns or throws (the per-division set catches a member's throw, so its STOP comes from here). */
    async function timedCall(pass: Pass, call: string, print: number, run: () => Promise<string[]>): Promise<void> {
      let index = 0;
      const stopsBefore = stops.length;
      const restore = recordSerializable(({ code, pages, ms, error }) => {
        index += 1;
        const expired = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2028";
        const outcome = error === null ? "ok" : expired ? `P2028${isExpiredTransaction(error) ? " (expired)" : ""}` : "threw";
        txFigures.push({ pass, call, print, index, code, pages, ms, outcome });
        console.log(`CANVAS timing: pass ${pass}; ${call}; print ${print}; statement ${index} ${code}; ${pages ?? "?"} page(s); transaction ${Math.round(ms)} ms${outcome === "ok" ? "" : `; ${outcome}`}`);
        if (expired) stops.push(`pass ${pass}; ${call}; print ${print}; statement ${code}; ${pages ?? "?"} page(s); ${Math.round(ms)} ms; ${(error as Error).message}`);
      });
      const started = performance.now();
      let ids: string[] = [];
      let thrown: unknown = null;
      try {
        ids = await run();
      } catch (error) {
        thrown = error;
      } finally {
        const ms = performance.now() - started;
        restore();
        walls.set(`${pass}|${call}|${print}`, { ms, statements: index });
        console.log(`CANVAS timing: pass ${pass}; ${call}; print ${print}; wall clock ${Math.round(ms)} ms over ${index} statement(s)${thrown === null ? "" : "; the call threw"}`);
      }
      // A P2028 the wrapper recorded ends the pass as a STOP, whether the call rethrew it (the single
      // print and the run) or caught it per member (the per-division set); any other throw propagates.
      if (stops.length > stopsBefore) throw new StopSignal(stops.slice(stopsBefore).join(" | "));
      if (thrown !== null) throw thrown;
      for (const documentId of ids) documents.push({ pass, label: `${call}; print ${print}`, documentId });
    }

    const CALLS = {
      single: `printStatement, ${SIZES.single} items, uncombined`,
      combined: `printStatement, a parent of ${SIZES.divisions} divisions of ${SIZES.perDivision} items, combined`,
      run: `runStatements, ${SIZES.runCustomers} of ${SIZES.perRunCustomer} items, with the ${SIZES.single}-item customer and the divisions`,
      perDivision: `printStatementsPerDivision, the parent and its ${SIZES.divisions} divisions`,
    };

    async function runPass(pass: Pass): Promise<void> {
      for (const print of [1, 2]) {
        await timedCall(pass, CALLS.single, print, async () => [(await asSystem(() => printStatement(single.id, UNCOMBINED))).documentId]);
      }
      for (const print of [1, 2]) {
        await timedCall(pass, CALLS.combined, print, async () => [(await asSystem(() => printStatement(parent.id, COMBINED))).documentId]);
      }
      for (const print of [1, 2]) {
        await timedCall(pass, CALLS.run, print, async () => {
          const results = await asSystem(() => runStatements({ assessFinanceCharges: false }));
          runCustomerIds[pass].push(results.map((r) => r.customerId).sort());
          return results.map((r) => r.documentId);
        });
      }
      for (const print of [1, 2]) {
        await timedCall(pass, CALLS.perDivision, print, async () => {
          const results = await asSystem(() => printStatementsPerDivision(parent.id, UNCOMBINED));
          expect(results.map((r) => [r.customerId, r.error])).toEqual(memberSet.map((id) => [id, null]));
          return results.map((r) => r.documentId!);
        });
      }
    }

    /** Runs a pass, ending it on a STOP (logged) and propagating anything else. */
    async function guardedPass(pass: Pass): Promise<void> {
      try {
        await runPass(pass);
      } catch (error) {
        if (!(error instanceof StopSignal)) throw error;
        console.log(`CANVAS timing: STOP, pass ${pass} ended: ${error.message}`);
      }
    }

    let canvas: string | null = null;
    try {
      // Pass F: nothing assigned, every customer on the Standard. Its first figure is the process's
      // first statement render (module load, fonts, cold caches).
      await guardedPass("F");

      // The canvas: seeded once from a customer with no A/R history (a stand-in laid out at its least),
      // published once and assigned to the 300-item customer, the 20 and the parent (its divisions
      // inherit it). The seed's render runs the canvas modules before pass C, so C runs warm.
      const seedStarted = performance.now();
      const layout = await seedStatementLayout(seedCustomer.id, structuredClone(STATEMENT_DEFAULT_CONFIG), undefined);
      console.log(`CANVAS timing: the seed (stand-in render, not judged) in ${Math.round(performance.now() - seedStarted)} ms`);
      canvas = await publishStatementTemplate("Budget canvas", [single.id, ...runCustomers.map((c) => c.id), parent.id], layout);

      // Pass C: the same four calls on the same customers, on the canvas.
      await guardedPass("C");
    } finally {
      // Every figure, each canvas figure beside its flow figure, logged whatever ended the case.
      console.log("CANVAS timing: SUMMARY. Pass F (the Standard) ran first and cold; then the seed's stand-in render; then pass C (the canvas), warm.");
      for (const call of Object.values(CALLS)) {
        for (const print of [1, 2]) {
          const f = walls.get(`F|${call}|${print}`);
          const c = walls.get(`C|${call}|${print}`);
          const ratio = f && c ? ` (C/F ${(c.ms / f.ms).toFixed(2)})` : "";
          console.log(`CANVAS timing: SUMMARY wall; ${call}; print ${print}; F ${f ? `${Math.round(f.ms)} ms over ${f.statements}` : "-"} | C ${c ? `${Math.round(c.ms)} ms over ${c.statements}` : "-"}${ratio}`);
          const fs = txFigures.filter((t) => t.pass === "F" && t.call === call && t.print === print);
          const cs = txFigures.filter((t) => t.pass === "C" && t.call === call && t.print === print);
          for (let i = 0; i < Math.max(fs.length, cs.length); i++) {
            const a = fs[i];
            const b = cs[i];
            const cell = (t: TxFigure | undefined) => t ? `${t.code} ${t.pages ?? "?"} p ${Math.round(t.ms)} ms${t.outcome === "ok" ? "" : ` ${t.outcome}`}` : "-";
            console.log(`CANVAS timing: SUMMARY transaction; ${call}; print ${print}; statement ${i + 1}; F ${cell(a)} | C ${cell(b)}`);
          }
        }
      }
      // The STOP rule's figures, computed and logged, never asserted.
      for (const pass of ["F", "C"] as const) {
        const own = txFigures.filter((t) => t.pass === pass);
        const worst = own.reduce<TxFigure | null>((m, t) => (m === null || t.ms > m.ms ? t : m), null);
        const over = own.filter((t) => t.ms > 2500);
        console.log(`CANVAS timing: VERDICT pass ${pass}; the longest statement transaction ${worst ? `${Math.round(worst.ms)} ms (${worst.code}, ${worst.pages ?? "?"} p, ${worst.call}, print ${worst.print})` : "-"}; ${over.length} over 2,500 ms${pass === "F" ? " (the flow's: existing behaviour, reported apart)" : ""}`);
      }
      for (const call of [CALLS.run, CALLS.perDivision]) {
        for (const print of [1, 2]) {
          const f = walls.get(`F|${call}|${print}`);
          const c = walls.get(`C|${call}|${print}`);
          if (!f || !c) continue;
          console.log(`CANVAS timing: VERDICT wall; ${call}; print ${print}; C ${Math.round(c.ms)} ms against F ${Math.round(f.ms)} ms, C/F ${(c.ms / f.ms).toFixed(2)}${c.ms > 1.5 * f.ms ? "; past half again: STOP" : ""}`);
        }
      }
      console.log(`CANVAS timing: VERDICT ${stops.length} expired transaction(s)`);
    }

    expect(stops, "STOP: a statement transaction expired (P2028); every figure is logged above").toEqual([]);
    // The run printed the same 26 statements in both passes, both prints.
    for (const pass of ["F", "C"] as const) {
      expect(runCustomerIds[pass], pass).toEqual([runSet, runSet]);
    }
    // Each document is stamped with the version it was meant to print: the Standard's in pass F, the
    // canvas's in pass C. Red when `publishStatementTemplate` assigns nothing (its `assignTemplate`
    // loop dropped, tests/helpers/statement-print-fixtures.ts): pass C then prints on the Standard.
    expect(canvas).not.toBeNull();
    for (const d of documents) {
      expect(await stampOf(d.documentId), `${d.pass}; ${d.label}`).toBe(d.pass === "C" ? canvas : standard);
    }
    // Every statement transaction the wrapper saw is one of the documents above (two singles, two
    // combined, two runs of 26 and two sets of 6 a pass), so nothing else was timed as a print.
    expect(txFigures.filter((t) => t.pass === "F")).toHaveLength(documents.filter((d) => d.pass === "F").length);
    expect(txFigures.filter((t) => t.pass === "C")).toHaveLength(documents.filter((d) => d.pass === "C").length);
  }, 600_000);
});
