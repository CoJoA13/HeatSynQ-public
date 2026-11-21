/**
 * The listing's `--clamp` verdict (#991, owner ruling 2026-11-15; design
 * docs/superpowers/specs/2026-11-17-991-flow-tables-in-box-design.md §7): for each stored template version, which of its
 * flow's table sections render.ts' column clamp lays out differently from the flow before #991. Before the merge the
 * owner lists `.182`'s templates with it, to see which overrun today.
 *
 * The verdict comes from the clamp firing, never from restated arithmetic: each version's config, judged by the
 * contracts as they stand (`normalizeStoredConfig`, the function a print calls), builds its flow around a stand-in
 * record whose every word is one character (`standInFor`), and render.ts lays it out and names the sections whose rows it
 * corrected, and those a row of which still prints past its width because its fixed parts pass it
 * (`clampedFlowTables`: "prints past the page as before"). The contracts refuse the fixed parts they count (owner
 * ruling R-B: every column table's, and the invoice's totals lines since the review's F1), so a stored version
 * reaching it there reads REFUSED in the default listing first; a row R-B does not count would still read it. With the
 * record's words at their least, what moves is what the template itself drives: typed widths and labels, fonts and
 * sizes, the headings it prints over its columns, and the wording the builders read from the template (the bill of
 * lading's sidebar paragraphs, the ticket's tear-off words). The texts the builders read from the record are the
 * stand-in's (a certification's statement, a quote's intro, ending and liability, the ticket's liability text), so
 * those are not judged. A real record's longer words can overrun where the stand-in does not, and no stored config
 * shows that.
 *
 * It reads no database and writes nothing. It is not file-free as the default listing is: render.ts reads the vendored
 * fonts as it loads. The builders' module graph wants a `DATABASE_URL`; the command sets an unreachable one when none is
 * set, and no query is made (`clampedFlowTables` lays out unstamped, so not even the practice check runs).
 */
import { ZodError } from "zod";
import {
  TEMPLATE_DOC_TYPES, TemplateConfigError, contractFor, normalizeStoredConfig,
  type TemplateConfig, type TemplateDocTypeString,
} from "../../src/lib/template-contracts/index";
import { barcodePng, clampedFlowTables, pngDataUri, type RenderableDefinition } from "../../src/server/pdf/render";
import { buildTravelerDefinitions, type TravelerData } from "../../src/server/traveler";
import { buildShippingTicketDefinitions, type TicketData } from "../../src/server/pdf/shipping-ticket";
import { buildBolDefinition, type BolData } from "../../src/server/pdf/bol";
import { buildCertDefinition, type CertPdfData } from "../../src/server/pdf/cert";
import { buildInvoiceDefinition, type InvoicePdfData } from "../../src/server/pdf/invoice";
import { buildStatementDefinition, type StatementData } from "../../src/server/pdf/statement";
import { buildQuoteDefinition, type QuotePdfData } from "../../src/server/pdf/quote";
import { issueWording, type ExportedVersion } from "./stored-template-check";

export const CLAMP_HEADINGS: readonly string[] = ["Document", "Template", "Version", "Status", "Customers", "Prints differently"];

/** What the listing says of a version with a canvas layout: its tables have been kept in their boxes since #971. */
export const CANVAS_VERDICT = "canvas: its tables keep inside their boxes since #971";
/** A version none of whose flow table sections the clamp moves or leaves past the page. */
const NONE = "none";

const W = "A";
const company = { name: W, address: W, phone: W };
const party = { code: W, attn: "", name: W, street: W, city: W, state: W, zip: W };

/** One stand-in record per document type with a table: one of each row the flow prints, every word one character,
 *  so every table section of the type's flow prints (tests/stored-template-clamp.test.ts holds each type's marks to
 *  `flowTableSections`). Exported for that test. */
export async function standInFor(docType: TemplateDocTypeString): Promise<unknown> {
  switch (docType) {
    case "TRAVELER": {
      const data: TravelerData = {
        orderNumber: 1, poNumber: W, customerName: W, receivedFrom: [W], customerPhone: W, company,
        lines: [{ qty: 1, partNumber: W, partName: W, description: W, eachWeight: 1, lineWeight: 1 }],
        orderQty: 1, containers: [{ typeName: W, count: 1, pieces: 1, tareEach: 1 }],
        materialName: W, processName: W, processId: W,
        inspections: [{ code: W, scale: W, min: 1, max: 1, sampleQty: "1", location: W }],
        revisionNumber: 1,
        steps: [{ position: 1, codeName: W, instruction: W, values: [{ label: W, value: "1", unit: W }] }],
        sheets: [{ loadNumber: 1, loadQty: 1, loadWeight: 1, barcodeDataUri: pngDataUri(await barcodePng("1-1")) }],
      };
      return data;
    }
    case "SHIPPER":
    case "MOS_SHIPPER": {
      const data: TicketData[] = [{
        company: { ...company, liabilityText: W }, soldTo: party, shipTo: party,
        orderLabel: "1-1", orderNumber: 1, shipDate: "2026-01-01",
        poNumber: W, packingListNo: 1, customerJobNo: W, route: W, carrierName: W,
        lines: [{ qty: 1, partNumber: W, partName: W, partDescription: W, pounds: 1 }],
        containers: [{ typeName: W, count: 1, customerContainerId: W, tareEach: 1 }],
        serials: [{ serial: W, description: W }], shippedComplete: true, totalQty: 1,
      }];
      return data;
    }
    case "BOL": {
      const data: BolData = {
        company: { name: W, address: W }, bolNumber: 1, proNumber: W, scacCode: W, carrierName: W, shipDate: "2026-01-01",
        consignee: { name: W, street: W, city: W, state: W, zip: W }, orderNumbers: [1], poNumbers: [W],
        packageCount: 1, freightDescription: W, orders: [{ lineWeights: [1], containers: [] }], freightClass: W,
        freightTerms: "PREPAID",
      };
      return data;
    }
    case "CERT": {
      const data: CertPdfData = {
        company, orderLabel: "1-1", printDate: "2026-01-01", entryDate: "2026-01-01",
        to: { attn: "", name: W, street: W, city: W, state: W, zip: W }, poNumber: W, packingListNo: 1, material: W,
        parts: [{ qty: 1, partNumber: W, partName: W, partDescription: W, pounds: 1 }],
        statement: W,
        requirements: [{
          lineIdentity: "1", linePosition: 1, partNumber: W, partName: W, specification: W, scale: W, readings: [1],
        }],
        serialBlocks: [{ partNumber: W, serials: [{ serial: W, description: W }] }],
        freeform: W, signer: { name: W, title: W, company: W, signatureDataUri: null },
      } as CertPdfData;
      return data;
    }
    case "INVOICE": {
      const data: InvoicePdfData = {
        company, remitTo: { name: W, lines: [W] }, billTo: [W], shipTo: [W], title: "Invoice",
        documentNumber: "1", invoiceDate: "2026-01-01", termsName: W, orderNumber: 1, poNumber: W,
        materialName: W, processNames: W,
        parts: [{ qty: 1, partNumber: W, partName: W, partDescription: W, eachWeight: 1, totalWeight: 1 }],
        priceRows: [{ description: W, pricePerLabel: W, unitPrice: 1, minimumCharge: 1, setupCharge: 1, amount: 1, partIndex: 0 }],
        subtotal: 1, surchargeRows: [{ description: W, amount: 1 }], chargeRows: [{ description: W, amount: 1 }],
        certRow: { description: W, amount: 1 }, freightRow: { description: W, amount: 1 }, taxRow: { description: W, amount: 1 },
        total: 1,
      } as InvoicePdfData;
      return data;
    }
    case "STATEMENT": {
      const data: StatementData = {
        asOf: "2026-01-01", company, remitTo: { name: W, lines: [W] },
        customer: { code: W, name: W, billTo: [W] },
        openItems: [{ documentNumber: "1", date: "2026-01-01", dueDate: "2026-01-01", kind: "INVOICE", original: 1, open: 1 }],
        aging: {
          customerId: W, customerCode: W, customerName: W,
          current: 1, d1_30: 1, d31_60: 1, d61_90: 1, d90_plus: 1, unapplied: 1, net: 1,
        },
        financeCharge: 1, totalDue: 1,
      } as StatementData;
      return data;
    }
    case "QUOTE": {
      const data: QuotePdfData = {
        company, quoteNumber: 1, effectiveDate: "2026-01-01", expiryDate: "2026-01-01", termsName: W, rfqNumber: W,
        attn: W, customerPhone: W, billTo: [W], introText: W,
        lines: [{
          quotedQty: 1, quotedUnlimited: false, partNumber: W, partName: W, partDescription: W, eachWeight: 1, totalLbs: 1,
          surcharges: [{ name: W, rateText: "1%", amount: 1 }], material: W,
          prices: [{
            stepName: W, notes: W, setupCharge: 1, unitPrice: 1, minimumCharge: 1, pricePerLabel: W, pricedPerLb: false,
            breaks: [], amount: 1,
          }],
        }],
        endingStatementText: W, notes: W, liabilityText: W, signer: { name: W, title: W },
      } as QuotePdfData;
      return data;
    }
    case "CONTAINER_TAG": return null;
  }
}

/** `docType`'s flow, built from `config` around `data`. */
function flowOf(docType: TemplateDocTypeString, config: TemplateConfig, data: unknown): RenderableDefinition[] {
  switch (docType) {
    case "TRAVELER": return buildTravelerDefinitions(data as TravelerData, config);
    case "SHIPPER":
    case "MOS_SHIPPER": return buildShippingTicketDefinitions(data as TicketData[], docType, config);
    case "BOL": return [buildBolDefinition(data as BolData, config)];
    case "CERT": return [buildCertDefinition(data as CertPdfData, config)];
    case "INVOICE": return [buildInvoiceDefinition(data as InvoicePdfData, config)];
    case "STATEMENT": return [buildStatementDefinition(data as StatementData, config)];
    case "QUOTE": return [buildQuoteDefinition(data as QuotePdfData, config)];
    case "CONTAINER_TAG": return [];
  }
}

/** The editor's name of a section of `docType`. */
const sectionName = (docType: TemplateDocTypeString, key: string) =>
  contractFor(docType).sections.find((s) => s.key === key)?.name ?? key;

/** One version's verdict: the sections the clamp moves by the editor's names, `none`, the canvas's words, or the
 *  contracts' refusal. Throws for a document type it does not know. */
export async function clampVerdict(version: ExportedVersion): Promise<string> {
  const docType = version.docType as TemplateDocTypeString;
  if (!(TEMPLATE_DOC_TYPES as readonly string[]).includes(docType)) {
    throw new Error(`Version ${version.versionId} has a document type this checker does not know: ${version.docType}`);
  }
  let config: TemplateConfig;
  try {
    config = normalizeStoredConfig(docType, version.config);
  } catch (error) {
    if (error instanceof ZodError) return `REFUSED: ${issueWording(error)}`;
    if (error instanceof TemplateConfigError) return `REFUSED: ${error.message}`;
    throw error;
  }
  if (config.layout !== null) return CANVAS_VERDICT;
  const data = await standInFor(docType);
  if (data === null) return NONE;
  return verdictWords(docType, await clampedFlowTables(flowOf(docType, config, data)));
}

/** The verdict's words for what the clamp did (`clampedFlowTables`), by the editor's section names. A section left
 *  past the page ("overran") is reached only by a row whose fixed parts the printed-width budget does not count: the
 *  review's sweep found the invoice's totals lines (an Amount column of 353 pt or more), which R-B counts since F1,
 *  and none other, so on an accepted config it is worded here and tested on its own. Exported for that test. */
export function verdictWords(docType: TemplateDocTypeString, clamp: { moved: string[]; overran: string[] }): string {
  const names = (keys: string[]) => keys.map((key) => sectionName(docType, key)).join("; ");
  const said = [
    ...(clamp.moved.length > 0 ? [`prints inside the page now: ${names(clamp.moved)}`] : []),
    ...(clamp.overran.length > 0 ? [`prints past the page as before: ${names(clamp.overran)}`] : []),
  ];
  return said.length === 0 ? NONE : said.join("; and ");
}

/** The status word, as the default listing writes it. */
function statusOf(version: ExportedVersion): string {
  const word: Record<string, string> = { PUBLISHED: "earlier", DRAFT: "draft", DISCARDED: "discarded" };
  if (!(version.status in word)) {
    throw new Error(`Version ${version.versionId} has a status this checker does not know: ${version.status}`);
  }
  return version.published ? "in use" : word[version.status];
}

const cell = (text: string): string => text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");

/** The `--clamp` listing of one database's export, as text. */
export async function clampListing(database: string, versions: readonly ExportedVersion[]): Promise<string> {
  const line = (cells: readonly string[]) => `| ${cells.map(cell).join(" | ")} |`;
  const rows: string[] = [];
  for (const v of versions) {
    const docType = v.docType as TemplateDocTypeString;
    const document = (TEMPLATE_DOC_TYPES as readonly string[]).includes(docType) ? contractFor(docType).name : v.docType;
    rows.push(line([
      document,
      `${v.templateName}${v.isDefault ? " (default)" : ""}${v.templateDeleted ? " (deleted)" : ""}`,
      String(v.versionNumber), statusOf(v), v.customers.length === 0 ? NONE : v.customers.map((c) => c.code).join(", "),
      await clampVerdict(v),
    ]));
  }
  return [
    `## ${database}: flow tables the column clamp moves (#991)`,
    "",
    "Laid out around a stand-in record whose every word is one character, the texts it carries included (a " +
      "certification's statement, a quote's wording): what moves is what the template's widths, labels, fonts, sizes " +
      "and own wording drive. A real record's longer words can move a table this cannot show.",
    "",
    line(CLAMP_HEADINGS), `|${CLAMP_HEADINGS.map(() => "---").join("|")}|`, ...rows,
  ].join("\n");
}
