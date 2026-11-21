/**
 * The invoice's and the credit memo's canvas path (design `docs/superpowers/specs/2026-11-10-invoice-canvas-design.md`
 * §4.2, §5.1, §5.2): a template whose `config.layout` is not null prints its items where they are
 * drawn. The certification's `cert-canvas.ts` is the model; the sheet itself is the shared
 * `pdf/canvas-sheet.ts`.
 *
 * This file holds what is the invoice's own: its field families (`invoiceItemContent`), each
 * printing the flow's text for its key through the flow's own functions (the identity lines' glue,
 * the Remit To box, the footer strip's cells, the date knob), so no second copy of a label, a glue
 * or a cell's text exists here; its six blocks (`tableBlock`, each ONE stack of its children in the
 * one canvas block shape, `drawnBlock`, by the wrapper and margin rule below); the lens the blocks
 * are printed through (`canvasCtx`, the grid read through `gridOf`) and its belt
 * (`completeInvoiceCanvas`, the identity: nothing is required); and #589 on a canvas, the price
 * block's own ctx, whose rules run from margin to margin, and its end-of-block belt, which gives the
 * last rule no space under it when nothing prints after the block (`tableBlock`,
 * `priceEndsTheFlow`, over the sheet's `nothingPrintsAfter`). `buildInvoiceDefinition`
 * (pdf/invoice.ts) branches here; a null layout never reaches this file. The frozen snapshot, W14's heading, W15's unit, R14's stacked
 * name, ruling 3's signs and #590's measured strip reach a canvas as they reach the flow: both
 * paths take the same `InvoicePdfData`, and the canvas adds no read.
 *
 * This file imports only TYPES from pdf/invoice.ts: the flow's builders, its widths and its boxed
 * fields arrive as one `InvoiceFlowBuilders` object (`INVOICE_FLOW`), so pdf/invoice.ts may import
 * this file with no cycle.
 */
import type { Content, Margins } from "pdfmake/interfaces";
import type { InvoiceCtx, InvoiceFlowBuilders, InvoicePdfData } from "./pdf/invoice";
import type { RenderableDefinition } from "./pdf/render";
import {
  assembleCanvasSheet, drawnBlock, inBoxWidth, labelOf, logoContent, nothingPrintsAfter, sectionConfigOf, strokeContent,
  textContent, type FieldItem, type ItemContent, type TableItem,
} from "./pdf/canvas-sheet";
import { gridOf, tablesByY } from "@/lib/template-canvas";
import { INVOICE_CONTRACT } from "@/lib/template-contracts/invoice";
import { CANVAS_PAGE, type CanvasLayout } from "@/lib/template-contracts/canvas";
import { completeSections, type SectionConfig, type TemplateConfig } from "@/lib/template-contracts/types";

/** The identity lines' keys, whose glue the flow holds (`flow.identityGlue`). */
type IdentityKey = keyof InvoiceFlowBuilders["identityGlue"];

/**
 * A field item's content, printed as the flow prints the same key, at the item's style (its size,
 * bold and alignment), in the item's box width. The families (design §4.2):
 *
 *  - value alone: `company_name` (the company's name); data as title: `title` prints the document's
 *    kind, "Invoice" or "Credit" (`d.title`), never its label, which is "" and which a typed label
 *    does not reach, as in the flow.
 *  - label and value on one line: `invoice_no`, `invoice_date` (the date knob's date, through the
 *    flow's `makeLongDate` bound as `ctx.date`, in every slot it prints in) and `terms`: the label
 *    always bold with the flow's glue after it (`flow.identityGlue`), then the value at the item's
 *    bold, so a 10 pt regular item prints the flow's line.
 *  - the footer strip's cells, `footer_address` (the company address), `footer_contact` (its label
 *    alone, no data behind it) and `footer_phone` (`${label} ${phone}`), each the text the flow's
 *    strip prints for it (`flow.footerText`), all at the item's style.
 *  - a boxed field (`flow.boxedFields`: `remit_to`): the flow's Remit To box (`flow.remitToBox`) at
 *    the item's drawn width, its label at the item's size and bold, the remit-to name and lines at
 *    the flow's 10 pt.
 *
 * Any other key prints nothing: the blocks' own fields (the profile's `notFields`) and the grid's
 * columns are never field items, and the validator refuses an unknown key.
 */
function fieldContent(ctx: InvoiceCtx, d: InvoicePdfData, item: FieldItem, flow: InvoiceFlowBuilders): Content | null {
  const { size, bold, align } = item.style;
  const label = labelOf(INVOICE_CONTRACT, item);
  const print = (text: string): Content => inBoxWidth(item.box.w, { text, fontSize: size, bold, alignment: align });
  const identity = (key: IdentityKey, value: string): Content => inBoxWidth(item.box.w, {
    text: [{ text: `${label}${flow.identityGlue[key]}`, bold: true }, value], fontSize: size, bold, alignment: align,
  });
  // The flow's boxed list is `remit_to` alone (INVOICE_BOXED_FIELDS), so a boxed key prints the Remit
  // To box; a second boxed key needs a branch of its own here.
  if (flow.boxedFields.includes(item.key)) {
    return inBoxWidth(item.box.w, flow.remitToBox(label, { fontSize: size, bold }, d));
  }
  switch (item.key) {
    case "company_name": return print(d.company.name);
    case "title": return print(d.title);
    case "invoice_no": return identity("invoice_no", d.documentNumber);
    case "invoice_date": return identity("invoice_date", ctx.date(d.invoiceDate));
    case "terms": return identity("terms", d.termsName);
    case "footer_address":
    case "footer_contact":
    case "footer_phone": return print(flow.footerText(item.key, label, d));
    default: return null;
  }
}

/**
 * The invoice's item node, the closure its sheet is assembled with: a field through its family
 * (`fieldContent`), a text item as text, the logo fitted (nothing when the version carries no logo
 * bytes, `logoDataUri` undefined), a line or a box stroked. A text-block item prints nothing (the
 * invoice's contract has no text block, and the profile refuses one). A table is never an item
 * node; a barcode, which the profile refuses, prints nothing.
 */
export function invoiceItemContent(ctx: InvoiceCtx, d: InvoicePdfData, flow: InvoiceFlowBuilders, logoDataUri?: string): ItemContent {
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
 * The canvas ctx the invoice's items and blocks are built from, through the flow's own `ctxOf` (its
 * lens and its `slotW` arithmetic), so a block prints exactly as the flow prints it. THE LENS (design
 * §5.1, §5.2): each placed block's section is its item's (`sectionConfigOf`), and the column headers'
 * section, which every grid block's columns and `slotW` read, is the GRID the layout's blocks print
 * under (`gridOf`, the one helper warning (g) reads too, so the canvas and the warning cannot
 * disagree): the column headers item's own columns where it is placed, else the contract's. The
 * sections no block stands for take the contract's defaults (`completeSections`; the field items'
 * labels come from the contract, `labelOf`). All six blocks are section-keyed, so no block is left
 * out of the lens. The logo is the Logo item's, never the header's, so the ctx carries none.
 */
function canvasCtx(config: TemplateConfig, layout: CanvasLayout, flow: InvoiceFlowBuilders): InvoiceCtx {
  const grid = gridOf(layout, INVOICE_CONTRACT, "parts")!;
  const gridSection: SectionConfig = {
    key: grid.key, visible: true,
    fields: grid.columns.map((column) => ({
      key: column.key, visible: column.visible, label: column.label, width: column.width,
    })),
  };
  const placed = tablesByY(layout).filter((item) => item.key !== grid.key).map((item) => sectionConfigOf(INVOICE_CONTRACT, item));
  return flow.ctxOf(config, completeSections(INVOICE_CONTRACT, [...placed, gridSection]), null);
}

/** A flow node with its own vertical margins zeroed and its lateral margins kept: the drawn
 *  distances between blocks carry what those margins carried in the flow. */
function withoutVerticalMargins(node: Content): Content {
  const margin = (node as { margin?: Margins }).margin;
  const [left, right] = margin === undefined ? [0, 0]
    : typeof margin === "number" ? [margin, margin]
      : margin.length === 2 ? [margin[0], margin[0]]
        : [margin[0], margin[2]];
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
 * by the section's KIND, never by how many nodes a given invoice happens to answer:
 *
 *  - one-node: `parties` (the two address columns, `partiesBlock`) and `column_header` (the boxed
 *    strip, `columnHeaderStrip`): that node with its own vertical margins zeroed, lateral kept.
 *  - several-node: `order_strip` (#590's measured row, which keeps its own id `invoice-order-strip`
 *    inside the block's inner stack, and the PARTS heading), `parts` (a row per part), `price` (the
 *    PRICE heading, each group's operations and #589's rule after each) and `totals` (a line per total):
 *    every node with its margins, so the PARTS heading keeps its 4 pt, the PRICE heading its 8.
 *
 * Null when the flow answers nothing (every address or grid column hidden, no part, nothing priced,
 * every total hidden).
 */
function blockChildren(ctx: InvoiceCtx, d: InvoicePdfData, flow: InvoiceFlowBuilders, item: TableItem): Content[] | null {
  switch (item.key) {
    case "parties": return oneNode(flow.partiesBlock(ctx, d)[0]);
    case "column_header": return oneNode(flow.columnHeaderStrip(ctx)[0]);
    case "order_strip": return severalNodes(flow.orderStrip(ctx, d));
    case "parts": return severalNodes(flow.partsRows(ctx, d));
    case "price": return severalNodes(flow.priceBlock(ctx, d));
    case "totals": return severalNodes(flow.totalsBlock(ctx, d));
    default: return null;
  }
}

/**
 * Whether nothing prints after the price block (design §5.2, the end-of-block belt): the sheet's own
 * question (`nothingPrintsAfter`, `pdf/canvas-sheet.ts`), asked of the price block with a later
 * block printing when the flow answers it children (`blockChildren`), so the belt and the sheet's
 * drop of a trailing gap (#997) cannot disagree. Every block drawn after the price block answers no
 * children, and no item anchored below the price block or below any later block prints. A page-top
 * or page-bottom item never counts. A region whose items print nothing is a spacer alone, which the
 * sheet leaves out when this answers true (#997, owner ruling 2026-11-15), so a gap drawn under the
 * price block with nothing after it no longer moves whole to a blank last page (design §4.5).
 */
function priceEndsTheFlow(
  ctx: InvoiceCtx, d: InvoicePdfData, flow: InvoiceFlowBuilders, layout: CanvasLayout, itemContent: ItemContent, price: TableItem,
): boolean {
  return nothingPrintsAfter(layout, price.key, itemContent, (table) => blockChildren(ctx, d, flow, table) !== null);
}

/**
 * A block's node: ONE stack holding the block's children (`blockChildren`), its margins 0, in the one
 * canvas block shape (`drawnBlock`, `pdf/canvas-sheet.ts`): the block's id on the wrapper, and the
 * lateral margin on the zero-gap `columns` node inside it, whose one column, fixed at the drawn width
 * as pdfmake subtracts it from the content width (`drawnBlock`), holds the stack, so every `"*"`
 * column of the grid resolves against it. The margin sits there, never on the stack: when a block
 * breaks across a page, pdfmake rebuilds the new page's width less a level-1 column group's own
 * margin, and a margin on an outer stack is not in that rebuild, so its end handed every block laid
 * out after it a width wider by its left plus right inset, past the right margin (#969; the
 * `canvas-nodes.ts` header holds the mechanism). The column is fixed, never `"*"`, so a child wider
 * than the block (the price rule, a grid narrower than its fixed columns) widens no sibling. Every
 * block takes the wrapper, so an id never lands on a flow node, and so never on a text node (the
 * PARTS and PRICE headings are text nodes), and the order strip's own id stays the row's, an item of
 * the block's inner stack, where `render.ts` measures it. Null when the block has no children; the
 * sheet still emits the block's marks and region.
 *
 * The price block (#589 on a canvas, design §5.2) takes its own ctx: its column starts at its drawn
 * x, so each rule after a group is drawn from the page's left margin less that x (the leaf's
 * `CANVAS_PAGE.margin`) across the flow's content width (`flow.widths.content`), margin to margin
 * whatever the block's x and width. And its END-OF-BLOCK BELT, the flow's end-of-content belt on a
 * canvas: when the block's last node is a rule the flow made (`flow.isPriceRule`, by the node itself,
 * never its shape) and nothing prints after the block (`priceEndsTheFlow`), that rule is replaced
 * by a new one with no space under it, so a last group ending 4 to 5 pt above the band prints no
 * blank last page for the rule's 1 pt. It runs here, before the sheet lays out a JSON copy of the
 * block, in which no node is the flow's rule any more.
 */
function tableBlock(
  ctx: InvoiceCtx, d: InvoicePdfData, flow: InvoiceFlowBuilders, layout: CanvasLayout, itemContent: ItemContent, item: TableItem,
): Content | null {
  const rule = item.key === "price" ? { x1: CANVAS_PAGE.margin - item.box.x, length: flow.widths.content } : null;
  const children = blockChildren(rule === null ? ctx : { ...ctx, priceRule: rule }, d, flow, item);
  if (children === null) return null;
  if (rule !== null && flow.isPriceRule(children.at(-1)) && priceEndsTheFlow(ctx, d, flow, layout, itemContent, item)) {
    children[children.length - 1] = flow.priceRule(0, rule.x1, rule.length);
  }
  return drawnBlock({ stack: children }, item);
}

/** The invoice's belt: the identity, since its profile requires nothing (design §4.3, §4.6). Kept so
 *  the measure's `complete` parameter has the invoice's name, as every canvas document's does. */
export function completeInvoiceCanvas(layout: CanvasLayout): CanvasLayout {
  return layout;
}

/**
 * The invoice's (or credit memo's) one definition, assembled by the shared sheet
 * (`assembleCanvasSheet`, `pdf/canvas-sheet.ts`) over the completed layout from its item node and
 * block: one sheet group, printed through `renderPdf` in one pass (no `overflowTopMargin`), its
 * repeat band, its page-bottom band (the company strip's items) and its page line the sheet's.
 */
export function buildCanvasInvoiceDefinition(
  input: InvoicePdfData, config: TemplateConfig, stored: CanvasLayout, flow: InvoiceFlowBuilders, logoDataUri?: string,
): RenderableDefinition {
  const layout = completeInvoiceCanvas(stored);
  const ctx = canvasCtx(config, layout, flow);
  const itemContent = invoiceItemContent(ctx, input, flow, logoDataUri);
  return assembleCanvasSheet({
    layout,
    pageFooter: config.pageFooter,
    fonts: config.fonts,
    itemContent,
    tableBlock: (item) => tableBlock(ctx, input, flow, layout, itemContent, item),
  });
}

/**
 * The item node the invoice's sheet is assembled with (`buildCanvasInvoiceDefinition`'s own ctx,
 * over the completed layout), for the preview's alone layouts (`aloneLayouts`, `pdf/canvas-sheet.ts`).
 * `invoiceCanvasItemContent` (pdf/invoice.ts, beside the flow's builders) is the one-call form.
 */
export function firstInvoiceItemContent(
  input: InvoicePdfData, config: TemplateConfig, stored: CanvasLayout, flow: InvoiceFlowBuilders, logoDataUri?: string,
): ItemContent {
  const layout = completeInvoiceCanvas(stored);
  return invoiceItemContent(canvasCtx(config, layout, flow), input, flow, logoDataUri);
}
