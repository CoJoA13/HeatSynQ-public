import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import type { Area } from "./permissions";
import { formatDateOnly, todayDateOnly } from "../lib/business-days";
import {
  renderPdf, renderSheetGroups, renderSheetGroupsWithPositions, layOutSheetGroups, jpegDataUri, pngDataUri, type RenderableDefinition,
} from "./pdf/render";
import { canvasMeasure, mergeAloneMeasure } from "./canvas-measure";
import { aloneLayouts, type ItemContent } from "./pdf/canvas-sheet";
import { completeCanvas } from "./traveler-canvas";
import { completeTicketCanvas } from "./shipping-ticket-canvas";
import { completeBolCanvas } from "./bol-canvas";
import { completeCertCanvas } from "./cert-canvas";
import { completeInvoiceCanvas } from "./invoice-canvas";
import { completeStatementCanvas } from "./statement-canvas";
import { completeQuoteCanvas } from "./quote-canvas";
import type { CanvasMeasure } from "../lib/template-canvas";
import type { CanvasLayout } from "../lib/template-contracts/canvas";
import {
  validateConfig, TemplateConfigError,
  type TemplateConfig, type TemplateDocTypeString,
} from "../lib/template-contracts/index";

// The record reads + settings + builders each print type already uses — a preview reuses the SAME
// read and the SAME builder, minus the store/stamp/printedAt/allocation.
import {
  travelerSettings, readTravelerData, buildTravelerDefinitions, travelerCanvasItemContent,
} from "./traveler";
import { readDetail } from "./orders";
import {
  ticketSettings, readShippingTicketData, bolSettings, readBolData,
} from "./shippers";
import { buildShippingTicketDefinitions, ticketCanvasItemContent } from "./pdf/shipping-ticket";
import { buildBolDefinition, bolCanvasItemContent } from "./pdf/bol";
import { CERT_SIGNER_SELECT, certPrintSettings, readCertPdfData } from "./certs";
import { buildCertDefinition, certCanvasItemContent } from "./pdf/cert";
import { invoicePrintSettings, readInvoicePdfData } from "./invoices";
import { buildInvoiceDefinition, invoiceCanvasItemContent, type InvoicePdfData } from "./pdf/invoice";
import { buildStatement } from "./statements";
import { buildStatementDefinition, statementCanvasItemContent, type StatementData } from "./pdf/statement";
import { quotePrintSettings, readQuotePdfData } from "./quotes";
import { buildQuoteDefinition, quoteCanvasItemContent, type QuotePdfData } from "./pdf/quote";
import { templatePlacesLogo } from "@/lib/template-contracts/template-logo";
import {
  TAG_NO_ROWS, TAG_ORDER_NOT_FOUND, TAG_ORDER_VOIDED, containerTagsData, readContainerTagsOrder,
} from "./container-tags";
import { buildContainerTags, type ContainerTagData } from "./pdf/container-tags";
import { buildContainerTagCanvas } from "./pdf/container-tag-canvas";

/**
 * The template PREVIEW (Phase 7 spec §5.5): render the editor's SUBMITTED (working, possibly-unsaved)
 * config against a real record the user picks, streaming PDF bytes with ZERO side effects — NO
 * `StoredDocument`, NO `printedAt`, NO finance-charge assessment, NO `updatedAt` bump, NO number
 * allocation.
 *
 * The whole point is that a preview renders the SUBMITTED config DIRECTLY — it does NOT go through
 * `resolveTemplateForPrint` (which requires a PUBLISHED version), so a never-published draft
 * previews exactly as an assigned one would. The only two facts this file reads FROM the template
 * row are its `docType` (which contract validates, which read/builder runs) and its open draft's
 * logo bytes (the logo lives per-version, not in the config — the print path's own §6.3 rule).
 *
 * This module is a top-level CONSUMER of every print service and builder; nothing imports it back,
 * so the wide import graph opens no cycle.
 */

type Db = Prisma.TransactionClient;

/** docType → the print-route permission a preview must ALSO hold (spec §5.5): a preview exposes the
 *  real record's amounts, so it can never be a cheaper read than the print itself. */
export const RECORD_AREA: Record<TemplateDocTypeString, Area> = {
  TRAVELER: "orders",
  SHIPPER: "shipping",
  MOS_SHIPPER: "shipping",
  BOL: "shipping",
  CERT: "certs",
  INVOICE: "invoicing",
  STATEMENT: "receivables",
  QUOTE: "quotes",
  // The tag route's own gate (`/api/orders/[id]/container-tags`, orders.view).
  CONTAINER_TAG: "orders",
};

export type PreviewContext = {
  docType: TemplateDocTypeString;
  /** The open draft's stored logo bytes (per-version — §6.3), or null when the draft carries none. */
  logoImage: Uint8Array | null;
  logoMimeType: string | null;
};

/**
 * The two facts the route needs from the template row: its `docType` (drives the record-area
 * permission gate AND the render dispatch) and its open draft's logo bytes (the preview shows the
 * WORKING logo, which lives on the draft version). A missing/soft-deleted template 404s. Read
 * BEFORE the record-area gate so the docType is known — no record data is touched here.
 */
export async function readPreviewContext(id: string): Promise<PreviewContext> {
  const template = await prisma.documentTemplate.findFirst({
    where: { id, deletedAt: null },
    select: {
      docType: true,
      versions: {
        where: { status: "DRAFT" },
        select: { logoImage: true, logoMimeType: true },
        take: 1,
      },
    },
  });
  if (!template) throw new HttpError(404, "Template not found");
  const draft = template.versions[0] ?? null;
  return {
    docType: template.docType as TemplateDocTypeString,
    logoImage: draft?.logoImage ?? null,
    logoMimeType: draft?.logoMimeType ?? null,
  };
}

export type PreviewInput = {
  /** The in-editor working config — validated here against the docType's contract, so a preview of
   *  an over-budget/invalid config 400s the same as a save, before any render. */
  config: unknown;
  recordId: string;
  /** STATEMENT only (defaults today/false; §5.5). */
  asOf?: string;
  combineFamily?: boolean;
  /** TRAVELER only — a single load; with neither this nor `allLoads`, the order's first load
   *  (ruling R17, #674), or the one blank sheet of an order with no loads. */
  loadNumber?: number;
  /** TRAVELER only — every load, bounded by the print path's own #43 cap. */
  allLoads?: boolean;
};

/** Read-only reads on a single RepeatableRead snapshot (the getTemplate/buildStatement posture): no
 *  claim, no write — the preview mutates nothing, so the print path's Serializable brackets and row
 *  claims are deliberately absent. */
function readOnly<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/** A preview with no measure report: every document but a canvas traveler, ticket, bill of lading,
 *  certification, invoice, statement, quotation or container tag. */
async function bare(pdf: Promise<Buffer>): Promise<{ pdf: Buffer; measure: null }> {
  return { pdf: await pdf, measure: null };
}

/**
 * A canvas preview's paper and measure: the definitions rendered once through
 * `renderSheetGroupsWithPositions` (bytes `renderSheetGroups`' own), the first sheet group's
 * positions mapped (`canvasMeasure`, over the config's `layout`, through the document's belt
 * `complete`), and the first sheet's float regions and page-bottom band laid out once more alone
 * (`aloneLayouts`, from the first sheet's item node `itemContent`), their bytes discarded and their
 * positions merged in (`mergeAloneMeasure`).
 */
async function measuredPreview(
  defs: RenderableDefinition[], config: TemplateConfig, layout: CanvasLayout, itemContent: ItemContent,
  complete: (layout: CanvasLayout) => CanvasLayout,
): Promise<{ pdf: Buffer; measure: CanvasMeasure }> {
  const { pdf, groups } = await renderSheetGroupsWithPositions(defs);
  let measure = canvasMeasure(layout, config.pageFooter, groups[0], complete);
  const alone = aloneLayouts({ layout, pageFooter: config.pageFooter, fonts: config.fonts, itemContent });
  const laid = await layOutSheetGroups(alone.map((a) => a.def));
  measure = mergeAloneMeasure(measure, layout, config.pageFooter,
    alone.map((a, i) => ({ after: a.after, positions: laid[i] })));
  return { pdf, measure };
}

/**
 * The invoice's (or credit memo's) preview, the whole of `renderPreview`'s INVOICE branch (the invoice
 * canvas design 2026-11-10 §5.2, §7): `data` is the picked record's own print data, `config` the
 * validated working config and `logoDataUri` the draft's logo where the config places one. A flow
 * config (`layout` null) renders today's one definition through `renderPdf` and answers no measure. A
 * canvas config renders its ONE definition (one sheet group, built without seed ids or the seed's
 * stand-in: the preview renders the real invoice) through `measuredPreview`, its first page the
 * measure's, the item node its sheet is assembled with (`invoiceCanvasItemContent`) feeding the alone
 * layouts and `completeInvoiceCanvas` its belt. The measure reads canvas ids by exact match, so the
 * order strip's own row id (`invoice-order-strip`) inside its block's inner stack enters no entry.
 *
 * The route reaches the canvas half since PR 3 put `INVOICE` in `CANVAS_PRINTS`: `validateConfig`
 * runs the registry's canvas rules, which accept an invoice layout.
 */
export async function renderInvoiceCanvasPreview(
  data: InvoicePdfData, config: TemplateConfig, logoDataUri: string | undefined,
): Promise<{ pdf: Buffer; measure: CanvasMeasure | null }> {
  const def = buildInvoiceDefinition(data, config, logoDataUri);
  if (config.layout === null) return bare(renderPdf(def));
  return measuredPreview([def], config, config.layout,
    invoiceCanvasItemContent(data, config, logoDataUri), completeInvoiceCanvas);
}

/**
 * The customer statement's preview (the statement canvas design 2026-11-11 §5.2, §9): `data` is the
 * picked customer's own statement (`buildStatement`'s, never assessed), `config` the validated working
 * config and `logoDataUri` the draft's logo where the config places one. A flow config (`layout`
 * null) renders today's one definition through `renderPdf` and answers no measure. A canvas config
 * renders its ONE definition (one sheet group, built without seed ids or the seed's stand-in: the
 * preview renders the real statement) through `measuredPreview`, its first page the measure's, the
 * item node its sheet is assembled with (`statementCanvasItemContent`) feeding the alone layouts and
 * `completeStatementCanvas` its belt. The Bill To block is measured at the height it prints, at least
 * its drawn height (`holdsHeight`), and a block the statement leaves empty (the finance line, unassessed)
 * at 0 pt.
 *
 * The route reaches the canvas half since statement canvas PR 2 put `STATEMENT` in
 * `CANVAS_PRINTS`: `validateConfig` runs the registry's canvas rules, which accept a statement layout,
 * and `renderPreview`'s STATEMENT arm is this function whole.
 */
export async function renderStatementCanvasPreview(
  data: StatementData, config: TemplateConfig, logoDataUri: string | undefined,
): Promise<{ pdf: Buffer; measure: CanvasMeasure | null }> {
  const def = buildStatementDefinition(data, config, logoDataUri);
  if (config.layout === null) return bare(renderPdf(def));
  return measuredPreview([def], config, config.layout,
    statementCanvasItemContent(data, config, logoDataUri), completeStatementCanvas);
}

/**
 * The quotation's preview (the quote canvas design 2026-11-12 §4.6, §5.1; since quote canvas PR 2):
 * `data` is the picked quote's own print data (`readQuotePdfData`, its intro and liability wording the
 * config's, bound at the data seam), `config` the validated working config and `logoDataUri` the
 * draft's logo where the config places one. A flow config (`layout` null) renders today's one
 * definition through `renderPdf` and answers no measure. A canvas config renders its ONE definition
 * (one sheet group, built without seed ids or the seed's stand-in: the preview renders the real quote)
 * through `measuredPreview`, its first page the measure's, the item node its sheet is assembled with
 * (`quoteCanvasItemContent`) feeding the alone layouts and `completeQuoteCanvas` its belt. A block the
 * quote leaves empty (blank liability wording, every column or parties row hidden, a deleted quote's
 * lines) is measured at 0 pt; the intro never is, its blank wording printing one empty line.
 *
 * `renderPreview`'s QUOTE arm is this function whole, since QUOTE joined `CANVAS_PRINTS` (quote canvas
 * PR 2), as its STATEMENT arm is `renderStatementCanvasPreview`.
 */
export async function renderQuoteCanvasPreview(
  data: QuotePdfData, config: TemplateConfig, logoDataUri: string | undefined,
): Promise<{ pdf: Buffer; measure: CanvasMeasure | null }> {
  const def = buildQuoteDefinition(data, config, logoDataUri);
  if (config.layout === null) return bare(renderPdf(def));
  return measuredPreview([def], config, config.layout,
    quoteCanvasItemContent(data, config, logoDataUri), completeQuoteCanvas);
}

/**
 * The container tag preview's paper and measure (container tag PR 3): `tag` the picked order's first
 * tag, `config` the validated working config and `logoDataUri` the draft's logo where the config places
 * one. A flow config renders the flow's tag and answers no measure; a canvas config renders the tag
 * builder's one page and answers the measure that builder reports (`buildContainerTagCanvas`), never
 * `canvas-measure.ts`'s (the design's §7.4: the tag prints through its own builder).
 */
export async function renderContainerTagPreview(
  tag: ContainerTagData, config: TemplateConfig, logoDataUri: string | undefined,
): Promise<{ pdf: Buffer; measure: CanvasMeasure | null }> {
  if (config.layout === null) return bare(renderPdf(buildContainerTags([tag], config)));
  const { def, measure } = buildContainerTagCanvas([tag], config, logoDataUri);
  return { pdf: await renderPdf(def), measure };
}

/**
 * Renders the submitted config against the picked record. Validates the config FIRST (an invalid/
 * over-budget config throws a named 400 with no render — the save-path parity §5.5 wants), embeds
 * the draft's stored logo when the config places one (the print path's §6.3 rule), then reuses the
 * exact per-type read + builder the print path uses — minus every side effect.
 *
 * `signerUserId` is the acting user, used ONLY by the CERT preview's signature block (the print
 * path signs with the caller's own user — §3.11; a preview mirrors that).
 *
 * `measure` is the canvas traveler's measure report (design 2026-11-07 §5.3, `canvasMeasure`): a
 * TRAVELER config with a `layout` renders through `renderSheetGroupsWithPositions`, whose bytes are
 * `renderSheetGroups`' own, and its first sheet group's positions are mapped, so one render serves
 * the paper and the measure (§14 call 6). The items anchored below a table and in the page-bottom
 * band are where that render cannot see, so the first sheet's regions and band are laid out once
 * more alone (`aloneLayouts`, one small render per region holding an item and one for the band,
 * whose bytes are discarded) and merged in (`mergeAloneMeasure`; the shipping ticket design's §5.2).
 * A canvas SHIPPER or MOS_SHIPPER answers one too, the first ticket's (the first order's sheet
 * group), built without seed ids or a placeholder serial line, and so does a canvas BOL, its one
 * definition's (the bill of lading design §5.3), built without seed ids or a placeholder PO line, and
 * a canvas CERT, its one definition's (the certification design §5.3, §7), built without seed ids or
 * the seed's stand-in, signed by the acting user: the canvas preview renders that definition through
 * `renderSheetGroupsWithPositions` and the canvas print through `renderPdf`, each in one pass (a
 * canvas carries no `overflowTopMargin`; the flow's two-pass render stays the flow's). The INVOICE
 * branch is `renderInvoiceCanvasPreview` whole, which answers a canvas invoice's measure the same way
 * (the invoice canvas design 2026-11-10 §7), the STATEMENT branch `renderStatementCanvasPreview`
 * whole, a canvas statement's (the statement canvas design 2026-11-11 §5.2, §9), and the QUOTE branch
 * `renderQuoteCanvasPreview` whole, a canvas quotation's (the quote canvas design 2026-11-12 §4.6,
 * §5.1; since quote canvas PR 2). The CONTAINER_TAG branch prints the order's first tag through
 * `renderContainerTagPreview`, which answers a canvas tag's measure from the tag's own builder
 * (`buildContainerTagCanvas`, the container tag design 2026-11-13 §7.4), never `canvasMeasure`. A
 * print renders none of the measures. Every other preview, a flow traveler's, ticket's, bill of
 * lading's, certification's, invoice's, statement's, quotation's or container tag's included, answers
 * null and renders exactly as before.
 */
export async function renderPreview(
  ctx: PreviewContext, input: PreviewInput, signerUserId: string,
): Promise<{ pdf: Buffer; measure: CanvasMeasure | null }> {
  const { docType } = ctx;
  let config: TemplateConfig;
  try {
    config = validateConfig(docType, input.config);
  } catch (err) {
    if (err instanceof TemplateConfigError) throw new HttpError(400, err.message);
    throw err; // a ZodError shape problem stays for `handle` to translate to a 400
  }

  // Logo bytes → data URI by the STORED mime type, ONLY when the config also places a logo — the
  // exact rule every print path applies (an unplaced upload converts nothing).
  const logoDataUri = ctx.logoImage !== null && templatePlacesLogo(config)
    ? (ctx.logoMimeType === "image/jpeg"
        ? jpegDataUri(Buffer.from(ctx.logoImage))
        : pngDataUri(Buffer.from(ctx.logoImage)))
    : undefined;

  switch (docType) {
    case "TRAVELER": {
      const settings = await travelerSettings();
      const data = await readOnly(async (tx) => {
        if (input.loadNumber !== undefined || input.allLoads) return readTravelerData(tx, input.recordId, settings, input.loadNumber);
        // One load's sheet judges a layout (R17): the order is read once, here, and handed on, so
        // the first load is chosen from the loads `readDetail` already orders by number.
        const order = await readDetail(tx, input.recordId, settings.traffic);
        return readTravelerData(tx, input.recordId, settings, order.loads[0]?.loadNumber, order);
      });
      const defs = buildTravelerDefinitions(data, config, logoDataUri);
      if (config.layout === null) return bare(renderSheetGroups(defs));
      return measuredPreview(defs, config, config.layout,
        travelerCanvasItemContent(data, config, logoDataUri), completeCanvas);
    }
    case "SHIPPER":
    case "MOS_SHIPPER": {
      // The liability text binds at the DATA SEAM from the SUBMITTED config (the print path's shape).
      const settings = await ticketSettings();
      const data = await readOnly((tx) => readShippingTicketData(tx, input.recordId,
        { ...settings, liabilityText: config.textBlocks.shipper_liability_text }, undefined));
      // No seed ids and no placeholder serial line: a preview renders the real shipment, so a
      // shipment with no flagged serial shows no serial list and the measure reports it 0 tall.
      const defs = buildShippingTicketDefinitions(data, docType, config, logoDataUri);
      if (config.layout === null) return bare(renderSheetGroups(defs));
      // The first ticket's (the first order's) sheet group, as the traveler's is its first load's.
      const itemContent = ticketCanvasItemContent(data, docType, config, logoDataUri);
      return measuredPreview(defs, config, config.layout, itemContent, completeTicketCanvas);
    }
    case "BOL": {
      const settings = await bolSettings();
      const data = await readOnly(async (tx) => {
        const shipper = await tx.shipper.findFirst({
          where: { id: input.recordId }, select: { bolNumber: true, shipperNumber: true },
        });
        if (!shipper) throw new HttpError(404, "Shipment not found");
        // A preview NEVER allocates a BOL number (side-effect-free — §5.5): show the existing one, or
        // the shipper number as a sample stand-in when none has been printed yet.
        return readBolData(tx, input.recordId, shipper.bolNumber ?? shipper.shipperNumber, settings);
      });
      const def = buildBolDefinition(data, config, logoDataUri);
      if (config.layout === null) return bare(renderPdf(def));
      // A canvas bill of lading is ONE definition (one sheet group), its first page the measure's,
      // built without seed ids or a placeholder PO line: the preview renders the real shipment.
      return measuredPreview([def], config, config.layout,
        bolCanvasItemContent(data, config, logoDataUri), completeBolCanvas);
    }
    case "CERT": {
      const settings = await certPrintSettings();
      const signer = await prisma.user.findFirst({ where: { id: signerUserId }, select: CERT_SIGNER_SELECT });
      if (!signer) throw new HttpError(404, "User not found");
      // The cert_statement binds at the DATA SEAM from the SUBMITTED config (the print path's shape).
      const { data } = await readOnly((tx) => readCertPdfData(tx, input.recordId,
        { ...settings, statement: config.textBlocks.cert_statement }, signer, formatDateOnly(todayDateOnly())));
      const def = buildCertDefinition(data, config, logoDataUri);
      if (config.layout === null) return bare(renderPdf(def));
      // A canvas certification is ONE definition (one sheet group), its first page the measure's,
      // built without seed ids or the seed's stand-in: the preview renders the real certification.
      return measuredPreview([def], config, config.layout,
        certCanvasItemContent(data, config, logoDataUri), completeCertCanvas);
    }
    case "INVOICE": {
      const settings = await invoicePrintSettings();
      const data = await readOnly((tx) => readInvoicePdfData(tx, input.recordId, settings));
      return renderInvoiceCanvasPreview(data, config, logoDataUri);
    }
    case "STATEMENT": {
      // `buildStatement` opens its own RepeatableRead tx. Finance-charge assessment is FORCED OFF
      // (the write path on a real statement run — §5.5); asOf/combineFamily default today/false.
      const data = await buildStatement(input.recordId, {
        asOf: input.asOf, combineFamily: input.combineFamily ?? false, assessFinanceCharges: false,
      });
      return renderStatementCanvasPreview(data, config, logoDataUri);
    }
    case "QUOTE": {
      // The intro + liability texts bind at the DATA SEAM from the SUBMITTED config.
      const settings = await quotePrintSettings();
      const data = await readOnly((tx) => readQuotePdfData(tx, input.recordId, {
        ...settings,
        introText: config.textBlocks.quote_intro_text,
        liabilityText: config.textBlocks.quote_liability_text,
      }));
      return renderQuoteCanvasPreview(data, config, logoDataUri);
    }
    case "CONTAINER_TAG": {
      // The order's first tag, refused as the print route refuses (a 404, then two 400s). It prints
      // the submitted config, its flow or its canvas (`renderContainerTagPreview`), whose Logo item
      // prints the draft's logo.
      const order = await readOnly((tx) => readContainerTagsOrder(tx, input.recordId));
      if (!order) throw new HttpError(404, TAG_ORDER_NOT_FOUND);
      if (order.deletedAt !== null) throw new HttpError(400, TAG_ORDER_VOIDED);
      const { tags } = containerTagsData(order);
      if (tags.length === 0) throw new HttpError(400, TAG_NO_ROWS);
      return renderContainerTagPreview(tags[0], config, logoDataUri);
    }
    default: {
      const _exhaustive: never = docType;
      throw new Error(`Unhandled preview docType: ${String(_exhaustive)}`);
    }
  }
}
