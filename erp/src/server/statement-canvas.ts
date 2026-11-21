/**
 * The customer statement's canvas path (design `docs/superpowers/specs/2026-11-11-statement-canvas-design.md`
 * §4.2, §4.4, §5.2): a template whose `config.layout` is not null prints its items where they are
 * drawn. The invoice's `invoice-canvas.ts` is the model; the sheet itself is the shared
 * `pdf/canvas-sheet.ts`.
 *
 * This file holds what is the statement's own: its field families (`statementItemContent`), each
 * printing the flow's text for its key through the flow's own functions (the identity lines' glue
 * and values, the Remit To box, the date knob), so no second copy of a label, a glue or a box exists
 * here; its five blocks (`tableBlock`, each ONE wrapper stack carrying the block's id, its lateral
 * margin on the `columns` node inside it, by the rule below), the Bill To printing at least its drawn height beside the Remit To box
 * (the profile's `holdsHeight`, read through `tableSpec`) and the finance line keeping its 2 pt top
 * margin (design §5.2's departure); the lens the blocks are printed through (`canvasCtx`, which
 * leaves the field-keyed Bill To out of `sectionView`) and its belt (`completeStatementCanvas`, the
 * identity: nothing is required). `buildStatementDefinition` (pdf/statement.ts) branches here; a
 * null layout never reaches this file. #162's informational finance line, ruling 8's Unapplied
 * column and R14's stacked bill-to reach a canvas as they reach the flow: both paths take the same
 * `StatementData`, and the canvas adds no read.
 *
 * This file imports only TYPES from pdf/statement.ts: the flow's builders, its widths and its boxed
 * fields arrive as one `StatementFlowBuilders` object (`STATEMENT_FLOW`), so pdf/statement.ts may
 * import this file with no cycle.
 */
import type { Content, Margins } from "pdfmake/interfaces";
import type { StatementCtx, StatementData, StatementFlowBuilders } from "./pdf/statement";
import type { RenderableDefinition } from "./pdf/render";
import {
  assembleCanvasSheet, defaultLabelOf, drawnBlock, inBoxWidth, labelOf, logoContent, sectionConfigOf,
  strokeContent, textContent, type FieldItem, type ItemContent, type TableItem,
} from "./pdf/canvas-sheet";
import { tableSpec, tablesByY } from "@/lib/template-canvas";
import { STATEMENT_CONTRACT } from "@/lib/template-contracts/statement";
import type { CanvasLayout } from "@/lib/template-contracts/canvas";
import { completeSections, type TemplateConfig } from "@/lib/template-contracts/types";

/** The identity lines' keys, whose glue and value the flow holds (`flow.identityGlue`,
 *  `flow.identityValue`). */
type IdentityKey = keyof StatementFlowBuilders["identityGlue"];

/**
 * A field item's content, printed as the flow prints the same key, at the item's style (its size,
 * bold and alignment), in the item's box width. The families (design §4.2):
 *
 *  - label as text: `title` prints its label (the contract's "Statement", or the item's typed one),
 *    as the flow's title is a label.
 *  - value alone: `company_name` (the company's name).
 *  - label and value on one line: `customer` (`${code} — ${name}`) and `statement_date` (the date
 *    knob's date, through the flow's `makeLongDate` bound as `ctx.date`, in every slot it prints
 *    in): the label always bold with the flow's glue after it (`flow.identityGlue`), then the value
 *    (`flow.identityValue`) at the item's bold, so a 10 pt regular item prints the flow's line.
 *  - a boxed field (`flow.boxedFields`: `remit_to`): the flow's Remit To box (`flow.remitToBox`) at
 *    the item's drawn width, its label at the item's size and bold, the remit-to name and lines at
 *    the flow's 10 pt.
 *
 * Any other key prints nothing: the blocks' own fields (the profile's `notFields`, the Bill To
 * among them, which prints as a block) and the aging strip's columns are never field items, and the
 * validator refuses an unknown key.
 */
function fieldContent(ctx: StatementCtx, d: StatementData, item: FieldItem, flow: StatementFlowBuilders): Content | null {
  const { size, bold, align } = item.style;
  const label = labelOf(STATEMENT_CONTRACT, item);
  const print = (text: string): Content => inBoxWidth(item.box.w, { text, fontSize: size, bold, alignment: align });
  const identity = (key: IdentityKey): Content => inBoxWidth(item.box.w, {
    text: [{ text: `${label}${flow.identityGlue[key]}`, bold: true }, flow.identityValue(key, ctx, d)],
    fontSize: size, bold, alignment: align,
  });
  // The flow's boxed list is `remit_to` alone (STATEMENT_BOXED_FIELDS), so a boxed key prints the
  // Remit To box; a second boxed key needs a branch of its own here.
  if (flow.boxedFields.includes(item.key)) {
    return inBoxWidth(item.box.w, flow.remitToBox(label, { fontSize: size, bold }, d));
  }
  switch (item.key) {
    case "title": return print(label);
    case "company_name": return print(d.company.name);
    case "customer": return identity("customer");
    case "statement_date": return identity("statement_date");
    default: return null;
  }
}

/**
 * The statement's item node, the closure its sheet is assembled with: a field through its family
 * (`fieldContent`), a text item as text, the logo fitted (nothing when the version carries no logo
 * bytes, `logoDataUri` undefined), a line or a box stroked. A text-block item prints nothing (the
 * statement's contract has no text block, and the profile refuses one). A table is never an item
 * node; a barcode, which the profile refuses, prints nothing.
 */
export function statementItemContent(
  ctx: StatementCtx, d: StatementData, flow: StatementFlowBuilders, logoDataUri?: string,
): ItemContent {
  return (item) => {
    switch (item.kind) {
      case "field": return fieldContent(ctx, d, item, flow);
      case "text": return textContent(item);
      case "logo": return logoContent(item, logoDataUri);
      case "line":
      case "box": return strokeContent(item);
      default: return null;
    }
  };
}

/**
 * The canvas ctx the statement's items and blocks are built from, through the flow's own `ctxOf`
 * (its lens, its money and its date knob), so a block prints exactly as the flow prints it. THE LENS
 * (design §4.4, the certification's To block's): each placed block's section is its item's
 * (`sectionConfigOf`), and the Bill To, keyed by its FIELD (`bill_to`, held by the identity section),
 * stands for no section, so it is left out of the sections handed to `sectionView`, which refuses an
 * unknown section; its heading is read from the item itself (`blockChildren`). The sections no block
 * stands for (the header, the identity) take the contract's defaults (`completeSections`; the field
 * items' labels come from the contract, `labelOf`). The logo is the Logo item's, never the header's,
 * so the ctx carries none.
 */
function canvasCtx(config: TemplateConfig, layout: CanvasLayout, flow: StatementFlowBuilders): StatementCtx {
  const sectionConfigs = completeSections(STATEMENT_CONTRACT, tablesByY(layout)
    .filter((item) => tableSpec(STATEMENT_CONTRACT, item.key)?.keyed !== "field")
    .map((item) => sectionConfigOf(STATEMENT_CONTRACT, item)));
  return flow.ctxOf(config, sectionConfigs, null);
}

/** A node's margin as [left, top, right, bottom] (pdfmake's one-, two- and four-number forms). */
function marginOf(node: Content): [number, number, number, number] {
  const margin = (node as { margin?: Margins }).margin;
  if (margin === undefined) return [0, 0, 0, 0];
  if (typeof margin === "number") return [margin, margin, margin, margin];
  if (margin.length === 2) return [margin[0], margin[1], margin[0], margin[1]];
  return [margin[0], margin[1], margin[2], margin[3]];
}

/** A flow node with its own vertical margins zeroed and its lateral margins kept: the drawn
 *  distances between blocks carry what those margins carried in the flow (the invoice's and the
 *  certification's, copied: theirs are private to their files). */
function withoutVerticalMargins(node: Content): Content {
  const [left, , right] = marginOf(node);
  return { ...(node as object), margin: [left, 0, right, 0] } as Content;
}

/** A one-node block's children: that node, its own vertical margins zeroed (its children's kept);
 *  null when the flow answers no node. */
const oneNode = (node: Content | null | undefined): Content[] | null =>
  node === null || node === undefined ? null : [withoutVerticalMargins(node)];

/**
 * A block's children, by the wrapper and margin rule (design §5.2, the certification's), which goes
 * by the section's KIND, never by how many nodes a given statement happens to answer:
 *
 *  - the Bill To: the flow's stack (`flow.billToStack`), its label the block's heading, else the
 *    contract's default, as the flow builds it, so the label keeps its 6 pt top margin inside the
 *    block (design §4.1's floor counts it).
 *  - one-node: `open_items` (the boxed table), `aging` (the boxed strip) and `total` (the Total Due
 *    line): that node with its own vertical margins zeroed, lateral kept, so the open items' and the
 *    aging's 10 pt below and Total Due's 6 pt above are the drawn distances' to carry.
 *  - the finance line, `finance_charge`: the flow's one node with its TOP margin KEPT and its bottom
 *    zeroed. This is design §5.2's departure from the one-node arm, which would zero the 2 pt the
 *    flow prints between the aging strip's 10 pt and #162's line: the seed (the flow's `seedIds` marks,
 *    pdf/statement.ts) marks the block's start ABOVE that 2 pt, so a seeded canvas prints the line where the
 *    flow prints it. Do not fold it into `oneNode`.
 *
 * Null when the flow answers nothing (every open-items or aging column hidden, no finance charge,
 * the Total Due line hidden). The Bill To always answers its label.
 */
function blockChildren(ctx: StatementCtx, d: StatementData, flow: StatementFlowBuilders, item: TableItem): Content[] | null {
  switch (item.key) {
    case "bill_to": return flow.billToStack(item.heading ?? defaultLabelOf(STATEMENT_CONTRACT, "bill_to"), d);
    case "open_items": return oneNode(flow.openItemsTable(ctx, d)[0]);
    case "aging": return oneNode(flow.agingStrip(ctx, d)[0]);
    case "finance_charge": {
      const node = flow.financeChargeBlock(ctx, d)[0];
      if (node === undefined) return null;
      const [left, top, right] = marginOf(node);
      return [{ ...(node as object), margin: [left, top, right, 0] } as Content];
    }
    case "total": return oneNode(flow.totalDueBlock(ctx, d)[0]);
    default: return null;
  }
}

/**
 * A block's node: the stack of the block's children (`blockChildren`) in the one canvas block shape
 * (`drawnBlock`, `pdf/canvas-sheet.ts`, #969): ONE wrapper stack carrying the block's id, its own
 * margin [0, 0, 0, 0], holding a zero-gap `columns` node that carries the lateral margin, its first
 * column fixed at the drawn width as pdfmake subtracts it from the content width (`drawnBlock`, never
 * `item.box.w`), never `"*"`: a `"*"` column takes its widest child's minimum width when that minimum
 * reaches the available width, so one unbreakable word wider than the block would widen every line
 * beside it (tests/statement-canvas.test.ts, the narrowed Bill To's case). Every block takes the
 * wrapper, so an id never lands on a flow node, and so never on a text node (the Bill To's label and
 * lines are text nodes). Null when the block has no children; the sheet still emits the block's
 * marks and region.
 *
 * The lateral margin sits on the `columns` node, never on the wrapper: on a page break inside a
 * top-level column group (a table's row, a `columns` node) pdfmake rebuilds the available width from
 * that group's OWN margin, never a parent stack's, so under a margined wrapper a block drawn narrower
 * than the page that breaks across a page leaves every node after it a width wider than the page's by
 * the block's left plus right inset (`canvas-nodes.ts`'s header). Under a margined wrapper over a `"*"`
 * column, a held Bill To breaking so (the open items ordered above the identity, 37 to 41 of them)
 * printed the aging, the finance line and Total Due about 300 pt past the right edge, and the open
 * items drawn 40 pt in on each side, paging, printed the aging's Net and Total Due's amount past it
 * (tests/statement-canvas-seed.test.ts). With the fixed column, the nodes after the block in those
 * cases take fixed widths (a block's column, an item's box through `inBoxWidth`), so none reads the
 * widened width and a margined wrapper alone prints them the same (#969's fix wave, 2026-11-12, by
 * mutation): the margin's place is held by structure. The held Bill To's pins in
 * tests/statement-canvas.test.ts hold it for the held block, and the canvas paper oracle's STATEMENT
 * column-toggle premise (tests/canvas-paper-oracle.test.ts) for every block, the open items included.
 *
 * A block whose profile entry holds its height (`holdsHeight`, read through `tableSpec`, never by
 * its key: the Bill To, beside the Remit To box; design §4.1, §4.4) takes a second column, 0 wide,
 * holding a spacer of its drawn height, so the block lays out at the larger of its content and its
 * drawn box: a one-line bill-to still ends at the box's bottom, so the open items start under the
 * Remit To box, and a taller one pushes them down (`drawnBlock`'s `held`). The spacer carries no id
 * (`canvas-nodes.ts`'s fill at opacity 0, which tests/canvas-marks-ink.test.ts reads).
 */
function tableBlock(ctx: StatementCtx, d: StatementData, flow: StatementFlowBuilders, item: TableItem): Content | null {
  const children = blockChildren(ctx, d, flow, item);
  if (children === null) return null;
  const held = tableSpec(STATEMENT_CONTRACT, item.key)?.holdsHeight === true;
  return drawnBlock({ stack: children }, item, held ? item.box.h : undefined);
}

/** The statement's belt: the identity, since its profile requires nothing (design §4.3, §4.6). Kept
 *  so the measure's `complete` parameter has the statement's name, as every canvas document's does. */
export function completeStatementCanvas(layout: CanvasLayout): CanvasLayout {
  return layout;
}

/**
 * The statement's one definition, assembled by the shared sheet (`assembleCanvasSheet`,
 * `pdf/canvas-sheet.ts`) over the completed layout from its item node and block: one sheet group,
 * printed through `renderPdf` in one pass (no `overflowTopMargin`), its repeat band, its page-bottom
 * band and its page line the sheet's.
 */
export function buildCanvasStatementDefinition(
  input: StatementData, config: TemplateConfig, stored: CanvasLayout, flow: StatementFlowBuilders, logoDataUri?: string,
): RenderableDefinition {
  const layout = completeStatementCanvas(stored);
  const ctx = canvasCtx(config, layout, flow);
  return assembleCanvasSheet({
    layout,
    pageFooter: config.pageFooter,
    fonts: config.fonts,
    itemContent: statementItemContent(ctx, input, flow, logoDataUri),
    tableBlock: (item) => tableBlock(ctx, input, flow, item),
  });
}

/**
 * The item node the statement's sheet is assembled with (`buildCanvasStatementDefinition`'s own ctx,
 * over the completed layout), for the preview's alone layouts (`aloneLayouts`, `pdf/canvas-sheet.ts`).
 * `statementCanvasItemContent` (pdf/statement.ts, beside the flow's builders) is the one-call form.
 */
export function firstStatementItemContent(
  input: StatementData, config: TemplateConfig, stored: CanvasLayout, flow: StatementFlowBuilders, logoDataUri?: string,
): ItemContent {
  const layout = completeStatementCanvas(stored);
  return statementItemContent(canvasCtx(config, layout, flow), input, flow, logoDataUri);
}
