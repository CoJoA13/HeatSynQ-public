import { describe, it, expect } from "vitest";
import { toXlsx } from "@/server/excel";
import { readXlsx, xlsxParts } from "./helpers/xlsx";

// The read-back helper the export suites assert through. A helper that answered undefined for a
// row or column that is not there would let `expect(sheet.row(9)).not.toContain(...)` pass on
// nothing, so reading past the sheet throws.
describe("the xlsx read-back helper", () => {
  const columns = [{ key: "a", header: "A" }, { key: "b", header: "B" }];
  const workbook = () => toXlsx("Sheet", columns, [{ a: "  padded  ", b: 1 }, { a: "second", b: null }]);

  it("reads rows, cells and columns by their spreadsheet numbers", async () => {
    const sheet = await readXlsx(await workbook(), "Sheet");
    expect(sheet.rows).toEqual([["A", "B"], ["  padded  ", 1], ["second", null]]);
    expect(sheet.row(1)).toEqual(["A", "B"]);
    expect(sheet.row(3)).toEqual(["second", null]);
    expect(sheet.cell(2, 2)).toBe(1);
    expect(sheet.cell(3, 2)).toBeNull();
    expect(sheet.column(1)).toEqual(["A", "  padded  ", "second"]);
    expect(sheet.column(2)).toEqual(["B", 1, null]);
  });

  it("keeps a string's leading and trailing spaces", async () => {
    expect((await readXlsx(await workbook(), "Sheet")).cell(2, 1)).toBe("  padded  ");
  });

  it("throws for a row or column that is not in the sheet", async () => {
    const sheet = await readXlsx(await workbook(), "Sheet");
    expect(() => sheet.row(4)).toThrow("Row 4 does not exist");
    expect(() => sheet.row(0)).toThrow("Row 0 does not exist");
    expect(() => sheet.cell(4, 1)).toThrow("Row 4 does not exist");
    expect(() => sheet.cell(1, 3)).toThrow("Column 3 does not exist");
    expect(() => sheet.cell(1, 0)).toThrow("Column 0 does not exist");
    expect(() => sheet.column(3)).toThrow("Column 3 does not exist");
  });

  it("rejects a sheet the workbook does not have, by name or by number", async () => {
    const bytes = await workbook();
    await expect(readXlsx(bytes, "Other")).rejects.toThrow("Sheet not found");
    await expect(readXlsx(bytes, 2)).rejects.toThrow("Sheet not found");
    expect((await readXlsx(bytes, 1)).row(1)).toEqual(["A", "B"]);
  });

  it("reads the same sheet from a Buffer, a Uint8Array, an ArrayBuffer and a Response", async () => {
    const bytes = await workbook();
    const copy = new Uint8Array(bytes);
    for (const source of [bytes, copy, copy.buffer, new Response(copy)]) {
      expect((await readXlsx(source, "Sheet")).row(2)).toEqual(["  padded  ", 1]);
    }
  });

  it("xlsxParts tells an absent cell from a styled empty one, and refuses a file that is not a workbook", async () => {
    const parts = xlsxParts(await toXlsx("Sheet", columns, [{ a: null, b: 1 }], "Caption"));
    expect(parts.rows.map((row) => row.cells.map((c) => `${c.ref}=${JSON.stringify(c.text)}`))).toEqual([
      ['A1="Caption"', "B1=null"], ['A2="A"', 'B2="B"'], ['B3="1"'],
    ]);
    expect(() => xlsxParts(Buffer.from("not a zip"))).toThrow();
  });
});
