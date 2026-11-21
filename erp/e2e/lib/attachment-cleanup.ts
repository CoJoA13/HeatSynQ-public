import type { PrismaClient } from "../../prisma/generated/prisma/client";

// Shared by normal teardown and interrupted-run recovery. UI deletion is soft, so include
// deleted attachments and remove their audit rows by attachment ID before deleting the owner.
export async function deleteFixtureAttachments(
  prisma: PrismaClient, owner: "part" | "order", ownerIds: string[],
): Promise<void> {
  if (ownerIds.length === 0) return;
  const attachments = owner === "part"
    ? await prisma.partAttachment.findMany({ where: { partId: { in: ownerIds } }, select: { id: true } })
    : await prisma.orderAttachment.findMany({ where: { orderId: { in: ownerIds } }, select: { id: true } });
  const ids = attachments.map((attachment) => attachment.id);
  if (ids.length === 0) return;
  await prisma.auditLog.deleteMany({ where: { entity: `${owner}Attachment`, entityId: { in: ids } } });
  if (owner === "part") await prisma.partAttachment.deleteMany({ where: { id: { in: ids } } });
  else await prisma.orderAttachment.deleteMany({ where: { id: { in: ids } } });
}
