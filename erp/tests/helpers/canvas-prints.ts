/**
 * One canvas print and one flow print of every document whose canvas prints (the traveler, both
 * shipping tickets, the bill of lading, the certification, the invoice, the statement, since quote
 * canvas PR 2 the quotation and, since container tag PR 3, the container tag), each
 * built from the house canvas fixtures and rendered through the function its print path calls: `renderSheetGroups`
 * for the traveler and the tickets, `renderPdf` for the rest. Pure: no database. Read by
 * tests/canvas-marks-ink.test.ts, whose reader walks the bytes.
 */
import { buildTravelerDefinitions, type TravelerData } from "@/server/traveler";
import { buildShippingTicketDefinitions, type TicketData, type TicketDocType } from "@/server/pdf/shipping-ticket";
import { buildBolDefinition } from "@/server/pdf/bol";
import { buildCertDefinition } from "@/server/pdf/cert";
import { buildInvoiceDefinition } from "@/server/pdf/invoice";
import { buildStatementDefinition } from "@/server/pdf/statement";
import { buildQuoteDefinition } from "@/server/pdf/quote";
import { buildContainerTags, type ContainerTagData } from "@/server/pdf/container-tags";
import { barcodePng, pngDataUri, renderPdf, renderSheetGroups } from "@/server/pdf/render";
import {
  INVOICE_DEFAULT_CONFIG, MOS_SHIPPER_DEFAULT_CONFIG, QUOTE_DEFAULT_CONFIG, SHIPPER_DEFAULT_CONFIG, STATEMENT_DEFAULT_CONFIG, TRAVELER_DEFAULT_CONFIG,
  validateConfig,
  type TemplateConfig,
} from "@/lib/template-contracts/index";
import { DEFAULT_CONFIG as BOL_DEFAULT_CONFIG } from "@/lib/template-contracts/bol";
import { DEFAULT_CONFIG as CERT_DEFAULT_CONFIG } from "@/lib/template-contracts/cert";
import { DEFAULT_CONFIG as CONTAINER_TAG_DEFAULT_CONFIG } from "@/lib/template-contracts/container-tag";
import type { CanvasItem, CanvasLayout } from "@/lib/template-contracts/canvas";
import { standardLayout } from "./canvas-fixtures";
import { standardTicketLayout } from "./ticket-canvas-fixtures";
import { sampleBol, standardBolLayout } from "./bol-canvas-fixtures";
import { sampleCert, standardCertLayout } from "./cert-canvas-fixtures";
import { sampleInvoice, standardInvoiceLayout } from "./invoice-canvas-fixtures";
import { sampleStatement, standardStatementLayout } from "./statement-canvas-fixtures";
import { sampleQuote, standardQuoteLayout } from "./quote-canvas-fixtures";

export type CanvasDoc = "TRAVELER" | "SHIPPER" | "MOS_SHIPPER" | "BOL" | "CERT" | "INVOICE" | "STATEMENT" | "QUOTE" | "CONTAINER_TAG";
export const CANVAS_DOCS: readonly CanvasDoc[] = ["TRAVELER", "SHIPPER", "MOS_SHIPPER", "BOL", "CERT", "INVOICE", "STATEMENT", "QUOTE", "CONTAINER_TAG"];

/** The Standard container tag's seeded layout (`seedContainerTagItems`, src/server/container-tag-canvas-seed.ts,
 *  which tests/container-tag-canvas-seed.test.ts holds equal to this list), written out so this helper
 *  imports no module that holds a database client. */
export const STANDARD_TAG_ITEMS: CanvasItem[] = ([
  ["order_number", 14, 23.438, 20, true],
  ["customer", 39.438, 14.063, 12, true],
  ["po_number", 57.501, 11.719, 10, false],
  ["containers_total", 69.22, 11.719, 10, false],
  ["received", 80.939, 11.719, 10, false],
  ["parts", 98.658, 82.033, 10, false],
] as const).map(([key, y, h, size, bold]): CanvasItem => ({
  id: `tag-${key}`, kind: "field", key, label: null, style: { size, bold, align: "left" },
  box: { x: 14, y, w: 260, h }, anchor: { kind: "page-top" }, repeat: false,
}));

/** A two-tag order (two container rows), every tag the same text. */
function tagData(): ContainerTagData[] {
  const one: ContainerTagData = {
    orderNumber: "1031", customer: "Tag Customer Inc", poNumber: "4500123",
    parts: ["TAG-LEAD × 1,000", "TAG-RIDER × 20"], containersTotal: "5", received: "10/22/2026, 9:02 AM",
  };
  return [one, { ...one, parts: [...one.parts] }];
}

/** tests/traveler-canvas.test.ts's traveler, with one step and one load. */
async function travelerData(): Promise<TravelerData> {
  return {
    orderNumber: 91246, poNumber: "", customerName: "Demo Castings Group",
    receivedFrom: ["200 Demo Drive", "Anniston, AL 36206"], customerPhone: "",
    company: { name: "Example Heat Treating", address: "1 Furnace Rd", phone: "256-555-0101" },
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
    sheets: [{ loadNumber: 1, loadQty: 336, loadWeight: 4536, barcodeDataUri: pngDataUri(await barcodePng("91246")) }],
    processName: "Austemper",
  };
}

/** tests/shipping-ticket-canvas.test.ts's ticket. */
function ticketData(): TicketData {
  return {
    company: {
      name: "Example Heat Treating - Alabama,", address: "1201 Front St", phone: "(256) 555-0100",
      liabilityText: "FIRST LIABILITY PARAGRAPH.\n\nSECOND LIABILITY PARAGRAPH.",
    },
    soldTo: {
      code: "9054", attn: "Accounts payable", name: "Demo Components Corporation", street: "300 Example Way",
      city: "Anniston", state: "AL", zip: "36201",
    },
    shipTo: { code: "", attn: "", name: "Example Coating", street: "88 Dock Rd.", city: "Oxford", state: "AL", zip: "36203" },
    orderLabel: "92036-3", orderNumber: 92036, shipDate: "2026-07-29",
    poNumber: "DEMO-PO-24115", packingListNo: 92826, customerJobNo: "JOB-9", route: "South", carrierName: "Customer",
    lines: [{ qty: 192, partNumber: "DEMO01-HT", partName: "Track Shoe, Vehicular", partDescription: "D-001", pounds: 4128 }],
    containers: [{ typeName: "Bin", count: 3, customerContainerId: "DEMO-COMP-77", tareEach: 42.5 }],
    serials: [{ serial: "SN-0001", description: "Heat A1" }],
    shippedComplete: true, totalQty: 192,
  };
}

const withLayout = (base: TemplateConfig, layout: CanvasLayout | null): TemplateConfig => ({ ...structuredClone(base), layout });

async function ticket(docType: TicketDocType, layout: CanvasLayout | null): Promise<Buffer> {
  const base = docType === "SHIPPER" ? SHIPPER_DEFAULT_CONFIG : MOS_SHIPPER_DEFAULT_CONFIG;
  return renderSheetGroups(buildShippingTicketDefinitions([ticketData()], docType, validateConfig(docType, withLayout(base, layout))));
}

/** One document's print, on its standard canvas layout (`canvas`) or on the flow (null). */
export async function printOf(doc: CanvasDoc, canvas: boolean): Promise<Buffer> {
  switch (doc) {
    case "TRAVELER": {
      const config = validateConfig("TRAVELER", withLayout(TRAVELER_DEFAULT_CONFIG, canvas ? standardLayout() : null));
      return renderSheetGroups(buildTravelerDefinitions(await travelerData(), config));
    }
    case "SHIPPER":
    case "MOS_SHIPPER":
      return ticket(doc, canvas ? standardTicketLayout() : null);
    case "BOL":
      return renderPdf(buildBolDefinition(sampleBol(), withLayout(BOL_DEFAULT_CONFIG, canvas ? standardBolLayout() : null)));
    case "CERT":
      return renderPdf(buildCertDefinition(sampleCert(), withLayout(CERT_DEFAULT_CONFIG, canvas ? standardCertLayout() : null)));
    case "INVOICE":
      return renderPdf(buildInvoiceDefinition(sampleInvoice(), withLayout(INVOICE_DEFAULT_CONFIG, canvas ? standardInvoiceLayout() : null)));
    // The standard statement layout's Bill To holds its drawn height (`holdsHeight`), so its canvas
    // print carries the held block's spacer as well as the sheet's marks.
    case "STATEMENT":
      return renderPdf(buildStatementDefinition(sampleStatement(), withLayout(STATEMENT_DEFAULT_CONFIG, canvas ? standardStatementLayout() : null)));
    case "QUOTE":
      return renderPdf(buildQuoteDefinition(sampleQuote(), withLayout(QUOTE_DEFAULT_CONFIG, canvas ? standardQuoteLayout() : null)));
    // The tag prints through `buildContainerTags`, the route's builder: its canvas through the tag's own
    // one-page builder, every item's mark on both tags' pages.
    case "CONTAINER_TAG":
      return renderPdf(buildContainerTags(tagData(), validateConfig("CONTAINER_TAG",
        withLayout(CONTAINER_TAG_DEFAULT_CONFIG, canvas ? { version: 1, items: structuredClone(STANDARD_TAG_ITEMS) } : null))));
  }
}
