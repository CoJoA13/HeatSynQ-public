/**
 * The canvas rules: what a document's `layout` must satisfy beyond its schema (`canvasRefusal`, the
 * designer's one question, asks the schema first, as the server's parse does). The editor and the
 * server share this one file (design `docs/superpowers/specs/2026-11-07-traveler-canvas-designer-design.md`
 * §6), so a layout the editor accepts is a layout the server accepts. It is client-safe: no
 * `src/server` import. The registry (`template-contracts/index.ts`) calls it; it must not import
 * the registry back (a cycle). Every rule reads the canvas profile the contract declares
 * (`canvasProfile`, design 2026-11-08 §4.1): its tables, its required items, its floors. Its document
 * imports are two, each read from its own module, never through the registry: the traveler's steps
 * measure (`travelerStepsPrintedWidth`, `./template-contracts/traveler`), which warning (d) uses for a
 * table printed in the steps layout, and the container tag's label join and widest digit (`TAG_JOIN`,
 * `widestDigitOf`, `./template-contracts/container-tag`), which the one-label rules (rule 10) measure
 * with through the client-safe metrics leaf `./tag-font-metrics`. Every other table's printed width is the arithmetic of
 * `./printed-width-core`, the registry-free leaf (never `./template-printed-width`, which reads the
 * registry: a cycle).
 *
 * Coordinates: every box is in points from the page's top-left corner, with one exception. A
 * NON-table item anchored below a table stores `box.y` as its offset from that table's rendered
 * bottom; `drawnBox` turns it into page coordinates using the table's drawn box (its minimum height
 * on the canvas). A table's box is always in page coordinates, whatever its stored anchor: a
 * table's anchor is derived (page-top for the first table by y, below the table above for the rest).
 */
import {
  TemplateConfigError, type CanvasProfile, type CanvasTableSpec, type ContractField, type FontsConfig,
  type SectionConfig, type TemplateContract,
} from "./template-contracts/types";
import { travelerStepsPrintedWidth } from "./template-contracts/traveler";
import { TAG_JOIN, widestDigitOf } from "./template-contracts/container-tag";
import { lineHeightOf, textWidthOf } from "./tag-font-metrics";
import { round2, sharedWidthWords, tableOverhead } from "./printed-width-core";
import {
  BARCODE_MIN, CANVAS_GRID, CANVAS_PAGE, CONTINUED_LINE_HEIGHT, CONTINUED_WIDTH, canvasLayoutSchema,
  type CanvasAnchor, type CanvasBox, type CanvasColumn, type CanvasItem, type CanvasLayout, type CanvasPage,
  type CanvasTableKey,
} from "./template-contracts/canvas";

type TableItem = Extract<CanvasItem, { kind: "table" }>;

/** The contract's canvas profile (design 2026-11-08 §4.1). A contract with none offers no canvas,
 *  and asking for its profile is refused. */
export function canvasProfile(contract: TemplateContract): CanvasProfile {
  if (contract.canvas === undefined) {
    throw new TemplateConfigError(`The ${contract.name} template offers no canvas; it keeps its sections.`);
  }
  return contract.canvas;
}

/** The profile's entry for a table, or null when the contract offers no canvas or no such table. */
export function tableSpec(contract: TemplateContract, table: string): CanvasTableSpec | null {
  return contract.canvas?.tables.find((spec) => spec.key === table) ?? null;
}

/** What a profile must hold (design 2026-11-09 §4.1 addition 1), one sentence per problem, in the
 *  profile's order (each table's, then `notFields`, `boxedFields`, `ruledFields`, a `ruledFields`
 *  entry drawn on two lines with no column, and `leastWidths`); [] for a sound
 *  profile and for a contract with none. Pure: the real-contract test calls it, and each clause is
 *  proven on a fixture contract. Each clause is its own statement; the two `notFields` clauses judge
 *  only a key that passes its own clauses, so a key with another problem answers that one alone.
 *  `notFields` holds a field-keyed block's key, its toggles, and every field of a section-keyed rows
 *  or list block's section, so no field prints both as an item and inside its block (design
 *  2026-11-10 §4.6). A `columnTable` (design 2026-11-10 §4.1 addition 1) stands only on a
 *  section-keyed column table (printed, not in the steps layout), and names a table some field of
 *  its own section is a column of; a section-keyed column table with none (the steps layout
 *  included) finds a column under its own key. A bad `columnTable` answers its own sentence alone:
 *  the finds-a-column clause asks only a spec without one, and it and the names-a-table clause ask
 *  only a key that is a section (a key that is none answers the no-section sentence alone). A
 *  `grid` (design 2026-11-10 §4.1 addition 2) stands only on a section-keyed rows block, and names
 *  a section-keyed column table of the same profile that is no rows block, is not printed in the
 *  steps layout, prints one copy and keeps nothing beside its columns; the names-a-grid clause asks
 *  only a spec that passes the first, so a bad `grid` answers one sentence. A `gridEdge` and a
 *  `gridGap` each stand only beside a `grid`. A section-keyed rows block prints no columns (`printed` null): one that
 *  prints some answers its own sentence, and is no column table, so a `columnTable` on it is refused
 *  as on any rows block and the finds-a-column clause never asks it. A `holdsHeight` (design
 *  2026-11-11 §4.1) stands only on a field-keyed block. A `oneLabel` (the container tag design of
 *  2026-11-13 §7.2) names a whole field the contract has, asked last. */
export function profileProblems(contract: TemplateContract): string[] {
  const profile = contract.canvas;
  if (profile === undefined) return [];
  const problems: string[] = [];
  const sections = new Map(contract.sections.map((section) => [section.key, section]));
  const fields = new Set(contract.sections.flatMap((section) => section.fields.map((f) => f.key)));
  const textBlocks = new Set(contract.textBlocks.map((block) => block.key));
  const notFields = new Set(profile.notFields);
  for (const spec of profile.tables) {
    const { key, heading } = spec;
    const fieldKeyed = spec.keyed === "field";
    // A toggle is a field of the section keyed `key` that is no column. A field-keyed block has no
    // section of its own, so it has no toggles: every one it names fails here, by design.
    const plainToggle = (toggle: string) =>
      sections.get(key)?.fields.some((f) => f.key === toggle && f.column === undefined) === true;
    if (!fieldKeyed && !sections.has(key)) {
      problems.push(`The table "${key}" is keyed by section, but the contract has no section "${key}".`);
    }
    if (fieldKeyed && !fields.has(key)) {
      problems.push(`The table "${key}" is keyed by field, but the contract has no field "${key}".`);
    }
    if (fieldKeyed && sections.has(key)) {
      problems.push(`The table "${key}" is keyed by field, but the contract has a section "${key}" too.`);
    }
    if (fieldKeyed && heading !== key) {
      problems.push(
        `The table "${key}" is keyed by field, so its heading is "${key}", not ${heading === null ? "none" : `"${heading}"`}.`,
      );
    }
    if (fieldKeyed && (spec.rows || spec.printed !== null)) {
      problems.push(`The table "${key}" is keyed by field, so it has no rows and prints no columns.`);
    }
    // A rows block's section is its rows (`tableFields` reads it so whatever `printed` says), so a
    // section-keyed one prints no columns, and the column-table clauses below never ask it.
    if (!fieldKeyed && spec.rows && spec.printed !== null) {
      problems.push(`The table "${key}" is a rows block, so it prints no columns.`);
    }
    for (const toggle of spec.toggles ?? []) {
      if (!plainToggle(toggle)) {
        problems.push(`The toggle "${toggle}" of the table "${key}" is not a field of its section without a column.`);
      }
    }
    if (fieldKeyed && fields.has(key) && !sections.has(key) && !notFields.has(key)) {
      problems.push(`The table "${key}" is keyed by field, but notFields does not hold "${key}".`);
    }
    for (const toggle of spec.toggles ?? []) {
      if (plainToggle(toggle) && !notFields.has(toggle)) {
        problems.push(`The toggle "${toggle}" of the table "${key}" is not in notFields.`);
      }
    }
    // A column table's columns are the contract fields whose column names its table: its own key,
    // or the `columnTable` it names (design 2026-11-10 §4.1 addition 1). Only a section-keyed column
    // table names one, and it must name a table its own section's fields are columns of; without
    // one, some field of the contract must be a column of its key. Each scans the contract directly
    // (never `tableFields`), so the profile's own judgement does not lean on the reader it governs.
    const { columnTable } = spec;
    const columnBlock = !fieldKeyed && !spec.rows && spec.printed !== null;
    if (columnTable !== undefined && (!columnBlock || spec.printed?.kind === "steps")) {
      problems.push(`The table "${key}" names the column table "${columnTable}", but only a section-keyed column table names one.`);
    }
    const ownSection = fieldKeyed ? undefined : sections.get(key);
    if (
      columnTable !== undefined && columnBlock && spec.printed?.kind !== "steps" && ownSection !== undefined
      && !ownSection.fields.some((f) => f.column?.table === columnTable)
    ) {
      problems.push(`The table "${key}" names the column table "${columnTable}", but no field of its section is a column of it.`);
    }
    if (
      columnTable === undefined && columnBlock && ownSection !== undefined
      && !contract.sections.some((section) => section.fields.some((f) => f.column?.table === key))
    ) {
      problems.push(`The column table "${key}" finds no column: no field of the contract is a column of "${key}".`);
    }
    // A rows block may print under a grid: a section-keyed column table of the same profile that is
    // no rows block, prints one copy and keeps nothing beside its columns, never one printed in the
    // steps layout (design 2026-11-10 §4.1 addition 2), so its left edge and width are its columns'.
    // Only a section-keyed rows block names one, a grid edge, gap or margin stands only beside a grid,
    // and a gap or margin is a finite number of points, none below 0.
    const { grid, gridEdge, gridGap, gridMargin } = spec;
    const gridBlock = !fieldKeyed && spec.rows;
    if (grid !== undefined && !gridBlock) {
      problems.push(`The table "${key}" names the grid "${grid}", but only a section-keyed rows block prints under one.`);
    }
    if (
      grid !== undefined && gridBlock
      && !profile.tables.some((t) => t.key === grid && t.keyed === "section" && !t.rows && t.printed !== null
        && t.printed.kind !== "steps" && t.printed.copies === 1 && (t.printed.beside ?? 0) === 0)
    ) {
      problems.push(`The grid "${grid}" of the table "${key}" is not a section-keyed column table of the profile.`);
    }
    if (gridEdge !== undefined && grid === undefined) {
      problems.push(`The table "${key}" names a grid edge but no grid.`);
    }
    if (gridGap !== undefined && grid === undefined) {
      problems.push(`The table "${key}" names a grid gap but no grid.`);
    }
    if (gridGap !== undefined && !(Number.isFinite(gridGap) && gridGap >= 0)) {
      problems.push(`The table "${key}" names a grid gap of ${gridGap}, but a grid gap is a finite number of points, none below 0.`);
    }
    if (gridMargin !== undefined && grid === undefined) {
      problems.push(`The table "${key}" names a grid margin but no grid.`);
    }
    if (gridMargin !== undefined && !(Number.isFinite(gridMargin) && gridMargin >= 0)) {
      problems.push(
        `The table "${key}" names a grid margin of ${gridMargin}, but a grid margin is a finite number of points, none below 0.`,
      );
    }
    // A grid indent stands only on a block reading its grid's left edge or every column of it (#971,
    // Codex review: the lines a block prints past a column, outside the grid's columns), past a
    // column of that grid, its gap and floor finite numbers of points, none below 0 (#971).
    const { gridIndent } = spec;
    if (gridIndent !== undefined) {
      if (grid === undefined || gridEdge === "right") {
        problems.push(
          `The table "${key}" names a grid indent, but only a block reading its grid's left edge or every column of it takes one.`,
        );
      } else if (
        // A grid that finds no column at all is named by its own sentence (above), so it answers one.
        tableFields(contract, grid).some((f) => f.column !== undefined)
        && !tableFields(contract, grid).some((f) => f.key === gridIndent.column && f.column !== undefined)
      ) {
        problems.push(`The table "${key}" is indented past "${gridIndent.column}", which is no column of its grid "${grid}".`);
      }
      for (const [what, value] of [["gap", gridIndent.gap], ["floor", gridIndent.floor]] as const) {
        if (!(Number.isFinite(value) && value >= 0)) {
          problems.push(
            `The table "${key}" names a grid indent ${what} of ${value}, but it is a finite number of points, none below 0.`,
          );
        }
      }
    }
    // A grid edge column stands only on a block reading its grid's right edge, a column of that grid,
    // its fixed parts a finite number of points, none below 0 (#971).
    const { gridEdgeColumn } = spec;
    if (gridEdgeColumn !== undefined) {
      if (grid === undefined || gridEdge !== "right") {
        problems.push(`The table "${key}" names a grid edge column, but only a block reading its grid's right edge takes one.`);
      } else if (
        tableFields(contract, grid).some((f) => f.column !== undefined)
        && !tableFields(contract, grid).some((f) => f.key === gridEdgeColumn.column && f.column !== undefined)
      ) {
        problems.push(`The table "${key}" prints "${gridEdgeColumn.column}" at its edge, which is no column of its grid "${grid}".`);
      }
      if (!(Number.isFinite(gridEdgeColumn.fixed) && gridEdgeColumn.fixed >= 0)) {
        problems.push(
          `The table "${key}" names grid edge fixed parts of ${gridEdgeColumn.fixed}, but they are a finite number of points, none below 0.`,
        );
      }
    }
    // A block holds its drawn height only where it is keyed by a field (design 2026-11-11 §4.1).
    if (spec.holdsHeight === true && !fieldKeyed) {
      problems.push(`The table "${key}" holds its drawn height, but only a block keyed by a field holds one.`);
    }
    // A section-keyed rows or list block prints its section's every field inside itself, so none of
    // them may also be placed as a field item (design 2026-11-10 §4.6). A column table's section is
    // judged by its columns and toggles above, never here; a key that is no section answered above.
    const blockSection = fieldKeyed ? undefined : sections.get(key);
    if (blockSection !== undefined && (spec.rows || spec.printed === null)) {
      for (const field of blockSection.fields) {
        if (notFields.has(field.key)) continue;
        problems.push(
          spec.rows
            ? `The row "${field.key}" of the rows block "${key}" is not in notFields.`
            : `The field "${field.key}" of the list block "${key}" is not in notFields.`,
        );
      }
    }
    for (const block of spec.textBlocks ?? []) {
      if (!textBlocks.has(block)) {
        problems.push(`The text block "${block}" of the table "${key}" is not one the contract has.`);
      }
    }
  }
  const ruledKeys = profile.ruledFields.map((ruled) => ruled.key);
  for (const [list, keys] of [
    ["notFields", profile.notFields], ["boxedFields", profile.boxedFields], ["ruledFields", ruledKeys],
  ] as const) {
    for (const k of keys) {
      if (!fields.has(k)) problems.push(`The ${list} key "${k}" is not a field of the contract.`);
    }
  }
  for (const ruled of profile.ruledFields) {
    if (ruled.draw === "lines" && ruled.column === undefined) {
      problems.push(`The ruledFields key "${ruled.key}" draws two lines but names no column.`);
    }
  }
  const tableKeys = new Set(profile.tables.map((spec) => spec.key));
  for (const k of Object.keys(profile.leastWidths)) {
    if (!fields.has(k) && !tableKeys.has(k)) {
      problems.push(`The leastWidths key "${k}" is neither a field nor a table of the profile.`);
    }
  }
  const whole = profile.oneLabel?.wholeField.key;
  if (whole !== undefined && !fields.has(whole)) {
    problems.push(`The oneLabel whole field "${whole}" is not a field of the contract.`);
  }
  return problems;
}

/** Every contract field a canvas may place as a field item: each field with no column, less the
 *  profile's `notFields` (the traveler's: the barcode, the two table headings and the typed step
 *  values). The empty set when the contract offers no canvas. */
export function canvasFieldKeys(contract: TemplateContract): Set<string> {
  const keys = new Set<string>();
  const profile = contract.canvas;
  if (profile === undefined) return keys;
  const notFields = new Set(profile.notFields);
  for (const section of contract.sections) {
    for (const field of section.fields) {
      if (field.column === undefined && !notFields.has(field.key)) keys.add(field.key);
    }
  }
  return keys;
}

/** The points a column table's block keeps beside its columns (the profile's `beside`: the bill of
 *  lading's sidebar and its gap, 178); 0 for a table printed in the steps layout, a list or a rows
 *  block (`printed` null), a column table with none, and a table the profile does not place. Read by
 *  `leastWidth`, rule 9, warning (d) and the stage's header strip. */
export function besideOf(contract: TemplateContract, table: string): number {
  const printed = tableSpec(contract, table)?.printed ?? null;
  return printed === null || printed.kind === "steps" ? 0 : printed.beside ?? 0;
}

/** Whether a table the profile places is a list block: no rows and no printed columns (the bill of
 *  lading's Consignee's ref/PO and TRV numbers blocks, the shipping ticket's serial list). The stage
 *  draws one as its label and one line under the hatch. False for a table the profile does not place. */
export function isListBlock(contract: TemplateContract, table: string): boolean {
  const spec = tableSpec(contract, table);
  return spec !== null && !spec.rows && spec.printed === null;
}

/** The contract field holding a table's heading, where the table has one (the profile's). */
export function tableHeadingKey(contract: TemplateContract, table: string): string | null {
  return tableSpec(contract, table)?.heading ?? null;
}

/** A table's own contract fields: a rows block's section's fields (its rows), else each contract
 *  field whose column names the table (its profile entry's `columnTable`, else its own key: the
 *  invoice's column headers are the fields of the table "columns", design 2026-11-10 §4.1
 *  addition 1), in the contract's order, and then the fields its profile entry's `toggles` name,
 *  in that list's order (the bill of lading's Collect checkbox: an entry of the block's columns
 *  with no column of its own, so every reader through here sees it). */
function tableFields(contract: TemplateContract, table: string): ContractField[] {
  const spec = tableSpec(contract, table);
  if (spec?.rows === true) {
    return contract.sections.find((section) => section.key === table)?.fields ?? [];
  }
  const fields = contract.sections.flatMap((section) => section.fields);
  const toggles = (spec?.toggles ?? []).flatMap((key) => fields.filter((f) => f.key === key));
  const columnTable = spec?.columnTable ?? table;
  return [...fields.filter((f) => f.column?.table === columnTable), ...toggles];
}

/** A table's columns as the contract gives them: each of its contract columns (a rows block: each
 *  of its section's fields; a list: none), in the contract's order, then each of its toggles, shown
 *  at its own label and width (null: the contract's). The one recipe for a table made from nothing:
 *  the designer's new table and cleared page (`placeNew`, `clearedLayout`) and the print's belt
 *  (`completeCanvas`, `src/server/traveler-canvas.ts`). */
export function defaultTableColumns(contract: TemplateContract, table: string): CanvasColumn[] {
  return tableFields(contract, table).map((f) => ({ key: f.key, visible: true, label: null, width: null }));
}

/** The grid a rows block prints under (its profile entry's `grid`, design 2026-11-10 §4.1 addition 2,
 *  §5.2): null when the table's spec names none (a contract with no profile, an unknown key and every
 *  built document's block included); else the grid's key, the layout's item of that key (null when
 *  none is placed) and the columns the block prints under: that item's `columns` as stored, else the
 *  contract's (`defaultTableColumns`). Warning (g) reads it; PR 2's canvas lens will share it. */
export function gridOf(
  layout: CanvasLayout, contract: TemplateContract, table: string,
): { key: string; item: TableItem | null; columns: CanvasColumn[] } | null {
  const grid = tableSpec(contract, table)?.grid;
  if (grid === undefined) return null;
  const item = layout.items.find((i): i is TableItem => i.kind === "table" && i.key === grid) ?? null;
  return { key: grid, item, columns: item?.columns ?? defaultTableColumns(contract, grid) };
}

/** The width a table's visible columns take: each one's own width, else its contract default, a
 *  flexible ("*") column and a toggle (no contract column) counting 0. A column table's least width
 *  (`leastWidth`, which rule 9 and the designer's resize read) is this with its padding and rules,
 *  once per copy, plus what it keeps beside it and one grid step (#971). A column the contract does
 *  not know counts 0 (rule 1 refuses it first). A rows block's rows take no width: 0. */
export function visibleColumnsWidth(contract: TemplateContract, table: TableItem): number {
  if (tableSpec(contract, table.key)?.rows === true) return 0;
  const own = tableFields(contract, table.key);
  let total = 0;
  for (const column of table.columns) {
    if (!column.visible) continue;
    const width = column.width ?? own.find((f) => f.key === column.key)?.column?.defaultWidth ?? 0;
    total += width === "*" ? 0 : width;
  }
  return total;
}

/** An item's least width (design 2026-11-09 §4.1 additions 2 and 5; #971 design §6, the controller's
 *  calls C1 and C2): what its fixed parts need, plus one grid step (`CANVAS_GRID`), unsnapped.
 *  - A column table (printed non-null): its printed width per copy (`canvasTablePrintedWidth`, at
 *    `fonts`' base size, else the contract's: its shown fixed widths and their padding and rules, or
 *    the steps layout's measure) times its copies, plus its `beside`, plus one grid step. Below it a
 *    table's fixed columns would print past its box.
 *  - A grid block printing every column of its grid (a `grid` and no `gridEdge`), with `layout`
 *    handed: its grid's shown columns as `gridOf` resolves them (a hidden one prints nothing, a "*"
 *    one counting 0), the `gridGap` between each two of them, the `gridMargin` while one of them is
 *    "*", and one grid step (`gridLeastWidth`); and, where it prints lines of its own indented past
 *    a column (`gridIndent`: the invoice's PRICE heading, the quote's Material line and PRICE
 *    heading), at least that indent's least width (`indentLeastWidth`), the larger of the two.
 *  - A block reading its grid's left edge past an indent (the invoice's order strip), with `layout`
 *    handed: `indentLeastWidth`.
 *  - A block reading its grid's right edge that prints a grid column there (`gridEdgeColumn`, the
 *    invoice's totals), with `layout` handed: `edgeLeastWidth`.
 *  - Any other list or rows block, the same grid block with no layout, and a field: its
 *    `leastWidths` entry, else 0; any other item 0.
 *  Rule 4 (fields, lists, rows blocks), rule 9 (column tables), the designer's resize floor and its
 *  new field read it. */
export function leastWidth(
  contract: TemplateContract, item: CanvasItem, options: { fonts?: FontsConfig; layout?: CanvasLayout } = {},
): number {
  const leastWidths = contract.canvas?.leastWidths ?? {};
  if (item.kind === "field") return leastWidths[item.key] ?? 0;
  if (item.kind !== "table") return 0;
  const parts = columnTableParts(contract, item, options.fonts?.baseSize ?? contract.fonts.baseSize);
  if (parts !== null) return parts.least;
  const floors = options.layout === undefined ? []
    : [
      gridLeastWidth(contract, item, options.layout), indentLeastWidth(contract, item, options.layout),
      edgeLeastWidth(contract, item, options.layout),
    ].filter((f): f is number => f !== null);
  return floors.length > 0 ? Math.max(...floors) : leastWidths[item.key] ?? 0;
}

/** A block's least width from its `gridIndent` (#971): null for a table whose spec names none. Else
 *  the indent column's shown width as `gridOf` resolves the grid's columns (a hidden one 0; one with
 *  no typed width, "*" included, its contract default, as the builder reads it), plus the indent's `gap` and `floor` and one grid step,
 *  to two decimals: the invoice's order strip, whose row starts past the Quantity column, and the
 *  lines the invoice's price block and the quote's lines print past it (their PRICE heading, the
 *  quote's Material line; `floor` 0, Codex review). */
function indentLeastWidth(contract: TemplateContract, item: TableItem, layout: CanvasLayout): number | null {
  const indent = tableSpec(contract, item.key)?.gridIndent;
  if (indent === undefined) return null;
  const grid = gridOf(layout, contract, item.key);
  if (grid === null) return null;
  const column = grid.columns.find((c) => c.key === indent.column);
  const fallback = tableFields(contract, grid.key).find((f) => f.key === indent.column)?.column?.defaultWidth;
  // As the builder reads the column (invoice.ts `ctxOf`'s `slotNum`): hidden reserves none, a typed
  // width is its own, anything else (no width, "*") the default.
  const width = column === undefined || !column.visible ? 0
    : typeof column.width === "number" ? column.width : typeof fallback === "number" ? fallback : 0;
  return round2(width + indent.gap + indent.floor + CANVAS_GRID);
}

/** A block's least width from its `gridEdgeColumn` (#971): null for a table whose spec names none.
 *  Else the edge column's width as the builder reads it (a shown column's typed width; untyped or
 *  hidden, its contract default: the invoice's `totalsBlock` falls back to it, `slotW.amt || W.amt`),
 *  plus the fixed parts beside it and one grid step, to two decimals: the invoice's totals, whose
 *  amount column follows the column headers' Amount. */
function edgeLeastWidth(contract: TemplateContract, item: TableItem, layout: CanvasLayout): number | null {
  const edge = tableSpec(contract, item.key)?.gridEdgeColumn;
  if (edge === undefined) return null;
  const grid = gridOf(layout, contract, item.key);
  if (grid === null) return null;
  const column = grid.columns.find((c) => c.key === edge.column);
  const fallback = tableFields(contract, grid.key).find((f) => f.key === edge.column)?.column?.defaultWidth;
  const width = column !== undefined && column.visible && typeof column.width === "number" ? column.width
    : typeof fallback === "number" ? fallback : 0;
  return round2(width + edge.fixed + CANVAS_GRID);
}

/** A column table's least width and its parts, as rule 9's sentence names them: its visible columns'
 *  fixed widths (`fixed`, per copy; the steps layout: its declared widths), their padding and rules
 *  (`overhead`, per copy: the printed width less `fixed`), its copies, what it keeps beside them and
 *  the least width (`least`: printed × copies + beside + one grid step). Null for a table that prints
 *  no columns. */
function columnTableParts(
  contract: TemplateContract, item: TableItem, baseSize: number,
): { fixed: number; overhead: number; copies: number; beside: number; least: number } | null {
  const width = canvasTablePrintedWidth(contract, item, baseSize);
  if (width === null) return null;
  const printed = tableSpec(contract, item.key)!.printed!;
  const fixed = printed.kind === "steps"
    ? travelerStepsPrintedWidth([stepsSection(item)], baseSize).declared
    : shownColumns(contract, item).fixed;
  const beside = besideOf(contract, item.key);
  return {
    fixed, overhead: round2(width.printed - fixed), copies: width.copies, beside,
    least: round2(width.printed * width.copies + beside + CANVAS_GRID),
  };
}

/** A grid block's least width from its grid's columns (#971 design §6.1): null for a table whose
 *  spec names no grid or a grid edge (the order strip and the totals read one edge of the grid, so
 *  their entries stand). Else the grid's shown columns as `gridOf` resolves them (the placed grid
 *  item's own, else the contract's), each fixed one at its width and a "*" one at 0, the `gridGap`
 *  between each two shown columns (a hidden column prints nothing, so it takes no gap: the row
 *  builders filter it out), the `gridMargin` while a shown column is "*" (pdfmake counts the cell's
 *  margin in that column's least width; inside a fixed column it is the column's own), and one grid
 *  step, to two decimals. */
function gridLeastWidth(contract: TemplateContract, item: TableItem, layout: CanvasLayout): number | null {
  const spec = tableSpec(contract, item.key);
  if (spec?.grid === undefined || spec.gridEdge !== undefined) return null;
  const grid = gridOf(layout, contract, item.key)!;
  const { fixed, shown, stars } = shownColumns(contract, { key: grid.key, columns: grid.columns });
  const margin = stars.length > 0 ? spec.gridMargin ?? 0 : 0;
  return round2(fixed + (spec.gridGap ?? 0) * Math.max(0, shown - 1) + margin + CANVAS_GRID);
}

/** The grid and the indent column's contract name of a table whose least width `indentLeastWidth`
 *  answers (rule 4's sentence), else null. */
function indentOf(contract: TemplateContract, item: TableItem, layout: CanvasLayout): { grid: string; column: string } | null {
  const indent = tableSpec(contract, item.key)?.gridIndent;
  if (indent === undefined || indentLeastWidth(contract, item, layout) === null) return null;
  const grid = gridOf(layout, contract, item.key)!.key;
  const column = tableFields(contract, grid).find((f) => f.key === indent.column)?.name ?? indent.column;
  return { grid, column };
}

/** The grid and the edge column's contract name of a table whose least width `edgeLeastWidth`
 *  answers (rule 4's sentence), else null. */
function edgeOf(contract: TemplateContract, item: TableItem, layout: CanvasLayout): { grid: string; column: string } | null {
  const edge = tableSpec(contract, item.key)?.gridEdgeColumn;
  if (edge === undefined || edgeLeastWidth(contract, item, layout) === null) return null;
  const grid = gridOf(layout, contract, item.key)!.key;
  const column = tableFields(contract, grid).find((f) => f.key === edge.column)?.name ?? edge.column;
  return { grid, column };
}

/** A steps table item's columns as the steps section `travelerStepsPrintedWidth` reads. */
function stepsSection(item: TableItem): SectionConfig {
  return {
    key: "steps", visible: true,
    fields: item.columns.map((c) => ({ key: c.key, visible: c.visible, label: c.label, width: c.width })),
  };
}

/**
 * A column table's printed width per copy at its own columns, whether it is a least width, and how
 * many copies print side by side. A column table (`printed` kind `ruled`, `boxed` or `nested`):
 * each shown column at its own width, else its contract default (a "*" column counts 0 and makes
 * the figure a least width, `flexible`), plus `tableOverhead` of the profile's layout kind over the
 * shown columns, to two decimals. A table printed in the steps layout: `travelerStepsPrintedWidth`
 * over the item's columns at `baseSize`, one copy. Null for a table the profile prints no columns
 * for (a list, a rows block: `printed` null) and for a table the profile does not place.
 */
export function canvasTablePrintedWidth(
  contract: TemplateContract, item: TableItem, baseSize: number,
): { printed: number; flexible: boolean; copies: number } | null {
  const printed = tableSpec(contract, item.key)?.printed ?? null;
  if (printed === null) return null;
  if (printed.kind === "steps") {
    const width = travelerStepsPrintedWidth([stepsSection(item)], baseSize);
    return { printed: width.printed, flexible: width.flexible, copies: 1 };
  }
  const { fixed, shown, stars } = shownColumns(contract, item);
  return { printed: round2(fixed + tableOverhead(printed.kind, shown)), flexible: stars.length > 0, copies: printed.copies };
}

/** The words a heading breaks into on paper: at each run of white space, but never before a closing
 *  mark pdfmake keeps on the word's line nor after an opening one (its line breaker follows UAX #14:
 *  LB13, no break before `,` `.` `:` `;` `!` `?` `)` `]` `}` or `/`, and LB14, none after `(` `[` or
 *  `{`, even across spaces), so "Information /" is one word. pdfmake also breaks after a dash or a
 *  "/" inside a word ("1–30", "and/or"), which this does not, so a word here is wider than
 *  pdfmake's there. Measured against pdfmake on every built-in heading (tests/canvas-keep-in-box.test.ts). */
function headingWords(text: string): string[] {
  // White space here is `\s` less U+00A0, U+2007 and U+202F: pdfmake never breaks at those (non-breaking).
  return text
    .split(/(?<![(\[{]|[^\S   ])[^\S   ]+(?=[^\s,.:;!?)\]}/]| | | |$)/)
    .map((word) => word.replace(/[^\S   ]+$/, ""))
    .filter((word) => word !== "");
}

/**
 * The width at which a column table's headings print whole, per copy (#971 design §7.2), and the
 * widest heading word it counts (`head`): its printed width per copy (`canvasTablePrintedWidth`:
 * the shown fixed widths and their padding and rules) plus each shown "*" column at `head`. `head`
 * is the widest word (`headingWords`) the header row prints over a shown "*" column: its label
 * (else its contract default; a blank label prints nothing) and any words the builder prints there
 * itself (`CanvasHead.words`), measured bold (`textWidthOf`) in `fonts`' family at the table's
 * heading size (`CanvasHead.size`, "base" read as `fonts`' base size); `fonts` absent, the
 * contract's. The "*" columns share what the fixed ones leave equally, so below this width each
 * gets less than its widest heading word, which breaks. The steps layout counts no word: its title
 * spans the position, code and instruction columns, locked in that order, so nothing prints over
 * the instruction alone (pdfmake spreads the title's word over the three, which print it whole):
 * its figure is its printed width and `head` 0. Null for a table that prints no columns.
 */
export function headingWholeWidth(
  contract: TemplateContract, item: TableItem, fonts?: FontsConfig,
): { perCopy: number; head: number } | null {
  const printed = tableSpec(contract, item.key)?.printed ?? null;
  if (printed === null) return null;
  const { family, baseSize } = fonts ?? contract.fonts;
  const width = canvasTablePrintedWidth(contract, item, baseSize)!;
  if (printed.kind === "steps") return { perCopy: width.printed, head: 0 };
  const size = printed.head.size === "base" ? baseSize : printed.head.size;
  const { stars } = shownColumns(contract, item);
  let head = 0;
  for (const star of stars) {
    const label = item.columns.find((c) => c.key === star.key)?.label ?? star.defaultLabel;
    for (const text of [label, printed.head.words?.[star.key] ?? ""]) {
      for (const word of headingWords(text)) head = Math.max(head, textWidthOf(word, family, "bold", size));
    }
  }
  return { perCopy: width.printed + stars.length * head, head };
}

/** A column table's shown columns: their count, the sum of the fixed ones' widths (own, else the
 *  contract default; unrounded) and the "*" ones' contract fields, in the contract's order. */
function shownColumns(
  contract: TemplateContract, item: Pick<TableItem, "key" | "columns">,
): { fixed: number; shown: number; stars: ContractField[] } {
  const byKey = new Map(item.columns.map((c) => [c.key, c]));
  let fixed = 0, shown = 0;
  const stars: ContractField[] = [];
  for (const field of tableFields(contract, item.key)) {
    const column = byKey.get(field.key);
    if (column === undefined || !column.visible || field.column === undefined) continue;
    shown++;
    const width = column.width ?? field.column.defaultWidth;
    if (width === "*") stars.push(field); else fixed += width;
  }
  return { fixed, shown, stars };
}

/** The layout's tables, top to bottom by their drawn `box.y`. */
export function tablesByY(layout: CanvasLayout): TableItem[] {
  return layout.items
    .filter((item): item is TableItem => item.kind === "table")
    .sort((a, b) => a.box.y - b.box.y);
}

/** An item's box in page coordinates. A below-table item whose table the layout does not hold (a
 *  layout the validator refuses, or one mid-edit) keeps its stored box. */
export function drawnBox(item: CanvasItem, layout: CanvasLayout): CanvasBox {
  if (item.kind === "table" || item.anchor.kind !== "below-table") return { ...item.box };
  const anchorTable = item.anchor.table;
  const table = layout.items.find((other): other is TableItem => other.kind === "table" && other.key === anchorTable);
  if (table === undefined) return { ...item.box };
  return { ...item.box, y: table.box.y + table.box.h + item.box.y };
}

/** The anchor the designer gives a box dropped at these page coordinates: below the nearest table
 *  whose drawn bottom is at or above the box's top, else page-top. Never page-bottom: that anchor
 *  is chosen in the inspector. */
export function inferAnchor(layout: CanvasLayout, box: CanvasBox): CanvasAnchor {
  let nearest: TableItem | null = null;
  for (const table of tablesByY(layout)) {
    const bottom = table.box.y + table.box.h;
    if (bottom <= box.y && (nearest === null || bottom > nearest.box.y + nearest.box.h)) nearest = table;
  }
  return nearest === null ? { kind: "page-top" } : { kind: "below-table", table: nearest.key };
}

/** The room the "Page N of M" line takes from every page when a template prints it: the
 *  traveler's bottom margin with the line on (`FOOTER_BOTTOM_MARGIN`, 44, in
 *  `src/server/traveler.ts`) less the plain 24 pt margin. Re-declared, not imported: `src/lib` may
 *  not import `src/server` (the `CONTENT_WIDTH` precedent in `template-contracts/types.ts`);
 *  `tests/template-canvas.test.ts` pins the two together. */
export const PAGE_LINE_ROOM = 20;

/** The page's foot: the lowest point anything on the canvas may reach, the usable bottom less the
 *  page line's room when the template prints the line. The band ends here, and with no band the
 *  band's top is here (one page-foot model: the room is counted once). */
export function pageFoot(pageFooter = false, page: CanvasPage = CANVAS_PAGE): number {
  return page.height - page.margin - (pageFooter ? PAGE_LINE_ROOM : 0);
}

/** The top of the page-bottom band: the page's foot when no item is anchored page-bottom, else the
 *  highest page-bottom item's top (the smallest y). A table's anchor is derived, never page-bottom. */
export function bandTop(layout: CanvasLayout, pageFooter = false, page: CanvasPage = CANVAS_PAGE): number {
  let top: number = pageFoot(pageFooter, page);
  let any = false;
  for (const item of layout.items) {
    if (item.kind === "table" || item.anchor.kind !== "page-bottom") continue;
    top = any ? Math.min(top, item.box.y) : item.box.y;
    any = true;
  }
  return top;
}

/** Whether the layout repeats anything on its continuation pages: a page-top item flagged `repeat`.
 *  A table's anchor is derived and it never repeats (the validator refuses one flagged); a repeated
 *  page-bottom item prints in the bottom band, and a repeated below-table item is refused. */
function repeatsAtTop(item: CanvasItem): boolean {
  return item.kind !== "table" && item.repeat && item.anchor.kind === "page-top";
}

/** The box "(continued)" prints in on a continuation page (design §4.5; Ruling 16, PR B of #926):
 *  the repeat band's bottom-left, at the left margin, `CONTINUED_WIDTH` wide and one
 *  `CONTINUED_LINE_HEIGHT` tall, its bottom level with the lowest repeated item's bottom (one grid
 *  step above the top margin). Null when no page-top item repeats: a page with no repeat band prints
 *  no "(continued)".
 *
 *  Why there, and not under an item: on today's paper (the seed) the order and load numbers sit
 *  directly above the barcode, so under a number is on the barcode, and the barcode sits 8 pt above
 *  the first table, so under the lowest item has no room for a 10 pt line. The band's bottom-left is
 *  where the flow prints the word (`continuationHeader`, `src/server/traveler.ts`), and it is empty
 *  on continuation pages because the header's left column does not repeat. A layout that puts a
 *  repeated item there is warned (`canvasWarnings`), never refused. The designer (PR C) draws its
 *  ghost from this box, so the editor and the paper agree on where the word goes. */
export function continuedBox(layout: CanvasLayout, page: CanvasPage = CANVAS_PAGE): CanvasBox | null {
  if (!layout.items.some(repeatsAtTop)) return null;
  return {
    x: page.margin, y: topMargin(layout, page) - CANVAS_GRID - CONTINUED_LINE_HEIGHT,
    w: CONTINUED_WIDTH, h: CONTINUED_LINE_HEIGHT,
  };
}

/** The fixed top margin of every page (design §4.5): the repeat band's height, the lowest repeated
 *  page-top item's drawn bottom plus one grid step, never under the page margin. The repeat band is
 *  the page-top band: a repeated page-bottom item prints in the bottom band and is not counted, a
 *  repeated below-table item is refused, and a table (whose anchor is derived) is never in it.
 *
 *  "(continued)" takes no room of its own (Ruling 16): its box ends where the lowest repeated item
 *  ends (`continuedBox`), so the band pdfmake lays the repeat header out in, exactly this margin tall,
 *  holds it whenever the band holds that item. */
export function topMargin(layout: CanvasLayout, page: CanvasPage = CANVAS_PAGE): number {
  let margin: number = page.margin;
  for (const item of layout.items) {
    if (!repeatsAtTop(item)) continue;
    const box = drawnBox(item, layout);
    margin = Math.max(margin, box.y + box.h + CANVAS_GRID);
  }
  return margin;
}

/** The band's height: from its top to the page's foot (0 with no page-bottom item). */
export function bandHeight(layout: CanvasLayout, pageFooter = false, page: CanvasPage = CANVAS_PAGE): number {
  return pageFoot(pageFooter, page) - bandTop(layout, pageFooter, page);
}

/** The page height a region may take: the band's top less the top margin. The page line's room is
 *  already under the band's top (design §6: the page less the top margin, the band and the line). */
export function usableHeight(layout: CanvasLayout, pageFooter = false, page: CanvasPage = CANVAS_PAGE): number {
  return bandTop(layout, pageFooter, page) - topMargin(layout, page);
}

/** The height of each region the tables open, top to bottom: from one table's drawn bottom to the
 *  next table's drawn top, and after the last table to the lowest drawn bottom of the items anchored
 *  below it, 0 when none (a float region holds the items anchored below the table above it: design
 *  §5.2). */
export function regionHeights(layout: CanvasLayout): { after: CanvasTableKey; height: number }[] {
  const tables = tablesByY(layout);
  return tables.map((table, i) => {
    const bottom = table.box.y + table.box.h;
    const next = tables[i + 1];
    if (next !== undefined) return { after: table.key, height: next.box.y - bottom };
    let lowest = bottom;
    for (const item of layout.items) {
      if (item.kind === "table" || item.anchor.kind !== "below-table" || item.anchor.table !== table.key) continue;
      const box = drawnBox(item, layout);
      lowest = Math.max(lowest, box.y + box.h);
    }
    return { after: table.key, height: lowest - bottom };
  });
}

/** The room the first table needs above the band: a heading and one row (the profile's). */
export function firstTableRoom(contract: TemplateContract): number {
  return canvasProfile(contract).firstTableRoom;
}

/** Where an item puts ink, from its stored box (pass a drawn box in for a below-table item). A
 *  filled item (a field, text, logo, barcode or table) inks its whole box. A line inks its stroke: a
 *  zero-thickness box is widened by its weight about its axis (`h: 0` across y, `w: 0` across x).
 *  The schema refuses a line with both sides drawn (`canvas.ts`); one reaching here unparsed (a
 *  layout mid-edit) inks its box. A box item is an outline: its four edges, each centred on the
 *  box's side and as thick as its weight, top, bottom, left, right. */
export function inkBoxes(item: CanvasItem): CanvasBox[] {
  const { x, y, w, h } = item.box;
  if (item.kind === "line") {
    const half = item.weight / 2;
    if (h === 0) return [{ x, y: y - half, w, h: item.weight }];
    if (w === 0) return [{ x: x - half, y, w: item.weight, h }];
    return [{ x, y, w, h }];
  }
  if (item.kind === "box") {
    const t = item.weight;
    const half = t / 2;
    return [
      { x: x - half, y: y - half, w: w + t, h: t },
      { x: x - half, y: y + h - half, w: w + t, h: t },
      { x: x - half, y: y - half, w: t, h: h + t },
      { x: x + w - half, y: y - half, w: t, h: h + t },
    ];
  }
  return [{ x, y, w, h }];
}

/** Whether two boxes share a positive area; touching edges do not. */
export function meets(a: CanvasBox, b: CanvasBox): boolean {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0;
}

/** Whether an item's ink, where it is drawn, meets a required element's box with positive area. */
function covers(item: CanvasItem, layout: CanvasLayout, required: CanvasBox): boolean {
  const drawn = { ...item, box: drawnBox(item, layout) } as CanvasItem;
  return inkBoxes(drawn).some((ink) => meets(ink, required));
}

/** A static item's name by its kind: the refusals' and the designer's (`itemTitle`). */
export const STATIC_NAMES = { logo: "Logo", barcode: "Barcode", text: "Text", line: "Line", box: "Box" } as const;

/** A table's name: a field-keyed block's field's contract name ("Consignee's ref/PO"); a
 *  section-keyed table's section name; the key when the contract has neither. Read by the refusals,
 *  the designer's `itemTitle` and the inspector's anchor list (through `itemTitle`). */
export function tableName(contract: TemplateContract, table: string): string {
  if (tableSpec(contract, table)?.keyed === "field") {
    const field = contract.sections.flatMap((section) => section.fields).find((f) => f.key === table);
    if (field !== undefined) return field.name;
  }
  return contract.sections.find((section) => section.key === table)?.name ?? table;
}

/** How a refusal names an item: a field by its contract name, a table by `tableName` (its field's
 *  or its section's name), a static item by its kind and id. */
function itemName(item: CanvasItem, contract: TemplateContract): string {
  if (item.kind === "field") {
    const field = contract.sections.flatMap((section) => section.fields).find((f) => f.key === item.key);
    return field === undefined ? `The field with the key "${item.key}" (field ${item.id})` : `The ${field.name} field`;
  }
  if (item.kind === "table") return `The ${tableName(contract, item.key)} table`;
  if (item.kind === "textBlock") {
    const block = contract.textBlocks.find((b) => b.key === item.key);
    return block === undefined
      ? `The wording with the key "${item.key}" (textBlock ${item.id})` : `The ${block.name} wording`;
  }
  return `The ${STATIC_NAMES[item.kind]} (${item.kind} ${item.id})`;
}

/** The same name inside a sentence: every name opens with "The". */
function itemNameInSentence(item: CanvasItem, contract: TemplateContract): string {
  return `the${itemName(item, contract).slice("The".length)}`;
}

/** The page's foot and the band's top, each with the words a sentence names it by. */
function pageLimits(layout: CanvasLayout, pageFooter: boolean, page: CanvasPage) {
  const foot = pageFoot(pageFooter, page);
  const footWords = pageFooter ? `${foot}, where the page line's room begins` : `${foot}`;
  const band = bandTop(layout, pageFooter, page);
  const bandWords = band < foot ? `${band}, the top of the page-bottom band` : footWords;
  return { foot, footWords, band, bandWords };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled required kind: ${JSON.stringify(value)}`);
}

/** The items the layout holds for the profile's required entries, in the profile's order: a
 *  barcode entry's barcodes, a table entry's tables of its key. Past rule 2 each entry holds
 *  exactly one; the warnings also judge a layout the rules refuse, where an entry may hold none or
 *  two. */
function requiredItems(profile: CanvasProfile, items: CanvasItem[]): CanvasItem[] {
  return profile.required.flatMap((required) => items.filter((item) => {
    switch (required.kind) {
      case "barcode": return item.kind === "barcode";
      case "table": return item.kind === "table" && item.key === required.key;
      // A field is held by rule 2 alone: rule 6 and warning (a)'s refused filter never see it.
      case "field": return false;
      default: return assertNever(required);
    }
  }));
}

/** The profile's paper word with its article: "an" before a leading vowel, else "a" ("a traveler",
 *  "an invoice"). The rule `withArticle` states in `template-editor.ts`, restated here because that
 *  module imports this one (a cycle); `tests/template-canvas.test.ts` holds the two together. */
function paperWithArticle(paper: string): string {
  return `${/^[aeiou]/i.test(paper) ? "an" : "a"} ${paper}`;
}

/** A field item's printed label, as the print's `labelOf` (src/server/pdf/canvas-sheet.ts) joins it, and
 *  the one the container tag's canvas builder joins (src/server/pdf/container-tag-canvas.ts), so the print
 *  joins exactly what rule 10 measures:
 *  its own, else its key's contract default. A blank label stays blank, so the value prints alone. */
export function printedLabel(contract: TemplateContract, item: Extract<CanvasItem, { kind: "field" }>): string {
  if (item.label !== null) return item.label;
  return contract.sections.flatMap((section) => section.fields).find((f) => f.key === item.key)?.defaultLabel ?? "";
}

/** `pageFooter`: whether the template prints the "Page N of M" line, whose room every page loses.
 *  `fonts`: the template's fonts, which the one-label rules measure with; absent, the contract's. */
export function validateCanvasLayout(
  layout: CanvasLayout, contract: TemplateContract,
  options: { pageFooter?: boolean; page?: CanvasPage; fonts?: FontsConfig } = {},
): void {
  const profile = canvasProfile(contract);
  const items = layout.items;
  const tables = items.filter((item): item is TableItem => item.kind === "table");
  const barcodes = items.filter((item) => item.kind === "barcode");
  const logos = items.filter((item) => item.kind === "logo");
  const fields = items.filter((item): item is Extract<CanvasItem, { kind: "field" }> => item.kind === "field");
  const textBlocks = items.filter((item): item is Extract<CanvasItem, { kind: "textBlock" }> => item.kind === "textBlock");

  // Rule 2: every id its own, the required items, and the items placed at most once. A measure
  // finds an item by its id, so two items under one id would share one measured box.
  const kindById = new Map<string, CanvasItem["kind"]>();
  for (const item of items) {
    const first = kindById.get(item.id);
    if (first !== undefined) {
      throw new TemplateConfigError(
        `Two items share the id "${item.id}": a ${first} and a ${item.kind}; every item has an id of its own.`,
        [item.id],
      );
    }
    kindById.set(item.id, item.kind);
  }
  // A barcode where the profile places none (the ticket's: nothing in its data encodes one), before
  // the required items.
  if (!profile.barcode && barcodes.length > 0) {
    throw new TemplateConfigError(
      `The canvas has a barcode; ${paperWithArticle(profile.paper)} prints none.`, [barcodes[0].id],
    );
  }
  // The profile's required items in its order; a barcode's "more than one" is asked with it.
  for (const required of profile.required) {
    switch (required.kind) {
      case "barcode":
        if (barcodes.length === 0) throw new TemplateConfigError(`The canvas has no barcode; ${required.reason}.`);
        if (barcodes.length > 1) {
          throw new TemplateConfigError(
            `The canvas has more than one barcode; ${paperWithArticle(profile.paper)} prints exactly one (spec §8).`,
            barcodes.map((item) => item.id),
          );
        }
        break;
      case "table":
        if (!tables.some((table) => table.key === required.key)) {
          throw new TemplateConfigError(
            `The canvas has no ${tableName(contract, required.key)} table; ${required.reason}.`,
          );
        }
        break;
      case "field":
        if (!fields.some((item) => item.key === required.key)) {
          const named = contract.sections.flatMap((section) => section.fields).find((f) => f.key === required.key);
          throw new TemplateConfigError(`The canvas has no ${named?.name ?? required.key}; ${required.reason}.`);
        }
        break;
      default: assertNever(required);
    }
  }
  const placed = new Set<CanvasTableKey>();
  for (const table of tables) {
    if (placed.has(table.key)) {
      throw new TemplateConfigError(
        `${itemName(table, contract)} is placed twice; a table prints once.`,
        tables.filter((other) => other.key === table.key).map((other) => other.id),
      );
    }
    placed.add(table.key);
  }
  if (logos.length > 1) {
    throw new TemplateConfigError(
      `${itemName(logos[1], contract)} is placed twice; the logo prints once.`, logos.map((item) => item.id),
    );
  }
  // A text block prints one of the contract's wordings (`config.textBlocks[key]`), once, and never
  // one a profile table prints itself (its spec's `textBlocks`, design 2026-11-09 §4.1 addition 4):
  // that wording is edited on the Wording tab and prints inside its block.
  const printedBy = new Map<string, CanvasTableSpec>();
  for (const spec of profile.tables) for (const key of spec.textBlocks ?? []) printedBy.set(key, spec);
  const worded = new Set<string>();
  for (const block of textBlocks) {
    if (!contract.textBlocks.some((b) => b.key === block.key)) {
      throw new TemplateConfigError(`${itemName(block, contract)} is not one the ${contract.name} contract has.`, [block.id]);
    }
    const inside = printedBy.get(block.key);
    if (inside !== undefined) {
      throw new TemplateConfigError(
        `${itemName(block, contract)} prints inside the ${tableName(contract, inside.key)} table; ` +
        "it is edited on the Wording tab, never placed on its own.",
        [block.id],
      );
    }
    if (worded.has(block.key)) {
      throw new TemplateConfigError(
        `${itemName(block, contract)} is placed twice; a text block prints once.`,
        textBlocks.filter((other) => other.key === block.key).map((other) => other.id),
      );
    }
    worded.add(block.key);
  }

  // Rule 1: fields the contract places, and each table's own columns, all of them.
  const fieldKeys = canvasFieldKeys(contract);
  for (const field of fields) {
    if (!fieldKeys.has(field.key)) {
      throw new TemplateConfigError(
        `${itemName(field, contract)} is not one the ${contract.name} contract places on a canvas.`, [field.id],
      );
    }
  }
  for (const table of tables) {
    // A table the contract's profile lacks is refused first, so its copied columns never are.
    if (!profile.tables.some((t) => t.key === table.key)) {
      throw new TemplateConfigError(
        `The table "${table.key}" is not one the ${contract.name} contract places on a canvas.`, [table.id],
      );
    }
    // A heading nothing prints is refused, not ignored: a stored value nothing honours is refused.
    if (table.heading !== null && tableHeadingKey(contract, table.key) === null) {
      throw new TemplateConfigError(
        `${itemName(table, contract)} has the heading "${table.heading}", but it prints no heading; ` +
        "only a table with a heading field takes one.",
        [table.id],
      );
    }
    const own = tableFields(contract, table.key);
    // A rows block's fields are its rows (the ticket's totals): named so, and never given a width.
    const spec = tableSpec(contract, table.key);
    const rows = spec?.rows === true;
    const [one, many] = rows ? ["row", "rows"] : ["column", "columns"];
    // An entry is named by its kind: a toggle (the bill of lading's Collect checkbox) as a toggle,
    // read from the key, so the "twice" sentence names it before it is looked up; every other key,
    // one the block does not hold included, by the table's own noun.
    const toggles = new Set(spec?.toggles ?? []);
    const noun = (key: string) => (toggles.has(key) ? "toggle" : one);
    const named = new Set<string>();
    for (const column of table.columns) {
      if (named.has(column.key)) {
        throw new TemplateConfigError(
          `${itemName(table, contract)} names the ${noun(column.key)} "${column.key}" twice.`, [table.id],
        );
      }
      named.add(column.key);
      const f = own.find((candidate) => candidate.key === column.key);
      if (f === undefined) {
        throw new TemplateConfigError(
          `${itemName(table, contract)} names a ${one} "${column.key}" that is not one of its ${many}.`, [table.id],
        );
      }
      if (rows && column.width !== null) {
        throw new TemplateConfigError(
          `${itemName(table, contract)}'s ${f.name} row carries a width (${column.width} pt); a row has no width.`, [table.id],
        );
      }
      // A toggle prints a mark, not a column: it takes no width.
      if (toggles.has(column.key) && column.width !== null) {
        throw new TemplateConfigError(
          `${itemName(table, contract)}'s ${f.name} toggle carries a width (${column.width} pt); a toggle has no width.`,
          [table.id],
        );
      }
    }
    for (const f of own) {
      if (!named.has(f.key)) {
        throw new TemplateConfigError(`${itemName(table, contract)} is missing its ${f.name} ${noun(f.key)}.`, [table.id]);
      }
    }
  }

  // Rule 3: anchors and the repeat set. A table never repeats; its anchor is derived, so the anchor
  // clauses read non-table items. One label (`oneLabel`, call 10) has no table to sit below, no band
  // and no second page: every item is placed from the label's top and none repeats, asked first, so a
  // below-table item is named by this sentence, not by the missing table's.
  const firstTable = tablesByY(layout)[0];
  const onePaper = paperWithArticle(profile.paper);
  const onePaperUpper = onePaper.charAt(0).toUpperCase() + onePaper.slice(1);
  for (const item of items) {
    if (item.kind === "table") {
      if (item.repeat) {
        throw new TemplateConfigError(
          `${itemName(item, contract)} is set to repeat on every page; a table prints once, where it is drawn.`, [item.id],
        );
      }
      continue;
    }
    if (profile.oneLabel !== undefined) {
      if (item.anchor.kind !== "page-top") {
        throw new TemplateConfigError(
          `${onePaperUpper} prints on one label; place every item from the label's top.`, [item.id],
        );
      }
      if (item.repeat) {
        throw new TemplateConfigError(`${onePaperUpper} prints on one label; nothing repeats.`, [item.id]);
      }
    }
    if (item.anchor.kind === "below-table") {
      const anchorTable = item.anchor.table;
      if (!placed.has(anchorTable)) {
        throw new TemplateConfigError(
          `${itemName(item, contract)} is anchored below the ${tableName(contract, anchorTable)} table, ` +
          "which the canvas does not place.",
          [item.id],
        );
      }
      if (item.repeat) {
        throw new TemplateConfigError(
          `${itemName(item, contract)} repeats on every page but is anchored below the ` +
          `${tableName(contract, anchorTable)} table; only an item at the page's top repeats.`,
          [item.id],
        );
      }
    }
    // The top margin is the repeat band's bottom plus one grid step (`topMargin`), and it must not
    // pass the first table's top, or the first page's spacer above that table would be negative
    // (Ruling 9). Judging each repeated item's own bottom judges the band: `topMargin` is the lowest
    // one's, and "(continued)" takes no room below it (Ruling 16, `continuedBox`). A canvas that
    // places no table (a ticket's may: it requires none) has no first table to pass.
    if (item.repeat && item.anchor.kind === "page-top" && firstTable !== undefined) {
      const box = drawnBox(item, layout);
      const bottom = box.y + box.h;
      if (bottom + CANVAS_GRID > firstTable.box.y) {
        throw new TemplateConfigError(
          `${itemName(item, contract)} repeats on every page but ends at ${figure(bottom)} pt, less than one grid ` +
          `step (${CANVAS_GRID} pt) above the first table's top at ${firstTable.box.y}; a repeated item sits above ` +
          "the tables (design §4.5).",
          [item.id, firstTable.id],
        );
      }
    }
  }

  // Rule 4: every box inside the usable area. A page-bottom item's `y ≥ bandTop` holds by bandTop's
  // own definition, so a page-bottom item drawn too high shows as a page-top item or table passing
  // the band's top.
  const page = options.page ?? CANVAS_PAGE;
  const left = page.margin;
  const right = page.width - page.margin;
  const top = page.margin;
  const pageFooter = options.pageFooter ?? false;
  // A page-bottom item ends by the page's foot; a page-top item or a table by the band's top, which
  // is the foot when no item is anchored page-bottom.
  const { foot, footWords, band, bandWords } = pageLimits(layout, pageFooter, page);
  for (const item of items) {
    const name = itemName(item, contract);
    const box = item.box;
    if (box.w < 0) throw new TemplateConfigError(`${name} has a negative width (${box.w} pt).`, [item.id]);
    if (box.h < 0) throw new TemplateConfigError(`${name} has a negative height (${box.h} pt).`, [item.id]);
    // A table's drawn box holds at least one row, or the covering and stacking rules could be
    // defeated by a shape the editor never draws.
    if (item.kind === "table" && box.h < profile.rowFloor) {
      throw new TemplateConfigError(
        `${name} is drawn ${box.h} pt tall; a table's box is at least ${profile.rowFloor} pt, one row.`,
        [item.id],
      );
    }
    // A field, a list and a rows block are at least as wide as their fixed parts and one grid step
    // (`leastWidth`: the profile's `leastWidths`, or a grid block's grid columns, #971 design §6.1);
    // a column table's width is rule 9's.
    const narrow = widthFloorSentence(contract, item, layout, options.fonts);
    if (narrow !== null) throw new TemplateConfigError(narrow, [item.id]);
    const outside = (edge: string): never => {
      throw new TemplateConfigError(`${name} lies outside the page: ${edge}.`, [item.id]);
    };
    if (box.x < left) outside(`its left edge is at ${box.x} pt, before ${left}`);
    if (box.x + box.w > right) outside(`its right edge is at ${figure(box.x + box.w)} pt, past ${right}`);
    if (item.kind !== "table" && item.anchor.kind === "below-table") {
      if (box.y < 0) {
        outside(`its offset below the ${tableName(contract, item.anchor.table)} table is ${box.y} pt, under 0`);
      }
    } else if (item.kind !== "table" && item.anchor.kind === "page-bottom") {
      if (box.y + box.h > foot) outside(`its bottom edge is at ${figure(box.y + box.h)} pt, past ${footWords}`);
    } else {
      if (box.y < top) outside(`its top edge is at ${box.y} pt, above ${top}`);
      if (box.y + box.h > band) outside(`its bottom edge is at ${figure(box.y + box.h)} pt, past ${bandWords}`);
    }
  }

  // Rule 10: one label (`oneLabel`; the container tag design of 2026-11-13 §7.2), measured in the
  // template's family through the client-safe metrics leaf the print's fit reads. A text item (a
  // field, a text or a text block) is at least one line of its text at its size and face (R12); a
  // line, a box and a logo print no text. The whole field, its printed label joined to `digits` of
  // its face's widest digit, fits the label's content width at its own size (R10, call 18): it may
  // run past its box, never past the label.
  if (profile.oneLabel !== undefined) {
    const family = (options.fonts ?? contract.fonts).family;
    const { key: wholeKey, digits } = profile.oneLabel.wholeField;
    for (const item of items) {
      if (item.kind !== "field" && item.kind !== "text" && item.kind !== "textBlock") continue;
      const face = item.style.bold ? "bold" : "normal";
      const line = lineHeightOf(family, face, item.style.size);
      if (item.box.h < line) {
        // The sentence names the least grid height at or above one line (the final review's I1): the
        // inspector snaps a typed height to the nearest grid step, so the raw line height, typed, can
        // snap back below it. Shown in inches rounded up to two decimals, which is within 0.72 pt of a
        // grid step and so snaps back to it. The rule's threshold stays the raw line.
        const gridHeight = Math.ceil(Math.round((line / CANVAS_GRID) * 1e6) / 1e6) * CANVAS_GRID;
        const inches = Math.ceil(Math.round((gridHeight / 72) * 1e6) / 1e4) / 100;
        throw new TemplateConfigError(
          `${itemName(item, contract)} is shorter than one line of its text; draw it at least ${inches.toFixed(2)} in tall.`,
          [item.id],
        );
      }
      if (item.kind === "field" && item.key === wholeKey) {
        const text = TAG_JOIN(printedLabel(contract, item), widestDigitOf(family, face).repeat(digits));
        if (textWidthOf(text, family, face, item.style.size) > right - left) {
          throw new TemplateConfigError(
            `${itemName(item, contract)} does not fit an order number of ${digits} digits within the label's width ` +
            "at this size and label; lower its size or shorten its label.",
            [item.id],
          );
        }
      }
    }
  }

  // Rule 5: the tables stack; none starts above the drawn bottom of the one before it.
  const stacked = tablesByY(layout);
  for (let i = 1; i < stacked.length; i++) {
    const prev = stacked[i - 1];
    const next = stacked[i];
    const prevBottom = prev.box.y + prev.box.h;
    if (next.box.y < prevBottom) {
      throw new TemplateConfigError(
        `${itemName(prev, contract)} and ${itemNameInSentence(next, contract)} overlap: ` +
        `${itemNameInSentence(next, contract)} starts at ${next.box.y} pt, above ` +
        `${itemNameInSentence(prev, contract)}'s bottom at ${figure(prevBottom)}.`,
        [prev.id, next.id],
      );
    }
  }

  // Rule 6: no ink is drawn over a required item (the traveler's: the barcode and the steps table;
  // touching an edge is not covering).
  for (const required of requiredItems(profile, items)) {
    const requiredBox = drawnBox(required, layout);
    for (const item of items) {
      if (item === required || !covers(item, layout, requiredBox)) continue;
      throw new TemplateConfigError(
        `${itemName(item, contract)} is drawn over ${itemNameInSentence(required, contract)}; ` +
        "nothing may cover a required element.",
        [item.id, required.id],
      );
    }
  }

  // Rule 7: the barcode's floor and its proportions, so a scanner can read it (when the layout holds
  // one: past rule 2 a profile that places none holds none).
  const barcode = barcodes[0];
  if (barcode !== undefined) {
    const code = barcode.box;
    if (code.w < BARCODE_MIN.width) {
      throw new TemplateConfigError(
        `${itemName(barcode, contract)} is ${code.w} pt wide; a barcode is at least ${BARCODE_MIN.width} pt wide ` +
        "so a scanner can read it.",
        [barcode.id],
      );
    }
    if (code.h < BARCODE_MIN.height) {
      throw new TemplateConfigError(
        `${itemName(barcode, contract)} is ${code.h} pt tall; a barcode is at least ${BARCODE_MIN.height} pt tall ` +
        "so a scanner can read it.",
        [barcode.id],
      );
    }
    if (Math.abs(code.w / code.h - BARCODE_MIN.width / BARCODE_MIN.height) > 0.02) {
      throw new TemplateConfigError(
        `${itemName(barcode, contract)} is ${code.w} × ${code.h} pt; a barcode keeps the ` +
        `${BARCODE_MIN.width} × ${BARCODE_MIN.height} proportions.`,
        [barcode.id],
      );
    }
  }

  // Rule 8: every region and the band fit on one page under its top margin, and the first table has
  // room for its heading and one row above the band.
  const usable = usableHeight(layout, pageFooter, page);
  const holds = pageFooter ? "under its top margin and the page line" : "under its top margin";
  for (const region of regionHeights(layout)) {
    if (region.height > usable) {
      throw new TemplateConfigError(
        `The region after the ${tableName(contract, region.after)} table is ${figure(region.height)} pt tall, ` +
        `more than the ${figure(usable)} pt a page holds ${holds}.`,
        tables.filter((table) => table.key === region.after).map((table) => table.id),
      );
    }
  }
  const bandSize = bandHeight(layout, pageFooter, page);
  if (bandSize > usable) {
    throw new TemplateConfigError(
      `The page-bottom band is ${figure(bandSize)} pt tall, more than the ${figure(usable)} pt a page holds ${holds}.`,
      // The band is the page-bottom items' (a table's anchor is derived, never page-bottom).
      items.filter((item) => item.kind !== "table" && item.anchor.kind === "page-bottom").map((item) => item.id),
    );
  }
  if (firstTable !== undefined && firstTable.box.y + profile.firstTableRoom > band) {
    throw new TemplateConfigError(
      `${itemName(firstTable, contract)} starts at ${firstTable.box.y} pt, too low for its heading and one row ` +
      `(${profile.firstTableRoom} pt) above ${band}.`,
      [firstTable.id],
    );
  }

  // Rule 9: no table hides a column its contract field locks (the steps table's typed step fields
  // and its handwriting boxes), and each table's visible columns fit its width, each time they print.
  for (const table of tables) {
    const own = tableFields(contract, table.key);
    // A toggle is named as a toggle, by rule 1's set; every other entry as a column.
    const toggles = new Set(tableSpec(contract, table.key)?.toggles ?? []);
    for (const column of table.columns) {
      const locked = own.find((f) => f.key === column.key)!;
      if (!column.visible && !locked.removable) {
        const noun = toggles.has(column.key) ? "toggle" : "column";
        throw new TemplateConfigError(
          `${itemName(table, contract)} hides its ${locked.name} ${noun}. ${locked.lockReason ?? "It cannot be hidden."}`,
          [table.id],
        );
      }
    }
    // A column table needs its least width (`leastWidth`, #971 design §6): its columns and their
    // padding and rules once per copy (twice side by side for the ticket's folded containers table),
    // what its block keeps beside them (the bill of lading's sidebar) and one grid step. Below it
    // its fixed columns alone would print past its box. A list or a rows block prints no columns:
    // rule 4 judges its width.
    const short = leastWidthSentence(contract, table, layout, options.fonts);
    if (short !== null) throw new TemplateConfigError(short, [table.id]);
  }
}

/**
 * What PR B's preview will report from the layout pass (design §5.3); hand-built in the tests.
 * Every figure is in points on its page, from the page's top-left corner, pages counted from 1. An
 * item is found by its `id`, a table by its `key`; neither carries a width, so a measured box is
 * `{ x: left (a table: its drawn x), y: top, w: the drawn box's width, h: height }`.
 */
export type CanvasMeasure = {
  pages: number;
  /** `squeezed`, present only when true: render.ts' column clamp laid the table's columns out narrower
   *  than pdfmake's own widths, so its words break inside their cells (#971). */
  tables: { key: CanvasTableKey; page: number; top: number; height: number; squeezed?: true }[];
  regions: { after: CanvasTableKey; page: number; top: number; height: number }[];
  /** `cut`: the value was cut at its box's edge; `past`: it ran past its box; `parts`: the part lines
   *  showed `shown` of `total` parts. Each optional and reported by the tag's builder alone. */
  items: {
    id: string; page: number; left: number; top: number; height: number;
    cut?: boolean; past?: boolean; parts?: { shown: number; total: number };
  }[];
};

export type CanvasWarning = { itemIds: string[]; sentence: string };

/** Two decimals: a sum of binary fractions must print as the figure it is. */
function figure(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A name's possessive: "column headers'" for a plural in s, "steps'"; "grid's" otherwise. */
function possessive(name: string): string {
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

/** Whether two boxes meet with an area a warning would print: their horizontal and vertical
 *  overlaps each more than 0 at `figure`'s two decimals (Ruling 21). A measured height a hair past
 *  a box snapped to the thousandth meets the box under it by less, and is not warned. The
 *  refusals keep `meets`, which counts any positive area. */
function meetsAsPrinted(a: CanvasBox, b: CanvasBox): boolean {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return figure(w) > 0 && figure(h) > 0;
}

/** The item kinds `itemName` can name. */
const ITEM_KINDS = new Set<string>(["field", "table", "textBlock", ...Object.keys(STATIC_NAMES)]);

/** The schema's first refusal of the layout (`canvasLayoutSchema`, the parse the server runs before
 *  the rules), as the designer shows it, or null when the schema reads it. An issue whose path is
 *  `items.<index>…` names that item (its id outlined, the item named as the rules name one, when it
 *  is read well enough to be named); any other names no item. The sentence carries the schema's own
 *  message (the line's "a line is horizontal (h 0) or vertical (w 0)"). */
function schemaRefusal(layout: unknown, contract: TemplateContract): TemplateConfigError | null {
  const parsed = canvasLayoutSchema.safeParse(layout);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  const message = issue.message.replace(/\.$/, "");
  const [at, index] = issue.path;
  const items = typeof layout === "object" && layout !== null ? (layout as { items?: unknown }).items : undefined;
  const element = at === "items" && typeof index === "number" && Array.isArray(items) ? items[index] : undefined;
  if (typeof element !== "object" || element === null) {
    return new TemplateConfigError(`The canvas is not one the editor can read: ${message}.`);
  }
  const { id, kind } = element as { id?: unknown; kind?: unknown };
  const ids = typeof id === "string" && id !== "" ? [id] : [];
  const name = typeof kind === "string" && ITEM_KINDS.has(kind)
    ? itemName(element as CanvasItem, contract)
    : `Item ${(index as number) + 1} of the canvas`;
  return new TemplateConfigError(`${name} is not drawn as the canvas allows: ${message}.`, ids);
}

/** The first refusal of the layout, as the designer shows it: the schema's (`schemaRefusal`, so
 *  the designer refuses whatever the server's parse refuses; ruling C31), else the first rule
 *  `validateCanvasLayout` refuses it on. The ids of the items its sentence names (outlined in red)
 *  and the sentence, which also closes the editor's Save (`canvasSaveBlock`). Null when the schema
 *  and the rules accept the layout. Only a refusal is caught: anything else thrown is a fault and is
 *  thrown on. */
export function canvasRefusal(
  layout: CanvasLayout, contract: TemplateContract,
  options: { pageFooter?: boolean; page?: CanvasPage; fonts?: FontsConfig } = {},
): CanvasWarning | null {
  const unread = schemaRefusal(layout, contract);
  if (unread !== null) return { itemIds: unread.itemIds, sentence: unread.message };
  try {
    validateCanvasLayout(layout, contract, options);
    return null;
  } catch (error) {
    if (error instanceof TemplateConfigError) return { itemIds: error.itemIds, sentence: error.message };
    throw error;
  }
}

/** Rule 4's width clause for one item (a field, a list or a rows block drawn narrower than its least
 *  width, `leastWidth`), its sentence, else null. `validateCanvasLayout` and `widthFloorRefusal` read it. */
function widthFloorSentence(
  contract: TemplateContract, item: CanvasItem, layout: CanvasLayout, fonts: FontsConfig | undefined,
): string | null {
  if (!(item.kind === "field" || (item.kind === "table" && (tableSpec(contract, item.key)?.printed ?? null) === null))) return null;
  const least = leastWidth(contract, item, { fonts, layout });
  const box = item.box;
  const name = itemName(item, contract);
  if (box.w >= least) return null;
  // The sentence names the floor that binds: the grid's columns (on a tie too), else the indent,
  // else the edge column.
  const gridFloor = item.kind === "table" ? gridLeastWidth(contract, item, layout) : null;
  const grid = gridFloor !== null && gridFloor >= least ? gridOf(layout, contract, item.key)!.key : null;
  const indent = item.kind === "table" && grid === null ? indentOf(contract, item, layout) : null;
  const edge = item.kind === "table" && grid === null && indent === null ? edgeOf(contract, item, layout) : null;
  return (
    grid !== null
      ? `${name} is ${figure(box.w)} pt wide, less than the ${figure(least)} pt the ` +
        `${possessive(tableName(contract, grid).toLowerCase())} columns, their gaps and one grid step need.`
      : indent !== null && gridFloor !== null
        ? `${name} is ${figure(box.w)} pt wide, less than the ${figure(least)} pt the text it prints past the ` +
          `${possessive(tableName(contract, indent.grid).toLowerCase())} ${indent.column.toLowerCase()} ` +
          `and one grid step need.`
        : indent !== null
          ? `${name} is ${figure(box.w)} pt wide, less than the ${figure(least)} pt its indent past the ` +
            `${possessive(tableName(contract, indent.grid).toLowerCase())} ${indent.column.toLowerCase()}, ` +
            `its fields and one grid step need.`
          : edge !== null
            ? `${name} is ${figure(box.w)} pt wide, less than the ${figure(least)} pt the ` +
              `${possessive(tableName(contract, edge.grid).toLowerCase())} ${edge.column.toLowerCase()} at its edge, ` +
              `its fixed parts beside it and one grid step need.`
            : `${name} is ${figure(box.w)} pt wide, less than the ${figure(least)} pt its fixed parts and one grid step need.`
  );
}

/** Rule 9's width clause for one column table (drawn narrower than its least width, `leastWidth`),
 *  its sentence, else null (a list or a rows block: rule 4's). `validateCanvasLayout` and
 *  `widthFloorRefusal` read it. */
function leastWidthSentence(
  contract: TemplateContract, table: TableItem, layout: CanvasLayout, fonts: FontsConfig | undefined,
): string | null {
  const parts = columnTableParts(contract, table, (fonts ?? contract.fonts).baseSize);
  if (parts === null) return null;
  const least = leastWidth(contract, table, { fonts, layout });
  if (!(least > table.box.w)) return null;
  const head = `${itemName(table, contract)} needs ${figure(least)} pt: its visible columns' ${figure(parts.fixed)} pt`;
  const room = `more than its ${figure(table.box.w)} pt.`;
  return parts.copies === 2
    ? `${head} and their ${figure(parts.overhead)} pt of padding and rules, printed twice, and one grid step, ${room}`
    : parts.beside > 0
      ? `${head}, their ${figure(parts.overhead)} pt of padding and rules, the ${figure(parts.beside)} pt it keeps ` +
        `beside them and one grid step, ${room}`
      : `${head}, their ${figure(parts.overhead)} pt of padding and rules and one grid step, ${room}`;
}

/**
 * The first width-floor refusal of `layout`, in the validator's own order and sentence, else null: rule
 * 4's width clause over every item, then rule 9's least width over every column table, and nothing else
 * of the rules (#991 review I2, the controller's ruling of 2026-11-17). The four seeds that validate their
 * layout (certification, invoice, statement, quote) ask it over their blocks at the content width BEFORE
 * they lay the stand-in out, so a template whose columns leave the page no room for a block is refused in
 * rule 9's or rule 4's sentence, never in the one-page sentence the column clamp's squeezed stand-in
 * would reach first.
 */
export function widthFloorRefusal(
  layout: CanvasLayout, contract: TemplateContract, options: { fonts?: FontsConfig } = {},
): CanvasWarning | null {
  for (const item of layout.items) {
    const sentence = widthFloorSentence(contract, item, layout, options.fonts);
    if (sentence !== null) return { itemIds: [item.id], sentence };
  }
  for (const item of layout.items) {
    if (item.kind !== "table") continue;
    const sentence = leastWidthSentence(contract, item, layout, options.fonts);
    if (sentence !== null) return { itemIds: [item.id], sentence };
  }
  return null;
}

/**
 * `canvasRefusal`'s answer when it refuses an item drawn narrower than its least width (`leastWidth`,
 * at `fonts`' base size and over `layout`: rule 4's floor or rule 9's), else null: a layout refused
 * for anything else, or not refused, answers null. The four seeds that validate their layout
 * (certification, invoice, statement, quote) answer this one as a 400 in its own sentence (#971
 * design §6, "Where the raised floors are met"): a template whose columns leave the page no room for
 * a block is the template's to change, where every other refusal there is the seed's own fault.
 */
export function floorRefusal(
  layout: CanvasLayout, contract: TemplateContract,
  options: { pageFooter?: boolean; page?: CanvasPage; fonts?: FontsConfig } = {},
): CanvasWarning | null {
  const refusal = canvasRefusal(layout, contract, options);
  if (refusal === null) return null;
  const item = layout.items.find((i) => i.id === refusal.itemIds[0]);
  if (item === undefined || item.box.w >= leastWidth(contract, item, { fonts: options.fonts, layout })) return null;
  return refusal;
}

/**
 * The canvas warnings: drawn in amber, never refused (design §6, ruling 6). In order:
 *
 * (a) two items whose ink meets with an area that prints, each overlap more than 0 at two decimals
 *     (`meetsAsPrinted`; `inkBoxes`, so a frame drawn clear around a field does not overlap it),
 *     judged on the measured boxes when the measure holds both items
 *     (and only on one page) and on the drawn boxes otherwise. Measured against a page-bottom item,
 *     a table or page-top item whose measured bottom passes the band's top is judged only down to
 *     it: its height is a flow extent over every page it prints on, and the sheet reserves the band
 *     in its bottom margin, so it breaks above the band on each. A warning never repeats a refusal: a
 *     pair whose drawn ink the covering rule refuses (an item over the barcode or the steps table)
 *     and two tables (the stacking rule's) are left out. An item over another table is warned.
 * (b) with a measure, an item that measures taller than its drawn box.
 * (c) an item whose bottom passes the page: the measured bottom when the measure holds the item,
 *     the drawn bottom otherwise. A page-top or below-table item ends by the band's top, a
 *     page-bottom item by the page's foot (the validator's one page-foot model, `pageFooter`
 *     included). A page-top item past it "would add a page"; an item anchored below a table, inside
 *     an unbreakable float region, and a page-bottom item, printed in the footer frame that drops
 *     its overflow, "would be cut off" (design §4.3, §5.2; the 2026-11-08 design §6).
 * (d) a column table whose headings break (#971 design §7.2): render.ts' column clamp gives the
 *     shown "*" columns equal shares of what the fixed columns and their padding and rules leave, so
 *     below `headingWholeWidth`'s figure (each "*" column at the widest heading word printed over
 *     one, at the template's fonts when `fonts` is given, else the contract's) a heading word is
 *     wider than its share and breaks. Judged as `round2(perCopy × copies) > W − beside`, and only
 *     where a "*" column is shown and some heading word prints over one (`head` above 0; never on
 *     the steps layout, whose title spans the instruction): with none, no heading breaks in a share
 *     and rule 9 alone refuses a box under the fixed parts. The sentence names the shares
 *     (`sharedWidthWords`, 0 in a box under the fixed parts, which rule 9 refuses), the widest
 *     heading word's width and the width from which the headings print whole: per copy and in all
 *     for a table printed twice, beside what its block keeps (`beside`, the bill of lading's
 *     sidebar) for one that keeps points beside its columns. A list and a rows block print no
 *     columns and are never judged. Body words are the record's: (i) states them.
 * (f) retired (owner ruling R-C, 2026-11-17, #991): it said a folded table's shared column under the
 *     39 pt line "has no room", which is untrue since #971 keeps every canvas table inside its box;
 *     (d) says when its headings break.
 * (e) a repeated page-top item whose ink, where it is drawn, meets the "(continued)" box
 *     (`continuedBox`, the repeat band's bottom-left; Ruling 16). Only a repeated item prints on a
 *     continuation page, so an item that does not repeat is never judged.
 * (g) a rows block that prints under a grid (`gridOf`; design 2026-11-10 §6) drawn out of line with
 *     the grid's placed item, each edge judged by its difference from the grid's, counted only when
 *     it rounds above 0 at `figure`'s two decimals (as (a) and (b) judge depth), and by what the
 *     block reads of the grid: its left edge (`gridEdge` "left", the invoice's order strip), its
 *     right edge ("right", the totals), or, with no grid edge, its left edge, and its width too
 *     while the grid's item shows a flexible column (a shown column whose width, stored or the
 *     contract's, is "*": it resolves against the block's own drawn width). With none shown, every
 *     shown column prints at its own width from the block's left edge, so its width is not judged
 *     against the grid's (the controller's narrowing of design §6, which assumed the Information
 *     column's "*"). A block drawn narrower than those columns and its `gridGap` between each two is
 *     rule 4's to refuse (`gridLeastWidth`, #971 design §6.1): the clause that warned of it here
 *     fired only on such a refused layout and is retired (#971 Task 6), as a warning never repeats a
 *     refusal. A grid not placed is never judged, and a block whose spec names no grid (every built
 *     document's) never is.
 * (h) with a measure, what the measure says about an item's value: cut at its box's edge, run past
 *     it, or part lines showing fewer parts than the record holds (the container tag's).
 * (i) with a measure, a table the measure holds `squeezed` (render.ts' column clamp laid its columns
 *     out narrower than pdfmake's own widths for the picked record, so words it prints for it break
 *     inside their cells; #971 design §7.3, ruling 4's "the designer warns"), unless (d) has
 *     warned of it. It reads the first sheet group of the picked record, as every measured warning
 *     does.
 */
export function canvasWarnings(
  layout: CanvasLayout, contract: TemplateContract, measure?: CanvasMeasure,
  options: { pageFooter?: boolean; page?: CanvasPage; fonts?: FontsConfig } = {},
): CanvasWarning[] {
  // A contract with no profile offers no canvas (the registry refuses its layout): nothing to warn of.
  if (contract.canvas === undefined) return [];
  const items = layout.items;
  const warnings: CanvasWarning[] = [];
  const pageFooter = options.pageFooter ?? false;
  const page = options.page ?? CANVAS_PAGE;

  /** The item's measured box and page, or null when the measure does not hold it. */
  const measuredOf = (item: CanvasItem): { page: number; box: CanvasBox } | null => {
    if (measure === undefined) return null;
    const drawn = drawnBox(item, layout);
    if (item.kind === "table") {
      const m = measure.tables.find((t) => t.key === item.key);
      return m === undefined ? null : { page: m.page, box: { x: drawn.x, y: m.top, w: drawn.w, h: m.height } };
    }
    const m = measure.items.find((i) => i.id === item.id);
    return m === undefined ? null : { page: m.page, box: { x: m.left, y: m.top, w: drawn.w, h: m.height } };
  };
  const inkAt = (item: CanvasItem, box: CanvasBox) => inkBoxes({ ...item, box } as CanvasItem);

  // (a) Overlaps.
  const band = bandTop(layout, pageFooter, page);
  const inBand = (item: CanvasItem) => item.kind !== "table" && item.anchor.kind === "page-bottom";
  /** The measured ink of an item judged against a band item. A table or a page-top item flows:
   *  its measured height is the extent over every page it prints on (`canvasMeasure`), while on paper
   *  it breaks above the band on each, which the sheet reserves in its bottom margin. So its ink past
   *  the band's top is cut off there; one whose measured bottom does not pass the band is judged
   *  whole. A below-table item rides its unbreakable region on one page, where a line past its
   *  region prints on through the band, and a band item prints in the band: neither is cut. */
  const inkAgainstBand = (item: CanvasItem, box: CanvasBox): CanvasBox[] => {
    const ink = inkAt(item, box);
    const flows = item.kind === "table" || item.anchor.kind === "page-top";
    if (!flows || figure(box.y + box.h) <= band) return ink;
    return ink.map((x) => (x.y + x.h > band ? { ...x, h: band - x.y } : x));
  };
  const required = requiredItems(contract.canvas, items);
  const refused = (a: CanvasItem, b: CanvasItem) =>
    (required.includes(a) && covers(b, layout, drawnBox(a, layout))) ||
    (required.includes(b) && covers(a, layout, drawnBox(b, layout)));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if ((a.kind === "table" && b.kind === "table") || refused(a, b)) continue;
      const ma = measuredOf(a);
      const mb = measuredOf(b);
      let inkA: CanvasBox[];
      let inkB: CanvasBox[];
      if (ma !== null && mb !== null) {
        // Two items measured on different pages never meet, unless one repeats: a repeated item prints
        // on every page (the band's on the last page too, where a last-page item is measured), so it is
        // judged against whatever shares any page with it; a table or page-top item judged against a
        // band item only down to the band's top (`inkAgainstBand`).
        if (ma.page !== mb.page && !a.repeat && !b.repeat) continue;
        inkA = inBand(b) ? inkAgainstBand(a, ma.box) : inkAt(a, ma.box);
        inkB = inBand(a) ? inkAgainstBand(b, mb.box) : inkAt(b, mb.box);
      } else {
        inkA = inkAt(a, drawnBox(a, layout));
        inkB = inkAt(b, drawnBox(b, layout));
      }
      if (inkA.some((x) => inkB.some((y) => meetsAsPrinted(x, y)))) {
        warnings.push({
          itemIds: [a.id, b.id],
          sentence: `${itemName(a, contract)} and ${itemNameInSentence(b, contract)} overlap; one prints over the other.`,
        });
      }
    }
  }

  // (b) Taller than drawn.
  for (const item of items) {
    if (item.kind === "table") continue;
    const m = measuredOf(item);
    // Only a difference the sentence prints as more than 0 pt is warned.
    if (m === null || figure(m.box.h - item.box.h) <= 0) continue;
    warnings.push({
      itemIds: [item.id],
      sentence: `${itemName(item, contract)} is taller than its box by ${figure(m.box.h - item.box.h)} pt and prints over ` +
        "what is drawn under it.",
    });
  }

  // (c) Past the page.
  const { foot, footWords, bandWords } = pageLimits(layout, pageFooter, page);
  for (const item of items) {
    if (item.kind === "table") continue;
    const box = measuredOf(item)?.box ?? drawnBox(item, layout);
    const bottom = figure(box.y + box.h);
    const [limit, limitWords] = item.anchor.kind === "page-bottom" ? [foot, footWords] : [band, bandWords];
    if (bottom <= limit) continue;
    // A page-top item flows: past the band it pushes onto a new page. A below-table item rides an
    // unbreakable region and a page-bottom item the footer frame: past their limit they are cut.
    const outcome = item.anchor.kind === "page-top" ? "would add a page" : "would be cut off";
    warnings.push({ itemIds: [item.id], sentence: `${itemName(item, contract)} ends at ${bottom} pt, past ${limitWords}, and ${outcome}.` });
  }

  // (d) Each column table's headings. ((f), the folded table's 39 pt line, is retired: R-C.)
  const baseSize = options.fonts?.baseSize ?? contract.fonts.baseSize;
  /** The tables (d) warned of: (i) does not say them again. */
  const headingsWarned = new Set<string>();
  for (const item of items) {
    if (item.kind !== "table") continue;
    const width = canvasTablePrintedWidth(contract, item, baseSize);
    const whole = headingWholeWidth(contract, item, options.fonts);
    if (width === null || whole === null) continue;
    const name = itemName(item, contract);
    // The points the block keeps beside its columns (the bill of lading's sidebar) are not theirs.
    const beside = besideOf(contract, item.key);
    const stars = tableSpec(contract, item.key)!.printed!.kind === "steps" ? [] : shownColumns(contract, item).stars;
    if (stars.length > 0 && whole.head > 0 && round2(whole.perCopy * width.copies) > item.box.w - beside) {
      // What each "*" column gets, as the clamp shares it: the box less what it keeps beside, per
      // copy, less the fixed widths and their padding and rules, shared equally; 0 in a box below
      // those (rule 9 refuses it).
      const share = Math.max(0, ((item.box.w - beside) / width.copies - width.printed) / stars.length);
      const gets = sharedWidthWords(stars.map((f) => f.name), share);
      const under = `under the ${figure(whole.head)} pt its widest heading word needs, so its heading words break`;
      const sentence = width.copies === 2
        ? `${name} prints its columns twice: ${gets} per copy, ${under}; its headings print whole from ` +
          `${figure(whole.perCopy)} pt each copy, ${figure(whole.perCopy * 2)} pt in all.`
        : beside > 0
          ? `${name}: ${gets}, ${under}; its headings print whole from a ${figure(whole.perCopy + beside)} pt box ` +
            `(${figure(whole.perCopy)} pt beside the ${beside} pt it keeps).`
          : `${name}: ${gets}, ${under}; its headings print whole from ${figure(whole.perCopy)} pt wide.`;
      warnings.push({ itemIds: [item.id], sentence });
      headingsWarned.add(item.id);
    }
  }

  // (e) A repeated item where "(continued)" prints.
  const continued = continuedBox(layout, page);
  if (continued !== null) {
    for (const item of items) {
      if (!repeatsAtTop(item) || !covers(item, layout, continued)) continue;
      warnings.push({
        itemIds: [item.id],
        sentence: `${itemName(item, contract)} repeats where "(continued)" prints on continuation pages, at the repeat ` +
          "band's bottom-left; the two print over each other.",
      });
    }
  }

  // (g) A grid block out of line with its grid.
  for (const block of items) {
    if (block.kind !== "table") continue;
    const spec = tableSpec(contract, block.key);
    if (spec?.grid === undefined) continue;
    const grid = gridOf(layout, contract, block.key);
    if (grid === null || grid.item === null) continue;
    const name = itemName(block, contract);
    const gridName = tableName(contract, grid.key);
    const at = block.box;
    const under = grid.item.box;
    const edge = spec.gridEdge;
    // Two edges a few thousandths apart are in line, though they round to either side of a cent.
    const apart = (a: number, b: number) => figure(Math.abs(a - b)) > 0;
    // The width is judged only while the grid shows a "*" column, which resolves against the block's
    // own drawn width; with none, every shown column prints at its own width from the left edge, and
    // rule 4 refuses a block narrower than those widths and its gaps (`gridLeastWidth`).
    const flexible = shownColumns(contract, grid.item).stars.length > 0;
    let sentence: string | null = null;
    if (edge === "left") {
      if (apart(at.x, under.x)) {
        sentence = `${name} prints from the ${gridName} table's left edge, but is drawn at another left edge, so it does ` +
          "not line up under its columns.";
      }
    } else if (edge === "right") {
      if (apart(at.x + at.w, under.x + under.w)) {
        sentence = `${name} prints to the ${gridName} table's right edge, but is drawn at another right edge, so it does ` +
          "not line up under its columns.";
      }
    } else if (apart(at.x, under.x) || (flexible && apart(at.w, under.w))) {
      sentence = `${name} prints under the ${gridName} table's columns, but is drawn at another left edge or width, so ` +
        "its columns do not line up under them.";
    }
    if (sentence !== null) warnings.push({ itemIds: [block.id], sentence });
  }

  // (h) What the measure says about a value: cut at its box's edge, run past it, or part lines
  // that showed fewer parts than the record holds. Only an item the measure holds is judged.
  if (measure !== undefined) {
    for (const item of items) {
      const m = measure.items.find((i) => i.id === item.id);
      if (m === undefined) continue;
      const name = itemName(item, contract);
      if (m.cut === true) {
        warnings.push({ itemIds: [item.id], sentence: `${name} is cut at its box's edge for this record.` });
      }
      if (m.past === true) {
        warnings.push({ itemIds: [item.id], sentence: `${name} runs past its box for this record.` });
      }
      if (m.parts !== undefined && m.parts.shown < m.parts.total) {
        warnings.push({
          itemIds: [item.id],
          sentence: `${name} shows ${m.parts.shown} of ${m.parts.total} parts for this record.`,
        });
      }
    }
  }

  // (i) This record's words break: the measure's `squeezed`, for a table (d) has not warned of.
  if (measure !== undefined) {
    for (const item of items) {
      if (item.kind !== "table" || headingsWarned.has(item.id)) continue;
      if (measure.tables.find((t) => t.key === item.key)?.squeezed !== true) continue;
      warnings.push({
        itemIds: [item.id],
        sentence: `${itemName(item, contract)}'s columns are narrower than words it prints for this record, so they break inside their cells.`,
      });
    }
  }

  return warnings;
}
