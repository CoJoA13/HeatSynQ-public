import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { readAudit } from "@/server/audit";
import { createOrder, addLine, type OrderDetail } from "@/server/orders";
import { addPartInspection } from "@/server/part-inspections";
import { createCert, getCert, type CertDetail } from "@/server/certs";
import { readableMessage } from "@/server/error-message";
import { replaceReadings } from "@/server/cert-results";
import type { Customer, Part } from "../prisma/generated/prisma/client";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({ data: { code: `CR${customerSeq}`, name: `Cert Results Customer ${customerSeq}` } });
}

let partSeq = 0;
async function makePart(customerId: string): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({ data: { customerId, partNumber: `CRP-${partSeq}`, eachWeight: "1.0000" } });
}

/** Gives a part revision 1 with one step — the orderability precondition createOrder enforces
 *  (spec §5.3), the certs.test.ts precedent. Only the LEAD line needs this: `resolveLineParts`
 *  locks the lead's own revision, never a rider's. */
async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `HT-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

let codeSeq = 0;
async function makeInspectionCode(): Promise<{ id: string }> {
  codeSeq += 1;
  return prisma.inspectionCode.create({ data: { name: `Hardness-${codeSeq}` } });
}

/** Lead part carries 2 live inspections, rider carries 1 — the brief's exact fixture shape for
 *  asserting seed order (lines in `position` order, each line's inspections in the part's own
 *  `sort` order, one cert-wide running `position`). */
async function twoLineOrder(): Promise<{ order: OrderDetail; leadPart: Part; riderPart: Part }> {
  const customer = await makeCustomer();
  const leadPart = await makePart(customer.id);
  const riderPart = await makePart(customer.id);
  await giveSteps(leadPart.id);

  const code = await makeInspectionCode();
  await asSystem(() => addPartInspection(leadPart.id, { inspectionCodeId: code.id, sort: 1 }));
  await asSystem(() => addPartInspection(leadPart.id, { inspectionCodeId: code.id, sort: 0 }));
  await asSystem(() => addPartInspection(riderPart.id, { inspectionCodeId: code.id, sort: 0 }));

  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber: "",
    lines: [
      { partId: leadPart.id, qty: 10, weight: "25.00" },
      { partId: riderPart.id, qty: 5, weight: "10.00" },
    ],
  }));
  return { order, leadPart, riderPart };
}

/** A single-line order whose lead part carries exactly one inspection, with the given min/max. */
async function oneLineOrder(
  opts: { min?: number; max?: number; qty?: number; loadQty?: number | null } = {},
): Promise<{ order: OrderDetail; leadPart: Part; inspection: { id: string } }> {
  const customer = await makeCustomer();
  const leadPart = await prisma.part.create({
    data: {
      customerId: customer.id, partNumber: `CRP-${++partSeq}`, eachWeight: "1.0000",
      loadQty: opts.loadQty ?? null,
    },
  });
  await giveSteps(leadPart.id);
  const code = await makeInspectionCode();
  const inspection = await asSystem(() => addPartInspection(leadPart.id, {
    inspectionCodeId: code.id, sort: 0,
    ...(opts.min !== undefined ? { min: opts.min } : {}),
    ...(opts.max !== undefined ? { max: opts.max } : {}),
  }));

  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber: "",
    lines: [{ partId: leadPart.id, qty: opts.qty ?? 10, weight: "25.00" }],
  }));
  return { order, leadPart, inspection };
}

/** A one-line order already carrying an ORDER-scope cert, seeded from its single inspection. */
async function seededCert(
  opts: { min?: number; max?: number } = {},
): Promise<{ cert: CertDetail; order: OrderDetail }> {
  const { order } = await oneLineOrder(opts);
  const cert = await asSystem(() => createCert({ orderId: order.id, scope: "ORDER" }));
  return { cert, order };
}

describe("seedRequirements (via createCert)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("seeds one requirement per part inspection, in print order", async () => {
    const { order } = await twoLineOrder();
    const cert = await asSystem(() => createCert({ orderId: order.id, scope: "ORDER" }));
    expect(cert.requirements.map((r) => [r.linePosition, r.position]))
      .toEqual([[1, 1], [1, 2], [2, 3]]);
  });

  it("freezes min/max against a later part edit", async () => {
    const { order, inspection } = await oneLineOrder({ min: 28, max: 32 });
    const cert = await asSystem(() => createCert({ orderId: order.id, scope: "ORDER" }));
    await prisma.partInspection.update({ where: { id: inspection.id }, data: { min: 40, max: 45 } });
    const after = await getCert(cert.id);
    expect([after.requirements[0].min, after.requirements[0].max]).toEqual([28, 32]);
  });

  it("a part with no inspection requirements contributes no rows", async () => {
    // Lead carries one inspection, the rider carries none — spec §6.3: "a part with no
    // inspection requirements contributes no rows; its block prints part identity and serials
    // only." The requirement set must show the lead's single row and nothing for the rider.
    const customer = await makeCustomer();
    const leadPart = await prisma.part.create({
      data: { customerId: customer.id, partNumber: `CRP-${++partSeq}`, eachWeight: "1.0000" },
    });
    const riderPart = await prisma.part.create({
      data: { customerId: customer.id, partNumber: `CRP-${++partSeq}`, eachWeight: "1.0000" },
    });
    await giveSteps(leadPart.id);
    const code = await makeInspectionCode();
    await asSystem(() => addPartInspection(leadPart.id, { inspectionCodeId: code.id, sort: 0 }));

    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: "",
      lines: [
        { partId: leadPart.id, qty: 10, weight: "25.00" },
        { partId: riderPart.id, qty: 5, weight: "10.00" },
      ],
    }));
    const cert = await asSystem(() => createCert({ orderId: order.id, scope: "ORDER" }));
    expect(cert.requirements).toHaveLength(1);
    expect(cert.requirements[0].linePosition).toBe(1);
  });

  it("copies sampleQty and location verbatim, and references the live inspection code/scale names", async () => {
    const customer = await makeCustomer();
    const leadPart = await prisma.part.create({
      data: { customerId: customer.id, partNumber: `CRP-${++partSeq}`, eachWeight: "1.0000" },
    });
    await giveSteps(leadPart.id);
    const code = await makeInspectionCode();
    const scale = await prisma.inspectionScale.create({ data: { name: "HRC" } });
    await asSystem(() => addPartInspection(leadPart.id, {
      inspectionCodeId: code.id, scaleId: scale.id, sort: 0,
      sampleQty: "8", location: "flange OD",
    }));
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: "",
      lines: [{ partId: leadPart.id, qty: 10, weight: "25.00" }],
    }));
    const cert = await asSystem(() => createCert({ orderId: order.id, scope: "ORDER" }));
    expect(cert.requirements[0]).toMatchObject({
      sampleQty: "8", location: "flange OD", scaleName: "HRC",
    });
  });
});

describe("seedRequirements' reference checks, once per distinct code and scale (#625)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  /** Two lines of one part carrying two inspections on one scale. */
  async function sharedPartOrder() {
    const customer = await makeCustomer();
    const part = await makePart(customer.id);
    await giveSteps(part.id);
    const scale = await prisma.inspectionScale.create({ data: { name: `HRC-${++codeSeq}` } });
    const first = await makeInspectionCode();
    const second = await makeInspectionCode();
    await asSystem(() => addPartInspection(part.id, { inspectionCodeId: first.id, scaleId: scale.id, sort: 0 }));
    await asSystem(() => addPartInspection(part.id, { inspectionCodeId: second.id, scaleId: scale.id, sort: 1 }));
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: "",
      lines: [{ partId: part.id, qty: 1, weight: "1.00" }, { partId: part.id, qty: 1, weight: "1.00" }],
    }));
    return { order, scale, first, second };
  }

  it("seeds both lines from the shared part, in print order", async () => {
    const { order, first, second } = await sharedPartOrder();
    const cert = await asSystem(() => createCert({ orderId: order.id, scope: "ORDER" }));
    const rows = await prisma.certRequirement.findMany({ where: { certId: cert.id }, orderBy: { position: "asc" } });
    expect(rows.map((r) => [r.linePosition, r.position, r.inspectionCodeId]))
      .toEqual([[1, 1, first.id], [1, 2, second.id], [2, 3, first.id], [2, 4, second.id]]);
  });

  // `deleteReference` refuses a code a PartInspection names, so the code is retired directly here.
  it("refuses a code retired under the part, and seeds nothing", async () => {
    const { order, second } = await sharedPartOrder();
    await prisma.inspectionCode.update({ where: { id: second.id }, data: { deletedAt: new Date() } });
    await expect(asSystem(() => createCert({ orderId: order.id, scope: "ORDER" })))
      .rejects.toThrow("That inspection code does not exist");
    expect(await prisma.cert.count({ where: { orderId: order.id } })).toBe(0);
    expect(await prisma.certRequirement.count()).toBe(0);
  });

  it("refuses a retired scale", async () => {
    const { order, scale } = await sharedPartOrder();
    await prisma.inspectionScale.update({ where: { id: scale.id }, data: { deletedAt: new Date() } });
    await expect(asSystem(() => createCert({ orderId: order.id, scope: "ORDER" })))
      .rejects.toThrow("That inspection scale does not exist");
  });

  it("names the code before the scale when the first row's code and scale are both retired", async () => {
    const { order, scale, first } = await sharedPartOrder();
    await prisma.inspectionScale.update({ where: { id: scale.id }, data: { deletedAt: new Date() } });
    await prisma.inspectionCode.update({ where: { id: first.id }, data: { deletedAt: new Date() } });
    await expect(asSystem(() => createCert({ orderId: order.id, scope: "ORDER" })))
      .rejects.toThrow("That inspection code does not exist");
  });
});

describe("addLine seeds rider requirements into live certs (ruling 28, #56)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("seeds the rider's frozen requirements and keeps typed readings intact", async () => {
    const { cert, order } = await seededCert({ min: 28, max: 32 });
    const typed = await asSystem(() => replaceReadings(cert.id, {
      requirements: [{ id: cert.requirements[0].id, readings: [{ value: "30.0" }] }],
    }, { afterPrint: false }));
    expect(typed.requirements[0].readings).toHaveLength(1);

    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: order.customerId } });
    const riderPart = await prisma.part.create({
      data: { customerId: customer.id, partNumber: `CRP-RIDER-${Date.now() % 100000}`, eachWeight: "1.0000" },
    });
    const code = await makeInspectionCode();
    await asSystem(() => addPartInspection(riderPart.id, { inspectionCodeId: code.id, sort: 0, min: 40, max: 45 }));

    const after = await asSystem(() => addLine(order.id, { partId: riderPart.id, qty: 5, weight: "10.00" }));
    const riderLine = after.lines[1];

    const detail = await getCert(cert.id);
    expect(detail.requirements).toHaveLength(2);
    const riderReq = detail.requirements.find((r) => r.orderLineId === riderLine.id);
    expect(riderReq).toBeTruthy();
    expect(riderReq!.partNumber).toBe(riderPart.partNumber); // frozen at add time
    expect(riderReq!.min).toBe(40);
    // The lead's typed reading survived untouched.
    expect(detail.requirements.find((r) => r.orderLineId === after.lines[0].id)!.readings).toHaveLength(1);
  });

  it("does nothing for a rider whose part carries no inspections", async () => {
    const { cert, order } = await seededCert({});
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: order.customerId } });
    const plainPart = await prisma.part.create({
      data: { customerId: customer.id, partNumber: `CRP-PLAIN-${Date.now() % 100000}`, eachWeight: "1.0000" },
    });
    await asSystem(() => addLine(order.id, { partId: plainPart.id, qty: 1, weight: "1.00" }));
    expect((await getCert(cert.id)).requirements).toHaveLength(1);
  });
});

describe("seedLineIntoLiveCerts across two live certs (#625)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  /** An order of two loads with a LOAD cert on each, every cert seeded with the lead's one row,
   *  and a rider part carrying two inspections. */
  async function twoCertOrder() {
    const { order } = await oneLineOrder({ qty: 2, loadQty: 1 });
    const certs = [
      await asSystem(() => createCert({ orderId: order.id, scope: "LOAD", loadNumber: 1 })),
      await asSystem(() => createCert({ orderId: order.id, scope: "LOAD", loadNumber: 2 })),
    ];
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: order.customerId } });
    const rider = await makePart(customer.id);
    const codes = [await makeInspectionCode(), await makeInspectionCode()];
    await asSystem(() => addPartInspection(rider.id, { inspectionCodeId: codes[1].id, sort: 1 }));
    await asSystem(() => addPartInspection(rider.id, { inspectionCodeId: codes[0].id, sort: 0 }));
    return { order, certs, rider, codes };
  }

  it("appends the rider's rows after each cert's own, in the part's sort order", async () => {
    const { order, certs, rider, codes } = await twoCertOrder();
    const after = await asSystem(() => addLine(order.id, { partId: rider.id, qty: 1, weight: "1.00" }));
    for (const cert of certs) {
      const rows = await prisma.certRequirement.findMany({ where: { certId: cert.id }, orderBy: { position: "asc" } });
      expect(rows.map((r) => [r.position, r.orderLineId, r.inspectionCodeId])).toEqual([
        [1, after.lines[0].id, cert.requirements[0].inspectionCodeId],
        [2, after.lines[1].id, codes[0].id],
        [3, after.lines[1].id, codes[1].id],
      ]);
    }
    // Each cert's growth is its own audited update.
    for (const cert of certs) {
      expect((await readAudit("cert", cert.id)).filter((e) => e.reason === "Rider line added to the order (ruling 28)"))
        .toHaveLength(1);
    }
  });

  it("checks nothing on an order with no live cert: a retired code there does not refuse the line", async () => {
    const { order } = await oneLineOrder();
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: order.customerId } });
    const rider = await makePart(customer.id);
    const code = await makeInspectionCode();
    await asSystem(() => addPartInspection(rider.id, { inspectionCodeId: code.id, sort: 0 }));
    await prisma.inspectionCode.update({ where: { id: code.id }, data: { deletedAt: new Date() } });
    const after = await asSystem(() => addLine(order.id, { partId: rider.id, qty: 1, weight: "1.00" }));
    expect(after.lines).toHaveLength(2);
  });

  it("refuses a rider whose inspection code was retired, and adds nothing", async () => {
    const { order, rider, codes } = await twoCertOrder();
    await prisma.inspectionCode.update({ where: { id: codes[1].id }, data: { deletedAt: new Date() } });
    await expect(asSystem(() => addLine(order.id, { partId: rider.id, qty: 1, weight: "1.00" })))
      .rejects.toThrow("That inspection code does not exist");
    expect(await prisma.orderLine.count({ where: { orderId: order.id } })).toBe(1);
    expect(await prisma.certRequirement.count()).toBe(2);
  });
});

describe("replaceReadings", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("computes pass/fail per reading and records an override", async () => {
    const { cert } = await seededCert({ min: 28, max: 32 });
    const saved = await asSystem(() => replaceReadings(cert.id, {
      requirements: [{ id: cert.requirements[0].id, readings: [
        { value: "30.0" },
        { value: "25.6", passed: true, overridden: true, note: "retest on the flange OD" },
      ] }],
    }, { afterPrint: false }));
    const [a, b] = saved.requirements[0].readings;
    expect([a.passed, a.overridden]).toEqual([true, false]);
    expect([b.passed, b.overridden]).toEqual([true, true]);
  });

  it("refuses a value below zero and takes zero (owner ruling O1)", async () => {
    const { cert } = await seededCert({ min: 28, max: 32 });
    const save = (value: string) => asSystem(() => replaceReadings(cert.id, {
      requirements: [{ id: cert.requirements[0].id, readings: [{ value }] }],
    }, { afterPrint: false }));
    const refusal = await save("-0.5").then(() => "accepted", (e) => readableMessage(e));
    expect(refusal).toBe("requirements.0.readings.0.value: cannot be negative.");
    const saved = await save("0");
    expect(saved.requirements[0].readings[0].value).toBe(0);
  });

  it("refuses an override verdict without a measurement value", async () => {
    // `value: null, passed: true` stored a passing result with no measurement (round-5 finding).
    const { cert } = await seededCert({ min: 28, max: 32 });
    await expect(asSystem(() => replaceReadings(cert.id, {
      requirements: [{ id: cert.requirements[0].id, readings: [{ passed: true, overridden: true }] }],
    }, { afterPrint: false }))).rejects.toThrow(/measurement/i);
  });

  it("refuses an overridden populated value with no pass\/fail verdict", async () => {
    // `value: 25.6, passed: null` hid an out-of-bounds value from the failure count.
    const { cert } = await seededCert({ min: 28, max: 32 });
    await expect(asSystem(() => replaceReadings(cert.id, {
      requirements: [{ id: cert.requirements[0].id, readings: [{ value: "25.6", overridden: true }] }],
    }, { afterPrint: false }))).rejects.toThrow(/verdict/i);
  });

  it("supports many readings under one requirement", async () => {
    const { cert } = await seededCert({ min: 28, max: 32 });
    const readings = Array.from({ length: 27 }, (_, i) => ({ value: String(28 + (i % 5)) }));
    const saved = await asSystem(() => replaceReadings(cert.id, {
      requirements: [{ id: cert.requirements[0].id, readings }],
    }, { afterPrint: false }));
    expect(saved.requirements[0].readings).toHaveLength(27);
    expect(saved.requirements[0].readings.every((r) => r.passed === true)).toBe(true);
    expect(saved.requirements[0].readings.map((r) => r.position)).toEqual(
      Array.from({ length: 27 }, (_, i) => i + 1),
    );
  });

  it("a value outside the frozen bounds fails, not overridden", async () => {
    const { cert } = await seededCert({ min: 28, max: 32 });
    const saved = await asSystem(() => replaceReadings(cert.id, {
      requirements: [{ id: cert.requirements[0].id, readings: [{ value: "20.0" }] }],
    }, { afterPrint: false }));
    expect(saved.requirements[0].readings[0]).toMatchObject({ passed: false, overridden: false });
  });

  it("replacing readings under a requirement deletes the previous set rather than appending", async () => {
    const { cert } = await seededCert({ min: 28, max: 32 });
    await asSystem(() => replaceReadings(cert.id, {
      requirements: [{ id: cert.requirements[0].id, readings: [{ value: "30" }, { value: "31" }] }],
    }, { afterPrint: false }));
    const second = await asSystem(() => replaceReadings(cert.id, {
      requirements: [{ id: cert.requirements[0].id, readings: [{ value: "29" }] }],
    }, { afterPrint: false }));
    expect(second.requirements[0].readings).toHaveLength(1);
    expect(second.requirements[0].readings[0].value).toBe(29);
  });

  // The locking test for the merge-vs-wipe contract: replaceReadings replaces readings ONLY
  // under the requirements a payload names — every other requirement on the same cert must come
  // out exactly as it went in. This is what stops a future refactor turning merge semantics into
  // a full wipe without anything going red (that ambiguity was the review's one Important finding
  // on this task, resolved in favor of merge — an editor keeps only what the user actually typed,
  // never more, so a partial submit can never silently destroy readings entered elsewhere).
  it("MERGE not WIPE: a payload naming only one requirement leaves every other requirement's readings on the cert untouched", async () => {
    const { order } = await twoLineOrder();
    const cert = await asSystem(() => createCert({ orderId: order.id, scope: "ORDER" }));
    expect(cert.requirements.length).toBeGreaterThanOrEqual(2);
    const [first, second] = cert.requirements;

    await asSystem(() => replaceReadings(cert.id, {
      requirements: [
        { id: first.id, readings: [{ value: "10" }] },
        { id: second.id, readings: [{ value: "20" }] },
      ],
    }, { afterPrint: false }));

    // This payload names ONLY the first requirement.
    const after = await asSystem(() => replaceReadings(cert.id, {
      requirements: [{ id: first.id, readings: [{ value: "11" }] }],
    }, { afterPrint: false }));

    const firstAfter = after.requirements.find((r) => r.id === first.id)!;
    expect(firstAfter.readings).toHaveLength(1);
    expect(firstAfter.readings[0].value).toBe(11);

    const secondAfter = after.requirements.find((r) => r.id === second.id)!;
    expect(secondAfter.readings).toHaveLength(1);
    expect(secondAfter.readings[0].value).toBe(20);
  });

  it("a requirement id not belonging to this cert is a 400 naming it", async () => {
    const { cert } = await seededCert({});
    await expect(asSystem(() => replaceReadings(cert.id, {
      requirements: [{ id: "not-a-real-requirement-id", readings: [{ value: "30" }] }],
    }, { afterPrint: false }))).rejects.toMatchObject({
      status: 400, message: expect.stringContaining("not-a-real-requirement-id"),
    });
  });

  it("refuses a results edit after printing without the special action", async () => {
    const { cert } = await seededCert({});
    await prisma.cert.update({ where: { id: cert.id }, data: { printedAt: new Date() } });
    await expect(asSystem(() => replaceReadings(cert.id, { requirements: [] }, { afterPrint: false })))
      .rejects.toThrow(/already been printed/i);
    await expect(asSystem(() => replaceReadings(cert.id, { requirements: [] }, { afterPrint: true })))
      .resolves.toBeTruthy();
  });

  it("refuses an unknown cert", async () => {
    await expect(asSystem(() => replaceReadings("nope", { requirements: [] }, { afterPrint: false })))
      .rejects.toThrow(/not found/i);
  });

  it("refuses a voided cert", async () => {
    const { cert } = await seededCert({});
    await prisma.cert.update({ where: { id: cert.id }, data: { deletedAt: new Date() } });
    await expect(asSystem(() => replaceReadings(cert.id, { requirements: [] }, { afterPrint: false })))
      .rejects.toThrow(/not found/i);
  });

  it("produces a real cert-level before/after audit diff carrying both reading values", async () => {
    const { cert } = await seededCert({ min: 28, max: 32 });
    await asSystem(() => replaceReadings(cert.id, {
      requirements: [{ id: cert.requirements[0].id, readings: [{ value: "30" }] }],
    }, { afterPrint: false }));

    const [entry] = await readAudit("cert", cert.id);
    expect(entry.action).toBe("update");
    type Snapshot = { requirements: { readings: { value: string | number | null }[] }[] };
    const before = entry.before as Snapshot;
    const after = entry.after as Snapshot;
    expect(before.requirements[0].readings).toEqual([]);
    expect(Number(after.requirements[0].readings[0].value)).toBe(30);
  });
});
