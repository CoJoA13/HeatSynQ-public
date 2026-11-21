import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInvoiceDefinition, type InvoicePdfData } from "@/server/pdf/invoice";
import { INVOICE_DEFAULT_CONFIG, validateConfig, type TemplateConfig } from "@/lib/template-contracts/index";
import type { LogoPlacement } from "@/lib/template-contracts/types";
import { sampleInvoice } from "./helpers/invoice-canvas-fixtures";

/**
 * The invoice flow's frozen node trees (invoice canvas PR 2, plan Task 1). The goldens of
 * tests/invoice-pdf.test.ts assert text, never widths, so a refactor of `pdf/invoice.ts` that moved a
 * width or a gap would pass them (the cert ledger's Task 1 lesson). This file freezes
 * `buildInvoiceDefinition`'s JSON for a matrix of data and configs, written once at the base commit
 * (`INVOICE_ORACLE_WRITE=1`), and deep-equals every later build against it: an invoice template whose
 * `layout` is null builds exactly the definition it built before the canvas lane. The cases from
 * "Liberation Serif at base 10, …" on were added after the whole-branch review (its finding 0) and
 * frozen from aa826aa8's pdf/invoice.ts, copied into the tree for the one write and removed: the 21
 * entries above them kept their bytes. Each of the five built over `rich` reds with the quote source
 * line's top margin, or the tax row's, moved by 1, which leaves the 21 earlier cases green.
 */

const ORACLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "invoice-flow-oracle.json");
/** A stand-in logo: the builder places the string it is handed and reads nothing of it. */
const LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** The default config edited by `edit`, then validated and backfilled as a template stores it. */
function configWith(edit: (c: TemplateConfig) => void): TemplateConfig {
  const c = structuredClone(INVOICE_DEFAULT_CONFIG);
  edit(c);
  return validateConfig("INVOICE", c);
}
const section = (c: TemplateConfig, key: string) => c.sections.find((s) => s.key === key)!;
const field = (c: TemplateConfig, sectionKey: string, key: string) => section(c, sectionKey).fields.find((f) => f.key === key)!;
const withLogo = (placement: LogoPlacement) => configWith((c) => { c.logo = { placement, width: 80 }; });

const credit = (): InvoicePdfData => sampleInvoice({
  title: "Credit", documentNumber: "1000",
  priceRows: [{ description: "Austemper", pricePerLabel: "Each", unitPrice: 6.51, minimumCharge: 600, setupCharge: null, amount: -937.44, partIndex: 0 }],
  subtotal: -937.44, surchargeRows: [{ description: "EnergySur", amount: -37.5 }], total: -974.94,
});
const PART_B = { qty: 50, partNumber: "DEMO-9002-000", partName: "SPRING SEAT", partDescription: "", eachWeight: 3.2, totalWeight: 160 };
const op = (description: string, partIndex: number | null, unitPrice: number) =>
  ({ description, pricePerLabel: "Each", unitPrice, minimumCharge: null, setupCharge: null, amount: unitPrice * 10, partIndex });
/** Two parts and a price that lost its part (#589's three groups). */
const grouped = (): InvoicePdfData => sampleInvoice({
  parts: [sampleInvoice().parts[0], PART_B],
  priceRows: [op("Temper", 1, 2), op("Carburize", 0, 1), op("Normalize", null, 4), op("Anneal", 1, 3)],
  subtotal: 100, surchargeRows: [], total: 100,
});
const PROCESS = "Austemper, Stress Relieve, Neutral Harden, Temper, Gas Nitride, Carburize, Anneal, Normalize";
const LONG_PO = "PO 24115 RELEASE ".repeat(12).slice(0, 200);
/** Every price detail and every totals row: a quoted operation with its unit price, minimum and
 *  setup; a needs-price operation; two charges, a certification, freight and tax, over two parts. */
const rich = (): InvoicePdfData => sampleInvoice({
  parts: [sampleInvoice().parts[0], PART_B],
  priceRows: [
    { description: "Austemper", pricePerLabel: "Each", unitPrice: 6.51, minimumCharge: 600, setupCharge: 75, sourceQuoteNumber: 4108, amount: 1012.44, partIndex: 0 },
    { description: "Temper", pricePerLabel: "Lb", unitPrice: null, minimumCharge: null, setupCharge: null, sourceQuoteNumber: null, amount: 0, partIndex: 1 },
  ],
  subtotal: 1012.44,
  surchargeRows: [{ description: "EnergySur", amount: 37.5 }],
  chargeRows: [{ description: "Expedite", amount: 50 }, { description: "Packaging", amount: 25.25 }],
  certRow: { description: "Certification", amount: 15 },
  freightRow: { description: "Freight", amount: 120 },
  taxRow: { description: "Sales Tax", amount: 81.23 },
  total: 1341.42,
});
/** A typed label on every identity line and the Remit To box, the order strip's fields and its
 *  heading, the totals' two labelled rows and the footer's two labelled cells. */
const TYPED_LABELS: [string, string, string][] = [
  ["identity", "invoice_no", "Inv #:"], ["identity", "invoice_date", "Dated:"], ["identity", "terms", "Pay terms:"],
  ["identity", "remit_to", "Pay To"],
  ["order_strip", "our_order_no", "Order:"], ["order_strip", "your_po", "PO:"], ["order_strip", "material", "Alloy:"],
  ["order_strip", "process", "Treatment:"], ["order_strip", "parts_heading", "ITEMS"],
  ["totals", "subtotal", "Subtotal:"], ["totals", "total", "Amount Due:"],
  ["footer", "footer_contact", "Questions? Call us"], ["footer", "footer_phone", "Tel:"],
];

type Case = { data: InvoicePdfData; config?: TemplateConfig; logo?: string };
const CASES: Record<string, () => Case> = {
  "the Standard": () => ({ data: sampleInvoice() }),
  "a credit, SIGN_AFTER_SYMBOL": () => ({ data: credit(), config: configWith((c) => { c.formats.negativeStyle = "SIGN_AFTER_SYMBOL"; }) }),
  "a credit, LEADING_MINUS": () => ({ data: credit(), config: configWith((c) => { c.formats.negativeStyle = "LEADING_MINUS"; }) }),
  "a credit, PARENTHESES": () => ({ data: credit(), config: configWith((c) => { c.formats.negativeStyle = "PARENTHESES"; }) }),
  "a 200-character PO and an eight-operation Process": () => ({ data: sampleInvoice({ poNumber: LONG_PO, processNames: PROCESS }) }),
  "Quantity 300 with both weights hidden (the stacked strip)": () => ({
    data: sampleInvoice(),
    config: configWith((c) => {
      field(c, "column_header", "col_qty").width = 300;
      for (const key of ["col_each_weight", "col_amount"]) field(c, "column_header", key).visible = false;
    }),
  }),
  "two parts and a lost-part price (#589's three groups)": () => ({ data: grouped() }),
  "Totals hidden": () => ({ data: grouped(), config: configWith((c) => { section(c, "totals").visible = false; }) }),
  "PRICE ordered after Totals": () => ({
    data: grouped(),
    config: configWith((c) => {
      const price = c.sections.findIndex((s) => s.key === "price");
      const [moved] = c.sections.splice(price, 1);
      c.sections.splice(c.sections.findIndex((s) => s.key === "totals") + 1, 0, moved);
    }),
  }),
  "every Totals row hidden": () => ({
    data: grouped(), config: configWith((c) => { for (const f of section(c, "totals").fields) f.visible = false; }),
  }),
  "part_qty, price_heading and footer_contact hidden": () => ({
    data: sampleInvoice(),
    config: configWith((c) => {
      field(c, "parts", "part_qty").visible = false;
      field(c, "price", "price_heading").visible = false;
      field(c, "footer", "footer_contact").visible = false;
    }),
  }),
  "an R14 bill-to": () => ({ data: sampleInvoice({ billTo: ["Accounts Payable", ...sampleInvoice().billTo] }) }),
  "a header-left logo": () => ({ data: sampleInvoice(), config: withLogo("header-left"), logo: LOGO }),
  "a header-right logo": () => ({ data: sampleInvoice(), config: withLogo("header-right"), logo: LOGO }),
  "a header-centre logo": () => ({ data: sampleInvoice(), config: withLogo("header-center"), logo: LOGO }),
  "pageFooter on": () => ({ data: sampleInvoice(), config: configWith((c) => { c.pageFooter = true; }) }),
  "the Column headers hidden over a typed Information width of 200": () => ({
    data: sampleInvoice(),
    config: configWith((c) => {
      field(c, "column_header", "col_info").width = 200;
      section(c, "column_header").visible = false;
    }),
  }),
  "every column hidden": () => ({
    data: sampleInvoice(), config: configWith((c) => { for (const f of section(c, "column_header").fields) f.visible = false; }),
  }),
  "the Footer hidden, the page line off": () => ({
    data: sampleInvoice(), config: configWith((c) => { section(c, "footer").visible = false; }),
  }),
  "the Footer hidden, the page line on": () => ({
    data: sampleInvoice(), config: configWith((c) => { section(c, "footer").visible = false; c.pageFooter = true; }),
  }),
  "footer_address hidden": () => ({
    data: sampleInvoice(), config: configWith((c) => { field(c, "footer", "footer_address").visible = false; }),
  }),
  // Frozen at aa826aa8 (main with invoice canvas PR 1 merged) by the whole-branch review's finding 0:
  // the base commit's pdf/invoice.ts built every case below, the earlier cases' bytes unchanged.
  "Liberation Serif at base 10, heading 24, small 8": () => ({
    data: rich(),
    config: configWith((c) => { c.fonts = { family: "Liberation Serif", baseSize: 10, headingSize: 24, smallSize: 8 }; }),
  }),
  "typed labels on the identity, strip, totals and footer fields": () => ({
    data: rich(),
    config: configWith((c) => {
      for (const [sectionKey, key, label] of TYPED_LABELS) field(c, sectionKey, key).label = label;
    }),
  }),
  "the order strip's four fields hidden": () => ({
    data: sampleInvoice(),
    config: configWith((c) => {
      for (const key of ["our_order_no", "your_po", "material", "process"]) field(c, "order_strip", key).visible = false;
    }),
  }),
  "dateFormat YYYY-MM-DD and priceDecimals 4": () => ({
    data: rich(), config: configWith((c) => { c.formats.dateFormat = "YYYY-MM-DD"; c.formats.priceDecimals = 4; }),
  }),
  "thousandsSeparator off": () => ({
    data: rich(), config: configWith((c) => { c.formats.thousandsSeparator = false; }),
  }),
  "setup and minimum charges, a quote source, charge rows, and cert, freight and tax rows": () => ({ data: rich() }),
};

function built(name: string): unknown {
  const { data, config, logo } = CASES[name]();
  return JSON.parse(JSON.stringify(buildInvoiceDefinition(data, config, logo)));
}

describe("the invoice flow's frozen definitions (invoice canvas PR 2, Task 1)", () => {
  it.skipIf(process.env.INVOICE_ORACLE_WRITE !== "1")("writes the oracle (INVOICE_ORACLE_WRITE=1, at the base commit only)", () => {
    const out = Object.fromEntries(Object.keys(CASES).map((name) => [name, built(name)]));
    writeFileSync(ORACLE, `${JSON.stringify(out, null, 1)}\n`);
  });

  const oracle = (): Record<string, unknown> => JSON.parse(readFileSync(ORACLE, "utf8")) as Record<string, unknown>;

  it("holds exactly the matrix's cases (pin)", () => {
    expect(Object.keys(oracle())).toEqual(Object.keys(CASES));
  });

  it.each(Object.keys(CASES))("%s builds the definition it built at the base commit", (name) => {
    expect(built(name)).toEqual(oracle()[name]);
  });

  // Task 7: the canvas seed's `seedIds` option, off, is the oracle. Green on arrival (the option did
  // not exist); it reds when a seed piece, a block's marks or the Remit To wrapper is built without
  // asking `ctx.seed` (the `!ctx.seed` guard dropped from `seedPiece`, say).
  it.each(Object.keys(CASES))("%s with seedIds off builds the definition it built at the base commit", (name) => {
    const { data, config, logo } = CASES[name]();
    expect(JSON.parse(JSON.stringify(buildInvoiceDefinition(data, config, logo, { seedIds: false })))).toEqual(oracle()[name]);
  });
});
