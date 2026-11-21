// e2e/lib/printed-page.mjs reads a printed page from a stored document's bytes, for the browser
// suite (the weights design's §14.2 and §14.5, "The reader"). A reader that took a page it could
// not decode for an empty one, or found a figure inside a longer one, would let a reading of paper
// pass while it proved nothing, and no browser run would show it. So each rule of the reader is
// held here: on pages the real builders and the program's renderer print
// (tests/helpers/example-pages.ts), on small pages rendered for one rule, and on plain lists of
// lines.
//
// Only the first render asks the test database its name, for the practice stamp: `practiceMode()`
// keeps its answer for as long as its module lives. No case reads or writes a row. `storedPdf` runs
// over a stand-in for a Playwright page: only a browser run proves it reads a real one.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { renderPdf } from "@/server/pdf/render";
import { bolPdf, ticketPdf, travelerPdf, type PageOrder } from "./helpers/example-pages";
import { TINY_JPEG, paintedImages, textRunsWithY } from "./helpers/pdf";
import { BINS_14 } from "./helpers/weights-examples";
import { assertRun, piecesLines, poundsCents, printedImages, printedPages, printedRuns, storedPdf, weightLines } from "../e2e/lib/printed-page.mjs";

/** 192 pieces at 21.5 lb in fourteen bins at 310 lb: net 4,128, tare 4,340, gross 8,468. */
const BINS: PageOrder = {
  number: 2001,
  lines: [{ qty: 192, eachWeight: 21.5, weight: 4128, partNumber: "DEMO 3001", partName: "Bracket" }],
  containers: [{ ...BINS_14 }],
};
/** 30 pieces at 10 lb on two rows of 15 pieces with no tare each: net 300, and no gross. */
const SKIDS: PageOrder = {
  number: 2002,
  lines: [{ qty: 30, eachWeight: 10, weight: 300, partNumber: "DEMO 3002", partName: "Collar" }],
  containers: [
    { typeName: "Skid", count: 3, pieces: 15, tareEach: null },
    { typeName: "Wire Basket", count: 1, pieces: 15, tareEach: null },
  ],
};

/** The three pages, rendered once: the skids' traveler, the bins' ticket and the skids' bill of lading. */
let pdf: { traveler: Buffer; ticket: Buffer; bol: Buffer };
beforeAll(async () => {
  pdf = { traveler: await travelerPdf(SKIDS), ticket: await ticketPdf(BINS), bol: await bolPdf(SKIDS) };
});
/** One of the three pages as the reader gives it. */
const lines = (doc: keyof typeof pdf): string[] => printedPages(pdf[doc], { pages: 1, what: doc })[0];

/** A page written by hand, in the one shape the decoder reads with no ToUnicode map: a Type1 font
 *  with WinAnsiEncoding, and one hex string of which each byte is a character, drawn at (10, 10)
 *  from the page's bottom-left. `mediaBox`, when given, is the page's size. */
function handMadePage(hex: string, mediaBox?: string): Buffer {
  const content = `BT /F1 12 Tf 1 0 0 1 10 10 Tm <${hex}> Tj ET`;
  return Buffer.from([
    "%PDF-1.3",
    "1 0 obj << /Type /Pages /Count 1 /Kids [2 0 R] >> endobj",
    `2 0 obj << /Type /Page /Parent 1 0 R ${mediaBox === undefined ? "" : `/MediaBox [${mediaBox}] `}/Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >> endobj`,
    "3 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> endobj",
    `4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
  ].join("\n"), "latin1");
}

/** What `act` raises, or undefined when it raises nothing. */
function raised(act: () => unknown): unknown {
  try { act(); } catch (error) { return error; }
  return undefined;
}
/** A refusal of the reader: a `node:assert` failure whose message holds `text`. */
const refusal = (text: string) => ({ code: "ERR_ASSERTION", message: expect.stringContaining(text) });

describe("printedPages (e2e/lib/printed-page.mjs)", () => {
  it.each<[keyof typeof pdf, string[], string[], string[]]>([
    // The order's three totals lines are drawn between its two container rows: drawing order, not top to bottom.
    ["traveler", ["Order totals", "30", "30", "300 lb", "Skid", "15 pcs", "3", "Net 300 lb", "Tare", "Gross", "Wire Basket", "15 pcs", "1", "Process:"],
      ["10 lb", "300 lb", "300 lb"], ["15 pcs", "15 pcs"]],
    ["ticket", ["Quantity Shipped:", "192", "Net weight:", "4,128.00 lb", "Tare:", "4,340.00 lb", "Gross weight:", "8,468.00 lb", "Order No.: 2001"],
      ["4,128 lb", "4,340 lb", "310 lb each", "4,128.00 lb", "4,340.00 lb", "8,468.00 lb", "4,128.00 lb"], []],
    ["bol", ["Check Column", "4", "300 lb", "Net weight"], ["300 lb"], []],
  ])("gives the %s as whole lines in the order the page draws them", (doc, run, weights, pieces) => {
    const [page] = printedPages(pdf[doc], { pages: 1, what: doc });
    const at = page.indexOf(run[0]);
    expect(page.slice(at, at + run.length)).toEqual(run);
    expect(weightLines(page)).toEqual(weights);
    expect(piecesLines(page)).toEqual(pieces);
  });

  it("gives one list of lines for each page of a document of two pages", async () => {
    const two = await renderPdf({ content: [{ text: "alpha body", pageBreak: "after" }, { text: "beta body" }] });
    expect(printedPages(two, { pages: 2, what: "two pages" })).toEqual([["alpha body"], ["beta body"]]);
  });

  it("takes text left at the end of a page as one more line, with its trailing white space cut", async () => {
    const page = await renderPdf({ content: [{ text: "alpha beta " }] });
    // The premise: the last run the page draws ends in white space, so no run after it ends the line.
    expect(textRunsWithY(page)[0].map((run) => run.text)).toEqual(["alpha ", "beta "]);
    expect(printedPages(page, { pages: 1, what: "a tail" })).toEqual([["alpha beta"]]);
  });

  it("refuses a document that has another number of pages than asked", () => {
    expect(raised(() => printedPages(pdf.ticket, { pages: 2, what: "the ticket" })))
      .toMatchObject(refusal("the ticket: the document says it has 1 page(s); 2 expected"));
  });

  it("refuses a file cut in half, which decodes to no page and no error", () => {
    const cut = pdf.ticket.subarray(0, Math.floor(pdf.ticket.length / 2));
    // The premise: the decoder gives no page for these bytes, and raises nothing.
    expect(textRunsWithY(cut)).toEqual([]);
    expect(raised(() => printedPages(cut, { pages: 1, what: "the ticket" })))
      .toMatchObject(refusal("the ticket: 0 page(s) could be read of the 1 the document says it has"));
  });

  it.each<[string, unknown]>([
    ["bytes that are not a PDF", Buffer.from("<html>Sign in</html>")],
    ["a value that is not bytes", undefined],
  ])("refuses %s with the code ERR_ASSERTION, where the decoder's own error has none", (_what, bytes) => {
    expect(raised(() => printedPages(bytes, { pages: 1, what: "the ticket" })))
      .toMatchObject(refusal("the ticket: the stored bytes could not be read as a PDF ("));
  });

  it("refuses bytes whose page count reads and whose pages cannot be found, with the code ERR_ASSERTION and the text reader's own words", () => {
    // The count is in the file, and the object that holds it never ends. So the count is read, and
    // it is the text reader that raises: a plain error with no code, whose words these are.
    const bytes = Buffer.from("%PDF-1.4\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n");
    expect(raised(() => printedPages(bytes, { pages: 1, what: "the ticket" })))
      .toMatchObject(refusal("the ticket: the stored bytes could not be read as a PDF (No root /Pages object found)"));
  });

  it("refuses a page that draws no text", async () => {
    const blank = await renderPdf({ content: [{ canvas: [{ type: "line", x1: 0, y1: 0, x2: 100, y2: 0, lineWidth: 1 }] }] });
    expect(raised(() => printedPages(blank, { pages: 1, what: "a blank page" })))
      .toMatchObject(refusal("a blank page: page 1 drew no text that could be read"));
  });

  it("refuses a page whose only text is white space", () => {
    const blank = handMadePage("20");
    // The premise: the decoder reads the page and gives one run, a space. So the page has text, and
    // the line left at its end is an empty one.
    expect(textRunsWithY(blank).map((page) => page.map((run) => run.text))).toEqual([[" "]]);
    expect(raised(() => printedPages(blank, { pages: 1, what: "a page of white space" })))
      .toMatchObject(refusal("a page of white space: page 1 drew no text that could be read"));
  });

  it("refuses a page with a glyph that cannot be read", () => {
    // The ticket with one font's ToUnicode key misspelled: that font's text has no mapping left.
    const broken = Buffer.from(pdf.ticket.toString("latin1").replace("/ToUnicode", "/ToUnicodX"), "latin1");
    expect(raised(() => printedPages(broken, { pages: 1, what: "the ticket" })))
      .toMatchObject(refusal("the ticket: page 1 holds a glyph that could not be read"));
  });
});

describe("printedRuns (e2e/lib/printed-page.mjs)", () => {
  it("gives each run's text and its baseline in points from the page's top-left, the page's height less the decoder's y", () => {
    // "AB" drawn at (10, 10) from the bottom-left of a page 300 pt tall: 290 pt from its top.
    const page = handMadePage("4142", "0 0 200 300");
    expect(textRunsWithY(page)).toEqual([[{ text: "AB", x: 10, y: 10 }]]);
    expect(printedRuns(page, { pages: 1, what: "a hand-made page" })).toEqual([[{ text: "AB", x: 10, y: 290 }]]);
  });

  it("measures from the page's top edge, the MediaBox's upper y, when its lower y is not zero", () => {
    // "AB" at device y 10 on a page whose box runs from y 100 to y 300: 290 pt under its top edge.
    const page = handMadePage("4142", "0 100 200 300");
    expect(printedRuns(page, { pages: 1, what: "a hand-made page" })).toEqual([[{ text: "AB", x: 10, y: 290 }]]);
  });

  it("places a run the renderer prints at a known place: its x as placed, its baseline under the place's top by less than the font size", async () => {
    const pdf = await renderPdf({ content: [{ text: "Placed", fontSize: 10, absolutePosition: { x: 100, y: 200 } }] });
    const [runs] = printedRuns(pdf, { pages: 1, what: "a placed run" });
    const placed = runs.filter((run) => run.text === "Placed");
    expect(placed).toHaveLength(1);
    expect(placed[0].x).toBeCloseTo(100, 3);
    expect(placed[0].y).toBeGreaterThan(200);
    expect(placed[0].y).toBeLessThan(210);
  });

  it("gives one list of runs for each page of a document of two pages", async () => {
    const two = await renderPdf({ content: [{ text: "alpha", pageBreak: "after" }, { text: "beta" }] });
    const pages = printedRuns(two, { pages: 2, what: "two pages" });
    expect(pages.map((runs) => runs.map((run) => run.text))).toEqual([["alpha"], ["beta"]]);
  });

  it("refuses a page whose size it cannot read", () => {
    expect(raised(() => printedRuns(handMadePage("4142"), { pages: 1, what: "a hand-made page" })))
      .toMatchObject(refusal("a hand-made page: the stored bytes could not be read as a PDF (page 1 has no /MediaBox)"));
  });

  it("refuses a document that has another number of pages than asked", () => {
    expect(raised(() => printedRuns(pdf.ticket, { pages: 2, what: "the ticket" })))
      .toMatchObject(refusal("the ticket: the document says it has 1 page(s); 2 expected"));
  });

  it("refuses a file cut in half, which decodes to no page and no error", () => {
    const cut = pdf.ticket.subarray(0, Math.floor(pdf.ticket.length / 2));
    expect(raised(() => printedRuns(cut, { pages: 1, what: "the ticket" })))
      .toMatchObject(refusal("the ticket: 0 page(s) could be read of the 1 the document says it has"));
  });

  it.each<[string, unknown]>([
    ["bytes that are not a PDF", Buffer.from("<html>Sign in</html>")],
    ["a value that is not bytes", undefined],
  ])("refuses %s with the code ERR_ASSERTION", (_what, bytes) => {
    expect(raised(() => printedRuns(bytes, { pages: 1, what: "the ticket" })))
      .toMatchObject(refusal("the ticket: the stored bytes could not be read as a PDF ("));
  });

  it("refuses a run with a glyph that cannot be read", () => {
    const broken = Buffer.from(pdf.ticket.toString("latin1").replace("/ToUnicode", "/ToUnicodX"), "latin1");
    expect(raised(() => printedRuns(broken, { pages: 1, what: "the ticket" })))
      .toMatchObject(refusal("the ticket: page 1 holds a glyph that could not be read"));
  });
});

describe("printedImages and paintedImages (e2e/lib/printed-page.mjs, tests/helpers/pdf.ts)", () => {
  const JPEG = `data:image/jpeg;base64,${TINY_JPEG.toString("base64")}`;

  it("gives each painted image's box in points from the page's top-left, as the renderer placed it", async () => {
    const placed = await renderPdf({ content: [
      { image: JPEG, width: 80, height: 40, absolutePosition: { x: 100, y: 200 } },
      { image: JPEG, width: 30, height: 60, absolutePosition: { x: 300, y: 50 } },
      { text: "beside" },
    ] });
    const boxes = [[{ x: 100, y: 200, w: 80, h: 40 }, { x: 300, y: 50, w: 30, h: 60 }]];
    expect(paintedImages(placed)).toEqual(boxes);
    expect(printedImages(placed, { pages: 1, what: "two images" })).toEqual(boxes);
  });

  it("gives one list for each page, an empty one for a page that paints none", async () => {
    const two = await renderPdf({ content: [
      { image: JPEG, width: 20, height: 10, absolutePosition: { x: 40, y: 60 } },
      { text: "first", pageBreak: "after" }, { text: "second" },
    ] });
    expect(printedImages(two, { pages: 2, what: "two pages" })).toEqual([[{ x: 40, y: 60, w: 20, h: 10 }], []]);
  });

  it("refuses a document that has another number of pages than asked", () => {
    expect(raised(() => printedImages(pdf.ticket, { pages: 2, what: "the ticket" })))
      .toMatchObject(refusal("the ticket: the document says it has 1 page(s); 2 expected"));
  });

  it("refuses a file cut in half, which decodes to no page and no error", () => {
    const cut = pdf.ticket.subarray(0, Math.floor(pdf.ticket.length / 2));
    expect(raised(() => printedImages(cut, { pages: 1, what: "the ticket" })))
      .toMatchObject(refusal("the ticket: 0 page(s) could be read of the 1 the document says it has"));
  });

  it.each<[string, unknown]>([
    ["bytes that are not a PDF", Buffer.from("<html>Sign in</html>")],
    ["a value that is not bytes", undefined],
  ])("refuses %s with the code ERR_ASSERTION", (_what, bytes) => {
    expect(raised(() => printedImages(bytes, { pages: 1, what: "the ticket" })))
      .toMatchObject(refusal("the ticket: the stored bytes could not be read as a PDF ("));
  });
});

describe("assertRun (e2e/lib/printed-page.mjs)", () => {
  it("finds a run of whole lines that the page draws one after another", () => {
    expect(raised(() => assertRun(lines("ticket"), ["Net weight:", "4,128.00 lb", "Tare:", "4,340.00 lb"], "the ticket"))).toBeUndefined();
  });

  it.each<[string, string[]]>([
    ["first", ["Net weight:"]],
    ["last", ["300 lb"]],
  ])("finds a run at the list's %s line", (_where, run) => {
    expect(raised(() => assertRun(["Net weight:", "300 lb"], run, "a list"))).toBeUndefined();
  });

  it("fails on a run that is not on the page, and prints what was asked and every line the page drew", () => {
    const drawn = lines("bol");
    expect(raised(() => assertRun(drawn, ["Check Column", "4", "300 lb", "Gross weight"], "the bill of lading"))).toMatchObject({
      code: "ERR_ASSERTION",
      message: 'the bill of lading: the page does not draw ["Check Column","4","300 lb","Gross weight"] as whole lines one after another. '
        + `It drew ${JSON.stringify(drawn)}`,
    });
  });

  it.each<[string, keyof typeof pdf, string[]]>([
    ["4,128 on a page that draws 4,128.00 lb", "ticket", ["4,128"]],
    ["30 on a page that draws 300 lb", "bol", ["30"]],
  ])("does not find a figure inside a longer one: %s", (_what, doc, run) => {
    expect(raised(() => assertRun(lines(doc), run, doc))).toMatchObject(refusal("as whole lines one after another"));
  });

  it("does not find lines that are on the page and not one after another", () => {
    expect(raised(() => assertRun(lines("ticket"), ["Net weight:", "8,468.00 lb"], "the ticket")))
      .toMatchObject(refusal("as whole lines one after another"));
  });

  it.each<[string, unknown]>([
    ["an empty run", []],
    ["a run that holds an empty line", ["Net weight:", ""]],
    ["a run that holds a number", [300]],
    ["a line that is not in a list", "Net weight:"],
  ])("refuses %s before it looks at the page", (_what, run) => {
    expect(raised(() => assertRun(["Net weight:", "", "300"], run, "the ticket")))
      .toMatchObject(refusal("the ticket: a run is one or more whole printed lines"));
  });
});

describe("weightLines and piecesLines (e2e/lib/printed-page.mjs)", () => {
  it("keeps the lines that are a printed weight, whole and in order", () => {
    expect(weightLines(["4,128 lb", "Net 300 lb", "4,128.00 lb", "300 lb net", "310 lb each", "-50 lb", "300", "lb", "300 lbs", "15 pcs", "1,727.5 lb"]))
      .toEqual(["4,128 lb", "4,128.00 lb", "310 lb each", "-50 lb", "1,727.5 lb"]);
  });

  it("keeps the lines that are a printed piece count, whole and in order", () => {
    expect(piecesLines(["15 pcs", "Skid 15 pcs", "1,000 pcs", "-5 pcs", "15 pcs each", "15", "pcs", "15.5 pcs", "300 lb"]))
      .toEqual(["15 pcs", "1,000 pcs", "-5 pcs"]);
  });
});

describe("poundsCents (e2e/lib/printed-page.mjs)", () => {
  it.each<[string, number]>([
    ["8,468 lb", 846800], ["8,468.00 lb", 846800], ["1,727.5 lb", 172750], ["8,468.00", 846800], ["4128.00", 412800],
    ["300", 30000], ["0 lb", 0], ["-50.00", -5000], ["-0.00", 0],
  ])("reads %s as %d cents", (text, cents) => {
    expect(poundsCents(text, "a cell")).toBe(cents);
  });

  it.each(["Incomplete", "Not available", "—", "", "310 lb each", "Net 300 lb", "8,46 lb", "1.234 lb", "300 lbs"])("refuses %j", (text) => {
    expect(raised(() => poundsCents(text, "a cell"))).toMatchObject(refusal(`a cell: ${JSON.stringify(text)} is not a weight`));
  });
});

type Served = { status: number; type: string | undefined; body: Buffer };

/** A stand-in for a Playwright page, as far as `storedPdf` uses one. `gets` records each GET,
 *  argument by argument. An Error is thrown, the way the GET rejects on a socket it could not use. */
function standIn(answer: Served | Error) {
  const gets: unknown[][] = [];
  const get = async (...how: unknown[]) => {
    gets.push(how);
    if (answer instanceof Error) throw answer;
    return {
      status: () => answer.status,
      headers: () => (answer.type === undefined ? {} : { "content-type": answer.type }),
      body: async () => answer.body,
    };
  };
  return { gets, page: { request: { get } } };
}

describe("storedPdf (e2e/lib/printed-page.mjs)", () => {
  const BYTES = Buffer.from("%PDF-1.3 a stand-in");
  const served = (over: Partial<Served> = {}) => standIn({ status: 200, type: "application/pdf", body: BYTES, ...over });

  it.each(["application/pdf", "application/pdf; charset=binary"])("reads the document's address once, with one retry, and gives its bytes (%s)", async (type) => {
    const { gets, page } = served({ type });
    expect(await storedPdf(page, "http://e2e.test", "doc_1", "the traveler")).toBe(BYTES);
    expect(gets).toEqual([["http://e2e.test/api/documents/doc_1", { maxRetries: 1 }]]);
  });

  it.each<[string, Partial<Served>, string]>([
    ["a status other than 200", { status: 404 }, "the traveler: stored document doc_1 must be served"],
    ["a content type that is not a PDF", { type: "text/html; charset=utf-8" }, 'the traveler: stored document doc_1 must be served as a PDF; its content type is "text/html; charset=utf-8"'],
    ["no content type", { type: undefined }, 'the traveler: stored document doc_1 must be served as a PDF; its content type is ""'],
  ])("fails by node:assert on %s", async (_what, over, message) => {
    await expect(storedPdf(served(over).page, "http://e2e.test", "doc_1", "the traveler")).rejects.toMatchObject(refusal(message));
  });

  it("passes an error the GET itself raises through as it was raised", async () => {
    const reset = new Error("apiRequestContext.get: read ECONNRESET");
    await expect(storedPdf(standIn(reset).page, "http://e2e.test", "doc_1", "the traveler")).rejects.toBe(reset);
  });
});

describe("the reader under plain node", () => {
  it("is imported by plain node, which strips the decoder's types and resolves no name without its ending", () => {
    const reader = pathToFileURL(path.join(process.cwd(), "e2e/lib/printed-page.mjs")).href;
    // The test runner's own node options are not passed on: a loader named there could resolve the name.
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const names = execFileSync(process.execPath,
      ["--input-type=module", "--eval", `console.log(Object.keys(await import(${JSON.stringify(reader)})).sort().join(" "))`],
      { env, encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
    expect(names.trim()).toBe("assertRun piecesLines poundsCents printedImages printedPages printedRuns storedPdf weightLines");
    // The case starts a second node, so it has a limit of its own: 30 seconds.
  }, 30_000);
});
