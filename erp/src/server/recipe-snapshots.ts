import type { Prisma } from "../../prisma/generated/prisma/client";
import { parseRecipeSnapshot, recipeFieldFromParameter } from "../lib/recipe-snapshot";
import { claimRecipeCodes } from "./recipe-catalog-claim";

/** Called only by the winning first lock, inside its audited transaction. The caller already
 * holds the part/revision/identity claims; step IDs and code assignments cannot change.
 * `fields` lists the step's own parameter rows in position order (spec 2026-09-26 §3.4): the key
 * is the captured `fieldDefId`, and label, type and unit are the row's own. Capture writes no
 * `RecipeSnapshotField` membership any more; key immutability (§3.3) carries that meaning. */
export async function captureRecipeSnapshot(tx: Prisma.TransactionClient, revisionId: string): Promise<void> {
  const revision = await tx.partProcessRevision.findUniqueOrThrow({
    where: { id: revisionId }, include: { recipe: true, steps: { select: { codeId: true } } },
  });
  if (!revision.recipe || revision.recipeSnapshot !== null) return;
  await claimRecipeCodes(tx, revision.steps.map((step) => step.codeId));
  // Code names are still captured under the catalog claims and must be read AFTER them. Read
  // Committed sees the winner's commit; Serializable cannot continue with an older projection
  // after a competing row-version write.
  const steps = await tx.partProcessStep.findMany({
    where: { revisionId }, orderBy: [{ position: "asc" }, { id: "asc" }],
    include: {
      code: { select: { code: true, name: true } },
      parameters: { orderBy: [{ position: "asc" }, { id: "asc" }] },
    },
  });
  const captured = parseRecipeSnapshot({
    schemaVersion: 1, recipeId: revision.recipe.id, recipeNumber: revision.recipe.number,
    partId: revision.partId, revisionNumber: revision.revisionNumber,
    steps: steps.map((step) => ({
      stepId: step.id, position: step.position, codeId: step.codeId,
      code: step.code.code, codeName: step.code.name, instruction: step.instruction,
      fields: step.parameters.map(recipeFieldFromParameter),
    })),
  });
  await tx.partProcessRevision.update({ where: { id: revisionId }, data: { recipeSnapshot: captured } });
}
