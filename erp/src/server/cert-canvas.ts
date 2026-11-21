/**
 * The certification's canvas path (design `docs/superpowers/specs/2026-11-10-cert-canvas-design.md`
 * §4.2, §5.1, §5.2): a template whose `config.layout` is not null prints its items where they are
 * drawn and its seven blocks in the flow at their drawn places and widths. The bill of lading's
 * `bol-canvas.ts` is the model; the sheet itself is the shared `pdf/canvas-sheet.ts`.
 *
 * This file holds what is the certification's own: its field families (`certItemContent`), each
 * printing the flow's text for its key through the flow's own functions, so the date knob's slots
 * and the packing list's padding hold with no second rule; its seven blocks (`tableBlock`, each ONE
 * stack of its children in the one canvas block shape, `drawnBlock`, by the wrapper and margin rule
 * below); the lens the blocks are printed through (`canvasCtx`) and its belt (`completeCertCanvas`,
 * the identity: nothing is required). `buildCertDefinition` (pdf/cert.ts) branches here; a null
 * layout never reaches this file. The frozen requirement identity, the bare readings, R14's attn
 * line, the multi-part headings, the signer and the statement at the data seam reach a canvas as
 * they reach the flow: both take the same `CertPdfData`, and the canvas adds no read.
 *
 * This file imports only TYPES from pdf/cert.ts: the flow builders and the flow's widths arrive as
 * one `CertFlowBuilders` object (`CERT_FLOW`), so pdf/cert.ts may import this file with no cycle.
 */
import type { Content, Margins } from "pdfmake/interfaces";
import type { CertCtx, CertFlowBuilders, CertPdfData } from "./pdf/cert";
import type { RenderableDefinition } from "./pdf/render";
import {
  assembleCanvasSheet, defaultLabelOf, drawnBlock, inBoxWidth, labelOf, logoContent, sectionConfigOf, strokeContent,
  textContent, type FieldItem, type ItemContent, type TableItem,
} from "./pdf/canvas-sheet";
import { tableSpec, tablesByY } from "@/lib/template-canvas";
import { CERT_CONTRACT } from "@/lib/template-contracts/cert";
import type { CanvasLayout } from "@/lib/template-contracts/canvas";
import { completeSections, type TemplateConfig } from "@/lib/template-contracts/types";

/**
 * A field item's content, printed as the flow prints the same key, at the item's style (its size,
 * bold and alignment), in the item's box width. The families (design §4.2):
 *
 *  - value alone: `company_name` (the company's name), `footer_address` (its address); their
 *    contract label is "", which the flow never prints, so neither prints a label.
 *  - title: `title` prints its label as its text, so a label override renames it, as in the flow.
 *  - label and value on one line, `${label} ${value}`: `order_no` (the order label), `print_date` and
 *    `entry_date` (the date knob's date, through the flow's `makeCertDate` bound as `ctx.date`, in
 *    every slot either prints in), `po_number`, `packing_list_no` (the flow's six-digit padding, the
 *    label alone when the cert has no shipment), `material`, `footer_phone`.
 *
 * Any other key prints nothing: the blocks' own fields (the profile's `notFields`) and the part
 * lines' columns are never field items, and the validator refuses an unknown key.
 */
function fieldContent(ctx: CertCtx, d: CertPdfData, item: FieldItem, flow: CertFlowBuilders): Content | null {
  const { size, bold, align } = item.style;
  const label = labelOf(CERT_CONTRACT, item);
  const print = (text: string): Content => inBoxWidth(item.box.w, { text, fontSize: size, bold, alignment: align });
  const labelled = (value: string): Content => print(`${label} ${value}`);
  switch (item.key) {
    case "company_name": return print(d.company.name);
    case "footer_address": return print(d.company.address);
    case "title": return print(label);
    case "order_no": return labelled(d.orderLabel);
    case "print_date": return labelled(ctx.date(d.printDate));
    case "entry_date": return labelled(ctx.date(d.entryDate));
    case "po_number": return labelled(d.poNumber);
    case "packing_list_no": return labelled(flow.packingListNo(d.packingListNo));
    case "material": return labelled(d.material);
    case "footer_phone": return labelled(d.company.phone);
    default: return null;
  }
}

/**
 * The certification's item node, the closure its sheet is assembled with: a field through its
 * family (`fieldContent`), a text item as text, the logo fitted (nothing when the version carries no
 * logo bytes, `logoDataUri` undefined), a line or a box stroked. A text-block item prints nothing:
 * the cert's one text block, its statement, is the statement block's (the profile's rule 2 refuses
 * the item). A table is never an item node; a barcode, which the profile refuses, prints nothing.
 */
export function certItemContent(ctx: CertCtx, d: CertPdfData, flow: CertFlowBuilders, logoDataUri?: string): ItemContent {
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
 * The canvas ctx the certification's items and blocks are built from. The blocks' sections resolve
 * through the flow's `sectionView` over `completeSections`, so a block prints exactly as the flow
 * prints it, and the sections no block stands for at the contract's defaults (the field items' labels
 * come from the contract, `labelOf`). THE LENS (design §5.1): the To block is keyed by its FIELD
 * (`to`, held by the parties section) and stands for no section, so it is left out of the sections
 * handed to `sectionView`, which refuses an unknown section; its heading is read from the item
 * itself (`tableBlock`). The logo is the Logo item's, never the header's, so the ctx carries none.
 */
function canvasCtx(config: TemplateConfig, layout: CanvasLayout, flow: CertFlowBuilders): CertCtx {
  const sectionConfigs = completeSections(CERT_CONTRACT, tablesByY(layout)
    .filter((item) => tableSpec(CERT_CONTRACT, item.key)?.keyed !== "field")
    .map((item) => sectionConfigOf(CERT_CONTRACT, item)));
  return {
    fonts: config.fonts,
    num: flow.makeNum(config.formats),
    date: flow.makeCertDate(config.formats),
    sections: new Map(sectionConfigs.map((sc) => [sc.key, flow.sectionView(sc)] as const)),
    logo: null,
  };
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
 * A block's children, by the wrapper and margin rule (design §5.2), which goes by the section's
 * KIND, never by how many nodes a given cert happens to answer:
 *
 *  - one-node: `to` (the flow's To stack, the block's heading, else the parties section's default
 *    label, as its underlined label; the stack's children as the flow builds them, under the
 *    parties' column gap the flow's columns node hands them), `parts` (the
 *    ruled table), `statement` (the wording's one text node), `freeform` (its one text node) and
 *    `signature` (the signature stack, its rule the block's drawn width long): that node with its
 *    own vertical margins zeroed, lateral kept.
 *  - several-node: `requirements` (each requirement's stack, and on a multi-part cert each line
 *    group's heading) and `serials` (each part's list): every node with its margins, so a cert with
 *    ONE requirement keeps its 4 pt top and 6 pt bottom inside the block.
 *
 * Null when the flow answers nothing (no part column shown, no requirement, no serials, empty
 * freeform text, every signature row hidden).
 */
function blockChildren(ctx: CertCtx, d: CertPdfData, flow: CertFlowBuilders, item: TableItem): Content[] | null {
  switch (item.key) {
    // The flow lays the To stack out inside the parties' columns node, whose `columnGap` pdfmake
    // hands down to every nested columns node (a style property), so the city, state and zip print
    // `partiesGap` apart there; the block carries that gap so they print at the flow's x.
    case "to": return [{ stack: flow.toStack(item.heading ?? defaultLabelOf(CERT_CONTRACT, "to"), d), columnGap: flow.widths.partiesGap }];
    case "parts": return oneNode(flow.partsTable(ctx, d)[0]);
    case "statement": return oneNode(flow.statementNode(d));
    case "freeform": return oneNode(flow.freeformNode(ctx, d));
    case "signature": {
      const stack = flow.signatureStack(ctx, d, item.box.w);
      return stack.length === 0 ? null : oneNode({ stack });
    }
    case "requirements": return severalNodes(flow.requirementSection(ctx, d));
    case "serials": return severalNodes(flow.serialBlocks(ctx, d));
    default: return null;
  }
}

/**
 * A block's node: ONE stack holding the block's children (`blockChildren`), its margins 0, in the one
 * canvas block shape (`drawnBlock`, `pdf/canvas-sheet.ts`): the block's id on the wrapper, and the
 * lateral margin on the zero-gap `columns` node inside it, whose one column, fixed at the drawn width
 * as pdfmake subtracts it from the content width (`drawnBlock`), holds the stack. The margin sits
 * there, never on the stack: when a block breaks across a page, pdfmake rebuilds the new page's width
 * less a level-1 column group's own margin, and a margin on an outer stack is not in that rebuild, so
 * its end handed every block laid out after it a width wider by its left plus right inset, past the
 * right margin (#969; the `canvas-nodes.ts` header holds the mechanism). Every block takes the
 * wrapper, so an id never lands on a flow node, and so never on a text node (the statement and
 * freeform blocks print text nodes). Null when the block has no children; the sheet still emits the
 * block's marks and region.
 */
function tableBlock(ctx: CertCtx, d: CertPdfData, flow: CertFlowBuilders, item: TableItem): Content | null {
  const children = blockChildren(ctx, d, flow, item);
  if (children === null) return null;
  return drawnBlock({ stack: children }, item);
}

/** The certification's belt: the identity, since its profile requires nothing (design §4.3, §4.6).
 *  Kept so the measure's `complete` parameter has the certification's name, as the ticket's and the
 *  bill of lading's do. */
export function completeCertCanvas(layout: CanvasLayout): CanvasLayout {
  return layout;
}

/**
 * The certification's one definition, assembled by the shared sheet (`assembleCanvasSheet`,
 * `pdf/canvas-sheet.ts`) over the completed layout from its item node and block: one sheet group,
 * printed through `renderPdf` in one pass (no `overflowTopMargin`), its repeat band, its page-bottom
 * band (the company strip's items) and its page line the sheet's.
 */
export function buildCanvasCertDefinition(
  input: CertPdfData, config: TemplateConfig, stored: CanvasLayout, flow: CertFlowBuilders, logoDataUri?: string,
): RenderableDefinition {
  const layout = completeCertCanvas(stored);
  const ctx = canvasCtx(config, layout, flow);
  return assembleCanvasSheet({
    layout,
    pageFooter: config.pageFooter,
    fonts: config.fonts,
    itemContent: certItemContent(ctx, input, flow, logoDataUri),
    tableBlock: (item) => tableBlock(ctx, input, flow, item),
  });
}

/**
 * The item node the certification's sheet is assembled with (`buildCanvasCertDefinition`'s own ctx,
 * over the completed layout), for the preview's alone layouts (`aloneLayouts`, `pdf/canvas-sheet.ts`).
 * `certCanvasItemContent` (pdf/cert.ts, beside the flow's builders) is the one-call form.
 */
export function firstCertItemContent(
  input: CertPdfData, config: TemplateConfig, stored: CanvasLayout, flow: CertFlowBuilders, logoDataUri?: string,
): ItemContent {
  const layout = completeCertCanvas(stored);
  return certItemContent(canvasCtx(config, layout, flow), input, flow, logoDataUri);
}
