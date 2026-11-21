import { beforeEach, expect, it } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { deleteFixtureAttachments } from "../e2e/lib/attachment-cleanup";

beforeEach(truncateAll);

it.each(["part", "order"] as const)("reaps only the supplied %s owners' attachments and audit entries", async (owner) => {
  const customer = await prisma.customer.create({ data: { code: "ATT-CLEANUP", name: "Attachment cleanup" } });
  const ownerIds: string[] = [];
  const attachmentIds: string[][] = [];
  for (const n of [1, 2]) {
    const record = owner === "part"
      ? await prisma.part.create({ data: { customerId: customer.id, partNumber: `ATT-${n}`, eachWeight: 1 } })
      : await prisma.order.create({ data: {
        customerId: customer.id, orderNumber: n, receivedDate: new Date(), requestDate: new Date(),
      } });
    ownerIds.push(record.id);
    const ids: string[] = [];
    for (const deletedAt of [null, new Date()]) {
      const data = { filename: "scan.txt", mimeType: "text/plain", size: 1, fileData: Buffer.from("x"), deletedAt };
      const attachment = owner === "part"
        ? await prisma.partAttachment.create({ data: { ...data, partId: record.id } })
        : await prisma.orderAttachment.create({ data: { ...data, orderId: record.id } });
      ids.push(attachment.id);
      await prisma.auditLog.create({ data: {
        actorName: "test", entity: `${owner}Attachment`, entityId: attachment.id, action: "create",
      } });
    }
    attachmentIds.push(ids);
  }
  // Entity names must scope audit deletion even if an unrelated entity has the same ID.
  const unrelated = await prisma.auditLog.create({ data: {
    actorName: "test", entity: "unrelated", entityId: attachmentIds[0][0], action: "create",
  } });
  const remaining = () => owner === "part" ? prisma.partAttachment.findMany() : prisma.orderAttachment.findMany();
  await deleteFixtureAttachments(prisma, owner, []);
  expect(await remaining()).toHaveLength(4);
  expect(await prisma.auditLog.count()).toBe(5);

  await deleteFixtureAttachments(prisma, owner, [ownerIds[0]]);
  await deleteFixtureAttachments(prisma, owner, [ownerIds[0]]); // repeated cleanup is harmless
  expect((await remaining()).map((row) => row.id).sort()).toEqual(attachmentIds[1].sort());
  expect(await prisma.auditLog.findMany({ where: { entityId: { in: attachmentIds[0] }, entity: `${owner}Attachment` } })).toEqual([]);
  expect(await prisma.auditLog.count()).toBe(3);
  expect(await prisma.auditLog.findUnique({ where: { id: unrelated.id } })).not.toBeNull();
  // Prove the restrict-on-delete children are gone, including the soft-deleted one.
  if (owner === "part") await prisma.part.delete({ where: { id: ownerIds[0] } });
  else await prisma.order.delete({ where: { id: ownerIds[0] } });
});
