import { BOL_CONTRACT, BOL_ROW_FLOOR } from "@/lib/template-contracts/bol";
import { defaultTableColumns } from "@/lib/template-canvas";
import type { CanvasAnchor, CanvasItem, CanvasLayout } from "@/lib/template-contracts/canvas";
import type { BolData } from "@/server/pdf/bol";
import { layoutOf } from "./canvas-fixtures";

type Over<K extends CanvasItem["kind"]> = Partial<Extract<CanvasItem, { kind: K }>>;

/** A bill of lading field item, page-top at the left margin unless `over` says otherwise. */
export function bolField(key: string, over: Over<"field"> = {}): Extract<CanvasItem, { kind: "field" }> {
  return {
    id: `field-${key}`, kind: "field", key, label: null,
    box: { x: 24, y: 24, w: 200, h: 12 }, anchor: { kind: "page-top" }, repeat: false,
    style: { size: 8, bold: false, align: "left" }, ...over,
  };
}

type BolTable = "consignee_ref" | "trv" | "freight";
/** The standard layout's stack: each block's drawn x, top, width and height, and the block it rides.
 *  The consignee's ref/PO block sits in the right slot (x 338, 244 wide) under the BOL number, its top
 *  at 57 (the BOL number ends at 52, so the repeat band's bottom plus one grid step, 56.5, stays above
 *  it: rule 3); the TRV block at 176 and the freight block at 206 take the full width, each one row
 *  (`BOL_ROW_FLOOR`) tall. */
const TABLE_BOXES: Record<BolTable, { x: number; y: number; w: number; h: number }> = {
  consignee_ref: { x: 338, y: 57, w: 244, h: BOL_ROW_FLOOR },
  trv: { x: 24, y: 176, w: 564, h: BOL_ROW_FLOOR },
  freight: { x: 24, y: 206, w: 564, h: BOL_ROW_FLOOR },
};
const ABOVE: Record<BolTable, BolTable | null> = { consignee_ref: null, trv: "consignee_ref", freight: "trv" };

/** A bill of lading block at its slot in the standard stack, its columns the contract's
 *  (`defaultTableColumns`, never a literal: the freight block's five columns and then its Collect
 *  checkbox toggle, the two others none). */
export function bolTable(key: BolTable, over: Over<"table"> = {}): Extract<CanvasItem, { kind: "table" }> {
  const above = ABOVE[key];
  const anchor: CanvasAnchor = above ? { kind: "below-table", table: above } : { kind: "page-top" };
  return {
    id: `table-${key}`, kind: "table", key, heading: null, columns: defaultTableColumns(BOL_CONTRACT, key),
    box: { ...TABLE_BOXES[key] }, anchor, repeat: false, ...over,
  };
}

/** A text-block item at the template's small size (5.5), full width, hung 4 pt below the freight
 *  block unless `over` says otherwise. */
export function bolTextBlock(key: string, over: Over<"textBlock"> = {}): Extract<CanvasItem, { kind: "textBlock" }> {
  return {
    id: `text-block-${key}`, kind: "textBlock", key,
    box: { x: 24, y: 4, w: 564, h: 24 }, anchor: { kind: "below-table", table: "freight" }, repeat: false,
    style: { size: 5.5, bold: false, align: "left" }, ...over,
  };
}

const BELOW = (table: BolTable): CanvasAnchor => ({ kind: "below-table", table });

/**
 * The bill of lading's standard arrangement, all inside the usable area (24..588 across, 24..768
 * down), passing every canvas rule, warning of nothing with no measure, every field and block at
 * least its `BOL_LEAST_WIDTHS` entry wide, and no two drawn boxes overlapping. Page-top: the
 * original label (24..34) and the title (36..56) at the left, 300 wide; the pro number (24..36) and
 * the BOL number (40..52, repeated on every page) in the right slot (x 338, 244 wide), off the left
 * margin, so the BOL number never meets "(continued)" at the repeat band's bottom-left. The
 * consignee's ref/PO block under them in the right slot (57..66). Below it: the SCAC code beside the
 * carrier's name (70..82), the received clause (86..110), the ship-from line (114..126), the property
 * clause (130..154) and the consigned-to line (158..170), the last three full width. The TRV block
 * (176..185) and the delivering carrier below it (189..201); the freight block (206..215) and below
 * it the water-carrier note (219..243), the shipper's signature (247..259) and the post-office address
 * (263..275).
 *
 * The no-overlap proof runs through `canvasWarnings`, which skips block pairs; rule 5 (the stacking
 * rule, run by the same tests) refuses any two blocks overlapping in y, so the blocks are judged by
 * stacking, not by warning (a).
 */
export function standardBolLayout(): CanvasLayout {
  const right = { x: 338, w: 244 };
  const header: CanvasItem[] = [
    bolField("original_label", { box: { x: 24, y: 24, w: 300, h: 10 }, style: { size: 7, bold: false, align: "left" } }),
    bolField("title", { box: { x: 24, y: 36, w: 300, h: 20 }, style: { size: 15, bold: true, align: "left" } }),
    bolField("pro_number", { box: { ...right, y: 24, h: 12 } }),
    bolField("bol_number", { box: { ...right, y: 40, h: 12 }, repeat: true }),
  ];
  const belowRef: CanvasItem[] = [
    bolField("scac_code", { anchor: BELOW("consignee_ref"), box: { ...right, y: 4, h: 12 } }),
    bolField("carrier_name", { anchor: BELOW("consignee_ref"), box: { x: 24, y: 4, w: 300, h: 12 } }),
    bolTextBlock("bol_received_text", { anchor: BELOW("consignee_ref"), box: { x: 24, y: 20, w: 564, h: 24 } }),
    bolField("ship_from", { anchor: BELOW("consignee_ref"), box: { x: 24, y: 48, w: 564, h: 12 } }),
    bolTextBlock("bol_property_text", { anchor: BELOW("consignee_ref"), box: { x: 24, y: 64, w: 564, h: 24 } }),
    bolField("consigned_to", { anchor: BELOW("consignee_ref"), box: { x: 24, y: 92, w: 564, h: 12 } }),
  ];
  const belowTrv = [bolField("delivering_carrier", { anchor: BELOW("trv"), box: { x: 24, y: 4, w: 300, h: 12 } })];
  const belowFreight: CanvasItem[] = [
    bolTextBlock("bol_water_note"),
    bolField("shipper_per", { anchor: BELOW("freight"), box: { x: 24, y: 32, w: 200, h: 12 } }),
    bolField("po_address", { anchor: BELOW("freight"), box: { x: 24, y: 48, w: 200, h: 12 } }),
  ];
  return layoutOf([
    ...header, bolTable("consignee_ref"), ...belowRef, bolTable("trv"), ...belowTrv, bolTable("freight"), ...belowFreight,
  ]);
}

/** The golden suite's bill of lading data, kept value-distinctive (moved from tests/bol-templates.test.ts). */
export function sampleBol(overrides: Partial<BolData> = {}): BolData {
  return {
    company: { name: "Example Heat Treating - Alabama, LLC", address: "100 Example Way  Anniston  AL  36207" },
    bolNumber: 92795,
    proNumber: "PRO-4471",
    scacCode: "GFMC",
    carrierName: "Demo Foundry Truck",
    shipDate: "2026-07-06",
    consignee: { name: "Example Coating", street: "400 Demo Drive", city: "Birmingham", state: "AL", zip: "35217" },
    orderNumbers: [91955, 91957, 91959, 91960, 91961],
    poNumbers: ["DEMO-PO-24115", "PT24116"],
    packageCount: 15,
    freightDescription: "Manufactured Castings I/S",
    orders: [{ lineWeights: [11415], containers: [] }],
    freightClass: "70",
    freightTerms: "PREPAID",
    ...overrides,
  };
}
