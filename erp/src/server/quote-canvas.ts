/**
 * The quotation's canvas path (design `docs/superpowers/specs/2026-11-12-quote-canvas-design.md` §4.2, §4.4, §5.2;
 * since quote canvas PR 2): a template whose `config.layout` is not null prints its items where they
 * are drawn. The invoice's `invoice-canvas.ts` and the statement's `statement-canvas.ts` are the
 * models; the sheet itself is the shared `pdf/canvas-sheet.ts`.
 *
 * This file holds what is the quote's own: its field families (`quoteItemContent`), each printing the
 * flow's text for its key through the flow's own functions (the address lines, the number line's label
 * and glue), so no second copy of a filter, a label or a glue exists here; its six blocks
 * (`tableBlock`, each ONE stack of its children in the one canvas block shape, `drawnBlock`, by the
 * wrapper and margin rule in `blockChildren`), the liability keeping its 10 pt top margin (design
 * §5.2's per-key exception); the lens the blocks are printed through (`canvasCtx`, the column
 * headers' section the grid the lines print under, read through `gridOf`, the invoice's) and its belt
 * (`completeQuoteCanvas`, the identity: nothing is required); and the page line's "Page:" label, set
 * on the sheet it is handed (`buildCanvasQuoteDefinition`). `buildQuoteDefinition` (pdf/quote.ts)
 * branches here; a null layout never reaches this file. Ruling 8's suppressed Material label, ruling
 * 9's Unlimited, W14's heading, W15's unit, Q7's two money precisions, R14's stacked name and #948's
 * estimate rows reach a canvas as they reach the flow: both paths take the same `QuotePdfData`, and
 * the canvas adds no read.
 *
 * This file imports only TYPES from pdf/quote.ts: the flow's builders and the header fields' text
 * arrive as one `QuoteFlowBuilders` object (`QUOTE_FLOW`), so pdf/quote.ts may import this file with no
 * cycle. That object carries the flow's widths too, for parity with the invoice and the statement, and
 * nothing here reads them.
 */
import type { Content, Margins } from "pdfmake/interfaces";
import type { QuoteCtx, QuoteFlowBuilders, QuotePdfData } from "./pdf/quote";
import type { RenderableDefinition } from "./pdf/render";
import {
  assembleCanvasSheet, drawnBlock, inBoxWidth, labelOf, logoContent, sectionConfigOf, strokeContent, textContent,
  type FieldItem, type ItemContent, type TableItem,
} from "./pdf/canvas-sheet";
import { gridOf, tablesByY } from "@/lib/template-canvas";
import { QUOTE_CONTRACT } from "@/lib/template-contracts/quote";
import type { CanvasLayout } from "@/lib/template-contracts/canvas";
import { completeSections, type SectionConfig, type TemplateConfig } from "@/lib/template-contracts/types";

/**
 * A field item's content, printed as the flow prints the same key, at the item's style (its size,
 * bold and alignment), in the item's box width. The families (design §4.2):
 *
 *  - label as text: `title` prints its label (the contract's "Quotation", or the item's typed one),
 *    as the flow's title is a label.
 *  - value alone: `company_name` (the company's name) and `company_address` (the flow's address
 *    lines, `flow.addressLines`: the address's non-blank lines, trimmed), one text node a line in
 *    one stack.
 *  - label and value on one line: `quote_number` (`flow.numberText`): the label always bold with
 *    its one space after it, then the number at the item's bold, so an 11 pt regular item prints
 *    the flow's line.
 *
 * Any other key prints nothing: the blocks' own fields (the profile's `notFields`) and the column
 * headers' columns are never field items, and the validator refuses an unknown key.
 */
function fieldContent(d: QuotePdfData, item: FieldItem, flow: QuoteFlowBuilders): Content | null {
  const { size, bold, align } = item.style;
  const label = labelOf(QUOTE_CONTRACT, item);
  const print = (text: string): Content => inBoxWidth(item.box.w, { text, fontSize: size, bold, alignment: align });
  switch (item.key) {
    case "title": return print(label);
    case "company_name": return print(d.company.name);
    case "company_address": return inBoxWidth(item.box.w, {
      stack: flow.addressLines(d).map((text): Content => ({ text, fontSize: size, bold, alignment: align })),
    });
    case "quote_number": return inBoxWidth(item.box.w, {
      text: flow.numberText(label, d), fontSize: size, bold, alignment: align,
    });
    default: return null;
  }
}

/**
 * The quote's item node, the closure its sheet is assembled with: a field through its family
 * (`fieldContent`), a text item as text, the logo fitted (nothing when the version carries no logo
 * bytes, `logoDataUri` undefined), a line or a box stroked. A text-block item prints nothing (the
 * quote's two wordings print inside their blocks, and the profile refuses one). A table is never an
 * item node; a barcode, which the profile refuses, prints nothing. `ctx` is the canvas ctx the
 * blocks print through; no header family reads it (the quote's header fields carry no date or
 * money), and it is taken so the item and block closures are built from one ctx, as the invoice's
 * and the statement's are.
 */
export function quoteItemContent(
  ctx: QuoteCtx, d: QuotePdfData, flow: QuoteFlowBuilders, logoDataUri?: string,
): ItemContent {
  return (item) => {
    switch (item.kind) {
      case "field": return fieldContent(d, item, flow);
      case "text": return textContent(item);
      case "logo": return logoContent(item, logoDataUri);
      case "line":
      case "box": return strokeContent(item);
      default: return null;
    }
  };
}

/**
 * The canvas ctx the quote's items and blocks are built from, through the flow's own `ctxOf` (its
 * lens, its formatters and its `qtyW` arithmetic), so a block prints exactly as the flow prints it.
 * THE LENS (design §4.4, §5.2, the invoice's): each placed block's section is its item's
 * (`sectionConfigOf`), and the column headers' section, which the strip, every grid row and the
 * Material and PRICE indent (`qtyW`) read, is the GRID the lines print under (`gridOf`, the one helper
 * warning (g) reads too, so the canvas and the warning cannot disagree): the column headers item's own
 * columns where it is placed, else the contract's, each column's visibility, label and width carried.
 * The sections no block stands for (the header) take the contract's defaults (`completeSections`; the
 * field items' labels come from the contract, `labelOf`). All six blocks are section-keyed, so no block
 * is left out of the lens. The logo is the Logo item's, never the header's, so the ctx carries none.
 */
function canvasCtx(config: TemplateConfig, layout: CanvasLayout, flow: QuoteFlowBuilders): QuoteCtx {
  const grid = gridOf(layout, QUOTE_CONTRACT, "lines")!;
  const gridSection: SectionConfig = {
    key: grid.key, visible: true,
    fields: grid.columns.map((column) => ({
      key: column.key, visible: column.visible, label: column.label, width: column.width,
    })),
  };
  const placed = tablesByY(layout).filter((item) => item.key !== grid.key).map((item) => sectionConfigOf(QUOTE_CONTRACT, item));
  return flow.ctxOf(config, completeSections(QUOTE_CONTRACT, [...placed, gridSection]), null);
}

/** A node's margin as [left, top, right, bottom] (pdfmake's one-, two- and four-number forms; the
 *  statement's, copied: its helpers are private to its file). */
function marginOf(node: Content): [number, number, number, number] {
  const margin = (node as { margin?: Margins }).margin;
  if (margin === undefined) return [0, 0, 0, 0];
  if (typeof margin === "number") return [margin, margin, margin, margin];
  if (margin.length === 2) return [margin[0], margin[1], margin[0], margin[1]];
  return [margin[0], margin[1], margin[2], margin[3]];
}

/** A flow node with its own vertical margins zeroed and its lateral margins kept: the drawn
 *  distances between blocks carry what those margins carried in the flow (the invoice's and the
 *  statement's, copied: theirs are private to their files). */
function withoutVerticalMargins(node: Content): Content {
  const [left, , right] = marginOf(node);
  return { ...(node as object), margin: [left, 0, right, 0] } as Content;
}

/** A one-node block's children: that node, its own vertical margins zeroed (its children's kept);
 *  null when the flow answers no node. */
const oneNode = (node: Content | null | undefined): Content[] | null =>
  node === null || node === undefined ? null : [withoutVerticalMargins(node)];

/** A several-node block's children: every node as the flow builds it, every margin kept (the first
 *  node's top and the last's bottom included); null when the flow answers none. */
const severalNodes = (nodes: Content[]): Content[] | null => (nodes.length === 0 ? null : nodes);

/**
 * A block's children, by the wrapper and margin rule (design §5.2, the certification's), which goes
 * by the section's KIND, never by how many nodes a given quote happens to answer:
 *
 *  - one-node: `parties` (the Attn and quote-fields columns, `partiesBlock`), `intro` (the intro
 *    line), `column_header` (the boxed strip, `columnHeaderStrip`) and `closing` (the ending
 *    statement, notes and signature columns): that node with its own vertical margins zeroed, lateral
 *    kept, so the parties' 8 pt below, the intro's 2 and 4, the strip's 4 and the closing's 18 are the
 *    drawn distances' to carry.
 *  - several-node: `lines` (each line's grid row, Material line, PRICE heading, price rows with their
 *    detail and break lines, and #948's estimate rows): every node with its margins, so the first grid
 *    row keeps its 2 pt, the Material line its 6 and the PRICE heading its 8 and 2.
 *  - the liability, `liability`: the flow's one node with its TOP margin KEPT and its bottom zeroed.
 *    This is design §5.2's per-key exception to the one-node arm, which would zero the 10 pt the flow
 *    prints between the closing and the fine print: the seed marks the block's start ABOVE that 10 pt,
 *    so a seeded canvas prints the wording where the flow prints it. Do not fold it into `oneNode`.
 *    Blank wording answers no node (the flow's own omission), so the block prints nothing.
 *
 * Null when the flow answers nothing (every parties row hidden or blank, every grid column hidden, no
 * line, blank liability wording).
 */
function blockChildren(ctx: QuoteCtx, d: QuotePdfData, flow: QuoteFlowBuilders, item: TableItem): Content[] | null {
  switch (item.key) {
    case "parties": return oneNode(flow.partiesBlock(ctx, d)[0]);
    case "intro": return oneNode(flow.introBlock(d)[0]);
    case "column_header": return oneNode(flow.columnHeaderStrip(ctx)[0]);
    case "lines": return severalNodes(flow.linesBlock(ctx, d));
    case "closing": return oneNode(flow.closingBlock(ctx, d)[0]);
    case "liability": {
      const node = flow.liabilityBlock(d)[0];
      if (node === undefined) return null;
      const [left, top, right] = marginOf(node);
      return [{ ...(node as object), margin: [left, top, right, 0] } as Content];
    }
    default: return null;
  }
}

/**
 * A block's node: ONE stack holding the block's children (`blockChildren`), in the one canvas block
 * shape (`drawnBlock`, `pdf/canvas-sheet.ts`, #969): the block's id on the wrapper, its own margin
 * [0, 0, 0, 0], and the lateral margin on the zero-gap `columns` node inside it, whose one column,
 * fixed at the drawn width as pdfmake subtracts it from the content width, holds the stack, so the
 * grid's `"*"` information column, the parties' and the closing's `"*"` columns resolve against it.
 * The margin sits there, never on the wrapper: when a block breaks across a page, pdfmake rebuilds the
 * new page's width less a level-1 column group's own margin, and a margin on an outer stack is not in
 * that rebuild, so its end handed every block laid out after it a width wider by its left plus right
 * inset, past the right margin (#969; the `canvas-nodes.ts` header holds the mechanism). The column is
 * fixed, never `"*"`, so a child wider than the block widens no sibling. Every block takes the wrapper,
 * so an id never lands on a flow node, and so never on a text node (the intro, the Material line, the
 * PRICE heading and the liability are text nodes). Null when the block has no children; the sheet
 * still emits the block's marks and region.
 */
function tableBlock(ctx: QuoteCtx, d: QuotePdfData, flow: QuoteFlowBuilders, item: TableItem): Content | null {
  const children = blockChildren(ctx, d, flow, item);
  if (children === null) return null;
  return drawnBlock({ stack: children }, item);
}

/** The quote's belt: the identity, since its profile requires nothing (design §4.3, §4.6). Kept so
 *  the measure's `complete` parameter has the quote's name, as every canvas document's does. */
export function completeQuoteCanvas(layout: CanvasLayout): CanvasLayout {
  return layout;
}

/**
 * The quote's one definition, assembled by the shared sheet (`assembleCanvasSheet`,
 * `pdf/canvas-sheet.ts`) over the completed layout from its item node and block, both built from ONE
 * canvas ctx: one sheet group, printed through `renderPdf` in one pass (no `overflowTopMargin`), its
 * repeat band and its page-bottom band the sheet's. THE PAGE LINE (design call 5): the sheet's line
 * reads "Page N of M"; the quote's flow has always printed "Page: N of M", so with `pageFooter` on the
 * sheet's spec is replaced by one carrying the flow's "Page:" label. It is set here, on the sheet this
 * module is handed, never through `assembleCanvasSheet`, so no other document's call or paper changes.
 */
export function buildCanvasQuoteDefinition(
  input: QuotePdfData, config: TemplateConfig, stored: CanvasLayout, flow: QuoteFlowBuilders, logoDataUri?: string,
): RenderableDefinition {
  const layout = completeQuoteCanvas(stored);
  const ctx = canvasCtx(config, layout, flow);
  const sheet = assembleCanvasSheet({
    layout,
    pageFooter: config.pageFooter,
    fonts: config.fonts,
    itemContent: quoteItemContent(ctx, input, flow, logoDataUri),
    tableBlock: (item) => tableBlock(ctx, input, flow, item),
  });
  return config.pageFooter ? { ...sheet, pageFooterSpec: { kind: "pageNofM", label: "Page:" } } : sheet;
}

/**
 * The item node the quote's sheet is assembled with (`buildCanvasQuoteDefinition`'s own ctx, over the
 * completed layout), for the preview's alone layouts (`aloneLayouts`, `pdf/canvas-sheet.ts`).
 * `quoteCanvasItemContent` (pdf/quote.ts, beside the flow's builders) is the one-call form.
 */
export function firstQuoteItemContent(
  input: QuotePdfData, config: TemplateConfig, stored: CanvasLayout, flow: QuoteFlowBuilders, logoDataUri?: string,
): ItemContent {
  const layout = completeQuoteCanvas(stored);
  return quoteItemContent(canvasCtx(config, layout, flow), input, flow, logoDataUri);
}
