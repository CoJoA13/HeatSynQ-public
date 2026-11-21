import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { validateContractConfig } from "@/lib/template-contracts/types";
import { INVOICE_CONTRACT } from "@/lib/template-contracts/invoice";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { drawnText, strokedLines, textRunsWithY } from "./helpers/pdf";
import { publishStored, seedLiteral, storedBefore } from "./helpers/stored-configs";
import { all } from "./helpers/source-lift";
import { measured } from "./helpers/measured";
import { runWithContext } from "@/server/context";
import { createOrder, getOrder, type OrderDetail } from "@/server/orders";
import { createShipper, replaceShipperLines } from "@/server/shippers";
import { addPartPrice, deletePartPrice, listPartPrices } from "@/server/part-prices";
import { createSurcharge } from "@/server/surcharges";
import { setSetting } from "@/server/settings";
import { setBillingConfig } from "@/server/billing-config";
import {
  createInvoice, finalizeInvoice, createCredit, discardInvoice, unlockInvoice,
  printInvoice, printSelectedInvoice, readInvoicePdfData, replaceInvoiceLines, recalculateInvoice, getInvoice,
  listInvoices, type InvoiceLineDetail,
} from "@/server/invoices";
import { optionsFor } from "@/app/admin/templates/[id]/edit/PreviewPane";
import { buildInvoiceDefinition, type InvoicePdfData } from "@/server/pdf/invoice";
import { renderPdf } from "@/server/pdf/render";
import { getDocument, storeDocument, VOIDED_PRINT } from "@/server/documents";
import { HttpError } from "@/server/errors";
import { CUSTOMER_FOLDERS_MARKER } from "@/lib/invoice-folder-entry";
import { PRINT_NO_FOLDER, PRINT_NOT_CONNECTED } from "@/lib/customer-folder-words";
import { INVOICE_DEFAULT_CONFIG, normalizeStoredConfig, validateConfig, type TemplateConfig } from "@/lib/template-contracts/index";
import { Prisma, type Customer, type Part } from "../prisma/generated/prisma/client";

import { POST as printRoute } from "@/app/api/invoices/[id]/print/route";
import { GET as invoiceDocumentsRoute } from "@/app/api/invoices/[id]/documents/route";
import { PUT as linesRoute } from "@/app/api/invoices/[id]/lines/route";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
const postReq = (url: string, cookie?: string) =>
  new Request(url, { method: "POST", headers: cookie ? { cookie } : {} });
const getReq = (url: string, cookie?: string) =>
  new Request(url, { method: "GET", headers: cookie ? { cookie } : {} });

/** Every `text` string anywhere in a document definition, flattened. This file's content pins read
 *  the DEFINITION through it, with three exceptions, each reading the rendered bytes through readers
 *  of tests/helpers/pdf.ts: the print-twice case reads its page's weights through `drawnText`; the
 *  order strip's cases (#590), the stored credit memo's among them, read the page's runs through
 *  `textRunsWithY`: where each run starts, and what the strip's runs draw; and the price rules'
 *  cases (#589) read the page's strokes through `strokedLines` and its runs through
 *  `textRunsWithY`: how many rules are drawn, how thick, where each runs from and to, the lines
 *  drawn nearest above and below each, which page each is on and what each page holds, and where
 *  the column strip's last vertical rule is drawn. pdfkit writes TTF-subset glyph ids, so a plain
 *  search of the bytes finds no text, and those readers decode them through each font's own table.
 *  The other cases hold a rendered file by its `%PDF-` marker, its page count or its stored bytes,
 *  never by its text. Copied from tests/cert-pdf.test.ts. */
function allText(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) allText(n, out); return out; }
  if (typeof node === "object") {
    for (const value of Object.values(node as Record<string, unknown>)) allText(value, out);
  }
  return out;
}

/** The PDF's own page count, off its `/Type /Pages /Count N` object — the one signal a race test
 *  can check without re-rendering. Copied from tests/traveler.test.ts (see its comment for why this
 *  is safe where a `Buffer.compare` of two fresh renders is not). */
function pageCount(pdf: Buffer): number {
  const match = pdf.toString("latin1").match(/\/Type\s*\/Pages[^>]*\/Count\s+(\d+)/);
  if (!match) throw new Error("Could not find a /Type /Pages /Count marker in the rendered PDF");
  return Number(match[1]);
}

// -------------------------------------------------------------------------------------------
// Fixtures — copied in shape from tests/invoices.test.ts (copying across test files is this repo's
// convention).
// -------------------------------------------------------------------------------------------

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({ data: { code: `IPD${customerSeq}`, name: `Invoice Customer ${customerSeq}` } });
}

let partSeq = 0;
async function makePart(customerId: string): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({
    data: { customerId, partNumber: `P-${partSeq}`, name: "EQUALIZER-RR SUSP", eachWeight: "21.0000" },
  });
}

async function makeBillTo(customerId: string) {
  return prisma.customerAddress.create({
    data: {
      customerId, kind: "BILL_TO", name: "Demo Foundry - Columbus LLC", street: "500 Example Street",
      city: "Columbus", state: "GA", zip: "31902-0096", isDefault: true,
    },
  });
}

async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `HT-${partId}`, name: "Austemper" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austemper at 1650F." },
  });
}

async function savedOrder(): Promise<{ order: OrderDetail; part: Part; customer: Customer }> {
  const customer = await makeCustomer();
  await makeBillTo(customer.id);
  const part = await makePart(customer.id);
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber: "89499",
    lines: [{ partId: part.id, qty: 144, weight: "3024.00" }],
  }));
  return { order, part, customer };
}

function oneOrderInput(order: OrderDetail) {
  return {
    customerId: order.customerId,
    shipDate: "2026-07-29",
    orders: [{
      orderId: order.id,
      lines: [{ orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight, lineComplete: true }],
      containers: [] as { orderContainerId: string; count: number }[],
      serials: [] as { orderSerialId: string; printOnShipper?: boolean }[],
    }],
  };
}

/** A fully-shipped order priced at $6.51/each with a $600 minimum — the sample invoice's numbers. */
async function pricedShippedOrder() {
  const { order, part, customer } = await savedOrder();
  const { shipper } = await createShipper(oneOrderInput(order), { canOverrideCreditHold: false });
  const gl = await prisma.glAccount.create({ data: { name: "4010", description: "Sales" } });
  const code = await prisma.processStepCode.create({ data: { code: "AUST", name: "Austemper", glAccountId: gl.id } });
  await asSystem(() => addPartPrice(part.id, {
    processStepCodeId: code.id, position: 1, unitPrice: "6.5100", minimumCharge: "600.00", pricePer: "EACH",
  }));
  return { order: await getOrder(order.id), part, customer, shipper, stepCode: code, glAccount: gl };
}

async function draftFixture() {
  const fixture = await pricedShippedOrder();
  const { invoice } = await asSystem(() => createInvoice({ orderId: fixture.order.id }));
  return { ...fixture, invoice };
}

async function finalizedFixture() {
  const d = await draftFixture();
  const invoice = await asSystem(() => finalizeInvoice(d.invoice.id));
  return { ...d, invoice };
}

/** The owner's own invoice as plain builder input (order 92026), so the golden numbers here and in
 *  tests/pricing.test.ts describe the same document. billTo/shipTo/remitTo are line arrays — an
 *  invoice's billTo/shipTo are FROZEN snapshot strings (invoices.ts), split here into lines. */
function sampleData(overrides: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return {
    company: { name: "Example Heat Treating - Alabama, LLC", address: "100 Example Way\nAnniston AL 36207", phone: "256-555-0100" },
    remitTo: { name: "Example Heat Treating - Alabama, LLC", lines: ["100 Example Way", "Anniston AL 36207"] },
    billTo: ["Demo Foundry - Columbus LLC", "PO Box 100", "500 Example Street", "Columbus  GA  31902-0096"],
    shipTo: ["Demo Foundry - Columbus LLC", "PO Box 100", "500 Example Street", "Columbus  GA  31902-0096"],
    title: "Invoice",
    documentNumber: "7 - 92026", invoiceDate: "2026-07-29", termsName: "Net 30",
    orderNumber: 92026, poNumber: "89499",
    materialName: "Ductile Iron", processNames: "Austemper",
    parts: [{ qty: 144, partNumber: "DEMO-9001-000", partName: "EQUALIZER-RR SUSP", partDescription: "", eachWeight: 21, totalWeight: 3024 }],
    priceRows: [{ description: "Austemper", pricePerLabel: "Each", unitPrice: 6.51, minimumCharge: 600, setupCharge: null, amount: 937.44, partIndex: 0 }],
    subtotal: 937.44,
    surchargeRows: [{ description: "EnergySur", amount: 37.5 }],
    chargeRows: [], certRow: null, freightRow: null, taxRow: null,
    total: 974.94,
    ...overrides,
  };
}

// -------------------------------------------------------------------------------------------
// The builder — pure, plain-JSON, and it says what the sample says (spec §10).
// -------------------------------------------------------------------------------------------

describe("buildInvoiceDefinition", () => {
  it("is a pure builder — the definition survives a JSON round trip", () => {
    const def = buildInvoiceDefinition(sampleData());
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
  });

  it("prints the sample's identity block, parts, price rows and totals", async () => {
    const text = allText(buildInvoiceDefinition(sampleData())).join(" ");
    expect(text).toContain("Invoice");
    expect(text).toContain("Example Heat Treating - Alabama, LLC");
    expect(text).toContain("7 - 92026");
    expect(text).toContain("Net 30");
    expect(text).toContain("Remit To");
    expect(text).toContain("Demo Foundry - Columbus LLC");
    expect(text).toContain("92026");                 // Our Order #
    expect(text).toContain("89499");                 // Your PO #
    expect(text).toContain("Ductile Iron");
    expect(text).toContain("Austemper");
    expect(text).toContain("DEMO-9001-000");
    expect(text).toContain("EQUALIZER-RR SUSP");
    expect(text).toContain("Price per Each");
    expect(text).toContain("6.51");
    expect(text).toContain("Minimum Charge");
    expect(text).toContain("600.00");
    expect(text).toContain("Sub Total Amount");
    expect(text).toContain("937.44");
    expect(text).toContain("EnergySur");
    expect(text).toContain("37.50");
    expect(text).toContain("Total Amount Due");
    expect(text).toContain("974.94");
    // No "Page N of M" — the pure-JSON deviation (the shipping ticket's / cert's own).
    expect(text).not.toContain("Page No.");
    expect(text).not.toMatch(/Page\s+\d+\s+of\s+\d+/);

    // Structural pins on the REAL file — the `%PDF-` header and the page count, never a
    // `Buffer.compare` of two fresh renders (CLAUDE.md).
    const pdf = await renderPdf(buildInvoiceDefinition(sampleData()));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pageCount(pdf)).toBe(1);
  });

  it("titles a credit 'Credit' and prints its negative amounts", () => {
    const text = allText(buildInvoiceDefinition(sampleData({
      title: "Credit", documentNumber: "1000",
      priceRows: [{ description: "Austemper", pricePerLabel: "Each", unitPrice: 6.51, minimumCharge: 600, setupCharge: null, amount: -937.44, partIndex: 0 }],
      subtotal: -937.44, surchargeRows: [{ description: "EnergySur", amount: -37.5 }], total: -974.94,
    }))).join(" ");
    expect(text).toContain("Credit");
    expect(text).toContain("1000");
    expect(text).toContain("-937.44");
    expect(text).toContain("-974.94");
  });
});

// -------------------------------------------------------------------------------------------
// The order strip on paper: its four fields on one line (owner ruling of 2026-10-20, #590).
// -------------------------------------------------------------------------------------------

// `textRunsWithY` gives where each word STARTS, and nothing of where it ends, so every assertion on
// the strip is made of starts. A field starts at its label. pdfkit draws a word as a run, and a field
// that fits its share is drawn under `noWrap`, as one run of each style, so a label's run is the
// whole label or its first word. Fields on one line are labels on one y; a field takes as many
// baselines as its runs have different y values; and nothing printed past the margin is every run
// starting before 588 (612 less the 24-point side margin).
const LABELS = ["Our Order #:", "Your PO #:", "Material:", "Process:"];
type Run = { text: string; x: number; y: number };
/** A rendered page's runs, and the strip's runs field by field. pdfkit draws a row column by column,
 *  so a field holds every run drawn from its label to the next field's label; the last holds the
 *  runs drawn after its label that start at or right of it, which ends at the PARTS heading. `labels`
 *  are the shown fields' labels as the template prints them, in their order. */
const fieldsOf = (page: Run[], labels: string[] = LABELS) => {
  const at = labels.map((label) => page.findIndex((r) => [label, label.split(" ")[0]].includes(r.text.trim())));
  expect(at.every((i) => i >= 0), `every label is drawn on page one: ${JSON.stringify(at)}`).toBe(true);
  // A field is cut from one label's run to the next one's, so the labels must be drawn in their order.
  expect(at.every((i, k) => k === 0 || i > at[k - 1]), `the labels are drawn in their order: ${JSON.stringify(at)}`).toBe(true);
  const fields = at.map((start, i): Run[] => {
    if (i + 1 < at.length) return page.slice(start, at[i + 1]);
    const rest = page.slice(start);
    const end = rest.findIndex((r) => r.x < rest[0].x);
    return end < 0 ? rest : rest.slice(0, end);
  });
  return { page, fields, labels: fields.map((field) => field[0]) };
};
const baselines = (runs: Run[]): number => new Set(runs.map((r) => r.y)).size;
/** The labels on one y, left to right in their order. */
const onOneLine = (labels: Run[]): void => {
  expect(labels.map((r) => r.y), "the labels' y").toEqual(labels.map(() => labels[0].y));
  expect(labels.every((r, i) => i === 0 || r.x > labels[i - 1].x), "the labels' x, left to right").toBe(true);
};

describe("the order strip prints its four fields on one line (#590)", () => {
  /** Eight operations, wider than what the three short fields leave Process. */
  const PROCESS = "Austemper, Stress Relieve, Neutral Harden, Temper, Gas Nitride, Carburize, Anneal, Normalize";
  /** 200 characters with spaces in them, the most a PO holds, wider than the line. */
  const LONG_PO = "PO 24115 RELEASE ".repeat(12).slice(0, 200);
  /** 250 letters and digits with no space or hyphen in them: one word, far wider than the line. */
  const UNBROKEN = "Austemper24115".repeat(18).slice(0, 250);
  const credit = (): InvoicePdfData => sampleData({
    title: "Credit", documentNumber: "1000",
    priceRows: [{ description: "Austemper", pricePerLabel: "Each", unitPrice: 6.51, minimumCharge: 600, setupCharge: null, amount: -937.44, partIndex: 0 }],
    subtotal: -937.44, surchargeRows: [{ description: "EnergySur", amount: -37.5 }], total: -974.94,
  });

  /** Page one of `data` printed under `config`, read by `fieldsOf`. */
  const printed = async (data: InvoicePdfData, config?: TemplateConfig, labels: string[] = LABELS) =>
    fieldsOf(textRunsWithY(await renderPdf(buildInvoiceDefinition(data, config)))[0], labels);
  /** The default config with the Quantity column `qty` points wide, the two weight columns hidden or
   *  shown, as a template stores it. */
  const wideQuantity = (qty: number, weightsHidden: boolean): TemplateConfig => {
    const c = structuredClone(INVOICE_DEFAULT_CONFIG);
    const columns = c.sections.find((s) => s.key === "column_header")!.fields;
    columns.find((f) => f.key === "col_qty")!.width = qty;
    for (const key of ["col_each_weight", "col_amount"]) columns.find((f) => f.key === key)!.visible = !weightsHidden;
    // The contract's own battery: a Quantity column this wide is refused by the registry's printed-width budget since
    // owner ruling R-B (2026-11-17, #991), and the strip's measured row is held here as a config that reaches the
    // renderer unvalidated would print.
    return validateContractConfig(INVOICE_CONTRACT, c);
  };

  it.each([["the invoice", sampleData], ["the credit memo", credit]] as const)(
    "%s prints the four labels on one line, left to right, above the PARTS heading", async (_paper, data) => {
      const { page, labels } = await printed(data());
      onOneLine(labels);
      const parts = page.find((r) => r.text.trim() === "PARTS");
      expect(parts!.y).toBeLessThan(labels[0].y);
    });

  it("keeps the three short fields on the first line while an eight-operation Process wraps", async () => {
    const { fields, labels } = await printed(sampleData({ processNames: PROCESS }));
    onOneLine(labels);
    for (const field of fields.slice(0, 3)) expect(field.map((r) => r.y)).toEqual(field.map(() => labels[0].y));
    expect(baselines(fields[3])).toBeGreaterThanOrEqual(2);
  });

  it("holds a 200-character PO to its share: it wraps inside it, the others stay whole on the first line, and nothing starts past the margin", async () => {
    const { page, fields, labels } = await printed(sampleData({ poNumber: LONG_PO }));
    onOneLine(labels);
    for (const field of [fields[0], fields[2], fields[3]]) expect(field.map((r) => r.y)).toEqual(field.map(() => labels[0].y));
    expect(baselines(fields[1])).toBeGreaterThanOrEqual(2);
    expect(page.filter((r) => r.x >= 588)).toEqual([]);
  });

  // Process is an "auto" column, which render.ts holds to what the others leave, so pdfmake breaks a
  // word wider than that at the column's edge (the #518 finding). As the "*" column it widened to the
  // word and printed it as one run from the column's start, past the margin, which "nothing starts
  // past the margin" cannot see: a run is read by where it starts. So the value's own runs, its
  // label's left out, are held on at least as many baselines as the word needs at the width from
  // where the value starts to the margin: its width on one line, measured alone on a page wide
  // enough for it, over that. Where the word breaks is not read.
  it("breaks a 250-character Process with no space in it across lines: the labels stay on one line, and nothing starts past the margin", async () => {
    const { page, fields, labels } = await printed(sampleData({ processNames: UNBROKEN }));
    onOneLine(labels);
    const alone = textRunsWithY(await renderPdf({
      pageSize: { width: 14_400, height: 200 }, pageMargins: 0,
      content: [{ columns: [{ width: "auto", text: UNBROKEN, fontSize: 9, noWrap: true }, { width: "auto", text: "END" }], columnGap: 0 }],
    }))[0];
    const word = alone.find((r) => r.text === "END")!.x;
    const value = fields[3].slice(1);
    expect(baselines(value), "the Process value's baselines").toBeGreaterThanOrEqual(Math.ceil(word / (588 - value[0].x)));
    expect(page.filter((r) => r.x >= 588)).toEqual([]);
  });

  it("prints a blank PO's label alone, in its place on the line", async () => {
    const { fields, labels } = await printed(sampleData({ poNumber: "" }));
    const [order, po, material] = labels;
    expect(po.y).toBe(material.y);
    expect(po.x).toBeGreaterThan(order.x);
    expect(po.x).toBeLessThan(material.x);
    // A blank value draws no run: the field's runs are its label's.
    expect(fields[1].map((r) => r.text).join("").trim()).toBe("Your PO #:");
  });

  // A line break inside a field prints as one space (owner's amendment of 2026-10-21, #590). A field
  // that fits its share is drawn under `noWrap`, where pdfkit drew a break's pieces end to end
  // ("89499" then "REL2" with nothing between) and a lone carriage return as a glyph. A CR LF pair is
  // one break. So the PO's runs read "Your PO #: 89499 REL2" on the label's one baseline, and no run
  // on the page holds a line-break character.
  it.each([["a line feed", "\n"], ["a CR LF pair", "\r\n"], ["a lone carriage return", "\r"]])(
    "prints a short PO holding %s as one space, on its label's line", async (_what, br) => {
      const { page, fields, labels } = await printed(sampleData({ poNumber: `89499${br}REL2` }));
      onOneLine(labels);
      expect(fields[1].map((r) => r.text).join("")).toBe("Your PO #: 89499 REL2");
      expect(fields[1].map((r) => r.y)).toEqual(fields[1].map(() => labels[0].y));
      expect(page.filter((r) => /[\n\r]/.test(r.text))).toEqual([]);
    });

  // A PO longer than its share is capped and wraps, and a capped field honoured a break: "PO" alone on
  // the first line, "24115" starting the second. As a space, the first line holds both.
  it("prints a line break in a PO longer than its share as a space: the words either side share the first line", async () => {
    const { page, fields, labels } = await printed(sampleData({ poNumber: LONG_PO.replace(" ", "\n") }));
    onOneLine(labels);
    // A capped field is not drawn under `noWrap`, so each word is its own run, the label's three first.
    const [po, number] = fields[1].slice(LABELS[1].split(" ").length);
    expect([po.text, number.text]).toEqual(["PO ", "24115 "]);
    expect([po.y, number.y]).toEqual([labels[0].y, labels[0].y]);
    expect(baselines(fields[1])).toBeGreaterThanOrEqual(2);
    expect(page.filter((r) => /[\n\r]/.test(r.text))).toEqual([]);
  });

  it("prints a line break in a typed label as one space", async () => {
    const c = structuredClone(INVOICE_DEFAULT_CONFIG);
    c.sections.find((s) => s.key === "order_strip")!.fields.find((f) => f.key === "your_po")!.label = "Customer\nPO #:";
    const labelsAsTyped = [LABELS[0], "Customer PO #:", LABELS[2], LABELS[3]];
    const { fields, labels } = await printed(sampleData(), validateConfig("INVOICE", c), labelsAsTyped);
    onOneLine(labels);
    expect(fields[1].map((r) => r.text).join("")).toBe("Customer PO #: 89499");
    expect(fields[1].map((r) => r.y)).toEqual(fields[1].map(() => labels[0].y));
  });

  // A typed label prints as typed, and a hidden field drops its pair, on the rendered page: the three
  // fields left on one line, and nothing of the PO drawn.
  it("prints a typed label as typed and drops a hidden field's pair, the other fields on one line", async () => {
    const c = structuredClone(INVOICE_DEFAULT_CONFIG);
    const fields = c.sections.find((s) => s.key === "order_strip")!.fields;
    fields.find((f) => f.key === "material")!.label = "Alloy:";
    fields.find((f) => f.key === "your_po")!.visible = false;
    const { page, labels } = await printed(sampleData(), validateConfig("INVOICE", c), [LABELS[0], "Alloy:", LABELS[3]]);
    onOneLine(labels);
    expect(page.filter((r) => ["Your", "Your PO #:", "89499", "Material:"].includes(r.text.trim()))).toEqual([]);
  });

  // The owner's amendment of 2026-10-21: a strip too narrow to share prints one field to a line. A
  // template may set the Quantity column so wide that a field's share of the line would be under 60
  // points (render.ts `MEASURED_ROW_FLOOR`); the four fields then print stacked under the strip's
  // indent (24 + the Quantity column + 6), each wrapping by word across the strip's whole width, in
  // their fixed order. A 200-character PO prints whole on page one with the PARTS heading after it,
  // as on the strip of two lines; held to its share it printed a letter or two to a line and pushed
  // the heading to a later page. The rest of the invoice takes the pages the strip of two lines left
  // it (two at 515 points with this sample, its totals on the second).
  it.each<[what: string, qty: number, weightsHidden: boolean]>([
    ["a Quantity column of 414 points and the weight columns shown", 414, false],
    ["a Quantity column of 440 points and the weight columns hidden", 440, true],
    ["a Quantity column of 515 points and the weight columns hidden", 515, true],
  ])("with %s, prints the four fields one to a line under the strip's indent, on page one", async (_what, qty, weightsHidden) => {
    const pdf = await renderPdf(buildInvoiceDefinition(sampleData({ poNumber: LONG_PO }), wideQuantity(qty, weightsHidden)));
    const [page] = textRunsWithY(pdf);
    const { fields, labels } = fieldsOf(page);
    expect(labels.map((r) => r.x)).toEqual(labels.map(() => 24 + qty + 6));
    expect(labels.every((r, i) => i === 0 || r.y < labels[i - 1].y), "each label below the one before").toBe(true);
    // The PO prints whole on page one: its runs, joined, are the label and the 200 characters.
    const words = (text: string) => text.split(/\s+/).filter((word) => word !== "");
    expect(words(fields[1].map((r) => r.text).join(""))).toEqual(words(`Your PO #: ${LONG_PO}`));
    const parts = page.findIndex((r) => r.text.trim() === "PARTS");
    expect(parts, "the PARTS heading on page one, after the strip").toBeGreaterThan(page.indexOf(labels[3]));
    // Nothing of the strip starts past the margin. (The rest of the page may: a Quantity column this
    // wide pushes the headings and figures of the columns after it there.)
    expect(page.slice(page.indexOf(labels[0]), parts).filter((r) => r.x >= 588)).toEqual([]);
  });

  // A Quantity column of 564 points with the weight columns hidden indents the strip to x = 594, past
  // the margin, where it has no width at all. render.ts hands the row back as the builder wrote it
  // and the invoice prints: the four fields on one line, past the margin.
  it("with a Quantity column of 564 points and the weight columns hidden, prints the row as the builder wrote it", async () => {
    const pdf = await renderPdf(buildInvoiceDefinition(sampleData(), wideQuantity(564, true)));
    expect(pageCount(pdf)).toBe(1);
    const { labels } = fieldsOf(textRunsWithY(pdf)[0]);
    expect(labels[0].x).toBe(594);
    onOneLine(labels);
  });

  // 590-3: no switch. Every stored invoice template prints the strip on one line from its next print.
  it.each([
    ["the seed migration's literal (every install's Standard)", () => seedLiteral("INVOICE")],
    ["the frozen typed-label config", () => storedBefore("INVOICE", "typed-label")],
  ])("a print through %s prints the four labels on one line", async (_what, stored) => {
    const { labels } = await printed(sampleData(), normalizeStoredConfig("INVOICE", stored()));
    onOneLine(labels);
  });
});

// -------------------------------------------------------------------------------------------
// A rule after each part's prices on paper (owner ruling of 2026-10-20, #589).
// -------------------------------------------------------------------------------------------

// A rule is read from `strokedLines`, whose y is top-down, and the lines either side of it from
// `textRunsWithY`, whose y is a baseline from the bottom of the page, so a run's top-down y is 792
// less its y. A rule is a horizontal stroke of the rule's thickness below the PRICE heading: the
// column strip's box draws 0.8 points, above the heading.
describe("a rule after each part's prices on the printed page (#589)", () => {
  /** The rule's thickness, as the owner ruled at the paper look of 2026-10-21. */
  const RULE_WIDTH = 0.5;
  const PART_B = { qty: 50, partNumber: "DEMO-9002-000", partName: "SPRING SEAT", partDescription: "", eachWeight: 3.2, totalWeight: 160 };
  const op = (description: string, partIndex: number | null, unitPrice: number, sign: 1 | -1) =>
    ({ description, pricePerLabel: "Each", unitPrice, minimumCharge: null, setupCharge: null, amount: sign * unitPrice * 10, partIndex });
  /** Two parts and a price that lost its part, the rows given as [part 1, part 0, lost, part 1]: the
   *  page prints Carburize, then Temper and Anneal, then Normalize. `sign` is -1 for the credit memo. */
  const grouped = (sign: 1 | -1): InvoicePdfData => sampleData({
    ...(sign < 0 ? { title: "Credit", documentNumber: "1000" } : {}),
    parts: [sampleData().parts[0], PART_B],
    priceRows: [op("Temper", 1, 2, sign), op("Carburize", 0, 1, sign), op("Normalize", null, 4, sign), op("Anneal", 1, 3, sign)],
    subtotal: sign * 100, surchargeRows: [], total: sign * 100,
  });

  /** Page one's rules, top to bottom, with the line of runs drawn nearest above and below each. */
  const ruled = (pdf: Buffer) => {
    expect(pageCount(pdf)).toBe(1);
    const [runs] = textRunsWithY(pdf);
    const top = (run: Run) => 792 - run.y;
    const heading = runs.find((r) => r.text.trim() === "PRICE")!;
    const rules = strokedLines(pdf)[0]
      .filter((s) => s.y1 === s.y2 && s.width === RULE_WIDTH && s.y1 > top(heading))
      .sort((a, b) => a.y1 - b.y1);
    /** The runs on the baseline nearest `y`, above or below it, joined in the order drawn. */
    const lineNear = (y: number, side: "above" | "below") => {
      const ys = runs.map(top).filter((t) => (side === "above" ? t < y : t > y));
      const at = side === "above" ? Math.max(...ys) : Math.min(...ys);
      return runs.filter((r) => top(r) === at).map((r) => r.text).join("");
    };
    return {
      runs, rules,
      between: rules.map((rule) => [lineNear(rule.y1, "above"), lineNear(rule.y1, "below")]),
    };
  };
  /** Each rule runs from the left margin to the right one, 24 to 588. */
  const marginToMargin = (rules: { x1: number; x2: number }[]) => {
    for (const rule of rules) {
      expect(Math.min(rule.x1, rule.x2)).toBeCloseTo(24, 2);
      expect(Math.max(rule.x1, rule.x2)).toBeCloseTo(588, 2);
    }
  };
  /** The three groups' rules: each between its group's last line and the next group's first
   *  operation, the last above Sub Total. */
  const threeGroups = (pdf: Buffer) => {
    const { runs, rules, between } = ruled(pdf);
    expect(rules).toHaveLength(3);
    marginToMargin(rules);
    const opAt = (name: string) => 792 - runs.find((r) => r.text.trim() === name)!.y;
    const ops = ["Carburize", "Temper", "Anneal", "Normalize"].map(opAt);
    expect(ops.every((y, i) => i === 0 || y > ops[i - 1]), "the operations top to bottom in their groups' order").toBe(true);
    expect(between.map(([above]) => above)).toEqual(["Price per Each:  $1.00", "Price per Each:  $3.00", "Price per Each:  $4.00"]);
    expect(between.map(([, below]) => below.split("$")[0])).toEqual(["Temper", "Normalize", "Sub Total Amount:"]);
  };

  it.each([["the invoice", 1], ["the credit memo", -1]] as const)(
    "%s with two parts and a price that lost its part prints three rules, one after each group", async (_paper, sign) => {
      threeGroups(await renderPdf(buildInvoiceDefinition(grouped(sign))));
    });

  // The strip and the operation rows follow a typed width (at 362 the strip inks to 624); the rule
  // does not. Each build first shows the typed width took effect: the column strip's rightmost
  // vertical rule, the one crossing its "Quantity" heading, is centred at 24 (the left margin) plus
  // the four columns' widths (52 + the typed width + 66 + 84), plus the boxed layout's 4 points of
  // padding on each side of each column (32) and its five 0.8-point rules (4), less half a rule:
  // 623.6 at 362, 461.6 at 200.
  it.each([[362, 623.6], [200, 461.6]])("under an information column typed %i points wide, each rule still runs 24 to 588", async (width, stripEnd) => {
    const c = structuredClone(INVOICE_DEFAULT_CONFIG);
    c.sections.find((s) => s.key === "column_header")!.fields.find((f) => f.key === "col_info")!.width = width;
    // The contract's own battery: 362 is refused by the registry since R-B (#991); the rule is the builder's.
    const pdf = await renderPdf(buildInvoiceDefinition(grouped(1), validateContractConfig(INVOICE_CONTRACT, c)));
    expect(24 + (52 + width + 66 + 84) + 4 * 2 * 4 + 5 * 0.8 - 0.4).toBeCloseTo(stripEnd, 6);
    const quantity = textRunsWithY(pdf)[0].filter((r) => r.text.trim() === "Quantity");
    expect(quantity, "the strip's one Quantity heading").toHaveLength(1);
    const y = 792 - quantity[0].y;
    const verticals = strokedLines(pdf)[0]
      .filter((s) => s.x1 === s.x2 && s.width === 0.8 && Math.min(s.y1, s.y2) < y && Math.max(s.y1, s.y2) > y);
    expect(verticals, "the strip's five column edges").toHaveLength(5);
    expect(Math.max(...verticals.map((s) => s.x1))).toBeCloseTo(stripEnd, 2);

    const { rules } = ruled(pdf);
    expect(rules).toHaveLength(3);
    marginToMargin(rules);
  });

  it("the one-part sample prints one rule, between its prices and Sub Total", async () => {
    const { rules, between } = ruled(await renderPdf(buildInvoiceDefinition(sampleData())));
    expect(rules).toHaveLength(1);
    marginToMargin(rules);
    expect(between).toEqual([["Minimum Charge:  $600.00", "Sub Total Amount:$937.44"]]);
  });

  // The page-break ruling (589-5, "Keep it as shown" at the paper look): nothing keeps a group with
  // its rule, so the rule may print alone at the top of the next page. The paper look's fixture
  // breaks there: seven parts of one priced operation each fill page 1 to the last group's minimum
  // line, and that group's rule opens page 2, under the continuation header, above Sub Total.
  // Mutation-proven: no rule after the last group reds it (six rules, not seven).
  it("seven parts over two pages: the last group's rule prints alone at the top of page 2, above Sub Total", async () => {
    const parts = Array.from({ length: 7 }, (_, i) => ({
      qty: 10 + i, partNumber: `DEMO-${9100 + i}-000`, partName: `PART ${i + 1}`, partDescription: "", eachWeight: 5, totalWeight: 5 * (10 + i),
    }));
    const priceRows = parts.map((p, i) =>
      ({ description: "Austemper", pricePerLabel: "Each", unitPrice: 2.5, minimumCharge: 100, setupCharge: null, amount: p.qty * 2.5, partIndex: i }));
    const pdf = await renderPdf(buildInvoiceDefinition(sampleData({ parts, priceRows })));
    expect(pageCount(pdf)).toBe(2);

    const rules = strokedLines(pdf).map((page) => page.filter((s) => s.y1 === s.y2 && s.width === RULE_WIDTH));
    expect(rules.flat(), "a rule for each of the seven groups").toHaveLength(7);
    marginToMargin(rules.flat());
    expect(rules.map((page) => page.length)).toEqual([6, 1]);
    const [page1, page2] = textRunsWithY(pdf);
    const top = (run: Run) => 792 - run.y;
    // Every price is on page 1, the last group's minimum line among them.
    expect(page1.filter((r) => r.text.trim() === "$100.00")).toHaveLength(7);
    expect(page2.some((r) => r.text.trim() === "Austemper")).toBe(false);
    const [rule] = rules[1];
    // Above the rule, only the continuation header; the first line below it is Sub Total's.
    const above = page2.filter((r) => top(r) < rule.y1);
    expect(above.map((r) => r.text).join("")).toBe("Invoice No.: 7 - 92026(continued)");
    const bodyBelow = page2.filter((r) => top(r) > rule.y1 && top(r) < 748);
    const first = Math.min(...bodyBelow.map(top));
    expect(bodyBelow.filter((r) => top(r) === first).map((r) => r.text).join("")).toMatch(/^Sub Total Amount:\$/);
  });

  // The rule that ends the content has no space below it (the owner's answer of 2026-10-21, plan
  // Amendment 4). pdfmake starts a new page when a node's bottom margin does not fit, so a final rule
  // whose group ended 4 to 5 points above the page foot drew, then left a blank last page for its
  // 1 point. Found by search over the parts and prices: with Totals hidden, ten priced parts and
  // twenty-two with no price end the last group 4.47 points above page 2's foot.
  it("with Totals hidden, a last group ending 4.47 points above the page foot prints no blank last page", async () => {
    const parts = Array.from({ length: 32 }, (_, i) => ({
      qty: 10 + i, partNumber: `DEMO-${9100 + i}-000`, partName: `PART ${i + 1}`, partDescription: "", eachWeight: 5, totalWeight: 5 * (10 + i),
    }));
    const price = (description: string, partIndex: number, unitPrice: number, minimumCharge: number | null = null) =>
      ({ description, pricePerLabel: "Each", unitPrice, minimumCharge, setupCharge: null, amount: 10 * unitPrice, partIndex });
    // Austemper on each of the first ten parts, Temper too on the first three and the tenth, whose
    // Austemper carries a minimum.
    const priceRows = Array.from({ length: 10 }, (_, i) => [
      price("Austemper", i, 2.5, i === 9 ? 100 : null), ...(i < 3 || i === 9 ? [price("Temper", i, 3.5)] : []),
    ]).flat();
    const c = structuredClone(INVOICE_DEFAULT_CONFIG);
    c.sections.find((s) => s.key === "totals")!.visible = false;
    const pdf = await renderPdf(buildInvoiceDefinition(sampleData({ parts, priceRows }), validateConfig("INVOICE", c)));

    const rules = strokedLines(pdf).map((page) => page.filter((s) => s.y1 === s.y2 && s.width === RULE_WIDTH));
    /** A page's runs between the continuation header (above 40) and the footer strip (below 748). */
    const body = textRunsWithY(pdf).map((page) => page.filter((r) => 792 - r.y > 40 && 792 - r.y < 748));
    const holdingContent = body.filter((runs, p) => runs.length > 0 || rules[p].length > 0).length;
    expect(rules.flat()).toHaveLength(10);
    const last = rules.flat().at(-1)!;
    // The fixture is the case it was found as: its group ends `room` points above the foot (792 less
    // the 44-point bottom margin), the rule drawn 4 points below it.
    const room = 748 - (last.y1 - 4);
    expect(room).toBeCloseTo(4.47, 2);
    expect(pageCount(pdf)).toBe(holdingContent);
    expect(pageCount(pdf)).toBe(2);
    expect(body[1].map((r) => r.text.trim())).toContain("Temper");
  });

  // 589-2: no switch. Every stored invoice template prints the rules from its next print.
  it.each([
    ["the seed migration's literal (every install's Standard)", () => seedLiteral("INVOICE")],
    ["the frozen typed-label config", () => storedBefore("INVOICE", "typed-label")],
  ])("a print through %s prints the three rules", async (_what, stored) => {
    threeGroups(await renderPdf(buildInvoiceDefinition(grouped(1), normalizeStoredConfig("INVOICE", stored()))));
  });
});

// -------------------------------------------------------------------------------------------
// The real data path + the print/archive mechanics.
// -------------------------------------------------------------------------------------------

describe("printInvoice", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("builds the print payload off the frozen invoice detail (parts, price grid, surcharge, total)", async () => {
    await asSystem(() => setSetting("company_name", "Example Heat Treating - Alabama, LLC"));
    await asSystem(() => setSetting("company_address", "100 Example Way\nAnniston AL 36207"));
    await asSystem(() => createSurcharge({ name: "EnergySur", kind: "FLAT", amount: "37.50", position: 1, scope: "ALL" }));
    const { order, part } = await pricedShippedOrder();
    const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));

    const data = await readInvoicePdfData(prisma, invoice.id);
    expect(data.title).toBe("Invoice");
    expect(data.company.name).toBe("Example Heat Treating - Alabama, LLC");
    expect(data.remitTo.lines).toContain("100 Example Way");
    expect(data.billTo).toContain("Demo Foundry - Columbus LLC");           // the FROZEN snapshot, split into lines
    expect(data.parts).toEqual([
      { qty: 144, partNumber: part.partNumber, partName: "EQUALIZER-RR SUSP", partDescription: "", eachWeight: 21, totalWeight: 3024 },
    ]);
    expect(data.priceRows[0]).toMatchObject({ description: "Austemper", pricePerLabel: "Each", unitPrice: 6.51, minimumCharge: 600, amount: 937.44 });
    expect(data.subtotal).toBe(937.44);
    expect(data.surchargeRows).toEqual([{ description: "EnergySur", amount: 37.5 }]);
    expect(data.total).toBe(974.94);

    const text = allText(buildInvoiceDefinition(data)).join(" ");
    expect(text).toContain("937.44");
    expect(text).toContain("EnergySur");
    expect(text).toContain("974.94");
  });

  it("archives kind INVOICE and reprints the identical stored bytes", async () => {
    const { invoice } = await finalizedFixture();
    const first = await asSystem(() => printInvoice(invoice.id));
    const stored = await getDocument(first.documentId);
    expect(stored.kind).toBe("INVOICE");
    expect(stored.invoiceId).toBe(invoice.id);
    expect(stored.orderId).toBeNull();
    expect(Buffer.compare(stored.fileData, first.pdf)).toBe(0);   // STORED bytes — exact by design

    // A reprint is a byte-for-byte reissue of the STORED bytes, never a re-render.
    const reprint = await getDocument(first.documentId);
    expect(Buffer.compare(reprint.fileData, first.pdf)).toBe(0);
  });

  it("a finalized invoice printed twice stores two documents under one template version, and its page carries the weights with their unit (W15)", async () => {
    // The Standard's published version becomes a config in the shape an install holds today.
    const { versionId } = await publishStored("INVOICE", storedBefore("INVOICE", "typed-label"));
    const { invoice } = await finalizedFixture();
    const first = await asSystem(() => printInvoice(invoice.id));
    const second = await asSystem(() => printInvoice(invoice.id));

    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    const stored = await prisma.storedDocument.findMany({
      where: { invoiceId: invoice.id }, select: { id: true, templateVersionId: true },
    });
    expect(stored.sort(byId)).toEqual([
      { id: first.documentId, templateVersionId: versionId },
      { id: second.documentId, templateVersionId: versionId },
    ].sort(byId));

    // 144 pieces at 21 lb: the part row's two weights, in the order the page draws them. Read from
    // the first print alone. Nothing changes between the two prints, so the second page's text is
    // the same fixed text, and what holds the second print is the two stored documents above.
    expect(drawnText(first.pdf)).toContain("21.00 lb3,024.00 lb");
  });

  it("keeps no byte in the audit payload", async () => {
    const { invoice } = await draftFixture();
    const printed = await asSystem(() => printInvoice(invoice.id));
    const entry = await prisma.auditLog.findFirst({ where: { entity: "storedDocument", entityId: printed.documentId } });
    expect(entry).not.toBeNull();
    expect(JSON.stringify(entry!.after)).not.toContain("fileData");
    expect(JSON.stringify(entry!.after)).not.toContain("%PDF");
  });

  it("refuses a new print on a discarded draft, and keeps old prints downloadable", async () => {
    const { invoice } = await draftFixture();
    const printed = await asSystem(() => printInvoice(invoice.id));
    // Discard is refused once printed (Task 12) — swallow it, then force the discarded state.
    await asSystem(() => discardInvoice(invoice.id, "raised in error")).catch(() => {});
    await prisma.invoice.update({ where: { id: invoice.id }, data: { deletedAt: new Date() } });
    await expect(asSystem(() => printInvoice(invoice.id))).rejects.toThrow(/voided/i);
    await expect(getDocument(printed.documentId)).resolves.toBeTruthy();
  });

  it("refuses a new print for a voided ORDER, keeping stored prints readable", async () => {
    const { invoice, order } = await draftFixture();
    const printed = await asSystem(() => printInvoice(invoice.id));
    await prisma.order.update({ where: { id: order.id }, data: { deletedAt: new Date() } });
    await expect(asSystem(() => printInvoice(invoice.id))).rejects.toThrow(VOIDED_PRINT);
    expect((await getDocument(printed.documentId)).fileData.length).toBeGreaterThan(0);
  });

  it("404s an invoice that does not exist", async () => {
    await expect(asSystem(() => printInvoice("nope"))).rejects.toThrow(/not found/i);
  });

  it("prints a credit with its credit number and negative amounts", async () => {
    const { invoice } = await finalizedFixture();
    const credit = await asSystem(() => createCredit(invoice.id));
    const { documentNumber, documentId, pdf } = await asSystem(() => printInvoice(credit.id));
    expect(documentNumber).toBe(String(credit.creditNumber));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    // The number and negatives are pinned on the DEFINITION (the glyph-id reason) — built from the
    // same data the print used.
    const text = allText(buildInvoiceDefinition(await readInvoicePdfData(prisma, credit.id))).join(" ");
    expect(text).toContain("Credit");
    expect(text).toContain(String(credit.creditNumber));
    expect(text).toContain("-937.44");

    const stored = await prisma.storedDocument.findUniqueOrThrow({ where: { id: documentId } });
    expect(stored.kind).toBe("CREDIT");          // the kind follows the invoice row's own kind
    expect(stored.invoiceId).toBe(credit.id);
    // The stored credit memo prints its order strip on one line (#590), read from its own page.
    onOneLine(fieldsOf(textRunsWithY(Buffer.from(stored.fileData))[0]).labels);
  });

  it("the Preview picker names an invoice and a credit as the paper does", async () => {
    // PreviewPane's optionsFor restates the paper's title and invoiceDocumentNumber on the client;
    // this holds the two together, an invoice under a number prefix and its credit.
    await asSystem(() => setSetting("invoice_number_prefix", "7"));
    await asSystem(() => setSetting("credit_number_next", 5000)); // apart from the order number
    const { invoice, order } = await finalizedFixture();
    const credit = await asSystem(() => createCredit(invoice.id));
    expect(credit.creditNumber).not.toBe(order.orderNumber);
    const options = optionsFor("invoice", await listInvoices({}));
    for (const [id, title] of [[invoice.id, "Invoice"], [credit.id, "Credit"]]) {
      const data = await readInvoicePdfData(prisma, id);
      expect(data.title).toBe(title);
      // The invoice's number carries the prefix, so the prefixed form is the one held; a credit's is
      // its own number alone.
      if (title === "Invoice") expect(data.documentNumber).toContain(" - ");
      else expect(data.documentNumber).toBe(String(credit.creditNumber));
      const option = options.find((o) => o.id === id);
      expect(option).toBeDefined();
      expect(option!.recordNumber).toBe(`${data.title.toLowerCase()} ${data.documentNumber}`);
    }
  });

  // -----------------------------------------------------------------------------------------
  // The binding concurrency requirement (task-19-brief.md, folded in from Task 12's review):
  // printInvoice must claim the invoice row (via `claimInvoiceForPrint`: the order row, then the
  // invoice row) BEFORE it inserts the StoredDocument, so a print and a discard serialize — the
  // discard's "is it printed?" read and print's archive write cannot interleave. Discriminating
  // shape copied from `createInvoice`/`finalizeInvoice`'s own concurrency tests: the competing
  // caller (print) runs at Read Committed via a manually-opened tx, so ONLY the row lock — not SSI
  // — can order the two.
  //
  // The holder mimics discardInvoice holding its claim: it claims the Order row and the Invoice
  // row, then soft-deletes the invoice, all before committing. WITH the claim, print blocks on the
  // holder's order-row lock, then reads the freshly-discarded invoice and refuses — no doc
  // archived. WITHOUT it (RED, verified by hand — see the task report), print reads the invoice
  // through an unlocked snapshot (still live), renders, and its insert lands AFTER the holder
  // commits the delete: a discarded invoice with an archived PDF, and printInvoice RESOLVES instead
  // of rejecting.
  it("claims the invoice row before archiving: a discard-holder makes print refuse, no doc (row-lock discipline)", async () => {
    const { invoice, order } = await draftFixture();

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${invoice.id} FOR UPDATE`;
      await tx.invoice.update({ where: { id: invoice.id }, data: { deletedAt: new Date() } });
      hasClaimed();
      await release;
    }, { timeout: 20000 });

    await claimed;
    // Print at Read Committed — printInvoice called against a manually-opened tx rather than through
    // the public no-`tx` API (which always forces Serializable).
    const printCall = asSystem(() => prisma.$transaction((tx) => printInvoice(invoice.id, tx), { timeout: 20000 }));

    const TIMED_OUT = Symbol("timed out");
    const raceResult = await Promise.race([
      printCall.then(() => "settled" as const, () => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
    ]);
    expect(raceResult).toBe(TIMED_OUT);          // blocked on the holder's row claim

    mayRelease();
    await holder;

    // With the claim: print reads the freshly-discarded invoice under the lock and refuses; no doc.
    await expect(printCall).rejects.toThrow(/voided/i);
    expect(await prisma.storedDocument.count({ where: { invoiceId: invoice.id } })).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------
// Each price row carries its part (#589, owner ruling of 2026-10-20): the index in `parts` of the
// PART line the operation's saved `parentLineId` names, one level, or null. Every case is a real
// invoice whose ties were written by the services (create, the lines save, Recalculate, the credit
// copy), never by hand.
// -------------------------------------------------------------------------------------------

/** A stored line as a lines-save payload item (tests/invoices.test.ts's `toLineInput`): `key` is
 *  the stored id, `parentKey` the stored parent's, so the save re-wires the same ties. */
function toLineInput(l: InvoiceLineDetail) {
  return {
    key: l.id, parentKey: l.parentLineId, kind: l.kind,
    orderLineId: l.orderLineId, processStepCodeId: l.processStepCodeId,
    surchargeId: l.surchargeId, orderChargeId: l.orderChargeId, glAccountId: l.glAccountId,
    partNumber: l.partNumber, partName: l.partName, partDescription: l.partDescription,
    description: l.description, glAccountName: l.glAccountName,
    qty: l.qty, weight: l.weight, eachWeight: l.eachWeight,
    pricePer: l.pricePer, unitPrice: l.unitPrice,
    setupCharge: l.setupCharge, minimumCharge: l.minimumCharge,
    breakThreshold: l.breakThreshold, minimumApplied: l.minimumApplied,
    rate: l.rate, priceSource: l.priceSource, needsPrice: l.needsPrice,
    amount: l.amount,
  };
}

/** A fully shipped order of two parts, A (10 pieces) then B (20), each priced for Austemper at $1
 *  each, and its draft invoice in the engine's order: PART A, A's operation, PART B, B's.
 *  `samePart`: B is part A again, on the order's second line (nothing refuses a part repeated on an
 *  order), so both lines are priced by A's one Austemper row. `normalizeOnA`: A is also priced for
 *  Normalize at $2 each, a second operation under PART A, after its Austemper. */
async function twoPartDraft(opts: { samePart?: boolean; normalizeOnA?: boolean } = {}) {
  const customer = await makeCustomer();
  await makeBillTo(customer.id);
  const partA = await makePart(customer.id);
  const partB = opts.samePart ? partA : await makePart(customer.id);
  const parts = opts.samePart ? [partA] : [partA, partB];
  for (const part of parts) await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber: "89499",
    lines: [{ partId: partA.id, qty: 10, weight: "210.00" }, { partId: partB.id, qty: 20, weight: "420.00" }],
  }));
  const { shipper } = await createShipper({
    customerId: customer.id, shipDate: "2026-07-29",
    orders: [{
      orderId: order.id,
      lines: order.lines.map((l) => ({ orderLineId: l.id, qty: l.qty, weight: l.weight, lineComplete: true })),
      containers: [], serials: [],
    }],
  }, { canOverrideCreditHold: false });
  const gl = await prisma.glAccount.create({ data: { name: "4010", description: "Sales" } });
  const code = await prisma.processStepCode.create({ data: { code: "AUST", name: "Austemper", glAccountId: gl.id } });
  for (const part of parts) {
    await asSystem(() => addPartPrice(part.id, {
      processStepCodeId: code.id, position: 1, unitPrice: "1.0000", minimumCharge: null, pricePer: "EACH",
    }));
  }
  if (opts.normalizeOnA) {
    const normalize = await prisma.processStepCode.create({ data: { code: "NORM", name: "Normalize", glAccountId: gl.id } });
    await asSystem(() => addPartPrice(partA.id, {
      processStepCodeId: normalize.id, position: 2, unitPrice: "2.0000", minimumCharge: null, pricePer: "EACH",
    }));
  }
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  // The engine's order, each operation under its own part (then TAX, for a taxed plant): what
  // every case below starts from.
  const engineOrder = ["PART", "OPERATION", ...(opts.normalizeOnA ? ["OPERATION"] : []), "PART", "OPERATION"];
  expect(invoice.lines.slice(0, engineOrder.length).map((l) => l.kind)).toEqual(engineOrder);
  expect(invoice.lines.slice(engineOrder.length).every((l) => l.kind === "TAX")).toBe(true);
  const [lineA, opA, ...rest] = invoice.lines;
  const normalizeA = opts.normalizeOnA ? rest.shift()! : null;
  const [lineB, opB] = rest;
  expect([lineA.partNumber, lineB.partNumber]).toEqual([partA.partNumber, partB.partNumber]);
  expect([opA.parentLineId, opB.parentLineId]).toEqual([lineA.id, lineB.id]);
  if (normalizeA !== null) expect([normalizeA.description, normalizeA.parentLineId]).toEqual(["Normalize", lineA.id]);
  return { invoice, lineA, opA, lineB, opB, partA, shipper };
}

/** Each price row of the invoice's print payload as [description, amount, partIndex]. */
const priceParts = async (invoiceId: string) =>
  (await readInvoicePdfData(prisma, invoiceId)).priceRows.map((r) => [r.description, r.amount, r.partIndex]);
/** The part numbers of the print payload's PARTS list, in its order: what `partIndex` counts in. */
const partNumbers = async (invoiceId: string) =>
  (await readInvoicePdfData(prisma, invoiceId)).parts.map((p) => p.partNumber);
/** A typed operation line: a manual price with no order line and no step code. */
const typedPrice = (description: string, amount: string, ties: { key?: string; parentKey?: string } = {}) => ({
  ...ties, kind: "OPERATION" as const, description, amount, priceSource: "MANUAL" as const,
});

describe("each price row carries its part (#589)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("an untouched two-part invoice: each operation reads its own part's index", async () => {
    const { invoice, lineA, lineB } = await twoPartDraft();
    expect(await partNumbers(invoice.id)).toEqual([lineA.partNumber, lineB.partNumber]);
    expect(await priceParts(invoice.id)).toEqual([["Austemper", 10, 0], ["Austemper", 20, 1]]);
  });

  // Nothing refuses a part repeated on an order, so two PART lines can carry one part number.
  // Mutation-proven: keying the lookup by the parent PART line's part number (the first PART line
  // with that number) reads both as 0.
  it("the same part on two order lines: each operation reads its own PART line's index", async () => {
    const { invoice, lineA, lineB } = await twoPartDraft({ samePart: true });
    expect(lineB.orderLineId).not.toBe(lineA.orderLineId);
    expect(await partNumbers(invoice.id)).toEqual([lineA.partNumber, lineA.partNumber]);
    expect(await priceParts(invoice.id)).toEqual([["Austemper", 10, 0], ["Austemper", 20, 1]]);
  });

  // Mutation-proven: mapping by the nearest PART above (position) reads both as 1, and mapping by
  // the order line reads both as 0.
  it("a draft save whose order and ties disagree: each reads its parent's index, never the nearest part above nor its order line's", async () => {
    const { invoice, lineA, opA, lineB, opB } = await twoPartDraft();
    const saved = await asSystem(() => replaceInvoiceLines(invoice.id, [
      toLineInput(lineA), toLineInput(lineB),
      // A's own operation, placed after B: the nearest part above it is B.
      { ...toLineInput(opA), description: "Names A, below B" },
      // B's operation, moved onto A's order line, still naming B.
      { ...toLineInput(opB), orderLineId: lineA.orderLineId, description: "Names B, ships on A's line" },
    ]));
    // The ties as the save wrote them: the setup the case is about.
    const [savedA, savedB, savedX, savedY] = saved.lines;
    expect(saved.lines.map((l) => l.kind)).toEqual(["PART", "PART", "OPERATION", "OPERATION"]);
    expect([savedX.parentLineId, savedY.parentLineId]).toEqual([savedA.id, savedB.id]);
    expect([savedX.orderLineId, savedY.orderLineId]).toEqual([savedA.orderLineId, savedA.orderLineId]);

    expect(await partNumbers(invoice.id)).toEqual([lineA.partNumber, lineB.partNumber]);
    expect(await priceParts(invoice.id)).toEqual([["Names A, below B", 10, 0], ["Names B, ships on A's line", 20, 1]]);
  });

  it("a draft save that drops the first PART row: its operation reads null, the second part's reads 0", async () => {
    const { invoice, lineB, opA, opB } = await twoPartDraft();
    const saved = await asSystem(() => replaceInvoiceLines(invoice.id, [opA, lineB, opB].map(toLineInput)));
    // A's operation names a line the payload no longer holds, so the save leaves it flat.
    expect(saved.lines.map((l) => [l.kind, l.parentLineId])).toEqual([
      ["OPERATION", null], ["PART", null], ["OPERATION", saved.lines[1].id],
    ]);

    expect(await partNumbers(invoice.id)).toEqual([lineB.partNumber]);
    expect(await priceParts(invoice.id)).toEqual([["Austemper", 10, null], ["Austemper", 20, 0]]);
  });

  // Through the lines PUT, whose `parentKey` accepts any key. Mutation-proven: walking up the parent
  // chain reads the operation-parented price as A's 0.
  it("an operation tied to an operation, a charge or itself reads null (one level, never a chain)", async () => {
    const { invoice, lineA, opA, lineB, opB } = await twoPartDraft();
    const cookie = await signInWith(["invoicing.edit", "action.change_prices"], "589-lines");
    const res = await linesRoute(new Request(`http://t/api/invoices/${invoice.id}/lines`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify([
        ...[lineA, opA, lineB, opB].map(toLineInput),
        { key: "rush", kind: "CHARGE", description: "Rush", amount: "5.00", priceSource: "MANUAL" },
        typedPrice("Under an operation", "1.00", { key: "under-op", parentKey: opA.id }),
        typedPrice("Under a charge", "2.00", { key: "under-charge", parentKey: "rush" }),
        typedPrice("Under itself", "3.00", { key: "under-itself", parentKey: "under-itself" }),
      ]),
    }), withParams({ id: invoice.id }));
    expect(res.status).toBe(200);

    // The ties as the save wrote them: each typed price has a parent, and it is not a PART line.
    const saved = await asSystem(() => getInvoice(invoice.id));
    const byDescription = (d: string) => saved.lines.find((l) => l.description === d)!;
    const parentKind = (d: string) => saved.lines.find((l) => l.id === byDescription(d).parentLineId)?.kind;
    expect(parentKind("Under an operation")).toBe("OPERATION");
    expect(saved.lines.find((l) => l.id === byDescription("Under an operation").parentLineId)!.parentLineId)
      .toBe(saved.lines[0].id); // that operation is A's, under PART A
    expect(parentKind("Under a charge")).toBe("CHARGE");
    expect(byDescription("Under itself").parentLineId).toBe(byDescription("Under itself").id);

    expect(await priceParts(invoice.id)).toEqual([
      ["Austemper", 10, 0], ["Austemper", 20, 1],
      ["Under an operation", 1, null], ["Under a charge", 2, null], ["Under itself", 3, null],
    ]);
  });

  // Mutation-proven: mapping by the nearest PART above reads the typed price as B's 1, and mapping
  // by the order line reads it as null (it has none).
  it("a typed price Recalculate keeps under a manual PART parent sits after TAX and reads its part's index", async () => {
    const taxGl = await prisma.glAccount.create({ data: { name: "2200", description: "Sales tax payable" } });
    await asSystem(() => setBillingConfig({ salesTaxGlAccountId: taxGl.id, salesTaxRate: "0.040000" }));
    const { invoice, lineA, opA, lineB, opB } = await twoPartDraft();
    const tax = invoice.lines.find((l) => l.kind === "TAX");
    expect(tax, "the taxable customer's draft carries a TAX line").toBeDefined();
    await asSystem(() => replaceInvoiceLines(invoice.id, [
      // PART A overridden by hand, so Recalculate keeps it in A's slot (`keyByManualId`).
      { ...toLineInput(lineA), priceSource: "MANUAL" as const },
      ...[opA, lineB, opB, tax!].map(toLineInput),
      typedPrice("Typed price", "7.00", { key: "typed", parentKey: lineA.id }),
    ]));

    const after = await asSystem(() => recalculateInvoice(invoice.id));
    expect(after.lines.map((l) => l.kind)).toEqual(["PART", "OPERATION", "PART", "OPERATION", "TAX", "OPERATION"]);
    const typed = after.lines[5];
    expect(typed.description).toBe("Typed price");
    expect(typed.position).toBeGreaterThan(after.lines[4].position); // after TAX by position
    expect(after.lines[0].priceSource).toBe("MANUAL");
    expect(typed.parentLineId).toBe(after.lines[0].id);              // under the manual PART A

    expect(await partNumbers(invoice.id)).toEqual([lineA.partNumber, lineB.partNumber]);
    expect(await priceParts(invoice.id)).toEqual([["Austemper", 10, 0], ["Austemper", 20, 1], ["Typed price", 7, 0]]);
  });

  // Recalculate and a typed price's part (the owner's answer of 2026-10-21, plan Amendment 4): a
  // manual line that finds no slot rides at the end, and keeps its tie when its saved parent was a
  // DERIVED line: it is re-tied to the line of the final set that the old parent's identity names.
  // Before, only a manual parent was kept, so the typed price below printed in the last group
  // though its part line still printed. Mutation-proven: keeping only a manual parent (the old
  // mapping) reds this case and the next two.
  it("a typed amount Recalculate moves to the end is re-tied to its regenerated PART line, and reads its part's index", async () => {
    const { invoice, lineA, opA, lineB, partA } = await twoPartDraft({ normalizeOnA: true });
    // A's Austemper typed by hand: a MANUAL line whose saved parent is the derived PART A.
    const saved = await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) =>
      (l.id === opA.id ? { ...toLineInput(l), amount: "15.00", priceSource: "MANUAL" as const } : toLineInput(l)))));
    const typedBefore = saved.lines.find((l) => l.priceSource === "MANUAL")!;
    const partBefore = saved.lines.find((l) => l.id === typedBefore.parentLineId)!;
    expect([partBefore.kind, partBefore.priceSource, partBefore.orderLineId]).toEqual(["PART", null, lineA.orderLineId]); // derived
    // A's Austemper price retired: the engine no longer prices it, and A's Normalize was already
    // billed in its own right, so the typed line takes no slot and rides at the end (#61).
    const austemper = (await listPartPrices(partA.id)).find((p) => p.stepCode === "AUST")!;
    await asSystem(() => deletePartPrice(partA.id, austemper.id));

    const after = await asSystem(() => recalculateInvoice(invoice.id));
    expect(after.lines.map((l) => [l.kind, l.description])).toEqual([
      ["PART", lineA.description], ["OPERATION", "Normalize"], ["PART", lineB.description], ["OPERATION", "Austemper"],
      ["OPERATION", "Austemper"],
    ]);
    const typed = after.lines.at(-1)!;
    expect([typed.priceSource, typed.amount]).toEqual(["MANUAL", 15]);
    const parent = after.lines.find((l) => l.id === typed.parentLineId);
    expect(parent && [parent.kind, parent.priceSource, parent.orderLineId]).toEqual(["PART", null, lineA.orderLineId]);

    expect(await partNumbers(invoice.id)).toEqual([lineA.partNumber, lineB.partNumber]);
    expect(await priceParts(invoice.id)).toEqual([["Normalize", 20, 0], ["Austemper", 20, 1], ["Austemper", 15, 0]]);
  });

  // The derived twin of the manual-PART case above. A typed price has no order line, so only its old
  // parent's identity can name its part. Mutation-proven: re-tying by the line's own order line
  // reads it as null (and the surcharge case below too); the case above, whose order line is its
  // part's, stays green under that mutation.
  it("a typed price saved under a derived PART line keeps that part at Recalculate", async () => {
    const { invoice, lineA, lineB } = await twoPartDraft();
    await asSystem(() => replaceInvoiceLines(invoice.id, [
      ...invoice.lines.map(toLineInput),
      typedPrice("Typed price", "7.00", { key: "typed", parentKey: lineA.id }),
    ]));

    const after = await asSystem(() => recalculateInvoice(invoice.id));
    expect(after.lines.map((l) => l.kind)).toEqual(["PART", "OPERATION", "PART", "OPERATION", "OPERATION"]);
    const typed = after.lines[4];
    expect([typed.description, typed.orderLineId]).toEqual(["Typed price", null]);
    expect([after.lines[0].kind, after.lines[0].priceSource]).toEqual(["PART", null]);
    expect(typed.parentLineId).toBe(after.lines[0].id); // the regenerated PART A

    expect(await partNumbers(invoice.id)).toEqual([lineA.partNumber, lineB.partNumber]);
    expect(await priceParts(invoice.id)).toEqual([["Austemper", 10, 0], ["Austemper", 20, 1], ["Typed price", 7, 0]]);
  });

  // Mutation-proven: falling back to the first PART line of the final set reads it as 0.
  it("a typed price whose derived PART line is gone at Recalculate stays untied, and reads null", async () => {
    const { invoice, lineA, lineB, shipper } = await twoPartDraft();
    await asSystem(() => replaceInvoiceLines(invoice.id, [
      ...invoice.lines.map(toLineInput),
      typedPrice("Typed price", "7.00", { key: "typed", parentKey: lineB.id }),
    ]));
    // B no longer ships: the shipment keeps A's line alone, so the engine prices no PART B.
    await asSystem(() => replaceShipperLines(shipper.id, shipper.orders[0].id,
      [{ orderLineId: lineA.orderLineId!, qty: 10, weight: 210, lineComplete: true }]));

    const after = await asSystem(() => recalculateInvoice(invoice.id));
    expect(after.lines.map((l) => [l.kind, l.description])).toEqual([
      ["PART", lineA.description], ["OPERATION", "Austemper"], ["OPERATION", "Typed price"],
    ]);
    expect(after.lines[2].parentLineId).toBeNull();

    expect(await partNumbers(invoice.id)).toEqual([lineA.partNumber]);
    expect(await priceParts(invoice.id)).toEqual([["Austemper", 10, 0], ["Typed price", 7, null]]);
  });

  // The final set's derived lines include the surcharge block Recalculate rebuilds (#586), so a line
  // tied to a derived surcharge is re-tied to the rebuilt one. It is not a PART line, so it reads null.
  // Mutation-proven: resolving against the engine's lines alone, which hold no surcharge, leaves it
  // untied.
  it("a typed price saved under a derived surcharge line is re-tied to the rebuilt surcharge at Recalculate", async () => {
    const { invoice } = await twoPartDraft();
    await asSystem(() => createSurcharge({ name: "Energy", kind: "PERCENT", rate: "0.050000", position: 1, scope: "ALL" }));
    const surcharged = await asSystem(() => recalculateInvoice(invoice.id));
    const surcharge = surcharged.lines.find((l) => l.kind === "SURCHARGE")!;
    expect([surcharge.priceSource, surcharge.amount]).toEqual([null, 1.5]); // 5% of 30.00, derived
    await asSystem(() => replaceInvoiceLines(invoice.id, [
      ...surcharged.lines.map(toLineInput),
      typedPrice("Typed price", "7.00", { key: "typed", parentKey: surcharge.id }),
    ]));

    const after = await asSystem(() => recalculateInvoice(invoice.id));
    expect(after.lines.map((l) => l.kind)).toEqual(["PART", "OPERATION", "PART", "OPERATION", "SURCHARGE", "OPERATION"]);
    expect(after.lines[5].description).toBe("Typed price");
    expect(after.lines[5].parentLineId).toBe(after.lines[4].id);
    expect(await priceParts(invoice.id)).toEqual([["Austemper", 10, 0], ["Austemper", 20, 1], ["Typed price", 7, null]]);
  });

  it("a manual price with no parent reads null", async () => {
    const { invoice } = await twoPartDraft();
    const saved = await asSystem(() => replaceInvoiceLines(invoice.id, [
      ...invoice.lines.map(toLineInput), typedPrice("No part", "4.00"),
    ]));
    expect(saved.lines.at(-1)!.parentLineId).toBeNull();

    expect(await priceParts(invoice.id)).toEqual([["Austemper", 10, 0], ["Austemper", 20, 1], ["No part", 4, null]]);
  });

  it("a credit memo raised from the invoice reads the same indexes as the invoice", async () => {
    const { invoice, lineA, opA, lineB, opB } = await twoPartDraft();
    await asSystem(() => replaceInvoiceLines(invoice.id, [
      toLineInput(lineA), toLineInput(lineB),
      { ...toLineInput(opA), description: "Names A, below B" },
      { ...toLineInput(opB), orderLineId: lineA.orderLineId, description: "Names B, ships on A's line" },
      // Finalize refuses a typed price with no step picked (#587), so this one names Austemper's.
      { ...typedPrice("No part", "4.00"), processStepCodeId: opA.processStepCodeId },
    ]));
    // Finalized in the database: B's operation, moved onto A's order line above (which no screen can
    // do), is a priced step Recalculate would put back on B's line, so Finalize refuses it (#605).
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "FINALIZED", finalizedAt: new Date() } });
    const credit = await asSystem(() => createCredit(invoice.id));

    const indexes = async (id: string) =>
      (await readInvoicePdfData(prisma, id)).priceRows.map((r) => [r.description, r.partIndex]);
    expect(await indexes(invoice.id)).toEqual([
      ["Names A, below B", 0], ["Names B, ships on A's line", 1], ["No part", null],
    ]);
    expect(await indexes(credit.id)).toEqual(await indexes(invoice.id));
    expect(await partNumbers(credit.id)).toEqual([lineA.partNumber, lineB.partNumber]);
    expect((await priceParts(credit.id)).map((r) => r[1])).toEqual([-10, -20, -4]);
  });
});

// -------------------------------------------------------------------------------------------
// #591: the selected print, `printSelectedInvoice`, behind the Invoicing list's Print selected. It
// refuses a row that is not finalized and one that has printed since it was finalized, in the
// owner's sentences (`selectedPrintRefusal`, src/lib/invoice-printed.ts), read under the print's
// claim on its own transaction. The sentences are written out here so a changed word reds too.
// -------------------------------------------------------------------------------------------

/** Polls `pg_stat_activity` until at least `count` OTHER backends are blocked on a lock inside a
 *  statement whose text contains every fragment: the proof that the prints are parked where the
 *  test needs them, in place of a blind sleep. `waitForLockWaiter` from
 *  tests/invoice-fingerprint-race.test.ts, copied with a count. */
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

const alreadyPrinted = (number: string | number) =>
  `Invoice ${number} has already printed since it was finalized, so it was not printed again.`;

describe("printSelectedInvoice (#591)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("reads the invoice's prints on the caller's transaction: a document written inside it refuses the print", async () => {
    const { invoice, order } = await finalizedFixture();
    let outcome: unknown;
    await expect(asSystem(() => prisma.$transaction(async (tx) => {
      await storeDocument(tx, { kind: "INVOICE", invoiceId: invoice.id }, Buffer.from("%PDF-1.7"));
      outcome = await printSelectedInvoice(invoice.id, tx).then(() => "printed" as const, (e: unknown) => e);
      throw new Error("roll back");
    }, { timeout: 20_000 }))).rejects.toThrow("roll back");

    expect(outcome).toBeInstanceOf(HttpError);
    expect((outcome as HttpError).status).toBe(400);
    expect((outcome as HttpError).message).toBe(alreadyPrinted(order.orderNumber));
    expect(await prisma.storedDocument.count({ where: { invoiceId: invoice.id } })).toBe(0);
  });

  it("reads the number prefix on the caller's transaction: a prefix written inside it names the refused row", async () => {
    const { invoice, order } = await draftFixture();
    let outcome: unknown;
    await expect(asSystem(() => prisma.$transaction(async (tx) => {
      await tx.setting.upsert({
        where: { key: "invoice_number_prefix" },
        create: { key: "invoice_number_prefix", value: "7" }, update: { value: "7" },
      });
      outcome = await printSelectedInvoice(invoice.id, tx).then(() => "printed" as const, (e: unknown) => e);
      throw new Error("roll back");
    }, { timeout: 20_000 }))).rejects.toThrow("roll back");

    expect(outcome).toBeInstanceOf(HttpError);
    expect((outcome as HttpError).message).toBe(`Invoice 7 - ${order.orderNumber} is not finalized, so it was not printed.`);
  });

  // DANGEROUS DIRECTION (the `close-periods.test.ts` and `invoice-fingerprint-race.test.ts`
  // precedent). The selected check reads StoredDocument rows, which no lock covers, from a snapshot
  // fixed before the print's claims (`claimInvoiceForPrint`'s stub read), and a print writes neither
  // the Order nor the Invoice row, so a second print's claim wakes with no error on its old snapshot
  // and reads no print. What stops it filing a second copy is SSI: each print read the invoice's
  // document predicate and inserted into it, and Postgres aborts the one that has not committed.
  // The late print here runs on a hand-opened Serializable transaction (a `tx` is never retried),
  // so the abort itself arrives.
  //
  // Measured 2026-10-20 on PostgreSQL 18: the late print aborts at its StoredDocument insert, P2034
  // carrying the driver's 40001 ("could not serialize access due to read/write dependencies among
  // transactions"), and one document is stored. Each of these was run once and restored:
  //   - the late transaction at Repeatable Read (this test's own option): it reads no print, files
  //     a second copy and commits; two documents. Not kept as a case, since it would pin the
  //     broken outcome.
  //   - `printSelectedInvoice` at Repeatable Read: the first print takes no part in SSI and the
  //     late one files a second copy. RED, and the concurrent case below reds with it.
  //   - the document read on `prisma` instead of `tx`: the late print reads the first print's
  //     committed document outside its snapshot and answers the already-printed 400. RED, and the
  //     hand-opened case above.
  //   - `"single"` for `"selected"` in `printSelectedInvoice`: the late print reads no document, so
  //     there is no cycle, and it files a second copy. RED.
  it("DANGEROUS-DIRECTION: a selected print that commits after another fixed its snapshot aborts the other, and one document is stored", async () => {
    const { invoice } = await finalizedFixture();
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
    measured("the late selected print's end", outcome instanceof Prisma.PrismaClientKnownRequestError
      ? { code: outcome.code, meta: outcome.meta } : String(outcome));
    expect(outcome).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((outcome as Prisma.PrismaClientKnownRequestError).code).toBe("P2034");
    expect(await prisma.storedDocument.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });

  // What the retry buys (`retryOnSerializationConflict` in `printSelectedInvoice`). A gate holds the
  // order row so that both prints fix their snapshots at the stub read and park on `claimOrder`
  // before either prints; the gate is Read Committed and only locks, so it forms no SSI edge with
  // either. The winner holds both claims to its commit; the loser wakes on its old snapshot, reads
  // no print, inserts, and SSI aborts it. Its retry's fresh snapshot sees the winner's document and
  // answers the owner's sentence. Measured 2026-10-20, each run once and restored: with the retry
  // removed the loser answers withDbErrors' 409 (RED); with `printSelectedInvoice` at Repeatable
  // Read both print and two documents are stored (RED). Both prints run on Prisma's five-second
  // interactive-transaction default, the parked wait included, so a slow runner can red here with
  // P2028 (the budget spent), which is not an SSI outcome.
  it("two selected prints of one invoice at once: one prints, the other answers the already-printed sentence, and one document is stored", async () => {
    const { invoice, order } = await finalizedFixture();
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
    expect(await prisma.storedDocument.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });

  // The plan's residual: after five aborted attempts a selected print answers the generic conflict
  // sentence beside its row, a 409, never a 500 the page would read as a lost answer. Every
  // transaction this print opens aborts here with P2034. Plain save/restore of the client's own
  // method, never `vi.spyOn` (CLAUDE.md), the tests/invoice-register.test.ts shape.
  it("answers the conflict sentence as a 409 after five aborted attempts", async () => {
    const { invoice } = await finalizedFixture();
    const client = prisma as unknown as { $transaction: (...args: unknown[]) => unknown };
    const real = client.$transaction;
    let opened = 0;
    client.$transaction = async () => {
      opened += 1;
      throw new Prisma.PrismaClientKnownRequestError("Transaction failed due to a write conflict or a deadlock", {
        code: "P2034", clientVersion: "x",
      });
    };
    let outcome: unknown;
    try {
      outcome = await asSystem(() => printSelectedInvoice(invoice.id)).then(() => "printed" as const, (e: unknown) => e);
    } finally {
      client.$transaction = real;
    }
    expect(outcome).toBeInstanceOf(HttpError);
    expect((outcome as HttpError).status).toBe(409);
    expect((outcome as HttpError).message).toBe(
      "Another change to that invoice was saved at the same time — please try again");
    expect(opened).toBe(5);
  });
});

// -------------------------------------------------------------------------------------------
// POST /api/invoices/[id]/print — gate invoicing.view (spec §9).
// -------------------------------------------------------------------------------------------

describe("POST /api/invoices/[id]/print", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("401s without a session", async () => {
    const { invoice } = await draftFixture();
    const res = await printRoute(postReq(`http://t/api/invoices/${invoice.id}/print`), withParams({ id: invoice.id }));
    expect(res.status).toBe(401);
  });

  it("requires invoicing.view", async () => {
    const { invoice } = await draftFixture();
    const cookie = await signInWith(["shipping.view"]);
    const res = await printRoute(postReq(`http://t/api/invoices/${invoice.id}/print`, cookie), withParams({ id: invoice.id }));
    expect(res.status).toBe(403);
  });

  it("streams the invoice PDF with a friendly filename and archives it", async () => {
    const { invoice, order } = await finalizedFixture();
    const cookie = await signInWith(["invoicing.view"]);
    const res = await printRoute(postReq(`http://t/api/invoices/${invoice.id}/print`, cookie), withParams({ id: invoice.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="Invoice-${order.orderNumber}.pdf"`);
    const documentId = res.headers.get("x-document-id")!;
    const stored = await getDocument(documentId);
    expect(stored.kind).toBe("INVOICE");
    expect(Buffer.compare(stored.fileData, Buffer.from(await res.arrayBuffer()))).toBe(0);
  });

  it("names a credit download by its credit number", async () => {
    const { invoice } = await finalizedFixture();
    const credit = await asSystem(() => createCredit(invoice.id));
    const cookie = await signInWith(["invoicing.view"]);
    const res = await printRoute(postReq(`http://t/api/invoices/${credit.id}/print`, cookie), withParams({ id: credit.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="Credit-${credit.creditNumber}.pdf"`);
  });
});

// -------------------------------------------------------------------------------------------
// POST /api/invoices/[id]/print?selected=1 — the selected mode (#591): invoicing view AND create
// (owner ruling 591-3), and the two refusals (owner, 2026-10-20: "Refuse both").
// -------------------------------------------------------------------------------------------

describe("POST /api/invoices/[id]/print?selected=1 (#591)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  const selectedUrl = (id: string) => `http://t/api/invoices/${id}/print?selected=1`;
  const printer = () => signInWith(["invoicing.view", "invoicing.create"], "selected-printer");

  it("prints a finalized invoice not printed since its finalize, answering as the single print does", async () => {
    const { invoice, order } = await finalizedFixture();
    const res = await printRoute(postReq(selectedUrl(invoice.id), await printer()), withParams({ id: invoice.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="Invoice-${order.orderNumber}.pdf"`);
    const stored = await getDocument(res.headers.get("x-document-id")!);
    expect(stored.kind).toBe("INVOICE");
    expect(stored.invoiceId).toBe(invoice.id);
    expect(Buffer.compare(stored.fileData, Buffer.from(await res.arrayBuffer()))).toBe(0);
  });

  it("prints a finalized credit memo not printed since its finalize, though its invoice printed since", async () => {
    const { invoice } = await finalizedFixture();
    const draft = await asSystem(() => createCredit(invoice.id));
    const credit = await asSystem(() => finalizeInvoice(draft.id));
    // The invoice's own print, after the credit's finalize: the check reads this credit's prints only.
    await asSystem(() => printInvoice(invoice.id));
    const res = await printRoute(postReq(selectedUrl(credit.id), await printer()), withParams({ id: credit.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="Credit-${credit.creditNumber}.pdf"`);
    const stored = await getDocument(res.headers.get("x-document-id")!);
    expect(stored.kind).toBe("CREDIT");
    expect(stored.invoiceId).toBe(credit.id);
  });

  it("refuses a draft invoice with the not-finalized sentence, its number carrying the prefix, and stores nothing", async () => {
    await asSystem(() => setSetting("invoice_number_prefix", "7"));
    const { invoice, order } = await draftFixture();
    const res = await printRoute(postReq(selectedUrl(invoice.id), await printer()), withParams({ id: invoice.id }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `Invoice 7 - ${order.orderNumber} is not finalized, so it was not printed.` });
    expect(await prisma.storedDocument.count()).toBe(0);
  });

  it("refuses a draft credit memo with the not-finalized sentence under its credit number", async () => {
    const { invoice } = await finalizedFixture();
    await asSystem(() => setSetting("credit_number_next", 5000)); // apart from the order number
    const credit = await asSystem(() => createCredit(invoice.id));
    const res = await printRoute(postReq(selectedUrl(credit.id), await printer()), withParams({ id: credit.id }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `Credit ${credit.creditNumber} is not finalized, so it was not printed.` });
    expect(await prisma.storedDocument.count()).toBe(0);
  });

  it("refuses an invoice printed since its finalize with the already-printed sentence, and stores nothing", async () => {
    const { invoice, order } = await finalizedFixture();
    await asSystem(() => printInvoice(invoice.id));
    const res = await printRoute(postReq(selectedUrl(invoice.id), await printer()), withParams({ id: invoice.id }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: alreadyPrinted(order.orderNumber) });
    expect(await prisma.storedDocument.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });

  it("judges by the newest of several prints: one made before the finalize and one after refuse", async () => {
    // A page read before the second print would offer this row's box; the check must read the print
    // after the finalize, not the draft's.
    const { invoice, order } = await draftFixture();
    await asSystem(() => printInvoice(invoice.id)); // the draft's print
    await new Promise((done) => setTimeout(done, 2)); // so the finalize's stamp is after it
    await asSystem(() => finalizeInvoice(invoice.id));
    await asSystem(() => printInvoice(invoice.id));
    const res = await printRoute(postReq(selectedUrl(invoice.id), await printer()), withParams({ id: invoice.id }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: alreadyPrinted(order.orderNumber) });
    expect(await prisma.storedDocument.count({ where: { invoiceId: invoice.id } })).toBe(2);
  });

  it("refuses a credit memo printed since its finalize with the already-printed sentence under its credit number", async () => {
    const { invoice } = await finalizedFixture();
    await asSystem(() => setSetting("credit_number_next", 5000)); // apart from the order number
    const draft = await asSystem(() => createCredit(invoice.id));
    const credit = await asSystem(() => finalizeInvoice(draft.id));
    await asSystem(() => printInvoice(credit.id));
    const res = await printRoute(postReq(selectedUrl(credit.id), await printer()), withParams({ id: credit.id }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: `Credit ${credit.creditNumber} has already printed since it was finalized, so it was not printed again.`,
    });
    expect(await prisma.storedDocument.count({ where: { invoiceId: credit.id } })).toBe(1);
  });

  it("prints an invoice whose only print was made before its finalize", async () => {
    const { invoice } = await draftFixture();
    await asSystem(() => printInvoice(invoice.id)); // the draft's print
    await asSystem(() => finalizeInvoice(invoice.id));
    const res = await printRoute(postReq(selectedUrl(invoice.id), await printer()), withParams({ id: invoice.id }));
    expect(res.status).toBe(200);
    expect(await prisma.storedDocument.count({ where: { invoiceId: invoice.id } })).toBe(2);
  });

  it("answers a discarded draft with the voided refusal first, as the single print does", async () => {
    const { invoice } = await draftFixture();
    await asSystem(() => discardInvoice(invoice.id, "raised in error"));
    const res = await printRoute(postReq(selectedUrl(invoice.id), await printer()), withParams({ id: invoice.id }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: VOIDED_PRINT });
  });

  it("needs invoicing.create beside view, while the single print still answers on view alone", async () => {
    const { invoice } = await finalizedFixture();
    const viewer = await signInWith(["invoicing.view"], "selected-viewer");
    const selected = await printRoute(postReq(selectedUrl(invoice.id), viewer), withParams({ id: invoice.id }));
    expect(selected.status).toBe(403);
    expect(await prisma.storedDocument.count()).toBe(0);
    const single = await printRoute(postReq(`http://t/api/invoices/${invoice.id}/print`, viewer), withParams({ id: invoice.id }));
    expect(single.status).toBe(200);
  });

  it("refuses invoicing.create without view", async () => {
    const { invoice } = await finalizedFixture();
    const creator = await signInWith(["invoicing.create"], "selected-creator");
    const res = await printRoute(postReq(selectedUrl(invoice.id), creator), withParams({ id: invoice.id }));
    expect(res.status).toBe(403);
    expect(await prisma.storedDocument.count()).toBe(0);
  });

  it("leaves the single print of a draft printing", async () => {
    const { invoice } = await draftFixture();
    const viewer = await signInWith(["invoicing.view"], "single-viewer");
    const res = await printRoute(postReq(`http://t/api/invoices/${invoice.id}/print`, viewer), withParams({ id: invoice.id }));
    expect(res.status).toBe(200);
    expect((await getDocument(res.headers.get("x-document-id")!)).kind).toBe("INVOICE");
  });

  it("takes only `selected=1` for the selected mode: `selected=0` is the single print, a draft on view alone", async () => {
    const { invoice } = await draftFixture();
    const viewer = await signInWith(["invoicing.view"], "zero-viewer");
    const res = await printRoute(postReq(`http://t/api/invoices/${invoice.id}/print?selected=0`, viewer), withParams({ id: invoice.id }));
    expect(res.status).toBe(200);
    expect(await prisma.storedDocument.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });
});

// -------------------------------------------------------------------------------------------
// GET /api/invoices/[id]/documents — the invoice page's own stored-documents list (Task 20; the
// route Task 19 owed but never built — see the route file's own comment). Gate invoicing.view,
// the certs/[id]/documents and shippers/[id]/documents precedent.
// -------------------------------------------------------------------------------------------

describe("GET /api/invoices/[id]/documents", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("401s without a session", async () => {
    const { invoice } = await draftFixture();
    const res = await invoiceDocumentsRoute(
      getReq(`http://t/api/invoices/${invoice.id}/documents`), withParams({ id: invoice.id }));
    expect(res.status).toBe(401);
  });

  it("requires invoicing.view, and lists only this invoice's own printed documents", async () => {
    const { invoice } = await finalizedFixture();
    const printed = await asSystem(() => printInvoice(invoice.id));

    const wrong = await signInWith(["shipping.view"], "invoice-docs-wrong-1");
    const forbidden = await invoiceDocumentsRoute(
      getReq(`http://t/api/invoices/${invoice.id}/documents`, wrong), withParams({ id: invoice.id }));
    expect(forbidden.status).toBe(403);

    const viewer = await signInWith(["invoicing.view"], "invoice-docs-view-1");
    const ok = await invoiceDocumentsRoute(
      getReq(`http://t/api/invoices/${invoice.id}/documents`, viewer), withParams({ id: invoice.id }));
    expect(ok.status).toBe(200);
    const docs = await ok.json() as { id: string; kind: string }[];
    expect(docs).toEqual([expect.objectContaining({ id: printed.documentId, kind: "INVOICE" })]);
  });
});

// -------------------------------------------------------------------------------------------
// #588: a FINALIZED print files a copy in the customer's Invoice folder, after the print commits.
// A real temp directory stands in for the office share, holding the marker and `Customers/Acme`;
// each test sets OFFICE_SHARE_DIR and OFFICE_SHARE_ROOT (the module reads them per call) and puts
// them back after, deleting them when they were unset (tests/helpers/setup.ts unsets both). The
// customer's folder is written straight to the row: the save's own check is
// tests/customer-invoice-folder.test.ts's, the copy's every outcome tests/customer-folders.test.ts's.
// -------------------------------------------------------------------------------------------

const SHARE_ROOT = "Z:\\";
const ACME_FOLDER = "Z:\\Customers\\Acme";

describe("the copy in the customer's folder (#588)", () => {
  let share: string;
  let acme: string;
  // A copy that did not land logs one line to console.error: caught, so the run stays quiet, and
  // read by the cases that say what is logged.
  let logSpy: MockInstance<typeof console.error>;
  const saved = { dir: process.env.OFFICE_SHARE_DIR, root: process.env.OFFICE_SHARE_ROOT };
  const putBack = (name: "OFFICE_SHARE_DIR" | "OFFICE_SHARE_ROOT", value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  beforeEach(async () => {
    await truncateAll();
    await seedOrderGatePrereqs();
    share = await mkdtemp(path.join(tmpdir(), "invoice-pdf-share-"));
    acme = path.join(share, "Customers", "Acme");
    await mkdir(acme, { recursive: true });
    await writeFile(path.join(share, CUSTOMER_FOLDERS_MARKER), "");
    process.env.OFFICE_SHARE_DIR = share;
    process.env.OFFICE_SHARE_ROOT = SHARE_ROOT;
    logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    logSpy.mockRestore();
    putBack("OFFICE_SHARE_DIR", saved.dir);
    putBack("OFFICE_SHARE_ROOT", saved.root);
    await rm(share, { recursive: true, force: true });
  });

  /** The customer's Invoice folder, written to the row (which skips the save's check). */
  const fileIn = (customerId: string, folder = ACME_FOLDER) =>
    prisma.customer.update({ where: { id: customerId }, data: { invoiceFolder: folder } });

  const printThroughRoute = (id: string, cookie: string) =>
    printRoute(postReq(`http://t/api/invoices/${id}/print`, cookie), withParams({ id }));

  /** What the customer's folder holds, by name: a temp file left behind is a dotfile among them. */
  const filedNames = async () => (await readdir(acme)).sort();

  /** The bytes of the stored document a print answered with. */
  const storedBytes = async (res: Response) => (await getDocument(res.headers.get("x-document-id")!)).fileData;

  /** The print's warning header is the one sentence, encoded as the shipping print encodes its own. */
  function expectWarning(res: Response, sentence: string) {
    const header = res.headers.get("x-print-warnings");
    expect(header).toBe(encodeURIComponent(JSON.stringify([sentence])));
    expect(JSON.parse(decodeURIComponent(header!))).toEqual([sentence]);
  }

  describe("through the print route", () => {
    it("a finalized invoice lands in the customer's folder as Invoice-<order#>.pdf: the stored bytes, no temp left, no warning", async () => {
      const { invoice, order, customer } = await finalizedFixture();
      await fileIn(customer.id);
      const res = await printThroughRoute(invoice.id, await signInWith(["invoicing.view"]));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-print-warnings")).toBeNull();
      const name = `Invoice-${order.orderNumber}.pdf`;
      expect(await filedNames()).toEqual([name]);
      expect(Buffer.compare(await readFile(path.join(acme, name)), await storedBytes(res))).toBe(0);
      expect(logSpy).not.toHaveBeenCalled();
    });

    it("a draft's print files nothing and carries no warning", async () => {
      const { invoice, customer } = await draftFixture();
      await fileIn(customer.id);
      const res = await printThroughRoute(invoice.id, await signInWith(["invoicing.view"]));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-document-id")).not.toBeNull();
      expect(res.headers.get("x-print-warnings")).toBeNull();
      expect(await filedNames()).toEqual([]);
      expect(logSpy).not.toHaveBeenCalled();
    });

    it("a finalized credit lands in its invoice's customer's folder as Credit-<credit#>.pdf", async () => {
      // Both counters start at 1000 on a fresh database: set apart, a credit filed under its
      // order's number shows.
      await asSystem(() => setSetting("credit_number_next", 7000));
      const { invoice, order, customer } = await finalizedFixture();
      const credit = await asSystem(() => createCredit(invoice.id));
      await asSystem(() => finalizeInvoice(credit.id));
      expect(credit.creditNumber).not.toBe(order.orderNumber);
      await fileIn(customer.id);
      const res = await printThroughRoute(credit.id, await signInWith(["invoicing.view"]));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-print-warnings")).toBeNull();
      const name = `Credit-${credit.creditNumber}.pdf`;
      expect(await filedNames()).toEqual([name]);
      expect(Buffer.compare(await readFile(path.join(acme, name)), await storedBytes(res))).toBe(0);
    });

    it("a second finalized print replaces the filed copy with its own bytes", async () => {
      const { invoice, order, customer } = await finalizedFixture();
      await fileIn(customer.id);
      const cookie = await signInWith(["invoicing.view"]);
      const name = `Invoice-${order.orderNumber}.pdf`;
      const first = await printThroughRoute(invoice.id, cookie);
      expect(Buffer.compare(await readFile(path.join(acme, name)), await storedBytes(first))).toBe(0);
      // Two renders of one invoice can be byte-identical, so the first copy is overwritten with
      // other bytes: only the second print's own copy can make the file its stored bytes again.
      await writeFile(path.join(acme, name), "an older copy");
      const second = await printThroughRoute(invoice.id, cookie);
      expect(second.headers.get("x-document-id")).not.toBe(first.headers.get("x-document-id"));
      expect(second.headers.get("x-print-warnings")).toBeNull();
      expect(await filedNames()).toEqual([name]);
      expect(Buffer.compare(await readFile(path.join(acme, name)), await storedBytes(second))).toBe(0);
    });

    it("after an unlock, the draft's print leaves the filed copy as it was", async () => {
      const { invoice, order, customer } = await finalizedFixture();
      await fileIn(customer.id);
      const cookie = await signInWith(["invoicing.view"]);
      const name = `Invoice-${order.orderNumber}.pdf`;
      const filed = await printThroughRoute(invoice.id, cookie);
      // A copy is renamed into place, so a new copy is a new file: the inode tells them apart even
      // when the two prints' bytes are the same.
      const before = await stat(path.join(acme, name));
      await asSystem(() => unlockInvoice(invoice.id, "wrong PO"));
      const draft = await printThroughRoute(invoice.id, cookie);
      expect(draft.status).toBe(200);
      expect(draft.headers.get("x-print-warnings")).toBeNull();
      expect(await filedNames()).toEqual([name]);
      expect((await stat(path.join(acme, name))).ino).toBe(before.ino);
      expect(Buffer.compare(await readFile(path.join(acme, name)), await storedBytes(filed))).toBe(0);
    });

    it("a customer with no Invoice folder: 200, the no-folder line, nothing written", async () => {
      const { invoice, customer } = await finalizedFixture();
      await fileIn(customer.id, "");
      const res = await printThroughRoute(invoice.id, await signInWith(["invoicing.view"]));
      expect(res.status).toBe(200);
      expectWarning(res, PRINT_NO_FOLDER);
      expect(await filedNames()).toEqual([]);
      expect(logSpy).not.toHaveBeenCalled();
    });

    it("a share whose marker is missing: 200, the print archived, the not-connected line, nothing written", async () => {
      const { invoice, order, customer } = await finalizedFixture();
      await fileIn(customer.id);
      await rm(path.join(share, CUSTOMER_FOLDERS_MARKER));
      const res = await printThroughRoute(invoice.id, await signInWith(["invoicing.view"]));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-document-id")).not.toBeNull();
      expect(Buffer.compare(await storedBytes(res), Buffer.from(await res.arrayBuffer()))).toBe(0);
      expectWarning(res, PRINT_NOT_CONNECTED);
      expect(await filedNames()).toEqual([]);
      expect(logSpy.mock.calls).toEqual([[`[customer-folders] Invoice-${order.orderNumber}.pdf not filed: the marker file: ENOENT`]]);
    });

    it("an install with no share set up: no warning and no log line", async () => {
      const { invoice, customer } = await finalizedFixture();
      await fileIn(customer.id);
      delete process.env.OFFICE_SHARE_DIR;
      delete process.env.OFFICE_SHARE_ROOT;
      const res = await printThroughRoute(invoice.id, await signInWith(["invoicing.view"]));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-print-warnings")).toBeNull();
      expect(logSpy).not.toHaveBeenCalled();
      // No listing of the temp share: with both values unset the module is never handed its path,
      // so a listing could only show it untouched. That no fs call is made is
      // tests/customer-folders.test.ts's.
    });
  });

  describe("printInvoice's filing", () => {
    it("is null for a draft and the claimed row's kind, number and own customer's folder once finalized, on one path", async () => {
      await asSystem(() => setSetting("credit_number_next", 7000));
      const { invoice, order, customer } = await draftFixture();
      await fileIn(customer.id);
      // The customer has a parent with a folder of its own, so the fixture is not inert: a change
      // that filed under the parent's folder would fail the ACME_FOLDER assertion. It shows the
      // rule, an invoice and its credit file under the invoice's own customer.
      const parent = await prisma.customer.create({ data: { code: "IPDPARENT", name: "Parent Group", invoiceFolder: "Z:\\Customers\\Parent" } });
      await prisma.customer.update({ where: { id: customer.id }, data: { parentId: parent.id } });

      expect((await asSystem(() => printInvoice(invoice.id))).filing).toBeNull();
      await asSystem(() => finalizeInvoice(invoice.id));
      expect((await asSystem(() => printInvoice(invoice.id))).filing).toEqual({
        kind: "INVOICE", number: order.orderNumber, folder: ACME_FOLDER, ticket: expect.any(Number),
      });

      const credit = await asSystem(() => createCredit(invoice.id));
      expect(credit.creditNumber).not.toBe(order.orderNumber);
      expect((await asSystem(() => printInvoice(credit.id))).filing).toBeNull();
      await asSystem(() => finalizeInvoice(credit.id));
      expect((await asSystem(() => printInvoice(credit.id))).filing).toEqual({
        kind: "CREDIT", number: credit.creditNumber, folder: ACME_FOLDER, ticket: expect.any(Number),
      });
    });

    // Print order (the plan's "Print order"): every print that can share a file claims one Order
    // row, so a ticket taken under that claim is taken in commit order. The holder claims the Order
    // row, a second print starts and blocks on it, and only then does the holder print and commit.
    // Taken before the claim, the second's ticket would come first, though its print commits second.
    it("a print that blocked on the claim takes the higher ticket", async () => {
      const { invoice, order } = await finalizedFixture();

      let hasClaimed!: () => void;
      const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
      let mayPrint!: () => void;
      const printNow = new Promise<void>((resolve) => { mayPrint = resolve; });

      const holder = asSystem(() => prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
        hasClaimed();
        await printNow;
        return printInvoice(invoice.id, tx);
      }, { timeout: 20000 }));

      await claimed;
      // The public path, which takes no transaction options, so its transaction has Prisma's default
      // 5-second budget from its start here to its commit after the holder's. Measured at 181-193 ms
      // over six runs on the development laptop (the poll's first look at about 53 ms, then both
      // renders), so 5 seconds holds with a margin of more than twentyfold.
      const blocked = asSystem(() => printInvoice(invoice.id));
      // Polled until the second print's claim waits on the holder's lock (the order-link-locks
      // shape), never a fixed sleep.
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const rows = await prisma.$queryRaw<{ query: string }[]>`
          SELECT query FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        waiting = rows.some((r) => r.query.includes(`FROM "Order"`) && r.query.includes("FOR UPDATE"));
      }
      expect(waiting).toBe(true);

      mayPrint();
      const first = await holder;
      const second = await blocked;
      expect(first.filing).not.toBeNull();
      expect(second.filing).not.toBeNull();
      expect(second.filing!.ticket).toBeGreaterThan(first.filing!.ticket);
    });

    it("takes its ticket in printInvoiceInTx once, after the claim (parsed: a comment cannot satisfy it)", () => {
      const file = fileURLToPath(new URL("../src/server/invoices.ts", import.meta.url));
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const fn = all(source, ts.isFunctionDeclaration).find((f) => f.name?.text === "printInvoiceInTx");
      expect(fn).toBeDefined();
      const starts = (name: string) => all(fn!, ts.isCallExpression)
        .filter((call) => call.expression.getText(source) === name).map((call) => call.getStart(source));
      const tickets = starts("nextFilingTicket");
      const claims = starts("claimInvoiceForPrint");
      expect(tickets).toHaveLength(1);
      expect(claims).toHaveLength(1);
      expect(tickets[0]).toBeGreaterThan(claims[0]);
    });
  });
});
