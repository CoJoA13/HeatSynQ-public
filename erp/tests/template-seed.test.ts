import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { prisma, truncateAll, templateVersionId } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { auditedUpdate, readAudit, redact } from "@/server/audit";
import { TEMPLATE_DOC_TYPES, defaultConfigFor, type TemplateDocTypeString } from "@/lib/template-contracts/index";

const SQL = readFileSync(join(process.cwd(), "prisma/migrations/20261120000000_public_baseline_v2/migration.sql"), "utf8");
const frozen = JSON.parse(readFileSync(join(process.cwd(), "prisma/public-baseline-templates.json"), "utf8")) as Array<{ docType: TemplateDocTypeString; config: unknown }>;

describe("public baseline template literals", () => {
  it("keeps the frozen baseline checksum and clean literals for all nine document types", () => {
    expect(createHash("sha256").update(SQL).digest("hex")).toBe("e1246256bd4b46cf95e97d81253f939fbe248fcbfcab8e3e78b5ee6e217fd715");
    const rows = [...SQL.matchAll(/INSERT INTO "DocumentTemplateVersion"[^\n]+? '((?:[^']|'')*)'::jsonb/g)];
    expect(rows).toHaveLength(9);
    for (const docType of TEMPLATE_DOC_TYPES) {
      const line = rows.find(row => row[0].includes(`'${templateVersionId(docType)}'`));
      expect(line, docType).toBeDefined();
      const config = JSON.parse(line![1].replaceAll("''", "'"));
      expect(config).toEqual(frozen.find(row => row.docType === docType)?.config);
      expect(config).toEqual(defaultConfigFor(docType));
      expect(line![0]).toContain("1, 'PUBLISHED'");
    }
    // The lineage names v2; no template version past v1 may.
    expect(SQL).not.toMatch(/standard-[a-z-]+-v2/);
  });
  it("preserves the installation marker and migration history through test cleanup", async () => {
    const marker = await prisma.publicInstallation.findMany();
    const history = await prisma.$queryRaw`SELECT * FROM public._prisma_migrations ORDER BY id`;
    expect(marker).toHaveLength(1);
    await truncateAll();
    expect(await prisma.publicInstallation.findMany()).toEqual(marker);
    expect(await prisma.$queryRaw`SELECT * FROM public._prisma_migrations ORDER BY id`).toEqual(history);
  });
});

describe("truncateAll() re-seeds the nine Standard templates (the BillingConfig precedent)", () => {
  beforeEach(truncateAll);

  it("a raw read sees 9 live Standard templates, each isDefault with a PUBLISHED v1 built from the TS constants", async () => {
    const templates = await prisma.documentTemplate.findMany({
      where: { deletedAt: null },
      include: { publishedVersion: true },
      orderBy: { docType: "asc" },
    });
    expect(templates).toHaveLength(9);
    expect(new Set(templates.map((t) => t.docType)).size).toBe(9);
    for (const template of templates) {
      expect(template.name).toBe("Standard");
      expect(template.isDefault).toBe(true);
      expect(template.publishedVersion, template.docType).not.toBeNull();
      expect(template.publishedVersion?.versionNumber).toBe(1);
      expect(template.publishedVersion?.status).toBe("PUBLISHED");
      expect(template.publishedVersion?.publishedAt).toBeInstanceOf(Date);
      expect(template.publishedVersion?.config).toEqual(
        defaultConfigFor(template.docType as TemplateDocTypeString));
    }
  });
});

describe("audit registration (spec §4.2)", () => {
  beforeEach(truncateAll);

  it("excludes logoImage bytes from version snapshots via SNAPSHOT_SELECT, keeping the config diff", async () => {
    // The signatureImage/fileData precedent: the bytes never leave Postgres for the snapshot
    // query at all — the key is absent, not merely redacted to a placeholder.
    const seeded = await prisma.documentTemplateVersion.findFirstOrThrow({
      where: { template: { docType: "TRAVELER" } },
    });
    const version = await prisma.documentTemplateVersion.create({
      data: {
        templateId: seeded.templateId, versionNumber: 2, status: "DRAFT",
        config: seeded.config ?? {}, logoImage: Buffer.from("fakelogobytes"), logoMimeType: "image/png",
      },
    });
    await runWithContext({ actor: { id: "u0", name: "Admin" }, user: null }, () =>
      prisma.$transaction((tx) =>
        auditedUpdate("documentTemplateVersion", version.id, () =>
          tx.documentTemplateVersion.update({
            where: { id: version.id }, data: { status: "DISCARDED" },
          }), { tx }),
      ),
    );
    const [entry] = await readAudit("documentTemplateVersion", version.id);
    const before = entry.before as Record<string, unknown>;
    const after = entry.after as Record<string, unknown>;
    expect(before).not.toHaveProperty("logoImage");
    expect(after).not.toHaveProperty("logoImage");
    // The snapshot still carries what the audit exists for: real before→after diffs.
    expect(before.status).toBe("DRAFT");
    expect(after.status).toBe("DISCARDED");
    expect(before.config).toBeTruthy();
    expect(before.logoMimeType).toBe("image/png");
    // Belt: no raw Buffer serialization survives anywhere in the entry.
    for (const s of [JSON.stringify(entry.before), JSON.stringify(entry.after)]) {
      expect(s).not.toContain('"type":"Buffer"');
      expect(s).not.toContain("fakelogobytes");
    }
  });

  it("redact() scrubs logoImage keys — defense-in-depth behind SNAPSHOT_SELECT", () => {
    expect(redact({ logoImage: "QUJDRA==", nested: { logoImage: "x" } })).toEqual({
      logoImage: "[redacted]", nested: { logoImage: "[redacted]" },
    });
  });

  it("a template snapshot pulls live assignments with customer names, so history never reads a bare cuid", async () => {
    const template = await prisma.documentTemplate.findFirstOrThrow({
      where: { docType: "SHIPPER", deletedAt: null },
    });
    const customer = await prisma.customer.create({ data: { code: "AC1", name: "Acme" } });
    await prisma.customerTemplateAssignment.create({
      data: { customerId: customer.id, docType: "SHIPPER", templateId: template.id },
    });
    // A dead assignment must NOT surface (the partPrice live-rows precedent).
    const gone = await prisma.customer.create({ data: { code: "GONE", name: "Gone Co" } });
    await prisma.customerTemplateAssignment.create({
      data: { customerId: gone.id, docType: "SHIPPER", templateId: template.id, deletedAt: new Date() },
    });
    await runWithContext({ actor: { id: "u0", name: "Admin" }, user: null }, () =>
      prisma.$transaction((tx) =>
        auditedUpdate("documentTemplate", template.id, () =>
          tx.documentTemplate.update({ where: { id: template.id }, data: { name: "Renamed" } }),
          { tx }),
      ),
    );
    const [entry] = await readAudit("documentTemplate", template.id);
    const after = entry.after as { assignments: { customer: { code: string } }[] };
    expect(after.assignments).toHaveLength(1);
    expect(after.assignments[0].customer).toEqual({ code: "AC1", name: "Acme" });
  });
});
