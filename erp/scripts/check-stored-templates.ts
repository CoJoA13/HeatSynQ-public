/**
 * Prints the listing of an install's stored templates from an export file (weights design §13.2).
 *
 *   npx tsx scripts/check-stored-templates.ts <export file>
 *   npx tsx scripts/check-stored-templates.ts <export file> --clamp
 *
 * The file holds one line of JSON for each database: {"database": "...", "versions": [...]}, the
 * versions as scripts/stored-templates.sql answers them. Exit 0: no row stops the merge. Exit 1: a
 * row does. Exit 2: the file could not be read as that shape, or held a version this checker
 * cannot judge, and no listing was printed.
 *
 * With `--clamp` it prints instead, for each stored version, which of its flow's table sections the
 * column clamp (#991) lays out differently from the flow before it, judged around a one-character
 * stand-in record (scripts/lib/stored-template-clamp.ts, design
 * docs/superpowers/specs/2026-11-17-991-flow-tables-in-box-design.md §7). It reads no database and
 * writes nothing, and stops no merge: exit 0, or 2 as above. Its builders want a `DATABASE_URL`, so
 * an unreachable one is set when none is; no query is made.
 *
 * It is run with TMPDIR, TMP and TEMP unset or short: under a long one tsx fails before this
 * command starts, with exit 1 and no listing, which is not a row.
 */
import { readFileSync } from "node:fs";
import { z, ZodError } from "zod";
import { issueWording, listing, stopsTheMerge, type ExportedVersion } from "./lib/stored-template-check";

const exportLine = z.object({
  database: z.string().min(1),
  versions: z.array(z.object({
    docType: z.string(), templateId: z.string(), templateName: z.string(), isDefault: z.boolean(),
    templateDeleted: z.boolean(), versionId: z.string(), versionNumber: z.number().int(), status: z.string(),
    published: z.boolean(), customers: z.array(z.object({ code: z.string(), name: z.string() })),
    config: z.unknown(),
  })),
});

const reason = (error: unknown): string =>
  error instanceof ZodError ? issueWording(error) : error instanceof Error ? error.message : String(error);

const USAGE = "Usage: npx tsx scripts/check-stored-templates.ts <export file> [--clamp]";

/** The export file's databases, each parsed: a line that is not one throws, naming it. */
function readExport(file: string) {
  const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new Error(`${file} holds no line`);
  return lines.map((line, index) => {
    try {
      return exportLine.parse(JSON.parse(line));
    } catch (error) {
      throw new Error(`Line ${index + 1} of ${file} is not one database's export: ${reason(error)}`);
    }
  });
}

/** The `--clamp` listing (#991): every database judged before anything prints. */
async function clamp(file: string): Promise<number> {
  const databases = readExport(file);
  // The builders' module graph opens a Prisma client on import and wants a URL; nothing queries it.
  process.env.DATABASE_URL ??= "postgresql://listing-reads-no-database@127.0.0.1:1/none";
  const { clampListing } = await import("./lib/stored-template-clamp");
  const pages: string[] = [];
  for (const d of databases) pages.push(await clampListing(d.database, d.versions satisfies ExportedVersion[]));
  console.log(pages.join("\n\n"));
  return 0;
}

function main(): number | Promise<number> {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith("--"));
  const files = args.filter((a) => !a.startsWith("--"));
  if (files.length !== 1 || flags.some((f) => f !== "--clamp")) throw new Error(USAGE);
  const file = files[0];
  if (flags.includes("--clamp")) return clamp(file);
  const databases = readExport(file);
  // Every database is judged before anything prints, so a file that cannot be judged prints no listing.
  const pages = databases.map((d) => listing(d.database, d.versions satisfies ExportedVersion[]));
  console.log(pages.join("\n\n"));
  return databases.some((d) => stopsTheMerge(d.versions)) ? 1 : 0;
}

Promise.resolve().then(main).then(
  (code) => { process.exitCode = code; },
  (error: unknown) => {
    console.error(reason(error));
    process.exitCode = 2;
  },
);
