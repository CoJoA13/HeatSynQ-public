import { execFileSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import {
  buildInvoiceRegister, type InvoiceRegisterData, type InvoiceRegisterPrintedRow,
} from "@/server/pdf/invoice-register";
import { LAYOUT, renderPdf } from "@/server/pdf/render";
import { pageCount, textRunsWithY } from "./helpers/pdf";
import { invoiceRegisterPdfData, type RegisterCustomer } from "@/server/invoice-register";
import type { InvoiceFilter, InvoiceRegisterRow } from "@/server/invoices";
import { assertRun, printedPages } from "../e2e/lib/printed-page.mjs";

// #592: the Invoice register, the Invoicing list's Export to PDF. The builder is PURE (the posting
// register's precedent): every cell arrives as the text it prints, so these cases hand it strings
// and read the rendered page back as whole printed lines (`printedPages`, e2e/lib/printed-page.mjs,
// the decoder of tests/helpers/pdf.ts): a cell is one line, in the order the page draws it. The
// layout is the one the owner approved on the draft render of 2026-10-21 (plan Amendment 8).

/** The Excel's ten column headers, in its order (plan Amendment 4; api/invoices/export). */
const HEADERS = [
  "Document No", "Kind", "Order No", "Customer Code", "Customer Name",
  "Invoice Date", "Status", "Total", "Finalized", "Printed",
];

const FILTER_LINE = "Customer: All customers   Status: All statuses   Invoice date: Any date";
const MADE_LINE = "Made 10/20/2026, 9:15 AM";

function printedRow(overrides: Partial<InvoiceRegisterPrintedRow> = {}): InvoiceRegisterPrintedRow {
  return {
    documentNumber: "1031", kind: "Invoice", orderNumber: "1031", customerCode: "ACME",
    customerName: "Acme Steel Inc", invoiceDate: "10/18/2026", status: "Finalized", total: "1,250.00",
    finalized: "10/18/2026, 8:05 AM", printed: "10/19/2026, 9:10 AM", ...overrides,
  };
}

function data(overrides: Partial<InvoiceRegisterData> = {}): InvoiceRegisterData {
  return {
    filterLine: FILTER_LINE, madeLine: MADE_LINE, rows: [printedRow()],
    summaryLabel: "Total of 1 document", summaryTotal: "1,250.00", ...overrides,
  };
}

type TableNode = {
  table: { headerRows?: number; dontBreakRows?: boolean; widths: unknown[]; body: unknown[][] }; layout?: string;
};

/** The register's table node, found by its layout: the one table the definition holds. */
function table(def: ReturnType<typeof buildInvoiceRegister>): TableNode {
  const content = def.content as Partial<TableNode>[];
  const tables = content.filter((node) => node.table !== undefined);
  expect(tables).toHaveLength(1);
  return tables[0] as TableNode;
}

/** Every page's whole printed lines of a definition, the page count read off the document itself. */
async function drawnPages(def: ReturnType<typeof buildInvoiceRegister>): Promise<string[][]> {
  const pdf = await renderPdf(def);
  return printedPages(pdf, { pages: pageCount(pdf), what: "the invoice register" });
}

/** Every page's whole printed lines. */
const pages = (d: InvoiceRegisterData): Promise<string[][]> => drawnPages(buildInvoiceRegister(d));

describe("buildInvoiceRegister", () => {
  it("is a pure builder: the definition survives a JSON round trip", () => {
    const def = buildInvoiceRegister(data());
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
  });

  it("is landscape letter", async () => {
    const def = buildInvoiceRegister(data());
    expect(def).toMatchObject({ pageSize: "LETTER", pageOrientation: "landscape" });
    // On the paper itself: 11 in wide by 8.5 in tall, in points.
    const pdf = await renderPdf(def);
    expect(pdf.toString("latin1")).toContain("/MediaBox [0 0 792 612]");
  });

  it("draws the title, the filter line, the Made line, the ten headers in order, the row, the summary and the page line", async () => {
    const drawn = await pages(data());
    expect(drawn).toHaveLength(1);
    assertRun(drawn[0], ["Invoice register", FILTER_LINE, MADE_LINE, ...HEADERS], "the register");
    assertRun(drawn[0], [
      "1031", "Invoice", "1031", "ACME", "Acme Steel Inc", "10/18/2026", "Finalized", "1,250.00",
      "10/18/2026, 8:05 AM", "10/19/2026, 9:10 AM",
      "Total of 1 document", "1,250.00",
    ], "the register");
    expect(drawn[0].at(-1)).toBe("Page 1 of 1");
  });

  it("keeps the filter line whole, its three spaces between parts included", async () => {
    const filterLine = "Customer: IEX1 · Export Customer   Status: Draft   Invoice date: 10/18/2026 – 10/24/2026";
    const drawn = await pages(data({ filterLine }));
    assertRun(drawn[0], ["Invoice register", filterLine, MADE_LINE], "the register");
  });

  it("draws one row reading No invoices across the ten columns when there are none, then the blank row and the summary", async () => {
    const def = buildInvoiceRegister(data({ rows: [], summaryLabel: "Total of 0 documents", summaryTotal: "0.00" }));
    const { body } = table(def).table;
    expect(body).toHaveLength(4); // the header, No invoices, the blank row, the summary
    // Centred across the ten columns, as the screen's empty row is (owner, 2026-10-21; Amendment 15).
    expect(body[1]).toEqual([{ text: "No invoices", colSpan: 10, alignment: "center" }, "", "", "", "", "", "", "", "", ""]);
    const pdf = await renderPdf(def);
    const drawn = printedPages(pdf, { pages: 1, what: "the empty register" });
    assertRun(drawn[0], [...HEADERS, "No invoices", "Total of 0 documents", "0.00", "Page 1 of 1"], "the empty register");
    // On the paper: the phrase, about 45 points wide, starts just left of the 792-point page's
    // middle (at about 374), where left-aligned it would start at the margin (about 28).
    const words = textRunsWithY(pdf)[0].filter((run) => run.text === "No " || run.text === "invoices");
    expect(words.map((run) => run.text)).toEqual(["No ", "invoices"]);
    expect(words[0].x).toBeGreaterThan(792 / 2 - 40);
    expect(words[0].x).toBeLessThan(792 / 2);
  });

  it("puts a blank row before the summary, with rows and with none", () => {
    for (const d of [data(), data({ rows: [], summaryLabel: "Total of 0 documents", summaryTotal: "0.00" })]) {
      const { body } = table(buildInvoiceRegister(d)).table;
      expect(body.at(-2)).toEqual(Array(10).fill(""));
    }
  });

  it("writes the summary's words across the first seven columns and the sum under Total, both bold", () => {
    const { body } = table(buildInvoiceRegister(data({ summaryLabel: "Total of 2 documents", summaryTotal: "0.00" }))).table;
    expect(body.at(-1)).toEqual([
      { text: "Total of 2 documents", bold: true, colSpan: 7 }, "", "", "", "", "", "",
      { text: "0.00", bold: true, alignment: "right" }, "", "",
    ]);
  });

  it("draws the ten headers at the top of every page, and Page N of M at each page's foot", async () => {
    // Fifty rows fill the first page and run onto a second (about 36 rows to a page).
    const rows = Array.from({ length: 50 }, (_, i) => printedRow({ documentNumber: String(2000 + i) }));
    const drawn = await pages(data({ rows, summaryLabel: "Total of 50 documents" }));
    expect(drawn).toHaveLength(2);
    for (const [index, lines] of drawn.entries()) {
      assertRun(lines, HEADERS, `page ${index + 1}`);
      expect(lines.at(-1)).toBe(`Page ${index + 1} of 2`);
    }
    // Every row reached the paper, the last on the last page with the summary after it.
    const documentNumbers = drawn.flat().filter((line) => /^2\d{3}$/.test(line));
    expect(documentNumbers).toEqual(rows.map((r) => r.documentNumber));
    assertRun(drawn[1], ["2049"], "page 2");
    assertRun(drawn[1], ["Total of 50 documents", "1,250.00"], "page 2");
  });

  it("bolds the header row and sets Total on the right there and in each row, on the approved page", () => {
    const def = buildInvoiceRegister(data());
    const { body } = table(def).table;
    expect(body[0]).toEqual([
      ...HEADERS.slice(0, 7).map((text) => ({ text, bold: true })),
      { text: "Total", bold: true, alignment: "right" },
      { text: "Finalized", bold: true }, { text: "Printed", bold: true },
    ]);
    expect(body[1]).toEqual([
      "1031", "Invoice", "1031", "ACME", "Acme Steel Inc", "10/18/2026", "Finalized",
      { text: "1,250.00", alignment: "right" }, "10/18/2026, 8:05 AM", "10/19/2026, 9:10 AM",
    ]);
    // The approved draft's page: its margins, its type, and the title, filter and Made lines.
    expect(def).toMatchObject({
      pageMargins: [24, 24, 24, 40],
      defaultStyle: { font: "Roboto", fontSize: 8.5 },
      content: [
        { text: "Invoice register", bold: true, fontSize: 13 },
        { text: FILTER_LINE, margin: [0, 2, 0, 0] },
        { text: MADE_LINE, margin: [0, 2, 0, 8], color: "#444444" },
        { layout: LAYOUT.ruled },
      ],
    });
  });

  it("keeps a row whole: a row the page's foot would cut moves whole to the next page (Amendment 16)", async () => {
    // Twenty-eight one-line rows, then a row ten lines tall, which the first page's foot cuts part
    // way when rows may break. The builder prints what it is handed, so a name broken by hand stands
    // for one wrapped by width (the mapping prints a line break as a space, Amendment 17). The
    // window the row is cut in is about six rows wide on this font, and twenty-eight stands in its
    // middle.
    const tall = Array.from({ length: 10 }, (_, i) => `Wrapped line ${i + 1}`);
    const rows = [
      ...Array.from({ length: 28 }, (_, i) => printedRow({ documentNumber: String(2000 + i) })),
      printedRow({ documentNumber: "9999", customerName: tall.join("\n") }),
    ];
    const def = buildInvoiceRegister(data({ rows, summaryLabel: "Total of 29 documents" }));
    // The control: the same table with rows allowed to break prints the row on both pages, so the
    // case stands at the break.
    const breaking = structuredClone(def);
    delete table(breaking).table.dontBreakRows;
    const cut = await drawnPages(breaking);
    expect(cut).toHaveLength(2);
    expect(tall.some((line) => cut[0].includes(line))).toBe(true);
    expect(tall.some((line) => cut[1].includes(line))).toBe(true);
    // Kept whole: the row starts page 2, every line of it there, and the row before it ends page 1.
    const drawn = await drawnPages(def);
    expect(drawn).toHaveLength(2);
    expect(drawn[0]).toContain("2027");
    expect(drawn[0]).not.toContain("9999");
    expect(tall.filter((line) => drawn[0].includes(line))).toEqual([]);
    expect(drawn[1]).toContain("9999");
    expect(tall.filter((line) => drawn[1].includes(line))).toEqual(tall);
  });

  it("is one ruled table with a repeated header row and its rows kept whole, and nothing that takes the renderer's portrait measurement path", () => {
    const def = buildInvoiceRegister(data());
    const node = table(def);
    expect(node.layout).toBe(LAYOUT.ruled);
    expect(node.table.headerRows).toBe(1);
    expect(node.table.dontBreakRows).toBe(true);
    expect(node.table.widths).toEqual(["auto", "auto", "auto", "auto", "*", "auto", "auto", "auto", "auto", "auto"]);
    // A steps table or a keep-together id sends a definition through `prepareTravelerLayout`,
    // which measures a named page size as portrait letter, and a measured-row id through
    // `fitMeasuredRows`, which refuses a landscape page (render.ts): no `"id":` covers both.
    const text = JSON.stringify(def);
    expect(text).not.toContain(LAYOUT.steps);
    expect(text).not.toMatch(/"id":/);
    expect(def.pageFooterSpec).toEqual({ kind: "pageNofM" });
  });
});

// ---------------------------------------------------------------------------------------------
// The mapping: the register's rows, the filter, its customer and the moment made, as text.
// ---------------------------------------------------------------------------------------------

/** A register row as `listInvoiceRegisterForPdf` answers it: the list row's fields and #591's. */
function registerRow(overrides: Partial<InvoiceRegisterRow> = {}): InvoiceRegisterRow {
  return {
    id: "inv-1", kind: "INVOICE", status: "FINALIZED", orderId: "order-1", orderNumber: 1031,
    documentNumber: "1031", customerId: "cust-1", customerCode: "ACME", customerName: "Acme Steel Inc",
    invoiceDate: "2026-10-18", total: 1250, finalizedAt: "2026-10-18T13:05:00.000Z", deletedAt: null,
    printedAt: "2026-10-19T14:10:00.000Z", creditNumber: null, orderVoided: false, ...overrides,
  };
}

/** 10:15 AM on 10/21/2026 at the plant (UTC-5 in October). */
const NOW = new Date("2026-10-21T15:15:00.000Z");
const map = (rows: InvoiceRegisterRow[], filter: InvoiceFilter = {}, customer: RegisterCustomer | null = null) =>
  invoiceRegisterPdfData({ rows, filter, customer, now: NOW });

describe("invoiceRegisterPdfData", () => {
  it("writes each cell as the screen shows it: labels, MM/DD/YYYY, grouped money, and date and time in plant time", () => {
    const { data } = map([registerRow()]);
    expect(data.rows).toEqual([{
      documentNumber: "1031", kind: "Invoice", orderNumber: "1031", customerCode: "ACME",
      customerName: "Acme Steel Inc", invoiceDate: "10/18/2026", status: "Finalized", total: "1,250.00",
      finalized: "10/18/2026, 8:05 AM", printed: "10/19/2026, 9:10 AM",
    }]);
  });

  it("writes a credit memo and a draft by their labels, the credit's total negative, and a blank Finalized and Printed", () => {
    const { data } = map([
      registerRow({ kind: "CREDIT", documentNumber: "5001", creditNumber: 5001, total: -157.5 }),
      registerRow({ status: "DRAFT", finalizedAt: null, printedAt: null, total: 1234567.8 }),
    ]);
    expect(data.rows.map((r) => [r.kind, r.status, r.total, r.finalized, r.printed])).toEqual([
      ["Credit", "Finalized", "-157.50", "10/18/2026, 8:05 AM", "10/19/2026, 9:10 AM"],
      ["Invoice", "Draft", "1,234,567.80", "", ""],
    ]);
  });

  it("prints a $0 invoice's Total as 0.00, never blank", async () => {
    const { data } = map([registerRow({ total: 0 })]);
    expect(data.rows[0].total).toBe("0.00");
    expect(data.summaryTotal).toBe("0.00");
    const drawn = await pages(data);
    assertRun(drawn[0], ["Finalized", "0.00", "10/18/2026, 8:05 AM"], "the $0 row");
    assertRun(drawn[0], ["Total of 1 document", "0.00"], "the $0 register's summary");
  });

  it("nets a credit against an invoice: 100.00 and -100.00 are Total of 2 documents and 0.00", async () => {
    const { data } = map([registerRow({ total: 100 }), registerRow({ kind: "CREDIT", total: -100 })]);
    expect([data.summaryLabel, data.summaryTotal]).toEqual(["Total of 2 documents", "0.00"]);
    const drawn = await pages(data);
    assertRun(drawn[0], ["Total of 2 documents", "0.00", "Page 1 of 1"], "the summary");
  });

  it("words one row in the singular, and an empty register as Total of 0 documents and 0.00", async () => {
    const one = map([registerRow({ total: -157.5 })]).data;
    expect([one.summaryLabel, one.summaryTotal]).toEqual(["Total of 1 document", "-157.50"]);
    assertRun((await pages(one))[0], ["Total of 1 document", "-157.50"], "one row");
    const none = map([]).data;
    expect([none.summaryLabel, none.summaryTotal]).toEqual(["Total of 0 documents", "0.00"]);
    assertRun((await pages(none))[0], ["No invoices", "Total of 0 documents", "0.00"], "no rows");
  });

  it.each<[what: string, filter: InvoiceFilter, customer: RegisterCustomer | null, line: string]>([
    ["no filter", {}, null,
      "Customer: All customers   Status: All statuses   Invoice date: Any date"],
    ["a customer, Draft and both dates", { customerId: "cust-1", status: "DRAFT", from: "2026-10-18", to: "2026-10-24" },
      { code: "IEX1", name: "Export Customer" },
      "Customer: IEX1 · Export Customer   Status: Draft   Invoice date: 10/18/2026 – 10/24/2026"],
    ["Finalized and a from date only", { status: "FINALIZED", from: "2026-10-18" }, null,
      "Customer: All customers   Status: Finalized   Invoice date: from 10/18/2026"],
    ["a to date only", { to: "2026-10-24" }, null,
      "Customer: All customers   Status: All statuses   Invoice date: through 10/24/2026"],
    ["a date as parsed, its spaces trimmed", { from: " 2026-10-18 " }, null,
      "Customer: All customers   Status: All statuses   Invoice date: from 10/18/2026"],
    ["the Printed filter, not printed (PR 6, owner 2026-10-31: a fourth part only when set)", { printed: "0" }, null,
      "Customer: All customers   Status: All statuses   Invoice date: Any date   Printed: Not printed"],
    ["the Printed filter, printed, with a status", { status: "FINALIZED", printed: "1" }, null,
      "Customer: All customers   Status: Finalized   Invoice date: Any date   Printed: Printed"],
  ])("writes the filter line for %s", async (_what, filter, customer, line) => {
    const { data } = map([registerRow()], filter, customer);
    expect(data.filterLine).toBe(line);
    assertRun((await pages(data))[0], ["Invoice register", line, "Made 10/21/2026, 10:15 AM"], "the header");
  });

  it("prints a line break inside a cell as one space, so a row wraps only by width (Amendment 17)", async () => {
    // Any run of white space holding a line break, in every cell and in the filter line's customer;
    // a run with no line break in it is left as it is.
    const { data } = map([
      registerRow({ documentNumber: "IR\n- 1031", customerCode: "AC\r\nME", customerName: "Acme \n  Steel\r\n\tInc" }),
      registerRow({ customerName: "Acme  Steel" }),
    ], { customerId: "cust-1" }, { code: "IEX\n1", name: "Export\r\nCustomer" });
    expect(data.rows.map((r) => [r.documentNumber, r.customerCode, r.customerName])).toEqual([
      ["IR - 1031", "AC ME", "Acme Steel Inc"],
      ["1031", "ACME", "Acme  Steel"],
    ]);
    const line = "Customer: IEX 1 · Export Customer   Status: All statuses   Invoice date: Any date";
    expect(data.filterLine).toBe(line);
    // On the paper: the filter line whole, and the row's cells each one printed line.
    const drawn = await pages(data);
    assertRun(drawn[0], ["Invoice register", line], "the header");
    assertRun(drawn[0], ["IR - 1031", "Invoice", "1031", "AC ME", "Acme Steel Inc", "10/18/2026"], "the row");
  });

  // R15 (#672, owner 2026-10-22): the fold covers the whole #522 line-break set, not LF and CR
  // alone. pdfmake ends a line on each of the seven, so a name pasted with any of them broke a
  // register row across lines, and enough of them made a row taller than a page, which under
  // Amendment 16 prints on no page at all.
  const SEVEN: [name: string, char: string][] = [
    ["a line feed", "\n"], ["a carriage return", "\r"], ["the line separator U+2028", "\u2028"],
    ["the paragraph separator U+2029", "\u2029"], ["a form feed", "\u000C"], ["a vertical tab", "\u000B"],
    ["a next-line U+0085", "\u0085"],
  ];
  it.each(SEVEN)("prints %s inside a cell and inside the filter line's customer as one space (R15, #672)", async (_name, char) => {
    const { data } = map(
      [registerRow({ documentNumber: `IR${char}1031`, customerName: `Acme ${char} Steel${char}${char}Inc` })],
      { customerId: "cust-1" }, { code: `IEX${char}1`, name: `Export${char}Customer` },
    );
    expect([data.rows[0].documentNumber, data.rows[0].customerName]).toEqual(["IR 1031", "Acme Steel Inc"]);
    const line = "Customer: IEX 1 · Export Customer   Status: All statuses   Invoice date: Any date";
    expect(data.filterLine).toBe(line);
    const drawn = await pages(data);
    expect(drawn).toHaveLength(1);
    assertRun(drawn[0], ["Invoice register", line], "the header");
    assertRun(drawn[0], ["IR 1031", "Invoice", "1031", "ACME", "Acme Steel Inc", "10/18/2026"], "the row");
  });

  it("prints a row of fifty-three next-line characters on the page, not on no page (R15, #672)", async () => {
    // Before R15 a name holding about 53 line-break characters outside LF and CR made the row taller
    // than the landscape body, and `dontBreakRows` then dropped it from the paper.
    const { data } = map([registerRow({ customerName: `A${"\u0085B".repeat(53)}` })]);
    const drawn = await pages(data);
    expect(drawn).toHaveLength(1);
    expect(drawn[0].some((line) => line.startsWith("A B B B"))).toBe(true);
    assertRun(drawn[0], ["Total of 1 document", "1,250.00"], "the summary");
  });

  it("names the Made line and the file by the same moment on the plant's clock", () => {
    expect(map([])).toMatchObject({
      data: { madeLine: "Made 10/21/2026, 10:15 AM" }, fileName: "invoice-register-2026-10-21.pdf",
    });
  });
});

// A child process fixes TZ before the module loads (the format.test.ts and print-selected.test.ts
// precedent): this laptop runs in the plant's own zone, so only a process in another zone shows a
// date-time that is not read in plant time, and only a zone west of UTC (America/Los_Angeles; CI
// runs in UTC) shows a date-only value, the row's invoice date or the filter's, read on the process's
// clock instead of as the UTC midnight it is held as. tsx loads the mapping, which loads no
// database. The child's 15-second bound sits inside the case's own 20.
const MAPPING = new URL("../src/server/invoice-register.ts", import.meta.url).href;
const INSTANTS = [
  "2026-10-21T03:00:00.000Z", // 10:00 PM on the 20th at the plant: the UTC date is the 21st
  "2026-03-08T07:59:00.000Z", // 1:59 AM CST, the minute before the spring change
  "2026-03-08T08:00:00.000Z", // 3:00 AM CDT, the minute after it
  "2026-11-01T06:30:00.000Z", // 1:30 AM CDT, the first of the fall's two 1:30s
  "2026-11-01T07:30:00.000Z", // 1:30 AM CST, the second (the plan's residual: they print alike)
  "2026-10-21T14:02:59.999Z", // 9:02 AM, its seconds and milliseconds not printed or rounded
  "2026-10-21T05:00:00.000Z", // midnight at the plant
  "2026-10-21T17:00:00.000Z", // noon at the plant
];
const plantProbe = `
  import { invoiceRegisterPdfData } from ${JSON.stringify(MAPPING)};
  const out = ${JSON.stringify(INSTANTS)}.map((iso) => {
    const row = {
      id: "i", kind: "INVOICE", status: "FINALIZED", orderId: "o", orderNumber: 1, documentNumber: "1",
      customerId: "c", customerCode: "C", customerName: "C", invoiceDate: "2026-10-20", total: 1,
      finalizedAt: iso, deletedAt: null, printedAt: iso, creditNumber: null, orderVoided: false,
    };
    const { data, fileName } = invoiceRegisterPdfData({
      rows: [row], filter: { from: "2026-10-18", to: "2026-10-24" }, customer: null, now: new Date(iso),
    });
    return [fileName, data.madeLine, data.rows[0].finalized, data.rows[0].printed, data.rows[0].invoiceDate, data.filterLine];
  });
  process.stdout.write(JSON.stringify(out));
`;
const PLANT_EXPECTED = [
  ["invoice-register-2026-10-20.pdf", "Made 10/20/2026, 10:00 PM", "10/20/2026, 10:00 PM"],
  ["invoice-register-2026-03-08.pdf", "Made 03/08/2026, 1:59 AM", "03/08/2026, 1:59 AM"],
  ["invoice-register-2026-03-08.pdf", "Made 03/08/2026, 3:00 AM", "03/08/2026, 3:00 AM"],
  ["invoice-register-2026-11-01.pdf", "Made 11/01/2026, 1:30 AM", "11/01/2026, 1:30 AM"],
  ["invoice-register-2026-11-01.pdf", "Made 11/01/2026, 1:30 AM", "11/01/2026, 1:30 AM"],
  ["invoice-register-2026-10-21.pdf", "Made 10/21/2026, 9:02 AM", "10/21/2026, 9:02 AM"],
  ["invoice-register-2026-10-21.pdf", "Made 10/21/2026, 12:00 AM", "10/21/2026, 12:00 AM"],
  ["invoice-register-2026-10-21.pdf", "Made 10/21/2026, 12:00 PM", "10/21/2026, 12:00 PM"],
].map(([file, made, stamp]) => [
  file, made, stamp, stamp,
  "10/20/2026", "Customer: All customers   Status: All statuses   Invoice date: 10/18/2026 – 10/24/2026",
]);

describe("invoiceRegisterPdfData on the plant's clock", () => {
  it.each(["UTC", "Asia/Tokyo", "America/Los_Angeles"])("reads every date-time in plant time, and every date as held, in a process running in %s", (zone) => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", plantProbe], {
      env: { ...process.env, TZ: zone },
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Whole strings: a plain space before AM and PM, no seconds, and the dates of their own day.
    expect(JSON.parse(output)).toEqual(PLANT_EXPECTED);
  }, 20_000);
});
