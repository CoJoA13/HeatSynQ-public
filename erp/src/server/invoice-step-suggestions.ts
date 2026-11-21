import { Prisma } from "../../prisma/generated/prisma/client";
import type { InvoiceStepSuggestions, StepSuggestion } from "../lib/invoice-step-suggestions";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { getRevisionContentUnchecked } from "./part-process-steps";

/**
 * The step suggestions an invoice's operation lines offer (#587, Amendment 22), behind
 * `GET /api/invoices/[id]/step-suggestions`. Its own module so it never imports `invoices.ts`.
 *
 * Per order line: the lead line (the one carrying `revisionNumber`) lists the steps of the revision
 * its order saved (ruling 587-11), so a later revision of the part changes nothing there; they
 * carry the names its snapshot captured where the saved revision carries a numbered recipe (its names
 * as captured at its first lock), else the codes' current names (`getRevisionContentUnchecked` reads
 * no snapshot otherwise). Every other line lists its part's latest revision, under the codes' current
 * names; a part with no revision lists none.
 * Each list names a step code once, where it first appears. `others` is every live, active step
 * code, ordered by code; the page leaves out the line's own steps.
 *
 * The lead read goes through `getRevisionContentUnchecked`, the reader its own header restricts to
 * callers anchored on a stored (partId, revisionNumber) pair they may read. This one is: the pair is
 * the order's own lead line, reached from the invoice the caller named, and the route gates on
 * `invoicing.view` (ruling 587-9, visible to anyone with invoicing view). Neither read checks the
 * part is live: a draft can sit on an order whose part has since been deleted, and the order's
 * paperwork stays readable. Only `{ id, code, name }` of each step leaves here, never an
 * instruction, a parameter or a recipe number, so the unchecked reader is not exposed in general.
 *
 * A pure read: one read-only RepeatableRead transaction, so the lines, their revisions and the code
 * list agree; no claim, no audit, no write. `SET TRANSACTION READ ONLY` is its first statement (the
 * `previewOrderEntry` precedent), so the database refuses a write that ever reaches it.
 */
export async function invoiceStepSuggestions(invoiceId: string): Promise<InvoiceStepSuggestions> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId, deletedAt: null }, select: { orderId: true },
    });
    if (!invoice) throw new HttpError(404, "Invoice not found");
    const lines = await tx.orderLine.findMany({
      where: { orderId: invoice.orderId }, orderBy: { position: "asc" },
      select: { id: true, partId: true, revisionNumber: true },
    });
    const latest = await latestStepsByPart(tx, lines.filter((l) => l.revisionNumber === null).map((l) => l.partId));
    const byOrderLine: Record<string, StepSuggestion[]> = {};
    for (const line of lines) {
      byOrderLine[line.id] = onceEach(line.revisionNumber !== null
        ? await savedSteps(tx, line.partId, line.revisionNumber)
        : latest.get(line.partId) ?? []);
    }
    const others = await tx.processStepCode.findMany({
      where: { deletedAt: null, active: true }, orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    });
    return { byOrderLine, others };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/** The lead line's saved revision: its captured names where the saved revision carries a numbered
 *  recipe (its names as captured at its first lock), else its codes' current names. */
async function savedSteps(
  tx: Prisma.TransactionClient, partId: string, revisionNumber: number,
): Promise<StepSuggestion[]> {
  const revision = await getRevisionContentUnchecked(partId, revisionNumber, tx);
  return revision.steps.map((s) => ({ id: s.codeId, code: s.code, name: s.codeName }));
}

/** Each part's latest revision (`readProcessDocumentProjection`'s "current" revision), its codes
 *  joined live, by part id; a part with no revision has no entry. Two reads whatever the number of
 *  lines (#622: two per line before): every revision's number for these parts, then the steps of
 *  each part's newest. Only the riders read here; the lead keeps its saved revision (ruling 587-11). */
async function latestStepsByPart(
  tx: Prisma.TransactionClient, partIds: string[],
): Promise<Map<string, StepSuggestion[]>> {
  const out = new Map<string, StepSuggestion[]>();
  if (partIds.length === 0) return out;
  const revisions = await tx.partProcessRevision.findMany({
    where: { partId: { in: [...new Set(partIds)] } },
    orderBy: [{ partId: "asc" }, { revisionNumber: "desc" }],
    select: { id: true, partId: true },
  });
  const newest = new Map<string, string>(); // revision id → part id: each part's first, its newest
  const seen = new Set<string>();
  for (const r of revisions) {
    if (seen.has(r.partId)) continue;
    seen.add(r.partId); newest.set(r.id, r.partId);
  }
  const steps = await tx.partProcessStep.findMany({
    where: { revisionId: { in: [...newest.keys()] } },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: { revisionId: true, code: { select: { id: true, code: true, name: true } } },
  });
  for (const partId of newest.values()) out.set(partId, []);
  for (const s of steps) out.get(newest.get(s.revisionId)!)!.push(s.code);
  return out;
}

/** Each step code once, where it first appears. */
function onceEach(steps: StepSuggestion[]): StepSuggestion[] {
  const seen = new Set<string>();
  return steps.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}
