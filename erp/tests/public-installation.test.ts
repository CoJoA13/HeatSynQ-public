import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { PrismaClient } from "../prisma/generated/prisma/client";
import { bootstrapPublicDatabase, validateBootstrapUrl } from "../scripts/lib/public-bootstrap";
import { PUBLIC_COMMAND_REFUSAL, PUBLIC_V1_REFUSAL, assertPublicInstallation, publicCommandRefusalLine } from "../scripts/lib/public-installation";
import { loadPublicBaselineTemplates, loadPublicMigrations } from "../scripts/lib/public-migrations";
import { withBootstrapDatabase as withDatabase } from "./helpers/bootstrap-database";
import type { BootstrapCommand } from "./helpers/bootstrap-process";

const baseline = { name: "20261120000000_public_baseline_v2", sha256: "e1246256bd4b46cf95e97d81253f939fbe248fcbfcab8e3e78b5ee6e217fd715" };
const additive = { name: "20261121000000_additive", sha256: "a".repeat(64) };
const later = { name: "20261122000000_later", sha256: "b".repeat(64) };
const GENERIC_REFUSAL = "Public installation admission refused: baseline completion or migration history is unsupported. Keep services stopped and inspect the installation.";
const expected = [baseline];
async function migrate(url: string, exec: BootstrapCommand) {
  await exec(process.execPath, [join(process.cwd(), "node_modules/prisma/build/index.js"), "migrate", "deploy"], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, maxBuffer: 1024 * 1024,
  });
}
const snapshot = (db: PrismaClient) => db.documentTemplate.findMany({
  include: { versions: { orderBy: { versionNumber: "asc" } } }, orderBy: { id: "asc" },
});
const marker = (db: PrismaClient) => db.$queryRaw`SELECT * FROM public."PublicInstallation"`;
async function recordAdditive(db: PrismaClient, entry = additive) {
  await db.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS public."PublicAdditiveExample" (id text PRIMARY KEY)');
  await db.$executeRaw`INSERT INTO public._prisma_migrations
    (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
    VALUES (${entry.name}, ${entry.sha256}, ${entry.name}, now(), now(), 1)`;
}

describe("public migration manifest", () => {
  it("binds the published manifest to the exact baseline bytes", async () => {
    expect(await loadPublicMigrations()).toEqual(expected);
  });
  it("refuses changed SQL and unlisted migration directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "public-manifest-"));
    try {
      await mkdir(join(root, "migrations", baseline.name), { recursive: true });
      await writeFile(join(root, "public-migrations.json"), JSON.stringify(expected));
      await writeFile(join(root, "migrations", baseline.name, "migration.sql"), "SELECT 1;");
      await expect(loadPublicMigrations(root)).rejects.toThrow();
      await writeFile(join(root, "migrations", baseline.name, "migration.sql"),
        await readFile(join(process.cwd(), "prisma/migrations", baseline.name, "migration.sql")));
      await mkdir(join(root, "migrations", additive.name));
      await expect(loadPublicMigrations(root)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("refuses altered frozen template defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "public-templates-"));
    try {
      await writeFile(join(root, "public-baseline-templates.json"), "[]");
      await expect(loadPublicBaselineTemplates(root)).rejects.toThrow("integrity");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("public command refusal line", () => {
  it("prints the v1 sentence only for that exact message, and the general line for everything else", () => {
    expect(publicCommandRefusalLine(new Error(PUBLIC_V1_REFUSAL))).toBe(PUBLIC_V1_REFUSAL);
    expect(PUBLIC_COMMAND_REFUSAL).toBe("Public command refused or failed. Keep services stopped and inspect installation history and completion.");
    for (const error of [new Error(GENERIC_REFUSAL), new Error(PUBLIC_V1_REFUSAL + " postgresql://user:secret@host/db"),
      new Error("connect ECONNREFUSED /srv/private/path"), PUBLIC_V1_REFUSAL, undefined, { message: PUBLIC_V1_REFUSAL }]) {
      expect(publicCommandRefusalLine(error)).toBe(PUBLIC_COMMAND_REFUSAL);
    }
  });
});

describe("public installation lifecycle", () => {
  it("initializes nine clean v1s and one generated-model marker, then admits seeded use", async ctx => {
    await withDatabase(ctx, async (db, url, exec) => {
      let before: Awaited<ReturnType<typeof snapshot>> = [];
      await bootstrapPublicDatabase(db, async () => { await migrate(url, exec); before = await snapshot(db); });
      expect(before).toHaveLength(9);
      expect(before.flatMap(t => t.versions)).toHaveLength(9);
      expect(before.map(t => t.docType).sort()).toEqual(["BOL", "CERT", "CONTAINER_TAG", "INVOICE", "MOS_SHIPPER", "QUOTE", "SHIPPER", "STATEMENT", "TRAVELER"]);
      expect(await snapshot(db)).toEqual(before);
      expect(await marker(db)).toEqual([{ id: "singleton", lineage: "heatsynq-public-v2",
        baselineMigration: baseline.name, completedAt: expect.any(Date) }]);
      expect(await db.publicInstallation.findUnique({ where: { id: "singleton" } })).toMatchObject({ lineage: "heatsynq-public-v2" });
      for (const t of before) {
        const config = t.versions[0].config as { textBlocks: Record<string, string> };
        if (t.docType === "CERT") expect(config.textBlocks.cert_statement).toBe("");
        if (["SHIPPER", "MOS_SHIPPER"].includes(t.docType)) expect(config.textBlocks.shipper_liability_text).toBe("");
      }
      await assertPublicInstallation(db, expected);
      await exec(process.execPath, [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "prisma/seed.ts"], {
        cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, maxBuffer: 1024 * 1024,
      });
      expect(await db.user.count()).toBe(1);
      await assertPublicInstallation(db, expected);
      await expect(bootstrapPublicDatabase(db, () => migrate(url, exec))).rejects.toThrow("completely empty");
      expect(await snapshot(db)).toEqual(before);
    });
  }, 60_000);

  it.for([
    'CREATE TABLE "_prisma_migrations" (id text)',
    'CREATE VIEW "existing_view" AS SELECT 1 AS value',
    'CREATE SEQUENCE "existing_sequence"',
    'CREATE TYPE "existing_enum" AS ENUM (\'value\')',
    'CREATE SCHEMA "existing_schema"',
    'CREATE FUNCTION public.existing_function() RETURNS int LANGUAGE SQL AS \'SELECT 1\'',
  ])("refuses pre-existing objects before migrations: %s", { timeout: 15_000 }, async (ddl, ctx) => {
    await withDatabase(ctx, async db => {
      await db.$executeRawUnsafe(ddl);
      let called = false;
      await expect(bootstrapPublicDatabase(db, async () => { called = true; }, expected)).rejects.toThrow("completely empty");
      expect(called).toBe(false);
    });
  });

  it("serializes competing bootstrap attempts using a database lock", async ctx => {
    await withDatabase(ctx, async db => {
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const firstResult = bootstrapPublicDatabase(db, async () => {
        entered(); await held; throw new Error("Controlled migration failure");
      }, expected).catch((error: unknown) => error);
      const abort = () => { release(); entered(); };
      ctx.signal.addEventListener("abort", abort, { once: true });
      if (ctx.signal.aborted) abort();
      await ready;
      try {
        if (ctx.signal.aborted) throw new Error("Fixture cancelled");
        let called = false;
        await expect(bootstrapPublicDatabase(db, async () => { called = true; }, expected)).rejects.toThrow("already running");
        expect(called).toBe(false);
      } finally { release(); ctx.signal.removeEventListener("abort", abort); await firstResult; }
      expect(String(await firstResult)).toContain("Controlled migration failure");
    });
  }, 15_000);

  it("refuses to resume after SQL committed but the migration callback failed", async ctx => {
    await withDatabase(ctx, async (db, url, exec) => {
      await expect(bootstrapPublicDatabase(db, async () => {
        await migrate(url, exec); throw new Error("Controlled post-migration failure");
      }, expected)).rejects.toThrow("Controlled post-migration failure");
      expect(await marker(db)).toEqual([]);
      await expect(assertPublicInstallation(db, expected)).rejects.toThrow();
      await expect(assertPublicInstallation(db, [baseline, additive], { allowPending: true })).rejects.toThrow();
      const before = await snapshot(db);
      await expect(bootstrapPublicDatabase(db, () => migrate(url, exec))).rejects.toThrow("completely empty");
      expect(await snapshot(db)).toEqual(before);
    });
  }, 60_000);

  it.for([
    'UPDATE public."DocumentTemplateVersion" SET config = jsonb_set(config, \'{fonts,baseSize}\', \'999\') WHERE id = \'standard-cert-v1\'',
    'UPDATE public."DocumentTemplateVersion" SET "logoMimeType" = \'image/png\' WHERE id = \'standard-cert-v1\'',
    'UPDATE public."BillingConfig" SET "billForCertDefault" = true',
    'UPDATE public."SetupState" SET "numbersConfirmedAt" = now()',
    'UPDATE public."UpdateHold" SET held = true',
    'DELETE FROM public."UpdateHold"',
    'DELETE FROM public."SetupState"',
    'INSERT INTO public."Role" (id, name, "updatedAt") VALUES (\'unexpected\', \'Unexpected\', now())',
  ])("does not mark a changed or populated baseline complete: %s", { timeout: 60_000 }, async (sql, ctx) => {
    await withDatabase(ctx, async (db, url, exec) => {
      await expect(bootstrapPublicDatabase(db, async () => {
        await migrate(url, exec); await db.$executeRawUnsafe(sql);
      }, expected)).rejects.toThrow();
      expect(await marker(db)).toEqual([]);
      await expect(assertPublicInstallation(db, expected)).rejects.toThrow();
    });
  });

  it("leaves an incomplete installation if the marker insert itself fails", async ctx => {
    await withDatabase(ctx, async (db, url, exec) => {
      await expect(bootstrapPublicDatabase(db, async () => {
        await migrate(url, exec);
        await db.$executeRawUnsafe('ALTER TABLE public."PublicInstallation" ADD CONSTRAINT test_marker_failure CHECK (false)');
      }, expected)).rejects.toThrow();
      expect(await marker(db)).toEqual([]);
      await expect(assertPublicInstallation(db, expected)).rejects.toThrow();
    });
  }, 60_000);

  it.for([
    'DELETE FROM public."PublicInstallation"',
    'UPDATE public._prisma_migrations SET checksum = repeat(\'0\', 64)',
    'UPDATE public._prisma_migrations SET finished_at = NULL',
    'UPDATE public._prisma_migrations SET rolled_back_at = now()',
    'UPDATE public._prisma_migrations SET applied_steps_count = 0',
    'UPDATE public._prisma_migrations SET migration_name = \'20260101000000_private_history\'',
    'INSERT INTO public._prisma_migrations SELECT \'duplicate\', checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count FROM public._prisma_migrations',
    'ALTER TABLE public."PublicInstallation" DROP CONSTRAINT "PublicInstallation_lineage_check"',
  ])("admission refuses damaged history without changing rows: %s", { timeout: 60_000 }, async (sql, ctx) => {
    await withDatabase(ctx, async (db, url, exec) => {
      await bootstrapPublicDatabase(db, () => migrate(url, exec), expected);
      await db.$executeRawUnsafe(sql);
      if (sql.startsWith("ALTER")) await db.$executeRawUnsafe('UPDATE public."PublicInstallation" SET lineage = \'other-lineage\'');
      const before = await snapshot(db);
      const historyBefore = await db.$queryRaw`SELECT * FROM public._prisma_migrations ORDER BY id`;
      await expect(assertPublicInstallation(db, expected)).rejects.toThrow();
      await expect(assertPublicInstallation(db, [baseline, additive], { allowPending: true })).rejects.toThrow();
      expect(await snapshot(db)).toEqual(before);
      expect(await db.$queryRaw`SELECT * FROM public._prisma_migrations ORDER BY id`).toEqual(historyBefore);
    });
  });

  // No v1 SQL ships, so the v1 marker is written over a v2 install here.
  it("refuses a heatsynq-public-v1 marker in a sentence of its own, and any other lineage as before", async ctx => {
    await withDatabase(ctx, async (db, url, exec) => {
      await bootstrapPublicDatabase(db, () => migrate(url, exec), expected);
      await db.$executeRawUnsafe('ALTER TABLE public."PublicInstallation" DROP CONSTRAINT "PublicInstallation_lineage_check"');
      for (const [lineage, sentence] of [["heatsynq-public-v1", PUBLIC_V1_REFUSAL], ["other-lineage", GENERIC_REFUSAL]]) {
        await db.$executeRaw`UPDATE public."PublicInstallation" SET lineage = ${lineage}`;
        const before = await snapshot(db);
        const markerBefore = await marker(db);
        const historyBefore = await db.$queryRaw`SELECT * FROM public._prisma_migrations ORDER BY id`;
        await expect(assertPublicInstallation(db, expected)).rejects.toThrow(new Error(sentence));
        await expect(assertPublicInstallation(db, [baseline, additive], { allowPending: true })).rejects.toThrow(new Error(sentence));
        expect(await snapshot(db)).toEqual(before);
        expect(await marker(db)).toEqual(markerBefore);
        expect(await db.$queryRaw`SELECT * FROM public._prisma_migrations ORDER BY id`).toEqual(historyBefore);
      }
    });
  }, 60_000);

  it("permits only a known missing additive suffix before deploy, and requires it afterwards", async ctx => {
    await withDatabase(ctx, async (db, url, exec) => {
      await bootstrapPublicDatabase(db, () => migrate(url, exec), expected);
      const upgraded = [baseline, additive];
      await expect(assertPublicInstallation(db, upgraded)).rejects.toThrow();
      await assertPublicInstallation(db, upgraded, { allowPending: true });
      await recordAdditive(db);
      await assertPublicInstallation(db, upgraded);
      await expect(assertPublicInstallation(db, expected)).rejects.toThrow();
      await db.$executeRaw`DELETE FROM public._prisma_migrations WHERE migration_name = ${additive.name}`;
      await recordAdditive(db, later);
      await expect(assertPublicInstallation(db, [baseline, additive, later], { allowPending: true })).rejects.toThrow();
    });
  }, 60_000);

  it("initializes with a completed compatible additive migration", async ctx => {
    await withDatabase(ctx, async (db, url, exec) => {
      await bootstrapPublicDatabase(db, async () => { await migrate(url, exec); await recordAdditive(db); }, [baseline, additive]);
      await assertPublicInstallation(db, [baseline, additive]);
    });
  }, 60_000);

  it("deploys a real additive Prisma migration while preserving existing application rows", async ctx => {
    await withDatabase(ctx, async (db, url, exec) => {
      await bootstrapPublicDatabase(db, () => migrate(url, exec), expected);
      await db.role.create({ data: { id: "retained-role", name: "Retained" } });
      const customer = await db.customer.create({ data: { code: "UPGRADE", name: "Upgrade fixture" } });
      await db.order.create({ data: { orderNumber: 7654321, customerId: customer.id, receivedDate: new Date("2026-09-15T00:00:00Z"), requestDate: new Date("2026-09-16T00:00:00Z"), notes: "Preserve this existing order." } });
      const original = await db.documentTemplateVersion.findUniqueOrThrow({ where: { id: "standard-cert-v1" } });
      const config = structuredClone(original.config) as { textBlocks: Record<string, string> };
      config.textBlocks.cert_statement = "Fixture-approved certification wording.";
      await db.documentTemplateVersion.create({ data: { id: "custom-cert-v2", templateId: "standard-cert", versionNumber: 2, status: "PUBLISHED", config, publishedAt: new Date() } });
      await db.documentTemplate.update({ where: { id: "standard-cert" }, data: { publishedVersionId: "custom-cert-v2" } });
      await db.customerTemplateAssignment.create({ data: { customerId: customer.id, docType: "CERT", templateId: "standard-cert" } });
      const customersBefore = await db.customer.findMany({ orderBy: { id: "asc" } });
      const ordersBefore = await db.order.findMany({ orderBy: { id: "asc" } });
      const assignmentsBefore = await db.customerTemplateAssignment.findMany();
      const ledgerBefore = await db.$queryRaw`SELECT * FROM public._prisma_migrations ORDER BY id`;
      const baselineBefore = await readFile(join(process.cwd(), "prisma/migrations", baseline.name, "migration.sql"));
      const before = await snapshot(db);
      const markerBefore = await marker(db);
      const rolesBefore = await db.role.findMany();
      // The disposable config lives below erp so prisma/config resolves from its dependencies.
      const root = await mkdtemp(join(process.cwd(), ".public-upgrade-"));
      try {
        await mkdir(join(root, "migrations", baseline.name), { recursive: true });
        await mkdir(join(root, "migrations", additive.name));
        await writeFile(join(root, "migrations", baseline.name, "migration.sql"),
          await readFile(join(process.cwd(), "prisma/migrations", baseline.name, "migration.sql")));
        const sql = 'CREATE TABLE public."PublicAdditiveExample" (id TEXT PRIMARY KEY);\n';
        await writeFile(join(root, "migrations", additive.name, "migration.sql"), sql);
        await writeFile(join(root, "migrations", "migration_lock.toml"), 'provider = "postgresql"\n');
        await writeFile(join(root, "public-migrations.json"), JSON.stringify([baseline,
          { name: additive.name, sha256: createHash("sha256").update(sql).digest("hex") }]));
        await writeFile(join(root, "prisma.config.ts"),
          'import { defineConfig } from "prisma/config";\nexport default defineConfig({ schema: "../prisma/schema.prisma", migrations: { path: "./migrations" }, datasource: { url: process.env.DATABASE_URL! } });\n');
        const upgraded = await loadPublicMigrations(root);
        await expect(assertPublicInstallation(db, upgraded)).rejects.toThrow();
        await assertPublicInstallation(db, upgraded, { allowPending: true });
        await exec(process.execPath, [join(process.cwd(), "node_modules/prisma/build/index.js"), "migrate", "deploy", "--config", join(root, "prisma.config.ts")], {
          cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, maxBuffer: 1024 * 1024,
        });
        await assertPublicInstallation(db, upgraded);
        expect(await db.$queryRaw`SELECT * FROM public."PublicAdditiveExample"`).toEqual([]);
        expect(await snapshot(db)).toEqual(before);
        expect(await marker(db)).toEqual(markerBefore);
        expect(await db.role.findMany()).toEqual(rolesBefore);
        expect(await db.customer.findMany({ orderBy: { id: "asc" } })).toEqual(customersBefore);
        expect(await db.order.findMany({ orderBy: { id: "asc" } })).toEqual(ordersBefore);
        expect(await db.customerTemplateAssignment.findMany()).toEqual(assignmentsBefore);
        expect(await db.$queryRaw`SELECT * FROM public._prisma_migrations WHERE migration_name = ${baseline.name} ORDER BY id`).toEqual(ledgerBefore);
        expect(await readFile(join(process.cwd(), "prisma/migrations", baseline.name, "migration.sql"))).toEqual(baselineBefore);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }, 60_000);

  it("rejects malformed expected histories before admitting a valid database", async ctx => {
    await withDatabase(ctx, async (db, url, exec) => {
      await bootstrapPublicDatabase(db, () => migrate(url, exec), expected);
      for (const invalid of [[], [additive], [baseline, baseline], [baseline, later, additive],
        [{ ...baseline, sha256: "0".repeat(64) }], [baseline, { name: "../escape", sha256: additive.sha256 }]]) {
        await expect(assertPublicInstallation(db, invalid, { allowPending: true })).rejects.toThrow();
      }
    });
  }, 60_000);

  it("uses public schema explicitly and refuses a different active schema", async ctx => {
    await withDatabase(ctx, async (db, url, exec) => {
      await bootstrapPublicDatabase(db, () => migrate(url, exec), expected);
      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe("SET LOCAL search_path = pg_catalog");
        await expect(assertPublicInstallation(tx, expected)).rejects.toThrow();
      });
    });
  }, 60_000);
});

describe("public bootstrap endpoint", () => {
  it("the CLI uses the canonical target despite ambient PG overrides and refuses a second bootstrap", async ctx => {
    await withDatabase(ctx, async (db, url, exec) => {
      const args = [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "scripts/public-bootstrap.ts"];
      const options = { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url, PGPORT: "1", PGHOST: "invalid.example",
        PGDATABASE: "wrong_database", PGUSER: "wrong_user", PGOPTIONS: "-c search_path=wrong_schema" }, maxBuffer: 1024 * 1024 };
      const { stdout, stderr } = await exec(process.execPath, args, options);
      expect(stdout).toContain("New public database initialized");
      expect(stdout + stderr).not.toContain(url);
      const before = await snapshot(db);
      const markerBefore = await marker(db);
      await assertPublicInstallation(db, expected);
      await expect(exec(process.execPath, args, options)).rejects.toMatchObject({ code: 1 });
      expect(await snapshot(db)).toEqual(before);
      expect(await marker(db)).toEqual(markerBefore);
    });
  }, 60_000);

  it("canonicalizes the explicit endpoint and refuses schema or connection overrides", () => {
    expect(validateBootstrapUrl("postgresql://user:password@localhost/example?schema=public")).toBe("postgresql://user:password@localhost:5432/example?schema=public");
    for (const suffix of ["?schema=private", "?host=other", "?schema=public&schema=public", "#fragment"]) {
      expect(() => validateBootstrapUrl("postgresql://user:password@localhost/example" + suffix)).toThrow();
    }
  });
});
