import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma, truncateAll } from "./helpers/db";
import { type Prisma } from "../prisma/generated/prisma/client";

// The read-only listing of stored figures below zero (#517, pull request 5c), run on the test
// database through Prisma. No case starts psql. The services refuse a figure
// below zero now, so every row here is written with Prisma directly.

const sql = readFileSync(join(process.cwd(), "scripts/stored-negatives.sql"), "utf8");

/** Runs `run` in a transaction PostgreSQL has been told is read-only. */
const readOnly = <T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    return run(tx);
  });
/** The committed file's whole answer. */
const answer = () => readOnly((tx) => tx.$queryRawUnsafe<{ listing: string }[]>(sql));

/**
 * Writes what an install can hold: part inspections and certification readings below zero, live,
 * deleted, voided and printed, beside figures of zero and above that the listing must leave out.
 * Answers the lines the query must give, in its order.
 */
async function anInstall(): Promise<string[]> {
  const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
  const hardness = await prisma.inspectionCode.create({ data: { name: "Hardness" } });
  const depth = await prisma.inspectionCode.create({ data: { name: "Case depth" } });
  const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-1", eachWeight: "1.0000" } });
  const gone = await prisma.part.create({
    data: { customerId: customer.id, partNumber: "P-2", eachWeight: "1.0000", deletedAt: new Date() },
  });
  await prisma.partInspection.createMany({ data: [
    { partId: part.id, inspectionCodeId: hardness.id, sort: 1, min: "-1", max: "52.5" },
    { partId: part.id, inspectionCodeId: depth.id, sort: 2, min: "0", max: "0.5" },
    { partId: part.id, inspectionCodeId: depth.id, sort: 3, min: "-2", max: "-1.5", deletedAt: new Date() },
    { partId: gone.id, inspectionCodeId: hardness.id, sort: 1, min: "1", max: "-3", deletedAt: new Date() },
  ] });

  const order = await prisma.order.create({
    data: { orderNumber: 92036, customerId: customer.id, receivedDate: new Date("2026-08-01"), requestDate: new Date("2026-08-05") },
  });
  const shipper = await prisma.shipper.create({
    data: { shipperNumber: 17, customerId: customer.id, shipDate: new Date("2026-08-06") },
  });
  const certs = {
    order: await prisma.cert.create({ data: { orderId: order.id, scope: "ORDER" } }),
    load: await prisma.cert.create({ data: { orderId: order.id, scope: "LOAD", loadNumber: 2, printedAt: new Date() } }),
    shipment: await prisma.cert.create({
      data: { orderId: order.id, scope: "SHIPMENT", shipperId: shipper.id, deletedAt: new Date() },
    }),
  };
  const requirement = (certId: string, position: number, inspectionCodeId: string) => prisma.certRequirement.create({
    data: { certId, position, linePosition: 1, partNumber: "P-1", inspectionCodeId, min: "45", max: "52.5" },
  });
  const onOrder = await requirement(certs.order.id, 1, hardness.id);
  const onOrderDepth = await requirement(certs.order.id, 2, depth.id);
  const onLoad = await requirement(certs.load.id, 1, hardness.id);
  const onShipment = await requirement(certs.shipment.id, 3, depth.id);
  await prisma.certReading.createMany({ data: [
    { requirementId: onOrder.id, position: 1, value: "48.25" },
    { requirementId: onOrder.id, position: 2, value: "-0.5" },
    { requirementId: onOrder.id, position: 3, value: "0" },
    { requirementId: onOrder.id, position: 4, value: null },
    { requirementId: onOrderDepth.id, position: 1, value: "-0.0001" },
    { requirementId: onLoad.id, position: 1, value: "-0.1" },
    { requirementId: onShipment.id, position: 2, value: "-4" },
  ] });

  return [
    "inspection | AC | P-1 | Hardness | min | -1.0000 | live",
    "inspection | AC | P-1 | Case depth | min | -2.0000 | inspection deleted",
    "inspection | AC | P-1 | Case depth | max | -1.5000 | inspection deleted",
    "inspection | AC | P-2 | Hardness | max | -3.0000 | part deleted",
    "reading | #92036 | 1. Hardness | reading 2 | -0.5000 | live",
    "reading | #92036 | 2. Case depth | reading 1 | -0.0001 | live",
    "reading | #92036, load 2 | 1. Hardness | reading 1 | -0.1000 | live, printed",
    "reading | #92036, packing list 17 | 3. Case depth | reading 2 | -4.0000 | cert voided",
  ];
}

async function snapshot() {
  return {
    customers: await prisma.customer.findMany({ orderBy: { id: "asc" } }),
    parts: await prisma.part.findMany({ orderBy: { id: "asc" } }),
    codes: await prisma.inspectionCode.findMany({ orderBy: { id: "asc" } }),
    inspections: await prisma.partInspection.findMany({ orderBy: { id: "asc" } }),
    orders: await prisma.order.findMany({ orderBy: { id: "asc" } }),
    shippers: await prisma.shipper.findMany({ orderBy: { id: "asc" } }),
    certs: await prisma.cert.findMany({ orderBy: { id: "asc" } }),
    requirements: await prisma.certRequirement.findMany({ orderBy: { id: "asc" } }),
    readings: await prisma.certReading.findMany({ orderBy: { id: "asc" } }),
  };
}

describe("scripts/stored-negatives.sql on the test database", () => {
  beforeEach(truncateAll);

  it("with nothing stored below zero, answers the count line alone", async () => {
    expect(await answer()).toEqual([{ listing: "0 stored figure(s) below zero" }]);
  });

  it("lists every stored figure below zero, as stored, inspections first, and nothing at zero or above", async () => {
    const lines = await anInstall();
    expect(await answer()).toEqual([{ listing: ["8 stored figure(s) below zero", ...lines].join("\n") }]);
  });

  it("changes no row, run outside any read-only transaction", async () => {
    await anInstall();
    const before = await snapshot();
    await prisma.$queryRawUnsafe(sql);
    expect(await snapshot()).toEqual(before);
  });

  it("the read-only transaction the cases run it in refuses a write", async () => {
    const insert = `INSERT INTO "InspectionCode" ("id", "name", "updatedAt") VALUES ('written', 'Written', now())`;
    await expect(readOnly((tx) => tx.$executeRawUnsafe(insert))).rejects.toThrow(/read-only transaction|25006/);
  });
});

describe("scripts/stored-negatives.sql, the file", () => {
  // What PostgreSQL is sent, without its comment lines.
  const statement = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n").trim();

  it("is one statement, a SELECT or a WITH", () => {
    expect(statement).toMatch(/^(SELECT|WITH)\b/);
    expect(statement.replace(/;$/, "")).not.toContain(";");
  });

  it.each([
    "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "DROP", "ALTER", "CREATE", "GRANT", "REVOKE", "COPY", "CALL",
    "DO", "SET", "INTO", "LOCK", "VACUUM", "REFRESH", "REINDEX", "EXECUTE", "NEXTVAL", "SETVAL", "SHARE",
  ])("holds no word that writes: %s", (word) => {
    expect(statement).not.toMatch(new RegExp(`\\b${word}\\b`, "i"));
  });

  it.each(['"User"', '"Setting"', '"Session"', "password"])("names no user, setting or session column: %s", (name) => {
    expect(statement.toLowerCase()).not.toContain(name.toLowerCase());
  });
});
