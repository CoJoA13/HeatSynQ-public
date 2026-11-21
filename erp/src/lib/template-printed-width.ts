/**
 * How wide each template table prints on paper (#457).
 *
 * The width budget (`tableBudgets` in template-editor.ts, the contracts' `assertWidthBudgets`) sums
 * the declared column widths. The PDF layout adds cell padding and rules to them, so a table
 * within its budget can still print past it. This leaf states, for every column table of every
 * contract, the layout its builder prints it with and what that layout adds, and since #991 the width at
 * which its headings print whole (`tableHeadingWidth`).
 *
 * It also states the shipping ticket's shared-width rule (#519): what each column that shares
 * the container table's spare width gets, computed from that table's printed width. The 39 pt line and
 * its measured-conditions test are retired on both layouts (owner rulings R-A and R-C, 2026-11-17, #991).
 *
 * CLIENT-SAFE: it imports only the template contracts (`./template-contracts/...`), by relative
 * path, and never `src/server/**`, which would drag Prisma into a client component's bundle. The
 * layouts themselves are server code (render.ts `TABLE_LAYOUTS`), so their padding and rule widths
 * are restated here. tests/template-printed-width-render.test.ts holds the two equal, checks that
 * each builder prints each table with the layout named below, and renders every table but the
 * traveler's steps at its exact fit and one point over; the steps table is rendered against its
 * figure in tests/process-traveler-layout.test.ts.
 */
import {
  CONTENT_WIDTH,
  type TemplateConfig,
  type TemplateContract,
} from "./template-contracts/types";
import { travelerStepsPrintedWidth } from "./template-contracts/traveler";
import { contractFor } from "./template-contracts/index";
import { headingWholeWidth } from "./template-canvas";
import { COLUMN_TABLE_LAYOUTS, round2, tableOverhead } from "./printed-width-core";

// The arithmetic lives in a registry-free leaf (the canvas rules read it); every name stays
// importable from here.
export {
  COLUMN_TABLE_LAYOUTS, MIN_SHARED_WIDTH_PT, TABLE_LAYOUT_METRICS, pt, sharedWidthWords, tableOverhead,
} from "./printed-width-core";
export type { ColumnTableLayout, TableLayoutKind } from "./printed-width-core";

export type TablePrintedWidth = {
  /** The sum of the shown columns' numeric widths: the figure the width budget checks. */
  declared: number;
  /** The cell padding and rules the layout adds. */
  overhead: number;
  /** `declared + overhead`. A minimum when `flexible`. */
  printed: number;
  /** A shown column is "*", a flex default with no typed width: it fills the remaining width, and
   *  its own width is not counted in `declared`. */
  flexible: boolean;
  /** The width the table has: the contract's `tableBudgets` entry, or the content width. */
  budget: number;
  /** How many times the columns print side by side. `declared`, `overhead`, `printed` and `budget`
   *  are one copy's. */
  copies: number;
};

/** `tableHeadingWidth`'s answer (#991). */
export type TableHeadingWidth = {
  /** The widest word the header row prints over a shown "*" column, bold in the config's family at the
   *  table's heading size (the canvas's `headingWholeWidth`, one rule for both layouts): 0 with no "*"
   *  column shown, a blank label, or the steps table, whose title spans its instruction. */
  head: number;
  /** One copy's width at which every heading prints whole: `tablePrintedWidth`'s `printed` plus each
   *  shown "*" column at `head`. render.ts' column clamp keeps a flow table inside its width, so below
   *  this its "*" columns' heading words break inside their cells. `printed` itself when `head` is 0. */
  headingWhole: number;
  /** The shown "*" columns, by the editor's names, in the contract's order. */
  shared: string[];
};

/**
 * The width `table` prints at under `config`, or null when it prints no columns: the contract has
 * no such table, its section is hidden or absent, or no column of it is shown. Columns are counted
 * as `tableBudgets` counts them: the shown columns of a shown section, each at its typed width or
 * the contract's default. The traveler's steps table is `travelerStepsPrintedWidth`'s figure.
 */
export function tablePrintedWidth(
  contract: TemplateContract, config: TemplateConfig, table: string,
): TablePrintedWidth | null {
  const holding = contract.sections.filter((cs) => cs.fields.some((cf) => cf.column?.table === table));
  if (holding.length === 0) return null;
  const layout = COLUMN_TABLE_LAYOUTS[contract.docType][table];
  if (layout === undefined) {
    throw new Error(`No printed-width layout is named for ${contract.docType} table "${table}"`);
  }
  const budget = contract.tableBudgets?.[table] ?? CONTENT_WIDTH;
  if (layout.kind === "steps") {
    return { ...travelerStepsPrintedWidth(config.sections, config.fonts.baseSize), budget, copies: layout.copies };
  }
  let columns = 0, declared = 0, flexible = false;
  for (const cs of holding) {
    const s = config.sections.find((candidate) => candidate.key === cs.key);
    if (s === undefined || !s.visible) continue;
    for (const f of s.fields) {
      const column = cs.fields.find((cf) => cf.key === f.key)?.column;
      if (column?.table !== table || !f.visible) continue;
      columns++;
      const width = f.width ?? column.defaultWidth;
      if (width === "*") flexible = true; else declared += width;
    }
  }
  if (columns === 0) return null;
  const overhead = tableOverhead(layout.kind, columns);
  return {
    declared: round2(declared), overhead, printed: round2(declared + overhead), flexible, budget, copies: layout.copies,
  };
}

/**
 * How wide `table` prints with its headings whole under `config` (#991, owner ruling 2026-11-15:
 * each "*" column counted at its widest heading word), or null when it prints no columns
 * (`tablePrintedWidth`'s null). One rule for both layouts: the canvas's `headingWholeWidth`, handed the
 * flow config's columns as a canvas item lists them, under the canvas table spec that prints the same
 * columns (the invoice's and the quote's `column_header` print the contract table "columns"). The
 * steps table counts no heading word (its title spans its instruction column).
 */
export function tableHeadingWidth(
  contract: TemplateContract, config: TemplateConfig, table: string,
): TableHeadingWidth | null {
  const width = tablePrintedWidth(contract, config, table);
  if (width === null) return null;
  if (COLUMN_TABLE_LAYOUTS[contract.docType][table].kind === "steps") {
    return { head: 0, headingWhole: width.printed, shared: [] };
  }
  const holding = contract.sections.filter((cs) => cs.fields.some((cf) => cf.column?.table === table));
  const listed: { key: string; visible: boolean; label: string | null; width: number | "*" | null }[] = [];
  const shared: string[] = [];
  for (const cs of holding) {
    const s = config.sections.find((candidate) => candidate.key === cs.key);
    if (s === undefined || !s.visible) continue;
    // The contract's order, as the canvas names a share's columns.
    for (const field of cs.fields) {
      const entry = s.fields.find((f) => f.key === field.key);
      if (field.column?.table !== table || entry === undefined) continue;
      listed.push({ key: entry.key, visible: entry.visible, label: entry.label, width: entry.width });
      if (entry.visible && (entry.width ?? field.column.defaultWidth) === "*") shared.push(field.name);
    }
  }
  const spec = contract.canvas?.tables.find((t) => (t.columnTable ?? t.key) === table && t.printed !== null);
  if (spec === undefined) throw new Error(`No canvas table spec prints ${contract.docType} table "${table}"`);
  const whole = headingWholeWidth(contract, { key: spec.key, columns: listed } as Parameters<typeof headingWholeWidth>[1], config.fonts);
  const head = whole?.head ?? 0;
  return { head: round2(head), headingWhole: round2(whole?.perCopy ?? width.printed), shared };
}

/** The two shipping tickets, whose container table shares its spare width. */
export type TicketDocType = "SHIPPER" | "MOS_SHIPPER";

/** `sharedContainerWidth`'s answer. */
function containerTable(
  docType: TicketDocType, config: TemplateConfig,
): { shared: string[]; each: number | null; fixedAndPadding: number } | null {
  const stored = config.sections.find((s) => s.key === "containers");
  if (stored === undefined) throw new Error(`A complete config has no "containers" section`);
  if (!stored.visible) return null;
  const contract = contractFor(docType);
  const entries = new Map(stored.fields.map((f) => [f.key, f]));
  const shared: string[] = [];
  // The shown columns and the sum of the fixed ones' widths, counted as `tablePrintedWidth` counts
  // them but not rounded: a width typed with three decimals keeps them.
  let shown = 0, fixed = 0;
  // The contract's order, so two shared columns are always named the same way round.
  for (const field of contract.sections.find((s) => s.key === "containers")!.fields) {
    const entry = entries.get(field.key);
    if (field.column === undefined || entry === undefined || !entry.visible) continue;
    shown++;
    const width = entry.width ?? field.column.defaultWidth;
    if (width !== "*") {
      fixed += width;
      continue;
    }
    shared.push(field.name);
  }
  const layout = COLUMN_TABLE_LAYOUTS[docType].containers;
  if (layout.kind === "steps") throw new Error("The ticket's container table cannot have the steps table's layout");
  const budget = contract.tableBudgets?.containers ?? CONTENT_WIDTH;
  // One copy's printed width, as `tablePrintedWidth` states it before rounding it to two decimals, so a
  // width typed with three decimals is shared as typed. With no column shown it is 0.
  const printed = fixed + tableOverhead(layout.kind, shown);
  return {
    shared,
    // Both copies of the fixed columns and of every shown column's padding.
    fixedAndPadding: layout.copies * printed,
    // What one copy has left over its printed width, split between the columns that share.
    each: shared.length === 0 ? null : (budget - printed) / shared.length,
  };
}

/** What each shared column of a ticket's container table gets, in points, and which columns share,
 *  by the editor's names. null when the section is hidden. `each` is null when no shown column
 *  shares. The shared columns are named in the contract's order, whatever order the template
 *  stores. `fixedAndPadding` is the fixed columns' widths and every shown column's padding, in both
 *  copies of the table. */
export function sharedContainerWidth(
  docType: TicketDocType, config: TemplateConfig,
): { shared: string[]; each: number | null; fixedAndPadding: number } | null {
  const table = containerTable(docType, config);
  return table === null ? null : { shared: table.shared, each: table.each, fixedAndPadding: table.fixedAndPadding };
}

