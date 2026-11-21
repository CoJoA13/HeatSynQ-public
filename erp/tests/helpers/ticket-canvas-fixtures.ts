import { SHIPPER_CONTRACT, TICKET_ROW_FLOOR } from "@/lib/template-contracts/shipper";
import { defaultTableColumns } from "@/lib/template-canvas";
import type { CanvasAnchor, CanvasItem, CanvasLayout } from "@/lib/template-contracts/canvas";
import { layoutOf } from "./canvas-fixtures";

type Over<K extends CanvasItem["kind"]> = Partial<Extract<CanvasItem, { kind: K }>>;

/** A ticket field item, page-top at the left margin unless `over` says otherwise. */
export function ticketField(key: string, over: Over<"field"> = {}): Extract<CanvasItem, { kind: "field" }> {
  return {
    id: `field-${key}`, kind: "field", key, label: null,
    box: { x: 24, y: 24, w: 200, h: 12 }, anchor: { kind: "page-top" }, repeat: false,
    style: { size: 8, bold: false, align: "left" }, ...over,
  };
}

type TicketTable = "field_strip" | "lines" | "containers" | "serials" | "totals";
/** The standard layout's stack: each table's drawn top and height, and the table it rides. */
const TABLE_BOXES: Record<TicketTable, { y: number; h: number }> = {
  field_strip: { y: 136, h: 30 },
  lines: { y: 172, h: 30 },
  containers: { y: 208, h: 30 },
  serials: { y: 244, h: TICKET_ROW_FLOOR },
  totals: { y: 310, h: 80 },
};
const ABOVE: Record<TicketTable, TicketTable | null> = {
  field_strip: null, lines: "field_strip", containers: "lines", serials: "containers", totals: "serials",
};

/** A ticket table, full width at its slot in the standard stack, its columns the profile's
 *  (`defaultTableColumns`: a rows block's rows, the serial list's none). */
export function ticketTable(key: TicketTable, over: Over<"table"> = {}): Extract<CanvasItem, { kind: "table" }> {
  const above = ABOVE[key];
  const anchor: CanvasAnchor = above ? { kind: "below-table", table: above } : { kind: "page-top" };
  return {
    id: `table-${key}`, kind: "table", key, heading: null, columns: defaultTableColumns(SHIPPER_CONTRACT, key),
    box: { x: 24, y: TABLE_BOXES[key].y, w: 564, h: TABLE_BOXES[key].h }, anchor, repeat: false, ...over,
  };
}

/** A text-block item, the liability wording's size (the Standard's small size, 5.5). */
export function textBlock(key: string, over: Over<"textBlock"> = {}): Extract<CanvasItem, { kind: "textBlock" }> {
  return {
    id: `text-block-${key}`, kind: "textBlock", key,
    box: { x: 24, y: 4, w: 564, h: 40 }, anchor: { kind: "below-table", table: "serials" }, repeat: false,
    style: { size: 5.5, bold: false, align: "left" }, ...over,
  };
}

const BELOW_SERIALS: CanvasAnchor = { kind: "below-table", table: "serials" };
const BELOW_TOTALS: CanvasAnchor = { kind: "below-table", table: "totals" };

function staticLine(id: string, box: { x: number; y: number; w: number; h: number }, weight: number): CanvasItem {
  return { id, kind: "line", box, anchor: BELOW_TOTALS, repeat: false, weight };
}

/**
 * The shipping ticket's standard arrangement, all inside the usable area (24..588 across, 24..768
 * down), passing every canvas rule and with no two drawn boxes overlapping. The header is page-top
 * (the order number repeats; it sits off the left margin, so it never meets "(continued)" at the
 * repeat band's bottom-left, 24..84 × 26..36), the two party boxes under it (66..130), then the five
 * tables stacked by y: Order fields 136..166, Part lines 172..202, Containers 208..238, the serial
 * list 244..259 and Totals 310..390, each after the first anchored below the one above. The
 * liability wording hangs 4 pt under the serial list (drawn 263..303), in the gap before Totals.
 *
 * The tear-off strip hangs below Totals (drawn from 390): a 1.5 pt rule at 396, the order number
 * and the banner on the row 402..414, the boxed pair at the right (its Box 384..588 × 400..432, the
 * two rows 402..414 and 418..430 in the label column), Received by and Date at 440..452, Sold To
 * and Shipped ON at 458..470. The pair's two Lines divide it without meeting each other, the Box's
 * ink or the rows: the vertical one before the figure column (x 522, the Box's height inset by 1 pt
 * at each end), the horizontal one between the rows across the label column alone (it would cross
 * the vertical one otherwise, which the warnings report as an overlap).
 *
 * The no-overlap proof runs through `canvasWarnings`, which skips table pairs; rule 5 (the stacking
 * rule, run by the same tests) refuses any two tables overlapping in y.
 */
export function standardTicketLayout(): CanvasLayout {
  const header = [
    ticketField("company_name", { box: { x: 24, y: 24, w: 250, h: 14 }, style: { size: 11, bold: true, align: "left" } }),
    ticketField("title", { box: { x: 24, y: 42, w: 250, h: 20 }, style: { size: 16, bold: true, align: "left" } }),
    ticketField("order_no", { box: { x: 280, y: 24, w: 140, h: 12 }, repeat: true }),
    ticketField("ship_date", { box: { x: 280, y: 40, w: 140, h: 12 } }),
    ticketField("company_address", { box: { x: 430, y: 24, w: 158, h: 12 }, style: { size: 7, bold: false, align: "right" } }),
    ticketField("company_phone", { box: { x: 430, y: 40, w: 158, h: 12 }, style: { size: 7, bold: false, align: "right" } }),
  ];
  const parties = [
    ticketField("sold_to", { box: { x: 24, y: 66, w: 256, h: 64 } }),
    ticketField("ship_to", { box: { x: 332, y: 66, w: 256, h: 64 } }),
  ];
  const tables = (["field_strip", "lines", "containers", "serials", "totals"] as const).map((key) => ticketTable(key));
  const liability = textBlock("shipper_liability_text", { anchor: BELOW_SERIALS });
  const strip: CanvasItem[] = [
    staticLine("strip-rule", { x: 24, y: 6, w: 564, h: 0 }, 1.5),
    ticketField("tear_order_no", { anchor: BELOW_TOTALS, box: { x: 24, y: 12, w: 150, h: 12 } }),
    ticketField("tear_shipped_complete", { anchor: BELOW_TOTALS, box: { x: 180, y: 12, w: 150, h: 12 } }),
    ticketField("tear_total_qty", { anchor: BELOW_TOTALS, box: { x: 387, y: 12, w: 130, h: 12 } }),
    ticketField("tear_total_weight", { anchor: BELOW_TOTALS, box: { x: 387, y: 28, w: 130, h: 12 } }),
    { id: "pair-box", kind: "box", box: { x: 384, y: 10, w: 204, h: 32 }, anchor: BELOW_TOTALS, repeat: false, weight: 0.8 },
    staticLine("pair-rows", { x: 386, y: 26, w: 133, h: 0 }, 0.8),
    staticLine("pair-figures", { x: 522, y: 11, w: 0, h: 30 }, 0.8),
    ticketField("received_by", { anchor: BELOW_TOTALS, box: { x: 24, y: 50, w: 200, h: 12 } }),
    ticketField("received_date", { anchor: BELOW_TOTALS, box: { x: 230, y: 50, w: 150, h: 12 } }),
    ticketField("tear_sold_to", { anchor: BELOW_TOTALS, box: { x: 24, y: 68, w: 250, h: 12 } }),
    ticketField("shipped_on", { anchor: BELOW_TOTALS, box: { x: 280, y: 68, w: 150, h: 12 } }),
  ];
  return layoutOf([...header, ...parties, ...tables, liability, ...strip]);
}
