/**
 * Reading an exported .xlsx back in a test.
 *
 * `readXlsx` answers "what does a spreadsheet user see in the cells": values, read with
 * read-excel-file. `xlsxParts` answers what that reader does not expose — fonts, column widths,
 * and whether a cell element exists at all — from the workbook's own XML. It reads the sheet
 * list, the font and cell-style lists, the shared strings, `<cols>` and `<sheetData>` as
 * `src/server/excel.ts` writes them, and throws when one of those holds anything else, so a writer
 * change there is a named parse failure, never a default. It examines nothing outside them (sheet
 * views, merged cells), and of a style only whether its font is bold or italic: not number
 * formats, fills, borders or other font properties.
 */
import { unzipSync, strFromU8 } from "fflate";
import { readSheet } from "read-excel-file/node";

export type XlsxCell = string | number | boolean | Date | null;

export type XlsxSheet = {
  /** 0-based, as the reader returned them: every row padded with null to the sheet's widest valued
   *  column, trailing all-empty rows dropped, strings untrimmed. */
  rows: XlsxCell[][];
  /** Row `n` as a spreadsheet numbers it (1-based). Throws if the sheet has no such row. */
  row(n: number): XlsxCell[];
  /** The cell at 1-based row `n`, column `c`. Throws if either is outside the sheet. */
  cell(n: number, c: number): XlsxCell;
  /** 1-based column `c`, one value per row, header included. Throws if `c` is past the sheet width. */
  column(c: number): XlsxCell[];
};

async function toBuffer(source: Buffer | ArrayBuffer | Uint8Array | Response): Promise<Buffer> {
  if (Buffer.isBuffer(source)) return source;
  if (source instanceof Response) return Buffer.from(await source.arrayBuffer());
  if (source instanceof ArrayBuffer) return Buffer.from(source);
  return Buffer.from(source.buffer, source.byteOffset, source.byteLength);
}

/** Read one sheet, by name or 1-based number. Rejects if the workbook has no such sheet. A
 *  Response body is consumed. */
export async function readXlsx(
  source: Buffer | ArrayBuffer | Uint8Array | Response, sheet: string | number,
): Promise<XlsxSheet> {
  // `trim: false`: the reader trims strings unless told not to, which would hide padding an export
  // wrote. Its cell type names the Date constructor where it returns Date instances, hence the cast.
  const rows = await readSheet(await toBuffer(source), sheet, { trim: false }) as unknown as XlsxCell[][];
  const width = rows.reduce((widest, r) => Math.max(widest, r.length), 0);
  const row = (n: number): XlsxCell[] => {
    if (!Number.isInteger(n) || n < 1 || n > rows.length) throw new Error(`Row ${n} does not exist: the sheet has ${rows.length} row(s)`);
    return rows[n - 1];
  };
  const checkColumn = (c: number): void => {
    if (!Number.isInteger(c) || c < 1 || c > width) throw new Error(`Column ${c} does not exist: the sheet is ${width} column(s) wide`);
  };
  return {
    rows,
    row,
    cell(n, c) {
      const cells = row(n);
      checkColumn(c);
      return cells[c - 1];
    },
    column(c) {
      checkColumn(c);
      return rows.map((r) => r[c - 1]);
    },
  };
}

export type XlsxRawCell = {
  /** The cell reference, e.g. "B2". */
  ref: string;
  /** The `t` attribute: "s" a shared string, "b" a boolean, "n" (the default) a number or a date. */
  type: string;
  /** What the cell holds: a shared string resolved to its text, anything else as the literal
   *  content of `<v>`. `null` when the element has no value at all — a styled but empty cell —
   *  which is not the same as `""`, a real empty-string cell. A cell with neither value nor style
   *  is not written, so it has no entry in its row. */
  text: string | null;
  bold: boolean;
  italic: boolean;
};

export type XlsxParts = {
  /** The sheet's name as the workbook declares it. */
  sheetName: string;
  /** Column widths from `<cols>`, in column order. */
  widths: number[];
  /** One entry per `<row>` element, each with the `<c>` elements actually present. */
  rows: { number: number; cells: XlsxRawCell[] }[];
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeXml(text: string): string {
  return text.replace(/&([^;]*);/g, (whole, name: string) => {
    if (!Object.hasOwn(ENTITIES, name)) throw new Error(`Unrecognised XML entity ${whole}`);
    return ENTITIES[name];
  });
}

/** Every match of `pattern` in `xml`, which must consist of those matches and nothing else. */
function parseAll(xml: string, pattern: RegExp, what: string): RegExpMatchArray[] {
  const matches = [...xml.matchAll(pattern)];
  const rest = xml.replace(pattern, "");
  if (rest !== "") throw new Error(`Unrecognised ${what} XML: ${rest.slice(0, 200)}`);
  return matches;
}

function inner(xml: string, tag: string, file: string): string {
  const found = [...xml.matchAll(new RegExp(`<${tag}(?: [^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))];
  if (found.length !== 1) throw new Error(`Expected exactly one <${tag}> in ${file}, found ${found.length}`);
  return found[0][1];
}

/** The raw-XML view of a single-sheet workbook written by `toXlsx`. */
export function xlsxParts(bytes: Buffer): XlsxParts {
  const files = unzipSync(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const read = (path: string): string => {
    if (!Object.hasOwn(files, path)) throw new Error(`The workbook has no ${path}; it has ${Object.keys(files).join(", ")}`);
    return strFromU8(files[path]);
  };

  // The sheet's file is found through the workbook's relationships rather than assumed.
  const [sheet, ...others] = parseAll(inner(read("xl/workbook.xml"), "sheets", "xl/workbook.xml"),
    /<sheet r:id="([^"]*)" sheetId="\d+" name="([^"]*)"\/>/g, "<sheets>");
  if (!sheet || others.length > 0) throw new Error(`Expected exactly one sheet, found ${others.length + (sheet ? 1 : 0)}`);
  const target = new RegExp(`<Relationship Id="${sheet[1]}" Type="[^"]*/worksheet" Target="([^"]*)"/>`)
    .exec(read("xl/_rels/workbook.xml.rels"));
  if (!target) throw new Error(`No worksheet relationship ${sheet[1]} in xl/_rels/workbook.xml.rels`);
  const sheetXml = read(`xl/${target[1]}`);

  const styles = read("xl/styles.xml");
  const fonts = parseAll(inner(styles, "fonts", "xl/styles.xml"), /<font>([\s\S]*?)<\/font>/g, "<fonts>")
    .map((font) => ({ bold: font[1].includes("<b/>"), italic: font[1].includes("<i/>") }));
  // An <xf> with no fontId uses font 0.
  const cellStyles = parseAll(inner(styles, "cellXfs", "xl/styles.xml"), /<xf ([^>]*)><\/xf>/g, "<cellXfs>").map((xf) => {
    const fontId = Number(/(?:^| )fontId="(\d+)"/.exec(xf[1])?.[1] ?? 0);
    if (fontId >= fonts.length) throw new Error(`A cell style names font ${fontId}; styles.xml has ${fonts.length}`);
    return fonts[fontId];
  });

  const strings = parseAll(inner(read("xl/sharedStrings.xml"), "sst", "xl/sharedStrings.xml"),
    /<si><t(?: xml:space="preserve")?>([^<]*)<\/t><\/si>/g, "shared string").map((si) => decodeXml(si[1]));

  const widths = parseAll(inner(sheetXml, "cols", "the worksheet"), /<col min="(\d+)" max="(\d+)" width="([\d.]+)" customWidth="1"\/>/g, "<cols>")
    .map((col, index) => {
      if (Number(col[1]) !== index + 1 || col[2] !== col[1]) throw new Error(`Unrecognised <col> span: ${col[0]}`);
      return Number(col[3]);
    });

  const rows = parseAll(inner(sheetXml, "sheetData", "the worksheet"), /<row r="(\d+)"(?:\/>|>([\s\S]*?)<\/row>)/g, "<sheetData>").map((row) => ({
    number: Number(row[1]),
    // A row with no cells is written self-closed.
    cells: parseAll(row[2] ?? "", /<c r="([A-Z]+)(\d+)"(?: s="(\d+)")?(?: t="([a-zA-Z]+)")?(?:\/>|><v>([^<]*)<\/v><\/c>)/g, `row ${row[1]}`)
      .map((c): XlsxRawCell => {
        if (c[2] !== row[1]) throw new Error(`Cell ${c[1]}${c[2]} is inside row ${row[1]}`);
        const style = c[3] === undefined ? 0 : Number(c[3]);
        if (style >= cellStyles.length) throw new Error(`Cell ${c[1]}${c[2]} names style ${style}; styles.xml has ${cellStyles.length}`);
        const type = c[4] ?? "n";
        let text: string | null = c[5] ?? null;
        if (type === "s") {
          if (text === null || !/^\d+$/.test(text) || Number(text) >= strings.length) {
            throw new Error(`Cell ${c[1]}${c[2]} names shared string ${text}; the workbook has ${strings.length}`);
          }
          text = strings[Number(text)];
        } else if (text !== null) {
          text = decodeXml(text);
        }
        return { ref: `${c[1]}${c[2]}`, type, text, ...cellStyles[style] };
      }),
  }));

  return { sheetName: decodeXml(sheet[2]), widths, rows };
}
