// Two readers of a static render, for a test that holds a heading or a label by its whole text.
//
// vitest runs in node with no DOM, so a component test here renders with `renderToStaticMarkup` and
// reads the markup. These two read it by pattern. That is sound for that renderer's output and for
// nothing wider: it closes every element it opens, writes every attribute value in double quotes,
// and escapes `&`, `<`, `>`, `"` and `'` in text and in attribute values, so a `<`, a `>` or a `"`
// in the markup is always markup. They are not readers of HTML in general.
//
// A test built on these compares against a literal written out (`toEqual([...])`, `toBe("...")`),
// never only loops over what was found: a reader that finds nothing then fails the test.
//
// Not named `*.test.ts`, so it is type-checked and linted but vitest never runs it as a suite.

/** The five entities React's static renderer writes, and the character each stands for. */
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'" };

/** Decoded in one pass, so `&amp;lt;` reads as the text `&lt;` and never as `<`. */
const decode = (text: string): string => text.replace(/&(amp|lt|gt|quot|#x27);/g, (_, name: string) => ENTITIES[name]);

/** What a piece of markup shows: every tag dropped, entities decoded, and white space (a no-break
 *  space included) collapsed and trimmed. */
const textOf = (markup: string): string => decode(markup.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

/** The inner markup of every `tag` element, in order. An element inside another of the same tag
 *  is not read right: the outer one is taken to end at the first closing tag. */
const inner = (html: string, tag: string): string[] =>
  [...html.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))].map((match) => match[1]);

/**
 * Every row of headings in a static render, in order: for each `<tr>` that holds a `<th>`, the
 * text of each of its `<th>` cells. A row with no `<th>` is not in the answer. So a component with
 * three tables answers its three heading rows, and a body row with a row heading answers that one
 * cell. A table nested inside a row is not read right.
 *
 * Hold a row whole, by its place or with `toContainEqual`, never by a text inside it.
 */
export function headingRowsOf(html: string): string[][] {
  return inner(html, "tr").map((row) => inner(row, "th").map(textOf)).filter((cells) => cells.length > 0);
}

/**
 * The text of the one `<label>` that holds a control whose `aria-label` is `name`: everything the
 * label shows, the text of an element inside it included. Throws, naming `name` and the count,
 * when no label or more than one holds such a control.
 */
export function labelOf(html: string, name: string): string {
  const held = inner(html, "label").filter((label) =>
    [...label.matchAll(/\saria-label="([^"]*)"/g)].some((match) => decode(match[1]) === name));
  if (held.length !== 1) throw new Error(`${held.length} labels hold a control named "${name}"`);
  return textOf(held[0]);
}
