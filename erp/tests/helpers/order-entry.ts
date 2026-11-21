import { prisma } from "./db";

/**
 * Fictional order-entry fixture built with raw Prisma writes. Callers own database cleanup and
 * the order-entry gate prerequisites so this helper stays usable by service and route tests.
 * Only the lead has process steps; the step-less rider keeps the rider exemption exercised.
 */
export async function entryFixture() {
  const customer = await prisma.customer.create({
    data: { code: "DEMO", name: "Demo Heat Treat Customer", active: true },
  });
  const code = await prisma.processStepCode.create({
    data: { code: "HT-008", name: "Demo heat treatment" },
  });
  const lead = await prisma.part.create({
    data: {
      customerId: customer.id,
      partNumber: "DEMO-008",
      name: "Demo lead",
      eachWeight: "127.0000",
      loadQty: 15,
    },
  });
  const rider = await prisma.part.create({
    data: {
      customerId: customer.id,
      partNumber: "DEMO-008-R",
      name: "Demo rider",
      eachWeight: "127.0000",
    },
  });
  const revision = await prisma.partProcessRevision.create({
    data: { partId: lead.id, revisionNumber: 1 },
  });
  await prisma.partProcessStep.createMany({
    data: [
      { revisionId: revision.id, position: 1, codeId: code.id, instruction: "Preheat to 900F." },
      { revisionId: revision.id, position: 2, codeId: code.id, instruction: "Austenitize at 1650F." },
      { revisionId: revision.id, position: 3, codeId: code.id, instruction: "Quench in oil." },
    ],
  });
  return { customer, lead, rider, code };
}
