import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The manual's glossary chapter, held to the repository glossary (owner ruling P3-Q7, 2026-10-08;
 * the design's §10.4; for the Weights table and its Formula column, the weights design's §11.5).
 *
 * `docs/manual/15-glossary.md` is written by hand from `CONTEXT.md`. Nothing generates it, so this
 * file is the only thing that keeps the two in step. The rule: every row of the tables named in
 * TABLES is in the chapter with the same term cell and the same meaning cell, word for word,
 * except the rows listed in NOT_YET_CURRENT, and the chapter holds no term those tables lack. A
 * row of a table named in WITH_FORMULA has the same formula cell as well, an empty one included.
 * The chapter's own shape is held too: one table under each of those headings and no other, and
 * no term twice. Its columns are Term, Meaning and Formula under a heading in WITH_FORMULA, and
 * Term and Meaning under every other; CONTEXT.md's Avoid column is left out of every table.
 * Which of its tables a term sits in is not compared, with two exceptions, both the Formula
 * column's: a term of a table in WITH_FORMULA that the chapter gives under another heading has no
 * formula cell there, and a term of another table that the chapter gives under a heading in
 * WITH_FORMULA has one that CONTEXT.md does not. Each is a difference. No sentence outside a table
 * is read.
 *
 * A row is split the way `scripts/build-manual.mjs` splits one (`splitRow`): on every `|`, each
 * cell trimmed. So the padding round a cell is free, and everything inside it counts, the `**`
 * included.
 *
 * It reads those two files and nothing else: no build, no browser, no database.
 */

const ERP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(ERP_ROOT, "..");
const GLOSSARY = "CONTEXT.md";
const CHAPTER = "docs/manual/15-glossary.md";

/**
 * The tables of CONTEXT.md the chapter repeats, by their `##` heading, in the chapter's order.
 * Weights joined with the pull request that renamed the screens' weight labels (the weights
 * design's §11.6).
 */
const TABLES = ["Weights", "Quantities", "Containers and loads", "Shipment completion"];

/**
 * The tables of TABLES whose third column, Formula, the chapter repeats as well (the owner's
 * answer 8 of 2026-10-10, the weights design's §11.1). Under these headings the chapter's table
 * has three columns, and CONTEXT.md's must open with Term, Meaning and Formula. Under every other
 * heading the chapter's table has two.
 */
const WITH_FORMULA = ["Weights"];

/**
 * Rows of those tables the chapter leaves out, by term cell, each with its reason. An entry is a
 * row waiting for its screen, not a resting place: when the screen ships, the row goes into the
 * chapter and the entry is deleted. The last test below makes a stale entry a failure.
 *
 * Empty now. Its one entry, the Pieces of a container row, left when the weights design's first
 * pull request made that field the row's total pieces and the row went into the chapter. While
 * the list is empty, the case "lists nothing as not yet current that CONTEXT.md lacks or the
 * chapter already gives" loops over nothing and holds nothing. It asserts again when the list
 * next has an entry.
 */
const NOT_YET_CURRENT: Record<string, string> = {};

/** One row of a table. `formula` is the row's third cell under a heading in WITH_FORMULA, and
 *  undefined under every other heading. */
type Row = { term: string; meaning: string; formula: string | undefined };
/** One pipe table of a markdown file: the `##` heading it sits under, and each of its lines as
 *  cells. `divider` is undefined for a table of one line. */
type Table = { heading: string; header: string[]; divider: string[] | undefined; rows: string[][] };

const read = (rel: string): string =>
  readFileSync(path.join(REPO_ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const splitRow = (line: string): string[] =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

const isDivider = (cells: string[] | undefined): boolean =>
  cells !== undefined && cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));

/**
 * Every pipe table of a markdown text, in order, with the `##` heading it sits under. A table is a
 * run of lines that start with `|`: its first line is the header, its second the divider, the rest
 * its rows. Nothing is required of a table here. `termRows` requires a shape, and it is asked only
 * of the tables this file reads.
 */
function tablesOf(text: string): Table[] {
  const lines = text.split("\n");
  const tables: Table[] = [];
  let heading = "";
  let i = 0;
  while (i < lines.length) {
    const titled = /^##\s+(.*?)\s*$/.exec(lines[i]);
    if (titled) heading = titled[1];
    if (!lines[i].trimStart().startsWith("|")) {
      i += 1;
      continue;
    }
    const block: string[][] = [];
    while (i < lines.length && lines[i].trimStart().startsWith("|")) {
      block.push(splitRow(lines[i]));
      i += 1;
    }
    const [header, divider, ...rows] = block;
    tables.push({ heading, header, divider, rows });
  }
  return tables;
}

/**
 * The cells a table under `heading` opens with. For the chapter that is its whole header. For
 * CONTEXT.md it is the start of one: a table there may go on to an Avoid column.
 */
const openingCells = (heading: string): string[] =>
  WITH_FORMULA.includes(heading) ? ["Term", "Meaning", "Formula"] : ["Term", "Meaning"];

/**
 * A table's rows as term and meaning, which are its first two cells, and under a heading in
 * WITH_FORMULA its formula, which is its third. Throws unless the table opens with the cells
 * `openingCells` gives for its heading and then a divider row, so a reshaped table is a named
 * failure and never an empty list that compares equal to another empty list.
 */
function termRows(rel: string, table: Table): Row[] {
  const cells = openingCells(table.heading);
  const opens = cells.every((cell, index) => table.header[index] === cell);
  if (!opens || !isDivider(table.divider)) {
    throw new Error(
      `${rel}: the table under "## ${table.heading}" does not open with | ${cells.join(" | ")} | ` +
        `and a divider row`,
    );
  }
  const withFormula = cells.length === 3;
  return table.rows.map((row) => ({
    term: row[0] ?? "",
    meaning: row[1] ?? "",
    formula: withFormula ? (row[2] ?? "") : undefined,
  }));
}

/**
 * CONTEXT.md's rows for the tables in TABLES, from `text` (the file as it stands, unless a test
 * hands in another). Only the tables under those headings are read, so only they must open as
 * `openingCells` says: a table under any other heading may have any shape. Throws when a table in
 * TABLES is gone, empty or reshaped.
 */
function glossaryRows(text: string = read(GLOSSARY)): Row[] {
  const tables = tablesOf(text);
  return TABLES.flatMap((name) => {
    const rows = tables
      .filter((table) => table.heading === name)
      .flatMap((table) => termRows(GLOSSARY, table));
    if (rows.length === 0) {
      throw new Error(
        `${GLOSSARY}: no table under "## ${name}". The heading was renamed or the table moved`,
      );
    }
    return rows;
  });
}

/** The chapter's tables, in order, from `text` (the file as it stands, unless a test hands in
 *  another). */
const chapterTables = (text: string = read(CHAPTER)): Table[] => tablesOf(text);

/** Every row of every table in the chapter. Every table of the chapter must open as
 *  `openingCells` says for the heading it is under: which headings it has is the first test's. */
const chapterRows = (text: string = read(CHAPTER)): Row[] =>
  chapterTables(text).flatMap((table) => termRows(CHAPTER, table));

/**
 * The chapter's rows whose formula cell is not CONTEXT.md's for the same term, each with its term
 * and both cells. A row under a heading that is not in WITH_FORMULA has no formula cell, in either
 * file, and that is `undefined` here. So a term the chapter gives under such a heading, where
 * CONTEXT.md gives it under one that is, is a difference.
 */
function formulaDifferences(
  chapter: string = read(CHAPTER),
  glossary: string = read(GLOSSARY),
): { term: string; chapter: string | undefined; glossary: string | undefined }[] {
  const formulaOf = new Map(glossaryRows(glossary).map((row) => [row.term, row.formula]));
  return chapterRows(chapter)
    .filter((row) => formulaOf.get(row.term) !== row.formula)
    .map((row) => ({ term: row.term, chapter: row.formula, glossary: formulaOf.get(row.term) }));
}

describe("the manual's glossary chapter against CONTEXT.md", () => {
  it("has one table under each heading TABLES names, in that order, and no other table", () => {
    expect(
      chapterTables().map((table) => table.heading),
      `${CHAPTER} must hold one table under each of ${TABLES.join(", ")}, and none elsewhere`,
    ).toEqual(TABLES);
  });

  it("gives each table its columns: a Formula column under a heading in WITH_FORMULA, and no Avoid column", () => {
    const tables = chapterTables();
    expect(tables.map((table) => table.header)).toEqual(TABLES.map((name) => openingCells(name)));
    // The divider and every row have as many cells as the header. One more is an Avoid cell, or a
    // `|` written inside a cell, which the manual's build would split into a column as well. One
    // fewer, under a heading in WITH_FORMULA, is a row whose formula cell was left off.
    const wrong = tables.flatMap((table) =>
      [table.divider ?? [], ...table.rows]
        .filter((cells) => cells.length !== openingCells(table.heading).length)
        .map((cells) => `under "## ${table.heading}": | ${cells.join(" | ")} |`),
    );
    expect(
      wrong,
      `a line of a table in ${CHAPTER} does not have as many cells as its header`,
    ).toEqual([]);
  });

  it("gives no term twice", () => {
    const terms = chapterRows().map((row) => row.term);
    const twice = terms.filter((term, index) => terms.indexOf(term) !== index);
    expect(twice, `a term is in ${CHAPTER} more than once: one word has one meaning`).toEqual([]);
    // The reader found rows to compare: a chapter with no table gives no term twice either.
    expect(terms.length).toBeGreaterThan(0);
  });

  it("holds every current term of the tables read", () => {
    const inChapter = new Set(chapterRows().map((row) => row.term));
    const missing = glossaryRows()
      .map((row) => row.term)
      .filter((term) => !Object.hasOwn(NOT_YET_CURRENT, term) && !inChapter.has(term));
    expect(
      missing,
      `in ${GLOSSARY} and not in ${CHAPTER}: add the row, or list it in NOT_YET_CURRENT ` +
        `with its reason`,
    ).toEqual([]);
  });

  it("gives each term CONTEXT.md's meaning, word for word", () => {
    const meaningOf = new Map(glossaryRows().map((row) => [row.term, row.meaning]));
    const differs = chapterRows()
      .filter((row) => meaningOf.has(row.term) && meaningOf.get(row.term) !== row.meaning)
      .map((row) => ({ term: row.term, chapter: row.meaning, glossary: meaningOf.get(row.term) }));
    expect(
      differs,
      `a meaning in ${CHAPTER} is not ${GLOSSARY}'s: copy the cell as it stands there, ` +
        `or change both`,
    ).toEqual([]);
  });

  it("gives each formula of a table in WITH_FORMULA as CONTEXT.md has it, word for word", () => {
    expect(
      formulaDifferences(),
      `a formula in ${CHAPTER} is not ${GLOSSARY}'s: copy the cell as it stands there, ` +
        `or change both`,
    ).toEqual([]);
    // The reader found formulas to compare: a chapter whose Formula column was never read differs
    // from nothing either.
    const formulas = chapterRows().flatMap((row) => (row.formula ? [row.formula] : []));
    expect(formulas.length).toBeGreaterThan(0);
  });

  it("holds no term CONTEXT.md lacks", () => {
    const known = new Set(glossaryRows().map((row) => row.term));
    const extra = chapterRows()
      .map((row) => row.term)
      .filter((term) => !known.has(term));
    expect(
      extra,
      `in ${CHAPTER} and in none of ${GLOSSARY}'s tables read here (${TABLES.join(", ")}): ` +
        `settle the term there first`,
    ).toEqual([]);
  });

  it("lists nothing as not yet current that CONTEXT.md lacks or the chapter already gives", () => {
    const known = new Set(glossaryRows().map((row) => row.term));
    const inChapter = new Set(chapterRows().map((row) => row.term));
    for (const [term, reason] of Object.entries(NOT_YET_CURRENT)) {
      expect(reason.trim(), `${term}: an entry needs its reason`).not.toBe("");
      expect(
        known.has(term),
        `${term} is listed as not yet current and is no row of ${GLOSSARY}: drop the entry`,
      ).toBe(true);
      expect(
        inChapter.has(term),
        `${term} is in the chapter now: the entry is stale, delete it`,
      ).toBe(false);
    }
  });
});

describe("which tables of CONTEXT.md are read", () => {
  const glossary = read(GLOSSARY);

  it("only the tables named: a table under another heading may have any header", () => {
    const another =
      `${glossary}\n## Documents\n\n| Word | Use |\n|---|---|\n` +
      `| **Traveler** | The sheet that goes with a load. |\n`;
    expect(glossaryRows(another)).toEqual(glossaryRows(glossary));
  });

  it("a named table that no longer opens with Term and Meaning is a failure that names it", () => {
    const opening = "## Quantities\n\n| Term | Meaning | Avoid |";
    expect(glossary).toContain(opening);
    const reshaped = glossary.replace(opening, "## Quantities\n\n| Word | Meaning | Avoid |");
    expect(() => glossaryRows(reshaped)).toThrow(
      `${GLOSSARY}: the table under "## Quantities" does not open with | Term | Meaning |`,
    );
  });

  it("a table in WITH_FORMULA that no longer opens with Term, Meaning and Formula is named too", () => {
    const header = "| Term | Meaning | Formula | Avoid |";
    expect(glossary).toContain(header);
    const reshaped = glossary.replace(header, "| Term | Meaning | Avoid | Formula |");
    expect(() => glossaryRows(reshaped)).toThrow(
      `${GLOSSARY}: the table under "## Weights" does not open with | Term | Meaning | Formula |`,
    );
  });
});

describe("the Formula column, on a chapter handed to the reader", () => {
  const chapter = read(CHAPTER);

  it("a formula that is not CONTEXT.md's is a difference, given with its term and both cells", () => {
    const cell = "| quantity × each weight |";
    expect(chapter).toContain(cell);
    const changed = chapter.replace(cell, "| quantity x each weight |");
    expect(formulaDifferences(changed)).toEqual([
      {
        term: "**Net weight**",
        chapter: "quantity x each weight",
        glossary: "quantity × each weight",
      },
    ]);
  });

  it("an empty formula cell is held: a formula written where CONTEXT.md has none is a difference", () => {
    const row = /^(\| \*\*Each weight\*\* \|[^|]*\|) \|$/m;
    expect(chapter).toMatch(row);
    const changed = chapter.replace(row, "$1 per piece |");
    expect(formulaDifferences(changed)).toEqual([
      { term: "**Each weight**", chapter: "per piece", glossary: "" },
    ]);
  });

  it("a term the chapter gives under a heading with no Formula column is a difference too", () => {
    const row = /^(\| \*\*Tare each\*\* \|[^|]*\|) \|\n/m;
    const found = row.exec(chapter);
    expect(found).not.toBeNull();
    const quantities = "## Quantities\n\n| Term | Meaning |\n|---|---|\n";
    expect(chapter).toContain(quantities);
    const moved = chapter.replace(row, "").replace(quantities, `${quantities}${found?.[1]}\n`);
    expect(formulaDifferences(moved)).toEqual([
      { term: "**Tare each**", chapter: undefined, glossary: "" },
    ]);
  });
});
