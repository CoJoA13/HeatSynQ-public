import type { ExternalLoadV1 } from "@/lib/external-load-contract";
import { parseRecipeSnapshot } from "@/lib/recipe-snapshot";
import { prisma } from "./db";
import { HttpError } from "./errors";

/** Resolve today's load identity and the lead line's saved revision in one coherent view.
 * This path never captures a snapshot or invokes session/audit mutation machinery. */
export async function readExternalLoad(orderNumber: number, loadNumber: number): Promise<ExternalLoadV1> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const order = await tx.order.findFirst({
      where: { orderNumber, deletedAt: null },
      select: { id: true, orderNumber: true,
        customer: { select: { id: true, code: true, name: true } },
        loads: { where: { loadNumber }, select: { id: true, loadNumber: true, qty: true, weight: true } },
        lines: { where: { position: 1 }, select: { partId: true, revisionNumber: true,
          part: { select: { id: true, partNumber: true, name: true } } } },
      },
    });
    const load = order?.loads[0];
    if (!order || !load) throw new HttpError(404, "Not found");
    const lead = order.lines[0];
    if (!lead) throw new Error("Missing lead line");
    const revision = lead.revisionNumber === null ? null : await tx.partProcessRevision.findUnique({
      where: { partId_revisionNumber: { partId: lead.partId, revisionNumber: lead.revisionNumber } },
      select: { recipeId: true, recipeSnapshot: true },
    });
    let recipe: ExternalLoadV1["recipe"];
    // Validate every non-null snapshot before classifying legacy rows. Malformed stored
    // data is an unavailable service, never a silently downgraded legacy response.
    const snapshot = revision?.recipeSnapshot == null ? null : parseRecipeSnapshot(revision.recipeSnapshot);
    if (!revision) recipe = { status: "legacy_snapshot_unavailable", snapshot: null };
    else if (!revision.recipeId) recipe = { status: "no_numbered_recipe", snapshot: null };
    else if (!snapshot) recipe = { status: "legacy_snapshot_unavailable", snapshot: null };
    else recipe = { status: "available", snapshot };

    return {
      schemaVersion: 1,
      order: { id: order.id, orderNumber: order.orderNumber },
      load: { id: load.id, loadNumber: load.loadNumber, qty: load.qty,
        weight: { value: load.weight?.toString() ?? null, unit: "lb" } },
      customer: order.customer,
      leadPart: { id: lead.part.id, partNumber: lead.part.partNumber, partName: lead.part.name },
      recipe,
    };
  }, { isolationLevel: "RepeatableRead" });
}
