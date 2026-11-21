import { beforeEach, describe, expect, it } from "vitest";
import { prisma, seedOrderGatePrereqs, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";
import { createOrder, updateLine } from "@/server/orders";
import { replaceLoads } from "@/server/order-loads";
import { getDocument, listDocumentsForOrder, storeDocument, type DocumentOwner } from "@/server/documents";
import { printSelectedTraveler, printTraveler } from "@/server/traveler";
import { parseTravelerPrintRecord, type TravelerPrintRecord } from "@/lib/traveler-print-record";
import { GET as documentsRoute } from "@/app/api/orders/[id]/documents/route";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "print-record-test" }, user: null }, fn);

const pdf = (marker: string) => Buffer.from(`%PDF-1.4 ${marker}`);

/**
 * One order of two lines whose three loads are set by hand, so each load's figures differ and
 * both nullable fields reach the database: load 2 has no weight and load 3 no quantity. The
 * rider's weight, 2.05, is one whose cents a plain multiplication gets wrong.
 *
 * Nothing here reads what `replaceLoads` or `updateLine` answer, so this file does not care
 * whether they answer the bare order or `{ order, warnings }`.
 */
async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "RECORD", name: "Print Record Demo" } });
  const code = await prisma.processStepCode.create({ data: { code: "HT", name: "Heat" } });
  const lead = await prisma.part.create({ data: {
    customerId: customer.id, partNumber: "REC-LEAD", eachWeight: "1.0000", loadQty: 10,
  } });
  const rider = await prisma.part.create({ data: {
    customerId: customer.id, partNumber: "REC-RIDER", eachWeight: "0.5125",
  } });
  const revision = await prisma.partProcessRevision.create({ data: { partId: lead.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({ data: {
    revisionId: revision.id, position: 1, codeId: code.id, instruction: "Heat the recorded work",
  } });
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id,
    lines: [{ partId: lead.id, qty: 30, weight: "30.00" }, { partId: rider.id, qty: 4, weight: "2.05" }],
  }));
  await asSystem(() => replaceLoads(order.id, [
    { loadNumber: 1, qty: 12, weight: "12.25" },
    { loadNumber: 2, qty: 10, weight: null },
    { loadNumber: 3, qty: null, weight: "9.80" },
  ]));
  const lines = [
    { partId: lead.id, qty: 30, weightCents: 3000 },
    { partId: rider.id, qty: 4, weightCents: 205 },
  ];
  return { order, lead, rider, lines };
}

const LOAD_1 = { loadNumber: 1, qty: 12, weightCents: 1225 };
const LOAD_2 = { loadNumber: 2, qty: 10, weightCents: null };
const LOAD_3 = { loadNumber: 3, qty: null, weightCents: 980 };

/** The record the order's document list hands out for one stored document. */
async function recordOf(orderId: string, documentId: string): Promise<TravelerPrintRecord | null> {
  const row = (await listDocumentsForOrder(orderId)).find((doc) => doc.id === documentId);
  if (!row) throw new Error("the document is not on the order's list");
  return parseTravelerPrintRecord(row.travelerPrintRecord);
}

describe("what a traveler print stores", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("an all-loads print records every line and every load, and the record rides in its audit entry", async () => {
    const { order, lines } = await fixture();
    const printed = await asSystem(() => printTraveler(order.id));
    expect(await recordOf(order.id, printed.documentId))
      .toStrictEqual({ v: 1, lines, loads: [LOAD_1, LOAD_2, LOAD_3] });

    const stored = await prisma.storedDocument.findUniqueOrThrow({
      where: { id: printed.documentId }, select: { travelerPrintRecord: true } });
    expect(typeof stored.travelerPrintRecord).toBe("string");
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entity: "storedDocument", entityId: printed.documentId, action: "create" } });
    expect((entry.after as Record<string, unknown>).travelerPrintRecord).toBe(stored.travelerPrintRecord);
  });

  it("a one-load print records every line and that load alone", async () => {
    const { order, lines } = await fixture();
    const printed = await asSystem(() => printTraveler(order.id, 2));
    expect(await recordOf(order.id, printed.documentId)).toStrictEqual({ v: 1, lines, loads: [LOAD_2] });
  });

  it("a selected-loads print records every line and the loads selected, ascending", async () => {
    const { order, lines } = await fixture();
    const printed = await asSystem(() => printSelectedTraveler(order.id, { mode: "loads", loadNumbers: [3, 1] }));
    expect(await recordOf(order.id, printed.documentId)).toStrictEqual({ v: 1, lines, loads: [LOAD_1, LOAD_3] });
  });

  it("a print of an order with no loads records no load", async () => {
    const { order, lines } = await fixture();
    // Legacy imported orders may have no loads; the editor requires at least one.
    await prisma.load.deleteMany({ where: { orderId: order.id } });
    const printed = await asSystem(() => printTraveler(order.id));
    expect(await recordOf(order.id, printed.documentId)).toStrictEqual({ v: 1, lines, loads: [] });
  });

  it("keeps the print-time figures after a line edit and a loads save; the next print records the new ones", async () => {
    const { order, lead, rider, lines } = await fixture();
    const before = await asSystem(() => printTraveler(order.id));

    await asSystem(() => updateLine(order.id, order.lines[0].id, { qty: 20, weight: "20.00" }));
    await asSystem(() => replaceLoads(order.id, [{ loadNumber: 1, qty: 24, weight: "22.05" }]));

    expect(await recordOf(order.id, before.documentId))
      .toStrictEqual({ v: 1, lines, loads: [LOAD_1, LOAD_2, LOAD_3] });
    const after = await asSystem(() => printTraveler(order.id));
    expect(await recordOf(order.id, after.documentId)).toStrictEqual({
      v: 1,
      lines: [{ partId: lead.id, qty: 20, weightCents: 2000 }, { partId: rider.id, qty: 4, weightCents: 205 }],
      loads: [{ loadNumber: 1, qty: 24, weightCents: 2205 }],
    });
  });
});

describe("who carries a record, and where it is read", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("the order's list and its route hand the record out; a traveler stored with none reads null", async () => {
    const { order } = await fixture();
    const printed = await asSystem(() => printTraveler(order.id, 1));
    // A row as every traveler printed before this column existed is: no record.
    const bare = await asSystem(() => prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "TRAVELER", orderId: order.id, loadNumber: null }, pdf("no record"))));

    const docs = await listDocumentsForOrder(order.id);
    const text = docs.find((doc) => doc.id === printed.documentId)?.travelerPrintRecord;
    expect(parseTravelerPrintRecord(text)?.loads).toStrictEqual([LOAD_1]);
    expect(docs.find((doc) => doc.id === bare.id)?.travelerPrintRecord).toBeNull();

    const cookie = await signInWith(["orders.view"]);
    const response = await documentsRoute(
      new Request(`http://t/api/orders/${order.id}/documents`, { headers: { cookie } }),
      { params: Promise.resolve({ id: order.id }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { id: string; travelerPrintRecord?: string | null }[];
    expect(Object.fromEntries(body.map((doc) => [doc.id, doc.travelerPrintRecord])))
      .toStrictEqual({ [printed.documentId]: text, [bare.id]: null });
  });

  it("a document that is not a traveler stores no record", async () => {
    const { order, lines } = await fixture();
    const cert = await prisma.cert.create({ data: { orderId: order.id, scope: "ORDER" } });
    const record: TravelerPrintRecord = { v: 1, lines, loads: [LOAD_1] };
    // The type refuses this owner, and the directive pins that for the CERT arm alone: `tsc`
    // checks a literal's keys against the arm its `kind` picks, so only a `printRecord` on the
    // CERT arm makes the directive unused. `noOtherArm` below holds the same for every arm.
    // vitest does not type-check: both are `tsc`'s to report, and neither can turn this case red.
    // @ts-expect-error only the traveler arm of DocumentOwner can carry a print record
    const owner: DocumentOwner = { kind: "CERT", certId: cert.id, printRecord: record };
    // Every arm of DocumentOwner, the traveler's left out, that has a `printRecord` key. There is
    // none, so the list is `never` and the annotation below is `true`. Give any other arm the
    // key, a new arm included, and the annotation is `false`, which `true` does not fit.
    type ArmsWithARecord<Arm> = Arm extends unknown ? ("printRecord" extends keyof Arm ? Arm : never) : never;
    const noOtherArm: [ArmsWithARecord<Exclude<DocumentOwner, { kind: "TRAVELER" }>>] extends [never] ? true : false = true;
    void noOtherArm;
    const certDoc = await asSystem(() => prisma.$transaction((tx) => storeDocument(tx, owner, pdf("cert"))));

    const row = await prisma.storedDocument.findUniqueOrThrow({
      where: { id: certDoc.id }, select: { kind: true, travelerPrintRecord: true } });
    expect(row).toStrictEqual({ kind: "CERT", travelerPrintRecord: null });
    expect((await listDocumentsForOrder(order.id)).find((doc) => doc.id === certDoc.id))
      .toMatchObject({ kind: "CERT", travelerPrintRecord: null });
  });

  it("only the order's list carries the column: a stored document's own metadata does not", async () => {
    const { order } = await fixture();
    const printed = await asSystem(() => printTraveler(order.id));
    const meta = await asSystem(() => prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "TRAVELER", orderId: order.id, loadNumber: 1 }, pdf("meta"))));
    expect(meta).not.toHaveProperty("travelerPrintRecord");
    expect(await getDocument(printed.documentId)).not.toHaveProperty("travelerPrintRecord");
  });
});
