import type { Prisma } from "../../prisma/generated/prisma/client";
import { HttpError } from "./errors";
import { travelerCustomerContact, travelerInspections, type TravelerData, type TravelerSettings } from "./traveler";

/**
 * The SAMPLE preview's data (design spec 2026-09-26 §5): the part's real details around the
 * caller's draft steps, with no order. Quantities and containers are blank, the order number and
 * load read SAMPLE (`buildTravelerDefinition`/`buildTravelerDefinitions` do the actual swap, keyed
 * off `sample: true`), and no order number is invented. A pure read — `db` never sees a write.
 *
 * `steps` is always `[]` here: this function knows nothing about the caller's in-progress draft
 * (saved or not), so the preview service (Task 6) fills it in from whatever the caller is editing.
 */
export async function readSampleTravelerData(
  db: Prisma.TransactionClient, partId: string, settings: TravelerSettings,
  options: { includeCustomerContact: boolean },
): Promise<TravelerData> {
  const part = await db.part.findFirst({
    where: { id: partId, deletedAt: null },
    select: {
      partNumber: true, name: true, description: true, eachWeight: true, processName: true,
      customerId: true, material: { select: { name: true } }, customer: { select: { name: true } },
    },
  });
  if (!part) throw new HttpError(404, "Part not found");
  const contact = options.includeCustomerContact
    ? await travelerCustomerContact(db, part.customerId)
    : { receivedFrom: [], phone: "" };
  return {
    sample: true,
    orderNumber: 0,
    // A SAMPLE has no order, so the blank prints (owner, 2026-10-17), whatever the caller may see
    // of customers, because the PO is order data.
    poNumber: "",
    customerName: part.customer.name,
    receivedFrom: contact.receivedFrom,
    customerPhone: contact.phone,
    company: settings.company,
    lines: [{
      qty: null, partNumber: part.partNumber, partName: part.name, description: part.description,
      // Part.eachWeight is a required Decimal (never null) — the same mapping readTravelerData
      // uses for a real line's part (pre-flight C, T5-3).
      eachWeight: part.eachWeight.toNumber(), lineWeight: null,
    }],
    orderQty: null, containers: [],
    materialName: part.material?.name ?? "", processName: part.processName, processId: part.partNumber,
    inspections: await travelerInspections(db, partId),
    revisionNumber: null, steps: [],
    sheets: [{ loadNumber: null, loadQty: null, loadWeight: null, barcodeDataUri: "" }],
  };
}
