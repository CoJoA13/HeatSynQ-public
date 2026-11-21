/**
 * The flow's printed-width budget (#991, owner ruling R-B, 2026-11-17): a flow table whose fixed column widths, with
 * the cell padding and rules its layout adds, and one 4.5 pt grid step where a "*" column is shown, pass its budget is
 * refused at save, as canvas rule 9's least width refuses a canvas table (`leastWidth`, #971 design §6). Below it a
 * table's fixed parts alone would print past the page (render.ts' column clamp cannot narrow a fixed column) and its
 * flexible columns would be left with nothing, a glyph a line.
 *
 * The figures are the editor's: one copy of the ticket's folded containers against the 282 pt each half has, the bill
 * of lading's freight against the 386 pt beside its sidebar, every other table against the content width; the padding
 * and rules are `tableOverhead`'s, the traveler's steps table `travelerStepsPrintedWidth`'s. Only VISIBLE columns of
 * VISIBLE sections count, as the declared budget counts them. Judged on a FLOW config alone: a canvas table's width is
 * rule 9's against its drawn box.
 *
 * One rule for both ends: the server's `validateConfig` (./index.ts) throws `printedBudgetProblems`' first sentence as
 * a `TemplateConfigError`, and the editor's `widthBudgetError` (src/lib/template-editor.ts) closes Save with it.
 * CLIENT-SAFE: it imports the contracts' types, the printed-width arithmetic and the traveler's steps measure, never the
 * registry (which imports this file).
 */
import { CANVAS_GRID } from "./canvas";
import { CONTENT_WIDTH, type SectionConfig, type TemplateContract } from "./types";
import { travelerStepsPrintedWidth } from "./traveler";
import { INVOICE_TOTALS_EDGE } from "./invoice";
import { COLUMN_TABLE_LAYOUTS, round2, tableOverhead } from "../printed-width-core";

export type PrintedBudgetProblem = {
  table: string;
  /** One copy's fixed widths, padding and rules, and the grid step where a "*" column is shown. */
  needs: number;
  declared: number;
  overhead: number;
  /** A shown "*" column adds one grid step. */
  flexible: boolean;
  budget: number;
  copies: number;
  sentence: string;
};

/** The ruled layout draws no vertical rules: its overhead is cell padding alone (`TABLE_LAYOUT_METRICS`). */
const addedWords = (kind: string): string => (kind === "ruled" ? "cell padding" : "cell padding and rules");

/**
 * Every column table of a flow config whose printed width passes its budget, in the contract's table order, then the
 * invoice's totals lines (#991 review F1, the controller's ruling): a right-aligned row of a "*" spacer, the 200 pt
 * label and the amount at the column headers' Amount width, two 6 pt gaps between them (`INVOICE_TOTALS_EDGE`, the
 * builder's constants held to it by tests/invoice-canvas.test.ts; the amount as the builder reads it: a shown Amount
 * column's typed width, else the contract's default), refused where it passes the content width, as canvas rule 4's
 * `gridEdgeColumn` floor counts it. Rendered, those lines overran from an Amount of 353 pt.
 *
 * The sentence says what fails: where the fixed columns and their padding pass the budget, that they would print past
 * the page; where only the shown "*" column's grid step does, that they leave it less than one step (#991 review F2).
 */
export function printedBudgetProblems(
  contract: TemplateContract, sections: SectionConfig[], baseSize: number,
): PrintedBudgetProblem[] {
  // A docType with no column table (the container tag, a test's stub) is judged on nothing.
  const layouts = COLUMN_TABLE_LAYOUTS[contract.docType] ?? {};
  const problems: PrintedBudgetProblem[] = [];
  for (const [table, layout] of Object.entries(layouts)) {
    const budget = contract.tableBudgets?.[table] ?? CONTENT_WIDTH;
    let declared: number, overhead: number, flexible: boolean;
    /** How many "*" columns are shown: the sentence names one flexible column, or several. */
    let stars = 0;
    /** The steps table's every column is locked (none can be hidden): its remedy names what can be done. */
    let remedy = "Narrow or hide a column.";
    if (layout.kind === "steps") {
      if (sections.find((s) => s.key === "steps")?.visible === false) continue;
      ({ declared, overhead, flexible } = travelerStepsPrintedWidth(sections, baseSize));
      stars = flexible ? 1 : 0;
      const instruction = sections.find((s) => s.key === "steps")?.fields.find((f) => f.key === "step_instruction");
      remedy = typeof instruction?.width === "number"
        ? "Narrow a column, or empty the Step instruction box to make it flex."
        : "Narrow a column.";
    } else {
      let shown = 0;
      declared = 0;
      flexible = false;
      for (const cs of contract.sections) {
        const s = sections.find((candidate) => candidate.key === cs.key);
        if (s === undefined || !s.visible) continue;
        for (const f of s.fields) {
          const column = cs.fields.find((cf) => cf.key === f.key)?.column;
          if (column?.table !== table || !f.visible) continue;
          shown++;
          const width = f.width ?? column.defaultWidth;
          if (width === "*") {
            flexible = true;
            stars++;
          } else declared += width;
        }
      }
      if (shown === 0) continue;
      overhead = tableOverhead(layout.kind, shown);
    }
    const needs = round2(declared + overhead + (flexible ? CANVAS_GRID : 0));
    if (!(needs > budget)) continue;
    const half = layout.copies === 2;
    const parts = `${round2(declared)}pt of column widths${half ? " each half" : ""}, ${overhead}pt of ${addedWords(layout.kind)}` +
      (flexible ? `, and ${CANVAS_GRID}pt for its flexible ${stars > 1 ? "columns" : "column"}` : "");
    const room = half ? `the ${budget}pt each half has` : contract.docType === "BOL" && table === "freight"
      ? `the ${budget}pt it has beside the sidebar` : `its ${budget}pt budget`;
    // The fixed parts alone pass the budget, or only the flexible column's least share does (the 4.5 pt band).
    const fails = round2(declared + overhead) > budget
      ? "its fixed columns alone would print past the page"
      : stars > 1
        ? `its fixed columns and their ${addedWords(layout.kind)} leave its flexible columns less than ${CANVAS_GRID}pt`
        : `its fixed columns and their ${addedWords(layout.kind)} leave its flexible column less than ${CANVAS_GRID}pt`;
    problems.push({
      table, needs, declared: round2(declared), overhead, flexible, budget, copies: layout.copies,
      sentence: `The "${table}" table needs ${needs}pt on paper (${parts}), more than ${room}: ${fails}. ${remedy}`,
    });
  }
  const totals = invoiceTotalsProblem(contract, sections);
  if (totals !== null) problems.push(totals);
  return problems;
}

/** The invoice's totals lines past the content width, or null (`printedBudgetProblems`' second half). */
function invoiceTotalsProblem(contract: TemplateContract, sections: SectionConfig[]): PrintedBudgetProblem | null {
  if (contract.docType !== "INVOICE") return null;
  const totals = sections.find((s) => s.key === "totals");
  if (totals === undefined || !totals.visible || !totals.fields.some((f) => f.visible)) return null;
  const amountField = contract.sections.flatMap((cs) => cs.fields).find((f) => f.key === INVOICE_TOTALS_EDGE.column);
  const entry = sections.flatMap((s) => s.fields).find((f) => f.key === INVOICE_TOTALS_EDGE.column);
  const fallback = typeof amountField?.column?.defaultWidth === "number" ? amountField.column.defaultWidth : 0;
  // The builder's `slotW.amt || W.amt`: a hidden or untyped Amount column reads the contract's default.
  const amount = entry !== undefined && entry.visible && typeof entry.width === "number" ? entry.width : fallback;
  const needs = round2(INVOICE_TOTALS_EDGE.fixed + amount);
  if (!(needs > CONTENT_WIDTH)) return null;
  return {
    table: "totals", needs, declared: round2(amount), overhead: INVOICE_TOTALS_EDGE.fixed, flexible: false,
    budget: CONTENT_WIDTH, copies: 1,
    // The amount at two decimals, as `needs` is, so a width typed with three reads as the sum it makes.
    sentence: `The totals lines need ${needs}pt on paper (the ${round2(amount)}pt Amount column beside their ${INVOICE_TOTALS_EDGE.fixed}pt ` +
      `label and gaps), more than the ${CONTENT_WIDTH}pt content width: they would print past the page. Narrow the Amount column.`,
  };
}
