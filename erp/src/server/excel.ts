import writeXlsxFile, { type Cell, type SheetData } from "write-excel-file/node";
import { Prisma } from "../../prisma/generated/prisma/client";

/** OOXML reads `_xHHHH_` inside a cell's text as the character HHHH (ECMA-376 ST_Xstring), so Excel
 *  shows the typed text `a_x0041_b` as `aAb` and `_x000D_` as a carriage return. write-excel-file
 *  passes text through as it is, so every such run's underscore is written as `_x005F_`, the escape
 *  for itself, and a reader shows the text as it was typed. An upper-case X is escaped too, which a
 *  reader that does not decode it still shows as typed. */
function xlsxText(text: string): string {
  return text.replace(/_([xX][0-9A-Fa-f]{4}_)/g, "_x005F_$1");
}

/** One value of a row as the workbook carries it: a string, number or boolean as it is, nothing for
 *  null, undefined, an empty string or a non-finite number (NaN and the infinities are no number a
 *  cell can hold, #446), a Date as a date, and a Prisma Decimal as its number (#439, owner ruling
 *  2026-10-05: converted here, once, for every exporter). Any other object or array is written as
 *  its JSON text, which is what the exceljs writer did (#399). */
function cell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  // Before the non-finite rule, so a NaN Decimal is an empty cell like any other NaN.
  if (Prisma.Decimal.isDecimal(value)) value = value.toNumber();
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (typeof value === "string") return xlsxText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return { value, type: Date, format: "mm-dd-yy" };
  const json = JSON.stringify(value);
  return json === undefined ? null : xlsxText(json);
}

/** Build a single-sheet workbook. `columns` sets the header row and the row keys; `rows` are keyed
 *  by those column keys. `caption`, when given, is written as an italic cell A1 ABOVE the header (the
 *  header then sits on row 2) — a report uses it to stamp its measure basis into the file itself
 *  (the Payments report's "Posted payments only", spec §4.2). Callers that omit it are unchanged:
 *  the header stays on row 1. */
export async function toXlsx(
  sheetName: string,
  columns: { key: string; header: string }[],
  rows: Record<string, unknown>[],
  caption?: string,
): Promise<Buffer> {
  const data: SheetData = [];
  // The whole caption row is italic, as it was when the row itself carried the font: the cells
  // beside the caption are empty and italic.
  if (caption) data.push(columns.map((_, index) => ({ value: index === 0 ? xlsxText(caption) : undefined, fontStyle: "italic" as const })));
  data.push(columns.map((c) => ({ value: xlsxText(c.header), fontWeight: "bold" })));
  for (const row of rows) data.push(columns.map((c) => cell(row[c.key])));
  return Buffer.from(await writeXlsxFile(data, {
    sheet: sheetName,
    columns: columns.map((c) => ({ width: Math.max(14, c.header.length + 2) })),
  }).toBuffer());
}
