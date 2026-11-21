import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, templateVersionId, seedOrderGatePrereqs } from "./helpers/db";
import { validateContractConfig } from "@/lib/template-contracts/types";
import { drawnPages, drawnText, pageCount, paintedImageCounts } from "./helpers/pdf";
import { runWithContext } from "@/server/context";
import { createOrder, getOrder, type OrderDetail } from "@/server/orders";
import { createShipper } from "@/server/shippers";
import { addPartPrice } from "@/server/part-prices";
import { setSetting } from "@/server/settings";
import {
  createInvoice, finalizeInvoice, createCredit, replaceInvoiceLines, printInvoice,
} from "@/server/invoices";
import { buildInvoiceDefinition, type InvoicePdfData } from "@/server/pdf/invoice";
import { renderPdf, barcodePng, layOutSheetGroups, type RenderableDefinition } from "@/server/pdf/render";
import { mark } from "@/server/pdf/canvas-nodes";
import { getDocument } from "@/server/documents";
import { createTemplate, editDraft, publishDraft, uploadLogo } from "@/server/templates";
import { assignTemplate } from "@/server/template-assignments";
import {
  FONT_FAMILIES, INVOICE_DEFAULT_CONFIG, normalizeStoredConfig, validateConfig, type FontFamily, type TemplateConfig,
} from "@/lib/template-contracts/index";
import { INVOICE_CONTRACT, INVOICE_FIRST_TABLE_ROOM, INVOICE_ROW_FLOOR } from "@/lib/template-contracts/invoice";
import { measured } from "./helpers/measured";
import type { Content } from "pdfmake/interfaces";
import { cellTexts, tableHeaded } from "./helpers/definition-text";
import { seedLiteral, storedBefore } from "./helpers/stored-configs";
import type { Customer, Part } from "../prisma/generated/prisma/client";
import { sampleInvoice, standardInvoiceLayout } from "./helpers/invoice-canvas-fixtures";

/**
 * Phase 7 Task 12 — the invoice/credit conversion. `buildInvoiceDefinition` becomes a
 * config-consumer over FROZEN snapshot data (spec §5.4/§5.6) — the OPPOSITE snapshot rule from the
 * cert/shipper: `InvoicePdfData` is built exclusively from the invoice row's frozen columns, and the
 * config controls placement/labels/widths/fonts/formats/logo over that frozen data. It introduces NO
 * live re-join. This file also covers the `processName` create-time snapshot source (§5.7, ruling 4)
 * and issue #98 (the `sourceQuoteNumber`-requires-QUOTE refine). Task 12 left the golden 5A suites
 * (invoice-pdf/invoices/invoice-routes/invoice-guards) untouched, and its tests live here. Later
 * owner rulings added cases to invoice-pdf.test.ts: W15's (a printed page's weights carry their
 * unit), #590's (the order strip on one line, held here as a definition and there on the rendered
 * page) and #589's (a rule after each part's prices, held the same two ways).
 */

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

// ------------------------------------------------------------------------------------------------
// Real-data fixtures — copied in shape from tests/invoice-pdf.test.ts (copying across test files is
// this repo's convention).
// ------------------------------------------------------------------------------------------------

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({ data: { code: `ITP${customerSeq}`, name: `Invoice Template Customer ${customerSeq}` } });
}

let partSeq = 0;
async function makePart(customerId: string, processName = ""): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({
    data: { customerId, partNumber: `P-${partSeq}`, name: "EQUALIZER-RR SUSP", eachWeight: "21.0000", processName },
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

async function savedOrder(processName = ""): Promise<{ order: OrderDetail; part: Part; customer: Customer }> {
  const customer = await makeCustomer();
  await makeBillTo(customer.id);
  const part = await makePart(customer.id, processName);
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
async function pricedShippedOrder(processName = "") {
  const { order, part, customer } = await savedOrder(processName);
  const { shipper } = await createShipper(oneOrderInput(order), { canOverrideCreditHold: false });
  const gl = await prisma.glAccount.create({ data: { name: `4010-${partSeq}`, description: "Sales" } });
  const code = await prisma.processStepCode.create({ data: { code: `AUST-${partSeq}`, name: "Austemper", glAccountId: gl.id } });
  await asSystem(() => addPartPrice(part.id, {
    processStepCodeId: code.id, position: 1, unitPrice: "6.5100", minimumCharge: "600.00", pricePer: "EACH",
  }));
  return { order: await getOrder(order.id), part, customer, shipper, stepCode: code, glAccount: gl };
}

async function draftFixture(processName = "") {
  const fixture = await pricedShippedOrder(processName);
  const { invoice } = await asSystem(() => createInvoice({ orderId: fixture.order.id }));
  return { ...fixture, invoice };
}

async function finalizedFixture(processName = "") {
  const d = await draftFixture(processName);
  const invoice = await asSystem(() => finalizeInvoice(d.invoice.id));
  return { ...d, invoice };
}

// ================================================================================================
// Issue #98 — LINE_INPUT gains a refine: sourceQuoteNumber only alongside priceSource === "QUOTE".
// The manual invoice-lines save (replaceInvoiceLines) is the trust surface; the refine is shape-
// tightening (permission-gated, audited), NOT authenticity verification against live quotes — a
// frozen-paper deliberate non-goal. The echo-back for genuine QUOTE lines must keep working.
// ================================================================================================

describe("replaceInvoiceLines — #98: sourceQuoteNumber requires priceSource QUOTE", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("refuses a MANUAL line that carries a sourceQuoteNumber", async () => {
    const { invoice } = await draftFixture();
    await expect(asSystem(() => replaceInvoiceLines(invoice.id, [
      { kind: "CHARGE", description: "Hand-typed", amount: "25.00", priceSource: "MANUAL", sourceQuoteNumber: 999 },
    ]))).rejects.toMatchObject({ name: "ZodError" });
  });

  it("refuses a null-priceSource line that carries a sourceQuoteNumber", async () => {
    const { invoice } = await draftFixture();
    await expect(asSystem(() => replaceInvoiceLines(invoice.id, [
      { kind: "CHARGE", description: "No source", amount: "10.00", sourceQuoteNumber: 42 },
    ]))).rejects.toMatchObject({ name: "ZodError" });
  });

  it("allows a QUOTE line to carry its sourceQuoteNumber (the echo-back survives)", async () => {
    const { invoice } = await draftFixture();
    const edited = await asSystem(() => replaceInvoiceLines(invoice.id, [
      { kind: "OPERATION", description: "Austemper", amount: "937.44", priceSource: "QUOTE", sourceQuoteNumber: 1006 },
    ]));
    const op = edited.lines.find((l) => l.kind === "OPERATION")!;
    expect(op.priceSource).toBe("QUOTE");
    expect(op.sourceQuoteNumber).toBe(1006);
  });

  it("allows a MANUAL line with no sourceQuoteNumber (the ordinary manual charge)", async () => {
    const { invoice } = await draftFixture();
    const edited = await asSystem(() => replaceInvoiceLines(invoice.id, [
      { kind: "CHARGE", description: "Hand-typed", amount: "25.00", priceSource: "MANUAL" },
    ]));
    expect(edited.lines.some((l) => l.description === "Hand-typed")).toBe(true);
  });
});

// ================================================================================================
// processName snapshot source (spec §5.7, ruling 4 — CREATE-TIME): the invoice's `processNames`
// snapshot is `part.processName` when non-blank, else the priced-operation comma-join. Prints read
// the snapshot UNCONDITIONALLY, so a processName edit after finalize provably changes nothing on
// raised paper (the load-bearing frozen-paper proof). Pre-existing invoices are untouched.
// ================================================================================================

describe("invoice processNames — create-time source (spec §5.7)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("snapshots part.processName when it is non-blank", async () => {
    const { invoice } = await draftFixture("MARQUENCHZONE");
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { processNames: true } });
    expect(row.processNames).toBe("MARQUENCHZONE");
  });

  it("falls back to the priced-operation comma-join when part.processName is blank", async () => {
    const { invoice } = await draftFixture(""); // blank
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { processNames: true } });
    expect(row.processNames).toBe("Austemper"); // the lead line's priced operation name
  });

  it("a processName edit after finalize changes NOTHING on raised paper (the frozen-paper proof)", async () => {
    const { invoice, part } = await finalizedFixture("MARQUENCHZONE");
    await asSystem(() => setSetting("company_name", "Example Heat Treating - Alabama, LLC"));
    await asSystem(() => setSetting("company_address", "100 Example Way\nAnniston AL 36207"));

    // Print once: the paper carries the frozen snapshot value.
    const first = await asSystem(() => printInvoice(invoice.id));
    expect(drawnText(first.pdf)).toContain("MARQUENCHZONE");

    // Edit the live part's processName to a DISTINCT marker AFTER the invoice was raised.
    await prisma.part.update({ where: { id: part.id }, data: { processName: "EDITEDAFTERWARD" } });

    // The frozen column is unchanged...
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { processNames: true } });
    expect(row.processNames).toBe("MARQUENCHZONE");

    // ...a fresh render still prints the frozen value, never the live edit (no re-join)...
    const reprint = await asSystem(() => printInvoice(invoice.id));
    const text = drawnText(reprint.pdf);
    expect(text).toContain("MARQUENCHZONE");
    expect(text).not.toContain("EDITEDAFTERWARD");

    // ...and the STORED bytes of the first print decode to the frozen value too.
    const stored = await getDocument(first.documentId);
    expect(drawnText(stored.fileData)).toContain("MARQUENCHZONE");
  });

  it("a credit copies the source invoice's frozen processNames snapshot (unchanged today)", async () => {
    const { invoice } = await finalizedFixture("MARQUENCHZONE");
    const credit = await asSystem(() => createCredit(invoice.id));
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: credit.id }, select: { processNames: true } });
    expect(row.processNames).toBe("MARQUENCHZONE");
  });
});

// ================================================================================================
// The builder as a CONFIG-CONSUMER over FROZEN data (spec §5.4/§5.6). Pure, plain-JSON fixtures —
// the golden suite's sampleData, kept value-distinctive. The config maps placement/labels/widths/
// fonts/formats/logo over the frozen data; it introduces NO live re-join.
// ================================================================================================

/** The owner's own invoice as plain builder input (order 92026) — billTo/shipTo/remitTo are line
 *  arrays (an invoice's billTo/shipTo are FROZEN snapshot strings, split here into lines). */
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

/** A credit-shaped fixture — negative amounts, the credit number as the bare document number. */
function creditData(overrides: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return sampleData({
    title: "Credit", documentNumber: "1000",
    priceRows: [{ description: "Austemper", pricePerLabel: "Each", unitPrice: 6.51, minimumCharge: 600, setupCharge: null, amount: -937.44, partIndex: 0 }],
    subtotal: -937.44, surchargeRows: [{ description: "EnergySur", amount: -37.5 }], total: -974.94,
    ...overrides,
  });
}

const cfg = (): TemplateConfig => structuredClone(INVOICE_DEFAULT_CONFIG);
/** Round-trips a tweaked config through the REAL validator — every config a test feeds the builder
 *  (the raw omission-belt shapes excepted, deliberately) is one a template could store. */
const checked = (c: TemplateConfig): TemplateConfig => validateConfig("INVOICE", c);
const sectionOf = (c: TemplateConfig, key: string) => c.sections.find((s) => s.key === key)!;
const fieldOf = (c: TemplateConfig, section: string, key: string) =>
  sectionOf(c, section).fields.find((f) => f.key === key)!;

/** Every `text` string/number in a definition, flattened (skips `image` so a data-URI never
 *  pollutes a text assertion). */
function allText(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) allText(n, out); return out; }
  if (typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "image") continue;
      allText(value, out);
    }
  }
  return out;
}
const textOf = (def: unknown): string => allText(def).join("\n");

/** Every node in a definition matching `pred` — structural assertions (font sizes, widths). */
function findNodes(node: unknown, pred: (n: Record<string, unknown>) => boolean,
  out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const n of node) findNodes(n, pred, out); return out; }
  const obj = node as Record<string, unknown>;
  if (pred(obj)) out.push(obj);
  for (const value of Object.values(obj)) findNodes(value, pred, out);
  return out;
}

/** Every table's `widths` array in the definition. */
function allWidths(def: unknown): (number | string)[][] {
  return findNodes(def, (n) => typeof n.table === "object" && n.table !== null)
    .map((n) => (n.table as { widths?: (number | string)[] }).widths)
    .filter((w): w is (number | string)[] => Array.isArray(w));
}

describe("buildInvoiceDefinition — config-driven over frozen data", () => {
  it("a label override prints in place of the contract default", () => {
    const c = cfg();
    fieldOf(c, "identity", "invoice_no").label = "INV NO:";
    fieldOf(c, "order_strip", "material").label = "Alloy:";
    fieldOf(c, "totals", "total").label = "Balance Due:";
    const text = textOf(buildInvoiceDefinition(sampleData(), checked(c)));
    expect(text).toContain("INV NO:");
    expect(text).not.toContain("Invoice No.:");
    expect(text).toContain("Alloy: ");
    expect(text).toContain("Balance Due:");
    expect(text).not.toContain("Total Amount Due:");
    // The FROZEN values are untouched by the relabel — the config maps over frozen data.
    expect(text).toContain("7 - 92026");
    expect(text).toContain("$974.94");
  });

  it("a width override lands in the column-header strip's widths array", () => {
    const c = cfg();
    fieldOf(c, "column_header", "col_each_weight").width = 90;
    const def = buildInvoiceDefinition(sampleData(), checked(c));
    expect(allWidths(def)).toContainEqual([52, "*", 90, 84]);
    // …the default keeps the sample's [52, "*", 66, 84].
    expect(allWidths(buildInvoiceDefinition(sampleData()))).toContainEqual([52, "*", 66, 84]);
  });

  it("a hidden section is omitted from the stack; the default still prints it", () => {
    const c = cfg();
    sectionOf(c, "totals").visible = false;
    const text = textOf(buildInvoiceDefinition(sampleData(), checked(c)));
    expect(text).not.toContain("Sub Total Amount:");
    expect(text).not.toContain("Total Amount Due:");
    expect(textOf(buildInvoiceDefinition(sampleData()))).toContain("Sub Total Amount:");
  });

  it("a hidden column field drops the strip header AND the parts cell; width frees the budget", () => {
    const c = cfg();
    fieldOf(c, "column_header", "col_each_weight").visible = false;
    const def = buildInvoiceDefinition(sampleData(), checked(c));
    expect(textOf(def)).not.toContain("Each weight");
    expect(allWidths(def)).toContainEqual([52, "*", 84]); // the each-weight column is gone from the grid
  });

  it("a hidden non-column field drops its slice of the order strip", () => {
    const c = cfg();
    fieldOf(c, "order_strip", "your_po").visible = false;
    const def = buildInvoiceDefinition(sampleData(), checked(c));
    const text = textOf(def);
    expect(text).not.toContain("Your PO #:");
    expect(text).not.toContain("89499");
    expect(text).toContain("Our Order #:"); // its sibling on the same line survives
    // The strip's row holds the three fields left (#590).
    expect(findNodes(def, (n) => n.id === "invoice-order-strip").map((n) => (n.columns as unknown[]).length)).toEqual([3]);
  });

  it("stack order follows the config's section order", () => {
    const c = cfg();
    const i = c.sections.findIndex((s) => s.key === "parties");
    const j = c.sections.findIndex((s) => s.key === "identity");
    [c.sections[i], c.sections[j]] = [c.sections[j], c.sections[i]];
    const text = textOf(buildInvoiceDefinition(sampleData(), checked(c)));
    expect(text.indexOf("Billto:")).toBeLessThan(text.indexOf("Remit To"));
    // …the default order is the other way around.
    const dflt = textOf(buildInvoiceDefinition(sampleData()));
    expect(dflt.indexOf("Remit To")).toBeLessThan(dflt.indexOf("Billto:"));
  });

  it("field order follows the config WITHIN the identity block", () => {
    const c = cfg();
    const identity = sectionOf(c, "identity");
    const terms = identity.fields.find((f) => f.key === "terms")!;
    identity.fields = [terms, ...identity.fields.filter((f) => f.key !== "terms")];
    const text = textOf(buildInvoiceDefinition(sampleData(), checked(c)));
    expect(text.indexOf("Terms:")).toBeLessThan(text.indexOf("Invoice No.:"));
  });
});

describe("buildInvoiceDefinition: the order strip prints on one line (owner ruling of 2026-10-20, #590)", () => {
  // The strip is a row of columns under its id, which render.ts measures to fit it to one line,
  // then the PARTS heading as the next top-level node. Its fields print in a fixed order, whatever
  // order a template keeps them in. Each is an "auto" column, none the star: render.ts holds a long
  // field to its equal share, so Process takes what the others leave whenever it is the long one.
  const ID = "invoice-order-strip";
  type Row = { id: string; columns: Record<string, unknown>[]; columnGap: number; margin: number[] };
  const content = (def: unknown) => (def as { content: Record<string, unknown>[] }).content;
  /** The strip's row, found among the definition's top-level nodes, and the node after it. */
  const strip = (def: unknown) => {
    const nodes = content(def);
    const at = nodes.findIndex((n) => n.id === ID);
    return { row: at < 0 ? undefined : (nodes[at] as Row), next: at < 0 ? undefined : nodes[at + 1] };
  };
  const pair = (label: string, value: string) =>
    ({ width: "auto", text: [{ text: `${label} `, bold: true }, value], fontSize: 9 });
  const PAIRS = [
    pair("Our Order #:", "92026"), pair("Your PO #:", "89499"), pair("Material:", "Ductile Iron"), pair("Process:", "Austemper"),
  ];
  const HEADING = { text: "PARTS", bold: true, decoration: "underline", fontSize: 9 };
  const hide = (c: TemplateConfig, keys: string[]) => {
    for (const key of keys) fieldOf(c, "order_strip", key).visible = false;
    return checked(c);
  };

  it("prints one row of the four fields at the top level, 12 points apart and indented past Quantity, then the PARTS heading", () => {
    const def = buildInvoiceDefinition(sampleData());
    expect(findNodes(def, (n) => n.id === ID)).toHaveLength(1);
    const { row, next } = strip(def);
    expect(row).toEqual({ id: ID, columns: PAIRS, columnGap: 12, margin: [58, 0, 0, 0] });
    expect(row!.columns.map((column) => column.width)).toEqual(["auto", "auto", "auto", "auto"]);
    expect(next).toEqual({ ...HEADING, margin: [58, 4, 0, 2] });
  });

  it("prints the fields in their fixed order whatever order the config keeps them in", () => {
    const c = cfg();
    const section = sectionOf(c, "order_strip");
    const field = (key: string) => section.fields.find((f) => f.key === key)!;
    section.fields = ["process", "material", "parts_heading", "your_po", "our_order_no"].map(field);
    const validated = checked(c);
    // The validator keeps the order the config gives, so the builder is handed it.
    expect(sectionOf(validated, "order_strip").fields.map((f) => f.key)).toEqual(section.fields.map((f) => f.key));
    expect(strip(buildInvoiceDefinition(sampleData(), validated))).toEqual(strip(buildInvoiceDefinition(sampleData())));
    expect(strip(buildInvoiceDefinition(sampleData())).row!.columns).toEqual(PAIRS);
  });

  it("a hidden Process leaves the other three columns, in their order", () => {
    expect(strip(buildInvoiceDefinition(sampleData(), hide(cfg(), ["process"]))).row!.columns).toEqual(PAIRS.slice(0, 3));
  });

  it("with the four fields hidden and the heading shown, prints the heading alone where the strip was", () => {
    const dflt = content(buildInvoiceDefinition(sampleData()));
    const def = buildInvoiceDefinition(sampleData(), hide(cfg(), ["our_order_no", "your_po", "material", "process"]));
    expect(findNodes(def, (n) => n.id === ID)).toEqual([]);
    expect(content(def)).toEqual(dflt.filter((n) => n.id !== ID));
  });

  it("with all five fields hidden, prints nothing for the section", () => {
    const c = cfg();
    sectionOf(c, "order_strip").visible = false;
    const sectionHidden = content(buildInvoiceDefinition(sampleData(), checked(c)));
    const def = buildInvoiceDefinition(sampleData(), hide(cfg(), ["our_order_no", "your_po", "material", "process", "parts_heading"]));
    expect(content(def)).toEqual(sectionHidden);
    expect(sectionHidden).toHaveLength(content(buildInvoiceDefinition(sampleData())).length - 2);
  });

  it("a blank value keeps its label", () => {
    expect(strip(buildInvoiceDefinition(sampleData({ poNumber: "" }))).row!.columns[1])
      .toEqual({ width: "auto", text: [{ text: "Your PO #: ", bold: true }, ""], fontSize: 9 });
  });

  // The owner's amendment of 2026-10-21: a line break inside a strip value or a typed strip label
  // prints as one space. A line break is any of the characters the shipping ticket's Sold To rule
  // names (src/lib/line-break.ts), and a CR LF pair is one. invoice-pdf.test.ts holds the printed space.
  const BREAKS: [name: string, chars: string][] = [
    ["a line feed", "\n"], ["a carriage return", "\r"], ["a CR LF pair", "\r\n"], ["the line separator U+2028", "\u2028"],
    ["the paragraph separator U+2029", "\u2029"], ["a form feed", "\u000C"], ["a vertical tab", "\u000B"],
    ["a next-line U+0085", "\u0085"],
  ];
  it.each(BREAKS)("prints %s in each of the four values and in each typed label as one space", (_name, br) => {
    const c = cfg();
    const typed = ["Our Order", "Your PO", "Material", "Process"];
    ["our_order_no", "your_po", "material", "process"].forEach((key, i) => {
      fieldOf(c, "order_strip", key).label = `${typed[i]}${br}#:`;
    });
    const def = buildInvoiceDefinition(sampleData({
      poNumber: `89499${br}REL2`, materialName: `Ductile${br}Iron`, processNames: `Neutral harden,${br}Temper`,
    }), checked(c));
    expect(strip(def).row!.columns.map((column) => column.text)).toEqual([
      [{ text: "Our Order #: ", bold: true }, "92026"], [{ text: "Your PO #: ", bold: true }, "89499 REL2"],
      [{ text: "Material #: ", bold: true }, "Ductile Iron"], [{ text: "Process #: ", bold: true }, "Neutral harden, Temper"],
    ]);
  });

  it("prints two line breaks in a row as two spaces, and leaves a tab as it is", () => {
    expect(strip(buildInvoiceDefinition(sampleData({ poNumber: "89499\n\nREL2", materialName: "Ductile\tIron" }))).row!
      .columns.map((column) => (column.text as unknown[])[1])).toEqual(["92026", "89499  REL2", "Ductile\tIron", "Austemper"]);
  });

  it("a width override on the Quantity column moves the row's and the heading's indent with it", () => {
    const c = cfg();
    fieldOf(c, "column_header", "col_qty").width = 70;
    const { row, next } = strip(buildInvoiceDefinition(sampleData(), checked(c)));
    expect(row!.margin).toEqual([76, 0, 0, 0]);
    expect(next).toEqual({ ...HEADING, margin: [76, 4, 0, 2] });
  });
});

describe("buildInvoiceDefinition: each part's prices, then a rule (owner ruling of 2026-10-20, #589)", () => {
  // The prices print grouped by the part each one's saved tie names (`partIndex`), in the PARTS
  // list's order, then the prices that lost their part as a last group. A rule follows each group
  // that printed something: a top-level canvas line across the content width, 564 points (LETTER's
  // 612 less the 24-point side margins), never the grid's columns. Its thickness and spacing are
  // as the owner ruled at the paper look of 2026-10-21. invoice-pdf.test.ts holds the rules on the
  // printed page.
  const RULE = { canvas: [{ type: "line", x1: 0, y1: 0, x2: 564, y2: 0, lineWidth: 0.5 }], margin: [0, 4, 0, 1] };
  const part = (partNumber: string) =>
    ({ qty: 10, partNumber, partName: "EQUALIZER-RR SUSP", partDescription: "", eachWeight: 1, totalWeight: 10 });
  const PARTS = ["DEMO-9001-000", "DEMO-9002-000", "DEMO-9003-000", "DEMO-9004-000"].map(part);
  /** An operation priced at `unitPrice` each, which prints one detail line beneath it, or none when
   *  it is null (as a needs-price row's). */
  const op = (description: string, partIndex: number | null, unitPrice: number | null) =>
    ({ description, pricePerLabel: "Each", unitPrice, minimumCharge: null, setupCharge: null, amount: 10, partIndex });
  const data = (parts: number, priceRows: InvoicePdfData["priceRows"]) =>
    sampleData({ parts: PARTS.slice(0, parts), priceRows, surchargeRows: [] });
  /** Rows given as [part 1, part 0, a price that lost its part, part 1]. */
  const MIXED = [op("Temper", 1, 2), op("Carburize", 0, 1), op("Normalize", null, 4), op("Anneal", 1, 3)];

  const content = (def: unknown) => (def as { content: Record<string, unknown>[] }).content;
  const isRule = (n: Record<string, unknown>) => "canvas" in n;
  /** The top-level nodes from the PRICE heading on, each named by what it prints: a text node by its
   *  text, a row of columns by its first non-blank cell (an operation by its name, a totals line by
   *  its label), a rule as "RULE". */
  const shape = (def: unknown): string[] => {
    const nodes = content(def);
    const start = nodes.findIndex((n) => n.text === "PRICE");
    expect(start, "the PRICE heading is a top-level node").toBeGreaterThanOrEqual(0);
    return nodes.slice(start).map((n) => {
      if (isRule(n)) return "RULE";
      if (typeof n.text === "string") return n.text;
      const cells = (n.columns as { text?: unknown }[]).map((c) => c.text);
      return cells.find((t): t is string => typeof t === "string" && t !== "")!;
    });
  };
  /** Never two rules together, anywhere among the top-level nodes. */
  const noTwoRulesTogether = (def: unknown) => {
    const nodes = content(def);
    expect(nodes.filter((n, i) => i > 0 && isRule(n) && isRule(nodes[i - 1])), "two rules together").toEqual([]);
  };
  const detail = (price: number) => `Price per Each:  $${price}.00`;
  const TOTALS = ["Sub Total Amount:", "Total Amount Due:"];

  it("prints part 0's prices, then part 1's in their own order, then the one that lost its part, a rule after each group", () => {
    const def = buildInvoiceDefinition(data(2, MIXED));
    expect(shape(def)).toEqual([
      "PRICE",
      "Carburize", detail(1), "RULE",
      "Temper", detail(2), "Anneal", detail(3), "RULE",
      "Normalize", detail(4), "RULE",
      ...TOTALS,
    ]);
    expect(content(def).filter(isRule)).toHaveLength(3);
  });

  it("a part with no prices adds no group and no rule", () => {
    const def = buildInvoiceDefinition(data(4, [op("Temper", 3, 2), op("Carburize", 1, 1)]));
    expect(shape(def)).toEqual(["PRICE", "Carburize", detail(1), "RULE", "Temper", detail(2), "RULE", ...TOTALS]);
    noTwoRulesTogether(def);
  });

  it("a part index out of range or not a whole number joins the last group, in the rows' own order", () => {
    const def = buildInvoiceDefinition(data(2, [
      op("Five", 5, 5), op("Carburize", 0, 1), op("Minus", -1, 6), op("Two", 2, 7), op("Half", 0.5, 8), op("Normalize", null, 4),
    ]));
    expect(shape(def)).toEqual([
      "PRICE",
      "Carburize", detail(1), "RULE",
      "Five", detail(5), "Minus", detail(6), "Two", detail(7), "Half", detail(8), "Normalize", detail(4), "RULE",
      ...TOTALS,
    ]);
  });

  // A draft save that drops every PART row leaves every price without its part. Mutation-proven:
  // printing the rows with no rule when there is no part reds it.
  it("no part at all: the prices print as the one last group, then a rule", () => {
    const def = buildInvoiceDefinition(data(0, [op("Typed", null, 1)]));
    expect(shape(def)).toEqual(["PRICE", "Typed", detail(1), "RULE", ...TOTALS]);
  });

  // Mutation-proven: sorting each group by its unit price, or by its amount, reds it.
  it("a group prints its prices in their own order, sorted by neither name, unit price nor amount", () => {
    const priced = (description: string, unitPrice: number) => ({ ...op(description, 0, unitPrice), amount: 10 * unitPrice });
    const def = buildInvoiceDefinition(data(1, [priced("Temper", 3), priced("Anneal", 1), priced("Normalize", 2)]));
    expect(shape(def)).toEqual(["PRICE", "Temper", detail(3), "Anneal", detail(1), "Normalize", detail(2), "RULE", ...TOTALS]);
  });

  it("no prices: no rule", () => {
    const def = buildInvoiceDefinition(data(2, []));
    expect(shape(def)).toEqual(["PRICE", ...TOTALS]);
    expect(findNodes(def, isRule)).toEqual([]);
  });

  it("a hidden price section prints no rule", () => {
    const c = cfg();
    sectionOf(c, "price").visible = false;
    expect(findNodes(buildInvoiceDefinition(data(2, MIXED), checked(c)), isRule)).toEqual([]);
  });

  it("a hidden PARTS section leaves the groups and their rules", () => {
    const c = cfg();
    sectionOf(c, "parts").visible = false;
    const def = buildInvoiceDefinition(data(2, MIXED), checked(c));
    expect(shape(def)).toEqual(shape(buildInvoiceDefinition(data(2, MIXED))));
  });

  // With every column heading hidden no operation row is drawn, so a group whose rows have no detail
  // line prints nothing, and is followed by no rule.
  describe("with every column heading hidden", () => {
    const noColumns = () => {
      const c = cfg();
      for (const key of ["col_qty", "col_info", "col_each_weight", "col_amount"]) fieldOf(c, "column_header", key).visible = false;
      return checked(c);
    };

    it("and no detail lines, prints the PRICE heading and no rule", () => {
      const def = buildInvoiceDefinition(data(2, MIXED.map((row) => ({ ...row, unitPrice: null }))), noColumns());
      expect(shape(def)).toEqual(["PRICE", ...TOTALS]);
      expect(findNodes(def, isRule)).toEqual([]);
    });

    it("rules only the group that printed a detail line, never two rules together", () => {
      const def = buildInvoiceDefinition(data(2, [op("Carburize", 0, null), op("Temper", 1, 2), op("Normalize", null, null)]), noColumns());
      expect(shape(def)).toEqual(["PRICE", detail(2), "RULE", ...TOTALS]);
      noTwoRulesTogether(def);
    });
  });

  it("each rule is its own top-level canvas line across the content width, on every build", () => {
    const def = buildInvoiceDefinition(data(2, MIXED));
    const rules = content(def).filter(isRule);
    // Every canvas in the definition is one of the top-level rules.
    expect(findNodes(def, isRule)).toHaveLength(3);
    expect(findNodes(def, isRule).every((n) => rules.includes(n))).toBe(true);
    for (const rule of rules) expect(rule).toEqual(RULE);
    // pdfmake shifts a canvas vector in place as it lays it out (ElementWriter.addVector), so no two
    // rules share a node or a vector, within a build or across two.
    const vectors = (nodes: Record<string, unknown>[]) => nodes.map((n) => (n.canvas as unknown[])[0]);
    const again = content(buildInvoiceDefinition(data(2, MIXED))).filter(isRule);
    const all = [...rules, ...again];
    expect(new Set(all).size).toBe(6);
    expect(new Set(vectors(all)).size).toBe(6);
  });

  // A rule that ends the content has no space below it (the owner's answer of 2026-10-21, plan
  // Amendment 4): pdfmake starts a new page when a node's bottom margin does not fit, so a final
  // rule ending within its bottom margin of the page foot printed a blank last page.
  // invoice-pdf.test.ts holds the page count.
  describe("the rule that ends the content", () => {
    const LAST = { ...RULE, margin: [0, 4, 0, 0] };
    /** The content ends with the last group's rule, which has no space below it; every other rule
     *  keeps its own. */
    const endsWithTheRule = (def: unknown) => {
      const rules = content(def).filter(isRule);
      expect(rules).toHaveLength(3);
      expect(content(def).at(-1), "the content's last node").toBe(rules[2]);
      expect(rules[2]).toEqual(LAST);
      for (const rule of rules.slice(0, 2)) expect(rule).toEqual(RULE);
    };

    it("Totals hidden: the last rule ends the content and has no space below it", () => {
      const c = cfg();
      sectionOf(c, "totals").visible = false;
      const def = buildInvoiceDefinition(data(2, MIXED), checked(c));
      expect(shape(def)).toEqual(shape(buildInvoiceDefinition(data(2, MIXED))).slice(0, -TOTALS.length));
      endsWithTheRule(def);
    });

    it("PRICE ordered after Totals: the same", () => {
      const c = cfg();
      const [price] = c.sections.splice(c.sections.findIndex((s) => s.key === "price"), 1);
      c.sections.push(price);
      const def = buildInvoiceDefinition(data(2, MIXED), checked(c));
      expect(textOf(def).indexOf("Total Amount Due:")).toBeLessThan(textOf(def).indexOf("PRICE"));
      endsWithTheRule(def);
    });

    it("Totals shown with nothing to print (its two standing fields hidden, no row of its own): the same", () => {
      const c = cfg();
      for (const key of ["subtotal", "total"]) fieldOf(c, "totals", key).visible = false;
      // `data` carries no surcharge, charge, cert, freight or tax row.
      const def = buildInvoiceDefinition(data(2, MIXED), checked(c));
      endsWithTheRule(def);
    });

    it("the Standard order: Sub Total follows the last rule, and every rule keeps its space below", () => {
      const def = buildInvoiceDefinition(data(2, MIXED));
      const rules = content(def).filter(isRule);
      expect(rules).toHaveLength(3);
      for (const rule of rules) expect(rule).toEqual(RULE);
      expect(shape(def).slice(-3)).toEqual(["RULE", ...TOTALS]);
    });
  });

  it("a typed width on the information column leaves the rule at the content width", () => {
    for (const width of [362, 200]) {
      const c = cfg();
      fieldOf(c, "column_header", "col_info").width = width;
      // The contract's own battery: 362 is refused by the registry since R-B (#991); the rule is the builder's.
      const def = buildInvoiceDefinition(data(2, MIXED), validateContractConfig(INVOICE_CONTRACT, c));
      // The typed width took effect in this build: the operation row's information column is it.
      const row = content(def).find((n) => Array.isArray(n.columns) && (n.columns as { text?: unknown }[]).some((cell) => cell.text === "Carburize"));
      const info = (row!.columns as { text?: unknown; width?: unknown }[]).find((cell) => cell.text === "Carburize")!;
      expect(info.width).toBe(width);
      const rules = content(def).filter(isRule);
      expect(rules).toHaveLength(3);
      for (const rule of rules) expect(rule).toEqual(RULE);
    }
  });
});

describe("buildInvoiceDefinition — fonts and number formats", () => {
  it("family, base size and role sizes map into the definition", () => {
    const c = cfg();
    c.fonts = { family: "Liberation Serif", baseSize: 8, headingSize: 26, smallSize: 5 };
    const def = buildInvoiceDefinition(sampleData(), checked(c));
    expect(def.defaultStyle).toEqual({ font: "Liberation Serif", fontSize: 8 });
    // headingSize drives the "Invoice" title; smallSize the footer strip's fine print.
    expect(findNodes(def, (n) => n.text === "Invoice")[0].fontSize).toBe(26);
    expect(findNodes(def, (n) => n.text === "Contact: Accounts Receivable")[0].fontSize).toBe(5);
    // …the default keeps today's literals.
    const dflt = buildInvoiceDefinition(sampleData());
    expect(dflt.defaultStyle).toEqual({ font: "Roboto", fontSize: 9 });
    expect(findNodes(dflt, (n) => n.text === "Invoice")[0].fontSize).toBe(20);
    expect(findNodes(dflt, (n) => n.text === "Contact: Accounts Receivable")[0].fontSize).toBe(7.5);
  });

  it("thousandsSeparator: false ungroups quantities, weights and money", () => {
    const c = cfg();
    c.formats.thousandsSeparator = false;
    const big = sampleData({
      parts: [{ qty: 1440, partNumber: "X", partName: "Y", partDescription: "", eachWeight: 21, totalWeight: 30240 }],
      priceRows: [{ description: "Op", pricePerLabel: "Each", unitPrice: 6.51, minimumCharge: null, setupCharge: null, amount: 9374.4, partIndex: 0 }],
      subtotal: 9374.4, surchargeRows: [], total: 9374.4,
    });
    const text = textOf(buildInvoiceDefinition(big, checked(c)));
    expect(text).toContain("1440");
    expect(findNodes(buildInvoiceDefinition(big, checked(c)), (n) => n.text === "30240.00 lb")).toHaveLength(1);
    expect(text).toContain("$9374.40");
    expect(text).not.toContain("1,440");
    expect(text).not.toContain("$9,374.40");
  });
});

describe("buildInvoiceDefinition: a part row's weights carry the unit (weights design §13; owner ruling W15)", () => {
  type PartRow = InvoicePdfData["parts"][number];
  /** The example's first line: 200 pieces at 6.4 lb. */
  const part = (over: Partial<PartRow> = {}): PartRow =>
    ({ qty: 200, partNumber: "BRACKET-A", partName: "Bracket", partDescription: "", eachWeight: 6.4, totalWeight: 1280, ...over });
  /** The part's own row, the one `columns` node that holds its part number: its first, third and
   *  fourth cells, each whole. They follow the heading strip: quantity, identity, each weight, net weight. */
  const weights = (over: Partial<PartRow> = {}, config?: TemplateConfig) => {
    const def = buildInvoiceDefinition(sampleData({ parts: [part(over)] }), config);
    const [row] = findNodes(def, (n) => Array.isArray(n.columns)
      && (n.columns as unknown[]).some((cell) => cellTexts(cell).includes("BRACKET-A")));
    const [qty, , each, net] = row.columns as unknown[];
    return { qty: cellTexts(qty), each: cellTexts(each), net: cellTexts(net) };
  };

  // The quantity is a count: its cell is held whole in every row, so a unit on it is refused.
  it.each<[state: string, over: Partial<PartRow>, each: string[], net: string[]]>([
    ["the example's first line", {}, ["6.40 lb"], ["1,280.00 lb"]],
    ["a part of 0.0049 lb keeps the two decimals it prints today", { eachWeight: 0.0049, totalWeight: 0.98 }, ["0.00 lb"], ["0.98 lb"]],
    ["no each weight: a blank cell, and no unit", { eachWeight: null }, [""], ["1,280.00 lb"]],
    ["no net weight: a blank cell, and no unit", { totalWeight: null }, ["6.40 lb"], [""]],
  ])("%s", (_state, over, each, net) => {
    expect(weights(over)).toEqual({ qty: ["200"], each, net });
  });

  it("prints the unit under a heading a stored template typed (the frozen typed-label config)", () => {
    const config = normalizeStoredConfig("INVOICE", storedBefore("INVOICE", "typed-label"));
    expect(weights({}, config)).toEqual({ qty: ["200"], each: ["6.40 lb"], net: ["1,280.00 lb"] });
  });

  it.each<[field: string, each: string[], net: string[]]>([
    ["part_each_weight", [""], ["1,280.00 lb"]],
    ["part_total_weight", ["6.40 lb"], [""]],
  ])("a template that hid %s prints that cell empty, with no unit, and the other weight as it was", (field, each, net) => {
    const c = cfg();
    fieldOf(c, "parts", field).visible = false;
    expect(weights({}, checked(c))).toEqual({ qty: ["200"], each, net });
  });
});

describe("buildInvoiceDefinition — the date knob (the sample's long full-month style)", () => {
  it.each([
    ["M/D/YYYY", "7/29/2026"],
    ["MM/DD/YYYY", "07/29/2026"],
    ["YYYY-MM-DD", "2026-07-29"],
    ["MMMM D, YYYY", "July 29, 2026"],
    ["MMM - DD - YYYY", "Jul - 29 - 2026"],
  ])("renders the invoice date as %s", (format, expected) => {
    const c = cfg();
    c.formats.dateFormat = format as TemplateConfig["formats"]["dateFormat"];
    expect(textOf(buildInvoiceDefinition(sampleData(), checked(c)))).toContain(expected);
  });

  it("defaults to the sample's 'July 29, 2026' style", () => {
    expect(textOf(buildInvoiceDefinition(sampleData()))).toContain("July 29, 2026");
  });
});

describe("buildInvoiceDefinition — the negativeStyle knob formats a credit (ruling 3)", () => {
  it.each([
    ["SIGN_AFTER_SYMBOL", "$-937.44", "$-974.94"],
    ["LEADING_MINUS", "-$937.44", "-$974.94"],
    ["PARENTHESES", "($937.44)", "($974.94)"],
  ])("renders %s on a credit's negative amounts", (style, amount, total) => {
    const c = cfg();
    c.formats.negativeStyle = style as TemplateConfig["formats"]["negativeStyle"];
    const text = textOf(buildInvoiceDefinition(creditData(), checked(c)));
    expect(text).toContain("Credit");
    expect(text).toContain(amount);
    expect(text).toContain(total);
  });

  it("defaults to SIGN_AFTER_SYMBOL — today's '$-937.44'; a positive invoice is unchanged", () => {
    expect(textOf(buildInvoiceDefinition(creditData()))).toContain("$-937.44");
    expect(textOf(buildInvoiceDefinition(sampleData()))).toContain("$937.44");
  });
});

describe("buildInvoiceDefinition — the §5.6 belt, both halves", () => {
  it("nothing on this contract is locked: a validated config may hide ANY section and the builder honors it", () => {
    const c = cfg();
    sectionOf(c, "parties").visible = false;
    sectionOf(c, "footer").visible = false;
    const validated = checked(c);
    const text = textOf(buildInvoiceDefinition(sampleData(), validated));
    expect(text).not.toContain("Billto:");
    expect(text).not.toContain("Contact: Accounts Receivable");
  });

  it("a raw config OMITTING the totals section entry still renders it (the omission half)", () => {
    const c = cfg();
    c.sections = c.sections.filter((s) => s.key !== "totals");
    const text = textOf(buildInvoiceDefinition(sampleData(), c));
    expect(text).toContain("Sub Total Amount:");
    expect(text).toContain("Total Amount Due:");
  });

  it("a raw config OMITTING a field entry inside a present section still renders it", () => {
    const c = cfg();
    const order = sectionOf(c, "order_strip");
    order.fields = order.fields.filter((f) => f.key !== "process");
    const text = textOf(buildInvoiceDefinition(sampleData(), c));
    expect(text).toContain("Process: ");
  });
});

const LOGO_URI = "data:image/png;base64,INVOICELOGOFIXTURE";

describe("buildInvoiceDefinition — logo placement (spec §6.3)", () => {
  const placedConfig = (placement: "header-left" | "header-center" | "header-right") => {
    const c = cfg();
    c.logo = { placement, width: 90 };
    return checked(c);
  };
  const header = (def: unknown) => (def as { content: Record<string, unknown>[] }).content[0];

  it("a header-center logo unshifts into the centered header stack", () => {
    const h = header(buildInvoiceDefinition(sampleData(), placedConfig("header-center"), LOGO_URI));
    expect((h.stack as { image?: string }[])[0]).toEqual({ image: LOGO_URI, width: 90 });
  });

  it("a header-left logo rides the left column at its configured width", () => {
    const h = header(buildInvoiceDefinition(sampleData(), placedConfig("header-left"), LOGO_URI));
    const cols = h.columns as { width?: number; stack?: { image?: string }[] }[];
    expect(cols[0].stack![0]).toEqual({ image: LOGO_URI, width: 90 });
  });

  it("a header-right logo rides the right column", () => {
    const h = header(buildInvoiceDefinition(sampleData(), placedConfig("header-right"), LOGO_URI));
    const cols = h.columns as { width?: number; stack?: { image?: string }[] }[];
    expect(cols[cols.length - 1].stack![0]).toEqual({ image: LOGO_URI, width: 90 });
  });

  it("config placement without bytes, and bytes without placement, both fall back to the text-only header", () => {
    expect(JSON.stringify(buildInvoiceDefinition(sampleData(), placedConfig("header-center")))).not.toContain(LOGO_URI);
    expect(JSON.stringify(buildInvoiceDefinition(sampleData(), cfg(), LOGO_URI))).not.toContain(LOGO_URI);
  });
});

describe("buildInvoiceDefinition — pageFooter knob and continuation band", () => {
  it("the knob OFF keeps the static company-strip footer; the margins are today's", () => {
    const dflt = buildInvoiceDefinition(sampleData());
    expect(dflt.pageFooterSpec).toBeUndefined();
    expect(textOf(dflt.footer)).toContain("Phone: 256-555-0100");
    expect(dflt.pageMargins).toEqual([24, 24, 24, 44]);
  });

  it("the knob ON moves the company strip onto the pageNofM footer's `above` slot, dropping the plain footer", () => {
    const c = cfg();
    c.pageFooter = true;
    const def = buildInvoiceDefinition(sampleData(), checked(c));
    expect(def.footer).toBeUndefined();
    expect(def.pageFooterSpec!.kind).toBe("pageNofM");
    expect(textOf(def.pageFooterSpec!.above)).toContain("Phone: 256-555-0100");
    expect(def.pageMargins).toEqual([24, 24, 24, 44]);
  });

  it("the knob ON with the footer section hidden carries the page line alone", () => {
    const c = cfg();
    c.pageFooter = true;
    sectionOf(c, "footer").visible = false;
    const def = buildInvoiceDefinition(sampleData(), checked(c));
    expect(def.pageFooterSpec).toEqual({ kind: "pageNofM" });
    expect(def.footer).toBeUndefined();
  });

  it("the definition carries the invoice's identity band for continuation pages", () => {
    const def = buildInvoiceDefinition(sampleData());
    const band = allText(def.continuationHeaderSpec!.content).join("\n");
    expect(band).toContain("Invoice No.: 7 - 92026");
    expect(band).toContain("(continued)");
    expect(def.continuationHeaderSpec!.overflowTopMargin).toBeGreaterThanOrEqual(36);
  });

  it("the band carries an invoice_no label override but ignores its visibility flag — identity on paper is locked", () => {
    const c = cfg();
    fieldOf(c, "identity", "invoice_no").label = "Job No.:";
    fieldOf(c, "identity", "invoice_no").visible = false;
    const def = buildInvoiceDefinition(sampleData(), checked(c));
    const band = allText(def.continuationHeaderSpec!.content).join("\n");
    expect(band).toContain("Job No.: 7 - 92026");
    // …while the sheet body honours the hide.
    expect(textOf(def.content)).not.toContain("Job No.:");
  });

  it("a many-part invoice overflows LETTER and repeats its identity on the last page (the live overflow path)", async () => {
    const parts = Array.from({ length: 40 }, (_, i) => ({
      qty: 144, partNumber: `A16-${i}`, partName: "EQUALIZER-RR SUSP", partDescription: "SUSP", eachWeight: 21, totalWeight: 3024,
    }));
    const pdf = await renderPdf(buildInvoiceDefinition(sampleData({ parts })));
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(2);
    const pages = drawnPages(pdf);
    expect(pages[0]).not.toContain("(continued)");
    expect(pages[pages.length - 1]).toContain("(continued)");
  });
});

describe("buildInvoiceDefinition — purity, config included", () => {
  it("a config-driven definition survives the JSON round trip and is deterministic", () => {
    const c = cfg();
    c.logo = { placement: "header-right", width: 80 };
    fieldOf(c, "identity", "invoice_no").label = "INV:";
    c.formats.dateFormat = "YYYY-MM-DD";
    c.formats.negativeStyle = "PARENTHESES";
    c.pageFooter = true;
    const config = checked(c);
    const def = buildInvoiceDefinition(creditData(), config, LOGO_URI);
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
    expect(buildInvoiceDefinition(creditData(), config, LOGO_URI)).toEqual(def);
  });
});

// ================================================================================================
// The print path (spec §5.2): resolve docType `INVOICE` on the invoice's own customer (BOTH an
// invoice and a credit resolve INVOICE — spec §4.1: one contract covers credits), render the
// resolved config, stamp `templateVersionId`. `claimInvoiceForPrint`'s order+invoice claim and the
// print-vs-discard serialization are untouched. Reprints reissue STORED bytes, never re-render.
// ================================================================================================

/** Create → tweak the v1 draft → (optionally logo) → publish, for the INVOICE docType. */
let tplSeq = 0;
async function publishCustom(tweak: (c: TemplateConfig) => void, logo?: { data: Buffer; mime: string }) {
  tplSeq += 1;
  const t = await asSystem(() => createTemplate("INVOICE", `Custom Invoice ${tplSeq}`));
  const c = cfg();
  tweak(c);
  await asSystem(() => editDraft(t.id, { config: c, updatedAt: t.draft.updatedAt }));
  if (logo) await asSystem(() => uploadLogo(t.id, logo.data, logo.mime));
  const { versionId } = await asSystem(() => publishDraft(t.id));
  return { templateId: t.id, versionId };
}

async function stampOf(documentId: string): Promise<string | null> {
  const row = await prisma.storedDocument.findUnique({
    where: { id: documentId }, select: { templateVersionId: true },
  });
  return row!.templateVersionId;
}

describe("printInvoice — resolution stamps the version (INVOICE for both invoice and credit)", () => {
  beforeEach(async () => {
    await truncateAll();
    await seedOrderGatePrereqs();
    await asSystem(() => setSetting("company_name", "Example Heat Treating - Alabama, LLC"));
    await asSystem(() => setSetting("company_address", "100 Example Way\nAnniston AL 36207"));
    await asSystem(() => setSetting("company_phone", "256-555-0100"));
  });

  it("no assignment: resolves the seeded Standard invoice and stamps ITS version id", async () => {
    const { invoice } = await finalizedFixture();
    const { documentId, pdf } = await asSystem(() => printInvoice(invoice.id));
    expect(drawnText(pdf)).toContain("Invoice");
    expect(await stampOf(documentId)).toBe(templateVersionId("INVOICE"));
  });

  it("a label override prints through the real path and stamps the assigned version", async () => {
    const { invoice, customer } = await finalizedFixture();
    const tpl = await publishCustom((c) => { fieldOf(c, "totals", "total").label = "TOTAL-MARKER:"; });
    await asSystem(() => assignTemplate(customer.id, "INVOICE", tpl.templateId));
    const { documentId, pdf } = await asSystem(() => printInvoice(invoice.id));
    expect(drawnText(pdf)).toContain("TOTAL-MARKER:");
    expect(await stampOf(documentId)).toBe(tpl.versionId);
  });

  it("BOTH an invoice and its credit resolve INVOICE — same assigned template, same version stamp", async () => {
    const { invoice, customer } = await finalizedFixture();
    const tpl = await publishCustom((c) => { fieldOf(c, "totals", "total").label = "SHARED-MARKER:"; });
    await asSystem(() => assignTemplate(customer.id, "INVOICE", tpl.templateId));

    const inv = await asSystem(() => printInvoice(invoice.id));
    expect(drawnText(inv.pdf)).toContain("SHARED-MARKER:");
    expect(await stampOf(inv.documentId)).toBe(tpl.versionId);

    const credit = await asSystem(() => createCredit(invoice.id));
    const cr = await asSystem(() => printInvoice(credit.id));
    expect(drawnText(cr.pdf)).toContain("SHARED-MARKER:");
    expect(await stampOf(cr.documentId)).toBe(tpl.versionId);
  });

  it("the negativeStyle knob formats a credit through the real path", async () => {
    const { invoice, customer } = await finalizedFixture();
    const tpl = await publishCustom((c) => { c.formats.negativeStyle = "PARENTHESES"; });
    await asSystem(() => assignTemplate(customer.id, "INVOICE", tpl.templateId));
    const credit = await asSystem(() => createCredit(invoice.id));
    const { pdf } = await asSystem(() => printInvoice(credit.id));
    const text = drawnText(pdf);
    expect(text).toContain("Credit");
    expect(text).toContain("($937.44)");
  });

  it("the pageFooter knob prints per-page numbers; the default prints none", async () => {
    const a = await finalizedFixture();
    const tpl = await publishCustom((c) => { c.pageFooter = true; });
    await asSystem(() => assignTemplate(a.customer.id, "INVOICE", tpl.templateId));
    const withFooter = await asSystem(() => printInvoice(a.invoice.id));
    expect(drawnText(withFooter.pdf)).toContain("Page 1 of 1");

    const b = await finalizedFixture();
    const bare = await asSystem(() => printInvoice(b.invoice.id));
    expect(drawnText(bare.pdf)).not.toMatch(/Page \d+ of \d+/);
  });

  it("a placed logo prints through the real path; the bare invoice paints none", async () => {
    const a = await finalizedFixture();
    const tpl = await publishCustom(
      (c) => { c.logo = { placement: "header-left", width: 90 }; },
      { data: await barcodePng("INVLOGO"), mime: "image/png" });
    await asSystem(() => assignTemplate(a.customer.id, "INVOICE", tpl.templateId));
    const placed = await asSystem(() => printInvoice(a.invoice.id));
    expect(paintedImageCounts(placed.pdf)).toEqual([1]);

    const b = await finalizedFixture();
    const bare = await asSystem(() => printInvoice(b.invoice.id));
    expect(paintedImageCounts(bare.pdf)).toEqual([0]);
  });

  it("a template edit after an invoice is raised changes NOTHING on reprint — the frozen-paper proof", async () => {
    const { invoice, customer } = await finalizedFixture();
    // Assign a template that relabels the total, then print — the paper carries that label.
    const first = await publishCustom((c) => { fieldOf(c, "totals", "total").label = "ORIGINAL-MARKER:"; });
    await asSystem(() => assignTemplate(customer.id, "INVOICE", first.templateId));
    const printed = await asSystem(() => printInvoice(invoice.id));
    expect(drawnText(printed.pdf)).toContain("ORIGINAL-MARKER:");

    // Publish and assign a DIFFERENT template AFTER the invoice was raised and printed.
    const second = await publishCustom((c) => { fieldOf(c, "totals", "total").label = "CHANGED-MARKER:"; });
    await asSystem(() => assignTemplate(customer.id, "INVOICE", second.templateId));

    // The STORED bytes of the raised paper are byte-for-byte unchanged — a reprint reissues them,
    // never re-renders under the new template.
    const stored = await getDocument(printed.documentId);
    expect(Buffer.compare(stored.fileData, printed.pdf)).toBe(0);
    const storedText = drawnText(stored.fileData);
    expect(storedText).toContain("ORIGINAL-MARKER:");
    expect(storedText).not.toContain("CHANGED-MARKER:");
  });
});

describe("the invoice's built-in heading on stored configs (owner ruling W14)", () => {
  const page = (data: InvoicePdfData, stored: unknown) => buildInvoiceDefinition(data, normalizeStoredConfig("INVOICE", stored));
  const heads = (def: unknown) => tableHeaded(def, "Quantity").body[0].map(cellTexts);
  const KEPT = [["Quantity"], ["Order Information / Part No. / Description / Pricing Information"], ["Each weight"]];
  const PAPERS = [["an invoice", sampleData()], ["a credit memo", creditData()]] as const;

  it.each(PAPERS)("a stored config with no typed label prints the new heading on %s", (_what, data) => {
    expect(heads(page(data, seedLiteral("INVOICE")))).toEqual([...KEPT, ["Net weight / Price"]]);
  });

  it.each(PAPERS)("a stored config with no typed label prints the old wording in no cell of %s", (_what, data) => {
    expect(allText(page(data, seedLiteral("INVOICE"))).filter((text) => text === "Total Wt / Price")).toEqual([]);
  });

  it("a typed label prints as typed", () => {
    expect(heads(page(sampleData(), storedBefore("INVOICE", "typed-label")))).toEqual([...KEPT, ["Wt / Price"]]);
  });

  it("a label typed to equal the old wording prints the old wording", () => {
    const stored = storedBefore("INVOICE", "typed-label") as TemplateConfig;
    fieldOf(stored, "column_header", "col_amount").label = "Total Wt / Price";
    expect(heads(page(sampleData(), stored))).toEqual([...KEPT, ["Total Wt / Price"]]);
  });
});

describe("the invoice's canvas floors (design 2026-11-10 §4.1)", () => {
  /** Lays out a probe of the flow's own nodes: the definition is built and cloned afresh (pdfmake
   *  uses up the nodes it lays out), `pick` returns the top-level node list from it, and the probe
   *  keeps the definition's page size, margins and default style with that list as its content and
   *  nothing else (no footer or continuation spec). Answers the top of an id'd mark, every mark a
   *  top-level node (render.ts: id only top-level flow nodes whose position is wanted). The order
   *  strip's row goes in at the top level with its id, where render.ts's `fitMeasuredRows` accepts
   *  and measures it. */
  async function probe(
    data: InvoicePdfData, config: TemplateConfig, pick: (def: RenderableDefinition) => Content[],
  ): Promise<(id: string) => number> {
    const def = structuredClone(buildInvoiceDefinition(data, checked(config)));
    const probeDef: RenderableDefinition = {
      pageSize: def.pageSize, pageMargins: def.pageMargins, defaultStyle: def.defaultStyle, content: pick(def),
    };
    const [laid] = await layOutSheetGroups([probeDef]);
    return (id) => {
      const node = laid.find((n) => n.id === id);
      if (node === undefined) throw new Error(`the probe laid out no mark "${id}"`);
      expect(node.page).toBe(1);
      return node.top;
    };
  }
  const one = (def: unknown, pred: (n: Record<string, unknown>) => boolean): Record<string, unknown> => {
    const found = findNodes(def, pred);
    expect(found).toHaveLength(1);
    return found[0];
  };
  const inFamily = (family: FontFamily): TemplateConfig => {
    const c = cfg();
    c.fonts.family = family;
    return c;
  };
  /** A one-node block's own margins zeroed (the wrapper rule, design §5.2). */
  const flat = (node: Record<string, unknown>): Content => ({ ...node, margin: [0, 0, 0, 0] }) as Content;
  /** The order strip's row with its top and bottom margins zeroed, its id and left indent kept. */
  const stripFlat = (node: Record<string, unknown>): Content => {
    const [left, , right] = node.margin as number[];
    return { ...node, margin: [left, 0, right, 0] } as Content;
  };
  /** Every label read from the contract, never retyped (the default config stores `label: null`). */
  const label = (section: string, key: string): string =>
    INVOICE_CONTRACT.sections.find((s) => s.key === section)!.fields.find((f) => f.key === key)!.defaultLabel;
  /** A node found in the definition, handed back to the probe as it is. */
  const asIs = (n: Record<string, unknown>): Content => n as unknown as Content;
  /** The definition's top-level nodes, read as records. */
  const topLevel = (def: RenderableDefinition): Record<string, unknown>[] => def.content as unknown as Record<string, unknown>[];
  const STRIP = "invoice-order-strip";
  const columnsOf = (n: Record<string, unknown>): Record<string, unknown>[] =>
    (Array.isArray(n.columns) ? n.columns : []) as Record<string, unknown>[];
  /** The parties' first address column: the stack whose first node is the Bill-to label. */
  const partiesStack = (def: unknown): Content[] =>
    one(def, (n) => Array.isArray(n.stack) && (n.stack as { text?: unknown }[])[0]?.text === label("parties", "bill_to"))
      .stack as Content[];
  /** The column headers' boxed strip: the one table of four columns (the Remit To box is one column). */
  const headerStrip = (def: unknown) =>
    one(def, (n) => typeof n.table === "object" && n.table !== null && (n.table as { widths: unknown[] }).widths.length === 4);
  const partRow = (def: unknown, partNumber: string) => one(def, (n) => columnsOf(n)
    .some((c) => Array.isArray(c.stack) && (c.stack as { text?: unknown }[])[0]?.text === partNumber));
  const priceHeading = (def: unknown) => one(def, (n) => n.text === label("price", "price_heading"));
  const operationRow = (def: unknown, description: string) => one(def, (n) => columnsOf(n).some((c) => c.text === description));
  const totalLine = (def: unknown, text: string) => one(def, (n) => columnsOf(n)[1]?.text === text);

  it("INVOICE_ROW_FLOOR is one 9 pt line, the least across the families, and INVOICE_FIRST_TABLE_ROOM the largest block's room, measured on the flow's own nodes", async () => {
    // The part's identity cell one line, so its row is one line.
    const part = { ...sampleData().parts[0], partName: "", partDescription: "" };
    const oneLine = sampleData({ parts: [part] });
    // One price row with no detail line under it (no per-unit price, minimum, setup or quote).
    const op = sampleData().priceRows[0];
    const bareOp = { ...op, unitPrice: null, minimumCharge: null, setupCharge: null, sourceQuoteNumber: null };
    const bare = sampleData({ parts: [part], priceRows: [bareOp] });
    const subtotal = label("totals", "subtotal");
    const total = label("totals", "total");

    type Blocks = { parties: number; column_header: number; order_strip: number; parts: number; price: number; totals: number };
    const line: Record<string, number> = {};
    const lineBlocks: Record<string, Blocks> = {};
    const roomsByFamily: Record<string, Blocks> = {};
    for (const family of FONT_FAMILIES) {
      // Each block's one one-line node, flattened, between its own two marks.
      const lineTop = await probe(oneLine, inFamily(family), (def) => {
        const strip = one(def, (n) => n.id === STRIP);
        expect(topLevel(def).includes(strip)).toBe(true);
        return [
          mark("parties:a"), flat(partiesStack(def)[1] as unknown as Record<string, unknown>), mark("parties:b"),
          mark("column_header:a"), flat(headerStrip(def)), mark("column_header:b"),
          mark("order_strip:a"), stripFlat(strip), mark("order_strip:b"),
          mark("parts:a"), flat(partRow(def, part.partNumber)), mark("parts:b"),
          mark("price:a"), flat(priceHeading(def)), mark("price:b"),
          mark("totals:a"), flat(totalLine(def, subtotal)), mark("totals:b"),
        ];
      });
      const span = (top: (id: string) => number, key: string) => top(`${key}:b`) - top(`${key}:a`);
      const blocks = (top: (id: string) => number): Blocks => ({
        parties: span(top, "parties"), column_header: span(top, "column_header"), order_strip: span(top, "order_strip"),
        parts: span(top, "parts"), price: span(top, "price"), totals: span(top, "totals"),
      });
      lineBlocks[family] = blocks(lineTop);
      line[family] = Math.min(...Object.values(lineBlocks[family]));

      // Each block's room: the nodes as they are, but a one-node block's own margins zeroed.
      const roomTop = await probe(bare, inFamily(family), (def) => {
        const content = topLevel(def);
        const strip = one(def, (n) => n.id === STRIP);
        const after = content[content.indexOf(strip) + 1];
        expect(after.text).toBe(label("order_strip", "parts_heading"));
        const parties = partiesStack(def);
        expect((parties[1] as { text?: unknown }).text).toBe(bare.billTo[0]);
        return [
          mark("parties:a"), parties[0], parties[1], mark("parties:b"),
          mark("column_header:a"), flat(headerStrip(def)), mark("column_header:b"),
          mark("order_strip:a"), asIs(strip), asIs(after), mark("order_strip:b"),
          mark("parts:a"), asIs(partRow(def, part.partNumber)), mark("parts:b"),
          mark("price:a"), asIs(priceHeading(def)), asIs(operationRow(def, bareOp.description)), mark("price:b"),
          mark("subtotal:a"), asIs(totalLine(def, subtotal)), mark("subtotal:b"),
          mark("total:a"), asIs(totalLine(def, total)), mark("total:b"),
        ];
      });
      roomsByFamily[family] = {
        parties: span(roomTop, "parties"), column_header: span(roomTop, "column_header"),
        order_strip: span(roomTop, "order_strip"), parts: span(roomTop, "parts"), price: span(roomTop, "price"),
        totals: Math.max(span(roomTop, "subtotal"), span(roomTop, "total")),
      };
    }
    measured("the invoice's canvas floors", { line, lineBlocks, roomsByFamily });

    // Bounds, so a misread mark (one read at its group's start answers 0) cannot pass.
    for (const family of FONT_FAMILIES) {
      expect(line[family]).toBeGreaterThanOrEqual(8);
      expect(line[family]).toBeLessThanOrEqual(16);
      for (const room of Object.values(roomsByFamily[family])) {
        expect(room).toBeGreaterThanOrEqual(8);
        expect(room).toBeLessThanOrEqual(50);
      }
    }

    // The literals, each held to its measurement (soft, so a wrong literal shows every check it breaks).
    expect.soft(INVOICE_ROW_FLOOR).toBe(Math.floor(Math.min(...Object.values(line))));
    expect.soft(INVOICE_FIRST_TABLE_ROOM).toBe(Math.ceil(Math.max(...Object.values(roomsByFamily.Roboto))));
    expect.soft(INVOICE_FIRST_TABLE_ROOM).toBeGreaterThan(INVOICE_ROW_FLOOR);
    // The floor is a least height in every face.
    for (const family of FONT_FAMILIES) expect.soft(line[family]).toBeGreaterThanOrEqual(INVOICE_ROW_FLOOR);
  }, 60_000);

  it("the parts' room on a three-line part, measured in every face on the flow's own nodes (pin)", async () => {
    // PR 1's residual 3: INVOICE_FIRST_TABLE_ROOM was measured on a part whose identity cell prints
    // one line. A part printing its number, its name and its description, each on one line, is the
    // three-line row measured here by the floors case's method (the row as the flow builds it,
    // between two top-level marks, its own margins kept). The one- and two-line rows beside it prove
    // each piece took one line: the three-line row is one line taller than the two-line row, as the
    // two-line row is than the one-line row, so no piece wrapped.
    const base = sampleData().parts[0];
    const rows = {
      one: { ...base, partNumber: "P-1", partName: "", partDescription: "" },
      two: { ...base, partNumber: "P-1", partName: "Name", partDescription: "" },
      three: { ...base, partNumber: "P-1", partName: "Name", partDescription: "Desc" },
    };
    const room: Record<string, { one: number; two: number; three: number }> = {};
    for (const family of FONT_FAMILIES) {
      const spans = {} as { one: number; two: number; three: number };
      for (const [size, part] of Object.entries(rows) as ["one" | "two" | "three", typeof base][]) {
        const top = await probe(sampleData({ parts: [part] }), inFamily(family), (def) => [
          mark("parts:a"), asIs(partRow(def, part.partNumber)), mark("parts:b"),
        ]);
        spans[size] = top("parts:b") - top("parts:a");
      }
      room[family] = spans;
    }
    measured("the invoice parts' room on a three-line part", room);

    for (const family of FONT_FAMILIES) {
      const { one: l1, two: l2, three: l3 } = room[family];
      // Each piece one line: the step from two lines to three is the step from one to two.
      expect(l2 - l1, family).toBeGreaterThan(5);
      expect(l3 - l2, family).toBeCloseTo(l2 - l1, 2);
    }
    // The figures, pinned (two decimals; `toBeCloseTo`'s second argument is digits).
    expect.soft(room.Roboto.three).toBeCloseTo(33.64, 2);
    expect.soft(room["Liberation Sans"].three).toBeCloseTo(32.16, 2);
    expect.soft(room["Liberation Serif"].three).toBeCloseTo(31.9, 2);
    // Roboto Mono's three-line row is past the 35 pt room (the owner's open Roboto Mono question).
    expect.soft(room["Roboto Mono"].three).toBeCloseTo(37.61, 2);
    // Roboto's, the contract's built-in face, is within the first table's room; the other faces'
    // figures are pinned and reported, Roboto Mono's joining the owner's open question (call 12).
    expect(room.Roboto.three).toBeLessThanOrEqual(INVOICE_FIRST_TABLE_ROOM);
  }, 60_000);
});

describe("the canvas branch (design 2026-11-10 §5.1)", () => {
  it("a canvas invoice: a null layout's definition holds no canvas id", () => {
    const config = (layout: TemplateConfig["layout"]): TemplateConfig => ({ ...structuredClone(INVOICE_DEFAULT_CONFIG), layout });
    expect(JSON.stringify(buildInvoiceDefinition(sampleInvoice(), config(null)))).not.toContain('"canvas:');
    // The contrast: the same config carrying the Standard's canvas holds the canvas's ids, so the
    // absence above is the branch's, never a definition that holds no id at all.
    expect(JSON.stringify(buildInvoiceDefinition(sampleInvoice(), config(standardInvoiceLayout())))).toContain('"canvas:');
  });
});
