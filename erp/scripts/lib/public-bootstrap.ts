import { isDeepStrictEqual } from "node:util";
import type { Prisma, PrismaClient } from "../../prisma/generated/prisma/client";
import { assertPublicMigrationHistory } from "./public-installation";
import { loadPublicBaselineTemplates, loadPublicMigrations, PUBLIC_BASELINE, PUBLIC_LINEAGE,
  validateExpectedMigrations, type BaselineTemplate, type ExpectedMigration } from "./public-migrations";

/** One endpoint and schema for raw access, adapter and migration engine. Never log the URL. */
export function validateBootstrapUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("db:bootstrap requires a PostgreSQL DATABASE_URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || url.pathname.length < 2 || url.hash) {
    throw new Error("db:bootstrap requires a PostgreSQL DATABASE_URL with a database name");
  }
  for (const key of url.searchParams.keys()) {
    if (!["schema", "sslmode"].includes(key) || url.searchParams.getAll(key).length !== 1) {
      throw new Error("db:bootstrap refuses unsupported connection overrides; use the public schema");
    }
  }
  if (url.searchParams.has("schema") && url.searchParams.get("schema") !== "public") {
    throw new Error("db:bootstrap supports only the public schema");
  }
  if (!url.port) url.port = "5432";
  return url.toString();
}

const EMPTY_REFUSAL = "db:bootstrap requires a completely empty database; inspect existing or incomplete installations before proceeding.";
const DIRTY_REFUSAL = "db:bootstrap found unexpected baseline data; keep services stopped and inspect this incomplete installation.";
const quoted = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const dirty = (): never => { throw new Error(DIRTY_REFUSAL); };
const validTimestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
type JsonRow = Record<string, unknown>;

async function assertEmpty(tx: Prisma.TransactionClient): Promise<void> {
  const [row] = await tx.$queryRaw<{ empty: boolean }[]>`
    SELECT NOT (
      EXISTS (SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public', 'pg_catalog', 'information_schema')
        AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%')
      OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public')
      OR EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public')
      OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public')
    ) AS empty`;
  if (!row?.empty) throw new Error(EMPTY_REFUSAL);
}

async function assertCleanBaseline(tx: Prisma.TransactionClient, frozen: BaselineTemplate[]): Promise<void> {
  const tables = await tx.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
  if (tables.length === 0) dirty();
  // Services must remain stopped. This additionally excludes ordinary writes between the
  // final data inspection and marker commit, including seed on a separate connection.
  await tx.$executeRawUnsafe(`LOCK TABLE ${tables.map(t => 'public.' + quoted(t.tablename)).join(', ')} IN SHARE ROW EXCLUSIVE MODE`);
  const allowedRows = new Set(["_prisma_migrations", "BillingConfig", "SetupState", "UpdateHold", "DocumentTemplate", "DocumentTemplateVersion"]);
  for (const { tablename } of tables) {
    if (allowedRows.has(tablename)) continue;
    const [row] = await tx.$queryRawUnsafe<{ present: boolean }[]>(`SELECT EXISTS (SELECT 1 FROM public.${quoted(tablename)}) AS present`);
    if (row?.present) dirty();
  }

  const billing = await tx.$queryRaw<{ value: JsonRow }[]>`SELECT to_jsonb(b) AS value FROM public."BillingConfig" b`;
  const setup = await tx.$queryRaw<{ value: JsonRow }[]>`SELECT to_jsonb(s) AS value FROM public."SetupState" s`;
  const hold = await tx.$queryRaw<{ value: JsonRow }[]>`SELECT to_jsonb(u) AS value FROM public."UpdateHold" u`;
  if (billing.length !== 1 || setup.length !== 1 || hold.length !== 1) dirty();
  const b = billing[0].value, s = setup[0].value, u = hold[0].value;
  if (b.id !== "singleton" || b.billForCertDefault !== false || !validTimestamp(b.updatedAt)
    || s.id !== "singleton" || s.numbersConfirmedAt !== null || s.checklistDismissedAt !== null || !validTimestamp(s.updatedAt)
    || u.id !== "singleton" || u.held !== false || u.fromVersion !== null || u.heldById !== null || u.heldAt !== null
    || !validTimestamp(u.updatedAt)) dirty();
  for (const key of ["salesTaxRate", "salesTaxGlAccountId", "freightGlAccountId", "otherChargeGlAccountId",
    "certChargeStepCodeId", "certChargeDefault", "financeChargeRate", "arGlAccountId", "discountGlAccountId", "writeOffGlAccountId"]) {
    if (b[key] !== null) dirty();
  }

  const templates = await tx.$queryRaw<{ value: JsonRow }[]>`SELECT to_jsonb(t) AS value FROM public."DocumentTemplate" t`;
  const versions = await tx.$queryRaw<{ value: JsonRow }[]>`SELECT to_jsonb(v) AS value FROM public."DocumentTemplateVersion" v`;
  if (templates.length !== frozen.length || versions.length !== frozen.length) dirty();
  for (const expected of frozen) {
    const id = `standard-${expected.docType.toLowerCase().replaceAll("_", "-")}`;
    const template = templates.find(row => row.value.id === id)?.value;
    const version = versions.find(row => row.value.id === id + "-v1")?.value;
    if (!template || !version || template.docType !== expected.docType || template.name !== "Standard"
      || template.isDefault !== true || template.deletedAt !== null || template.publishedVersionId !== id + "-v1"
      || !validTimestamp(template.createdAt) || !validTimestamp(template.updatedAt)
      || version.templateId !== id || version.versionNumber !== 1 || version.status !== "PUBLISHED"
      || version.logoImage !== null || version.logoMimeType !== null || version.publishedById !== null
      || !validTimestamp(version.createdAt) || !validTimestamp(version.updatedAt) || !validTimestamp(version.publishedAt)
      || !isDeepStrictEqual(version.config, expected.config)) dirty();
  }
}

/**
 * One-time initialization of an empty database with application services stopped.
 * Migrations commit separately. Any later failure leaves no completion marker and cannot
 * be resumed automatically: inspect it and use a fresh empty database if disposable.
 */
export async function bootstrapPublicDatabase(db: PrismaClient, migrate: () => Promise<void>, manifest?: ExpectedMigration[], prismaDirectory?: string): Promise<void> {
  const expected = validateExpectedMigrations(manifest ?? await loadPublicMigrations(prismaDirectory));
  const frozen = await loadPublicBaselineTemplates(prismaDirectory);
  await db.$transaction(async tx => {
    const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtext(${'heatsynq:new-install-bootstrap'})) AS acquired`;
    if (!lock?.acquired) throw new Error("db:bootstrap is already running for this database");
    const [schema] = await tx.$queryRaw<{ name: string | null }[]>`SELECT current_schema() AS name`;
    if (schema?.name !== "public") throw new Error("db:bootstrap requires public as the active schema");
    await assertEmpty(tx);
    await migrate();
    await assertCleanBaseline(tx, frozen);
    await assertPublicMigrationHistory(tx, expected);
    await tx.$executeRaw`INSERT INTO public."PublicInstallation" (id, lineage, "baselineMigration", "completedAt")
      VALUES ('singleton', ${PUBLIC_LINEAGE}, ${PUBLIC_BASELINE}, clock_timestamp())`;
  }, { timeout: 180_000, maxWait: 5_000 });
}
