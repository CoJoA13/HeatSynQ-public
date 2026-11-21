import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { assertProcessSize, parseProcessDocument, type ProcessDocumentInput } from "@/lib/process-document";
import { deletedAddedCodes, readProcessDocumentProjection, validateProcessDocumentDraft } from "./process-document";
import { validateStepValue } from "./part-process-steps";
import { travelerSettings, readTravelerData, buildTravelerDefinitions, type TravelerStep } from "./traveler";
import { readSampleTravelerData } from "./traveler-sample";
import { resolveTemplateForPrint } from "./template-assignments";
import { templatePlacesLogo } from "@/lib/template-contracts/template-logo";
import { renderDraftTraveler, jpegDataUri, pngDataUri } from "./pdf/render";

export type ProcessPreviewContext = { orderId: string; orderNumber: number; loadNumber: number };
/** `context: null` asks for the SAMPLE preview (spec 2026-09-26 §5): the part's own details around
 *  the draft, with no order. The key itself is required, so a request that forgot its context is a
 *  400, never a silent SAMPLE. */
export type ProcessPreviewInput = ProcessDocumentInput & { context: ProcessPreviewContext | null; generation: number };
/** What the caller may see besides the part and its process, derived by the route from the session:
 *  `orders` allows a real order's preview, `customers` the SAMPLE header's received-from address and
 *  phone. Required with no default, so a caller that forgets it can never grant order access. */
export type ProcessPreviewAccess = { orders: boolean; customers: boolean };
const positive = z.number().int().min(1).max(2_147_483_647);
const contextSchema = z.object({ orderId: z.string().min(1), orderNumber: positive, loadNumber: positive }).strict();
const envelope = z.object({ context: contextSchema.nullable(), generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), expectedBaselineToken: z.unknown(), steps: z.unknown() }).strict();
const cursorSchema = z.object({ orderNumber: positive, loadNumber: positive }).strict();
type Projection = Awaited<ReturnType<typeof readProcessDocumentProjection>>;

export async function listProcessPreviewContexts(partId: string, query: string, cursor?: string): Promise<{ items: ProcessPreviewContext[]; nextCursor: string | null }> {
  let after: z.infer<typeof cursorSchema> | undefined;
  if (cursor) {
    try { after = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))); }
    catch { throw new HttpError(400, "Invalid preview context cursor"); }
  }
  const search = z.string().max(100).parse(query).trim();
  return prisma.$transaction(async tx => {
    if (!await tx.part.findFirst({ where: { id: partId, deletedAt: null }, select: { id: true } })) throw new HttpError(404, "Part not found");
    // Search is an exact saved order number; no synthetic order/load is ever produced.
    if (search && (!/^\d+$/.test(search) || Number(search) > 2_147_483_647)) return { items: [], nextCursor: null };
    // Newest first (spec 2026-09-26 §5): the first item, the highest order number with its lowest
    // load, is the default the preview selects. So the cursor walks order numbers down and each
    // order's loads up. Only orders with loads are listed, and a voided order never is.
    const loads = await tx.load.findMany({
      where: {
        order: { deletedAt: null, lines: { some: { position: 1, partId } }, ...(search ? { orderNumber: Number(search) } : {}) },
        ...(after ? { OR: [{ order: { orderNumber: { lt: after.orderNumber } } }, { order: { orderNumber: after.orderNumber }, loadNumber: { gt: after.loadNumber } }] } : {}),
      },
      orderBy: [{ order: { orderNumber: "desc" } }, { loadNumber: "asc" }], take: 26,
      select: { loadNumber: true, orderId: true, order: { select: { orderNumber: true } } },
    });
    const items = loads.slice(0, 25).map(l => ({ orderId: l.orderId, orderNumber: l.order.orderNumber, loadNumber: l.loadNumber }));
    const last = items.at(-1);
    return { items, nextCursor: loads.length > 25 && last ? Buffer.from(JSON.stringify({ orderNumber: last.orderNumber, loadNumber: last.loadNumber })).toString("base64url") : null };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/** The SAMPLE's customer is the part's own; a part that is not live is a 404. */
async function sampleCustomerId(tx: Prisma.TransactionClient, partId: string): Promise<string> {
  const part = await tx.part.findFirst({ where: { id: partId, deletedAt: null }, select: { customerId: true } });
  if (!part) throw new HttpError(404, "Part not found");
  return part.customerId;
}

/** The selected order's customer, once the order, its lead part and the load are proven current. */
async function orderCustomerId(tx: Prisma.TransactionClient, partId: string, context: ProcessPreviewContext): Promise<string> {
  const order = await tx.order.findFirst({ where: { id: context.orderId, deletedAt: null }, select: { orderNumber: true, customerId: true, lines: { where: { position: 1 }, select: { partId: true } } } });
  if (!order) throw new HttpError(404, "Order not found");
  if (order.orderNumber !== context.orderNumber || order.lines[0]?.partId !== partId) throw new HttpError(409, "The selected order no longer matches this process lead part and order number");
  if (!await tx.load.findUnique({ where: { orderId_loadNumber: { orderId: context.orderId, loadNumber: context.loadNumber } }, select: { id: true } })) throw new HttpError(404, "The selected load no longer exists");
  return order.customerId;
}

/** The draft's steps as the traveler prints them: one projection for an order and a SAMPLE.
 *  Both render the revision's own parameter rows, as the editor shows them (owner 2026-09-27): an
 *  unchanged document shows its saved rows — a revision captured before part-owned rows still
 *  prints its captured projection on its orders, but the editor previews what it would save. An
 *  edited document projects the same trimmed storage values as save. Empty values stay; the
 *  builder prints them as handwriting blanks. */
function draftTravelerSteps(before: Projection, document: ProcessDocumentInput, unchanged: boolean): TravelerStep[] {
  return unchanged ? (before.baseline.revision?.steps ?? []).map(s => ({
    position: s.position, codeName: s.codeName, instruction: s.instruction,
    values: s.parameters.map(p => ({ label: p.label, value: p.value, unit: p.unit })),
  })) : document.steps.map((s, index) => {
    const code = before.baseline.codes.find(c => c.id === s.codeId)!;
    return { position: index + 1, codeName: code.name, instruction: s.instruction,
      values: s.parameters.map(p => ({ label: p.label, value: validateStepValue(p, p.value), unit: p.unit })),
    };
  });
}

export async function renderProcessTravelerPreview(partId: string, input: unknown, access: ProcessPreviewAccess): Promise<{ pdf: Buffer; pageCount: number; generation: number; templateId: string; templateName: string; sample: boolean }> {
  assertProcessSize(input);
  const parsed = envelope.parse(input);
  const { context, generation } = parsed;
  // A real order needs orders.view (spec 2026-09-26 §5). Refused before the transaction opens, so a
  // refused request reads nothing: not whether the order, its load, the part or the baseline exist.
  if (context !== null && !access.orders) throw new HttpError(403, "Previewing an order needs orders.view access");
  const document = parseProcessDocument({ expectedBaselineToken: parsed.expectedBaselineToken, steps: parsed.steps });
  const snapshot = await prisma.$transaction(async tx => {
    const customerId = context === null ? await sampleCustomerId(tx, partId) : await orderCustomerId(tx, partId, context);
    const before = await readProcessDocumentProjection(tx, partId);
    const unchanged = validateProcessDocumentDraft(before, document, await deletedAddedCodes(tx, before, document));
    const settings = await travelerSettings(tx);
    // SAMPLE (spec §5): the part's real details with no order read, the customer name always, and
    // the received-from address and phone only for a caller who may view customers.
    const data = context === null
      ? await readSampleTravelerData(tx, partId, settings, { includeCustomerContact: access.customers })
      : await readTravelerData(tx, context.orderId, settings, context.loadNumber, undefined, { readRevision: false });
    const template = await resolveTemplateForPrint(tx, "TRAVELER", customerId);
    data.revisionNumber = before.baseline.revision?.revisionNumber ?? null;
    data.steps = draftTravelerSteps(before, document, unchanged);
    const templateIdentity = await tx.documentTemplate.findUniqueOrThrow({ where: { id: template.templateId }, select: { name: true } });
    return { data, template, templateName: templateIdentity.name };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  const { data, template } = snapshot;
  const logo = template.logoImage !== null && templatePlacesLogo(template.config)
    ? (template.logoMimeType === "image/jpeg" ? jpegDataUri : pngDataUri)(Buffer.from(template.logoImage)) : undefined;
  const result = await renderDraftTraveler(buildTravelerDefinitions(data, template.config, logo));
  return { ...result, generation, templateId: template.templateId, templateName: snapshot.templateName, sample: data.sample === true };
}
