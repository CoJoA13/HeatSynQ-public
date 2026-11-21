// #517: one rule reads a typed decimal, `src/lib/decimal-entry.ts` (decimal entry design §2). A
// pattern that reads digits around a point, written anywhere else in `src/`, is a hand copy of it
// that can drift, which is how one screen came to take ".36" while the box beside it refused it.
//
// SCOPE: every `.ts`/`.tsx` file under `src/`, walked, never hand-listed. A pattern counts when it
// names a digit (`\d` or `[0-9]`) and a literal point (`\.` or `[.]`). FAILS CLOSED: it over-matches
// (an archive name, a timestamp) and each such file is an exemption here with its reason. The
// escape hatch for a decimal box is the leaf, never an exemption. Only regular-expression literals
// and the literal, string or template first argument of a bare `RegExp(…)` are read, so a pattern
// built another way (held in a const, concatenated) is not seen.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { regexTexts } from "./helpers/ts-parse";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const LEAF = "src/lib/decimal-entry.ts";

const EXEMPT: Record<string, string> = {
  "src/server/part-field-values.ts": "a part's Number custom field is left out by the owner (spec §1.2 ruling 3)",
  "src/server/part-process-steps.ts": "a step's Number parameter is left out by the owner (spec §1.2 ruling 3)",
  "src/lib/recipe-snapshot.ts": "the recipe snapshot LoadSynQ reads keeps its shape (spec §1.2 ruling 3)",
  "src/lib/format.ts": "display formatting of a stored figure and a timestamp, not an entry rule",
  "src/lib/rate-display.ts": "an exact shift of a percent's point; the figure is read by decimalField",
  "src/lib/backup-constants.ts": "backup archive file names",
  "src/server/search.ts": "the search box's order-number range scan, not a decimal box",
  "src/lib/container-refusal-field.ts": "a server refusal's path, containers.<row>.<key>: its digits are a row number, not a decimal box",
  "src/lib/line-refusal-field.ts": "a server refusal's path, lines.<line>.<key> or lines.<line>.serials.<serial>.<key>: its digits are row numbers, not a decimal box",
  "src/lib/charge-refusal-field.ts": "a server refusal's path, charges.<row>.<key>: its digits are a row number, not a decimal box",
  "src/lib/release-contracts.ts": "release version and ISO timestamp patterns of the release-update contracts, not a decimal box",
  "src/lib/release-version.ts": "release version (1.4.0, 1.4.0-rc.2) pattern, not a decimal box",
  "src/lib/shipment-box-ids.ts": "a server refusal's path, orders.<order>.lines.<row>.<key>: its digits are order and row numbers, not a decimal box",
};

const DIGIT = /\\d|\[0-9\]/;
const POINT = /\\\.|\[\.\]/;
const isDecimalPattern = (text: string) => DIGIT.test(text) && POINT.test(text);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const code = walk(SRC).map((full) => relative(ROOT, full).split(sep).join("/"))
  .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));
const hits = (file: string) => regexTexts(readFileSync(join(ROOT, file), "utf8"), file)
  .filter(({ text }) => isDecimalPattern(text));

describe("regexTexts (the parsed primitive the sweep asks)", () => {
  it.each([
    ["a literal", "const p = /^\\d+(\\.\\d+)?$/;"],
    ["new RegExp of a string", 'const p = new RegExp("^\\\\d+\\\\.\\\\d$");'],
    ["new RegExp of a template", "const p = new RegExp(`^\\\\d{1,${n}}(\\\\.\\\\d{1,${s}})?$`);"],
    ["RegExp called bare", 'const p = RegExp("[0-9][.][0-9]");'],
    ["a zod regex", "z.string().regex(/^-?\\d{1,12}(\\.\\d{1,6})?$/)"],
  ])("finds %s", (_label, src) => {
    expect(regexTexts(src).some(({ text }) => isDecimalPattern(text))).toBe(true);
  });
  it("does not count a string that is not a pattern", () => {
    expect(regexTexts('const s = "\\\\d and \\\\.";').length).toBe(0);
  });
});

describe("no decimal pattern outside the leaf", () => {
  it("the leaf holds one", () => {
    expect(hits(LEAF).length).toBeGreaterThan(0);
  });
  it.each(code.filter((file) => file !== LEAF && !(file in EXEMPT)))("%s writes none", (file) => {
    expect(hits(file)).toEqual([]);
  });
  it.each(Object.keys(EXEMPT))("the exemption for %s still names a file with a pattern", (file) => {
    expect(code).toContain(file);
    expect(hits(file).length).toBeGreaterThan(0);
  });
});
