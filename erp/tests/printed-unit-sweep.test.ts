// No builder writes the weight unit itself (the weights design's §13.2, "The one place that writes
// the unit", and §13.7, point 29; owner ruling W15). The unit on a printed weight is written by
// `lb` and `lbEach` of src/server/pdf/printed-weight.ts and by nothing else, so a blank figure
// prints no unit and no document can drift from the others. This is the plan's own guard.
//
// SCOPE: every `.ts` file under src/server/pdf/ but that one, found by walking, and
// src/server/traveler.ts, the one builder that lives beside the folder.
//
// PARSED, never pattern-matched (#188): `literalTexts` gives every string and every piece of a
// template. It never gives a comment, an identifier or a property name written without quotes.
// It does give a property name written with quotes, a string written as a type and an import's
// path (its own docblock, tests/helpers/ts-parse.ts), and this check reads those like any other
// text. A text is refused when it holds "lb" as a word of its own, in any capitals. That fails
// closed: "Per lb" written in a builder would be refused too, and no builder writes it (the label
// comes with the data).
//
// WHAT IT DOES NOT SEE: "lb" written against a digit or an underscore ("5lb"), which counts as
// part of a word; a unit written as any other word ("pounds", "#"); a unit joined from pieces at
// run time; and a unit that a builder takes from a constant of another file. "lbs" is not this
// check's: tests/weight-words-sweep.test.ts refuses it everywhere under src/.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TEMPLATE_DOC_TYPES, contractFor } from "@/lib/template-contracts/index";
import { literalTexts } from "./helpers/ts-parse";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const UNIT_FILE = "src/server/pdf/printed-weight.ts";
const TRAVELER = "src/server/traveler.ts";

/** The texts of one source that hold "lb" as a word of its own, in the order they are written. */
function unitTexts(src: string, file: string): string[] {
  return literalTexts(src, file).map((held) => held.text).filter((text) => /\blb\b/i.test(text));
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
const underPdf = walk(join(ROOT, "src/server/pdf")).map((full) => relative(ROOT, full).split(sep).join("/"));
/** Every file this check reads: the builders and what they share, and never the unit's own file. */
const builders = [...underPdf.filter((file) => file.endsWith(".ts") && file !== UNIT_FILE), TRAVELER].sort();
/** Every field of every contract, with its built-in label. */
const labels = TEMPLATE_DOC_TYPES.flatMap((docType) => contractFor(docType).sections.flatMap((section) =>
  section.fields.map((field) => ({ field: `${docType}.${section.key}.${field.key}`, label: field.defaultLabel }))));

describe("the unit rule, on small sources", () => {
  it.each<[what: string, src: string, texts: string[]]>([
    ["a template's tail", "const s = `${num(w)} lb`;", [" lb"]],
    ["the small line's tail", "const s = `${num(t)} lb each`;", [" lb each"]],
    ["a string joined on", 'const s = num(w) + " lb";', [" lb"]],
    ["the unit alone", 'const u = "lb";', ["lb"]],
    ["the unit in capitals", 'const u = "LB";', ["LB"]],
    ["the unit inside a longer text", 'const s = "1,000 lb or more:";', ["1,000 lb or more:"]],
    ["money per weight written in a builder", 'const p = "Per lb";', ["Per lb"]],
  ])("refuses %s", (_what, src, texts) => {
    expect(unitTexts(src, "candidate.ts")).toEqual(texts);
  });

  it.each<[what: string, src: string]>([
    ["a call of the unit's functions", "const s = lb(num(w)); const t = lbEach(num(e));"],
    ["the import of them", 'import { lb, lbEach } from "./printed-weight";'],
    ["a comment", "// 1,600 lb\nconst n = 1; /* 42.5 lb each */"],
    ["an identifier and a property name", "const lb = 1; const c = { lb: 2, pricedPerLb: true };"],
    ["\"lb\" inside another word", 'const s = "bulb"; const t = "albatross"; const u = "lbx";'],
    ["\"lbs\", which is the weight-words check's", 'const s = "5 lbs";'],
    ["\"lb\" written against a digit, which this check does not see", 'const s = "5lb";'],
  ])("lets through %s", (_what, src) => {
    expect(unitTexts(src, "candidate.ts")).toEqual([]);
  });
});

describe("the unit on paper has one writer", () => {
  it("reads real files and real contracts", () => {
    // Floors that a reader which found nothing, or lost the traveler, would not meet.
    expect(builders).toEqual(expect.arrayContaining([
      "src/server/pdf/bol.ts", "src/server/pdf/cert.ts", "src/server/pdf/invoice.ts", "src/server/pdf/quote.ts",
      "src/server/pdf/render.ts", "src/server/pdf/shipping-ticket.ts", "src/server/pdf/statement.ts", TRAVELER,
    ]));
    // The extension filter is exhaustive only while the folder holds no other script type.
    expect(underPdf.filter((file) => /\.(?:tsx|[cm]?jsx?|mts|cts)$/.test(file))).toEqual([]);
    // The rule does find the unit where it is written: the one file left out is the one that holds it.
    expect(unitTexts(read(UNIT_FILE), UNIT_FILE)).toEqual([" lb", " lb each"]);
    expect(labels.map((held) => held.label)).toEqual(expect.arrayContaining(["Net weight", "Tare", "Gross weight:", "Order totals"]));
  });

  it("no builder writes the unit itself", () => {
    const found = builders.flatMap((file) => unitTexts(read(file), file).map((text) => `${file}: ${JSON.stringify(text)}`));
    expect(found, `A printed weight takes its unit from lb or lbEach of ${UNIT_FILE}, never from a text of the builder.`).toEqual([]);
  });

  it("no built-in label of any contract holds the unit", () => {
    expect(labels.filter((held) => /\blbs?\b/i.test(held.label))).toEqual([]);
  });
});
