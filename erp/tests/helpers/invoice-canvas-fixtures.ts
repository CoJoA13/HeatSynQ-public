import { INVOICE_CONTRACT, INVOICE_ROW_FLOOR } from "@/lib/template-contracts/invoice";
import { defaultTableColumns } from "@/lib/template-canvas";
import { CANVAS_GRID, type CanvasAnchor, type CanvasBox, type CanvasItem, type CanvasLayout } from "@/lib/template-contracts/canvas";
import { layoutOf } from "./canvas-fixtures";
import type { InvoicePdfData } from "@/server/pdf/invoice";

type Over<K extends CanvasItem["kind"]> = Partial<Extract<CanvasItem, { kind: K }>>;

/** An invoice field item, page-top at the left margin, 200 × 12, unless `over` says otherwise. */
export function invoiceField(key: string, over: Over<"field"> = {}): Extract<CanvasItem, { kind: "field" }> {
  return {
    id: `field-${key}`, kind: "field", key, label: null,
    box: { x: 24, y: 24, w: 200, h: 12 }, anchor: { kind: "page-top" }, repeat: false,
    style: { size: 10, bold: false, align: "left" }, ...over,
  };
}

export type InvoiceTable = "parties" | "column_header" | "order_strip" | "parts" | "price" | "totals";
const STACK: InvoiceTable[] = ["parties", "column_header", "order_strip", "parts", "price", "totals"];

/** The identity row (`standardInvoiceLayout`): Invoice No., Invoice Date and Terms at x 96 (clear of
 *  the "(continued)" box, x 24 to 84), 230 wide, 12 tall, from 72 every 14 pt; the Remit To box at x
 *  338, 250 wide, 72 to 112 (its label and two address lines). Both columns end at 112. */
const IDENTITY = { top: 72, step: 14, h: 12, x: 96, w: 230 };
const REMIT_TO: CanvasBox = { x: 338, y: IDENTITY.top, w: 250, h: 40 };
const IDENTITY_BOTTOM = Math.max(IDENTITY.top + 2 * IDENTITY.step + IDENTITY.h, REMIT_TO.y + REMIT_TO.h); // 112

/** The standard stack's drawn boxes, every block x 24, 564 wide and `INVOICE_ROW_FLOOR` (F) tall. The
 *  parties' top two grid steps under the identity row's bottom (112 + 9 = 121), page-top; each later
 *  block's top two grid steps under the bottom of the block before it (its top + F + 9). With F = 9
 *  the tops are 121, 139, 157, 175, 193 and 211. */
function stackBoxes(): Record<InvoiceTable, CanvasBox> {
  const boxes = {} as Record<InvoiceTable, CanvasBox>;
  let top = IDENTITY_BOTTOM + 2 * CANVAS_GRID;
  for (const key of STACK) {
    boxes[key] = { x: 24, y: top, w: 564, h: INVOICE_ROW_FLOOR };
    top += INVOICE_ROW_FLOOR + 2 * CANVAS_GRID;
  }
  return boxes;
}

/** An invoice block at its slot in the standard stack (`stackBoxes`), anchored below the block before
 *  it (the parties page-top), its columns the contract's (`defaultTableColumns`, never a literal: the
 *  rows blocks' rows, the column headers' four grid fields through `columnTable`). */
export function invoiceTable(key: InvoiceTable, over: Over<"table"> = {}): Extract<CanvasItem, { kind: "table" }> {
  const i = STACK.indexOf(key);
  const anchor: CanvasAnchor = i === 0 ? { kind: "page-top" } : { kind: "below-table", table: STACK[i - 1] };
  return {
    id: `table-${key}`, kind: "table", key, heading: null, columns: defaultTableColumns(INVOICE_CONTRACT, key),
    box: { ...stackBoxes()[key] }, anchor, repeat: false, ...over,
  };
}

/**
 * The invoice's standard arrangement, all inside the usable area (24..588 across, 24..768 down),
 * passing every canvas rule and warning of nothing with no measure and the page line off, every
 * block at least its `INVOICE_LEAST_WIDTHS` entry wide, the four grid blocks in line with the column
 * headers (same x and width), and no two drawn boxes overlapping. Page-top: the title (24..48, the
 * heading size, bold, centred) and the company name (50..68, 15, bold, centred) across the content;
 * the invoice number (72..84, repeated on every page), the invoice date (86..98) and the terms
 * (100..112) at x 96, 230 wide, so the invoice number ends 37 pt above the parties' top (121), more
 * than one grid step, and lies clear of "(continued)" at the repeat band's bottom-left (x 24..84,
 * 74..84); the Remit To box (72..112) at x 338, 250 wide. The six blocks below (`stackBoxes`). The
 * band: the company address (x 24, 244 wide, 750..768, its two lines at the small size 17.578 pt
 * tall, so the box ends at the page's foot and holds both: owner ruling 2026-11-14, #978, where it
 * was 754..763 and its second line printed past the band), the contact line (x 268, 180 wide,
 * centred) and the phone (x 448, 140 wide, right-aligned), each 754..763, all page-bottom, repeated
 * and at the small size (7.5), inside the page's foot (768). Like the rest of the fixture they are
 * not on the 4.5 pt grid.
 *
 * The no-overlap proof runs through `canvasWarnings`, which skips block pairs; rule 5 (the stacking
 * rule) refuses any two blocks overlapping in y, so the blocks are judged by stacking.
 */
export function standardInvoiceLayout(): CanvasLayout {
  const across = { x: 24, w: 564 };
  const small = INVOICE_CONTRACT.fonts.smallSize;
  const header: CanvasItem[] = [
    invoiceField("title", {
      box: { ...across, y: 24, h: 24 }, style: { size: INVOICE_CONTRACT.fonts.headingSize, bold: true, align: "center" },
    }),
    invoiceField("company_name", { box: { ...across, y: 50, h: 18 }, style: { size: 15, bold: true, align: "center" } }),
  ];
  const identity: CanvasItem[] = ["invoice_no", "invoice_date", "terms"].map((key, i) =>
    invoiceField(key, {
      box: { x: IDENTITY.x, y: IDENTITY.top + i * IDENTITY.step, w: IDENTITY.w, h: IDENTITY.h }, repeat: key === "invoice_no",
    }));
  const remitTo = invoiceField("remit_to", { box: { ...REMIT_TO } });
  const band: CanvasItem[] = [
    invoiceField("footer_address", {
      anchor: { kind: "page-bottom" }, repeat: true, box: { x: 24, y: 750, w: 244, h: 18 },
      style: { size: small, bold: false, align: "left" },
    }),
    invoiceField("footer_contact", {
      anchor: { kind: "page-bottom" }, repeat: true, box: { x: 268, y: 754, w: 180, h: 9 },
      style: { size: small, bold: false, align: "center" },
    }),
    invoiceField("footer_phone", {
      anchor: { kind: "page-bottom" }, repeat: true, box: { x: 448, y: 754, w: 140, h: 9 },
      style: { size: small, bold: false, align: "right" },
    }),
  ];
  return layoutOf([...header, ...identity, remitTo, ...STACK.map((key) => invoiceTable(key)), ...band]);
}

/** The invoice the flow's goldens print, a copy of tests/invoice-pdf.test.ts's `sampleData` (that
 *  file keeps its own, the cert's `sampleCert` precedent): one part, one priced operation with a
 *  minimum, one surcharge. `overrides` replace whole keys. */
export function sampleInvoice(overrides: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return {
    company: { name: "Example Heat Treating - Alabama, LLC", address: "100 Example Way\nAnniston AL 36207", phone: "256-555-0100" },
    remitTo: { name: "Example Heat Treating - Alabama, LLC", lines: ["100 Example Way", "Anniston AL 36207"] },
    billTo: ["Demo Foundry - Columbus LLC", "PO Box 100", "500 Example Street", "Columbus  GA  31902-0096"],
    shipTo: ["Demo Foundry - Columbus LLC", "PO Box 100", "500 Example Street", "Columbus  GA  31902-0096"],
    title: "Invoice",
    documentNumber: "7 - 92026", invoiceDate: "2026-07-29", termsName: "Net 30",
    orderNumber: 92026, poNumber: "89499",
    materialName: "Ductile Iron", processNames: "Austemper",
    parts: [{ qty: 144, partNumber: "DEMO-9001-000", partName: "EQUALIZER-RR SUSP", partDescription: "", eachWeight: 21, totalWeight: 3024 }],
    priceRows: [{ description: "Austemper", pricePerLabel: "Each", unitPrice: 6.51, minimumCharge: 600, setupCharge: null, amount: 937.44, partIndex: 0 }],
    subtotal: 937.44,
    surchargeRows: [{ description: "EnergySur", amount: 37.5 }],
    chargeRows: [], certRow: null, freightRow: null, taxRow: null,
    total: 974.94,
    ...overrides,
  };
}
