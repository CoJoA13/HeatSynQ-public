/**
 * The traveler's template contract (spec §5.3), derived from `src/server/traveler.ts`'s
 * `buildTravelerDefinition` — every section is one of the builder's stacked blocks, in stack
 * order, and every field is a label or column that builder actually prints. A contract can only
 * re-arrange, re-label, restyle, show, or hide what the data layer already collects (spec §5.3);
 * nothing here is a new data source.
 *
 * LOCKED (spec §5.6): the steps section, its typed-field rendering, and the barcode. The header
 * section is non-hideable because it is what carries the barcode — hiding it would hide the lock.
 */
import {
  CONTENT_WIDTH, defaultConfig, defaultFieldConfig,
  type CanvasProfile, type SectionConfig, type TemplateConfig, type TemplateContract,
} from "./types";
import { NET_WEIGHT } from "../weight-terms";

/** The master spec §15 Step-fields ruling (2026-07-30) — the lock's reason string, quoted in
 *  every refusal. Supersedes the original §8 "steps on traveler" show/hide example. */
const STEP_FIELDS_LOCK =
  "Spec §15 Step-fields ruling: typed step fields print in a fixed place on the traveler and " +
  "cannot be quietly omitted.";

export const TRAVELER_HANDWRITING_LOCK =
  "Process traveler requirement: every step must provide aligned EQ#, OP, and Date handwriting boxes.";

const HANDWRITING_FIELD_KEYS = ["step_eq", "step_op", "step_date"] as const;

/** Shared with the named PDF step layout (render.ts). The width-compatibility budget below still
 *  reserves padding and a rule for every column. The EQ#/OP/Date columns render unpadded and
 *  unruled since the 2026-09-26 print refresh, so that budget over-reserves, which is the safe
 *  direction. Every size below is a PRINTED size (owner ruling B, 2026-09-26 dev test), not a
 *  pdfmake content height — `TRAVELER_STEP_ROW_CONTENT_MIN`/`TRAVELER_STEP_BOX_CONTENT` below are
 *  the derived content heights the builder actually hands pdfmake, each documented separately.
 *  `rowHeight` is the MINIMUM printed height of a step row, measured between the centres of its
 *  top and bottom rules (a one-line step prints exactly this at the default template font; taller
 *  content, or a template with a larger base font, grows it). `boxHeight` is likewise the MINIMUM
 *  printed height of each small EQ#/OP/Date handwriting box, measured between the centres of its
 *  own top and bottom border lines: it is empty, but pdfmake still reserves at least one line's
 *  height for it at the cell's current font size, so it prints exactly this at the default
 *  template font and grows only when a template's base font makes that empty line taller than the
 *  box's content height. `cellPaddingY` is the explicit top/bottom cell padding of both the steps
 *  table and the sign-off boxes (pdfmake's own default value, now stated rather than implied).
 *  `padding` stays the content columns' left/right padding. */
export const TRAVELER_STEP_LAYOUT = {
  padding: 4, cellPaddingY: 2, ruleWidth: 0.8, firstRuledColumn: 3, rowHeight: 24, boxHeight: 18,
} as const;

// pdfmake `heights` are content heights: a row/box's PRINTED size (measured rule-centre to
// rule-centre) also adds the layout's own top+bottom cell padding and one rule width on top of
// whatever content height is declared. The two constants below are the content heights that
// reproduce the printed `rowHeight`/`boxHeight` above at the default template font — derived,
// never hand-tuned, so the two stay in lock step.

/** The steps table's row `heights` entry: the content height that prints a one-line step row at
 *  exactly `rowHeight`. */
export const TRAVELER_STEP_ROW_CONTENT_MIN =
  TRAVELER_STEP_LAYOUT.rowHeight - 2 * TRAVELER_STEP_LAYOUT.cellPaddingY - TRAVELER_STEP_LAYOUT.ruleWidth;
/** A step handwriting box's `heights` entry: the content height that prints an empty box at
 *  exactly `boxHeight` (at the default template font — see `boxHeight`'s own docstring above). */
export const TRAVELER_STEP_BOX_CONTENT =
  TRAVELER_STEP_LAYOUT.boxHeight - 2 * TRAVELER_STEP_LAYOUT.cellPaddingY - TRAVELER_STEP_LAYOUT.ruleWidth;

/** The traveler's canvas profile (design 2026-11-08 §4.1): its four tables in the palette's order
 *  (the inspections and steps tables print a heading), the barcode and the steps table required,
 *  the fields the canvas never places as a field item (the barcode is its own item, the two table
 *  headings print with their tables, the typed step values are the locked rendering inside the
 *  steps table, spec §15 Step-fields), and the step layout's floors: a table box one step row tall,
 *  and the first table's heading and one row above the band. */
export const TRAVELER_CANVAS: CanvasProfile = {
  paper: "traveler",
  tables: [
    { key: "lines", keyed: "section", heading: null, rows: false, printed: { kind: "ruled", copies: 1, head: { size: "base" } } },
    { key: "quantities", keyed: "section", heading: null, rows: false, printed: { kind: "ruled", copies: 1, head: { size: "base" } } },
    { key: "inspections", keyed: "section", heading: "inspections_title", rows: false, printed: { kind: "nested", copies: 1, head: { size: "base" } } },
    { key: "steps", keyed: "section", heading: "steps_title", rows: false, printed: { kind: "steps", head: { size: "base" } } },
  ],
  required: [
    { kind: "barcode", reason: "every traveler prints one (spec §8)" },
    { kind: "table", key: "steps", reason: "every traveler prints its steps (spec §5.6)" },
  ],
  barcode: true,
  notFields: ["barcode", "inspections_title", "steps_title", "step_values"],
  boxedFields: [],
  ruledFields: [],
  leastWidths: {},
  rowFloor: TRAVELER_STEP_LAYOUT.rowHeight,
  firstTableRoom: TRAVELER_STEP_LAYOUT.rowHeight + 30,
};

/** Spec §4/§8 — "barcode automatic": scanning it into the global search opens the order. */
const BARCODE_LOCK =
  "Spec §8: the traveler barcode is automatic — scanning it opens the order — and cannot be " +
  "removed from any traveler template.";

export const TRAVELER_CONTRACT: TemplateContract = {
  docType: "TRAVELER",
  name: "Traveler",
  sections: [
    {
      // headerBlock — non-hideable because the barcode lives here (see BARCODE_LOCK); the
      // individual header fields other than the barcode remain free.
      key: "header", name: "Header", hideable: false, reorderable: true, lockReason: BARCODE_LOCK,
      fields: [
        { key: "customer_name", name: "Customer name", defaultLabel: "", removable: true },
        { key: "received_from", name: "Received-from address", defaultLabel: "", removable: true },
        // Customer.phone (spec §7, owner 2026-09-26). Additive under the #103 rules: a new
        // removable non-column field backfills visible on every stored template's next print.
        { key: "customer_phone", name: "Customer phone", defaultLabel: "Ph:", removable: true },
        // Order.poNumber (#518, owner 2026-10-15, worded 2026-10-17). Additive under the #103
        // rules: a new removable non-column field in a non-hideable section backfills visible on
        // every stored template's next print, published ones included. Its index decides its place
        // in a config's field list (the default's, and where the backfill splices it), never where
        // it prints: headerBlock prints it last in the left stack.
        { key: "po_number", name: "Purchase order", defaultLabel: "PO:", removable: true },
        { key: "company_name", name: "Company name", defaultLabel: "", removable: true },
        { key: "company_address", name: "Company address", defaultLabel: "", removable: true },
        { key: "company_phone", name: "Company phone", defaultLabel: "", removable: true },
        { key: "order_number", name: "Order number", defaultLabel: "Order Number", removable: true },
        { key: "load_number", name: "Load number", defaultLabel: "Load", removable: true },
        {
          key: "barcode", name: "Order barcode", defaultLabel: "", removable: false,
          lockReason: BARCODE_LOCK,
        },
      ],
    },
    {
      // linesTable — widths [78, "*", 78, 88].
      key: "lines", name: "Part lines", hideable: true, reorderable: true,
      fields: [
        {
          key: "line_qty", name: "Part quantity", defaultLabel: "Part Quantity", removable: true,
          column: { table: "lines", defaultWidth: 78 },
        },
        {
          key: "line_part", name: "Part identity",
          defaultLabel: "Part Number / Part Name / Description", removable: true,
          column: { table: "lines", defaultWidth: "*" },
        },
        {
          key: "line_each_weight", name: "Each weight", defaultLabel: "Each weight", removable: true,
          column: { table: "lines", defaultWidth: 78 },
        },
        {
          key: "line_weight", name: NET_WEIGHT, defaultLabel: NET_WEIGHT, removable: true,
          column: { table: "lines", defaultWidth: 88 },
        },
      ],
    },
    {
      // quantityTable — widths [78, 78, "*", 88, 78, 88].
      key: "quantities", name: "Quantities and containers", hideable: true, reorderable: true,
      fields: [
        {
          key: "order_qty", name: "Order quantity", defaultLabel: "Order Quantity", removable: true,
          column: { table: "quantities", defaultWidth: 78 },
        },
        {
          key: "load_qty", name: "Load quantity", defaultLabel: "Load Quantity", removable: true,
          column: { table: "quantities", defaultWidth: 78 },
        },
        {
          key: "container", name: "Container", defaultLabel: "Container", removable: true,
          column: { table: "quantities", defaultWidth: "*" },
        },
        {
          key: "container_qty", name: "Containers", defaultLabel: "Containers",
          removable: true, column: { table: "quantities", defaultWidth: 88 },
        },
        {
          key: "tare_weight", name: "Tare", defaultLabel: "Tare", removable: true,
          column: { table: "quantities", defaultWidth: 78 },
        },
        {
          // The key, the flags and the width are the Gross Weight column's, kept so that every
          // stored template stays valid. Under the weights design's §13 (owner answer 4 of
          // 2026-10-11) the column is headed "Order totals", the screen table's caption, and its
          // cell holds the order's net, tare and gross. This file does not import the screens'
          // leaf: tests/template-contracts.test.ts holds the two texts equal.
          key: "gross_weight", name: "Order totals", defaultLabel: "Order totals", removable: true,
          column: { table: "quantities", defaultWidth: 88 },
        },
      ],
    },
    {
      // processRow — label/value pairs in one hand-laid table; no column memberships (its widths
      // are the builder's own, not a per-column knob).
      key: "process", name: "Process row", hideable: true, reorderable: true,
      fields: [
        // The deliberately blank Process: slot (Phase 3 owner ruling) — ruling 4 binds
        // `part.processName` to it in a later task; the contract just declares the slot.
        { key: "process", name: "Process", defaultLabel: "Process:", removable: true },
        { key: "material", name: "Material", defaultLabel: "Material:", removable: true },
        { key: "process_id", name: "Process ID", defaultLabel: "Process ID:", removable: true },
      ],
    },
    {
      // inspectionsBlock — heading plus the inner table, widths ["*", 55, 48, 48, 72, "*"].
      key: "inspections", name: "Key characteristic inspections", hideable: true, reorderable: true,
      fields: [
        {
          key: "inspections_title", name: "Inspections heading",
          defaultLabel: "Key Characteristic Inspection(s):", removable: true,
        },
        {
          key: "inspection_code", name: "Inspection code", defaultLabel: "Inspection",
          removable: true, column: { table: "inspections", defaultWidth: "*" },
        },
        {
          key: "inspection_scale", name: "Scale", defaultLabel: "Scale", removable: true,
          column: { table: "inspections", defaultWidth: 55 },
        },
        {
          key: "inspection_min", name: "Minimum", defaultLabel: "Min", removable: true,
          column: { table: "inspections", defaultWidth: 48 },
        },
        {
          key: "inspection_max", name: "Maximum", defaultLabel: "Max", removable: true,
          column: { table: "inspections", defaultWidth: 48 },
        },
        {
          key: "inspection_qty", name: "Sample quantity", defaultLabel: "Quantity", removable: true,
          column: { table: "inspections", defaultWidth: 72 },
        },
        {
          key: "inspection_location", name: "Location", defaultLabel: "Location", removable: true,
          column: { table: "inspections", defaultWidth: "*" },
        },
      ],
    },
    {
      // stepsTable — widths [16, 62, "*", 34, 30, 46]. LOCKED whole (spec §5.6): non-hideable
      // and pinned to this position; the typed-field columns below are individually locked too
      // (defense in depth — the section lock alone would not survive a contract edit that
      // loosened it). The EQ#/OP/Date handwriting boxes are NOT typed fields and stay free.
      key: "steps", name: "Process steps", hideable: false, reorderable: false,
      lockReason: STEP_FIELDS_LOCK,
      fields: [
        {
          key: "steps_title", name: "Steps heading", defaultLabel: "PROCESS STEPS:",
          removable: true,
        },
        {
          key: "step_position", name: "Step position", defaultLabel: "", removable: false,
          lockReason: STEP_FIELDS_LOCK, column: { table: "steps", defaultWidth: 16 },
        },
        {
          key: "step_code", name: "Step code", defaultLabel: "", removable: false,
          lockReason: STEP_FIELDS_LOCK, column: { table: "steps", defaultWidth: 62 },
        },
        {
          key: "step_instruction", name: "Step instruction", defaultLabel: "", removable: false,
          lockReason: STEP_FIELDS_LOCK, column: { table: "steps", defaultWidth: "*" },
        },
        {
          // The typed step values ("Furnace Temp: 1650 °F") render inside the instruction
          // column — a rendering, not a column of their own, so no column membership.
          key: "step_values", name: "Typed step values", defaultLabel: "", removable: false,
          lockReason: STEP_FIELDS_LOCK,
        },
        {
          key: "step_eq", name: "EQ# box", defaultLabel: "EQ#", removable: false,
          lockReason: TRAVELER_HANDWRITING_LOCK,
          column: { table: "steps", defaultWidth: 34 },
        },
        {
          key: "step_op", name: "OP box", defaultLabel: "OP", removable: false,
          lockReason: TRAVELER_HANDWRITING_LOCK,
          column: { table: "steps", defaultWidth: 30 },
        },
        {
          key: "step_date", name: "Date box", defaultLabel: "Date", removable: false,
          lockReason: TRAVELER_HANDWRITING_LOCK,
          column: { table: "steps", defaultWidth: 46 },
        },
      ],
    },
    {
      // footerBlocks — the hand-completed results/sign-off area; labels only, hand-laid.
      key: "footer", name: "Results and sign-off", hideable: true, reorderable: true,
      fields: [
        { key: "results", name: "Results box", defaultLabel: "RESULTS:", removable: true },
        {
          key: "tempered_results", name: "Notes / comments box", defaultLabel: "TEMPERED RESULTS:",
          removable: true,
        },
        {
          key: "final_inspection", name: "Final inspection", defaultLabel: "FINAL INSPECTION:",
          removable: true,
        },
        { key: "pass", name: "Pass checkbox", defaultLabel: "PASS", removable: true },
        { key: "fail", name: "Fail checkbox", defaultLabel: "FAIL", removable: true },
        { key: "tested_by", name: "Tested by", defaultLabel: "Tested By:", removable: true },
        { key: "tested_date", name: "Tested date", defaultLabel: "Date:", removable: true },
        { key: "ok_to_ship", name: "OK to ship", defaultLabel: "OK to Ship:", removable: true },
        { key: "ship_date", name: "OK-to-ship date", defaultLabel: "Date:", removable: true },
      ],
    },
  ],
  textBlocks: [], // the traveler carries no standing paragraph — its texts are all data or labels
  // `num()` groups thousands ("4,500"); no date and no price ever prints, so those knobs are
  // deliberately off this document's surface.
  formats: { thousandsSeparator: true },
  // The builder's sizes: defaultStyle 8pt; the company name (12pt) is the sheet's heading; 6.5pt
  // is the size of a cell's second line (a container row's pieces, its tare each, a load's weight).
  fonts: { family: "Roboto", baseSize: 8, headingSize: 12, smallSize: 6.5 },
  canvas: TRAVELER_CANVAS,
};

export const DEFAULT_CONFIG: TemplateConfig = defaultConfig(TRAVELER_CONTRACT);

/** Restores the mandatory handwriting fields without mutating immutable stored config JSON. */
export function normalizeTravelerHandwritingFields(
  sections: SectionConfig[], baseSize = TRAVELER_CONTRACT.fonts.baseSize,
): SectionConfig[] {
  return sections.map((section) => {
    if (section.key !== "steps") {
      return { ...section, fields: section.fields.map((field) => ({ ...field })) };
    }
    const contract = TRAVELER_CONTRACT.sections.find((candidate) => candidate.key === "steps")!;
    const byKey = new Map(section.fields.map((field) => [field.key, { ...field }]));
    const restoringColumns = HANDWRITING_FIELD_KEYS.some((key) => !byKey.get(key)?.visible);
    for (const key of HANDWRITING_FIELD_KEYS) {
      const existing = byKey.get(key);
      const fieldContract = contract.fields.find((field) => field.key === key)!;
      byKey.set(key, existing === undefined
        ? defaultFieldConfig(fieldContract)
        : { ...existing, visible: true });
    }
    const required = new Set<string>(HANDWRITING_FIELD_KEYS);
    const fields = section.fields
      .filter((field) => !required.has(field.key))
      .map((field) => ({ ...field }));
    const anchor = Math.max(
      fields.findIndex((field) => field.key === "step_values"),
      fields.findIndex((field) => field.key === "step_instruction"),
    );
    fields.splice(anchor + 1, 0, ...HANDWRITING_FIELD_KEYS.map((key) => byKey.get(key)!));
    if (restoringColumns) {
      const columns = contract.fields.filter((field) => field.column?.table === "steps");
      const columnBudget = CONTENT_WIDTH - columns.length * 2 * TRAVELER_STEP_LAYOUT.padding -
        (columns.length + 1 - TRAVELER_STEP_LAYOUT.firstRuledColumn) * TRAVELER_STEP_LAYOUT.ruleWidth;
      const fixedWidth = columns.reduce((total, field) => {
        if (field.key === "step_instruction") return total;
        const width = byKey.get(field.key)?.width ?? field.column!.defaultWidth;
        return total + (typeof width === "number" ? width : 0);
      }, 0);
      if (columnBudget - fixedWidth < baseSize) {
        // Reserve at least one em at the configured text size: a positive sliver still cannot fit
        // a normal glyph. This applies only to restored legacy columns, not new-save validation.
        // The compatibility view uses the complete default table; immutable stored JSON is untouched.
        const columnKeys = new Set(columns.map((field) => field.key));
        for (const field of fields) if (columnKeys.has(field.key)) field.width = null;
      } else {
        const instruction = fields.find((field) => field.key === "step_instruction");
        if (instruction?.width != null && instruction.width > columnBudget - fixedWidth) {
          // Restore the contract's flexible column so the native renderer assigns the exact remainder.
          instruction.width = null;
        }
      }
    }
    return { ...section, fields };
  });
}

export type TravelerStepsPrintedWidth = {
  /** The sum of the numeric column widths: the figure the width budget checks. */
  declared: number;
  /** The side padding of the padded columns plus the vertical rule slots. */
  overhead: number;
  /** `declared + overhead`. A minimum when `flexible`. */
  printed: number;
  /** Some step column has no fixed width. */
  flexible: boolean;
};

/**
 * The width the traveler's steps table is laid out at on paper (#450). The width budget sums the
 * declared column widths only; the PDF layout (render.ts `TRAVELER_STEPS_LAYOUT`) adds side
 * padding to every column but EQ#/OP/Date, and a rule slot wherever a padded column meets one of
 * those or the table's edge. Its predicate is restated here because the layout object is server
 * code; `tests/process-traveler-layout.test.ts` reads both and holds them equal.
 *
 * Counts every step column whatever its `visible` flag, in the order the builder prints: none can
 * be hidden, and the builder restores EQ#/OP/Date after the instruction. The slot at the table's
 * right edge is laid out but not drawn while the last column is one of those three, so there the
 * last ink is one rule width inside `printed`.
 */
export function travelerStepsPrintedWidth(
  sections: SectionConfig[], baseSize = TRAVELER_CONTRACT.fonts.baseSize,
): TravelerStepsPrintedWidth {
  const contract = TRAVELER_CONTRACT.sections.find((candidate) => candidate.key === "steps")!;
  const columnOf = new Map(contract.fields.flatMap((field) =>
    field.column?.table === "steps" ? [[field.key, field.column] as const] : []));
  const columns = (normalizeTravelerHandwritingFields(sections, baseSize)
    .find((section) => section.key === "steps")?.fields ?? [])
    .filter((field) => columnOf.has(field.key));
  const handwriting = (i: number) =>
    i >= 0 && i < columns.length && (HANDWRITING_FIELD_KEYS as readonly string[]).includes(columns[i].key);
  let declared = 0, overhead = 0, flexible = false;
  columns.forEach((field, i) => {
    const width = field.width ?? columnOf.get(field.key)!.defaultWidth;
    if (typeof width === "number") declared += width; else flexible = true;
    if (!handwriting(i)) overhead += 2 * TRAVELER_STEP_LAYOUT.padding;
  });
  for (let i = 0; i <= columns.length; i++) {
    if (handwriting(i) !== handwriting(i - 1)) overhead += TRAVELER_STEP_LAYOUT.ruleWidth;
  }
  // Two decimals: binary sums such as 538.4 + 25.6 must compare equal to 564.
  const round = (n: number) => Math.round(n * 100) / 100;
  return { declared: round(declared), overhead: round(overhead), printed: round(declared + overhead), flexible };
}
