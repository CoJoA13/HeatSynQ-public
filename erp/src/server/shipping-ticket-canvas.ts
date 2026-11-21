/**
 * The shipping ticket's canvas path (design `docs/superpowers/specs/2026-11-08-shipping-ticket-canvas-design.md`
 * §4.2, §5.1, §5.2): a template whose `config.layout` is not null prints its items where they are
 * drawn, its five tables in the flow at their drawn places and widths, and the items anchored below
 * a table riding that table's rendered bottom. `buildShippingTicketDefinitions` (pdf/shipping-ticket.ts)
 * branches here; a null layout never reaches this file. The traveler's `traveler-canvas.ts` is the
 * model.
 *
 * The sheet itself (the detached page-top wrappers, the spacer, the float regions, the repeat and
 * page-bottom bands, the margins and `CANVAS_IDS`) is shared by every canvas document and lives in
 * `pdf/canvas-sheet.ts`. This file holds what is the ticket's own: its field families
 * (`fieldContent`), its table blocks (the flow's own section builders at the drawn place and
 * width), the item node those make (`ticketItemContent`) and its belt (`completeTicketCanvas`, the
 * identity: the ticket's profile requires nothing).
 *
 * Every figure prints through the flow's own functions, so the two date styles (the header's
 * `ship_date` takes the format knob, the strip's `shipped_on` is `paddedDate` unconditionally), the
 * units on every weight (`lb`/`lbEach`, W15, through the flow's cells and `totalWeightText`), the
 * stacked Sold To name (R14) and the number formats hold with no second rule.
 *
 * This file imports only TYPES from pdf/shipping-ticket.ts, which imports this file: the flow
 * builders arrive as one `TicketFlowBuilders` object that file assembles at its branch (no import
 * cycle).
 */
import type { Content } from "pdfmake/interfaces";
import type {
  Ctx, TicketData, TicketDocType, TicketFlowBuilders, TicketParty,
} from "./pdf/shipping-ticket";
import type { RenderableDefinition } from "./pdf/render";
import {
  assembleCanvasSheet, boxedCell, drawnBlock, inBoxWidth, labelOf, logoContent, sectionConfigOf, strokeContent,
  textBlockContent, textContent, type FieldItem, type ItemContent, type TableItem,
} from "./pdf/canvas-sheet";
import { tablesByY } from "@/lib/template-canvas";
import type { CanvasLayout } from "@/lib/template-contracts/canvas";
import { SHIPPER_CONTRACT } from "@/lib/template-contracts/shipper";
import { MOS_SHIPPER_CONTRACT } from "@/lib/template-contracts/mos-shipper";
import { completeSections, type TemplateConfig, type TemplateContract } from "@/lib/template-contracts/types";
import { weightTotals, type WeightTotals } from "@/lib/net-weight";

const CONTRACTS: Record<TicketDocType, TemplateContract> = {
  SHIPPER: SHIPPER_CONTRACT,
  MOS_SHIPPER: MOS_SHIPPER_CONTRACT,
};

const VALUE_ONLY = new Set(["company_name", "company_address", "company_phone"]);
const BANNERS = new Set(["tear_shipped_complete"]);
const PAIR = new Set(["tear_total_qty", "tear_total_weight"]);
/** The party boxes' keys, printed in a border at the item's box: the ticket profile's `boxedFields`,
 *  which the designer draws the border from (a test holds the two lists to each other). */
export const PARTY_FIELDS = ["sold_to", "ship_to"] as const;

/**
 * A field item's content, printed as the flow prints the same key, at the item's style. The
 * families (design §4.2):
 *
 *  - value alone (`company_name`, `company_address`, `company_phone`): the value, the label unused
 *    as the flow leaves it; `title` prints its label as its text.
 *  - label and value on one line: `order_no` (the order label), `ship_date` (the format knob's
 *    date), `tear_order_no` (the bare number), `tear_sold_to` (the customer's name alone),
 *    `shipped_on` (`paddedDate`, NEVER the knob: the two-date-styles trap), `received_by` and
 *    `received_date` (the label and the flow's write-in rule).
 *  - the strip's banner (`tear_shipped_complete`): the label when the order shipped complete,
 *    else nothing. The totals block's banner (`shipped_complete`) is the totals table's column,
 *    never a field item.
 *  - the strip's pair (`tear_total_qty`, `tear_total_weight`): a borderless row, the label bold at
 *    the item's size and the figure at the template's base size in a 62 pt right column, as the
 *    flow's boxed pair prints them; the box around the pair is a static (the seed's Box and Lines).
 *  - party boxes (`sold_to`, `ship_to`): the flow's address block, its label at the item's size,
 *    boxed at the item's box, which is a minimum (a long name or street grows it).
 *
 * A key outside these prints nothing: the validator refuses it before a layout is stored.
 */
function fieldContent(
  ctx: Ctx, d: TicketData, totals: WeightTotals, item: FieldItem, flow: TicketFlowBuilders, config: TemplateConfig,
): Content | null {
  const { size, bold, align } = item.style;
  // The contract of the docType the ctx was resolved against.
  const label = labelOf(CONTRACTS[ctx.docType], item);
  const line = (text: string): Content => inBoxWidth(item.box.w, { text, fontSize: size, bold, alignment: align });

  if (VALUE_ONLY.has(item.key)) {
    return line(item.key === "company_name" ? d.company.name
      : item.key === "company_address" ? d.company.address : d.company.phone);
  }
  switch (item.key) {
    case "title": return line(label);
    case "order_no": return line(`${label} ${d.orderLabel}`);
    // The ONE place the date knob lands (the two-date-styles trap).
    case "ship_date": return line(`${label} ${flow.makeHeaderDate(config.formats)(d.shipDate)}`);
    case "tear_order_no": return line(`${label} ${d.orderNumber}`);
    case "tear_sold_to": return line(`${label} ${d.soldTo.name}`);
    // paddedDate, NEVER the header's date: the two-date-styles trap.
    case "shipped_on": return line(`${label} ${flow.paddedDate(d.shipDate)}`);
    case "received_by": return line(`${label} ${flow.RECEIVED_BY_RULE}`);
    case "received_date": return line(`${label} ${flow.RECEIVED_DATE_RULE}`);
    default: break;
  }
  if (BANNERS.has(item.key)) return d.shippedComplete ? line(label) : null;
  if (PAIR.has(item.key)) {
    const figure = item.key === "tear_total_qty"
      ? flow.makeNum2(config.formats)(d.totalQty)
      : flow.totalWeightText(ctx, totals.netCents);
    return inBoxWidth(item.box.w, {
      columns: [
        { width: "*", text: label, bold: true, fontSize: size },
        { width: 62, text: figure, alignment: "right", fontSize: config.fonts.baseSize },
      ],
    });
  }
  if ((PARTY_FIELDS as readonly string[]).includes(item.key)) {
    const party: TicketParty = item.key === "sold_to" ? d.soldTo : d.shipTo;
    return boxedCell(item.box, flow.partyLines(label, party, size));
  }
  return null;
}

/**
 * The ticket's item node for one ticket, the closure its sheet is assembled with (and the preview's
 * alone layouts are built with): a field through its family (`fieldContent`), a text item as text,
 * the liability wording's text block from the config's Wording text, the logo fitted (nothing when
 * the version carries no logo bytes, `logoDataUri` undefined), a line or a box stroked. A table is
 * never an item node; a barcode, which the ticket's profile refuses, and a text block of another key
 * print nothing.
 */
export function ticketItemContent(
  ctx: Ctx, d: TicketData, totals: WeightTotals, flow: TicketFlowBuilders, config: TemplateConfig,
  logoDataUri?: string,
): ItemContent {
  return (item) => {
    switch (item.kind) {
      case "field": return fieldContent(ctx, d, totals, item, flow, config);
      case "text": return textContent(item);
      case "textBlock":
        return item.key === "shipper_liability_text" ? textBlockContent(item, config.textBlocks[item.key] ?? "") : null;
      case "logo": return logoContent(item, logoDataUri);
      case "line":
      case "box": return strokeContent(item);
      default: return null;
    }
  };
}

/** A table's block: the flow builder's node for its section in the one canvas block shape
 *  (`drawnBlock`, `pdf/canvas-sheet.ts`): the table's id on the wrapper, the node's own margin
 *  replaced by [0, 0, 0, 0] (the spacers carry the drawn vertical distances) and the lateral margin
 *  on the block's zero-gap `columns` node, whose one column is the drawn width as pdfmake subtracts
 *  it from the content width (`drawnBlock`), so every `"*"` resolves against it (the containers'
 *  fold, each copy against half of it, included). The margin sits there because pdfmake rebuilds a
 *  broken level-1 group's width from that group's own margin: on the flow's own node, a totals block
 *  drawn narrower than the content that broke across a page handed every node after it a width wider
 *  by its two side margins (#969). The totals block loses its `unbreakable` mark, deleted on the
 *  flow's node before it is wrapped, and any `ticket-totals` id (#673's measure), which `drawnBlock`
 *  deletes: on a canvas the region's spacer and the validator's bound do that block's job (design
 *  §4.5, §5.2).
 *
 *  Null when the flow builder answers nothing (every column hidden, the serial list with no flagged
 *  serial, a totals block with the banner and every row left out): the canvas then prints no block,
 *  the flow's own convention, and the sheet still emits the table's marks and region. */
function tableBlock(
  ctx: Ctx, d: TicketData, totals: WeightTotals, flow: TicketFlowBuilders, item: TableItem,
): Content | null {
  const { docType } = ctx;
  const nodes = item.key === "field_strip" ? flow.fieldStrip(ctx, docType, d)
    : item.key === "lines" ? flow.linesTable(ctx, docType, d)
      : item.key === "containers" ? flow.containersTable(ctx, docType, d)
        : item.key === "serials" ? flow.serialsBlock(ctx, d)
          : item.key === "totals" ? flow.totalsBlock(ctx, d, totals)
            : [];
  if (nodes.length > 1) throw new Error(`A ticket table block answers one node; ${item.key} answered ${nodes.length}.`);
  const node = nodes[0];
  if (node === undefined) return null;
  // The sheet copies the block (`assembleCanvasSheet`), so the containers table's heading cells,
  // one object per column in both copies of the fold, each print.
  delete (node as { unbreakable?: boolean }).unbreakable;
  return drawnBlock(node as object, item);
}

/** The ticket's belt: the identity, since its profile requires nothing (design §4.3, §5.2). Kept so
 *  the measure's `complete` parameter has the ticket's name, as `completeCanvas` is the traveler's. */
export function completeTicketCanvas(layout: CanvasLayout): CanvasLayout {
  return layout;
}

/** The canvas ctx every ticket's items and tables are built from: the tables' sections resolved
 *  through the flow's `sectionView` over `completeSections`, so a table prints exactly as the flow
 *  prints it, and the sections no table stands for at the contract's defaults (the field items'
 *  default labels come from the contract, `labelOf`). The logo is the Logo item's, never the
 *  header's, so the ctx carries none. */
function canvasCtx(docType: TicketDocType, config: TemplateConfig, layout: CanvasLayout, flow: TicketFlowBuilders): Ctx {
  const contract = CONTRACTS[docType];
  const sectionConfigs = completeSections(contract, tablesByY(layout).map((item) => sectionConfigOf(contract, item)));
  return {
    docType,
    fonts: config.fonts,
    num: flow.makeNum(config.formats),
    num2: flow.makeNum2(config.formats),
    headerDate: flow.makeHeaderDate(config.formats),
    sections: new Map(sectionConfigs.map((sc) => [sc.key, flow.sectionView(docType, sc)] as const)),
    logo: null,
  };
}

/** Net, tare and gross for one ticket's order, from its rows on the shipment, as the flow works them
 *  out (`prepareTickets`): the one rule is `weightTotals`. */
function ticketTotals(d: TicketData): WeightTotals {
  return weightTotals({ lineWeights: d.lines.map((l) => l.pounds), containers: d.containers });
}

/**
 * One definition per ticket, as `buildShippingTicketDefinitions` gives the flow path, each assembled
 * by the shared sheet (`assembleCanvasSheet`, `pdf/canvas-sheet.ts`) over the completed layout from
 * the ticket's item node and table block for that ticket, so a continuation page names its own
 * order.
 */
export function buildCanvasTicketDefinitions(
  input: TicketData[], docType: TicketDocType, config: TemplateConfig, stored: CanvasLayout,
  flow: TicketFlowBuilders, logoDataUri?: string,
): RenderableDefinition[] {
  const layout = completeTicketCanvas(stored);
  const ctx = canvasCtx(docType, config, layout, flow);
  return input.map((d) => {
    const totals = ticketTotals(d);
    return assembleCanvasSheet({
      layout,
      pageFooter: config.pageFooter,
      fonts: config.fonts,
      itemContent: ticketItemContent(ctx, d, totals, flow, config, logoDataUri),
      tableBlock: (item) => tableBlock(ctx, d, totals, flow, item),
    });
  });
}

/**
 * The item node the FIRST ticket is assembled with (`buildCanvasTicketDefinitions`' own ctx, over
 * the completed layout), for the preview's alone layouts (`aloneLayouts`, `pdf/canvas-sheet.ts`),
 * which measure the first sheet group as the preview's measure does. `ticketCanvasItemContent`
 * (pdf/shipping-ticket.ts, beside the flow's builders) is the one-call form.
 */
export function firstTicketItemContent(
  input: TicketData[], docType: TicketDocType, config: TemplateConfig, stored: CanvasLayout,
  flow: TicketFlowBuilders, logoDataUri?: string,
): ItemContent {
  if (input.length === 0) throw new Error("A shipment prints at least one ticket.");
  const layout = completeTicketCanvas(stored);
  const ctx = canvasCtx(docType, config, layout, flow);
  return ticketItemContent(ctx, input[0], ticketTotals(input[0]), flow, config, logoDataUri);
}
