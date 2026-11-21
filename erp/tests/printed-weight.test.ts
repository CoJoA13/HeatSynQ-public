// A printed weight's unit (the weights design's §13.2; owner ruling W15 of 2026-10-09), and the
// measured fit of the cells that take it on the certification, the invoice and the quote (§13.5).
import { describe, expect, it } from "vitest";
import { lb, lbEach } from "@/server/pdf/printed-weight";
import { buildCertDefinition, type CertPdfData } from "@/server/pdf/cert";
import { buildInvoiceDefinition, type InvoicePdfData } from "@/server/pdf/invoice";
import { buildQuoteDefinition, type QuotePdfData } from "@/server/pdf/quote";
import { renderPdf, type RenderableDefinition } from "@/server/pdf/render";
import { textRunsWithY } from "./helpers/pdf";
import { measured } from "./helpers/measured";
import { ORDER_1031 } from "./helpers/weights-examples";

describe("lb and lbEach", () => {
  it.each([
    ["1,280", "1,280 lb"],
    ["-1,280", "-1,280 lb"],
    ["1280", "1280 lb"], // it does not group
    ["0.00", "0.00 lb"], // it does not round or trim
  ])("lb(%j) is %j", (figure, printed) => {
    expect(lb(figure)).toBe(printed);
  });

  it.each([
    ["42.5", "42.5 lb each"],
    ["1,250.5", "1,250.5 lb each"],
  ])("lbEach(%j) is %j", (figure, printed) => {
    expect(lbEach(figure)).toBe(printed);
  });

  it("a blank figure stays blank: no unit prints alone (W15)", () => {
    expect(lb("")).toBe("");
    expect(lbEach("")).toBe("");
  });
});

// -------------------------------------------------------------------------------------------
// Measured on rendered pages (the design's §13.5). The owner was told "one line" for each text
// below. A count of 0 is a text that wrapped or did not print.
// -------------------------------------------------------------------------------------------

/** Page one's printed lines: the runs that share a baseline, joined left to right. */
function printedLines(pdf: Buffer): string[] {
  const byBaseline = new Map<string, { text: string; x: number }[]>();
  for (const run of textRunsWithY(pdf)[0]) {
    const baseline = run.y.toFixed(1);
    byBaseline.set(baseline, [...(byBaseline.get(baseline) ?? []), run]);
  }
  return [...byBaseline.values()].map((runs) => runs.sort((a, b) => a.x - b.x).map((run) => run.text).join(""));
}

const [first, second] = ORDER_1031.lines; // 200 at 6.4 lb is 1,280; 100 at 3.2 lb is 320
const company = { name: "Example Heat Treating - Alabama, LLC", address: "100 Example Way, Anniston AL 36207", phone: "256-555-0100" };

const cert: CertPdfData = {
  company, orderLabel: String(ORDER_1031.number), printDate: "2026-08-03", entryDate: "2026-07-29",
  to: { attn: "", name: "Demo Components Corporation", street: "300 Example Way", city: "Anniston", state: "AL", zip: "36201" },
  poNumber: "DEMO-PO-24115", packingListNo: null, material: "steel",
  parts: [
    { qty: first.qty, partNumber: "BRACKET-A", partName: "Bracket", partDescription: "", pounds: first.weight },
    { qty: second.qty, partNumber: "BRACKET-B", partName: "Bracket", partDescription: "", pounds: second.weight },
  ],
  statement: "We certify.", requirements: [], serialBlocks: [], freeform: "",
  signer: { name: "Alex Example", title: "", company: company.name, signatureDataUri: null },
};

const invoice: InvoicePdfData = {
  company, remitTo: { name: company.name, lines: ["100 Example Way", "Anniston AL 36207"] },
  billTo: ["Demo Foundry - Columbus LLC"], shipTo: ["Demo Foundry - Columbus LLC"],
  title: "Invoice", documentNumber: `7 - ${ORDER_1031.number}`, invoiceDate: "2026-07-29", termsName: "30 days",
  orderNumber: ORDER_1031.number, poNumber: "89499", materialName: "Ductile Iron", processNames: "Austemper",
  parts: [
    { qty: first.qty, partNumber: "BRACKET-A", partName: "Bracket", partDescription: "", eachWeight: first.eachWeight, totalWeight: first.weight },
    { qty: second.qty, partNumber: "BRACKET-B", partName: "Bracket", partDescription: "", eachWeight: second.eachWeight, totalWeight: second.weight },
  ],
  priceRows: [{ description: "Austemper", pricePerLabel: "Each", unitPrice: 6.51, minimumCharge: 600, setupCharge: null, amount: 1953, partIndex: 0 }],
  subtotal: 1953, surchargeRows: [], chargeRows: [], certRow: null, freightRow: null, taxRow: null, total: 1953,
};

const quote: QuotePdfData = {
  company, quoteNumber: 1006, effectiveDate: "2026-06-30", expiryDate: "2026-07-10", termsName: "30 days",
  rfqNumber: "12345", attn: "", customerPhone: "", billTo: ["Demo Tractor Parts"],
  introText: "We are pleased to provide you with the following quotation:",
  lines: [{
    quotedQty: first.qty, quotedUnlimited: false, partNumber: "BRACKET-A", partName: "Bracket", partDescription: "",
    eachWeight: first.eachWeight, totalLbs: first.weight, surcharges: [], material: "",
    prices: [{
      stepName: "Stress Relieve", notes: "", setupCharge: null, unitPrice: 0.055, minimumCharge: null,
      pricePerLabel: "Per lb", pricedPerLb: true, breaks: [], amount: 70.4,
    }],
  }],
  endingStatementText: "", notes: "", liabilityText: "", signer: { name: "Mr. Johnathen Smith", title: "" },
};

describe("the unit fits its cell (measured)", () => {
  it.each<[page: string, definition: RenderableDefinition, texts: string[]]>([
    ["the certification", buildCertDefinition(cert), ["1,280 lb", "320 lb"]],
    ["the invoice", buildInvoiceDefinition(invoice), ["Net weight / Price", "6.40 lb", "1,280.00 lb", "3.20 lb", "320.00 lb"]],
    ["the quote", buildQuoteDefinition(quote), ["Net weight / Price", "6.40 lb", "1,280.00 lb"]],
  ])("%s prints each text whole on one line", async (page, definition, texts) => {
    const lines = printedLines(await renderPdf(definition));
    const linesHolding = Object.fromEntries(texts.map((text) => [text, lines.filter((line) => line.includes(text)).length]));
    measured(`${page}: the printed lines that hold each text`, linesHolding);
    expect(linesHolding).toEqual(Object.fromEntries(texts.map((text) => [text, 1])));
  });
});
