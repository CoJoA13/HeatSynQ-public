// The three release-update contracts (ops/releases/contracts/README.md). Client-safe: imports only zod.
// Each parser returns the parsed value or null; every schema is strict, so an unknown key is a refusal.
import { z } from "zod";

const hex = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`);
const sha1 = z.string().regex(hex(40));
const sha256 = z.string().regex(hex(64));
const imageId = z.string().regex(/^sha256:[0-9a-f]{64}$/);
// Every pattern matches the whole string. Same pattern as readProtectedTag in erp/scripts/github-release-prepare.mjs.
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-rc\.[1-9]\d*)?$/;
const version = z.string().regex(VERSION);
// UTC only, whole string: seconds required, one to six fractional digits allowed, no offset (Python's
// isoformat() writes +00:00 and is refused, so the agent formats its own times). Date.parse then
// refuses an impossible date such as month 13.
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const isoZ = z.string().refine((s) => ISO_Z.test(s) && !Number.isNaN(Date.parse(s)));
// An uploaded file's name: one path segment of safe characters.
const assetName = z.string().regex(/^[A-Za-z0-9._-]+$/).refine((s) => s !== "." && s !== "..");
// previousRelease names a tag: "v" + a version.
const tagName = z.string().regex(new RegExp(`^v${VERSION.source.slice(1)}`));
const nonEmpty = z.string().min(1);
const posInt = z.number().int().positive();
const asset = z.object({ asset: assetName, sha256 }).strict();

export const releaseManifestSchema = z
  .object({
    schemaVersion: z.literal(3),
    provider: z.literal("github"),
    tag: nonEmpty,
    version,
    prerelease: z.boolean(),
    commit: sha1,
    tagObjectSha: sha1,
    repository: z.object({ id: posInt, name: nonEmpty }).strict(),
    pipeline: z.object({ id: posInt, url: nonEmpty }).strict(),
    producer: z.object({ attempt: posInt, jobId: posInt }).strict(),
    platform: nonEmpty,
    image: z.object({ asset: assetName, sha256, imageId }).strict(),
    bundle: asset,
    hostTools: asset,
    migrations: z.array(nonEmpty),
    databaseChanges: z.boolean(),
    previousRelease: tagName.nullable(),
  })
  .strict()
  .superRefine((m, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: "custom", message });
    if (m.tag !== `v${m.version}`) bad("tag must be v + version");
    if (m.prerelease !== /-rc\.\d+$/.test(m.version)) bad("prerelease must match the version");
    for (let i = 1; i < m.migrations.length; i++) {
      if (!(m.migrations[i - 1] < m.migrations[i])) bad("migrations must be sorted and unique");
    }
    if (m.previousRelease === null && m.databaseChanges) bad("no previous release means no database changes");
  });
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

const note = z
  .object({ version, publishedAt: isoZ, databaseChanges: z.boolean(), body: z.string() })
  .strict();
const pending = z
  .object({
    version,
    publishedAt: isoZ,
    firstSeenAt: isoZ,
    databaseChanges: z.boolean(),
    installAfter: isoZ,
    state: z.enum(["scheduled", "held", "manual"]),
    reason: nonEmpty.nullable(),
  })
  .strict()
  .refine((p) => (p.state === "scheduled" ? p.reason === null : p.reason !== null), {
    message: "reason is a sentence for held/manual, else null",
  });

export const updateStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    writtenAt: isoZ,
    running: z.object({ version, at: isoZ }).strict(),
    pending: pending.nullable(),
    notes: z.array(note).max(10),
  })
  .strict();
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

export const updateHoldSchema = z.union([
  z
    .object({ schemaVersion: z.literal(1), held: z.literal(true), fromVersion: version, by: nonEmpty, at: isoZ })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      held: z.literal(false),
      fromVersion: z.null(),
      by: z.null(),
      at: z.null(),
    })
    .strict(),
]);
export type UpdateHold = z.infer<typeof updateHoldSchema>;

function parseWith<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const r = schema.safeParse(value);
  return r.success ? r.data : null;
}

export const parseReleaseManifest = (value: unknown): ReleaseManifest | null =>
  parseWith(releaseManifestSchema, value);
export const parseUpdateStatus = (value: unknown): UpdateStatus | null => parseWith(updateStatusSchema, value);
export const parseUpdateHold = (value: unknown): UpdateHold | null => parseWith(updateHoldSchema, value);
