import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import { readXlsx, xlsxParts, type XlsxCell } from "./helpers/xlsx";
import { toXlsx } from "@/server/excel";
import { Prisma } from "../prisma/generated/prisma/client";
import { createReference, updateReference } from "@/server/reference";
import { GET as exportRoute } from "@/app/api/admin/reference/[kind]/export/route";
import { signInWith } from "./helpers/auth";

describe("excel export", () => {
  beforeEach(async () => await truncateAll());

  it("produces a real workbook with a header row and the data", async () => {
    const buf = await toXlsx("GL accounts",
      [{ key: "name", header: "Account number" }, { key: "description", header: "Description" }],
      [{ name: "4010", description: "Heat Treat Revenue" }]);

    const sheet = await readXlsx(buf, "GL accounts");
    expect(sheet.row(1)).toEqual(["Account number", "Description"]);
    expect(sheet.row(2)).toEqual(["4010", "Heat Treat Revenue"]);
  });

  it("the export route returns a parseable xlsx and 401s without a session", async () => {
    const ctx = { params: Promise.resolve({ kind: "glAccount" }) };
    const anon = await exportRoute(new Request("http://t/api/admin/reference/glAccount/export"), ctx);
    expect(anon.status).toBe(401);

    const cookie = await signInWith(["admin.view"]);
    await createReference("glAccount", { name: "4010", description: "Heat Treat Revenue" });
    const res = await exportRoute(
      new Request("http://t/api/admin/reference/glAccount/export", { headers: { cookie } }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/spreadsheetml/);
    // The download filename is the human label ("GL accounts"), not the raw camelCase kind
    // ("glAccount") — that internal identifier used to be the only thing the owner ever saw.
    expect(res.headers.get("content-disposition")).toMatch(/filename="GL accounts\.xlsx"/);
    expect(Buffer.from(await res.clone().arrayBuffer()).byteLength).toBeGreaterThan(0);

    // Prove a genuinely working workbook reached the wire — the seam the brief warned about
    // (NextResponse + Uint8Array) — not merely that some bytes came back.
    const sheet = await readXlsx(res, "GL accounts");
    expect(sheet.row(1)).toEqual(["Account number", "Description", "Active"]);
    expect(sheet.row(2)).toEqual(["4010", "Heat Treat Revenue", true]);
  });

  // Phase 6: the first boolean extra column (endingStatement.isDefault) exports the raw boolean —
  // a TRUE/FALSE cell, exactly how the Active column already exports — so a copied cell pastes
  // back through the importer's boolean coercion (see reference-tables.test.ts's paste tests).
  it("exports an ending statement's text and default flag as real cells", async () => {
    const ctx = { params: Promise.resolve({ kind: "endingStatement" }) };
    const cookie = await signInWith(["admin.view"]);
    await createReference("endingStatement", { name: "Standard", text: "Valid 30 days.", isDefault: true });

    const res = await exportRoute(
      new Request("http://t/api/admin/reference/endingStatement/export", { headers: { cookie } }), ctx);
    expect(res.status).toBe(200);
    const sheet = await readXlsx(res, "Ending statements");
    expect(sheet.row(1)).toEqual(["Name", "Text", "Default", "Active"]);
    expect(sheet.row(2)).toEqual(["Standard", "Valid 30 days.", true, true]);
  });

  // Owner ruling 2026-10-05 (#439): Discount % is a number cell with no format. It was the JSON text
  // of the Decimal, quotes included.
  it("exports a Terms row's discount percent as a number cell (#439)", async () => {
    const ctx = { params: Promise.resolve({ kind: "terms" }) };
    const cookie = await signInWith(["admin.view"]);
    await createReference("terms", { name: "2% 10 Net 30", netDays: 30, discountPercent: 2, discountDays: 10 });

    const res = await exportRoute(
      new Request("http://t/api/admin/reference/terms/export", { headers: { cookie } }), ctx);
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    const sheet = await readXlsx(bytes, "Terms");
    expect(sheet.row(1)).toEqual(["Name", "Net days", "Discount %", "Discount days", "Active"]);
    expect(sheet.row(2)).toEqual(["2% 10 Net 30", 30, 2, 10, true]);
    // From the XML: B, C and D are number cells holding 30, 2 and 10.
    expect(xlsxParts(bytes).rows[1].cells.slice(1, 4).map((c) => `${c.ref} ${c.type} ${c.text}`))
      .toEqual(["B2 n 30", "C2 n 2", "D2 n 10"]);
  });

  // Weights design §9.4: a container type's default tare each exports under the pick list's own
  // column label, as a number cell (#439), and a type with none exports no cell.
  it("exports a container type's tare each as a number cell, and no cell for a type with none", async () => {
    const ctx = { params: Promise.resolve({ kind: "containerType" }) };
    const cookie = await signInWith(["admin.view"]);
    await createReference("containerType", { name: "Steel Basket", tareEach: "42.50" });
    await createReference("containerType", { name: "Wire Basket" });

    const res = await exportRoute(
      new Request("http://t/api/admin/reference/containerType/export", { headers: { cookie } }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/filename="Container types\.xlsx"/);
    const bytes = Buffer.from(await res.arrayBuffer());
    const sheet = await readXlsx(bytes, "Container types");
    expect(sheet.rows).toEqual([
      ["Name", "Tare each (lb)", "Active"],
      ["Steel Basket", 42.5, true],
      ["Wire Basket", null, true],
    ]);
    // From the XML: B2 is a number cell holding 42.5, and row 3 has no B element at all.
    expect(xlsxParts(bytes).rows.slice(1).map((row) => row.cells.map((c) => `${c.ref} ${c.type} ${c.text}`)))
      .toEqual([["A2 s Steel Basket", "B2 n 42.5", "C2 b 1"], ["A3 s Wire Basket", "C3 b 1"]]);
  });

  it("mirrors the on-screen includeInactive filter: omitted excludes inactive rows, ?includeInactive=1 includes them", async () => {
    const ctx = { params: Promise.resolve({ kind: "glAccount" }) };
    const cookie = await signInWith(["admin.view"]);
    await createReference("glAccount", { name: "4010", description: "Active account" });
    const inactiveRow = await createReference("glAccount", { name: "4030", description: "Also inactive" });
    await updateReference("glAccount", inactiveRow.id, { active: false });

    const withoutFlag = await readXlsx(await exportRoute(
      new Request("http://t/api/admin/reference/glAccount/export", { headers: { cookie } }), ctx), "GL accounts");
    const namesWithoutFlag = withoutFlag.column(1).slice(1);
    expect(namesWithoutFlag).toEqual(["4010"]);
    expect(namesWithoutFlag).not.toContain("4030");

    const withFlag = await readXlsx(await exportRoute(
      new Request("http://t/api/admin/reference/glAccount/export?includeInactive=1", { headers: { cookie } }), ctx), "GL accounts");
    const namesWithFlag = withFlag.column(1).slice(1);
    expect(namesWithFlag).toEqual(["4010", "4030"]);
  });
});

// #399. `toXlsx` moved from exceljs to write-excel-file. These parts of an export are pinned here
// literally: cell values as read-excel-file reads them, and from the workbook's own XML what that
// reader does not expose — bold, italic, column widths and which cells exist at all.
describe("toXlsx: every cell, width and emphasis of an export (#399)", () => {
  const columns = [
    { key: "a", header: "Text" }, { key: "b", header: "A much longer header than fourteen" }, { key: "c", header: "N" },
    { key: "d", header: "Flag" }, { key: "e", header: "Other" },
  ];
  const decimal = new Prisma.Decimal("2.00"); // what an exporter's row holds for a Decimal column
  const plain = { toJSON: () => "2" };        // an object that is not a Decimal: its JSON text
  const rows: Record<string, unknown>[] = [
    { a: "plain", b: "second", c: 1250.5, d: true, e: "x" },
    { a: "=SUM(A1:A2)", b: "<tag> & \"quoted\" 'single'", c: -75, d: false, e: null },
    { a: "Ünïcode Würks ✓", b: "  padded  ", c: 0, d: true, e: undefined },
    { a: "line one\nline two", b: "tab\there", c: 1234567.891, d: false },                // `e` is missing
    { a: "", b: "crlf\r\nend", c: 0.1 + 0.2, d: true, e: "", extra: "not a column" },
    { a: "x".repeat(40000), b: "_x000D_", c: Number.MAX_SAFE_INTEGER, d: false, e: "ctl\u0000\u000b\u001b" },
    { a: decimal, b: { nested: [1, 2] }, c: 2, d: plain, e: [1, 2] },
    { a: "non-finite", b: Number.NaN, c: Number.POSITIVE_INFINITY, d: true, e: Number.NEGATIVE_INFINITY },
    // No exporter passes a Date today. Its value is pinned; its number format (mm-dd-yy) is not.
    { a: new Date(Date.UTC(2026, 9, 5)), b: "date", c: 1, d: true, e: "y" },
  ];
  // What is read back for each of `rows`, in order.
  const READ: XlsxCell[][] = [
    ["plain", "second", 1250.5, true, "x"],
    ["=SUM(A1:A2)", "<tag> & \"quoted\" 'single'", -75, false, null],
    ["Ünïcode Würks ✓", "  padded  ", 0, true, null],
    ["line one\nline two", "tab\there", 1234567.891, false, null],
    // The carriage return and the literal text "_x000D_" in the next row come back exactly as
    // given. exceljs read them back as "crlf\nend" and as a lone carriage return.
    [null, "crlf\r\nend", 0.30000000000000004, true, null],
    // The writer strips the control characters XML cannot carry.
    ["x".repeat(40000), "_x000D_", Number.MAX_SAFE_INTEGER, false, "ctl"],
    // A Prisma Decimal as its number (#439); other objects and arrays as their JSON text.
    [2, '{"nested":[1,2]}', 2, '"2"', "[1,2]"],
    // A non-finite number is an empty cell (#446).
    ["non-finite", null, null, true, null],
    [new Date(Date.UTC(2026, 9, 5)), "date", 1, true, "y"],
  ];
  // The columns each of `rows` has a cell element in. null, undefined, a missing key, an empty
  // string and a non-finite number all write no element at all.
  const PRESENT = ["ABCDE", "ABCD", "ABCD", "ABCD", "BCD", "ABCDE", "ABCDE", "AD", "ABCDE"];

  for (const [name, caption] of [["without a caption", undefined], ["with a caption", "Posted payments only"]] as const) {
    it(`${name}: every cell, width and emphasis`, async () => {
      const bytes = await toXlsx("Payments", columns, rows, caption);
      const headerRow = caption ? 2 : 1;

      const sheet = await readXlsx(bytes, "Payments");
      expect(sheet.rows).toEqual([
        ...(caption ? [[caption, null, null, null, null]] : []),
        columns.map((c) => c.header),
        ...READ,
      ]);

      const parts = xlsxParts(bytes);
      expect(parts.sheetName).toBe("Payments");
      expect(parts.widths).toEqual([14, 36, 14, 14, 14]);
      // One line per row element: each cell present, with its emphasis.
      const emphasis = parts.rows.map((row) =>
        row.cells.map((c) => `${c.ref}${c.bold ? " bold" : ""}${c.italic ? " italic" : ""}`).join(", "));
      expect(emphasis).toEqual([
        // The whole caption row is italic, the cells beside the caption included.
        ...(caption ? ["A1 italic, B1 italic, C1 italic, D1 italic, E1 italic"] : []),
        [..."ABCDE"].map((letter) => `${letter}${headerRow} bold`).join(", "),
        ...PRESENT.map((letters, index) => [...letters].map((letter) => `${letter}${headerRow + 1 + index}`).join(", ")),
      ]);
      expect(parts.rows.map((row) => row.number)).toEqual(parts.rows.map((_, index) => index + 1));
      if (caption) expect(parts.rows[0].cells.map((c) => c.text)).toEqual([caption, null, null, null, null]);
    });
  }

  // OOXML reads `_xHHHH_` inside a cell's text as the character HHHH, so Excel shows `a_x0041_b` as
  // `aAb` and `_x000D_` as a carriage return. The writer passes text through as it is, so `toXlsx`
  // escapes the underscore of every such run (`_x005F_`), and the text reads back as it was typed.
  it("writes text shaped like an `_xHHHH_` escape so it reads back as typed", async () => {
    const typed = ["a_x0041_b", "_x000D_", "_X000d_", "_x005F_", "_x00_", "plain_x_"];
    const bytes = await toXlsx(
      "S",
      [{ key: "a", header: "Head _x0042_" }, { key: "b", header: "B" }],
      [...typed.map((a) => ({ a, b: { note: "_x0043_" } }))],
      "Caption _x0044_",
    );
    const sheet = await readXlsx(bytes, "S");
    expect(sheet.rows).toEqual([
      ["Caption _x0044_", null],
      ["Head _x0042_", "B"],
      ...typed.map((a) => [a, '{"note":"_x0043_"}']),
    ]);
    expect(xlsxParts(bytes).rows[2].cells[0].text).toBe("a_x005F_x0041_b");
  });

  it("writes no cell for an empty string", async () => {
    const bytes = await toXlsx("S", [{ key: "a", header: "A" }, { key: "b", header: "B" }], [{ a: "", b: "kept" }]);
    expect(xlsxParts(bytes).rows[1]).toEqual({
      number: 2, cells: [{ ref: "B2", type: "s", text: "kept", bold: false, italic: false }],
    });
    expect((await readXlsx(bytes, "S")).row(2)).toEqual([null, "kept"]);
  });

  // Owner ruling 2026-10-05 (#446). Before it, each of these was written into a number cell as its
  // text (<v>NaN</v>), and read-excel-file refused the whole sheet for the NaN.
  it("writes no cell for NaN, Infinity or -Infinity, exactly as for null", async () => {
    const values = [null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    const bytes = await toXlsx("S", [{ key: "n", header: "N" }, { key: "b", header: "B" }],
      values.map((n) => ({ n, b: "kept" })));
    // From the XML: column A has no element in any of the four rows, the null row included.
    expect(xlsxParts(bytes).rows.slice(1)).toEqual(values.map((_, index) => ({
      number: index + 2, cells: [{ ref: `B${index + 2}`, type: "s", text: "kept", bold: false, italic: false }],
    })));
    expect((await readXlsx(bytes, "S")).rows.slice(1)).toEqual(values.map(() => [null, "kept"]));
  });

  // Owner ruling 2026-10-05 (#439): the conversion is in the writer, once, for any Prisma Decimal.
  it("writes a Prisma Decimal as a number cell, and a NaN Decimal as no cell (#439)", async () => {
    // 1.2345 and 0.062500: digits past the second decimal place, which rounding to two would lose.
    const values = ["2.50", "0.040000", "9999999999.99", "NaN", "2", "1.2345", "0.062500"];
    const bytes = await toXlsx("S", [{ key: "n", header: "N" }, { key: "b", header: "B" }],
      values.map((n) => ({ n: new Prisma.Decimal(n), b: "kept" })));
    // From the XML: a number cell ("n") per finite value, and no element at all for the NaN.
    expect(xlsxParts(bytes).rows.slice(1).map((row) => row.cells.map((c) => `${c.ref} ${c.type} ${c.text}`)))
      .toEqual([
        ["A2 n 2.5", "B2 s kept"], ["A3 n 0.04", "B3 s kept"], ["A4 n 9999999999.99", "B4 s kept"],
        ["B5 s kept"], ["A6 n 2", "B6 s kept"], ["A7 n 1.2345", "B7 s kept"], ["A8 n 0.0625", "B8 s kept"],
      ]);
    expect((await readXlsx(bytes, "S")).column(1).slice(1)).toEqual([2.5, 0.04, 9999999999.99, null, 2, 1.2345, 0.0625]);
  });

  it("writes no rows beyond the header for an empty export", async () => {
    const bytes = await toXlsx("Empty", columns, []);
    // Counted from the XML: a reader drops trailing empty rows, so it cannot see one.
    const parts = xlsxParts(bytes);
    expect(parts.rows).toHaveLength(1);
    expect(parts.rows[0].cells.map((c) => c.text)).toEqual(columns.map((c) => c.header));
    expect((await readXlsx(bytes, "Empty")).rows).toEqual([columns.map((c) => c.header)]);
  });
});
