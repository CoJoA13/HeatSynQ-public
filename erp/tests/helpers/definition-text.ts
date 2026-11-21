/**
 * Readers of a document definition, shared by the cases of the weights-on-paper pull request
 * (the weights design §13.5). A definition is plain JSON, so each is a walk.
 *
 * A test file keeps the local reader its existing cases use. A new case imports these.
 */

/** Every string and number under a definition, in order. An `image` is skipped: it holds a data
 *  URI of many kilobytes, never text. This also collects alignments, colours and sizes, so it
 *  cannot compare a cell whole: `cellTexts` does. */
export function allText(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) allText(n, out); return out; }
  if (typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "image") continue;
      allText(value, out);
    }
  }
  return out;
}

/** `allText` joined by "\n". */
export function textOf(def: unknown): string {
  return allText(def).join("\n");
}

/** Every object under `node` that `pred` takes, `node` itself included, a parent before its
 *  children. */
export function findNodes(
  node: unknown, pred: (n: Record<string, unknown>) => boolean,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (n: unknown): void => {
    if (n === null || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const obj = n as Record<string, unknown>;
    if (pred(obj)) out.push(obj);
    Object.values(obj).forEach(walk);
  };
  walk(node);
  return out;
}

/** One `text` value as the line it prints: a string as it is, a number as its digits, and an
 *  array of inline pieces joined, each piece a string or an object with a `text` of its own. */
function lineOf(text: unknown): string {
  if (typeof text === "string") return text;
  if (typeof text === "number") return String(text);
  if (Array.isArray(text)) return text.map(lineOf).join("");
  if (text !== null && typeof text === "object" && "text" in text) return lineOf((text as { text: unknown }).text);
  return "";
}

/** One cell's own `text` strings, top line first: one string for each object that has a `text`.
 *  An empty text is a line, so a Tare cell with no total gives `["", "42.5 lb each"]`. The empty
 *  cell under a spanned one (`{}`) gives none. A cell that is itself a bare string or number is
 *  its one line, but a bare string inside a stack is not read. Nothing else a cell carries is
 *  read: not its alignment, its size or its colour. */
export function cellTexts(cell: unknown): string[] {
  if (typeof cell === "string" || typeof cell === "number") return [String(cell)];
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const obj = node as Record<string, unknown>;
    if ("text" in obj) { out.push(lineOf(obj.text)); return; }
    Object.values(obj).forEach(walk);
  };
  walk(cell);
  return out;
}

/** The one table whose first row holds a cell whose own text is exactly `heading`. Throws when
 *  there is none, or more than one: hand it one sheet, not a definition of several. A longer
 *  heading that holds `heading` is not a match. */
export function tableHeaded(def: unknown, heading: string): { widths: (number | string)[]; body: unknown[][] } {
  const found = findNodes(def, (n) => {
    const body = (n.table as { body?: unknown } | null | undefined)?.body;
    return Array.isArray(body) && Array.isArray(body[0])
      && body[0].some((cell) => (cell as { text?: unknown } | null)?.text === heading);
  });
  if (found.length !== 1) {
    throw new Error(`${found.length} tables are headed "${heading}": tableHeaded needs exactly one`);
  }
  const table = found[0].table as { widths?: (number | string)[]; body: unknown[][] };
  return { widths: table.widths ?? [], body: table.body };
}
