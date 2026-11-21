// One reader of a shipment's totals tables as markup (the weights design §12.2 and §12.5), for
// any test that renders `ShipmentTotalsTable`, alone or inside a page or a panel that mounts it.
// It follows tests/helpers/order-totals-markup.ts, and answers a list: a shipment page draws
// several tables. vitest has no DOM, so a rendered component is a string.
//
// It refuses what it cannot read. A root that holds another `div`, and anything between the parts
// it reads, throw, so a table that changed shape fails the case that reads it and never passes
// unread. shipment-totals-table.test.tsx holds each refusal. Markup with no root answers `[]`.
//
// No string the design gives these tables holds `&`, `<`, `>` or a quote, so React escapes
// nothing in it and an element's text is its markup's text.
//
// Not named `*.test.ts`, so it is type-checked and linted but vitest never runs it as a suite.

export type ShipmentTotalsMarkup = {
  /** The table's `aria-label`. */
  name: string | undefined;
  /** The text of the caption's first span. */
  caption: string;
  /** The caption's second span, as its whole markup. Null when the caption holds one span. */
  tag: string | null;
  /** The text of each `th` of the head row, in order. */
  columns: string[];
  /** The text of each `td` of the one body row, in order. */
  cells: string[];
  /** The status paragraph's text. Null when there is none. */
  note: string | null;
};

type Read = { name: string; attributes: string; text: string; markup: string };

const attribute = (attributes: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(attributes)?.[1];
const unread = (where: string, html: string) =>
  new Error(`The shipment totals ${where} holds markup this reader does not read: ${html}`);

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

/** One table, from the markup that follows its root's opening tag. */
function tableAfter(opened: string): ShipmentTotalsMarkup {
  // The root holds no other `div`, so its own closing tag is the first one after it opens.
  const end = opened.indexOf("</div>");
  if (end < 0) throw new Error("A shipment totals root is never closed");
  const root = opened.slice(0, end);
  if (root.includes("<div")) throw new Error("A shipment totals root holds another div");

  const table = /^<table\b([^>]*)>([\s\S]*)<\/table>/.exec(root);
  if (!table) throw new Error(`A shipment totals root does not open with its table: ${root}`);
  const parts = /^<caption\b[^>]*>([\s\S]*?)<\/caption><thead\b[^>]*>([\s\S]*?)<\/thead><tbody\b[^>]*>([\s\S]*?)<\/tbody>$/.exec(table[2]);
  if (!parts) throw new Error(`A shipment totals table is not a caption, a head and a body: ${table[2]}`);

  const spans = elements(parts[1], "span", "caption");
  if (spans.length < 1 || spans.length > 2) throw new Error(`Expected one or two spans in the caption, found ${spans.length}`);

  const head = tableRows(parts[2], "head");
  if (head.length !== 1) throw new Error(`Expected one row of column headings, found ${head.length}`);
  const headings = elements(head[0], "th|td", "head row");
  if (headings.some((cell) => cell.name !== "th")) throw new Error(`A cell of the shipment totals' head row is not a column heading: ${head[0]}`);

  const body = tableRows(parts[3], "body");
  if (body.length !== 1) throw new Error(`Expected one row of figures, found ${body.length}`);
  const figures = elements(body[0], "th|td", "body row");
  if (figures.some((cell) => cell.name !== "td")) throw new Error(`A cell of the shipment totals' row of figures is not a td: ${body[0]}`);
  if (figures.length !== headings.length) throw new Error(`Expected a figure under each heading, found ${headings.length} headings and ${figures.length} figures`);

  const paragraphs = elements(root.slice(table[0].length), "p", "paragraphs");
  if (paragraphs.length > 1) throw new Error(`Expected at most one paragraph under the table, found ${paragraphs.length}`);
  const role = paragraphs.length === 1 ? attribute(paragraphs[0].attributes, "role") : "status";
  if (role !== "status") throw new Error(`The paragraph under the shipment totals has ${role === undefined ? "no role" : `the role ${role}`}`);

  return {
    name: attribute(table[1], "aria-label"),
    caption: spans[0].text,
    tag: spans[1]?.markup ?? null,
    columns: headings.map((cell) => cell.text),
    cells: figures.map((cell) => cell.text),
    note: paragraphs[0]?.text ?? null,
  };
}

/** What each shipment totals table in `html` shows, in the order drawn: one entry for each root
 *  marked `data-shipment-totals`, and `[]` for markup with none. `html` is a table's own markup,
 *  or markup that holds tables. Throws unless every part of every root is read. */
export function shipmentTotalsIn(html: string): ShipmentTotalsMarkup[] {
  return html.split(/<div\b[^>]*\sdata-shipment-totals(?=[\s=>])[^>]*>/).slice(1).map(tableAfter);
}
