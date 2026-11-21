import { CERT_CONTRACT, CERT_ROW_FLOOR } from "@/lib/template-contracts/cert";
import { defaultTableColumns } from "@/lib/template-canvas";
import { CANVAS_GRID, type CanvasAnchor, type CanvasItem, type CanvasLayout } from "@/lib/template-contracts/canvas";
import type { CertPdfData } from "@/server/pdf/cert";
import { layoutOf } from "./canvas-fixtures";

type Over<K extends CanvasItem["kind"]> = Partial<Extract<CanvasItem, { kind: K }>>;

/** A certification field item, page-top at the left margin unless `over` says otherwise. */
export function certField(key: string, over: Over<"field"> = {}): Extract<CanvasItem, { kind: "field" }> {
  return {
    id: `field-${key}`, kind: "field", key, label: null,
    box: { x: 24, y: 24, w: 200, h: 12 }, anchor: { kind: "page-top" }, repeat: false,
    style: { size: 10, bold: false, align: "left" }, ...over,
  };
}

export type CertTable = "to" | "parts" | "statement" | "requirements" | "serials" | "freeform" | "signature";
const STACK: CertTable[] = ["to", "parts", "statement", "requirements", "serials", "freeform", "signature"];

/** The right column beside the To block (x 348, 240 wide): the purchase order, the packing list and
 *  the material, each 12 tall, from the To block's top (72) every 16 pt, so the last ends at 116. */
const BESIDE_TO = { x: 348, w: 240, top: 72, step: 16, h: 12 };
const BESIDE_TO_BOTTOM = BESIDE_TO.top + 2 * BESIDE_TO.step + BESIDE_TO.h; // 116
/** The parties' rule's drawn y: one grid step under the right column's last field (116 + 4.5 = 120.5). */
const RULE_Y = BESIDE_TO_BOTTOM + CANVAS_GRID;

/** The standard stack's drawn boxes, every block `CERT_ROW_FLOOR` (F) tall. The To block page-top at
 *  x 24, 314 wide, top 72. The part lines' top two grid steps under the parties' rule (RULE_Y + 9 =
 *  129.5); each later block's top two grid steps under the block before it (its top + F + 9). The
 *  part lines, statement, requirements, serials and freeform blocks at x 24, 564 wide; the signature
 *  block at x 338, 250 wide (its right edge at the margin, 588). With F = 10 the tops are 72, 129.5,
 *  148.5, 167.5, 186.5, 205.5 and 224.5. */
function stackBoxes(): Record<CertTable, { x: number; y: number; w: number; h: number }> {
  const boxes = {} as Record<CertTable, { x: number; y: number; w: number; h: number }>;
  boxes.to = { x: 24, y: 72, w: 314, h: CERT_ROW_FLOOR };
  let top = RULE_Y + 2 * CANVAS_GRID;
  for (const key of STACK.slice(1)) {
    boxes[key] = key === "signature"
      ? { x: 338, y: top, w: 250, h: CERT_ROW_FLOOR }
      : { x: 24, y: top, w: 564, h: CERT_ROW_FLOOR };
    top += CERT_ROW_FLOOR + 2 * CANVAS_GRID;
  }
  return boxes;
}

/** A certification block at its slot in the standard stack (`stackBoxes`), anchored below the block
 *  before it (the To block page-top), its columns the contract's (`defaultTableColumns`, never a
 *  literal: the rows blocks' rows, the part lines' three columns, none for the list blocks). */
export function certTable(key: CertTable, over: Over<"table"> = {}): Extract<CanvasItem, { kind: "table" }> {
  const i = STACK.indexOf(key);
  const anchor: CanvasAnchor = i === 0 ? { kind: "page-top" } : { kind: "below-table", table: STACK[i - 1] };
  return {
    id: `table-${key}`, kind: "table", key, heading: null, columns: defaultTableColumns(CERT_CONTRACT, key),
    box: { ...stackBoxes()[key] }, anchor, repeat: false, ...over,
  };
}

/**
 * The certification's standard arrangement, all inside the usable area (24..588 across, 24..768
 * down), passing every canvas rule and warning of nothing with no measure and the page line off,
 * every block at least its `CERT_LEAST_WIDTHS` entry wide, and no two drawn boxes overlapping.
 * Page-top: the company name (24..36, size 10) and the title (38..62, the heading size, 19) centred
 * at x 132, 288 wide; the order number (24..36, repeated on every page), the print date (40..52) and
 * the entry date (56..68) in the right column (x 423, 165 wide), so the order number ends 36 pt
 * above the To block's top (72), more than one grid step, and never meets "(continued)" at the
 * repeat band's bottom-left. The To block (72..72 + F, x 24..338) and beside it, page-top, the
 * purchase order (72..84), packing list (88..100) and material (104..116) at x 348, 240 wide. The
 * parties' rule, a 1.5 pt line 564 wide anchored below the To block at the offset that draws it at
 * 120.5 (one grid step under the material). The six blocks below (`stackBoxes`). The band: the
 * company address (x 24, 364 wide) and the phone (x 388, 200 wide, right-aligned, bold), both
 * page-bottom and repeated, 754..763 at the small size (7.5), inside the page's foot (768).
 *
 * The no-overlap proof runs through `canvasWarnings`, which skips block pairs; rule 5 (the stacking
 * rule) refuses any two blocks overlapping in y, so the blocks are judged by stacking.
 */
export function standardCertLayout(): CanvasLayout {
  const centre = { x: 132, w: 288 };
  const right = { x: 423, w: 165 };
  const header: CanvasItem[] = [
    certField("company_name", { box: { ...centre, y: 24, h: 12 }, style: { size: 10, bold: true, align: "center" } }),
    certField("title", { box: { ...centre, y: 38, h: 24 }, style: { size: 19, bold: true, align: "center" } }),
    certField("order_no", { box: { ...right, y: 24, h: 12 }, repeat: true }),
    certField("print_date", { box: { ...right, y: 40, h: 12 } }),
    certField("entry_date", { box: { ...right, y: 56, h: 12 } }),
  ];
  const besideTo: CanvasItem[] = ["po_number", "packing_list_no", "material"].map((key, i) =>
    certField(key, { box: { x: BESIDE_TO.x, y: BESIDE_TO.top + i * BESIDE_TO.step, w: BESIDE_TO.w, h: BESIDE_TO.h } }));
  const to = certTable("to");
  const rule: CanvasItem = {
    id: "parties-rule", kind: "line", weight: 1.5, repeat: false,
    anchor: { kind: "below-table", table: "to" },
    box: { x: 24, y: RULE_Y - (to.box.y + to.box.h), w: 564, h: 0 },
  };
  const band: CanvasItem[] = [
    certField("footer_address", {
      anchor: { kind: "page-bottom" }, repeat: true, box: { x: 24, y: 754, w: 364, h: 9 },
      style: { size: 7.5, bold: false, align: "left" },
    }),
    certField("footer_phone", {
      anchor: { kind: "page-bottom" }, repeat: true, box: { x: 388, y: 754, w: 200, h: 9 },
      style: { size: 7.5, bold: true, align: "right" },
    }),
  ];
  return layoutOf([...header, to, ...besideTo, rule, ...STACK.slice(1).map((key) => certTable(key)), ...band]);
}

/** A 1x1 PNG, the signer's signature image. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64");

/** The golden suite's certification (moved from tests/cert-templates.test.ts, which imports it;
 *  tests/cert-pdf.test.ts keeps its own copy), kept value-distinctive: one part, one requirement of
 *  nine readings, one serial, a freeform line and a signer with a 1x1 signature image. */
export function sampleCert(overrides: Partial<CertPdfData> = {}): CertPdfData {
  return {
    company: { name: "Example Heat Treating - Alabama, LLC", address: "100 Example Way  Anniston  AL  36207", phone: "256-555-0100" },
    orderLabel: "92036-3",
    printDate: "2026-08-03",
    entryDate: "2026-07-29",
    to: { attn: "", name: "Demo Components Corporation", street: "300 Example Way", city: "Anniston", state: "AL", zip: "36201" },
    poNumber: "DEMO-PO-24115",
    packingListNo: 92826,
    material: "steel",
    parts: [{ qty: 192, partNumber: "DEMO01-HT", partName: "Track Shoe, Vehicular", partDescription: "D-001", pounds: 4128 }],
    statement: "We certify that the listed Parts / Materials were heat treated in accordance with the QAM and customer requirements as follows:",
    requirements: [{
      lineIdentity: "line-1", linePosition: 1, partNumber: "DEMO01-HT", partName: "Track Shoe, Vehicular",
      specification: "Were heat treated as per P.O. NONE", scale: "HRC",
      readings: [28, 30, 29, 30, 29, 30.1, 29.7, 25.6, 27.1],
    }],
    serialBlocks: [{ partNumber: "DEMO01-HT", serials: [{ serial: "SN-0001", description: "Heat A1" }] }],
    freeform: "FREEFORM BLOCK UNDER TEST",
    signer: { name: "Alex Example", title: "", company: "Example Heat Treating - Alabama, LLC", signatureDataUri: `data:image/png;base64,${TINY_PNG.toString("base64")}` },
    ...overrides,
  };
}
