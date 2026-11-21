import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export type ExpectedMigration = { name: string; sha256: string };
export const PUBLIC_BASELINE = "20261120000000_public_baseline_v2";
export const PUBLIC_LINEAGE = "heatsynq-public-v2";
export const PUBLIC_BASELINE_SHA256 = "e1246256bd4b46cf95e97d81253f939fbe248fcbfcab8e3e78b5ee6e217fd715";
const TEMPLATE_SHA256 = "be61662f0cdd2896e33def4815a6507810c1d7d08bfe3015392b545fa80350a2";
// Bundled modules move; shipped artifacts remain under the documented application cwd.
// The /*turbopackIgnore: true*/ is load-bearing (#334): without it the tracer copies all of prisma/ (seeds,
// schema, generated client) into the standalone build; next.config.ts's outputFileTracingIncludes names the files read.
const prismaDirectory = () => resolve(/*turbopackIgnore: true*/ process.cwd(), "prisma");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Fail closed before using names as paths or trusting a caller-supplied manifest. */
export function validateExpectedMigrations(value: unknown): ExpectedMigration[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Invalid public migration manifest");
  const result: ExpectedMigration[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).sort().join(",") !== "name,sha256"
      || typeof entry.name !== "string" || !/^\d{14}_[a-z0-9_]+$/.test(entry.name)
      || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || (result.length > 0 && result[result.length - 1].name >= entry.name)) {
      throw new Error("Invalid public migration manifest");
    }
    result.push({ name: entry.name, sha256: entry.sha256 });
  }
  if (result[0].name !== PUBLIC_BASELINE || result[0].sha256 !== PUBLIC_BASELINE_SHA256) {
    throw new Error("Public migration manifest does not match the supported baseline");
  }
  return result;
}

/** Production callers load the manifest from the shipped migration files, never the database. */
export async function loadPublicMigrations(directory = prismaDirectory()): Promise<ExpectedMigration[]> {
  try {
    const expected = validateExpectedMigrations(JSON.parse(await readFile(join(directory, "public-migrations.json"), "utf8")));
    const entries = await readdir(join(directory, "migrations"), { withFileTypes: true });
    const directories = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    if (entries.some(entry => !entry.isDirectory() && !(entry.isFile() && entry.name === "migration_lock.toml"))
      || directories.length !== expected.length || directories.some((name, i) => name !== expected[i].name)) {
      throw new Error("Migration directory mismatch");
    }
    for (const entry of expected) {
      if (digest(await readFile(join(directory, "migrations", entry.name, "migration.sql"))) !== entry.sha256) {
        throw new Error("Migration checksum mismatch");
      }
    }
    return expected;
  } catch {
    // Filesystem errors may include deployment paths; JSON errors can include file contents.
    throw new Error("Public migration files or manifest failed integrity validation");
  }
}

export type BaselineTemplate = { docType: string; config: unknown };
/** Frozen reviewed baseline values; future factory defaults must not redefine old installs. */
export async function loadPublicBaselineTemplates(directory = prismaDirectory()): Promise<BaselineTemplate[]> {
  try {
    const bytes = await readFile(join(directory, "public-baseline-templates.json"));
    if (digest(bytes) !== TEMPLATE_SHA256) throw new Error("Template checksum mismatch");
    return JSON.parse(bytes.toString("utf8")) as BaselineTemplate[];
  } catch {
    throw new Error("Public baseline template defaults failed integrity validation");
  }
}
