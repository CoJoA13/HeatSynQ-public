import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildQuoteDefinition, type QuotePdfData, type QuotePdfLine } from "@/server/pdf/quote";
import { QUOTE_DEFAULT_CONFIG, validateConfig, type TemplateConfig } from "@/lib/template-contracts/index";
import type { DateFormat, FontFamily, LogoPlacement, PriceDecimals } from "@/lib/template-contracts/types";
import { sampleQuote } from "./helpers/quote-canvas-fixtures";

/**
 * The quotation flow's frozen node trees (since quote canvas PR 2). The goldens of
 * tests/quote-pdf.test.ts and tests/quote-templates.test.ts assert text, never widths, so a refactor of
 * `pdf/quote.ts` that moved a width, a gap or a margin would pass them (the cert ledger's lesson). This
 * file freezes `buildQuoteDefinition`'s JSON for a matrix of data and configs, written once at the base
 * (`QUOTE_ORACLE_WRITE=1`, against a2bda2ad's pdf/quote.ts, which the branch's base holds unchanged), and
 * deep-equals every later build against it: a quotation template whose `layout` is null builds exactly
 * the definition it built before the canvas lane.
 *
 * THIS FILE AND ITS FIXTURE ARE NEVER EDITED after the commit that wrote them (the plan's `ORACLE_SHA`
 * check: `git diff --quiet "$ORACLE_SHA" HEAD -- <both>`). A case a review wants goes in a SECOND oracle
 * file, frozen from `git show a2bda2ad:erp/src/server/pdf/quote.ts` (copied into the tree for the one
 * write, then removed), never into this one. The writer stays in the file; that diff, not the writer's
 * absence, is what catches a rewrite.
 *
 * The enum axes are hand-listed, typed against their unions, never iterated off the exported
 * constants: a member added to `FONT_FAMILIES` (say) must not change this matrix's keys. So are the
 * contract's sections and fields, by section.
 */

const ORACLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "quote-flow-oracle.json");
/** A stand-in logo: the builder places the string it is handed and reads nothing of it. */
const LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
/** `validateConfig`'s font-size bounds (types.ts's private FONT_SIZE_MIN and FONT_SIZE_MAX); the
 *  "(pin)" case below holds these literals to the validator. */
const FONT_MIN = 4;
const FONT_MAX = 72;

const DATES: DateFormat[] = ["M/D/YYYY", "MM/DD/YYYY", "YYYY-MM-DD", "MMMM D, YYYY", "MMM - DD - YYYY"];
const FAMILIES: FontFamily[] = ["Roboto", "Liberation Sans", "Liberation Serif", "Roboto Mono"];
const PLACEMENTS: LogoPlacement[] = ["header-left", "header-center", "header-right"];
const DECIMALS: PriceDecimals[] = [2, 3, 4];
const SECTIONS = ["header", "parties", "intro", "column_header", "lines", "closing", "liability"];
/** The contract's fields, by section, hand-listed. */
const FIELDS: Record<string, string[]> = {
  header: ["title", "company_name", "company_address", "quote_number"],
  parties: ["attn", "bill_to", "company_phone", "effective", "expires", "terms", "rfq_number", "customer_phone"],
  column_header: ["col_qty", "col_info", "col_each_weight", "col_amount"],
  lines: [
    "line_qty", "line_part", "line_each_weight", "line_total_lbs", "material", "price_heading", "step_name",
    "step_notes", "price_amount", "setup_charge", "price_per", "minimum_charge", "breaks", "surcharge_estimate",
  ],
  closing: ["ending_statement", "quote_notes", "signer_name", "signer_title"],
};

/** The default config edited by `edit`, then validated and backfilled as a template stores it (never
 *  with a layout). */
function configWith(edit: (c: TemplateConfig) => void): TemplateConfig {
  const c = structuredClone(QUOTE_DEFAULT_CONFIG);
  edit(c);
  return validateConfig("QUOTE", c);
}
const section = (c: TemplateConfig, key: string) => c.sections.find((s) => s.key === key)!;
const field = (c: TemplateConfig, sectionKey: string, key: string) => section(c, sectionKey).fields.find((f) => f.key === key)!;
/** Moves section `key` to index `to` of the config's order. */
function moveSection(c: TemplateConfig, key: string, to: number): void {
  const [moved] = c.sections.splice(c.sections.findIndex((s) => s.key === key), 1);
  c.sections.splice(to, 0, moved);
}
/** Section `key` placed directly after section `after`. */
function moveAfter(c: TemplateConfig, key: string, after: string): void {
  const [moved] = c.sections.splice(c.sections.findIndex((s) => s.key === key), 1);
  c.sections.splice(c.sections.findIndex((s) => s.key === after) + 1, 0, moved);
}
/** A section's fields reordered to `keys` (the keys it names, in that order, then the rest as they stood). */
function orderFields(c: TemplateConfig, sectionKey: string, keys: string[]): void {
  const s = section(c, sectionKey);
  const named = keys.map((k) => s.fields.find((f) => f.key === k)!);
  s.fields = [...named, ...s.fields.filter((f) => !keys.includes(f.key))];
}
/** The quote's Standard carries `logo: null`, so a logo has no width of its own: 80 pt, the statement
 *  oracle's `withLogo` width, unless `width` says otherwise. */
const withLogo = (placement: LogoPlacement, width = 80, edit: (c: TemplateConfig) => void = () => {}) =>
  configWith((c) => { c.logo = { placement, width }; edit(c); });

const LINE = (): QuotePdfLine => sampleQuote().lines[0];
/** The sample's one line edited by `over`. */
const lineWith = (over: Partial<QuotePdfLine>): QuotePdfData => sampleQuote({ lines: [{ ...LINE(), ...over }] });
/** The sample's one price row edited by `over`. */
const priceWith = (over: Partial<QuotePdfLine["prices"][number]>): QuotePdfData =>
  lineWith({ prices: [{ ...LINE().prices[0], ...over }] });

/** A figure, a rate-only estimate and a second figure under the sample's line. */
const SURCHARGES = [
  { name: "Heat treat surcharge", rateText: "3%", amount: 3.06 },
  { name: "Energy", rateText: "1.5%", amount: null },
  { name: "Fuel", rateText: null, amount: 12.5 },
];
const withSurcharges = (): QuotePdfData => lineWith({ surcharges: SURCHARGES });

/** Every branch at once: two price rows (one EACH with breaks in pieces, one LB with breaks in pounds),
 *  estimates with and without a figure, and a material, so every field hidden in turn has something to
 *  hide. */
const full = (): QuotePdfData => lineWith({
  surcharges: SURCHARGES,
  prices: [
    { ...LINE().prices[0], breaks: [{ threshold: 500, price: 0.12 }, { threshold: 1000, price: 0.1 }] },
    {
      stepName: "Temper", notes: "", setupCharge: null, unitPrice: 0.0555, minimumCharge: 75,
      pricePerLabel: "Per lb", pricedPerLb: true, breaks: [{ threshold: 1000, price: 0.05 }, { threshold: 2500.5, price: 0.0425 }],
      amount: 55.5,
    },
  ],
});

/** Figures that group and a four-decimal price, so the formats reach the paper. */
const figures = (): QuotePdfData => lineWith({
  quotedQty: 1440, eachWeight: 12.5, totalLbs: 18000,
  prices: [{
    ...LINE().prices[0], setupCharge: 1234.5, unitPrice: 1234.0555, minimumCharge: 2500,
    breaks: [{ threshold: 1500, price: 1000.1234 }], amount: 1778713.42,
  }],
});

/** 40 lines: a local copy of the sample's line repeated (this file imports nothing a later task adds). */
const fortyLines = (): QuotePdfData => sampleQuote({ lines: Array.from({ length: 40 }, () => LINE()) });

const withAddress = (address: string): QuotePdfData => sampleQuote({ company: { ...sampleQuote().company, address } });

/** A typed label on every field of the contract. */
const TYPED_LABELS: [string, string, string][] = [
  ["header", "title", "Price Quotation"], ["header", "company_name", "Co"], ["header", "company_address", "Addr"],
  ["header", "quote_number", "Quote No.:"],
  ["parties", "attn", "Attention:"], ["parties", "bill_to", "Bill To"], ["parties", "company_phone", "Tel:"],
  ["parties", "effective", "Valid From:"], ["parties", "expires", "Valid To:"], ["parties", "terms", "Payment:"],
  ["parties", "rfq_number", "Your RFQ:"], ["parties", "customer_phone", "Your Tel:"],
  ["column_header", "col_qty", "Qty"], ["column_header", "col_info", "Part / Pricing"],
  ["column_header", "col_each_weight", "Each"], ["column_header", "col_amount", "Weight / Price"],
  ["lines", "line_qty", "Q"], ["lines", "line_part", "P"], ["lines", "line_each_weight", "E"],
  ["lines", "line_total_lbs", "N"], ["lines", "material", "Alloy:"], ["lines", "price_heading", "PRICING"],
  ["lines", "step_name", "S"], ["lines", "step_notes", "SN"], ["lines", "price_amount", "A"],
  ["lines", "setup_charge", "Setup:"], ["lines", "price_per", "Rate per"], ["lines", "minimum_charge", "Minimum:"],
  ["lines", "breaks", "and up:"], ["lines", "surcharge_estimate", "(est.)"],
  ["closing", "ending_statement", "ES"], ["closing", "quote_notes", "QN"], ["closing", "signer_name", "SG"],
  ["closing", "signer_title", "ST"],
];

type Case = { data: QuotePdfData; config?: TemplateConfig; logo?: string };
const CASES: Record<string, () => Case> = {
  "the Standard": () => ({ data: sampleQuote() }),

  // Each of the seven sections hidden, one at a time.
  ...Object.fromEntries(SECTIONS.map((key) => [`the ${key} section hidden`, (): Case => ({
    data: sampleQuote(), config: configWith((c) => { section(c, key).visible = false; }),
  })])),

  // Reorders. Section order is a plain concatenation (`content.push` over the config's order), so these
  // cover the seams.
  "the Standard's order, set explicitly": () => ({
    data: sampleQuote(), config: configWith((c) => { c.sections = SECTIONS.map((k) => section(c, k)); }),
  }),
  "the liability after the parties": () => ({ data: sampleQuote(), config: configWith((c) => { moveAfter(c, "liability", "parties"); }) }),
  "the header after the parties": () => ({ data: sampleQuote(), config: configWith((c) => { moveAfter(c, "header", "parties"); }) }),
  "the closing first": () => ({ data: sampleQuote(), config: configWith((c) => { moveSection(c, "closing", 0); }) }),

  // The logo at each placement, at 80 pt and wider than its column (200 for a side's 170, 260 for the
  // centre's), and placed with no bytes.
  ...Object.fromEntries(PLACEMENTS.map((placement) => [`a ${placement} logo at 80`, (): Case => ({
    data: sampleQuote(), config: withLogo(placement), logo: LOGO,
  })])),
  ...Object.fromEntries(PLACEMENTS.map((placement) => {
    const width = placement === "header-center" ? 260 : 200;
    return [`a ${placement} logo at ${width}, wider than its column`, (): Case => ({
      data: sampleQuote(), config: withLogo(placement, width), logo: LOGO,
    })];
  })),
  "config.logo set with no logoDataUri (the null logo)": () => ({ data: sampleQuote(), config: withLogo("header-left") }),

  // The page line.
  "pageFooter off": () => ({ data: sampleQuote(), config: configWith((c) => { c.pageFooter = false; }) }),
  "pageFooter on": () => ({ data: sampleQuote(), config: configWith((c) => { c.pageFooter = true; }) }),

  // The lines.
  "quotedUnlimited": () => ({ data: lineWith({ quotedUnlimited: true, quotedQty: null, totalLbs: null }) }),
  "a blank quantity (quotedQty null)": () => ({ data: lineWith({ quotedQty: null, totalLbs: null }) }),
  "breaks in pieces": () => ({ data: priceWith({ breaks: [{ threshold: 500, price: 0.12 }, { threshold: 1000, price: 0.1 }] }) }),
  "breaks on an LB row": () => ({
    data: priceWith({ pricePerLabel: "Per lb", pricedPerLb: true, breaks: [{ threshold: 1000, price: 0.05 }, { threshold: 2500.5, price: 0.0425 }] }),
  }),
  "a blank Material": () => ({ data: lineWith({ material: "" }) }),
  "a line with no price rows": () => ({ data: lineWith({ prices: [], surcharges: [] }) }),
  "a line with no price rows but surcharges in its data": () => ({ data: lineWith({ prices: [], surcharges: SURCHARGES }) }),
  "surcharge estimates present": () => ({ data: withSurcharges() }),
  "surcharge estimates absent": () => ({ data: lineWith({ surcharges: [] }) }),
  "a rate-only surcharge estimate (amount null)": () => ({ data: lineWith({ surcharges: [{ name: "Energy", rateText: "1.5%", amount: null }] }) }),
  "surcharge estimates with surcharge_estimate hidden": () => ({
    data: withSurcharges(), config: configWith((c) => { field(c, "lines", "surcharge_estimate").visible = false; }),
  }),
  "surcharge estimates with price_amount hidden": () => ({
    data: withSurcharges(), config: configWith((c) => { field(c, "lines", "price_amount").visible = false; }),
  }),
  "1 line": () => ({ data: sampleQuote({ lines: [LINE()] }) }),
  "40 lines": () => ({ data: fortyLines() }),
  "40 lines, page line off": () => ({ data: fortyLines(), config: configWith((c) => { c.pageFooter = false; }) }),

  // The company address (filtered and trimmed in the header).
  "a company address with a blank middle line": () => ({ data: withAddress("600 Example Street\n\nCrystal Lake IL 60014") }),
  "a company address whose lines carry leading and trailing spaces": () => ({
    data: withAddress("  600 Example Street  \n\tCrystal Lake IL 60014 "),
  }),
  "a company address with a whitespace-only line": () => ({ data: withAddress("600 Example Street\n   \nCrystal Lake IL 60014") }),
  "a company address of one line alone": () => ({ data: withAddress("600 Example Street, Crystal Lake IL 60014") }),
  "a blank company address": () => ({ data: withAddress("") }),

  // The two texts.
  "typed liability wording": () => ({ data: sampleQuote({ liabilityText: "Liability is limited to the price of the work quoted. No other warranty." }) }),
  "blank liability wording": () => ({ data: sampleQuote({ liabilityText: "" }) }),
  "a blank intro": () => ({ data: sampleQuote({ introText: "" }) }),

  // Formats.
  ...Object.fromEntries(DECIMALS.map((decimals) => [`priceDecimals ${decimals}`, (): Case => ({
    data: figures(), config: configWith((c) => { c.formats.priceDecimals = decimals; }),
  })])),
  "thousandsSeparator off": () => ({ data: figures(), config: configWith((c) => { c.formats.thousandsSeparator = false; }) }),
  ...Object.fromEntries(DATES.map((format) => [`dateFormat ${format}`, (): Case => ({
    data: sampleQuote(), config: configWith((c) => { c.formats.dateFormat = format; }),
  })])),

  // Fonts.
  ...Object.fromEntries(FAMILIES.map((family) => [`font family ${family}`, (): Case => ({
    data: sampleQuote(), config: configWith((c) => { c.fonts.family = family; }),
  })])),
  ...Object.fromEntries((["baseSize", "headingSize", "smallSize"] as const).flatMap((knob) => [FONT_MIN, FONT_MAX].map((size) =>
    [`${knob} ${size}`, (): Case => ({ data: sampleQuote(), config: configWith((c) => { c.fonts[knob] = size; }) })]))),

  // Labels.
  "every field's label typed": () => ({
    data: full(), config: configWith((c) => { for (const [s, k, label] of TYPED_LABELS) field(c, s, k).label = label; }),
  }),
  "the quote_number label typed alone": () => ({
    data: sampleQuote(), config: configWith((c) => { field(c, "header", "quote_number").label = "Our Ref.:"; }),
  }),

  // Every field hidden in turn, over data that gives each something to hide.
  ...Object.fromEntries(Object.entries(FIELDS).flatMap(([s, keys]) => keys.map((key) => [`${s} ${key} hidden`, (): Case => ({
    data: full(), config: configWith((c) => { field(c, s, key).visible = false; }),
  })]))),
  "quote_number hidden under a header-right logo": () => ({
    data: sampleQuote(), config: withLogo("header-right", 80, (c) => { field(c, "header", "quote_number").visible = false; }), logo: LOGO,
  }),
  "title, company_name and company_address hidden under a header-center logo": () => ({
    data: sampleQuote(),
    config: withLogo("header-center", 80, (c) => { for (const k of ["title", "company_name", "company_address"]) field(c, "header", k).visible = false; }),
    logo: LOGO,
  }),
  "every header field hidden, no logo": () => ({
    data: sampleQuote(), config: configWith((c) => { for (const k of FIELDS.header) field(c, "header", k).visible = false; }),
  }),
  "the header's fields reordered": () => ({
    data: sampleQuote(), config: configWith((c) => { orderFields(c, "header", ["company_address", "quote_number", "company_name", "title"]); }),
  }),
  "price_per and minimum_charge hidden (no trailer)": () => ({
    data: full(), config: configWith((c) => { for (const k of ["price_per", "minimum_charge"]) field(c, "lines", k).visible = false; }),
  }),
  "every parties field hidden": () => ({
    data: sampleQuote(), config: configWith((c) => { for (const k of FIELDS.parties) field(c, "parties", k).visible = false; }),
  }),

  // The grid.
  "col_qty 80": () => ({ data: full(), config: configWith((c) => { field(c, "column_header", "col_qty").width = 80; }) }),
  "col_amount 100": () => ({ data: full(), config: configWith((c) => { field(c, "column_header", "col_amount").width = 100; }) }),
  "col_qty 80 and col_amount 100": () => ({
    data: full(),
    config: configWith((c) => { field(c, "column_header", "col_qty").width = 80; field(c, "column_header", "col_amount").width = 100; }),
  }),
  "every column hidden": () => ({
    data: full(), config: configWith((c) => { for (const k of FIELDS.column_header) field(c, "column_header", k).visible = false; }),
  }),
  "the columns reordered": () => ({
    data: full(), config: configWith((c) => { orderFields(c, "column_header", ["col_amount", "col_info", "col_qty", "col_each_weight"]); }),
  }),

  // The parties and the closing.
  "an R14 stacked bill-to": () => ({
    data: sampleQuote({ billTo: ["Accounts Payable", "Demo Tractor Parts", "700 Demo Drive", "Chicago, IL 12345"] }),
  }),
  "a blank contact": () => ({ data: sampleQuote({ attn: "" }) }),
  "blank phones": () => ({ data: sampleQuote({ company: { ...sampleQuote().company, phone: "" }, customerPhone: "" }) }),
  "a blank signer title": () => ({ data: sampleQuote({ signer: { name: "Mr. Johnathen Smith", title: "" } }) }),
  "a blank ending statement": () => ({ data: sampleQuote({ endingStatementText: "" }) }),
  "blank notes": () => ({ data: sampleQuote({ notes: "" }) }),
  "a blank ending statement and blank notes": () => ({ data: sampleQuote({ endingStatementText: "", notes: "" }) }),
  "the parties' fields reordered": () => ({
    data: sampleQuote(),
    config: configWith((c) => { orderFields(c, "parties", ["customer_phone", "rfq_number", "terms", "expires", "effective", "company_phone", "bill_to", "attn"]); }),
  }),
  "the closing's fields reordered": () => ({
    data: sampleQuote(),
    config: configWith((c) => { orderFields(c, "closing", ["quote_notes", "ending_statement", "signer_title", "signer_name"]); }),
  }),
};

function built(name: string): unknown {
  const { data, config, logo } = CASES[name]();
  return JSON.parse(JSON.stringify(buildQuoteDefinition(data, config, logo)));
}

describe("the quotation flow's frozen definitions (since quote canvas PR 2)", () => {
  it.skipIf(process.env.QUOTE_ORACLE_WRITE !== "1")("writes the oracle (QUOTE_ORACLE_WRITE=1, at the base commit only)", () => {
    const out = Object.fromEntries(Object.keys(CASES).map((name) => [name, built(name)]));
    writeFileSync(ORACLE, `${JSON.stringify(out, null, 1)}\n`);
  });

  const oracle = (): Record<string, unknown> => JSON.parse(readFileSync(ORACLE, "utf8")) as Record<string, unknown>;

  it("holds exactly the matrix's cases (pin)", () => {
    expect(Object.keys(oracle())).toEqual(Object.keys(CASES));
  });

  it("the font-size bounds the matrix prints at are the validator's (pin)", () => {
    for (const knob of ["baseSize", "headingSize", "smallSize"] as const) {
      expect(() => configWith((c) => { c.fonts[knob] = FONT_MIN - 0.1; })).toThrow();
      expect(() => configWith((c) => { c.fonts[knob] = FONT_MAX + 0.1; })).toThrow();
      expect(() => configWith((c) => { c.fonts[knob] = FONT_MIN; })).not.toThrow();
      expect(() => configWith((c) => { c.fonts[knob] = FONT_MAX; })).not.toThrow();
    }
  });

  it("the hand-listed sections and fields are the contract's (pin)", () => {
    const c = configWith(() => {});
    expect(c.sections.map((s) => s.key)).toEqual(SECTIONS);
    for (const [s, keys] of Object.entries(FIELDS)) expect(section(c, s).fields.map((f) => f.key)).toEqual(keys);
    for (const s of ["intro", "liability"]) expect(section(c, s).fields).toEqual([]);
  });

  it.each(Object.keys(CASES))("%s builds the definition it built at the base commit", (name) => {
    expect(built(name)).toEqual(oracle()[name]);
  });
});
