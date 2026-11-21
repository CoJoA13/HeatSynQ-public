// The weight words: the check that refuses the old ones (the weights design's §11.5; ruling W13).
//
// Screens, reports, Excel files and messages name a weight by a glossary term (CONTEXT.md), with
// "lb" for the unit. This test reads the text the code under src/ holds and refuses three things:
//
//  1. "lbs" as a word, in any capitals, anywhere in a text. "lbs" inside another word is not it.
//  2. A retired label as the WHOLE of a text: `RETIRED_LABELS` below. Capitals count, so the field
//     name "weight" is not the heading "Weight".
//  3. One of the five headings of src/lib/weight-terms.ts as the whole of a text in any other
//     file. This rule is what fails a second copy of one of them written whole.
//
// SCOPE: every `.ts` and `.tsx` file under `src/`, found by walking the tree and never hand-listed.
// Not the manual, not a test and not a browser flow.
//
// PARSED, never pattern-matched (#188). `literalTexts` (tests/helpers/ts-parse.ts) gives every
// string, every piece of a template between its substitutions and every piece of JSX text. It
// never gives a comment, an identifier, a property name written without quotes or a regular
// expression.
//
// WHOLE TEXTS, never a part of one: "Net Weight Ordered (lb)" holds a retired label letter for
// letter and is no finding. "Whole" is the whole of one text as the parser gives it, with its
// white space collapsed. That over-matches in four places, on purpose, so that the check FAILS
// CLOSED: a template's piece before or after a substitution, a piece of JSX text beside an
// expression or a child element, a property name written with quotes, and a string written as a
// type. The way out of a finding is to reword the text or to read the heading from the leaf. An
// entry in `ALLOWED` is no way out: one case holds the list empty and another holds the tree's
// findings to none without reading it. Never a comment.
//
// WHAT IT DOES NOT REFUSE: an old text that is not in `RETIRED_LABELS`; "lbs" written against a
// digit or an underscore, as in "5lbs" and the key "line_total_lbs", because each of those two
// counts as part of a word. And, of a retired label or a term (the word "lbs" is still found in
// each of these): a text in lower case that a CSS class (`capitalize`, `uppercase`) raises on
// screen, because the check compares the capitals the source writes; a label built at run time
// from pieces, whether strings joined in code or pieces of JSX text round a child element or an
// expression, as in `<th>Each<br />wt</th>`; and a label written with an HTML entity, because JSX
// text and a JSX attribute's string are read as written.
//
// ALLOWED is exact, and it is empty: a finding that is not on it fails, and an entry with no
// finding fails. The closing case writes the tree's findings out as none and reads no list, so a
// finding let through by an entry of ALLOWED, or by a second list that the tree case reads beside
// ALLOWED, fails there until that case is edited too. Both cases are handed `treeFindings()`: a
// text which that function, `code` or a rule leaves out reaches neither of them.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EACH_WEIGHT_LB, NET_WEIGHT, NET_WEIGHT_LB, TARE_EACH_LB, TARE_TOTAL_LB } from "@/lib/weight-terms";
import { literalTexts } from "./helpers/ts-parse";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const LEAF = "src/lib/weight-terms.ts";
/** The name the small sources below are parsed under: a `.tsx` file that is not the leaf. */
const FILE = "candidate.tsx";

/**
 * The labels this check refuses as a whole text. The first eight and the last are the list the
 * owner approved on 2026-10-10. "Weight (lb)" is the tenth: a load's weight is a net weight, so
 * that heading is retired with the others (the design's §11.1, answer 2, and §11.7, point 8).
 */
const RETIRED_LABELS = ["Each wt", "Load wt", "Total weight", "Ship now lbs", "Weight Ordered", "Weight Shipped",
  "Weight ordered (lb)", "Weight shipped (lb)", "Weight (lb)", "Weight"];
const TERMS = [EACH_WEIGHT_LB, NET_WEIGHT_LB, NET_WEIGHT, TARE_EACH_LB, TARE_TOTAL_LB];

/** What the three rules find in one source, in the order its texts are written. */
function weightWordFindings(src: string, file: string): string[] {
  const out: string[] = [];
  for (const { text } of literalTexts(src, file)) {
    if (/\blbs\b/i.test(text)) out.push('"lbs" as a word');
    const whole = text.replace(/\s+/g, " ").trim();
    if (RETIRED_LABELS.includes(whole)) out.push(`the retired label "${whole}"`);
    if (TERMS.includes(whole) && file !== LEAF) out.push(`the term "${whole}" written outside ${LEAF}`);
  }
  return out;
}

/**
 * The findings that stay, each with its reason: none. Exact: an entry here with no finding fails,
 * and so does a finding that is not listed.
 */
const ALLOWED: readonly (readonly [file: string, finding: string, why: string])[] = [];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const everyFile = walk(SRC).map((full) => relative(ROOT, full).split(sep).join("/"));
const code = everyFile.filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
/** Every finding under src/, each as `file: finding`, sorted. */
function treeFindings(): string[] {
  return code.flatMap((file) => weightWordFindings(read(file), file).map((finding) => `${file}: ${finding}`)).sort();
}

describe("literalTexts (the parsed primitive the check asks)", () => {
  it.each<[kind: string, src: string, texts: string[]]>([
    ["a double-quoted string", 'const s = "Weight";', ["Weight"]],
    ["a single-quoted string", "const s = 'Each wt';", ["Each wt"]],
    ["a string's value, an escape in it read", 'const s = "a\\u2014b";', ["a\u2014b"]],
    ["a template with no substitution", "const s = `Load wt`;", ["Load wt"]],
    ["the head, the middle and the tail of a template", "const s = `a ${x} b ${y} c`;", ["a ", " b ", " c"]],
    ["a template's empty head and tail", "const s = `${x} lbs ${y}`;", ["", " lbs ", ""]],
    ["JSX text as written, an entity not decoded", "const x = <th>Net&nbsp;weight</th>;", ["Net&nbsp;weight"]],
    ["JSX text on each side of an expression", "const x = <p>Weight {n} lb</p>;", ["Weight ", " lb"]],
    ["a JSX attribute's string", 'const x = <input placeholder="Each wt" />;', ["Each wt"]],
    ["a JSX attribute's string as written, an entity not decoded", 'const x = <input placeholder="Each&nbsp;wt" />;', ["Each&nbsp;wt"]],
    ["a string in a JSX attribute's braces", 'const x = <Metric label={"Weight"} />;', ["Weight"]],
    ["a property name written with quotes", 'const c = { "Weight": 1 };', ["Weight"]],
    ["a string written as a type", 'type T = "Weight" | "Qty";', ["Weight", "Qty"]],
    ["a use-client line and an import's path", '"use client";\nimport x from "./Weight";', ["use client", "./Weight"]],
  ])("reads %s", (_kind, src, texts) => {
    expect(literalTexts(src).map((held) => held.text)).toEqual(texts);
  });

  it.each<[kind: string, src: string]>([
    ["a line comment", "// 5 lbs already shipped\nconst n = 1;"],
    ["a block comment", "/* Ship now lbs */ const n = 1;"],
    ["a JSX comment", "const x = <th>{/* Weight */}</th>;"],
    ["an identifier", "const totalLbs = 1; const lbs = 2; const Weight = 3;"],
    ["a property name written without quotes", "const c = { Weight: 1, lbs: 2 };"],
    ["a regular expression", "const r = /5 lbs already shipped/i;"],
    ["a number", "const n = 42;"],
  ])("never reads %s", (_kind, src) => {
    expect(literalTexts(src)).toEqual([]);
  });

  it("gives each text's 1-based line, and for JSX text the line of its first character that is not white space", () => {
    const src = ['const a = "one";', "const x = (", "  <th>", "    Weight", "  </th>", ");", "const b = `two ${a} three`;"].join("\n");
    expect(literalTexts(src)).toEqual([
      { line: 1, text: "one" },
      { line: 4, text: "\n    Weight\n  " },
      { line: 7, text: "two " },
      { line: 7, text: " three" },
    ]);
  });

  it("gives a piece of JSX text that is all white space the line of what follows it", () => {
    // Two such pieces. The first starts on line 2, after `<tr>`, and the `<th>` after it is on
    // line 3. The second starts on line 3, after `</th>`, and the `</tr>` after it is on line 5.
    const src = ["const x = (", "  <tr>", "    <th>Weight</th>", "", "  </tr>", ");"].join("\n");
    expect(literalTexts(src)).toEqual([
      { line: 3, text: "\n    " },
      { line: 3, text: "Weight" },
      { line: 5, text: "\n\n  " },
    ]);
  });

  it("parses a .ts module as TS and anything else as TSX", () => {
    // An angle-bracket assertion is legal only in a .ts module. Parsed as TSX it opens an element,
    // and the string after it becomes part of that element's text.
    const src = 'const n = <number>value; const h = "Weight";';
    expect(literalTexts(src, "candidate.ts").map((held) => held.text)).toEqual(["Weight"]);
    expect(literalTexts(src, "candidate.tsx").map((held) => held.text)).toEqual(['value; const h = "Weight";']);
    // A name that ends in neither is parsed as TSX too.
    expect(literalTexts(src, "candidate.js").map((held) => held.text)).toEqual(['value; const h = "Weight";']);
  });
});

describe("the three rules, on small sources", () => {
  it.each<[what: string, src: string, findings: string[]]>([
    ["a heading as JSX text", "const x = <th>Weight</th>;", ['the retired label "Weight"']],
    ["a heading with classes and layout round it", 'const x = <th className="p-2">\n  Weight\n</th>;', ['the retired label "Weight"']],
    ["a label's text before its box", 'const x = <label className="block">Total weight\n  <input value={v} /></label>;', ['the retired label "Total weight"']],
    ["a label broken over two lines", "const x = <th>Total\n    weight</th>;", ['the retired label "Total weight"']],
    ["a column label", 'const c = { key: "weight", label: "Weight" };', ['the retired label "Weight"']],
    ["an Excel header", 'const c = { key: "weight", header: "Weight Ordered" };', ['the retired label "Weight Ordered"']],
    ["a placeholder", 'const x = <input placeholder="Each wt" />;', ['the retired label "Each wt"']],
    ["a JSX attribute in braces", 'const x = <Metric label={"Weight"} />;', ['the retired label "Weight"']],
    ["a template with no substitution", "const h = `Load wt`;", ['the retired label "Load wt"']],
    ["\"Ship now lbs\", by two rules", "const x = <th>Ship now lbs</th>;", ['"lbs" as a word', 'the retired label "Ship now lbs"']],
    ["\"lbs\" after a substitution", "const s = `${a} / ${b} lbs`;", ['"lbs" as a word']],
    ["\"lbs\" between substitutions", "const s = `${a} lbs exceeds the ${b}`;", ['"lbs" as a word']],
    ["\"lbs\" in a sentence", 'const s = "reversing 10 / 100 lbs would drive";', ['"lbs" as a word']],
    ["\"Lbs\" with a capital", 'const c = { defaultLabel: "Total Lbs / Price" };', ['"lbs" as a word']],
    ["\"LBS\" in capitals", 'const s = "LBS";', ['"lbs" as a word']],
    ["a term written again as a heading", "const x = <th>Net weight (lb)</th>;", [`the term "Net weight (lb)" written outside ${LEAF}`]],
    ["a term written again as a string", 'const c = { header: "Each weight (lb)" };', [`the term "Each weight (lb)" written outside ${LEAF}`]],
    ["a term written again as a label's text", "const x = <dt>\n  Net weight\n</dt>;", [`the term "Net weight" written outside ${LEAF}`]],
    ["a tare heading written again before its box", 'const x = <label className="block">\n  Tare each (lb)\n  <input value={v} /></label>;',
      [`the term "Tare each (lb)" written outside ${LEAF}`]],
    ["a tare heading written again as a string", 'const c = { label: "Tare total (lb)" };', [`the term "Tare total (lb)" written outside ${LEAF}`]],
  ])("refuses %s", (_what, src, findings) => {
    expect(weightWordFindings(src, FILE)).toEqual(findings);
  });

  it.each<[label: string]>([
    ["Each wt"], ["Load wt"], ["Total weight"], ["Ship now lbs"], ["Weight Ordered"], ["Weight Shipped"],
    ["Weight ordered (lb)"], ["Weight shipped (lb)"], ["Weight (lb)"], ["Weight"],
  ])("refuses the retired label \"%s\", as a heading and as a string", (label) => {
    expect(weightWordFindings(`const x = <th>${label}</th>;`, FILE)).toContain(`the retired label "${label}"`);
    expect(weightWordFindings(`const c = { header: ${JSON.stringify(label)} };`, FILE)).toContain(`the retired label "${label}"`);
  });

  it.each<[what: string, src: string]>([
    ["a header that holds \"Weight Ordered\" inside more words", 'const c = { header: "Net Weight Ordered (lb)" };'],
    ["a header that holds \"Weight Shipped\" inside more words", 'const c = { header: "Net Weight Shipped (lb)" };'],
    ["a heading that holds \"weight ordered (lb)\" inside more words", "const x = <th>Net weight ordered (lb)</th>;"],
    ["a heading that holds \"weight shipped (lb)\" inside more words", "const x = <th>Net weight shipped (lb)</th>;"],
    ["a heading that ends in a term's words, in other capitals", "const x = <th>Ship now net weight (lb)</th>;"],
    ["a label that holds \"Weight\" before more words", "const x = <label>Weight per load (lb)<input /></label>;"],
    ["a label that holds \"weight (lb)\" after another word", "const x = <label>Load weight (lb)<input /></label>;"],
    ["a field name", 'const k = "weight"; const f = field("weight"); const c = { key: "eachWeight" };'],
    ["the plain word inside a sentence", 'const s = "A weight-only load needs a weight greater than zero";'],
    ["a sentence that starts with the word", 'const s = "Weight does not count.";'],
    ["money per pound", 'const u = { LB: "Per lb" };'],
    ["\"net\" for money", 'const m = "Invoiced — net total"; const h = <th>Net</th>; const b = "Net balance:";'],
    ["\"lb\", the unit", 'const s = `${n} lb`; const t = "1,905.00 lb";'],
    ["\"lbs\" inside another word", 'const s = "bulbs"; const t = "albs"; const u = "lbsx";'],
    ["a line comment", '// 5 lbs already shipped\nconst s = "ok";'],
    ["a block comment", 'const s = /* Ship now lbs */ "ok";'],
    ["an identifier", "const totalLbs = 1; const lbs = 2; const Weight = 3;"],
    ["a property name", "const c = { Weight: 1, lbs: 2 };"],
    ["a regular expression", "const r = /5 lbs already shipped/i;"],
    ["a title that holds the word in the plural", 'const t = "Container weights & IDs";'],
    ["a spoken name that ends in the word", 'const x = <input aria-label="Add rider weight" />; const y = `Line ${i} ship-now weight`;'],
    ["the short forms of net, tare and gross", 'const c = ["Pieces", "Net (lb)", "Tare (lb)", "Gross (lb)"];'],
    ["the scale gross heading, which the leaf does not hold", "const x = <label>Scale gross (lb)<input /></label>;"],
  ])("lets through %s", (_what, src) => {
    expect(weightWordFindings(src, FILE)).toEqual([]);
  });

  // Where "whole" over-matches on purpose, and what the check does not see (the design's §11.7,
  // point 23). Each is the rule working as written, held here so that a change to it is seen.
  it.each<[what: string, src: string, findings: string[]]>([
    ["refuses a retired label as a template's head", "const s = `Weight ${n}`;", ['the retired label "Weight"']],
    ["refuses a term as a template's head", "const s = `Net weight ${n} lb`;", [`the term "Net weight" written outside ${LEAF}`]],
    ["refuses a retired label as a property name written with quotes", 'const c = { "Weight": 1 };', ['the retired label "Weight"']],
    ["refuses a retired label as a string written as a type", 'type T = "Weight" | "Qty";', ['the retired label "Weight"']],
    ["refuses a retired label as JSX text beside an expression", "const x = <p>Weight {n} lb</p>;", ['the retired label "Weight"']],
    ["lets through a retired label with a colon after it", "const x = <p>Weight: {n}</p>;", []],
    ["lets through a retired label after other words in one string", 'const s = "Qty / Weight";', []],
    ["lets through a term in other capitals", "const x = <th>Net Weight (lb)</th>;", []],
    ["does not see a term written with an entity", "const x = <th>Net&nbsp;weight (lb)</th>;", []],
    ["does not see a retired label written with an entity in a JSX attribute's string", 'const x = <input placeholder="Each&nbsp;wt" />;', []],
    ["does not see a text in lower case that a CSS class raises on screen",
      'const x = <th className="capitalize">weight</th>; const y = <th className="uppercase">weight</th>;', []],
    ["does not see a retired label written as pieces of JSX text round a child element or an expression",
      'const x = <th>Each<br />wt</th>; const y = <th>Total{" "}weight</th>;', []],
    ["does not see a label built at run time from pieces", 'const s = "Each" + " " + "wt"; const t = ["Total", "weight"].join(" ");', []],
    ["lets through a term's words with no unit", "const x = <span>Each weight</span>;", []],
  ])("at the edge, %s", (_what, src, findings) => {
    expect(weightWordFindings(src, FILE)).toEqual(findings);
  });

  it("does not see \"lbs\" written against a digit or an underscore, and refuses it after a digit and a space", () => {
    // Rule 1 asks for "lbs" as a word, and a digit and an underscore each count as part of one.
    expect(weightWordFindings('const s = "5lbs already shipped";', FILE)).toEqual([]);
    expect(weightWordFindings('const k = "line_total_lbs";', FILE)).toEqual([]);
    expect(weightWordFindings('const s = "5 lbs already shipped";', FILE)).toEqual(['"lbs" as a word']);
  });

  it("reads a .ts module as TS, so a string after an angle-bracket assertion is still a text", () => {
    expect(weightWordFindings('const n = <number>value; const h = "Weight";', "candidate.ts")).toEqual(['the retired label "Weight"']);
  });
});

describe("the weight headings of src/lib/weight-terms.ts are written once", () => {
  it("holds the five headings by value", () => {
    expect([EACH_WEIGHT_LB, NET_WEIGHT_LB, NET_WEIGHT, TARE_EACH_LB, TARE_TOTAL_LB])
      .toEqual(["Each weight (lb)", "Net weight (lb)", "Net weight", "Tare each (lb)", "Tare total (lb)"]);
  });

  it("lets the leaf write its five texts, by its path alone, and finds the leaf holds no other text", () => {
    const leaf = read(LEAF);
    // Five texts and no sixth, so no import either: an import's path is a string literal.
    expect(literalTexts(leaf, LEAF).map((held) => held.text))
      .toEqual(["Each weight (lb)", "Net weight (lb)", "Net weight", "Tare each (lb)", "Tare total (lb)"]);
    expect(weightWordFindings(leaf, LEAF)).toEqual([]);
    expect(weightWordFindings(leaf, "src/lib/another.ts")).toEqual([
      `the term "Each weight (lb)" written outside ${LEAF}`,
      `the term "Net weight (lb)" written outside ${LEAF}`,
      `the term "Net weight" written outside ${LEAF}`,
      `the term "Tare each (lb)" written outside ${LEAF}`,
      `the term "Tare total (lb)" written outside ${LEAF}`,
    ]);
  });
});

describe("no old weight word under src/", () => {
  it("reads a real tree: every .ts and .tsx under src/, and no other script type", () => {
    // Floors that a walk would not meet if it found nothing, lost one of src/app, src/components,
    // src/lib and src/server, or read only one of the two extensions: a count, and files named in
    // each of those four folders and of each extension.
    expect(code.length).toBeGreaterThan(400);
    expect(code).toEqual(expect.arrayContaining([
      LEAF, "src/server/shippers.ts", "src/app/orders/[id]/LinesSection.tsx", "src/app/api/parts/export/route.ts",
      "src/components/OrderTotalsTable.tsx",
    ]));
    // The extension filter is exhaustive only while src/ holds no other script type.
    expect(everyFile.filter((file) => /\.(?:[cm]?jsx?|mts|cts)$/.test(file))).toEqual([]);
  });

  it("lets nothing through: the list of allowed findings is empty", () => {
    expect(ALLOWED).toEqual([]);
  });

  it("finds exactly the findings that are listed", () => {
    const listed = ALLOWED.map(([file, finding]) => `${file}: ${finding}`).sort();
    expect(treeFindings(), "A finding that is not listed: give the text its approved wording, or read the heading from "
      + `${LEAF}. A listed entry with no finding: delete the entry.`).toEqual(listed);
  });

  it("holds the tree's findings to none, written out here and read from no list", () => {
    // No list is read here. A finding let through by an entry of ALLOWED, or by a second list
    // that the tree case reads beside ALLOWED, fails this case until the case is edited too.
    expect(treeFindings()).toEqual([]);
  });
});
