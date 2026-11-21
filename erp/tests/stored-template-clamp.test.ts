import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { TEMPLATE_DOC_TYPES, defaultConfigFor, type TemplateConfig } from "@/lib/template-contracts/index";
import { CANVAS_VERDICT, clampListing, clampVerdict, standInFor, verdictWords } from "../scripts/lib/stored-template-clamp";
import { flowTableMarkOf } from "@/server/pdf/canvas-nodes";
import { flowTableSections } from "@/server/pdf/flow-tables";
import { definitionsOf, type PaperDoc } from "./helpers/canvas-paper-dump";
import type { ExportedVersion } from "../scripts/lib/stored-template-check";
import { seedLiteral, storedBefore, storedNames } from "./helpers/stored-configs";
import { standardLayout } from "./helpers/canvas-fixtures";
import { FIRST_SEED_TYPES } from "./helpers/stored-configs";

/**
 * The stored-template listing's `--clamp` verdict (#991, design docs/superpowers/specs/2026-11-17-991-flow-tables-in-box-design.md
 * §7): which of a stored version's flow table sections the column clamp moves, read off render.ts' own report of the
 * clamp firing around a one-character stand-in record.
 */

const version = (docType: string, config: unknown, over: Partial<ExportedVersion> = {}): ExportedVersion => ({
  docType, templateId: "t-1", templateName: "Standard", isDefault: true, templateDeleted: false,
  versionId: "v-1", versionNumber: 1, status: "PUBLISHED", published: true, customers: [], config, ...over,
});
function edited(docType: (typeof TEMPLATE_DOC_TYPES)[number], edit: (c: TemplateConfig) => void): TemplateConfig {
  const c = structuredClone(defaultConfigFor(docType));
  edit(c);
  return c;
}
const field = (c: TemplateConfig, section: string, key: string) =>
  c.sections.find((s) => s.key === section)!.fields.find((f) => f.key === key)!;

describe("clampVerdict (#991)", () => {
  it.each(TEMPLATE_DOC_TYPES)("finds nothing moved at %s's Standard config", async (docType) => {
    expect(await clampVerdict(version(docType, defaultConfigFor(docType)))).toBe("none");
  }, 30_000);

  it("finds nothing moved on any seed literal or config frozen before the weights paper", async () => {
    for (const docType of FIRST_SEED_TYPES) {
      expect(await clampVerdict(version(docType, seedLiteral(docType))), docType).toBe("none");
      for (const name of storedNames(docType)) {
        const verdict = await clampVerdict(version(docType, storedBefore(docType, name)));
        // The two frozen ticket configs whose columns pass the half are refused by R-B (stored-template-configs.test.ts).
        const refused = (docType === "SHIPPER" || docType === "MOS_SHIPPER") && (name === "widths-full" || name === "type-width-220");
        if (refused) expect(verdict, `${docType} ${name}`).toMatch(/^REFUSED: The "containers" table needs /);
        else expect(verdict, `${docType} ${name}`).not.toMatch(/^REFUSED/);
      }
    }
  }, 120_000);

  it("names the quantities on a traveler whose headings pass the page, and not one whose headings fit", async () => {
    const past = edited("TRAVELER", (c) => { field(c, "quantities", "order_qty").width = 150; });
    expect(await clampVerdict(version("TRAVELER", past))).toBe("prints inside the page now: Quantities and containers");
    const fits = edited("TRAVELER", (c) => { field(c, "quantities", "order_qty").width = 149; });
    expect(await clampVerdict(version("TRAVELER", fits))).toBe("none");
  }, 30_000);

  it("names the containers on a ticket at a 12 pt base", async () => {
    for (const docType of ["SHIPPER", "MOS_SHIPPER"] as const) {
      const big = edited(docType, (c) => { c.fonts.baseSize = 12; });
      expect(await clampVerdict(version(docType, big)), docType).toMatch(/^prints inside the page now: .*Container/);
    }
  }, 30_000);

  it("reads a table whose fixed columns pass the page as REFUSED (owner ruling R-B), and words a row left past it", async () => {
    const past = edited("SHIPPER", (c) => { field(c, "containers", "container_type").width = 190; });
    expect(await clampVerdict(version("SHIPPER", past))).toMatch(/^REFUSED: The "containers" table needs 288\.5pt on paper/);
    expect(verdictWords("BOL", { moved: [], overran: ["freight"] })).toBe("prints past the page as before: Freight");
    expect(verdictWords("TRAVELER", { moved: ["quantities"], overran: ["inspections"] })).toBe(
      "prints inside the page now: Quantities and containers; and prints past the page as before: Key characteristic inspections");
    expect(verdictWords("CERT", { moved: [], overran: [] })).toBe("none");
  }, 30_000);

  it("says a canvas keeps its tables in their boxes, and words a refusal as the listing does", async () => {
    const canvas = { ...structuredClone(defaultConfigFor("TRAVELER")), layout: standardLayout() };
    expect(await clampVerdict(version("TRAVELER", canvas))).toBe(CANVAS_VERDICT);
    expect(await clampVerdict(version("TRAVELER", { sections: "no" }))).toMatch(/^REFUSED: /);
    await expect(clampVerdict(version("LETTERHEAD", {}))).rejects.toThrow(/document type this checker does not know: LETTERHEAD/);
  }, 30_000);
});

describe("the listing's stand-ins print every table section (#991)", () => {
  it.each(TEMPLATE_DOC_TYPES.filter((d) => d !== "CONTAINER_TAG"))("%s's stand-in reaches each of its flow table sections", async (docType) => {
    const data = await standInFor(docType);
    const found = new Set<string>();
    const walk = (node: unknown) => {
      if (node === null || typeof node !== "object") return;
      const key = flowTableMarkOf(node);
      if (key !== undefined) found.add(key);
      Object.values(node).forEach(walk);
    };
    for (const def of definitionsOf({ name: "stand-in", doc: docType as PaperDoc, config: defaultConfigFor(docType), data, premise: { kind: "full" } })) {
      walk(def.content);
    }
    // A section the stand-in left empty would read "none" whatever its template drives.
    expect([...found].sort()).toEqual([...flowTableSections(docType)].sort());
  }, 30_000);
});

describe("scripts/check-stored-templates.ts --clamp, the command (#991)", () => {
  const dir = mkdtempSync(join(tmpdir(), "stored-clamp-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  async function run(args: string[], lines: unknown[], env: NodeJS.ProcessEnv) {
    const file = join(dir, "export.jsonl");
    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const argv = [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "scripts/check-stored-templates.ts", file, ...args];
    // As the default listing's command test: tsx opens a socket under the temporary folder.
    const clean = { ...env };
    delete clean.TMPDIR;
    delete clean.TMP;
    delete clean.TEMP;
    return promisify(execFile)(process.execPath, argv, { cwd: process.cwd(), env: clean }).then(
      (ran) => ({ code: 0, stdout: ran.stdout, stderr: ran.stderr }),
      (failed: { code: number; stdout: string; stderr: string }) => ({ code: failed.code, stdout: failed.stdout, stderr: failed.stderr }));
  }
  const past = version("TRAVELER", edited("TRAVELER", (c) => { field(c, "quantities", "order_qty").width = 150; }), { versionId: "v-2" });
  const clean = version("CERT", defaultConfigFor("CERT"));

  it("prints each database's clamp listing and exits 0, with no DATABASE_URL in its environment", async () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const ran = await run(["--clamp"], [{ database: "erp", versions: [clean, past] }], env);
    expect({ code: ran.code, stdout: ran.stdout }).toEqual({ code: 0, stdout: `${await clampListing("erp", [clean, past])}\n` });
    expect(ran.stdout).toContain("| Traveler | Standard (default) | 1 | in use | none | prints inside the page now: Quantities and containers |");
  }, 60_000);

  it("refuses an option it does not know, exit 2 and no listing", async () => {
    const ran = await run(["--clamps"], [{ database: "erp", versions: [clean] }], process.env);
    expect({ code: ran.code, stdout: ran.stdout }).toEqual({ code: 2, stdout: "" });
    expect(ran.stderr).toMatch(/^Usage: npx tsx scripts\/check-stored-templates\.ts <export file> \[--clamp\]/);
  }, 60_000);
});
