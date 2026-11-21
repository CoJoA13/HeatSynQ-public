// The weights on paper: every hand-written page in every state (the weights design's §13.5, "The
// paper look"). Each case builds one document from figures written out here, renders it with the
// program's renderer, and holds what the page prints: its page count, and runs of whole printed
// lines. No case reads or writes a row but the last, the weighed order's: sheet data written by
// hand has no scale figure to leave out, so that sheet is read from a saved order. A render asks
// the database its name once, as every render does (the practice stamp).
//
// When WEIGHTS_PAPER_PAGES_DIR names a folder, each page is also written there as
// `<document>__<state>.pdf`, for the owner to open. Unset, nothing is written.
//
// WHOLE LINES, never a part of a page's joined text. `printedLines` gives a page as the lines it
// draws, and a case holds a run of them, top to bottom with nothing between. So "1,280" is not
// found inside "1,280 lb", and a row that must not print is held by the line that follows the row
// before it. One exception: the invoice's order strip is four fields on one line (#590), each a
// column of its own, and the page draws them left to right, so its "lines" are its fields.
import { mkdirSync, writeFileSync } from "node:fs";
import { validateContractConfig } from "@/lib/template-contracts/types";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { measured } from "./helpers/measured";
import { pageCount, textRunsWithY } from "./helpers/pdf";
import { storedBefore } from "./helpers/stored-configs";
import { ORDER_1031, ORDER_1032 } from "./helpers/weights-examples";
import { runWithContext } from "@/server/context";
import { createOrder } from "@/server/orders";
import { barcodePng, pngDataUri, renderPdf, renderSheetGroups } from "@/server/pdf/render";
import { buildTravelerDefinitions, collectTravelerData, type TravelerData } from "@/server/traveler";
import { buildShippingTicketDefinitions, type TicketData, type TicketDocType } from "@/server/pdf/shipping-ticket";
import { buildBolDefinition, type BolData, type BolOrderWeights } from "@/server/pdf/bol";
import { buildCertDefinition, type CertPdfData } from "@/server/pdf/cert";
import { buildInvoiceDefinition, type InvoicePdfData } from "@/server/pdf/invoice";
import { buildQuoteDefinition, type QuotePdfData } from "@/server/pdf/quote";
import {
  SHIPPER_DEFAULT_CONFIG, contractFor, normalizeStoredConfig, validateConfig, type TemplateConfig, type TemplateDocTypeString,
} from "@/lib/template-contracts/index";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

// ---- The reader, and the one assertion every page takes ----------------------------------------

type Line = { text: string; baselines: number };

/**
 * Each page's printed lines, in the order the page draws them. pdfkit draws a line word by word and
 * each word keeps the space after it, so a run that ends in no white space ends a line of a cell.
 * A line that wraps comes back whole, with the number of baselines it took. NOT whole: a word
 * broken after a hyphen that a letter follows ("DEMO-" then "PL"), which is why no name in this
 * file holds one. A minus sign before a figure and the hyphen of "1031-1" do not break. Nor whole:
 * a word that fits its column only without the space after it. pdfmake cuts that space off and
 * draws it as a run of its own, so the line ends at the word and the next line begins with the
 * space ("127.5" then " lb", on the ticket whose Tare column has no room).
 */
function printedLines(pdf: Buffer): Line[][] {
  return textRunsWithY(pdf).map((runs) => {
    const lines: Line[] = [];
    let text = "";
    let ys = new Set<number>();
    for (const run of runs) {
      text += run.text;
      ys.add(Math.round(run.y));
      if (/\s$/.test(run.text)) continue;
      lines.push({ text, baselines: ys.size });
      text = "";
      ys = new Set();
    }
    if (text !== "") lines.push({ text: text.trimEnd(), baselines: ys.size });
    return lines;
  });
}

type Expected = {
  pages: number;
  /** Runs of whole printed lines. One page holds each run, top to bottom with nothing between. */
  holds: { page: number; lines: string[] }[];
  /** A printed line and the baselines it takes: one the owner was told wraps or does not, or one a page is made to show. */
  baselines?: Record<string, number>;
  /** A text the rendered bytes hold. The second-font ticket's alone. */
  bytesHold?: string;
};
type Page = Expected & { name: string; render: () => Promise<Buffer> };
const page = (name: string, render: () => Promise<Buffer>, expected: Expected): Page => ({ name, render, ...expected });
/** A one-page document that holds each of these runs. */
const one = (...runs: string[][]): Expected => ({ pages: 1, holds: runs.map((lines) => ({ page: 1, lines })) });

function holdPage(name: string, pdf: Buffer, expected: Expected): void {
  // Written before anything is held, so a page that fails its case can still be opened.
  const dir = process.env.WEIGHTS_PAPER_PAGES_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${name}.pdf`), pdf);
  }
  const pages = pageCount(pdf);
  const printed = printedLines(pdf);
  /** The baselines of each printed line that reads `text`. */
  const baselinesOf = (text: string) => printed.flat().filter((line) => line.text === text).map((line) => line.baselines);
  // Written out when the run asks, for a report, before anything is held.
  measured(name, { pages, baselines: Object.fromEntries(Object.keys(expected.baselines ?? {}).map((text) => [text, baselinesOf(text)])) });
  expect(pages, "pages").toBe(expected.pages);
  for (const held of expected.holds) {
    const drawn = printed[held.page - 1].map((line) => line.text).join("\n");
    expect(`\n${drawn}\n`, `page ${held.page}`).toContain(`\n${held.lines.join("\n")}\n`);
  }
  for (const [text, baselines] of Object.entries(expected.baselines ?? {})) {
    expect(baselinesOf(text), text).toEqual([baselines]);
  }
  if (expected.bytesHold !== undefined) expect(pdf.toString("latin1")).toContain(expected.bytesHold);
}

// ---- Figures -------------------------------------------------------------------------------------
// Order 1031 is the owner's example (tests/helpers/weights-examples.ts): 200 at 6.4 lb and 100 at
// 3.2 lb, in 3 Steel Baskets of 252 pieces at 42.5 lb each. Net 1,600, tare 127.5, gross 1,727.5.
// Order 1032 ships 450 lb with no containers.

const PARTS = [{ number: "DEMO 2001", name: "U Bolt Plate" }, { number: "DEMO 2002", name: "Spring Seat" }];
const COMPANY = { name: "Example Heat Treating", address: "100 Example Way  Anniston  AL  36207", phone: "256 555 0100" };
const CUSTOMER = { name: "Demo Components Corporation", street: "300 Example Way", city: "Anniston", state: "AL", zip: "36201" };
const DOCK = { name: "Example Coating", street: "88 Dock Rd.", city: "Oxford", state: "AL", zip: "36203" };
const BASKET_ROW = ORDER_1031.containers[0];
const LOAD_1 = pngDataUri(await barcodePng("1031-1"));
const LOAD_2 = pngDataUri(await barcodePng("1031-2"));
/** A frozen stored config, read as a print reads one. */
const stored = (docType: TemplateDocTypeString, name: string): TemplateConfig =>
  normalizeStoredConfig(docType, storedBefore(docType, name));
/** A frozen config the registry refuses since owner ruling R-B (2026-11-17, #991), read by the contract's own battery:
 *  the page it would print were it to reach the renderer unvalidated. */
const storedPastTheBudget = (docType: TemplateDocTypeString, name: string): TemplateConfig =>
  validateContractConfig(contractFor(docType), storedBefore(docType, name));

// ---- The traveler --------------------------------------------------------------------------------

function traveler(over: Partial<TravelerData> = {}): TravelerData {
  return {
    orderNumber: ORDER_1031.number, poNumber: "", customerName: CUSTOMER.name, receivedFrom: ["300 Example Way", "Anniston, AL 36201"],
    customerPhone: "", company: COMPANY,
    lines: ORDER_1031.lines.map((l, i) => ({
      qty: l.qty, partNumber: PARTS[i].number, partName: PARTS[i].name, description: "", eachWeight: l.eachWeight, lineWeight: l.weight,
    })),
    orderQty: 300, containers: ORDER_1031.containers.map((c) => ({ ...c })),
    materialName: "Ductile Iron", processName: "Austemper", processId: PARTS[0].number, inspections: [], revisionNumber: 1,
    steps: [{ position: 1, codeName: "Austemper", instruction: "Heat to the specified temperature.", values: [{ label: "Furnace Temp", value: "1650", unit: "°F" }] }],
    sheets: [{ loadNumber: 1, loadQty: 300, loadWeight: 1600, barcodeDataUri: LOAD_1 }],
    ...over,
  };
}
const withRows = (...containers: TravelerData["containers"]): TravelerData => traveler({ containers });
const step = (position: number, codeName: string, instruction: string, values: TravelerData["steps"][number]["values"] = []) =>
  ({ position, codeName, instruction, values });
const reading = (label: string, value: string, unit = "°F") => ({ label, value, unit });

/** The owner's marked-up form in size: 7 steps, 2 lines, 2 container rows, 2 inspections. The
 *  figures of `formSized()` in tests/process-traveler-layout.test.ts, which a test file cannot
 *  import: 8 drop pans at 367 lb and 12 bins at 319 lb under 60,750 lb of parts. */
const formSized = (): TravelerData => traveler({
  lines: [
    { qty: 2500, partNumber: "DEMO 100", partName: "Ring gear", description: "Machined", eachWeight: 13.5, lineWeight: 33750 },
    { qty: 2000, partNumber: "DEMO 101", partName: "Ring gear, rear", description: "Machined", eachWeight: 13.5, lineWeight: 27000 },
  ],
  orderQty: 4500,
  containers: [{ typeName: "Drop pan", count: 8, pieces: null, tareEach: 367 }, { typeName: "Bin", count: 12, pieces: null, tareEach: 319 }],
  inspections: [
    { code: "Hardness", scale: "HBW", min: 269, max: 341, sampleQty: "8", location: "" },
    { code: "Mag particle", scale: null, min: null, max: null, sampleQty: "100%", location: "" },
  ],
  steps: [
    step(1, "Receiving inspection", "Receiving inspection completed when the shop order is issued."),
    step(2, "Racking", "Load parts lying flat\nX rows of X pieces\nXX layers per basket, XXX pieces per load\n\nJig tag: ________   Quantity: ________"),
    step(3, "Pre-heat", "Pre-heat for 1 hour minimum.", [reading("Temperature", "1100")]),
    step(4, "Austemper", "Water flow: 35 mL / 10 s\n\nTime in: ________   Quench in: ________   Quench out: ________", [
      reading("Furnace temp", "1650"), reading("Furnace time", "120", "min"), reading("Carbon potential", "0.85", "%"),
      reading("Quench temp", "690"), reading("Quench time", "120", "min"),
    ]),
    step(5, "Hot wash", "Wash parts to remove residual salt."),
    step(6, "Final inspection", "Inspect parts per customer requirements."),
    step(7, "Pack", "Return parts to the containers they were received in."),
  ],
  sheets: [{ loadNumber: 1, loadQty: 336, loadWeight: 4536, barcodeDataUri: LOAD_1 }],
});

const travelerPdf = (data: TravelerData, config?: TemplateConfig): Promise<Buffer> =>
  renderSheetGroups(buildTravelerDefinitions(data, config));

const LOAD = ["300", "300", "1,600 lb"];
const BASKETS = ["Steel Basket", "252 pcs", "3", "127.5 lb", "42.5 lb each"];
const TOTALS = ["Net 1,600 lb", "Tare 127.5 lb", "Gross 1,727.5 lb"];
const NO_GROSS = ["Net 1,600 lb", "Tare", "Gross"];
const QUANTITY_HEADS = ["Order Quantity", "Load Quantity", "Container", "Containers", "Tare"];
/** Order 1031's part lines and its quantities row, whole, down to the block beneath them. */
const sheet = (row: string[], heading = { net: "Net weight", totals: "Order totals" }): string[] => [
  "Each weight", heading.net, "200", "DEMO 2001 / U Bolt Plate", "6.4 lb", "1,280 lb", "100", "DEMO 2002 / Spring Seat", "3.2 lb", "320 lb",
  ...QUANTITY_HEADS, heading.totals, ...row, "Process:",
];

// ---- The shipping ticket -------------------------------------------------------------------------

const RECEIVED_BY = `Received By: ${"_".repeat(23)}`;
const ticketLines = (rows: { qty: number; weight: number }[]): TicketData["lines"] => rows.map((l, i) => ({
  qty: l.qty, partNumber: PARTS[i].number, partName: PARTS[i].name, partDescription: "", pounds: l.weight,
}));
const ticketBaskets = (tareEach: number | null): TicketData["containers"] =>
  [{ typeName: BASKET_ROW.typeName, count: BASKET_ROW.count, customerContainerId: "CC 1", tareEach }];
const TWICE = [...ticketBaskets(42.5), ...ticketBaskets(42.5)];

function ticket(over: Partial<TicketData> = {}): TicketData {
  return {
    company: { name: COMPANY.name, address: "1201 Front St", phone: COMPANY.phone, liabilityText: "FIRST LIABILITY PARAGRAPH.\n\nSECOND LIABILITY PARAGRAPH." },
    soldTo: { code: "9054", attn: "", ...CUSTOMER }, shipTo: { code: "", attn: "", ...DOCK },
    orderLabel: "1031-1", orderNumber: ORDER_1031.number, shipDate: "2026-10-11",
    poNumber: "PO 24115", packingListNo: 2001, customerJobNo: "JOB 9", route: "South", carrierName: "Customer",
    lines: ticketLines(ORDER_1031.lines), containers: ticketBaskets(BASKET_ROW.tareEach), serials: [], shippedComplete: true, totalQty: 300,
    ...over,
  };
}
const ticket1032 = (): TicketData => ticket({
  orderLabel: "1032-1", orderNumber: ORDER_1032.number, containers: [], totalQty: ORDER_1032.lines.reduce((sum, l) => sum + l.qty, 0),
  lines: ORDER_1032.lines.map((l, i) => ({ qty: l.qty, partNumber: `DEMO 300${i + 1}`, partName: "Bracket", partDescription: "", pounds: l.weight })),
});
/** A ticket of `count` part rows of three lines each. Row n is 10 + n pieces and 100 + n lb, so
 *  nine rows are 135 pieces and 945 lb. */
const rowsTicket = (count: number, over: Partial<TicketData> = {}): TicketData => {
  const lines = Array.from({ length: count }, (_, i) => ({
    qty: 11 + i, partNumber: `ROW ${i + 1}`, partName: "Three Line Part", partDescription: "Third line", pounds: 101 + i,
  }));
  return ticket({ lines, totalQty: lines.reduce((sum, l) => sum + l.qty, 0), ...over });
};
/** The same with one serial line and two container rows at 42.5 lb each: tare 255.00. */
const longTicket = (count: number): TicketData =>
  rowsTicket(count, { containers: TWICE, serials: [{ serial: "SN 0001", description: "Heat A1" }] });

const ticketPdf = (tickets: TicketData[], docType: TicketDocType = "SHIPPER", config?: TemplateConfig): Promise<Buffer> =>
  renderSheetGroups(buildShippingTicketDefinitions(tickets, docType, config));

const HEADS = ["Container Type", "Containers", "Tare", "Cust Cont Id"];
const TICKET_BASKETS = ["Steel Basket", "3", "127.5 lb", "42.5 lb each", "CC 1"];
const LINES_1031 = ["200", "DEMO 2001", "U Bolt Plate", "1,280 lb", "100", "DEMO 2002", "Spring Seat", "320 lb"];
const NET_ROW = ["Net weight:", "1,600.00 lb"];
const GROSS_ROWS = [...NET_ROW, "Tare:", "127.50 lb", "Gross weight:", "1,727.50 lb"];
/** A ticket's part lines under their weight heading and its container table, down to the liability text. */
const upper = (containers: string[], lines = LINES_1031, heading = "Net weight"): string[] =>
  [heading, ...lines, ...HEADS, ...HEADS, ...containers, "FIRST LIABILITY PARAGRAPH."];
/** A ticket's totals and its strip: nothing between them, and nothing between the strip's net and its signature rule. */
const lower = (qty: string, totals: string[], net: string, complete = true): string[] => [
  ...(complete ? ["Shipped Complete"] : []), "Quantity Shipped:", qty, ...totals,
  "Order No.: 1031", ...(complete ? ["Shipped Complete"] : []), "Quantity Shipped:", `${qty}.00`, "Net weight:", net, RECEIVED_BY,
];
/** The last of a `rowsTicket`'s part rows, the container table and what prints under it, down to the liability text. */
const tail = (count: number, under: string[]): string[] => [
  String(10 + count), `ROW ${count}`, "Three Line Part", "Third line", `${100 + count} lb`, ...HEADS, ...HEADS, ...under, "FIRST LIABILITY PARAGRAPH.",
];
const TWO_ROWS_AND_SERIAL = [...TICKET_BASKETS, ...TICKET_BASKETS, "Serial Numbers:", "SN 0001 — Heat A1"];
/** A `longTicket`'s totals and strip as `lower` gives them. */
const longLower = (qty: string, net: string, gross: string): string[] =>
  lower(qty, ["Net weight:", net, "Tare:", "255.00 lb", "Gross weight:", gross], net);
/** A run of `lower` that a page break parts: its first `above` lines are on `firstPage` and the rest on the next. */
const parted = (firstPage: number, above: number, run: string[]): Expected["holds"] =>
  [{ page: firstPage, lines: run.slice(0, above) }, { page: firstPage + 1, lines: run.slice(above) }];

// ---- The bill of lading --------------------------------------------------------------------------

const weights = (order: { lines: { weight: number }[]; containers: { count: number; tareEach: number | null }[] }): BolOrderWeights => ({
  lineWeights: order.lines.map((l) => l.weight), containers: order.containers.map((c) => ({ count: c.count, tareEach: c.tareEach })),
});
const bolPdf = (orders: BolOrderWeights[], over: Partial<BolData> = {}): Promise<Buffer> => renderPdf(buildBolDefinition({
  company: { name: COMPANY.name, address: COMPANY.address }, bolNumber: 3001, proNumber: "", scacCode: "", carrierName: "Customer",
  shipDate: "2026-10-11", consignee: DOCK, orderNumbers: [ORDER_1031.number], poNumbers: ["PO 24115"], packageCount: 3,
  freightDescription: "Manufactured Castings", orders, freightClass: "70", freightTerms: "PREPAID", ...over,
}));
/** The weight cell between its neighbours: the figure, and under it the word that says which. */
const freight = (figure: string, which: string): Expected => one(["Manufactured Castings", figure, which, "70"]);

// ---- The certification, the invoice, the credit memo and the quote ---------------------------------

const CERT: CertPdfData = {
  company: COMPANY, orderLabel: "1031-1", printDate: "2026-10-11", entryDate: "2026-10-01", to: { attn: "", ...CUSTOMER },
  poNumber: "PO 24115", packingListNo: 2001, material: "Ductile Iron",
  parts: ORDER_1031.lines.map((l, i) => ({ qty: l.qty, partNumber: PARTS[i].number, partName: PARTS[i].name, partDescription: "", pounds: l.weight })),
  statement: "We certify that the listed parts were heat treated as follows:",
  requirements: [{
    lineIdentity: "line 1", linePosition: 1, partNumber: PARTS[0].number, partName: PARTS[0].name,
    specification: "Hardness per drawing", scale: "HRC", readings: [28, 30, 29],
  }],
  serialBlocks: [], freeform: "", signer: { name: "Alex Example", title: "", company: COMPANY.name, signatureDataUri: null },
};

const ADDRESS = "100 Example Way\nAnniston AL 36207";
const BILL_TO = [CUSTOMER.name, CUSTOMER.street, "Anniston  AL  36201"];
/** Order 1031's two parts and a light one: 1,000 washers at 0.0049 lb each, 4.9 lb in all. `sign` is -1 for the credit memo. */
const invoice = (title: string, documentNumber: string, sign: 1 | -1): InvoicePdfData => ({
  company: { name: COMPANY.name, address: ADDRESS, phone: COMPANY.phone }, remitTo: { name: COMPANY.name, lines: ADDRESS.split("\n") },
  billTo: BILL_TO, shipTo: BILL_TO, title, documentNumber, invoiceDate: "2026-10-11", termsName: "Net 30",
  orderNumber: ORDER_1031.number, poNumber: "PO 24115", materialName: "Ductile Iron", processNames: "Austemper",
  parts: [
    ...ORDER_1031.lines.map((l, i) => ({
      qty: l.qty, partNumber: PARTS[i].number, partName: PARTS[i].name, partDescription: "", eachWeight: l.eachWeight, totalWeight: l.weight,
    })),
    { qty: 1000, partNumber: "DEMO 2003", partName: "Precision washer", partDescription: "", eachWeight: 0.0049, totalWeight: 4.9 },
  ],
  priceRows: [{ description: "Austemper", pricePerLabel: "Per lb", unitPrice: 0.36, minimumCharge: 100, setupCharge: null, amount: sign * 577.76, partIndex: 0 }],
  subtotal: sign * 577.76, surchargeRows: [], chargeRows: [], certRow: null, freightRow: null, taxRow: null, total: sign * 577.76,
});
/** The column headings, then the order strip, then the parts. The strip's lines are its four fields:
 *  one line on paper (#590), but four columns, which the page draws left to right. That they share
 *  one line is held in tests/invoice-pdf.test.ts, by y, not here. */
const INVOICE_HEADS = [
  "Each weight", "Net weight / Price", "Our Order #: 1031", "Your PO #: PO 24115", "Material: Ductile Iron", "Process: Austemper",
];
const INVOICE_PARTS = [
  "PARTS", "200", "DEMO 2001", "U Bolt Plate", "6.40 lb", "1,280.00 lb", "100", "DEMO 2002", "Spring Seat", "3.20 lb", "320.00 lb",
  "1,000", "DEMO 2003", "Precision washer", "0.00 lb", "4.90 lb", "PRICE",
];

const quoteLine = (i: number, price: QuotePdfData["lines"][number]["prices"][number]): QuotePdfData["lines"][number] => ({
  quotedQty: ORDER_1031.lines[i].qty, quotedUnlimited: false, partNumber: PARTS[i].number, partName: PARTS[i].name, partDescription: "",
  eachWeight: ORDER_1031.lines[i].eachWeight, totalLbs: ORDER_1031.lines[i].weight, material: "Ductile Iron", surcharges: [], prices: [price],
});
const QUOTE: QuotePdfData = {
  company: { name: COMPANY.name, address: ADDRESS, phone: COMPANY.phone }, quoteNumber: 4001, effectiveDate: "2026-10-11",
  expiryDate: "2026-11-10", termsName: "Net 30", rfqNumber: "RFQ 12", attn: "Casey Example", customerPhone: "256 555 0102",
  billTo: [CUSTOMER.name, CUSTOMER.street, "Anniston, AL 36201"], introText: "We are pleased to provide you with the following quotation:",
  lines: [
    quoteLine(0, {
      stepName: "Austemper", notes: "", setupCharge: null, unitPrice: 0.36, minimumCharge: 100,
      pricePerLabel: "Per lb", pricedPerLb: true, breaks: [{ threshold: 1000, price: 0.32 }], amount: 409.6,
    }),
    quoteLine(1, {
      stepName: "Temper", notes: "", setupCharge: null, unitPrice: 1.25, minimumCharge: null,
      pricePerLabel: "Each", pricedPerLb: false, breaks: [{ threshold: 100, price: 1.1 }], amount: 110,
    }),
  ],
  endingStatementText: "", notes: "", liabilityText: "", signer: { name: "Alex Example", title: "Sales" },
};

// ---- The pages -----------------------------------------------------------------------------------

const PAGES: Page[] = [
  page("traveler__with-gross", () => travelerPdf(traveler()), one(sheet([...LOAD, ...BASKETS, ...TOTALS]))),
  page("traveler__no-container-rows", () => travelerPdf(withRows()), one(sheet([...LOAD, ...NO_GROSS]))),
  page("traveler__row-without-tare-each", () => travelerPdf(withRows({ ...BASKET_ROW, tareEach: null })),
    one(sheet([...LOAD, "Steel Basket", "252 pcs", "3", ...NO_GROSS]))),
  page("traveler__tare-each-of-0", () => travelerPdf(withRows({ ...BASKET_ROW, tareEach: 0 })),
    one(sheet([...LOAD, "Steel Basket", "252 pcs", "3", "0 lb", "0 lb each", "Net 1,600 lb", "Tare 0 lb", "Gross 1,600 lb"]))),
  page("traveler__two-loads", () => travelerPdf(traveler({ sheets: [
    { loadNumber: 1, loadQty: 150, loadWeight: 800, barcodeDataUri: LOAD_1 }, { loadNumber: 2, loadQty: 150, loadWeight: 800, barcodeDataUri: LOAD_2 },
  ] })), { pages: 2, holds: [1, 2].map((n) => ({ page: n, lines: sheet(["300", "150", "800 lb", ...BASKETS, ...TOTALS]) })) }),
  page("traveler__two-container-rows", () => travelerPdf(withRows(
    { typeName: "Steel Basket", count: 2, pieces: 168, tareEach: 42.5 }, { typeName: "Steel Basket", count: 1, pieces: 84, tareEach: 42.5 },
  )), one(sheet([...LOAD, "Steel Basket", "168 pcs", "2", "85 lb", "42.5 lb each", ...TOTALS, "Steel Basket", "84 pcs", "1", "42.5 lb", "42.5 lb each"]))),
  page("traveler__two-bare-container-rows", () => travelerPdf(withRows(
    { typeName: "Steel Basket", count: 2, pieces: null, tareEach: null }, { typeName: "Wire Bin", count: 1, pieces: null, tareEach: null },
  )), one(sheet([...LOAD, "Steel Basket", "2", ...NO_GROSS, "Wire Bin", "1"]))),
  page("traveler__form-sized", () => travelerPdf(formSized()), one([
    "Drop pan", "8", "2,936 lb", "367 lb each", "Net 60,750 lb", "Tare 6,764 lb", "Gross 67,514 lb", "Bin", "12", "3,828 lb", "319 lb each", "Process:",
  ])),
  page("traveler__sample-preview", () => travelerPdf(traveler({
    sample: true, orderNumber: 0, orderQty: null, containers: [],
    lines: [{ qty: null, partNumber: PARTS[0].number, partName: PARTS[0].name, description: "", eachWeight: 6.4, lineWeight: null }],
    sheets: [{ loadNumber: null, loadQty: null, loadWeight: null, barcodeDataUri: "" }],
  })), one(["Each weight", "Net weight", "DEMO 2001 / U Bolt Plate", "6.4 lb", ...QUANTITY_HEADS, "Order totals", "Net", "Tare", "Gross", "Process:"])),
  page("traveler__typed-labels", () => travelerPdf(traveler(), stored("TRAVELER", "typed-labels")),
    one(sheet([...LOAD, ...BASKETS, ...TOTALS], { net: "Line Wt", totals: "Gross Wt" }))),
  page("traveler__gross-width-50", () => travelerPdf(traveler(), stored("TRAVELER", "gross-width-50")), {
    ...one(sheet([...LOAD, ...BASKETS, ...TOTALS])), baselines: { "Net 1,600 lb": 1, "Tare 127.5 lb": 1, "Gross 1,727.5 lb": 2 },
  }),

  // The heading's order number is held whole on one line: the hyphen of "1031-1" does not break it.
  page("ticket__with-gross", () => ticketPdf([ticket()]), one(["Order No.: 1031-1"], upper(TICKET_BASKETS), lower("300", GROSS_ROWS, "1,600.00 lb"))),
  page("ticket__no-gross", () => ticketPdf([ticket({ containers: ticketBaskets(null) })]),
    one(upper(["Steel Basket", "3", "CC 1"]), lower("300", NET_ROW, "1,600.00 lb"))),
  page("ticket__mixed-shipment", () => ticketPdf([ticket(), ticket1032()], "MOS_SHIPPER"), { pages: 2, holds: [
    { page: 1, lines: upper(TICKET_BASKETS) }, { page: 1, lines: lower("300", GROSS_ROWS, "1,600.00 lb") },
    { page: 2, lines: [...HEADS, ...HEADS, "FIRST LIABILITY PARAGRAPH."] },
    { page: 2, lines: ["Net weight:", "450.00 lb", "Order No.: 1032"] }, { page: 2, lines: ["Net weight:", "450.00 lb", RECEIVED_BY] },
  ] }),
  page("ticket__reversal", () => ticketPdf([ticket({
    lines: ticketLines(ORDER_1031.lines.map((l) => ({ qty: -l.qty, weight: -l.weight }))), containers: [], shippedComplete: false, totalQty: -300,
  })]), one(
    upper([], ["-200", "DEMO 2001", "U Bolt Plate", "-1,280 lb", "-100", "DEMO 2002", "Spring Seat", "-320 lb"]),
    lower("-300", ["Net weight:", "-1,600.00 lb"], "-1,600.00 lb", false),
  )),
  page("ticket__order-with-no-line", () => ticketPdf([ticket({ lines: [], shippedComplete: false, totalQty: 0 })]), one(
    upper(TICKET_BASKETS, []), lower("0", ["Net weight:", "0.00 lb", "Tare:", "127.50 lb", "Gross weight:", "127.50 lb"], "0.00 lb", false),
  )),
  // Answer 1's first case: the order's second shipment, 125 of the first part, 800 lb, with the
  // order's whole number of containers left in its row.
  page("ticket__second-partial-shipment", () => ticketPdf([ticket({
    orderLabel: "1031-2", lines: ticketLines([{ qty: 125, weight: 800 }]), shippedComplete: false, totalQty: 125,
  })]), one(
    upper(TICKET_BASKETS, ["125", "DEMO 2001", "U Bolt Plate", "800 lb"]),
    lower("125", ["Net weight:", "800.00 lb", "Tare:", "127.50 lb", "Gross weight:", "927.50 lb"], "800.00 lb", false),
  )),
  // Answer 1's second case (issue #493): the order's containers are on the shipment twice.
  page("ticket__containers-added-twice", () => ticketPdf([ticket({ containers: TWICE })]), one(
    upper([...TICKET_BASKETS, ...TICKET_BASKETS]), lower("300", [...NET_ROW, "Tare:", "255.00 lb", "Gross weight:", "1,855.00 lb"], "1,600.00 lb"),
  )),
  // Nine part lines fit one page with one container row and no serial line. The sheet after it
  // adds the serial line and a second container row and prints two pages. The builder puts the
  // second container row in the table's right half, beside the first, so it adds no row: the
  // height the sheet gains is the serial line's. The totals stay on page 1 and the strip moves.
  page("ticket__nine-part-lines-one-container-row-no-serial-line", () => ticketPdf([rowsTicket(9)]), one(
    tail(9, TICKET_BASKETS),
    lower("135", ["Net weight:", "945.00 lb", "Tare:", "127.50 lb", "Gross weight:", "1,072.50 lb"], "945.00 lb"),
  )),
  page("ticket__nine-part-lines-serial-line-two-container-rows", () => ticketPdf([longTicket(9)]), { pages: 2, holds: [
    { page: 1, lines: tail(9, TWO_ROWS_AND_SERIAL) }, ...parted(1, 9, longLower("135", "945.00 lb", "1,200.00 lb")),
  ] }),
  // The Shipped Complete banner and the totals rows are one block, and a page break does not part
  // it. At eleven, twelve and thirteen part lines the whole block prints on page 2: the banner,
  // the four rows and then the strip, with nothing between.
  page("ticket__eleven-part-lines-serial-line-two-container-rows", () => ticketPdf([longTicket(11)]), { pages: 2, holds: [
    { page: 1, lines: tail(11, TWO_ROWS_AND_SERIAL) }, { page: 2, lines: longLower("176", "1,166.00 lb", "1,421.00 lb") },
  ] }),
  page("ticket__twelve-part-lines-serial-line-two-container-rows", () => ticketPdf([longTicket(12)]), { pages: 2, holds: [
    { page: 1, lines: tail(12, TWO_ROWS_AND_SERIAL) }, { page: 2, lines: longLower("198", "1,278.00 lb", "1,533.00 lb") },
  ] }),
  page("ticket__thirteen-part-lines-serial-line-two-container-rows", () => ticketPdf([longTicket(13)]), { pages: 2, holds: [
    { page: 1, lines: tail(13, TWO_ROWS_AND_SERIAL) }, { page: 2, lines: longLower("221", "1,391.00 lb", "1,646.00 lb") },
  ] }),
  // Thirty part lines put the container table on page 2, with its headings over both halves, and
  // the strip on page 3.
  page("ticket__thirty-part-lines-container-table-on-page-two", () => ticketPdf([longTicket(30)]), { pages: 3, holds: [
    { page: 2, lines: tail(30, TWO_ROWS_AND_SERIAL) }, ...parted(2, 9, longLower("765", "3,465.00 lb", "3,720.00 lb")),
  ] }),
  // Typed widths of 110, 110 and 62 leave the Tare column, which alone shares width, no room. The
  // reader gives the tare total's figure and its unit as two lines, "127.5" and " lb" (see
  // `printedLines`), and the tare each whole, on two baselines. The reader reads the page's content
  // stream and not the paper, so it holds a line wherever that line is drawn, past the paper's edge
  // included. This table is drawn past the right margin (tests/shipping-ticket-templates.test.ts
  // holds its rules there for this stored config), and nothing here holds how far. Since owner ruling R-B (#991) the
  // contracts refuse this config (its columns fill the half before their padding), so the page is the belt's.
  page("ticket__tare-alone-shares-width-and-has-no-room", () => ticketPdf([ticket()], "SHIPPER", storedPastTheBudget("SHIPPER", "widths-full")), {
    ...one(upper(["Steel Basket", "3", "127.5", " lb", "42.5 lb each", "CC 1"]), lower("300", GROSS_ROWS, "1,600.00 lb")),
    baselines: { "42.5 lb each": 2 },
  }),
  page("ticket__typed-labels", () => ticketPdf([ticket()], "SHIPPER", stored("SHIPPER", "typed-labels")),
    one(upper(TICKET_BASKETS, LINES_1031, "Lbs Shipped"), lower("300", ["Pounds Shipped:", ...GROSS_ROWS.slice(1)], "1,600.00 lb"))),
  page("ticket__second-font", () => ticketPdf([ticket()], "SHIPPER", validateConfig("SHIPPER", {
    ...SHIPPER_DEFAULT_CONFIG, fonts: { ...SHIPPER_DEFAULT_CONFIG.fonts, family: "Liberation Serif" },
  })), { ...one(upper(TICKET_BASKETS), lower("300", GROSS_ROWS, "1,600.00 lb")), bytesHold: "+LiberationSerif" }),

  page("bill-of-lading__with-gross", () => bolPdf([weights(ORDER_1031)]), freight("1,727.5 lb", "Gross weight")),
  page("bill-of-lading__no-gross", () => bolPdf([{ ...weights(ORDER_1031), containers: [] }]), freight("1,600 lb", "Net weight")),
  page("bill-of-lading__mixed-shipment", () => bolPdf([weights(ORDER_1031), weights(ORDER_1032)], { orderNumbers: [1031, 1032] }),
    freight("2,050 lb", "Net weight")),
  page("bill-of-lading__reversal", () => bolPdf([{ lineWeights: [-1280, -320], containers: [] }], { packageCount: null }),
    freight("-1,600 lb", "Net weight")),
  page("bill-of-lading__second-partial-shipment", () => bolPdf([{ lineWeights: [800], containers: weights(ORDER_1031).containers }]),
    freight("927.5 lb", "Gross weight")),
  page("bill-of-lading__containers-added-twice", () => bolPdf([weights({ lines: ORDER_1031.lines, containers: TWICE })], { packageCount: 6 }),
    freight("1,855 lb", "Gross weight")),
  // 99,999,872.49 lb of parts in the three baskets. The figure and its unit take two lines of the cell.
  page("bill-of-lading__very-large-gross", () => bolPdf([{ lineWeights: [99_999_872.49], containers: weights(ORDER_1031).containers }]),
    { ...freight("99,999,999.99 lb", "Gross weight"), baselines: { "99,999,999.99 lb": 2 } }),

  page("certification__net-weight", () => renderPdf(buildCertDefinition(CERT)), one([
    "Net weight", "200", "DEMO 2001", "U Bolt Plate", "1,280 lb", "100", "DEMO 2002", "Spring Seat", "320 lb", CERT.statement,
  ])),
  page("invoice__with-a-light-part", () => renderPdf(buildInvoiceDefinition(invoice("Invoice", "7 - 1031", 1))),
    one(["Invoice", "Example Heat Treating"], [...INVOICE_HEADS, ...INVOICE_PARTS])),
  page("credit-memo__with-a-light-part", () => renderPdf(buildInvoiceDefinition(invoice("Credit", "1000", -1))),
    one(["Credit", "Example Heat Treating"], [...INVOICE_HEADS, ...INVOICE_PARTS])),
  page("quote__per-lb-and-per-piece-breaks", () => renderPdf(buildQuoteDefinition(QUOTE)), one(
    ["Each weight", "Net weight / Price", "200", "DEMO 2001", "U Bolt Plate", "6.40 lb", "1,280.00 lb", "Material: Ductile Iron"],
    ["1,000 lb or more:  $0.32"],
    ["100", "DEMO 2002", "Spring Seat", "3.20 lb", "320.00 lb", "Material: Ductile Iron"],
    ["100 or more:  $1.10"],
  )),
];
const WEIGHED = "traveler__weighed-order";

describe("the weights on paper: every hand-written page", () => {
  it("names every page the paper look is owed, each once, as <document>__<state>", () => {
    expect([...PAGES.map((p) => p.name), WEIGHED].sort()).toEqual([
      "bill-of-lading__containers-added-twice", "bill-of-lading__mixed-shipment", "bill-of-lading__no-gross",
      "bill-of-lading__reversal", "bill-of-lading__second-partial-shipment", "bill-of-lading__very-large-gross",
      "bill-of-lading__with-gross",
      "certification__net-weight", "credit-memo__with-a-light-part", "invoice__with-a-light-part", "quote__per-lb-and-per-piece-breaks",
      "ticket__containers-added-twice", "ticket__eleven-part-lines-serial-line-two-container-rows", "ticket__mixed-shipment",
      "ticket__nine-part-lines-one-container-row-no-serial-line", "ticket__nine-part-lines-serial-line-two-container-rows",
      "ticket__no-gross", "ticket__order-with-no-line", "ticket__reversal", "ticket__second-font", "ticket__second-partial-shipment",
      "ticket__tare-alone-shares-width-and-has-no-room", "ticket__thirteen-part-lines-serial-line-two-container-rows",
      "ticket__thirty-part-lines-container-table-on-page-two", "ticket__twelve-part-lines-serial-line-two-container-rows",
      "ticket__typed-labels", "ticket__with-gross",
      "traveler__form-sized", "traveler__gross-width-50", "traveler__no-container-rows", "traveler__row-without-tare-each",
      "traveler__sample-preview", "traveler__tare-each-of-0", "traveler__two-bare-container-rows", "traveler__two-container-rows",
      "traveler__two-loads", "traveler__typed-labels", "traveler__weighed-order", "traveler__with-gross",
    ]);
  });

  it.each(PAGES.map((p) => [p.name, p] as const))("%s", async (_name, p) => {
    holdPage(p.name, await p.render(), p);
  });
});

describe("the weighed order's sheet, read from a saved order", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it(`${WEIGHED} prints the calculated figures and no scale figure`, async () => {
    const customer = await prisma.customer.create({ data: { code: "WPP", name: "Weighed Order Co" } });
    const code = await prisma.processStepCode.create({ data: { code: "AUS", name: "Austemper" } });
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "WPP 1", name: "Weighed Part", eachWeight: "6.4000", loadQty: 1000 },
    });
    const revision = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    await prisma.partProcessStep.create({
      data: { revisionId: revision.id, position: 1, codeId: code.id, instruction: "Heat to the specified temperature." },
    });
    const baskets = await prisma.containerType.create({ data: { name: "Steel Basket" } });
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: part.id, qty: 250, weight: "1600.00" }],
      // On the scale the three baskets read 1,750.00 lb. Calculated, 1,600 + 3 × 42.50 is 1,727.50.
      containers: [{ typeId: baskets.id, count: 3, pieces: 250, tareEach: "42.50", scaleGross: "1750.00" }],
    }));
    // The saved row holds a scale figure, and it is not the calculated gross.
    expect(order.containers[0].scaleGross).toBe(1750);

    const data = await asSystem(() => collectTravelerData(order.id));
    holdPage(WEIGHED, await travelerPdf(data), one(["Steel Basket", "250 pcs", "3", "127.5 lb", "42.5 lb each", ...TOTALS, "Process:"]));
  });
});
