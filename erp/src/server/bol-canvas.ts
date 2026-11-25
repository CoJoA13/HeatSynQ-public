/**
 * The bill of lading's canvas path (design `docs/superpowers/specs/2026-11-09-bol-canvas-design.md`
 * §4.2, §5.1, §5.2): a template whose `config.layout` is not null prints its items where they are
 * drawn and its three blocks in the flow at their drawn places and widths. The traveler's
 * `traveler-canvas.ts` and the ticket's `shipping-ticket-canvas.ts` are the models; the sheet itself
 * is the shared `pdf/canvas-sheet.ts`.
 *
 * This file holds what is the bill of lading's own: its field families and its wordings
 * (`bolItemContent`), its three blocks (`tableBlock`: the PO list keyed by its field, the TRV list,
 * the freight table with its sidebar), the lens the blocks are printed through (`canvasCtx`) and its
 * belt (`completeBolCanvas`, the identity: nothing is required). `buildBolDefinition` (pdf/bol.ts)
 * branches here; a null layout never reaches this file. Every figure prints through the flow's own
 * functions at the flow's own widths, so the date knob's slot, the PO list's join, the form's rules,
 * W15's "lb", the gross-else-net word, #557's box and the type the flow prints hold with no second
 * rule.
 *
 * This file imports only TYPES from pdf/bol.ts, which imports it: the flow builders and the flow's
 * widths arrive as one `BolFlowBuilders` object (`BOL_FLOW`, which carries `BOL_WIDTHS` as `widths`),
 * so there is no import cycle.
 */
import type { Column, Content } from "pdfmake/interfaces";
import type { BolData, BolFlowBuilders, Ctx, LabelStyle } from "./pdf/bol";
import type { RenderableDefinition } from "./pdf/render";
import {
  assembleCanvasSheet, defaultLabelOf, drawnBlock, inBoxWidth, labelOf, logoContent, sectionConfigOf, strokeContent, textContent,
  type FieldItem, type ItemContent, type TableItem, type TextBlockItem,
} from "./pdf/canvas-sheet";
import { tableHeadingKey, tableSpec, tablesByY } from "@/lib/template-canvas";
import { BOL_CANVAS, BOL_CONTRACT } from "@/lib/template-contracts/bol";
import type { CanvasLayout } from "@/lib/template-contracts/canvas";
import { completeSections, type TemplateConfig } from "@/lib/template-contracts/types";

/** The keys printed as a form rule: the label in the flow's label column, the value on a rule taking
 *  the rest of the box. */
export const FORM_RULE_FIELDS = ["pro_number", "bol_number", "scac_code", "destination", "destination_state", "destination_zip"] as const;
/** The keys printed as a blank write-in rule beside their label. */
export const WRITE_IN_FIELDS = ["delivering_carrier", "vehicle_initials", "vehicle_no", "shipper_per", "agent_per", "po_address"] as const;
/** The keys printed on a rule, by family; the profile's `ruledFields` is held to their union. */
export const RULED_FIELDS = [...FORM_RULE_FIELDS, ...WRITE_IN_FIELDS, "carrier_name", "consigned_to"] as const;

/** The wordings a block prints itself (the freight block's sidebar): never a text-block item. */
const BLOCK_WORDINGS = new Set(BOL_CANVAS.tables.flatMap((spec) => spec.textBlocks ?? []));
/** The wordings a text-block item prints: the contract's, less the blocks' own. */
const PLACEABLE_WORDINGS = new Set(BOL_CONTRACT.textBlocks.map((t) => t.key).filter((key) => !BLOCK_WORDINGS.has(key)));

const ZERO: [number, number, number, number] = [0, 0, 0, 0];

/** A flow node with its margins zeroed: the item's box carries the drawn distances. */
function unmargined(node: Content): Content {
  return { ...(node as object), margin: ZERO } as Content;
}

/**
 * A field item's content, printed as the flow prints the same key, at the item's style (its size,
 * bold and alignment, "the item's style" below). The families (design §4.2), each in the item's box
 * width:
 *
 *  - label as text (`original_label`, `title`): the label at the item's style.
 *  - form rule (`pro_number`, `bol_number`, `scac_code`): the flow's `labeledRule`, the label at the
 *    item's style in the flow's 110 pt column, the value at the flow's 8 pt centred on a rule taking
 *    the rest of the box, its 3 pt bottom margin zeroed. `destination` (the city), `destination_state`
 *    and `destination_zip`: the flow's `ruledPair` with their own label columns, the value at 9 pt
 *    (the state and the zip centred) on a rule taking the rest of the box.
 *  - write-in rule (`delivering_carrier`, `vehicle_initials`, `vehicle_no`, `shipper_per`,
 *    `agent_per`, `po_address`): the label at the item's style beside a blank rule taking the rest of
 *    the box, after the flow's gap (the signatures' 6 pt, the others' 4).
 *  - carrier line (`carrier_name`): the flow's `carrierPair`, the label in the flow's 70 pt column at
 *    its 9 pt bold, the carrier (one space when there is none) at the item's style on a rule taking the
 *    rest of the box (owner ruling R1, 2026-11-24: the label printed under the rule before; the
 *    item's style stays the name's, so a stored item prints its name as it did).
 *  - ship-from line (`ship_from`): the flow's one sentence at the item's size, the date bold always
 *    and the item's bold on the rest, its alignment not read; every `ship_from` item prints the date
 *    knob's date (owner ruling R2, 2026-11-24: four columns before).
 *  - consignee block (`consigned_to`): the flow's two consignee rows, the label at the item's style,
 *    the caption beside the first line taking the box's width past the second rule.
 *
 * Any other key prints nothing: the blocks' own fields (`consignee_ref`, `trv_no`,
 * `collect_checkbox`) are never field items, and the validator refuses an unknown key.
 */
function fieldContent(ctx: Ctx, d: BolData, item: FieldItem, flow: BolFlowBuilders): Content | null {
  const W = flow.widths;
  const { size, bold, align } = item.style;
  const style: LabelStyle = { fontSize: size, bold, alignment: align };
  const label = labelOf(BOL_CONTRACT, item);
  const width = item.box.w;
  const inBox = (node: Content): Content => inBoxWidth(width, node);
  /** A label column beside a value (or a blank write-in, `value` null) on a rule taking the rest. */
  const ruled = (labelWidth: number, gap: number, value: string | null, valueSize?: number, valueAlign?: "left" | "center"): Content => {
    const rest = width - labelWidth - gap;
    const columns: Column[] = flow.ruledPair({
      label, labelWidth, labelStyle: style, value, valueSize, valueAlign, columnWidth: rest, ruleWidth: rest,
    });
    return inBox({ columns, columnGap: gap });
  };

  switch (item.key) {
    case "original_label":
    case "title": return inBox({ text: label, fontSize: size, bold, alignment: align });
    case "pro_number":
    case "bol_number":
    case "scac_code": {
      const value = item.key === "pro_number" ? d.proNumber : item.key === "bol_number" ? String(d.bolNumber) : d.scacCode;
      return inBox(unmargined(flow.labeledRule(label, value, W.formLabel, width - W.formLabel - W.formGap, style)));
    }
    case "destination": return ruled(W.destinationLabel, W.rowGap, d.consignee.city, 9);
    case "destination_state": return ruled(W.stateLabel, W.rowGap, d.consignee.state, 9, "center");
    case "destination_zip": return ruled(W.zipLabel, W.rowGap, d.consignee.zip, 9, "center");
    case "delivering_carrier": return ruled(W.deliveringLabel, W.rowGap, null);
    case "vehicle_initials": return ruled(W.initialsLabel, W.rowGap, null);
    case "vehicle_no": return ruled(W.vehicleNoLabel, W.rowGap, null);
    case "shipper_per":
    case "agent_per": return ruled(W.signLabel, W.signGap, null);
    case "po_address": return ruled(W.poAddressLabel, W.rowGap, null);
    case "carrier_name": return inBox({
      columns: flow.carrierPair(d.carrierName, label, width - W.carrierLabel - W.rowGap, style), columnGap: W.rowGap,
    });
    // The date knob's slot: every ship-from item prints it.
    case "ship_from": return inBox(unmargined(flow.shipFromLine(ctx, d, size, bold)));
    case "consigned_to": {
      const caption = width - W.consignedLabel - W.consignedRule - 2 * W.rowGap;
      // A belt: rule 4 holds the box to its least width (`BOL_LEAST_WIDTHS`), so the caption is never
      // under 4.5 pt and this max never fires. The flow's caption column carries its own 8 pt inset, so
      // at the least width the caption sets one character a line (design §4.1 addition 5's letter),
      // which warning (b) reports on a measured page.
      return inBox({ stack: flow.consigneeRows(label, style, d, Math.max(0, caption)) });
    }
    default: return null;
  }
}

/** A text-block item: the wording as the bill of lading's flow prints it, ONE text node at the
 *  item's style, line breaks kept, no paragraph split and no paragraph margin (design §4.2, call 11;
 *  the shared `textBlockContent` splits on blank lines, which is the ticket's flow, not this one). A
 *  wording a block prints itself prints nothing as an item. */
function wordingContent(ctx: Ctx, item: TextBlockItem): Content | null {
  if (!PLACEABLE_WORDINGS.has(item.key)) return null;
  const { size, bold, align } = item.style;
  return inBoxWidth(item.box.w, { text: ctx.text(item.key), fontSize: size, bold, alignment: align });
}

/**
 * The bill of lading's item node, the closure its sheet is assembled with: a field through its family
 * (`fieldContent`), a text item as text, a placeable wording as the flow prints it, the logo fitted
 * (nothing when the version carries no logo bytes, `logoDataUri` undefined), a line or a box stroked.
 * A table is never an item node; a barcode, which the profile refuses, prints nothing.
 */
export function bolItemContent(ctx: Ctx, d: BolData, flow: BolFlowBuilders, logoDataUri?: string): ItemContent {
  return (item) => {
    switch (item.kind) {
      case "field": return fieldContent(ctx, d, item, flow);
      case "text": return textContent(item);
      case "textBlock": return wordingContent(ctx, item);
      case "logo": return logoContent(item, logoDataUri);
      case "line":
      case "box": return strokeContent(item);
      default: return null;
    }
  };
}

/**
 * The canvas ctx the bill of lading's items and blocks are built from. The blocks' sections resolve
 * through the flow's `sectionView` over `completeSections`, so a block prints exactly as the flow
 * prints it, and the sections no block stands for at the contract's defaults (the field items' labels
 * come from the contract, `labelOf`). THE LENS (design §4.1 addition 1): a block keyed by a FIELD
 * (`consignee_ref`, keyed by the header section's field) stands for no section, so it is left out
 * of the sections handed to `sectionView`, which refuses an unknown section; its heading is read
 * from the item itself (`tableBlock`). The logo is the Logo item's, never the header's, so the ctx
 * carries none.
 */
function canvasCtx(config: TemplateConfig, layout: CanvasLayout, flow: BolFlowBuilders): Ctx {
  const sectionConfigs = completeSections(BOL_CONTRACT, tablesByY(layout)
    .filter((item) => tableSpec(BOL_CONTRACT, item.key)?.keyed !== "field")
    .map((item) => sectionConfigOf(BOL_CONTRACT, item)));
  return {
    fonts: config.fonts,
    num: flow.makeNum(config.formats),
    bolDate: flow.makeBolDate(config.formats),
    // The flow's own wording rule (`textOf`): a raw config omitting a key prints the contract's
    // text, never "undefined". The freight block's sidebar prints its three wordings through it.
    text: flow.textOf(config.textBlocks),
    sections: new Map(sectionConfigs.map((sc) => [sc.key, flow.sectionView(sc)] as const)),
    logo: null,
  };
}

/**
 * A block's node: the flow builder's node for it in the one canvas block shape (`drawnBlock`,
 * `pdf/canvas-sheet.ts`): the block's id on the wrapper, the node's own margin replaced by
 * [0, 0, 0, 0] (the spacers carry the drawn vertical distances) and the lateral margin on the
 * block's zero-gap `columns` node, whose one column is the drawn width as pdfmake subtracts it from
 * the content width (`drawnBlock`), so every `"*"` resolves against it. pdfmake rebuilds a broken
 * level-1 group's width from that group's own margin, so the margin sits there. The bill of lading
 * printed correctly before (#969): each of its three builders answers a `columns` node, which held
 * the margin itself as a level-1 group; it takes the shared shape so every canvas block is one shape.
 *
 *  - `consignee_ref`: the flow's `labeledRule`, the block's heading (else the header section's
 *    default label) in the flow's 110 pt label column at its 7.5 pt bold, the PO list (`poList`, its
 *    blank-skipping join; a single space when every PO is blank) at its 8 pt on a rule taking the rest
 *    of the drawn width after the flow's 4 pt gap. A table carries no style (call 12).
 *  - `trv`: the flow's TRV list node (its label the block's heading, through the lens), WITHOUT the
 *    rule the flow prints under it: on a canvas that rule is a static (design §4.2).
 *  - `freight`: the flow's `freightBlock` node, the table in its `"*"` column beside the sidebar, the
 *    Collect checkbox toggle and the five columns through the section view; with every column hidden
 *    the sidebar still prints.
 *
 * Null when the flow builder answers nothing (the canvas then prints no block, and the sheet still
 * emits the block's marks and region). A builder answering more than one node is a fault: a block is
 * one node.
 */
function tableBlock(ctx: Ctx, d: BolData, flow: BolFlowBuilders, item: TableItem): Content | null {
  const W = flow.widths;
  const nodes: Content[] = item.key === "consignee_ref"
    ? [flow.labeledRule(
      item.heading ?? defaultLabelOf(BOL_CONTRACT, tableHeadingKey(BOL_CONTRACT, item.key) ?? item.key),
      flow.poList(d), W.formLabel, item.box.w - W.formLabel - W.formGap,
    )]
    : item.key === "trv" ? [flow.trvListNode(ctx, d)].filter((node): node is Content => node !== null)
      : item.key === "freight" ? flow.freightBlock(ctx, d)
        : [];
  if (nodes.length > 1) throw new Error(`A bill of lading block answers one node; ${item.key} answered ${nodes.length}.`);
  const node = nodes[0];
  if (node === undefined) return null;
  return drawnBlock({ ...(node as object) }, item);
}

/** The bill of lading's belt: the identity, since its profile requires nothing (design §4.3, §4.6).
 *  Kept so the measure's `complete` parameter has the bill of lading's name, as the ticket's
 *  `completeTicketCanvas` does. */
export function completeBolCanvas(layout: CanvasLayout): CanvasLayout {
  return layout;
}

/**
 * The bill of lading's one definition, assembled by the shared sheet (`assembleCanvasSheet`,
 * `pdf/canvas-sheet.ts`) over the completed layout from its item node and block: one sheet group,
 * printed through `renderPdf` in one pass (no `overflowTopMargin`), its repeat band and page line the
 * sheet's.
 */
export function buildCanvasBolDefinition(
  input: BolData, config: TemplateConfig, stored: CanvasLayout, flow: BolFlowBuilders, logoDataUri?: string,
): RenderableDefinition {
  const layout = completeBolCanvas(stored);
  const ctx = canvasCtx(config, layout, flow);
  return assembleCanvasSheet({
    layout,
    pageFooter: config.pageFooter,
    fonts: config.fonts,
    itemContent: bolItemContent(ctx, input, flow, logoDataUri),
    tableBlock: (item) => tableBlock(ctx, input, flow, item),
  });
}

/**
 * The item node the bill of lading's sheet is assembled with (`buildCanvasBolDefinition`'s own ctx,
 * over the completed layout), for the preview's alone layouts (`aloneLayouts`, `pdf/canvas-sheet.ts`).
 * `bolCanvasItemContent` (pdf/bol.ts, beside the flow's builders) is the one-call form.
 */
export function firstBolItemContent(
  input: BolData, config: TemplateConfig, stored: CanvasLayout, flow: BolFlowBuilders, logoDataUri?: string,
): ItemContent {
  const layout = completeBolCanvas(stored);
  return bolItemContent(canvasCtx(config, layout, flow), input, flow, logoDataUri);
}
