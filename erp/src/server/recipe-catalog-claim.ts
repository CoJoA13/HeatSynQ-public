import type { Prisma } from "../../prisma/generated/prisma/client";

/** A row-version claim, ordered across codes to avoid opposite-order deadlocks. Unlike an
 * advisory lock, this makes a Serializable waiter retry its stale snapshot. No business
 * metadata (including updatedAt) changes. All catalog writers claim before reading metadata. */
export async function claimRecipeCodes(tx: Prisma.TransactionClient, codeIds: readonly string[]): Promise<void> {
  for (const codeId of [...new Set(codeIds)].sort()) {
    await tx.$executeRaw`UPDATE "ProcessStepCode" SET "id" = "id" WHERE "id" = ${codeId}`;
  }
}
