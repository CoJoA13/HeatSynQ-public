import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";
import { setSetting } from "@/server/settings";
import {
  createQuote, closeQuote, deleteQuote, listQuotes, printQuote, readQuotePdfData, quotePrintSettings,
} from "@/server/quotes";
import { createSurcharge, setCustomerSurcharge, deleteCustomerSurcharge } from "@/server/surcharges";
import { buildQuoteDefinition, type QuotePdfData } from "@/server/pdf/quote";
import { PRICE_PER } from "@/lib/part-constants";
import { findNodes } from "./helpers/definition-text";
import { QUOTE_DEFAULT_CONFIG, validateConfig, type TemplateConfig } from "@/lib/template-contracts/index";
import { seedLiteral } from "./helpers/stored-configs";
import { renderPdf } from "@/server/pdf/render";
import { getDocument, VOIDED_PRINT } from "@/server/documents";
import type { Customer, User } from "../prisma/generated/prisma/client";

import { POST as printRoute } from "@/app/api/quotes/[id]/print/route";
import { GET as quoteDocumentsRoute } from "@/app/api/quotes/[id]/documents/route";
import { optionsFor } from "@/app/admin/templates/[id]/edit/PreviewPane";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
const postReq = (url: string, cookie?: string) =>
  new Request(url, { method: "POST", headers: cookie ? { cookie } : {} });
const getReq = (url: string, cookie?: string) =>
  new Request(url, { method: "GET", headers: cookie ? { cookie } : {} });

/** Every `text` string anywhere in a document definition, flattened — content pins live on the
 *  DEFINITION, never on rendered bytes (pdfkit writes TTF-subset glyph ids, so a rendered PDF
 *  carries no character text to grep for; the rendered file is pinned STRUCTURALLY instead).
 *  Copied from tests/invoice-pdf.test.ts (copying across test files is this repo's convention).
 *  Functions are simply not traversed (belt-and-braces — the builder is now plain JSON, its footer
 *  retired to the declarative `pageFooterSpec`, so there are none). */
function allText(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) allText(n, out); return out; }
  if (typeof node === "object") {
    for (const value of Object.values(node as Record<string, unknown>)) allText(value, out);
  }
  return out;
}

/** The PDF's own page count, off its `/Type /Pages /Count N` object — the structural pin a fresh
 *  render CAN carry (CLAUDE.md: renderPdf is not byte-deterministic, so fresh renders are never
 *  Buffer.compare'd). Copied from tests/traveler.test.ts. */
function pageCount(pdf: Buffer): number {
  const match = pdf.toString("latin1").match(/\/Type\s*\/Pages[^>]*\/Count\s+(\d+)/);
  if (!match) throw new Error("Could not find a /Type /Pages /Count marker in the rendered PDF");
  return Number(match[1]);
}

// -------------------------------------------------------------------------------------------
// Fixtures — copied in shape from tests/quotes.test.ts / tests/invoice-pdf.test.ts.
// -------------------------------------------------------------------------------------------

let seq = 0;
async function makeCustomer(withTerms = true): Promise<Customer> {
  seq += 1;
  const terms = withTerms
    ? await prisma.terms.create({ data: { name: "Net 30", netDays: 30 } })
    : null;
  return prisma.customer.create({
    data: { code: `QPD${seq}`, name: `Demo Tractor Parts ${seq}`, termsId: terms?.id ?? null },
  });
}

async function makeBillTo(customerId: string, name = "") {
  return prisma.customerAddress.create({
    data: {
      customerId, kind: "BILL_TO", name, street: "700 Demo Drive",
      city: "Chicago", state: "IL", zip: "12345", isDefault: true,
    },
  });
}

async function makeContact(customerId: string) {
  return prisma.customerContact.create({
    data: { customerId, name: "Casey Example", phone: "312.555.0102" },
  });
}

async function makeQuotedBy(title = "V.P. Sales"): Promise<User> {
  seq += 1;
  return prisma.user.create({
    data: { username: `sales${seq}`, displayName: "Mr. Johnathen Smith", passwordHash: "x", title },
  });
}

async function makeStep(name: string) {
  seq += 1;
  return prisma.processStepCode.create({ data: { code: `QS${seq}`, name } });
}

/** Loose payload line for `createQuote` — the service zod-parses `unknown`, so the fixture only
 *  needs a shape TypeScript will pass through. */
type LineOverride = Record<string, unknown>;

/** One quote shaped after the sample: free-text part, qty 100 at 10 lb each, one EACH row
 *  (0.15 / min 100 / setup 2 — the minimum-floor case: 100 × $0.15 = $15 → floor $100 → + $2). */
async function sampleFixture(opts: { lines?: LineOverride[]; title?: string; billToName?: string } = {}) {
  await asSystem(() => setSetting("company_name", "Example Supplier Inc."));
  await asSystem(() => setSetting("company_address", "600 Example Street\nCrystal Lake IL 60014"));
  await asSystem(() => setSetting("company_phone", "312.555.0100"));
  const customer = await makeCustomer();
  const billTo = await makeBillTo(customer.id, opts.billToName ?? "");
  const contact = await makeContact(customer.id);
  const quotedBy = await makeQuotedBy(opts.title ?? "V.P. Sales");
  const step = await makeStep("Bake");
  const lines = opts.lines ?? [{
    partNumberText: "Customer Part ID", partNameText: "Customer part name",
    partDescriptionText: "Description of Part", materialText: "Customer Material",
    eachWeight: "10", quotedQty: 100,
    prices: [{
      processStepCodeId: step.id, setupCharge: "2.00", unitPrice: "0.1500",
      minimumCharge: "100.00", pricePer: "EACH", notes: "Quote Notes",
    }],
  }];
  const quote = await asSystem(() => createQuote({
    customerId: customer.id, contactId: contact.id, rfqNumber: "12345",
    quotedById: quotedBy.id, notes: "Our terms are net 30",
    lines,
  }));
  return { quote, customer, contact, quotedBy, step, billTo };
}

/** A hand-built QuotePdfData carrying the owner sample's demo content, for the pure-builder
 *  assertions (the invoice-pdf sampleData shape). */
function sampleData(overrides: Partial<QuotePdfData> = {}): QuotePdfData {
  return {
    company: { name: "Example Supplier Inc.", address: "600 Example Street\nCrystal Lake IL 60014", phone: "312.555.0100" },
    quoteNumber: 1006,
    effectiveDate: "2018-06-30",
    expiryDate: "2018-07-10",
    termsName: "Net 30",
    rfqNumber: "12345",
    attn: "Casey Example",
    customerPhone: "312.555.0102",
    billTo: ["Example Purchasing Department", "Demo Tractor Parts", "700 Demo Drive", "Chicago, IL 12345"],
    introText: "We are pleased to provide you with the following quotation:",
    lines: [{
      quotedQty: 100, quotedUnlimited: false,
      partNumber: "Customer Part ID", partName: "Customer part name",
      partDescription: "Description of Part",
      eachWeight: 10, totalLbs: 1000, surcharges: [], material: "Customer Material",
      prices: [
        {
          stepName: "Bake", notes: "Quote Notes", setupCharge: 2, unitPrice: 0.15,
          minimumCharge: 100, pricePerLabel: "Each", pricedPerLb: false, breaks: [], amount: 102,
        },
        {
          stepName: "Certification", notes: "", setupCharge: null, unitPrice: 20,
          minimumCharge: null, pricePerLabel: "Lot (flat)", pricedPerLb: false, breaks: [], amount: 20,
        },
      ],
    }],
    endingStatementText: "Ending Statement from Quote Control",
    notes: "Our terms are net 30",
    liabilityText: "You can add a limited Liability Statement here.",
    signer: { name: "Mr. Johnathen Smith", title: "V.P. Sales" },
    ...overrides,
  };
}

/** The default quote config with one `lines` field hidden and/or relabelled. */
function linesConfig(edit: Record<string, { visible?: boolean; label?: string }>): TemplateConfig {
  const c = structuredClone(QUOTE_DEFAULT_CONFIG);
  const lines = c.sections.find((s) => s.key === "lines")!;
  for (const [key, e] of Object.entries(edit)) Object.assign(lines.fields.find((f) => f.key === key)!, e);
  return c;
}

const SURCHARGES = [
  { name: "EnergySur", rateText: "4%", amount: 4.08 },
  { name: "Handling", rateText: null, amount: 75 },
];
function surchargeData(surcharges: QuotePdfData["lines"][number]["surcharges"] = SURCHARGES): QuotePdfData {
  const d = sampleData();
  d.lines[0] = { ...d.lines[0], surcharges };
  return d;
}

// -------------------------------------------------------------------------------------------
// The builder — pure (data + config in, plain-JSON definition out), built to
// docs/samples/Quote_Sample_Form.jpeg (spec §6). Since Task 14 it is a config-consumer and JOINS
// the JSON-round-trip purity test its siblings had: the Phase 6 footer callback retired to the
// declarative `pageFooterSpec { kind: "pageNofM", label: "Page:" }`. Config-driven assertions live
// in tests/quote-templates.test.ts; these pin the DEFAULT config reproduces today's paper exactly.
// -------------------------------------------------------------------------------------------

describe("buildQuoteDefinition — surcharge estimate rows (#948)", () => {
  it("prints each surcharge row after the line's last price row", () => {
    const t = allText(buildQuoteDefinition(surchargeData()));
    expect(t).toContain("EnergySur 4% (estimate):");
    expect(t).toContain("$4.08");
    expect(t).toContain("Handling (estimate):");
    expect(t).toContain("$75.00");
    // The last price row is Certification ($20.00 / "Price per Lot (flat):").
    expect(t.indexOf("EnergySur 4% (estimate):")).toBeGreaterThan(t.findLastIndex((x) => x.startsWith("Price per Lot (flat):")));
    expect(t.indexOf("EnergySur 4% (estimate):")).toBeGreaterThan(t.lastIndexOf("$20.00"));
  });

  it("the estimate prints at font size 9, not bold, its amount right-aligned", () => {
    const def = buildQuoteDefinition(surchargeData());
    const [label] = findNodes(def, (n) => n.text === "EnergySur 4% (estimate):");
    const [amount] = findNodes(def, (n) => n.text === "$4.08");
    expect(label.fontSize).toBe(9);
    expect(label.bold).toBeUndefined();
    expect(amount.fontSize).toBe(9);
    expect(amount.bold).toBeUndefined();
    expect(amount.alignment).toBe("right");
  });

  it("a row with no figure has no colon and a blank amount", () => {
    const def = buildQuoteDefinition(surchargeData([{ name: "EnergySur", rateText: "4%", amount: null }]));
    const t = allText(def);
    expect(t).toContain("EnergySur 4% (estimate)");
    expect(t).not.toContain("EnergySur 4% (estimate):");
    const [row] = findNodes(def, (n) => Array.isArray(n.columns) && (n.columns as { text?: string }[]).some((c) => c.text === "EnergySur 4% (estimate)"));
    const amount = (row.columns as { text?: string; alignment?: string }[]).find((c) => c.alignment === "right");
    expect(amount?.text).toBe("");
  });

  it("two lines, two surcharges each: rows sit under their own line, in order", () => {
    const d = sampleData();
    const line1 = { ...d.lines[0], surcharges: [
      { name: "Alpha", rateText: "5%", amount: 11.11 },
      { name: "Beta", rateText: "6%", amount: 22.22 },
    ] };
    const line2 = {
      ...d.lines[0], partNumber: "Second Part ID",
      prices: [{ ...d.lines[0].prices[0], stepName: "Anneal", amount: 333.33 }],
      surcharges: [
        { name: "Alpha", rateText: "5%", amount: 44.44 },
        { name: "Beta", rateText: "6%", amount: 55.55 },
      ],
    };
    d.lines = [line1, line2];
    const t = allText(buildQuoteDefinition(d));
    const at = (x: string, from = 0) => { const i = t.indexOf(x, from); expect(i).toBeGreaterThanOrEqual(0); return i; };
    const l1Price = t.lastIndexOf("$20.00", at("Second Part ID"));
    const a1 = at("$11.11");
    const b1 = at("$22.22");
    const id2 = at("Second Part ID");
    const p2 = at("$333.33");
    const a2 = at("$44.44");
    const b2 = at("$55.55");
    expect(l1Price).toBeLessThan(a1);
    expect(a1).toBeLessThan(b1);
    expect(b1).toBeLessThan(id2);
    expect(id2).toBeLessThan(p2);
    expect(p2).toBeLessThan(a2);
    expect(a2).toBeLessThan(b2);
  });

  it("hiding the field prints no row", () => {
    const t = allText(buildQuoteDefinition(surchargeData(), linesConfig({ surcharge_estimate: { visible: false } }))).join(" ");
    expect(t).not.toContain("EnergySur");
    expect(t).not.toContain("Handling");
    expect(t).not.toContain("$4.08");
  });

  it("the PRICE heading's visibility has no effect on the rows", () => {
    const t = allText(buildQuoteDefinition(surchargeData(), linesConfig({ price_heading: { visible: false } })));
    expect(t).toContain("EnergySur 4% (estimate):");
  });

  it("hiding the indicative amount blanks the estimate's figure", () => {
    const t = allText(buildQuoteDefinition(surchargeData(), linesConfig({ price_amount: { visible: false } })));
    expect(t).toContain("EnergySur 4% (estimate)");
    expect(t).not.toContain("EnergySur 4% (estimate):");
    expect(t).not.toContain("$4.08");
  });

  it("a relabelled field prints its own label", () => {
    const t = allText(buildQuoteDefinition(surchargeData(), linesConfig({ surcharge_estimate: { label: "(est.)" } })));
    expect(t).toContain("EnergySur 4% (est.):");
  });

  it("a config saved before the field prints the rows", () => {
    const literal = seedLiteral("QUOTE") as TemplateConfig;
    expect(literal.sections.find((s) => s.key === "lines")!.fields.some((f) => f.key === "surcharge_estimate")).toBe(false);
    // Through the real validator, which backfills the field a stored version predates.
    const t = allText(buildQuoteDefinition(surchargeData(), validateConfig("QUOTE", literal)));
    expect(t).toContain("EnergySur 4% (estimate):");
  });
});

describe("buildQuoteDefinition", () => {
  it("is a pure builder — the definition survives a JSON round trip", () => {
    const def = buildQuoteDefinition(sampleData());
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
  });

  it("prints the sample's header, right block, Attn block and intro line", () => {
    const text = allText(buildQuoteDefinition(sampleData())).join(" ");
    expect(text).toContain("Quotation");
    expect(text).toContain("Example Supplier Inc.");
    expect(text).toContain("600 Example Street");
    expect(text).toContain("Crystal Lake IL 60014");
    expect(text).toContain("Quotation Number: ");
    expect(text).toContain("1006");
    expect(text).toContain("Phone: ");                       // the company's own (settings)
    expect(text).toContain("312.555.0100");
    expect(text).toContain("Effective: ");
    expect(text).toContain("06/30/2018");
    expect(text).toContain("Expires On: ");
    expect(text).toContain("07/10/2018");
    expect(text).toContain("Terms: ");
    expect(text).toContain("Net 30");
    expect(text).toContain("Your R.F.Q. Number: ");
    expect(text).toContain("12345");
    expect(text).toContain("Your Phone No.: ");              // the contact's, where the model has one
    expect(text).toContain("312.555.0102");
    expect(text).toContain("Attn: ");
    expect(text).toContain("Casey Example");
    expect(text).toContain("Demo Tractor Parts");
    expect(text).toContain("700 Demo Drive");
    expect(text).toContain("Chicago, IL 12345");
    expect(text).toContain("We are pleased to provide you with the following quotation:");
  });

  it("prints the line grid and the price section in 5A vocabulary with engine amounts", () => {
    const text = allText(buildQuoteDefinition(sampleData())).join(" ");
    expect(text).toContain("Quantity");
    expect(text).toContain("Part No. / Description / Pricing Information");
    expect(text).toContain("Each weight");
    // A whole cell, old wording or new: the fourth heading of the strip.
    expect(allText(buildQuoteDefinition(sampleData())).filter((t) => t === "Net weight / Price" || t === "Total Lbs / Price"))
      .toEqual(["Net weight / Price"]);
    expect(text).toContain("100");
    expect(text).toContain("Customer Part ID");
    expect(text).toContain("Customer part name");
    expect(text).toContain("Description of Part");
    expect(findNodes(buildQuoteDefinition(sampleData()), (n) => n.text === "10.00 lb")).toHaveLength(1); // each weight, the cell whole
    expect(findNodes(buildQuoteDefinition(sampleData()), (n) => n.text === "1,000.00 lb")).toHaveLength(1); // net weight = qty × each weight, the cell whole
    expect(text).toContain("Material: ");
    expect(text).toContain("Customer Material");
    expect(text).toContain("PRICE");
    expect(text).toContain("Bake");
    expect(text).toContain("Quote Notes");
    // 5A vocabulary in the sample's own arrangement (spec §6) — NOT the sample's VS labels
    // ("Furnace Charge" / "Flat rate charge of").
    expect(text).toContain("Setup charge:");
    expect(text).toContain("$2.00");
    expect(text).toContain("Plus");
    expect(text).toContain("Price per Each:");
    expect(text).toContain("$0.15");
    expect(text).toContain("Or");
    expect(text).toContain("Minimum charge:");
    expect(text).toContain("$100.00");
    expect(text).toContain("$102.00");                        // engine amount: max(15, 100) + 2
    expect(text).toContain("Certification");
    expect(text).toContain("Price per Lot (flat):");
    expect(text).toContain("$20.00");
    expect(text).not.toContain("Furnace Charge");
  });

  it("prints the footer blocks: ending statement, notes, liability text and the signature", () => {
    const text = allText(buildQuoteDefinition(sampleData())).join(" ");
    expect(text).toContain("Ending Statement from Quote Control");
    expect(text).toContain("Our terms are net 30");
    expect(text).toContain("You can add a limited Liability Statement here.");
    expect(text).toContain("Mr. Johnathen Smith");
    expect(text).toContain("V.P. Sales");
  });

  it("declares 'Page: N of M' via pageFooterSpec (label 'Page:'), the retired footer callback gone", () => {
    const def = buildQuoteDefinition(sampleData());
    // The Phase 6 hand-written footer callback is retired; render.ts's pageNofM callback reproduces
    // the exact "Page: N of M" line from this spec (label "Page:"). The multi-page render proof —
    // the printed line stays byte-identical — is in tests/quote-templates.test.ts.
    expect(def.footer).toBeUndefined();
    expect(def.pageFooterSpec).toEqual({ kind: "pageNofM", label: "Page:" });
  });

  it("prints 'Unlimited' for an unlimited line and omits its amounts", () => {
    const data = sampleData();
    data.lines[0] = {
      ...data.lines[0], quotedQty: null, quotedUnlimited: true, totalLbs: null,
      prices: data.lines[0].prices.map((p) => ({ ...p, amount: null })),
    };
    const text = allText(buildQuoteDefinition(data)).join(" ");
    expect(text).toContain("Unlimited");
    // The engine AMOUNT is omitted; the price DETAILS (unit/minimum/setup) still describe the
    // agreement — an unlimited quote still states its prices, it just extends nothing.
    expect(text).not.toContain("$102.00");
    expect(text).toContain("Price per Each:");
  });

  it("lists break rows beneath the price details", () => {
    const data = sampleData();
    data.lines[0].prices[0] = {
      ...data.lines[0].prices[0], breaks: [{ threshold: 500, price: 0.12 }],
    };
    const text = allText(buildQuoteDefinition(data)).join(" ");
    expect(text).toContain("500 or more:");
    expect(text).toContain("$0.12");
  });

  it("suppresses the bare Material label when the value is blank (owner ruling 8, #100 item 9)", () => {
    const data = sampleData();
    data.lines[0] = { ...data.lines[0], material: "" };
    const text = allText(buildQuoteDefinition(data)).join(" ");
    // Value-based suppression, deliberately NOT the cert's keep-the-label rule: an empty value
    // would print a bare "Material:" with nothing after it.
    expect(text).not.toContain("Material: ");
  });

  it("omits blank optional pieces: no attn, no phone, no RFQ value, blank title prints nothing", () => {
    const text = allText(buildQuoteDefinition(sampleData({
      attn: "", customerPhone: "", rfqNumber: "",
      signer: { name: "Mr. Johnathen Smith", title: "" },
      endingStatementText: "", notes: "", liabilityText: "",
    }))).join(" ");
    expect(text).not.toContain("Attn: ");
    expect(text).not.toContain("Your Phone No.: ");
    expect(text).toContain("Your R.F.Q. Number: ");           // label stays, value blank (the cert's label rule)
    expect(text).toContain("Mr. Johnathen Smith");
    expect(text).not.toContain("V.P. Sales");
    expect(text).not.toContain("Ending Statement from Quote Control");
  });

  it("renders to a real single-page PDF (structural pin — never Buffer.compare on fresh renders)", async () => {
    const pdf = await renderPdf(buildQuoteDefinition(sampleData()));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pageCount(pdf)).toBe(1);
  });
});

// -------------------------------------------------------------------------------------------
// The real data path — the collector feeds the builder off the live quote, with indicative
// amounts computed through the REAL engine (priceOrder with a synthetic line — no second
// pricing formula).
// -------------------------------------------------------------------------------------------

describe("readQuotePdfData", () => {
  beforeEach(truncateAll);

  it("assembles company/terms/attn/bill-to/intro and the engine's minimum-floor amount to the cent", async () => {
    const { quote, customer } = await sampleFixture();
    const data = await readQuotePdfData(prisma, quote.id);
    expect(data.company).toEqual({
      name: "Example Supplier Inc.", address: "600 Example Street\nCrystal Lake IL 60014", phone: "312.555.0100",
    });
    expect(data.quoteNumber).toBe(quote.quoteNumber);
    expect(data.termsName).toBe("Net 30");
    expect(data.rfqNumber).toBe("12345");
    expect(data.attn).toBe("Casey Example");
    expect(data.customerPhone).toBe("312.555.0102");
    expect(data.billTo).toEqual([customer.name, "700 Demo Drive", "Chicago, IL 12345"]);
    expect(data.introText).toBe("We are pleased to provide you with the following quotation:");
    expect(data.signer).toEqual({ name: "Mr. Johnathen Smith", title: "V.P. Sales" });
    const [line] = data.lines;
    expect(line.partNumber).toBe("Customer Part ID");
    expect(line.eachWeight).toBe(10);
    expect(line.totalLbs).toBe(1000);
    expect(line.material).toBe("Customer Material");
    // The engine's own math (pricing.ts ruling 13): extended 100 × $0.15 = $15.00, floored to the
    // $100 minimum, setup $2 on TOP — $102.00, to the cent.
    expect(line.prices[0]).toMatchObject({
      stepName: "Bake", notes: "Quote Notes", setupCharge: 2, unitPrice: 0.15,
      minimumCharge: 100, pricePerLabel: "Each", amount: 102,
    });
  });

  // #671 (owner ruling R14): the quote's stack is now every document's rule, stated once in
  // src/server/party-address.ts; this pins the quote still reads it, both halves.
  it("stacks a named bill-to row above the customer's name, and not one equal to it (R14, #671)", async () => {
    const { quote, customer, billTo } = await sampleFixture({ billToName: "Accounts Payable" });
    const stacked = await readQuotePdfData(prisma, quote.id);
    expect(stacked.billTo).toEqual(["Accounts Payable", customer.name, "700 Demo Drive", "Chicago, IL 12345"]);
    await prisma.customerAddress.update({ where: { id: billTo.id }, data: { name: customer.name } });
    const same = await readQuotePdfData(prisma, quote.id);
    expect(same.billTo).toEqual([customer.name, "700 Demo Drive", "Chicago, IL 12345"]);
  });

  it("selects the qualifying break through the engine (the break case, to the cent)", async () => {
    await asSystem(() => setSetting("company_name", "Example Supplier Inc."));
    const customer = await makeCustomer();
    const quotedBy = await makeQuotedBy();
    const step = await makeStep("Bake");
    const quote = await asSystem(() => createQuote({
      customerId: customer.id, quotedById: quotedBy.id,
      lines: [{
        partNumberText: "BRK-1", quotedQty: 500,
        prices: [{
          processStepCodeId: step.id, unitPrice: "0.1500", minimumCharge: "50.00", pricePer: "EACH",
          breaks: [{ threshold: "500.00", price: "0.1200" }],
        }],
      }],
    }));
    const data = await readQuotePdfData(prisma, quote.id);
    // 500 hits the 500-threshold break: 500 × $0.12 = $60.00 (above the $50 floor, no setup).
    expect(data.lines[0].prices[0].amount).toBe(60);
    expect(data.lines[0].prices[0].breaks).toEqual([{ threshold: 500, price: 0.12 }]);
  });

  it("computes an LB row over qty × each-weight, and omits its amount when weight is unknown", async () => {
    await asSystem(() => setSetting("company_name", "Example Supplier Inc."));
    const customer = await makeCustomer();
    const quotedBy = await makeQuotedBy();
    const step = await makeStep("Stress Relieve");
    const withWeight = await asSystem(() => createQuote({
      customerId: customer.id, quotedById: quotedBy.id,
      lines: [{
        partNumberText: "LB-1", quotedQty: 100, eachWeight: "10",
        prices: [{ processStepCodeId: step.id, unitPrice: "0.0550", pricePer: "LB" }],
      }],
    }));
    // 100 pcs × 10 lb = 1,000 lb × $0.055/lb = $55.00.
    const dataW = await readQuotePdfData(prisma, withWeight.id);
    expect(dataW.lines[0].totalLbs).toBe(1000);
    expect(dataW.lines[0].prices[0].amount).toBe(55);

    const noWeight = await asSystem(() => createQuote({
      customerId: customer.id, quotedById: quotedBy.id,
      lines: [{
        partNumberText: "LB-2", quotedQty: 100,
        prices: [{ processStepCodeId: step.id, unitPrice: "0.0550", pricePer: "LB" }],
      }],
    }));
    const dataN = await readQuotePdfData(prisma, noWeight.id);
    expect(dataN.lines[0].totalLbs).toBeNull();
    expect(dataN.lines[0].prices[0].amount).toBeNull();       // LB basis unknown — omitted, never $0
  });

  it("says of each price row whether it is priced per lb: only then is a break's threshold a weight (W15)", async () => {
    await asSystem(() => setSetting("company_name", "Example Supplier Inc."));
    const customer = await makeCustomer();
    const quotedBy = await makeQuotedBy();
    const steps = await Promise.all(PRICE_PER.map((unit) => makeStep(`Priced ${unit}`)));
    const quote = await asSystem(() => createQuote({
      customerId: customer.id, quotedById: quotedBy.id,
      lines: [{
        partNumberText: "UNIT-1", quotedQty: 100, eachWeight: "10",
        prices: PRICE_PER.map((pricePer, i) => ({ processStepCodeId: steps[i].id, unitPrice: "0.0550", pricePer })),
      }],
    }));
    const data = await readQuotePdfData(prisma, quote.id);
    expect(data.lines[0].prices.map((p) => [p.pricePerLabel, p.pricedPerLb])).toEqual([
      ["Each", false], ["Per lb", true], ["Per 100", false], ["Per 1,000", false], ["Lot (flat)", false],
    ]);
  });

  it("rounds the qty × each-weight products to the Decimal(10,4) grain — 3 × 0.1 prints exactly 0.3 (#100 item 5)", async () => {
    await asSystem(() => setSetting("company_name", "Example Supplier Inc."));
    const customer = await makeCustomer();
    const quotedBy = await makeQuotedBy();
    const step = await makeStep("Anneal");
    const quote = await asSystem(() => createQuote({
      customerId: customer.id, quotedById: quotedBy.id,
      lines: [{
        partNumberText: "FLT-1", quotedQty: 3, eachWeight: "0.1",
        prices: [{ processStepCodeId: step.id, unitPrice: "1.0000", pricePer: "LB" }],
      }],
    }));
    const data = await readQuotePdfData(prisma, quote.id);
    // 3 × 0.1 is 0.30000000000000004 in bare float math — the payload must carry the
    // Decimal(10,4)-grain value, exactly.
    expect(data.lines[0].totalLbs).toBe(0.3);
    // The engine's LB basis (shippedWeight) is rounded at the same grain; $1.00/lb over it.
    expect(data.lines[0].prices[0].amount).toBe(0.3);
  });

  it("omits every amount for unlimited and no-qty lines", async () => {
    await asSystem(() => setSetting("company_name", "Example Supplier Inc."));
    const customer = await makeCustomer();
    const quotedBy = await makeQuotedBy();
    const step = await makeStep("Bake");
    const quote = await asSystem(() => createQuote({
      customerId: customer.id, quotedById: quotedBy.id,
      lines: [
        {
          partNumberText: "UNL-1", quotedUnlimited: true, eachWeight: "10",
          prices: [{ processStepCodeId: step.id, unitPrice: "0.1500", pricePer: "EACH" }],
        },
        {
          partNumberText: "NOQ-1", eachWeight: "10",
          prices: [{ processStepCodeId: step.id, unitPrice: "0.1500", pricePer: "EACH" }],
        },
      ],
    }));
    const data = await readQuotePdfData(prisma, quote.id);
    expect(data.lines[0].quotedUnlimited).toBe(true);
    expect(data.lines[0].prices[0].amount).toBeNull();
    expect(data.lines[1].quotedQty).toBeNull();
    expect(data.lines[1].prices[0].amount).toBeNull();
  });

  it("reads a part-linked line's identity live from the part", async () => {
    await asSystem(() => setSetting("company_name", "Example Supplier Inc."));
    const customer = await makeCustomer();
    const quotedBy = await makeQuotedBy();
    const material = await prisma.material.create({ data: { name: "Ductile Iron" } });
    const part = await prisma.part.create({
      data: {
        customerId: customer.id, partNumber: "DEMO-9001-000", name: "EQUALIZER-RR SUSP",
        eachWeight: "21.0000", materialId: material.id,
      },
    });
    const quote = await asSystem(() => createQuote({
      customerId: customer.id, quotedById: quotedBy.id,
      lines: [{ partId: part.id, quotedQty: 144, prices: [] }],
    }));
    const data = await readQuotePdfData(prisma, quote.id);
    expect(data.lines[0]).toMatchObject({
      partNumber: "DEMO-9001-000", partName: "EQUALIZER-RR SUSP",
      material: "Ductile Iron", eachWeight: 21, totalLbs: 3024,
    });
  });

  it("a part with no material and a free-text line with blank materialText print NO bare Material label (ruling 8)", async () => {
    await asSystem(() => setSetting("company_name", "Example Supplier Inc."));
    const customer = await makeCustomer();
    const quotedBy = await makeQuotedBy();
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "NOMAT-1", eachWeight: "1.0000" }, // no materialId
    });
    const quote = await asSystem(() => createQuote({
      customerId: customer.id, quotedById: quotedBy.id,
      lines: [
        { partId: part.id, prices: [] },
        { partNumberText: "FT-NOMAT", prices: [] }, // free-text, no materialText
      ],
    }));
    const data = await readQuotePdfData(prisma, quote.id);
    expect(data.lines.map((l) => l.material)).toEqual(["", ""]);
    const text = allText(buildQuoteDefinition(data)).join(" ");
    expect(text).not.toContain("Material: ");
  });

  it("prints notes but never internal notes, and carries the ending statement text", async () => {
    await asSystem(() => setSetting("company_name", "Example Supplier Inc."));
    await prisma.endingStatement.create({
      data: { name: "Standard", text: "Ending Statement from Quote Control", isDefault: true },
    });
    const customer = await makeCustomer();
    const quotedBy = await makeQuotedBy();
    const quote = await asSystem(() => createQuote({
      customerId: customer.id, quotedById: quotedBy.id,
      notes: "PUBLIC-QUOTE-NOTES", internalNotes: "SECRET-INTERNAL-STRING",
      lines: [{ partNumberText: "N-1", prices: [] }],
    }));
    const data = await readQuotePdfData(prisma, quote.id);
    expect(data.endingStatementText).toBe("Ending Statement from Quote Control");
    expect(data.notes).toBe("PUBLIC-QUOTE-NOTES");
    expect(JSON.stringify(data)).not.toContain("SECRET-INTERNAL-STRING");
    const text = allText(buildQuoteDefinition(data)).join(" ");
    expect(text).toContain("PUBLIC-QUOTE-NOTES");
    expect(text).not.toContain("SECRET-INTERNAL-STRING");
  });

  it("the Preview picker names a quote by the number its paper prints", async () => {
    // PreviewPane's optionsFor restates the quote's printed number (readQuotePdfData's quoteNumber)
    // on the client; this holds the two together. A second quote keeps the find honest.
    const { quote, customer, contact, quotedBy } = await sampleFixture();
    const other = await asSystem(() => createQuote({
      customerId: customer.id, contactId: contact.id, quotedById: quotedBy.id,
      lines: [{ partNumberText: "OTHER-1", prices: [] }],
    }));
    const options = optionsFor("quote", await listQuotes({}));
    const numbers: string[] = [];
    for (const id of [quote.id, other.id]) {
      const option = options.find((o) => o.id === id);
      expect(option).toBeDefined();
      const printed = String((await readQuotePdfData(prisma, id)).quoteNumber);
      expect(option!.recordNumber).toBe(printed);
      numbers.push(printed);
    }
    expect(numbers[0]).not.toBe(numbers[1]);
  });
});

// -------------------------------------------------------------------------------------------
// printQuote — render, archive (kind QUOTE), stored-byte reprints (spec §6; the printInvoice
// precedent, claim + archive in one Serializable transaction).
// -------------------------------------------------------------------------------------------

describe("printQuote", () => {
  beforeEach(truncateAll);

  it("archives kind QUOTE against the quote and reprints the identical stored bytes", async () => {
    const { quote } = await sampleFixture();
    const first = await asSystem(() => printQuote(quote.id));
    const stored = await getDocument(first.documentId);
    expect(stored.kind).toBe("QUOTE");
    expect(stored.quoteId).toBe(quote.id);
    expect(stored.invoiceId).toBeNull();
    expect(Buffer.compare(stored.fileData, first.pdf)).toBe(0);   // STORED bytes — exact by design

    // A reprint is a byte-for-byte reissue of the STORED bytes, never a re-render.
    const reprint = await getDocument(first.documentId);
    expect(Buffer.compare(reprint.fileData, first.pdf)).toBe(0);
  });

  it("keeps no byte in the audit payload", async () => {
    const { quote } = await sampleFixture();
    const printed = await asSystem(() => printQuote(quote.id));
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "storedDocument", entityId: printed.documentId },
    });
    expect(entry).not.toBeNull();
    expect(JSON.stringify(entry!.after)).not.toContain("fileData");
    expect(JSON.stringify(entry!.after)).not.toContain("%PDF");
  });

  it("still prints a CLOSED quote — closing forbids edits, not the paper", async () => {
    const { quote } = await sampleFixture();
    await asSystem(() => closeQuote(quote.id, "won the business"));
    const printed = await asSystem(() => printQuote(quote.id));
    expect(printed.pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("refuses a new print on a deleted quote, keeping stored prints downloadable", async () => {
    const { quote } = await sampleFixture();
    const printed = await asSystem(() => printQuote(quote.id));
    await asSystem(() => deleteQuote(quote.id, "typo"));
    await expect(asSystem(() => printQuote(quote.id))).rejects.toThrow(VOIDED_PRINT);
    await expect(getDocument(printed.documentId)).resolves.toBeTruthy();
  });

  it("404s a quote that does not exist", async () => {
    await expect(asSystem(() => printQuote("nope"))).rejects.toThrow(/not found/i);
  });
});

// -------------------------------------------------------------------------------------------
// POST /api/quotes/[id]/print — gate quotes.view (spec §6; the traveler/cert/invoice print-route
// precedent: printing changes nothing about the quote beyond the audited archive of its own
// output, an explicit POST so "reads never mutate" holds).
// -------------------------------------------------------------------------------------------

describe("POST /api/quotes/[id]/print", () => {
  beforeEach(truncateAll);

  it("401s without a session", async () => {
    const { quote } = await sampleFixture();
    const res = await printRoute(postReq(`http://t/api/quotes/${quote.id}/print`), withParams({ id: quote.id }));
    expect(res.status).toBe(401);
  });

  it("requires quotes.view", async () => {
    const { quote } = await sampleFixture();
    const cookie = await signInWith(["orders.view"]);
    const res = await printRoute(postReq(`http://t/api/quotes/${quote.id}/print`, cookie), withParams({ id: quote.id }));
    expect(res.status).toBe(403);
  });

  it("streams the quote PDF with a friendly filename and archives it", async () => {
    const { quote } = await sampleFixture();
    const cookie = await signInWith(["quotes.view"]);
    const res = await printRoute(postReq(`http://t/api/quotes/${quote.id}/print`, cookie), withParams({ id: quote.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="quote-${quote.quoteNumber}.pdf"`);
    const documentId = res.headers.get("x-document-id")!;
    const stored = await getDocument(documentId);
    expect(stored.kind).toBe("QUOTE");
    expect(Buffer.compare(stored.fileData, Buffer.from(await res.arrayBuffer()))).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------
// GET /api/quotes/[id]/documents — the quote page's own stored-documents list, at EXACTLY the
// path Task 8 wired (its 404→empty-state becomes this live list). Gate quotes.view — the
// certs/invoices documents-route precedent: the only kind `listDocumentsForQuote` can return
// sits behind the SAME `quotes` area this route gates on (AREA_FOR_KIND.QUOTE), so no
// cross-kind union or per-kind filter is needed the way the order hub's route needs one.
// -------------------------------------------------------------------------------------------

describe("GET /api/quotes/[id]/documents", () => {
  beforeEach(truncateAll);

  it("401s without a session", async () => {
    const { quote } = await sampleFixture();
    const res = await quoteDocumentsRoute(
      getReq(`http://t/api/quotes/${quote.id}/documents`), withParams({ id: quote.id }));
    expect(res.status).toBe(401);
  });

  it("requires quotes.view, and lists only this quote's own printed documents", async () => {
    const { quote } = await sampleFixture();
    const printed = await asSystem(() => printQuote(quote.id));

    const wrong = await signInWith(["orders.view"], "quote-docs-wrong-1");
    const forbidden = await quoteDocumentsRoute(
      getReq(`http://t/api/quotes/${quote.id}/documents`, wrong), withParams({ id: quote.id }));
    expect(forbidden.status).toBe(403);

    const viewer = await signInWith(["quotes.view"], "quote-docs-view-1");
    const ok = await quoteDocumentsRoute(
      getReq(`http://t/api/quotes/${quote.id}/documents`, viewer), withParams({ id: quote.id }));
    expect(ok.status).toBe(200);
    const docs = await ok.json() as { id: string; kind: string }[];
    expect(docs).toEqual([expect.objectContaining({ id: printed.documentId, kind: "QUOTE" })]);
  });

  it("404s an unknown quote, and keeps a deleted quote's prints listable", async () => {
    const { quote } = await sampleFixture();
    const printed = await asSystem(() => printQuote(quote.id));
    await asSystem(() => deleteQuote(quote.id, "typo"));
    const viewer = await signInWith(["quotes.view"]);

    const missing = await quoteDocumentsRoute(
      getReq("http://t/api/quotes/nope/documents", viewer), withParams({ id: "nope" }));
    expect(missing.status).toBe(404);

    // The voided-owner rule (spec §5.6): stored paper stays listable and downloadable forever.
    const ok = await quoteDocumentsRoute(
      getReq(`http://t/api/quotes/${quote.id}/documents`, viewer), withParams({ id: quote.id }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual([expect.objectContaining({ id: printed.documentId })]);
  });
});

describe("readQuotePdfData surcharge estimates (#948)", () => {
  beforeEach(truncateAll);

  const sampleLine = (stepId: string, over: LineOverride = {}): LineOverride => ({
    partNumberText: "P", quotedQty: 100, eachWeight: "10",
    prices: [{
      processStepCodeId: stepId, setupCharge: "2.00", unitPrice: "0.1500",
      minimumCharge: "100.00", pricePer: "EACH",
    }],
    ...over,
  });
  const percent = (name: string, rate: string, extra: Record<string, unknown> = {}) =>
    asSystem(() => createSurcharge({ name, kind: "PERCENT", rate, position: 1, scope: "ALL", ...extra }));

  it("estimates an active surcharge under the line", async () => {
    await percent("EnergySur", "0.050000");
    const { quote } = await sampleFixture();
    const data = await readQuotePdfData(prisma, quote.id);
    expect(data.lines[0].surcharges).toEqual([{ name: "EnergySur", rateText: "5%", amount: 5.1 }]);
  });

  it("floors each of two lines at the minimum on its own", async () => {
    await percent("EnergySur", "0.050000", { minimumAmount: "25.00" });
    const step = await makeStep("Bake");
    const { quote } = await sampleFixture({ lines: [sampleLine(step.id), sampleLine(step.id)] });
    const data = await readQuotePdfData(prisma, quote.id);
    expect(data.lines.map((l) => l.surcharges[0].amount)).toEqual([25, 25]);
  });

  it("prints a flat surcharge under every part line it applies to", async () => {
    await asSystem(() => createSurcharge({ name: "FLAT", kind: "FLAT", amount: "75.00", position: 1, scope: "ALL" }));
    const step = await makeStep("Bake");
    const { quote } = await sampleFixture({ lines: [sampleLine(step.id), sampleLine(step.id), sampleLine(step.id)] });
    const data = await readQuotePdfData(prisma, quote.id);
    expect(data.lines.map((l) => l.surcharges)).toEqual(
      [0, 1, 2].map(() => [{ name: "FLAT", rateText: null, amount: 75 }]));
  });

  it("an unpriced row keeps its printed amount and blanks the estimate", async () => {
    await percent("EnergySur", "0.050000");
    const step = await makeStep("Bake");
    const { quote } = await sampleFixture({
      lines: [sampleLine(step.id, { prices: [{ processStepCodeId: step.id, setupCharge: "2.00" }] })],
    });
    const data = await readQuotePdfData(prisma, quote.id);
    expect(data.lines[0].prices[0].amount).toBe(2);
    expect(data.lines[0].surcharges[0]).toEqual({ name: "EnergySur", rateText: "5%", amount: null });
  });

  it("an unlimited line gets the rate and no figure", async () => {
    await percent("EnergySur", "0.050000");
    const step = await makeStep("Bake");
    const { quote } = await sampleFixture({
      lines: [sampleLine(step.id, { quotedQty: undefined, quotedUnlimited: true })],
    });
    const data = await readQuotePdfData(prisma, quote.id);
    expect(data.lines[0].surcharges).toEqual([{ name: "EnergySur", rateText: "5%", amount: null }]);
  });

  it("the blanket opt-out prints no rows", async () => {
    await percent("EnergySur", "0.050000");
    const { quote, customer } = await sampleFixture();
    await prisma.customer.update({ where: { id: customer.id }, data: { surchargeOptOut: true } });
    const data = await readQuotePdfData(prisma, quote.id);
    expect(data.lines[0].surcharges).toEqual([]);
  });

  it("applies a per-surcharge opt-out and a rate override side by side", async () => {
    const { id: a } = await percent("Alpha", "0.050000");
    const { id: b } = await asSystem(() => createSurcharge({
      name: "Beta", kind: "PERCENT", rate: "0.050000", position: 2, scope: "ALL",
    }));
    const { quote, customer } = await sampleFixture();
    await asSystem(() => setCustomerSurcharge(customer.id, a, { optOut: true }));
    await asSystem(() => setCustomerSurcharge(customer.id, b, { rate: "0.100000" }));
    const data = await readQuotePdfData(prisma, quote.id);
    expect(data.lines[0].surcharges).toEqual([{ name: "Beta", rateText: "10%", amount: 10.2 }]);
  });

  it("ignores a deleted override and an inactive surcharge", async () => {
    const { id } = await percent("Alpha", "0.050000");
    await percent("Dormant", "0.200000", { active: false });
    const { quote, customer } = await sampleFixture();
    await asSystem(() => setCustomerSurcharge(customer.id, id, { optOut: true }));
    await asSystem(() => deleteCustomerSurcharge(customer.id, id));
    const data = await readQuotePdfData(prisma, quote.id);
    expect(data.lines[0].surcharges).toEqual([{ name: "Alpha", rateText: "5%", amount: 5.1 }]);
  });

  it("takes Admin's list from the settings it is handed", async () => {
    await percent("EnergySur", "0.050000");
    const { quote } = await sampleFixture();
    const settings = { ...(await quotePrintSettings()), surcharges: [] };
    const data = await readQuotePdfData(prisma, quote.id, settings);
    expect(data.lines[0].surcharges).toEqual([]);
  });
});
