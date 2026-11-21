import { TRAVELER_CONTRACT } from "@/lib/template-contracts/traveler";
import { CANVAS_GRID, CANVAS_TABLES, type CanvasAnchor, type CanvasItem, type CanvasLayout } from "@/lib/template-contracts/canvas";

type Over<K extends CanvasItem["kind"]> = Partial<Extract<CanvasItem, { kind: K }>>;

export function layoutOf(items: CanvasItem[]): CanvasLayout {
  return { version: 1, items };
}

export function barcode(over: Over<"barcode"> = {}): Extract<CanvasItem, { kind: "barcode" }> {
  return { id: "barcode", kind: "barcode", box: { x: 402, y: 48, w: 186, h: 44 }, anchor: { kind: "page-top" }, repeat: true, ...over };
}

export function logo(over: Over<"logo"> = {}): Extract<CanvasItem, { kind: "logo" }> {
  return { id: "logo", kind: "logo", box: { x: 24, y: 24, w: 80, h: 40 }, anchor: { kind: "page-top" }, repeat: false, ...over };
}

export function field(key: string, over: Over<"field"> = {}): Extract<CanvasItem, { kind: "field" }> {
  return {
    id: `field-${key}`, kind: "field", key, label: null,
    box: { x: 24, y: 72, w: 200, h: 12 }, anchor: { kind: "page-top" }, repeat: false,
    style: { size: 8, bold: false, align: "left" }, ...over,
  };
}

type TravelerTable = (typeof CANVAS_TABLES)[number];
const TABLE_BOXES: Record<TravelerTable, { y: number; h: number }> = {
  lines: { y: 140, h: 40 },
  quantities: { y: 188, h: 52 },
  inspections: { y: 248, h: 70 },
  steps: { y: 326, h: 120 },
};
const ABOVE: Record<TravelerTable, TravelerTable | null> = {
  lines: null, quantities: "lines", inspections: "quantities", steps: "inspections",
};

export function table(key: TravelerTable, over: Over<"table"> = {}): Extract<CanvasItem, { kind: "table" }> {
  const above = ABOVE[key];
  const anchor: CanvasAnchor = above ? { kind: "below-table", table: above } : { kind: "page-top" };
  const columns = TRAVELER_CONTRACT.sections
    .flatMap((section) => section.fields)
    .filter((f) => f.column?.table === key)
    .map((f) => ({ key: f.key, visible: true, label: null, width: null }));
  return {
    id: `table-${key}`, kind: "table", key, heading: null, columns,
    box: { x: 24, y: TABLE_BOXES[key].y, w: 564, h: TABLE_BOXES[key].h }, anchor, repeat: false, ...over,
  };
}

const HEADER_KEYS = [
  "customer_name", "received_from", "customer_phone", "po_number",
  "company_name", "company_address", "company_phone", "order_number", "load_number",
];
const PROCESS_KEYS = ["process", "material", "process_id"];
const FOOTER_KEYS = [
  "results", "tempered_results", "final_inspection", "pass", "fail",
  "tested_by", "tested_date", "ok_to_ship", "ship_date",
];

/**
 * The traveler's standard arrangement, all inside the usable area (24..588 across, 24..768 down),
 * passing every canvas refusal and with no two drawn boxes overlapping. The process fields sit one
 * grid step under Quantities (drawn 244.5..256.5), so Inspections starts one grid step under them
 * (261, drawn bottom 331) and Steps 8 pt under Inspections (339, drawn bottom 459); the footer
 * fields hang below Steps, their lowest drawn bottom at 459 + 68 = 527.
 */
export function standardLayout(): CanvasLayout {
  const header = HEADER_KEYS.map((key, i) =>
    field(key, { box: { x: i % 2 === 0 ? 120 : 260, y: 24 + Math.floor(i / 2) * 22, w: 130, h: 12 } }));
  const process = PROCESS_KEYS.map((key, i) =>
    field(key, { anchor: { kind: "below-table", table: "quantities" }, box: { x: 24 + i * 190, y: CANVAS_GRID, w: 180, h: 12 } }));
  const footer = FOOTER_KEYS.map((key, i) =>
    field(key, { anchor: { kind: "below-table", table: "steps" }, box: { x: 24 + (i % 3) * 190, y: 8 + Math.floor(i / 3) * 24, w: 180, h: 12 } }));
  return layoutOf([
    logo(), ...header, barcode(),
    table("lines"), table("quantities"),
    table("inspections", { box: { x: 24, y: 261, w: 564, h: 70 } }),
    table("steps", { box: { x: 24, y: 339, w: 564, h: 120 } }),
    ...process, ...footer,
  ]);
}
