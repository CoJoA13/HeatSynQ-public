/**
 * A traveler, a shipping ticket and a bill of lading for one order, from plain figures, through
 * the real builders and the program's renderer. tests/e2e-printed-page.test.ts reads these pages
 * back from their bytes.
 *
 * Each page is what a shipment of that order alone prints when the order ships whole: one load,
 * one ticket sheet, one bill of lading with no carrier and no address. The company's and the
 * customer's names, the dates, the document numbers, the step and the liability text are this
 * file's own. Only the first render asks the database its name, for the practice stamp:
 * `practiceMode()` keeps its answer for as long as its module lives.
 */
import { buildTravelerDefinitions, type TravelerData } from "@/server/traveler";
import { buildShippingTicketDefinitions, type TicketData } from "@/server/pdf/shipping-ticket";
import { buildBolDefinition, type BolData } from "@/server/pdf/bol";
import { barcodePng, pngDataUri, renderPdf, renderSheetGroups } from "@/server/pdf/render";
import type { TemplateConfig } from "@/lib/template-contracts/index";

/** An order as far as the three pages print it. Plain figures and no builder type. */
export type PageOrder = {
  number: number;
  lines: { qty: number; eachWeight: number; weight: number; partNumber: string; partName: string }[];
  containers: { typeName: string; count: number; pieces: number | null; tareEach: number | null }[];
};

const COMPANY = { name: "Example Heat Treating", address: "100 Example Way  Anniston  AL  36207", phone: "256 555 0100" };
const CUSTOMER = "Demo Components Corporation";
const NO_ADDRESS = { street: "", city: "", state: "", zip: "" };
const SHIP_DATE = "2026-10-12";

/** The pieces of every line, added up. */
const pieces = (order: PageOrder): number => order.lines.reduce((sum, line) => sum + line.qty, 0);
/** The weight of every line, added up in whole cents. */
const pounds = (order: PageOrder): number => order.lines.reduce((sum, line) => sum + Math.round(line.weight * 100), 0) / 100;

/** The order's traveler: one load of every line, so one sheet group. Built-in template unless `config` is given. */
export async function travelerPdf(order: PageOrder, config?: TemplateConfig): Promise<Buffer> {
  const data: TravelerData = {
    orderNumber: order.number, poNumber: "", customerName: CUSTOMER, receivedFrom: [], customerPhone: "", company: COMPANY,
    lines: order.lines.map((line) => ({
      qty: line.qty, partNumber: line.partNumber, partName: line.partName, description: "", eachWeight: line.eachWeight, lineWeight: line.weight,
    })),
    orderQty: pieces(order), containers: order.containers.map((row) => ({ ...row })),
    materialName: "", processName: "", processId: order.lines[0].partNumber, inspections: [], revisionNumber: 1,
    steps: [{ position: 1, codeName: "Wash", instruction: "Wash and pack.", values: [] }],
    sheets: [{
      loadNumber: 1, loadQty: pieces(order), loadWeight: pounds(order),
      barcodeDataUri: pngDataUri(await barcodePng(`${order.number}-1`)),
    }],
  };
  return renderSheetGroups(buildTravelerDefinitions(data, config));
}

/** The order's shipping ticket, alone on its shipment and shipped whole: document type "SHIPPER", order label `${number}-1`, shipped complete. A container row carries no pieces. */
export function ticketPdf(order: PageOrder, config?: TemplateConfig): Promise<Buffer> {
  const ticket: TicketData = {
    company: { ...COMPANY, liabilityText: "Liability text of the test helper." },
    soldTo: { code: "DEMO", attn: "", name: CUSTOMER, ...NO_ADDRESS }, shipTo: { code: "", attn: "", name: CUSTOMER, ...NO_ADDRESS },
    orderLabel: `${order.number}-1`, orderNumber: order.number, shipDate: SHIP_DATE, poNumber: "", packingListNo: 1,
    customerJobNo: "", route: "", carrierName: "",
    lines: order.lines.map((line) => ({
      qty: line.qty, partNumber: line.partNumber, partName: line.partName, partDescription: "", pounds: line.weight,
    })),
    containers: order.containers.map((row) => ({
      typeName: row.typeName, count: row.count, customerContainerId: "", tareEach: row.tareEach,
    })),
    serials: [], shippedComplete: true, totalQty: pieces(order),
  };
  return renderSheetGroups(buildShippingTicketDefinitions([ticket], "SHIPPER", config));
}

/** The order's bill of lading, alone on its shipment: no carrier, a consignee with a name alone, and a package count that is the containers added up, or null when there are none. */
export function bolPdf(order: PageOrder, config?: TemplateConfig): Promise<Buffer> {
  const data: BolData = {
    company: { name: COMPANY.name, address: COMPANY.address }, bolNumber: 1, proNumber: "", scacCode: "", carrierName: "",
    shipDate: SHIP_DATE, consignee: { name: CUSTOMER, ...NO_ADDRESS }, orderNumbers: [order.number], poNumbers: [""],
    packageCount: order.containers.reduce((sum, row) => sum + row.count, 0) || null,
    freightDescription: "", freightClass: "", freightTerms: "PREPAID",
    orders: [{
      lineWeights: order.lines.map((line) => line.weight),
      containers: order.containers.map((row) => ({ count: row.count, tareEach: row.tareEach })),
    }],
  };
  return renderPdf(buildBolDefinition(data, config));
}
