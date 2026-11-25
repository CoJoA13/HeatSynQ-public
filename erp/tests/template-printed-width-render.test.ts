/**
 * The printed-width figures of src/lib/template-printed-width.ts against the real print path
 * (#457). That leaf restates render.ts's table layouts in client-safe code, so these hold it to
 * them three ways: each table's builder uses the layout the leaf names for it; the padding and
 * rules render.ts's `TABLE_LAYOUTS` lay out add up to the leaf's figure (for the traveler's
 * inspections, to its outer box's share); and a rendered table at its exact fit, and one point
 * over, ends where the figure says. Pure renders: practice mode is mocked, so nothing reads the
 * database. The traveler's steps table is rendered against its figure in
 * tests/process-traveler-layout.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import assert from "node:assert/strict";

vi.mock("@/server/practice-mode", () => ({ practiceMode: vi.fn().mockResolvedValue(false) }));
import { validateContractConfig } from "@/lib/template-contracts/types";

import {
  BOL_DEFAULT_CONFIG,
  CERT_DEFAULT_CONFIG,
  CONTAINER_TAG_DEFAULT_CONFIG,
  INVOICE_DEFAULT_CONFIG,
  MOS_SHIPPER_DEFAULT_CONFIG,
  QUOTE_DEFAULT_CONFIG,
  SHIPPER_DEFAULT_CONFIG,
  STATEMENT_DEFAULT_CONFIG,
  TEMPLATE_DOC_TYPES,
  TRAVELER_DEFAULT_CONFIG,
  contractFor,
  type TemplateConfig,
  type TemplateDocTypeString,
} from "@/lib/template-contracts";
import {
  COLUMN_TABLE_LAYOUTS, tableOverhead, tablePrintedWidth, type TableLayoutKind,
} from "@/lib/template-printed-width";
import {
  LAYOUT, TABLE_LAYOUTS, barcodePng, pngDataUri, renderPdf, renderSheetGroups, type RenderableDefinition,
} from "@/server/pdf/render";
import { buildTravelerDefinitions, type TravelerData } from "@/server/traveler";
import { buildShippingTicketDefinitions, type TicketData } from "@/server/pdf/shipping-ticket";
import { buildBolDefinition, type BolData } from "@/server/pdf/bol";
import { buildCertDefinition, type CertPdfData } from "@/server/pdf/cert";
import { buildInvoiceDefinition, type InvoicePdfData } from "@/server/pdf/invoice";
import { buildStatementDefinition, type StatementData } from "@/server/pdf/statement";
import { buildQuoteDefinition, type QuotePdfData } from "@/server/pdf/quote";
import { buildContainerTags } from "@/server/pdf/container-tags";
import { strokedLines, textRunsWithY } from "./helpers/pdf";

const LEFT = 24; // LETTER with 24pt margins: the content width is 564, its right edge 588.

// ------------------------------------------------------------------------------------------------
// One record per document, as the template suites write them.
// ------------------------------------------------------------------------------------------------

const BARCODE = pngDataUri(await barcodePng("91246"));

const traveler: TravelerData = {
  orderNumber: 91246, poNumber: "", customerName: "Demo Castings Group", receivedFrom: ["200 Demo Drive", "Anniston, AL 36206"],
  customerPhone: "", company: { name: "Example Heat Treating", address: "1 Furnace Rd", phone: "256-555-0101" },
  lines: [{
    qty: 4500, partNumber: "DEMO-PL-2001", partName: "U Bolt Rear Spr Plate",
    description: "Machined", eachWeight: 13.5, lineWeight: 60750,
  }],
  orderQty: 4500,
  containers: [{ typeName: "Drop Pan", count: 8, pieces: 320, tareEach: 367 }],
  materialName: "Ductile Iron", processId: "DEMO-PL-2001",
  inspections: [{ code: "Hardness", scale: "HBW", min: 269, max: 341, sampleQty: "8", location: "flange OD" }],
  revisionNumber: 1,
  steps: [{
    position: 1, codeName: "Austemper", instruction: "Pre-heat to 1100F.",
    values: [{ label: "Furnace Temp", value: "1650", unit: "°F" }],
  }],
  sheets: [{ loadNumber: 1, loadQty: 336, loadWeight: 4536, barcodeDataUri: BARCODE }],
  processName: "",
};

const ticket: TicketData = {
  company: {
    name: "Example Heat Treating - Alabama,", address: "1201 Front St", phone: "(256) 555-0100",
    liabilityText: "FIRST LIABILITY PARAGRAPH.\n\nSECOND LIABILITY PARAGRAPH.",
  },
  soldTo: { code: "9054", attn: "", name: "Demo Components Corporation", street: "300 Example Way", city: "Anniston", state: "AL", zip: "36201" },
  shipTo: { code: "", attn: "", name: "Example Coating", street: "88 Dock Rd.", city: "Oxford", state: "AL", zip: "36203" },
  orderLabel: "92036-3", orderNumber: 92036, shipDate: "2026-07-29",
  poNumber: "DEMO-PO-24115", packingListNo: 92826, customerJobNo: "JOB-9", route: "South", carrierName: "Customer",
  lines: [{ qty: 192, partNumber: "DEMO01-HT", partName: "Track Shoe, Vehicular", partDescription: "D-001", pounds: 4128 }],
  containers: [
    { typeName: "Bin", count: 3, customerContainerId: "DEMO-COMP-77", tareEach: 42.5 },
    { typeName: "Bin", count: 2, customerContainerId: "DEMO-COMP-78", tareEach: 42.5 },
  ],
  serials: [{ serial: "SN-0001", description: "Heat A1" }],
  shippedComplete: true, totalQty: 192,
};

const bol: BolData = {
  company: { name: "Example Heat Treating - Alabama, LLC", address: "100 Example Way  Anniston  AL  36207" },
  bolNumber: 92795, proNumber: "PRO-4471", scacCode: "GFMC", carrierName: "Demo Foundry Truck", shipDate: "2026-07-06",
  consignee: { name: "Example Coating", street: "400 Demo Drive", city: "Birmingham", state: "AL", zip: "35217" },
  orderNumbers: [91955], poNumbers: ["DEMO-PO-24115"], packageCount: 15, freightDescription: "Manufactured Castings I/S",
  orders: [{ lineWeights: [11415], containers: [] }], freightClass: "70", freightTerms: "PREPAID",
};

const cert: CertPdfData = {
  company: { name: "Example Heat Treating - Alabama, LLC", address: "100 Example Way  Anniston  AL  36207", phone: "256-555-0100" },
  orderLabel: "92036-3", printDate: "2026-08-03", entryDate: "2026-07-29",
  to: { attn: "", name: "Demo Components Corporation", street: "300 Example Way", city: "Anniston", state: "AL", zip: "36201" },
  poNumber: "DEMO-PO-24115", packingListNo: 92826, material: "steel",
  parts: [{ qty: 192, partNumber: "DEMO01-HT", partName: "Track Shoe, Vehicular", partDescription: "D-001", pounds: 4128 }],
  statement: "We certify that the listed Parts / Materials were heat treated as follows:",
  requirements: [{
    lineIdentity: "line-1", linePosition: 1, partNumber: "DEMO01-HT", partName: "Track Shoe, Vehicular",
    specification: "Were heat treated as per P.O. NONE", scale: "HRC", readings: [28, 30, 29],
  }],
  serialBlocks: [], freeform: "",
  signer: { name: "Alex Example", title: "", company: "Example Heat Treating - Alabama, LLC", signatureDataUri: null },
};

const invoice: InvoicePdfData = {
  company: { name: "Example Heat Treating - Alabama, LLC", address: "100 Example Way\nAnniston AL 36207", phone: "256-555-0100" },
  remitTo: { name: "Example Heat Treating - Alabama, LLC", lines: ["100 Example Way", "Anniston AL 36207"] },
  billTo: ["Demo Foundry - Columbus LLC", "500 Example Street", "Columbus  GA  31902-0096"],
  shipTo: ["Demo Foundry - Columbus LLC", "500 Example Street", "Columbus  GA  31902-0096"],
  title: "Invoice", documentNumber: "7 - 92026", invoiceDate: "2026-07-29", termsName: "Net 30",
  orderNumber: 92026, poNumber: "89499", materialName: "Ductile Iron", processNames: "Austemper",
  parts: [{ qty: 144, partNumber: "DEMO-9001-000", partName: "EQUALIZER-RR SUSP", partDescription: "", eachWeight: 21, totalWeight: 3024 }],
  priceRows: [{ description: "Austemper", pricePerLabel: "Each", unitPrice: 6.51, minimumCharge: 600, setupCharge: null, amount: 937.44, partIndex: 0 }],
  subtotal: 937.44, surchargeRows: [], chargeRows: [], certRow: null, freightRow: null, taxRow: null, total: 937.44,
};

const statement: StatementData = {
  asOf: "2026-07-29",
  company: { name: "Example Heat Treating - Alabama, LLC", address: "100 Example Way\nAnniston AL 36207", phone: "256-555-0100" },
  remitTo: { name: "Example Heat Treating - Alabama, LLC", lines: ["100 Example Way", "Anniston AL 36207"] },
  customer: { code: "C100", name: "Demo Foundry - Columbus LLC", billTo: ["Demo Foundry - Columbus LLC", "500 Example Street"] },
  openItems: [{ documentNumber: "7 - 92026", date: "2026-06-29", dueDate: "2026-06-29", kind: "INVOICE", original: 1000, open: 400 }],
  aging: {
    customerId: "cust-1", customerCode: "C100", customerName: "Demo Foundry - Columbus LLC",
    current: 0, d1_30: 0, d31_60: 400, d61_90: 0, d90_plus: 0, unapplied: 200, net: 200,
  },
  financeCharge: null, totalDue: 200,
};

const quote: QuotePdfData = {
  company: { name: "Example Supplier Inc.", address: "600 Example Street\nCrystal Lake IL 60014", phone: "312.555.0100" },
  quoteNumber: 1006, effectiveDate: "2018-06-30", expiryDate: "2018-07-10", termsName: "Net 30", rfqNumber: "12345",
  attn: "Casey Example", customerPhone: "312.555.0102", billTo: ["Demo Tractor Parts", "700 Demo Drive", "Chicago, IL 12345"],
  introText: "We are pleased to provide you with the following quotation:",
  lines: [{
    quotedQty: 100, quotedUnlimited: false, partNumber: "Customer Part ID", partName: "Customer part name",
    partDescription: "Description of Part", eachWeight: 10, totalLbs: 1000, surcharges: [], material: "Customer Material",
    prices: [{
      stepName: "Bake", notes: "Quote Notes", setupCharge: 2, unitPrice: 0.15,
      minimumCharge: 100, pricePerLabel: "Each", pricedPerLb: false, breaks: [], amount: 102,
    }],
  }],
  endingStatementText: "Ending Statement from Quote Control", notes: "Our terms are net 30",
  liabilityText: "You can add a limited Liability Statement here.", signer: { name: "Mr. Johnathen Smith", title: "V.P. Sales" },
};

/** Each document's built-in config, its builder over the record above, and its print path's renderer. */
const DOCS: Record<TemplateDocTypeString, {
  defaults: TemplateConfig; defs: (c: TemplateConfig) => RenderableDefinition[]; sheetGroups: boolean;
}> = {
  TRAVELER: { defaults: TRAVELER_DEFAULT_CONFIG, defs: (c) => buildTravelerDefinitions(traveler, c), sheetGroups: true },
  SHIPPER: { defaults: SHIPPER_DEFAULT_CONFIG, defs: (c) => buildShippingTicketDefinitions([ticket], "SHIPPER", c), sheetGroups: true },
  MOS_SHIPPER: {
    defaults: MOS_SHIPPER_DEFAULT_CONFIG, defs: (c) => buildShippingTicketDefinitions([ticket], "MOS_SHIPPER", c), sheetGroups: true,
  },
  BOL: { defaults: BOL_DEFAULT_CONFIG, defs: (c) => [buildBolDefinition(bol, c)], sheetGroups: false },
  CERT: { defaults: CERT_DEFAULT_CONFIG, defs: (c) => [buildCertDefinition(cert, c)], sheetGroups: false },
  INVOICE: { defaults: INVOICE_DEFAULT_CONFIG, defs: (c) => [buildInvoiceDefinition(invoice, c)], sheetGroups: false },
  STATEMENT: { defaults: STATEMENT_DEFAULT_CONFIG, defs: (c) => [buildStatementDefinition(statement, c)], sheetGroups: false },
  QUOTE: { defaults: QUOTE_DEFAULT_CONFIG, defs: (c) => [buildQuoteDefinition(quote, c)], sheetGroups: false },
  // The tag has no column table (COLUMN_TABLE_LAYOUTS.CONTAINER_TAG is {}), so no case reads its row.
  CONTAINER_TAG: {
    defaults: CONTAINER_TAG_DEFAULT_CONFIG,
    defs: () => [buildContainerTags([{
      orderNumber: "1234", customer: "Acme", poNumber: "5531", parts: ["WIDGET-100 × 100"], containersTotal: "1", received: "10/23/2026, 9:02 AM",
    }])],
    sheetGroups: false,
  },
};

const render = (docType: TemplateDocTypeString, c: TemplateConfig): Promise<Buffer> => {
  const defs = DOCS[docType].defs(c);
  return DOCS[docType].sheetGroups ? renderSheetGroups(defs) : renderPdf(defs[0]);
};

// ------------------------------------------------------------------------------------------------
// The table nodes in a definition.
// ------------------------------------------------------------------------------------------------

type TableNode = { table: { widths: unknown[]; body: unknown[][] }; layout?: unknown };

function tableNodes(node: unknown, out: TableNode[] = []): TableNode[] {
  if (Array.isArray(node)) { for (const child of node) tableNodes(child, out); return out; }
  if (node === null || typeof node !== "object") return out;
  const record = node as Record<string, unknown>;
  const table = record.table as { widths?: unknown } | undefined;
  if (table !== undefined && Array.isArray(table.widths)) out.push(record as unknown as TableNode);
  for (const value of Object.values(record)) tableNodes(value, out);
  return out;
}

/** The widths of `table`'s shown columns in config order, a typed width or the contract's default. */
function shownWidths(docType: TemplateDocTypeString, c: TemplateConfig, table: string): (number | "*")[] {
  const contract = contractFor(docType);
  const out: (number | "*")[] = [];
  for (const s of c.sections) {
    const cs = contract.sections.find((candidate) => candidate.key === s.key);
    if (!s.visible || cs === undefined) continue;
    for (const f of s.fields) {
      const column = cs.fields.find((candidate) => candidate.key === f.key)?.column;
      if (column?.table === table && f.visible) out.push(f.width ?? column.defaultWidth);
    }
  }
  return out;
}

/** The layout name a table of each kind carries; a nested table's is its outer box's. */
const LAYOUT_NAME: Record<TableLayoutKind, keyof typeof TABLE_LAYOUTS> = {
  ruled: LAYOUT.ruled, boxed: LAYOUT.boxed, nested: LAYOUT.boxed, steps: LAYOUT.steps,
};

/** The three callbacks of a layout that set a table's width, as pdfmake calls them. */
type WidthCallbacks = {
  paddingLeft: (i: number, node: unknown) => number;
  paddingRight: (i: number, node: unknown) => number;
  vLineWidth: (i: number, node: unknown) => number;
};

/** What `layout` adds to `node`'s column widths: each column's two paddings and the rule slot at
 *  its left, then the slot at the table's right edge. pdfmake's own sum, read off the layout object. */
function laidOutOverhead(layout: WidthCallbacks, node: TableNode): number {
  const n = node.table.widths.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += layout.paddingLeft(i, node) + layout.paddingRight(i, node) + layout.vLineWidth(i, node);
  return sum + layout.vLineWidth(n, node);
}

describe("each table's builder lays it out as the printed-width leaf says (#457)", () => {
  for (const docType of TEMPLATE_DOC_TYPES) {
    for (const [table, layout] of Object.entries(COLUMN_TABLE_LAYOUTS[docType])) {
      it(`${docType} ${table}: ${layout.kind}${layout.copies > 1 ? ` × ${layout.copies}` : ""}`, () => {
        const c = DOCS[docType].defaults;
        const widths = shownWidths(docType, c, table);
        const nodes = tableNodes(DOCS[docType].defs(c)[0].content);
        const repeated = Array.from({ length: layout.copies }, () => widths).flat();
        const matches = nodes.filter((n) => JSON.stringify(n.table.widths) === JSON.stringify(repeated));
        expect(matches, "exactly one table has these widths").toHaveLength(1);
        let node = matches[0];
        if (layout.kind === "nested") {
          // The columns are a borderless table stacked inside one boxed cell.
          expect(node.layout).toBe("noBorders");
          const inner = node;
          const outers = nodes.filter((n) => {
            const cell = n.table.body[0]?.[0] as { stack?: unknown[] } | undefined;
            return cell?.stack?.includes(inner) === true;
          });
          expect(outers, "exactly one box holds the columns").toHaveLength(1);
          node = outers[0];
          expect(node.table.widths).toEqual(["*"]);
        }
        expect(node.layout).toBe(LAYOUT_NAME[layout.kind]);

        const laidOut = laidOutOverhead(TABLE_LAYOUTS[node.layout as keyof typeof TABLE_LAYOUTS], node);
        const printed = tablePrintedWidth(contractFor(docType), c, table);
        if (printed === null) assert.fail(`${docType} ${table} has no printed width at the built-in config`);
        if (layout.kind === "nested") {
          // The outer box's share. The borderless table's padding is pdfmake's own `noBorders`,
          // which render.ts does not declare: the renders below prove that part.
          expect(laidOut).toBeCloseTo(tableOverhead("boxed", 1), 6);
        } else {
          expect(laidOut).toBeCloseTo(layout.copies * printed.overhead, 6);
        }
      });
    }
  }
});

// ------------------------------------------------------------------------------------------------
// Rendered strokes.
// ------------------------------------------------------------------------------------------------

/** A heading none of the records above prints, typed over the table's first column to find the
 *  table on the page. */
const MARK = "Zeta";

/**
 * Where the marked table's ink ends on the first page. Ruled: the right end of the nearest rule
 * above the mark, the rule over the heading row. Boxed or nested: the rightmost vertical rule that
 * crosses the mark's baseline, plus half the 0.8pt rule. `verticals` counts the vertical rules
 * that cross it.
 */
function inkEnd(pdf: Buffer, kind: "ruled" | "boxed" | "nested"): { end: number; verticals: number } {
  const marks = textRunsWithY(pdf)[0].filter((run) => run.text === MARK);
  if (marks.length === 0) assert.fail(`"${MARK}" is not printed`);
  expect(new Set(marks.map((run) => run.y)).size, "every mark sits on one heading row").toBe(1);
  const y = 792 - marks[0].y; // strokes are top-down
  const strokes = strokedLines(pdf)[0];
  const verticals = strokes.filter((s) => s.x1 === s.x2 && Math.min(s.y1, s.y2) < y && Math.max(s.y1, s.y2) > y);
  if (kind === "ruled") {
    const above = strokes.filter((s) => s.y1 === s.y2 && s.y1 < y);
    const top = Math.max(...above.map((s) => s.y1));
    return { end: Math.max(...above.filter((s) => s.y1 === top).map((s) => Math.max(s.x1, s.x2))), verticals: verticals.length };
  }
  return { end: Math.max(...verticals.map((s) => s.x1)) + 0.4, verticals: verticals.length };
}

/** The bill of lading's sidebar: where its first 160pt rule starts. */
/** Where the bill of lading's sidebar starts: its first row's label, "Signature of consignor", opens at
 *  its left edge, with the row's rule beside it (owner ruling R1, 2026-11-24; the row's rule started
 *  there before). */
function sidebarStart(pdf: Buffer): number {
  const opening = textRunsWithY(pdf)[0].filter((r) => r.text.trim() === "Signature");
  if (opening.length !== 1) assert.fail(`${opening.length} runs open the sidebar's first row`);
  return opening[0].x;
}

type Fit = {
  docType: TemplateDocTypeString; section: string; table: string; kind: "ruled" | "boxed" | "nested";
  /** The column the mark is typed over: the table's first. */
  first: string;
  /** Typed widths that make the declared total exactly the budget less the padding and rules. */
  widths: Record<string, number>;
  /** The column one point wider in the second render. */
  over: string;
  budget: number; copies: number; columns: number;
};

const AGING_72 = Object.fromEntries(
  ["aging_current", "aging_1_30", "aging_31_60", "aging_61_90", "aging_90_plus", "aging_unapplied"].map((key) => [key, 72]));

const FITS: Fit[] = [
  { docType: "TRAVELER", section: "lines", table: "lines", kind: "ruled", first: "line_qty",
    widths: { line_part: 288 }, over: "line_part", budget: 564, copies: 1, columns: 4 },
  { docType: "TRAVELER", section: "quantities", table: "quantities", kind: "ruled", first: "order_qty",
    widths: { container: 106 }, over: "container", budget: 564, copies: 1, columns: 6 },
  { docType: "TRAVELER", section: "inspections", table: "inspections", kind: "nested", first: "inspection_code",
    widths: { inspection_code: 145, inspection_location: 146.4 }, over: "inspection_location", budget: 564, copies: 1, columns: 6 },
  ...(["SHIPPER", "MOS_SHIPPER"] as const).flatMap((docType): Fit[] => [
    { docType, section: "field_strip", table: "field_strip", kind: "boxed", first: "po_number",
      widths: { po_number: 127, packing_list_no: 127.2 }, over: "packing_list_no", budget: 564, copies: 1, columns: 5 },
    { docType, section: "lines", table: "lines", kind: "ruled", first: "line_qty",
      widths: { line_part: 380 }, over: "line_part", budget: 564, copies: 1, columns: 3 },
    { docType, section: "containers", table: "containers", kind: "ruled", first: "container_type",
      widths: { container_count: 54, container_tare: 54 }, over: "container_count", budget: 282, copies: 2, columns: 4 },
  ]),
  { docType: "BOL", section: "freight", table: "freight", kind: "boxed", first: "package_count",
    widths: { freight_description: 153.2 }, over: "freight_description", budget: 386, copies: 1, columns: 5 },
  { docType: "CERT", section: "parts", table: "parts", kind: "ruled", first: "part_qty",
    widths: { part_identity: 380 }, over: "part_identity", budget: 564, copies: 1, columns: 3 },
  ...(["INVOICE", "QUOTE"] as const).map((docType): Fit => ({
    docType, section: "column_header", table: "columns", kind: "boxed", first: "col_qty",
    widths: { col_info: 326 }, over: "col_info", budget: 564, copies: 1, columns: 4,
  })),
  { docType: "STATEMENT", section: "aging", table: "aging", kind: "boxed", first: "aging_current",
    widths: { ...AGING_72, aging_net: 69.6 }, over: "aging_net", budget: 564, copies: 1, columns: 7 },
];

/** The built-in config with `widths` typed in `section` and the mark over `first`, validated. */
function marked(fit: Pick<Fit, "docType" | "section" | "first">, widths: Record<string, number>): TemplateConfig {
  const c = structuredClone(DOCS[fit.docType].defaults);
  const s = c.sections.find((candidate) => candidate.key === fit.section)!;
  const field = (key: string) => {
    const found = s.fields.find((candidate) => candidate.key === key);
    if (found === undefined) assert.fail(`${fit.docType} ${fit.section} has no field ${key}`);
    return found;
  };
  for (const [key, width] of Object.entries(widths)) field(key).width = width;
  field(fit.first).label = MARK;
  // The contract's own battery: one point over is refused by the registry since owner ruling R-B (2026-11-17, #991),
  // and printed here as a config that reaches the renderer unvalidated would print.
  return validateContractConfig(contractFor(fit.docType), c);
}

describe("a table at its exact fit ends at its budget's edge, and one point wider one point past it (#457)", () => {
  it("renders every column table the leaf names but the traveler's steps table, each once", () => {
    const named = Object.entries(COLUMN_TABLE_LAYOUTS).flatMap(([docType, tables]) =>
      Object.entries(tables).filter(([, layout]) => layout.kind !== "steps").map(([table]) => `${docType} ${table}`));
    const rendered = FITS.map((fit) => `${fit.docType} ${fit.table}`);
    expect(new Set(rendered)).toEqual(new Set(named));
    expect(rendered).toHaveLength(named.length);
  });

  for (const fit of FITS) {
    it(`${fit.docType} ${fit.table}`, async () => {
      const contract = contractFor(fit.docType);
      const edge = LEFT + fit.copies * fit.budget;
      const runs = [
        { widths: fit.widths, past: 0 },
        { widths: { ...fit.widths, [fit.over]: fit.widths[fit.over] + 1 }, past: 1 },
      ];
      for (const { widths, past } of runs) {
        const c = marked(fit, widths);
        const figure = tablePrintedWidth(contract, c, fit.table);
        if (figure === null) assert.fail(`${fit.docType} ${fit.table} has no printed width`);
        expect(figure.flexible).toBe(false);
        expect(figure.budget).toBe(fit.budget);
        expect(figure.copies).toBe(fit.copies);
        const ink = inkEnd(await render(fit.docType, c), fit.kind);
        expect(ink.end, `${past}pt over: the leaf's figure`).toBeCloseTo(LEFT + figure.copies * figure.printed, 2);
        expect(ink.end, `${past}pt over: the budget's edge`).toBeCloseTo(edge + fit.copies * past, 2);
        if (fit.kind === "boxed") expect(ink.verticals, "a rule at every column edge").toBe(fit.columns + 1);
      }
    });
  }

  it("pushes the bill of lading's sidebar right by as much as the freight table passes its 386pt", async () => {
    const fit = FITS.find((candidate) => candidate.docType === "BOL")!;
    expect(sidebarStart(await render("BOL", marked(fit, fit.widths)))).toBeCloseTo(418, 2);
    expect(sidebarStart(await render("BOL", marked(fit, { freight_description: 154.2 })))).toBeCloseTo(418 + 1, 2);
  });

  it("prints each table where the figures say at the widths the measurements used", async () => {
    const at = async (fit: Fit, widths: Record<string, number>) => {
      const c = marked(fit, widths);
      return { pdf: await render(fit.docType, c), figure: tablePrintedWidth(contractFor(fit.docType), c, fit.table)! };
    };
    const byTable = (docType: TemplateDocTypeString, table: string) =>
      FITS.find((candidate) => candidate.docType === docType && candidate.table === table)!;
    const measured: Record<string, number> = {};
    // Each declared at its whole budget but the containers, 262 of 282 a half.
    const cases: [string, Fit, Record<string, number>, number][] = [
      ["cert", byTable("CERT", "parts"), { part_identity: 404 }, 564],
      ["invoice", byTable("INVOICE", "columns"), { col_info: 362 }, 564],
      ["bol", byTable("BOL", "freight"), { freight_description: 198 }, 386],
      ["inspections", byTable("TRAVELER", "inspections"), { inspection_code: 170, inspection_location: 171 }, 564],
      ["statement", byTable("STATEMENT", "aging"), {
        ...Object.fromEntries(Object.keys(AGING_72).map((key) => [key, 80])), aging_net: 84,
      }, 564],
      ["containers", byTable("SHIPPER", "containers"), { container_count: 60, container_tare: 60 }, 262],
    ];
    for (const [name, fit, widths, declared] of cases) {
      const { pdf, figure } = await at(fit, widths);
      expect(figure.declared, name).toBe(declared);
      const ink = inkEnd(pdf, fit.kind).end;
      expect(ink, name).toBeCloseTo(LEFT + figure.copies * figure.printed, 2);
      measured[name] = Math.round(ink * 100) / 100;
      if (name === "bol") measured.sidebar = Math.round(sidebarStart(pdf) * 100) / 100;
    }
    expect(measured).toEqual({
      cert: 612, invoice: 624, bol: 454.8, sidebar: 462.8, inspections: 637.6, statement: 650.4, containers: 612,
    });
  });
});
