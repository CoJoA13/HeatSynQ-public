// One reader of the order totals table's markup (the weights design §10.2 and §10.5), for any
// test that renders `OrderTotalsTable`, alone or inside a section that mounts it.
//
// vitest has no DOM, so a rendered component is a string. `totalsOf` reads the one table in that
// string into the values a test compares: the table's name, its caption and tag, the column
// headings, each row's cells, the note and the weighed lines. Which element draws each of them is
// order-totals-table.test.tsx's to hold. This file reads values.
//
// It refuses what it cannot read. Markup with no table root, or two, a root that holds another
// `div`, and anything between the parts it reads all throw, so a table that changed shape fails
// the case that reads it and never passes unread. order-totals-table.test.tsx holds each refusal.
//
// No string the table shows holds `&`, `<`, `>` or a quote, so React escapes nothing in it and an
// element's text is its markup's text.
//
// Not named `*.test.ts`, so it is type-checked and linted but vitest never runs it as a suite.

export type TotalsMarkup = {
  /** The table's `aria-label`. */
  name: string | undefined;
  /** The text of the caption's first span. */
  caption: string;
  /** The caption's second span, as its whole markup. Null when the caption holds one span. */
  tag: string | null;
  /** The text of each `th` of the head row, in order. */
  columns: string[];
  /** Each body row's cells' text in column order, by the row's heading. */
  rows: Record<string, string[]>;
  /** The status paragraph's text. Null when there is none. */
  note: string | null;
  /** The text of each paragraph that has no role, in order. */
  weighed: string[];
};

type Read = { name: string; attributes: string; text: string; markup: string };

const attribute = (attributes: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(attributes)?.[1];
const unread = (where: string, html: string) =>
  new Error(`The order totals ${where} holds markup this reader does not read: ${html}`);

/** Every element of `html` named by `names` whose content is text alone. `html` must be those
 *  elements end to end: anything else in it is something this reader would pass over. */
function elements(html: string, names: string, where: string): Read[] {
  const found = [...html.matchAll(new RegExp(`<(${names})\\b([^>]*)>([^<]*)</\\1>`, "g"))]
    .map(([markup, name, attributes, text]) => ({ name, attributes, text, markup }));
  if (found.map((element) => element.markup).join("") !== html) throw unread(where, html);
  return found;
}

/** The inner markup of each `<tr>` of `html`, which must be rows end to end. */
function tableRows(html: string, where: string): string[] {
  const found = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)];
  if (found.map(([markup]) => markup).join("") !== html) throw unread(where, html);
  return found.map(([, inner]) => inner);
}

/** What the one order totals table in `html` shows. `html` is the table's own markup, or markup
 *  that holds it. Throws unless `html` holds exactly one root marked `data-order-totals`, and
 *  unless every part of that root is read. */
export function totalsOf(html: string): TotalsMarkup {
  const around = html.split(/<div\b[^>]*\sdata-order-totals(?=[\s=>])[^>]*>/);
  if (around.length !== 2) throw new Error(`Expected one data-order-totals root, found ${around.length - 1}`);
  // The root holds no other `div`, so its own closing tag is the first one after it opens.
  const end = around[1].indexOf("</div>");
  if (end < 0) throw new Error("The order totals root is never closed");
  const root = around[1].slice(0, end);
  if (root.includes("<div")) throw new Error("The order totals root holds another div");

  const table = /^<table\b([^>]*)>([\s\S]*)<\/table>/.exec(root);
  if (!table) throw new Error(`The order totals root does not open with its table: ${root}`);
  const parts = /^<caption\b[^>]*>([\s\S]*?)<\/caption><thead\b[^>]*>([\s\S]*?)<\/thead><tbody\b[^>]*>([\s\S]*?)<\/tbody>$/.exec(table[2]);
  if (!parts) throw new Error(`The order totals table is not a caption, a head and a body: ${table[2]}`);

  const spans = elements(parts[1], "span", "caption");
  if (spans.length < 1 || spans.length > 2) throw new Error(`Expected one or two spans in the caption, found ${spans.length}`);

  const head = tableRows(parts[2], "head");
  if (head.length !== 1) throw new Error(`Expected one row of column headings, found ${head.length}`);
  // The head row is one corner cell that holds no text, and then column headings and no other cell.
  const [corner, ...headings] = elements(head[0], "th|td", "head row");
  if (corner?.name !== "td") throw new Error(`The head row of the order totals does not open with a corner cell: ${head[0]}`);
  if (corner.text !== "") throw new Error(`The corner cell of the order totals holds text: ${corner.text}`);
  if (headings.some((cell) => cell.name !== "th")) throw new Error(`A cell after the corner of the order totals' head row is not a column heading: ${head[0]}`);
  const columns = headings.map((cell) => cell.text);

  const rows: Record<string, string[]> = {};
  for (const row of tableRows(parts[3], "body")) {
    const [heading, ...cells] = elements(row, "th|td", "body row");
    if (heading?.name !== "th" || cells.some((cell) => cell.name !== "td")) throw new Error(`A row of the order totals is not a heading and then cells: ${row}`);
    if (Object.hasOwn(rows, heading.text)) throw new Error(`Two rows of the order totals are headed ${heading.text}`);
    rows[heading.text] = cells.map((cell) => cell.text);
  }

  const paragraphs = elements(root.slice(table[0].length), "p", "paragraphs");
  const roles = paragraphs.map((paragraph) => attribute(paragraph.attributes, "role"));
  const other = roles.find((role) => role !== undefined && role !== "status");
  if (other !== undefined) throw new Error(`A paragraph under the order totals has the role ${other}`);
  const notes = paragraphs.filter((_, index) => roles[index] === "status");
  if (notes.length > 1) throw new Error(`Expected at most one status paragraph, found ${notes.length}`);

  return {
    name: attribute(table[1], "aria-label"),
    caption: spans[0].text,
    tag: spans[1]?.markup ?? null,
    columns,
    rows,
    note: notes[0]?.text ?? null,
    weighed: paragraphs.filter((_, index) => roles[index] === undefined).map((paragraph) => paragraph.text),
  };
}
