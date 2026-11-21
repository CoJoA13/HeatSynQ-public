// Reads a printed page from a stored document's bytes (the weights design's §14.2). It gives each
// page as the whole lines the page draws, in the order it draws them, which is not top to bottom:
// nothing here sorts by position. It fails only by `node:assert`, so every failure it raises
// carries the code ERR_ASSERTION, the decoder's own plain errors included.
//
// A line: the renderer draws a line of a cell word by word, and each word keeps the space after
// it. So the decoder's text runs are joined as they are, up to and including the first run that
// does not end in white space. Text left at the end of a page is one more line, with its trailing
// white space cut. The design's §14.2 gives the rule's limits.
//
// Where a page puts things (PR C of #926): `printedRuns` gives each text run with its baseline and
// `printedImages` each painted image's box, both in points from the page's top-left, y growing
// down, so a flow can hold a printed place against a place the screen states.
//
// The decoder is the unit tests' own. It is imported with its `.ts` ending because plain node,
// which runs the browser suite, resolves a relative name no other way, and strips the file's
// types as it loads it. tests/e2e-printed-page.test.ts holds each rule of this file.
import assert from "node:assert/strict";
import { pageCount, pageTops, paintedImages, textRunsWithY } from "../../tests/helpers/pdf.ts";

const WEIGHT_LINE = /^-?\d[\d,]*(?:\.\d+)? lb(?: each)?$/;
const PIECES_LINE = /^-?\d[\d,]* pcs$/;
const WEIGHT_TEXT = /^(-?)(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?(?: lb)?$/;
/** What the decoder gives for a glyph it has no mapping for. */
const UNREAD_GLYPH = String.fromCharCode(0xfffd);

/**
 * The stored document's bytes: one GET of the document's address through the page's request
 * context, written inline, with one retry of a reset socket (#843). Fails unless the status is 200 and the
 * content type begins "application/pdf". An error the GET itself raises is Playwright's own: the
 * read is issued through the page's request context by the Playwright process, and not by the
 * browser. It passes through as it is, so the harness can still call it a network fault.
 */
export async function storedPdf(page, baseURL, documentId, what) {
  const response = await page.request.get(`${baseURL}/api/documents/${documentId}`, { maxRetries: 1 });
  assert.equal(response.status(), 200, `${what}: stored document ${documentId} must be served`);
  const type = response.headers()["content-type"] ?? "";
  assert.ok(type.startsWith("application/pdf"),
    `${what}: stored document ${documentId} must be served as a PDF; its content type is ${JSON.stringify(type)}`);
  return response.body();
}

/** One page's text runs as whole lines, by the rule in this file's header. */
function linesOf(runs) {
  const lines = [];
  let text = "";
  for (const run of runs) {
    text += run.text;
    if (/\s$/.test(run.text)) continue;
    lines.push(text);
    text = "";
  }
  if (text !== "") lines.push(text.trimEnd());
  return lines;
}

/**
 * The document's pages through `decode`, one entry a page. Fails, by `node:assert`, on anything the
 * reader raises, on a page count other than `pages`, and on fewer decoded pages than the document's
 * own count (a file cut in half decodes to no page and no error).
 * @template T
 * @param {unknown} bytes
 * @param {{ pages: number, what: string }} expected
 * @param {(pdf: Buffer) => T[]} decode
 * @returns {T[]}
 */
function decodedPages(bytes, { pages, what }, decode) {
  let counted;
  let decoded;
  try {
    counted = pageCount(bytes);
    decoded = decode(bytes);
  } catch (error) {
    assert.fail(`${what}: the stored bytes could not be read as a PDF (${error instanceof Error ? error.message : String(error)})`);
  }
  assert.equal(counted, pages, `${what}: the document says it has ${counted} page(s); ${pages} expected`);
  assert.equal(decoded.length, counted, `${what}: ${decoded.length} page(s) could be read of the ${counted} the document says it has`);
  return decoded;
}

/**
 * Each page as the whole lines it draws, in drawing order. `pages` is how many pages the document
 * must have. Fails on anything the decoder raises, on a page count other than `pages`, on fewer
 * decoded pages than the document's own count (a file cut in half decodes to no page and no
 * error), on a page with no line that holds a character (a page whose only text is white space
 * gives one empty line), and on a line that holds a glyph the decoder could not read. So a line's
 * absence is never read off a page that did not decode.
 */
export function printedPages(bytes, { pages, what }) {
  const drawn = decodedPages(bytes, { pages, what }, textRunsWithY).map(linesOf);
  for (const [index, lines] of drawn.entries()) {
    assert.ok(lines.some((line) => line !== ""), `${what}: page ${index + 1} drew no text that could be read`);
    assert.ok(!lines.some((line) => line.includes(UNREAD_GLYPH)),
      `${what}: page ${index + 1} holds a glyph that could not be read: ${JSON.stringify(lines)}`);
  }
  return drawn;
}

/**
 * Each page's text runs with their places, in drawing order: `{ text, x, y }`, where (x, y) is the
 * run's BASELINE start in points from the page's TOP-LEFT corner, y growing down (the frame the
 * canvas designer's inspector and `printedImages` use). The decoder (`textRunsWithY`) reports y in
 * PDF device space, from the page's BOTTOM edge; this subtracts it from the page's own top edge
 * (the upper y of its `/MediaBox`). A run is what the renderer draws in one go, a word with the
 * space after it for a cell's text, so one printed phrase is several runs. Fails as `printedPages`
 * does on the document, on a page whose size cannot be read, and on a run that holds a glyph the
 * decoder could not read.
 */
export function printedRuns(bytes, { pages, what }) {
  const decoded = decodedPages(bytes, { pages, what }, (pdf) => {
    const tops = pageTops(pdf);
    return textRunsWithY(pdf).map((runs, index) => runs.map((run) => ({ text: run.text, x: run.x, y: tops[index] - run.y })));
  });
  for (const [index, runs] of decoded.entries()) {
    assert.ok(!runs.some((run) => run.text.includes(UNREAD_GLYPH)),
      `${what}: page ${index + 1} holds a glyph that could not be read: ${JSON.stringify(runs.map((run) => run.text))}`);
  }
  return decoded;
}

/**
 * Each page's painted images, in drawing order: `{ x, y, w, h }`, the drawn box in points from the
 * page's TOP-LEFT corner, y growing down (`paintedImages`). A page that paints none gives an empty
 * list. Fails as `printedPages` does on the document.
 */
export function printedImages(bytes, { pages, what }) {
  return decodedPages(bytes, { pages, what }, paintedImages);
}

/**
 * Fails unless `run`, one or more non-empty strings, is in `lines` as whole lines, one after
 * another. A line is compared by equality, so "30" is not found in "300 lb". The failure's
 * message holds `what`, the run and every line of `lines`.
 */
export function assertRun(lines, run, what) {
  assert.ok(Array.isArray(run) && run.length > 0 && run.every((line) => typeof line === "string" && line !== ""),
    `${what}: a run is one or more whole printed lines; got ${JSON.stringify(run)}`);
  for (let start = 0; start + run.length <= lines.length; start += 1) {
    if (run.every((line, offset) => lines[start + offset] === line)) return;
  }
  assert.fail(`${what}: the page does not draw ${JSON.stringify(run)} as whole lines one after another. It drew ${JSON.stringify(lines)}`);
}

/** The lines that are a printed weight, in order: "4,128 lb", "4,128.00 lb", "310 lb each". */
export function weightLines(lines) {
  return lines.filter((line) => WEIGHT_LINE.test(line));
}

/** The lines that are a printed piece count, in order: "15 pcs". */
export function piecesLines(lines) {
  return lines.filter((line) => PIECES_LINE.test(line));
}

/**
 * A weight as whole cents, from paper's text ("8,468 lb", "1,727.5 lb") or a screen cell's
 * ("8,468.00"): grouped or plain digits, at most two decimals, an optional " lb". Anything else
 * fails: a word, a dash, "310 lb each" and "Net 300 lb" included.
 */
export function poundsCents(text, what) {
  const match = WEIGHT_TEXT.exec(text);
  assert.ok(match, `${what}: ${JSON.stringify(text)} is not a weight`);
  const cents = Number(match[2].replaceAll(",", "")) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  return match[1] === "-" ? 0 - cents : cents;
}
