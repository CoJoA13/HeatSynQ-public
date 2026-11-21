import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma, truncateAll, templateId, templateVersionId } from "./helpers/db";
import { TEMPLATE_DOC_TYPES, defaultConfigFor, type TemplateDocTypeString } from "@/lib/template-contracts/index";
import { type Prisma } from "../prisma/generated/prisma/client";
import { stopsTheMerge, type ExportedVersion } from "../scripts/lib/stored-template-check";
import { publishStored, seedLiteral, storedBefore } from "./helpers/stored-configs";

// The read-only query of the listing (weights design §13.2), run on the test database through
// Prisma. No case starts psql.

const sql = readFileSync(join(process.cwd(), "scripts/stored-templates.sql"), "utf8");

/** Runs `run` in a transaction PostgreSQL has been told is read-only. */
const readOnly = <T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    return run(tx);
  });
/** The committed file's whole answer. */
const answer = () => readOnly((tx) => tx.$queryRawUnsafe<{ versions: ExportedVersion[] }[]>(sql));

async function snapshot() {
  return {
    templates: await prisma.documentTemplate.findMany({ orderBy: { id: "asc" } }),
    versions: await prisma.documentTemplateVersion.findMany({ orderBy: { id: "asc" } }),
    assignments: await prisma.customerTemplateAssignment.findMany({ orderBy: { id: "asc" } }),
    customers: await prisma.customer.findMany({ orderBy: { id: "asc" } }),
  };
}

const stored = (config: unknown) => config as Prisma.InputJsonValue;
/** A re-seeded Standard's one row, as the query must answer it. */
const standard = (docType: TemplateDocTypeString): ExportedVersion => ({
  docType, templateId: templateId(docType), templateName: "Standard", isDefault: true, templateDeleted: false,
  versionId: templateVersionId(docType), versionNumber: 1, status: "PUBLISHED", published: true, customers: [],
  config: defaultConfigFor(docType),
});

/**
 * Writes, with Prisma directly, what an install can hold beside its Standards: a ticket template
 * with an earlier version, the one in use, a discarded draft and a draft, assigned to two customers
 * and once to a third whose assignment is dead; a deleted template that a customer is still assigned
 * to; and a template never published. Answers the rows the query must give, in its order.
 */
async function anInstall(): Promise<ExportedVersion[]> {
  const seed = seedLiteral("SHIPPER");
  const full = storedBefore("SHIPPER", "widths-full");
  const cert = seedLiteral("CERT");
  const quote = seedLiteral("QUOTE");
  await prisma.documentTemplate.createMany({ data: [
    { id: "acme-ticket", docType: "SHIPPER", name: "Acme ticket" },
    { id: "old-cert", docType: "CERT", name: "Old cert", deletedAt: new Date() },
    { id: "new-quote", docType: "QUOTE", name: "New quote" },
  ] });
  await prisma.documentTemplateVersion.createMany({ data: [
    { id: "acme-ticket-v1", templateId: "acme-ticket", versionNumber: 1, status: "PUBLISHED", config: stored(seed) },
    { id: "acme-ticket-v2", templateId: "acme-ticket", versionNumber: 2, status: "PUBLISHED", config: stored(full),
      logoImage: Buffer.from("LOGO-BYTES-STAY-IN-THE-DATABASE"), logoMimeType: "image/png" },
    { id: "acme-ticket-v3", templateId: "acme-ticket", versionNumber: 3, status: "DISCARDED", config: stored(seed) },
    { id: "acme-ticket-v4", templateId: "acme-ticket", versionNumber: 4, status: "DRAFT", config: stored(full) },
    { id: "old-cert-v1", templateId: "old-cert", versionNumber: 1, status: "PUBLISHED", config: stored(cert) },
    { id: "new-quote-v1", templateId: "new-quote", versionNumber: 1, status: "DRAFT", config: stored(quote) },
  ] });
  await prisma.documentTemplate.update({ where: { id: "acme-ticket" }, data: { publishedVersionId: "acme-ticket-v2" } });
  await prisma.documentTemplate.update({ where: { id: "old-cert" }, data: { publishedVersionId: "old-cert-v1" } });
  const zed = await prisma.customer.create({ data: { code: "ZED", name: "Zed Gear" } });
  const acme = await prisma.customer.create({ data: { code: "ACME", name: "Acme Forge" } });
  const gone = await prisma.customer.create({ data: { code: "GONE", name: "Gone Co" } });
  await prisma.customerTemplateAssignment.createMany({ data: [
    { customerId: zed.id, docType: "SHIPPER", templateId: "acme-ticket" },
    { customerId: acme.id, docType: "SHIPPER", templateId: "acme-ticket" },
    { customerId: gone.id, docType: "SHIPPER", templateId: "acme-ticket", deletedAt: new Date() },
    { customerId: acme.id, docType: "CERT", templateId: "old-cert" },
  ] });

  const both = [{ code: "ACME", name: "Acme Forge" }, { code: "ZED", name: "Zed Gear" }];
  const acmeTicket = { docType: "SHIPPER", templateId: "acme-ticket", templateName: "Acme ticket", isDefault: false, templateDeleted: false, customers: both };
  const extra: Partial<Record<TemplateDocTypeString, ExportedVersion[]>> = {
    SHIPPER: [
      { ...acmeTicket, versionId: "acme-ticket-v1", versionNumber: 1, status: "PUBLISHED", published: false, config: seed },
      { ...acmeTicket, versionId: "acme-ticket-v2", versionNumber: 2, status: "PUBLISHED", published: true, config: full },
      { ...acmeTicket, versionId: "acme-ticket-v3", versionNumber: 3, status: "DISCARDED", published: false, config: seed },
      { ...acmeTicket, versionId: "acme-ticket-v4", versionNumber: 4, status: "DRAFT", published: false, config: full },
    ],
    CERT: [{
      docType: "CERT", templateId: "old-cert", templateName: "Old cert", isDefault: false, templateDeleted: true,
      versionId: "old-cert-v1", versionNumber: 1, status: "PUBLISHED", published: true,
      customers: [{ code: "ACME", name: "Acme Forge" }], config: cert,
    }],
    QUOTE: [{
      docType: "QUOTE", templateId: "new-quote", templateName: "New quote", isDefault: false, templateDeleted: false,
      versionId: "new-quote-v1", versionNumber: 1, status: "DRAFT", published: false, customers: [], config: quote,
    }],
  };
  // By document type as the schema lists them, then the template's name, then the version's number.
  return TEMPLATE_DOC_TYPES.flatMap((docType) => [...(extra[docType] ?? []), standard(docType)]);
}

describe("scripts/stored-templates.sql on the test database", () => {
  beforeEach(truncateAll);

  it("answers one row of one column: every stored version by value, with no logo", async () => {
    const rows = await anInstall();
    expect(await answer()).toEqual([{ versions: rows }]);
  });

  it("changes no row, run outside any read-only transaction", async () => {
    await anInstall();
    const before = await snapshot();
    await prisma.$queryRawUnsafe(sql);
    expect(await snapshot()).toEqual(before);
  });

  it("the read-only transaction the cases run it in refuses a write", async () => {
    const insert = `INSERT INTO "DocumentTemplate" ("id", "docType", "name", "updatedAt") VALUES ('written', 'CERT', 'Written', now())`;
    await expect(readOnly((tx) => tx.$executeRawUnsafe(insert))).rejects.toThrow(/read-only transaction|25006/);
  });

  it("end to end: the re-seeded Standards stop nothing, and a stored ticket template its contract refuses stops the merge", async () => {
    expect(stopsTheMerge((await answer())[0].versions)).toBe(false);
    // A tight share stops nothing since owner ruling R-A (2026-11-17, #991): the clamp breaks its words in their cells.
    await publishStored("SHIPPER", storedBefore("SHIPPER", "type-width-130"));
    expect(stopsTheMerge((await answer())[0].versions)).toBe(false);
    // Columns that pass the half's 282 pt are refused since R-B, and a refused version in use stops the merge.
    await publishStored("SHIPPER", storedBefore("SHIPPER", "type-width-220"));
    expect(stopsTheMerge((await answer())[0].versions)).toBe(true);
  });
});

describe("scripts/stored-templates.sql, the file", () => {
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

  it.each(["logo", '"User"', '"Setting"', '"Session"', "password", "publishedBy"])(
    "names no logo, user, setting or session column: %s", (name) => {
      expect(statement.toLowerCase()).not.toContain(name.toLowerCase());
    });
});
