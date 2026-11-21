import { describe, expect, it } from "vitest";
import {
  contractFor, defaultConfigFor, validateConfig, type TemplateConfig, type TemplateDocTypeString,
} from "@/lib/template-contracts/index";
import { printedWidthWarning, widthBudgetError } from "@/lib/template-editor";
import { tableHeadingWidth, tablePrintedWidth } from "@/lib/template-printed-width";
import { COLUMN_TABLE_LAYOUTS } from "@/lib/printed-width-core";

/**
 * The flow editor's honest printed-width warning (#991, owner ruling 2026-11-15: each "*" column counted at its widest
 * heading word; design docs/superpowers/specs/2026-11-17-991-flow-tables-in-box-design.md §5). The heading figure is
 * the canvas's warning (d) rule (`headingWholeWidth`), whose word split and sizes tests/canvas-keep-in-box.test.ts holds
 * to pdfmake; at every Standard column table it is #971 report 1's threshold, the width at which the table first fits.
 */

const DOCS: TemplateDocTypeString[] = ["TRAVELER", "SHIPPER", "MOS_SHIPPER", "BOL", "CERT", "INVOICE", "STATEMENT", "QUOTE"];

function configWith(docType: TemplateDocTypeString, edit: (c: TemplateConfig) => void): TemplateConfig {
  const raw = structuredClone(defaultConfigFor(docType));
  edit(raw);
  return validateConfig(docType, raw);
}
const field = (c: TemplateConfig, section: string, key: string) =>
  c.sections.find((s) => s.key === section)!.fields.find((f) => f.key === key)!;
const orderQty = (width: number) => configWith("TRAVELER", (c) => { field(c, "quantities", "order_qty").width = width; });

describe("tableHeadingWidth (#991)", () => {
  it("holds each Standard column table's headings-whole width to #971's first fitting width", () => {
    const want: Record<string, { head: number; headingWhole: number }> = {
      "TRAVELER lines": { head: 40.86, headingWhole: 316.86 },
      "TRAVELER quantities": { head: 34.8, headingWhole: 492.8 },
      "TRAVELER inspections": { head: 37.49, headingWhole: 347.58 },
      "TRAVELER steps": { head: 0, headingWhole: 213.6 },
      "SHIPPER field_strip": { head: 33.72, headingWhole: 377.24 },
      "SHIPPER lines": { head: 40.86, headingWhole: 224.86 },
      "SHIPPER containers": { head: 38.91, headingWhole: 251.83 },
      "MOS_SHIPPER field_strip": { head: 33.72, headingWhole: 377.24 },
      "MOS_SHIPPER lines": { head: 40.86, headingWhole: 224.86 },
      "MOS_SHIPPER containers": { head: 38.91, headingWhole: 251.83 },
      "BOL freight": { head: 33.2, headingWhole: 266 },
      "CERT parts": { head: 45.97, headingWhole: 229.97 },
      "INVOICE columns": { head: 52.87, headingWhole: 290.87 },
      "STATEMENT aging": { head: 40.35, headingWhole: 344.82 },
      "QUOTE columns": { head: 51.71, headingWhole: 289.71 },
    };
    const got: Record<string, { head: number; headingWhole: number }> = {};
    for (const docType of DOCS) {
      for (const table of Object.keys(COLUMN_TABLE_LAYOUTS[docType])) {
        const width = tableHeadingWidth(contractFor(docType), defaultConfigFor(docType), table)!;
        got[`${docType} ${table}`] = { head: width.head, headingWhole: width.headingWhole };
      }
    }
    expect(got).toEqual(want);
  });

  it("counts a blank label as no word, and a hidden section as no table", () => {
    const blank = configWith("TRAVELER", (c) => { field(c, "quantities", "container").label = ""; });
    expect(tableHeadingWidth(contractFor("TRAVELER"), blank, "quantities")).toEqual({ head: 0, headingWhole: 458, shared: ["Container"] });
    const hidden = configWith("TRAVELER", (c) => { c.sections.find((s) => s.key === "quantities")!.visible = false; });
    expect(tableHeadingWidth(contractFor("TRAVELER"), hidden, "quantities")).toBeNull();
  });
});

describe("printedWidthWarning's heading half (#991)", () => {
  const contract = contractFor("TRAVELER");
  const quantities = (c: TemplateConfig) => printedWidthWarning(contract, c, "quantities");

  it("speaks once the headings pass the content width while the columns and padding fit, and not before", () => {
    // Order Qty 149: 481 + 48 = 529 printed, the headings whole at 563.8; 150: at 564.8.
    expect(quantities(orderQty(149))).toBeNull();
    expect(quantities(orderQty(150))).toEqual({
      table: "quantities", printed: 564.8, over: 0.8, atLeast: false,
      message: "On paper the “quantities” table's flexible column has what its fixed columns leave: Container gets " +
        "34 pt, under the 34.8 pt its widest heading word needs, so its heading words break inside their cells. Its " +
        "headings print whole from 564.8 pt wide, past the 564 pt content width. You can still save. Narrow a column to fit.",
    });
  });

  it("is silent where the heading over the flexible column is blank", () => {
    const blank = configWith("TRAVELER", (c) => {
      field(c, "quantities", "order_qty").width = 150;
      field(c, "quantities", "container").label = "";
    });
    expect(quantities(blank)).toBeNull();
  });

  it("is silent where the columns and padding pass the width: the refusal speaks there (owner ruling R-B)", () => {
    // 532 + 48 and 4.5 for the flexible Container: 584.5, past the 564. An unsaved edit: the registry refuses it.
    const past = structuredClone(defaultConfigFor("TRAVELER"));
    field(past, "quantities", "order_qty").width = 200;
    expect(() => validateConfig("TRAVELER", past)).toThrow(/^The "quantities" table needs 584\.5pt on paper/);
    expect(quantities(past)).toBeNull();
    expect(widthBudgetError(contract, past)).toBe(
      'The "quantities" table needs 584.5pt on paper (532pt of column widths, 48pt of cell padding, and 4.5pt ' +
      "for its flexible column), more than its 564pt budget: its fixed columns alone would print past the page. Narrow " +
      "or hide a column.");
  });

  it("is silent on a canvas config, where the canvas's warning (d) speaks", () => {
    expect(quantities({ ...orderQty(150), layout: { version: 1, items: [] } })).toBeNull();
  });

  it("names several shares, a folded table's halves and the bill of lading's sidebar", () => {
    const inspections = configWith("TRAVELER", (c) => { field(c, "inspections", "inspection_scale").width = 280; });
    expect(printedWidthWarning(contract, inspections, "inspections")?.message).toMatch(
      /^On paper the “inspections” table's flexible columns share what its fixed columns leave: Inspection code and Location get .* pt each, under the 37\.49 pt /);
    const containers = configWith("SHIPPER", (c) => { field(c, "containers", "container_type").width = 120; });
    expect(printedWidthWarning(contractFor("SHIPPER"), containers, "containers")?.message).toMatch(
      /^On paper each half of the “containers” table shares what its fixed columns leave: Containers and Tare get 34 pt each, under the 38\.91 pt .* from 291\.83 pt each half, 583\.66 pt in all, past the 282 pt each half has\./);
    const freight = configWith("BOL", (c) => { field(c, "freight", "package_count").width = 170; });
    expect(printedWidthWarning(contractFor("BOL"), freight, "freight")?.message).toMatch(
      /^On paper the “freight” table's flexible column has what its fixed columns leave beside the sidebar: Freight description gets .* pt, under the 33\.2 pt .* from 396 pt beside the sidebar, past the 386 pt it has there\./);
  });

  it("refuses nothing the heading warning speaks of: the warning never blocks a save", () => {
    for (const docType of DOCS) {
      const config = defaultConfigFor(docType);
      for (const table of Object.keys(COLUMN_TABLE_LAYOUTS[docType])) {
        expect(tablePrintedWidth(contractFor(docType), config, table), `${docType} ${table}`).not.toBeNull();
      }
      expect(widthBudgetError(contractFor(docType), config), docType).toBeNull();
    }
    expect(quantities(orderQty(150))).not.toBeNull();
    expect(widthBudgetError(contract, orderQty(150))).toBeNull();
  });
});
