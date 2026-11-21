/**
 * The traveler's canvas path (design `docs/superpowers/specs/2026-11-07-traveler-canvas-designer-design.md`
 * §5.2): a template whose `config.layout` is not null prints its items where they are drawn, its
 * tables in the flow at their drawn places and widths, and the items anchored below a table riding
 * that table's rendered bottom. `buildTravelerDefinitions` (traveler.ts) branches here; a null
 * layout never reaches this file.
 *
 * The sheet itself (the detached page-top wrappers, the spacer, the float regions, the repeat and
 * page-bottom bands, the margins and `CANVAS_IDS`) is shared by every canvas document and lives in
 * `pdf/canvas-sheet.ts`, whose header states the pdfmake primitives and where the ids go. This file
 * holds what is the traveler's own: its field families (`fieldContent`), its barcode, its table
 * blocks (the flow's own section builders at the drawn place and width), the item node those make
 * (`travelerItemContent`) and its locked-element belt (`completeCanvas`).
 *
 * This file imports only TYPES from traveler.ts, which imports this file: the flow builders arrive
 * as one `FlowBuilders` object traveler.ts assembles at its branch (no import cycle).
 */
import type { Content, ContentTable, TableCell } from "pdfmake/interfaces";
import type { Ctx, SectionView, TravelerData, TravelerSheet } from "./traveler";
import { LAYOUT, type RenderableDefinition } from "./pdf/render";
import {
  CANVAS_IDS, LEFT, RIGHT, assembleCanvasSheet, boxedCell, drawnBlock, inBoxWidth, labelOf, logoContent,
  sectionConfigOf, strokeContent, textContent, type FieldItem, type ItemContent, type TableItem,
} from "./pdf/canvas-sheet";
import { defaultTableColumns, tablesByY } from "@/lib/template-canvas";
import { BARCODE_MIN, type CanvasItem, type CanvasLayout } from "@/lib/template-contracts/canvas";
import { TRAVELER_CONTRACT, normalizeTravelerHandwritingFields } from "@/lib/template-contracts/traveler";
import {
  completeSections, type FormatsConfig, type SectionConfig, type TemplateConfig,
} from "@/lib/template-contracts/types";

/** Re-exported from the shared sheet, so the traveler's importers keep their import. */
export { CANVAS_IDS };

/** The flow path's own section builders, handed in by traveler.ts (Ruling 1: no import cycle). The
 *  canvas prints each table exactly as the flow prints it; only its place and width are its own. */
export type FlowBuilders = {
  sectionView: (sc: SectionConfig) => SectionView;
  makeNum: (formats: FormatsConfig) => (value: number | null | undefined) => string;
  linesTable: (ctx: Ctx) => Content | null;
  quantityTable: (ctx: Ctx, sheet: TravelerSheet) => Content | null;
  inspectionsBlock: (ctx: Ctx) => Content | null;
  stepsTable: (ctx: Ctx) => Content;
  checkbox: () => TableCell;
  PO_WRITE_IN: string;
};

/** What one sheet's items are built from. `logoDataUri` is the version's logo bytes, which a logo
 *  item prints (undefined: the version carries none). */
type SheetScope = { ctx: Ctx; sheet: TravelerSheet; flow: FlowBuilders; logoDataUri?: string };

const TWO_LINE = new Set(["order_number", "load_number"]);
const VALUE_ONLY = new Set(["customer_name", "received_from", "company_name", "company_address", "company_phone"]);
const PROCESS_PAIRS = new Set(["process", "material", "process_id"]);
const HAND_WRITTEN = new Set([
  "results", "tempered_results", "final_inspection", "tested_by", "tested_date", "ok_to_ship", "ship_date",
]);
const CHECKBOXES = new Set(["pass", "fail"]);

/**
 * A field item's content, printed as the flow prints the same key. Every part takes the item's
 * size; a label is always bold, as the flow's labels are; a value takes the item's bold and
 * alignment. The families:
 *
 *  - two-line (`order_number`, `load_number`): the label over the value. A SAMPLE prints "SAMPLE"
 *    for both; a sheet with no load number prints "—".
 *  - joined (`customer_phone`, `po_number`): `label value` on one line, as the flow joins them. An
 *    empty phone prints nothing; an empty PO prints the flow's write-in rule.
 *  - value-only (`customer_name`, `received_from`, the company's name, address and phone): the value
 *    alone, the label unused as the flow leaves it; the received-from address one line per entry,
 *    the company's address as the one string it is stored as.
 *  - process pairs (`process`, `material`, `process_id`): `label value` on one line, label bold.
 *  - hand-written (`results`, `tempered_results`, …): a boxed area with its label at the top-left.
 *  - checkboxes (`pass`, `fail`): a boxed cell holding the label and the flow's checkbox.
 *
 * A key outside these prints nothing: the validator refuses it before a layout is stored.
 */
export function fieldContent(ctx: Ctx, sheet: TravelerSheet, item: FieldItem, flow: FlowBuilders): Content | null {
  const { d } = ctx;
  const { size, bold, align } = item.style;
  const label = labelOf(TRAVELER_CONTRACT, item);
  const value = (text: string): Content => ({ text, fontSize: size, bold, alignment: align });

  if (TWO_LINE.has(item.key)) {
    const shown = d.sample ? "SAMPLE"
      : item.key === "order_number" ? String(d.orderNumber)
        : sheet.loadNumber === null ? "—" : String(sheet.loadNumber);
    return inBoxWidth(item.box.w, {
      stack: [{ text: label, fontSize: size, bold: true, alignment: align }, value(shown)],
    });
  }
  if (item.key === "customer_phone") {
    if (d.customerPhone === "") return null;
    return inBoxWidth(item.box.w, value([label, d.customerPhone].filter((part) => part !== "").join(" ")));
  }
  if (item.key === "po_number") {
    const po = d.poNumber === "" ? flow.PO_WRITE_IN : d.poNumber;
    return inBoxWidth(item.box.w, value([label, po].filter((part) => part !== "").join(" ")));
  }
  if (VALUE_ONLY.has(item.key)) {
    if (item.key === "received_from") {
      if (d.receivedFrom.length === 0) return null;
      return inBoxWidth(item.box.w, { stack: d.receivedFrom.map((line) => value(line)) });
    }
    const text = item.key === "customer_name" ? d.customerName
      : item.key === "company_name" ? d.company.name
        : item.key === "company_address" ? d.company.address : d.company.phone;
    return inBoxWidth(item.box.w, value(text));
  }
  if (PROCESS_PAIRS.has(item.key)) {
    const text = item.key === "process" ? d.processName : item.key === "material" ? d.materialName : d.processId;
    return inBoxWidth(item.box.w, {
      text: [{ text: label, bold: true }, " ", { text, bold }], fontSize: size, alignment: align,
    });
  }
  if (HAND_WRITTEN.has(item.key)) {
    return boxedCell(item.box, { text: label, bold: true, fontSize: size });
  }
  if (CHECKBOXES.has(item.key)) {
    return boxedCell(item.box, {
      columns: [
        { width: "auto", text: label, bold: true, fontSize: size },
        { width: "auto", stack: [flow.checkbox() as Content] },
      ],
    } as TableCell);
  }
  return null;
}

/** The SAMPLE placeholder in the barcode's box: the flow's (`samplePlaceholder`, a 176.4 × 38 cell
 *  for the 186 × 44 slot) scaled to the box, its cell the box less 9.6 across and 6 down.
 *  `LAYOUT.boxed` adds 4 pt of padding on each side, 2 above and below, and a 0.8 pt rule on every
 *  edge, so it prints the box's width exactly and 0.4 pt short of its height, as the flow's prints
 *  186 × 43.6. */
function barcodePlaceholder(box: CanvasItem["box"]): Content {
  return {
    table: {
      widths: [Math.max(0, box.w - 9.6)], heights: [Math.max(0, box.h - 6)],
      body: [[{ text: "SAMPLE", bold: true, fontSize: 14, alignment: "center", margin: [0, 10, 0, 0] }]],
    },
    layout: LAYOUT.boxed,
  };
}

/**
 * The barcode's node. A real sheet's PNG is STRETCHED into the box (`width` and `height`, never
 * `fit`): the PNG's own proportions vary with the payload's length, and the flow path has always
 * stretched it into 186 × 44, so a box the validator holds to those proportions is a uniform scale
 * of the stretch the shop's scanners read today (design §4.1, §14 call 4). A no-load order's sheet
 * is real too: `readTravelerData` encodes the bare order number for it (Ruling 10).
 *
 * The SAMPLE preview has no order and no number to encode (spec 2026-09-26 §5), so it prints the
 * placeholder. A real sheet with no image ("") prints nothing in the box: production never produces
 * one (only the SAMPLE sheet carries ""), and pdfmake throws on an empty image, so this guards
 * against bad input rather than printing "SAMPLE" on real paper.
 */
function barcodeContent(scope: SheetScope, box: CanvasItem["box"]): Content | null {
  if (scope.ctx.d.sample) return barcodePlaceholder(box);
  if (scope.sheet.barcodeDataUri === "") return null;
  return { image: scope.sheet.barcodeDataUri, width: box.w, height: box.h };
}

/**
 * The traveler's item node for one sheet, the closure its sheet is assembled with (and the
 * preview's alone layouts are built with): a field through its family (`fieldContent`), a text item
 * as text, the logo fitted (nothing when the version carries no logo bytes, `logoDataUri`
 * undefined), the barcode as the sheet's own, a line or a box stroked. A table is never an item
 * node, and a text-block item, which no traveler layout holds, prints nothing.
 */
export function travelerItemContent(
  ctx: Ctx, sheet: TravelerSheet, flow: FlowBuilders, logoDataUri: string | undefined,
): ItemContent {
  return (item) => {
    switch (item.kind) {
      case "field": return fieldContent(ctx, sheet, item, flow);
      case "text": return textContent(item);
      case "logo": return logoContent(item, logoDataUri);
      case "barcode": return barcodeContent({ ctx, sheet, flow, logoDataUri }, item.box);
      case "line":
      case "box": return strokeContent(item);
      default: return null;
    }
  };
}

/** A table's block: the flow builder's node for its section, in the one canvas block shape
 *  (`drawnBlock`): the table's id on the wrapper, the node's own margin replaced by [0, 0, 0, 0] (the
 *  spacers carry the drawn vertical distances) and the lateral margin on the block's zero-gap
 *  `columns` node, whose one column is the drawn width as pdfmake subtracts it from the content width
 *  (`drawnBlock`, never `item.box.w`, which the steps table's `canvasWidth` below is). pdfmake
 *  rebuilds a broken level-1 column group's width from that group's own margin, so a margin anywhere
 *  else hands every node laid out after a page break a width wider by the block's two insets (#969):
 *  render.ts's oversized-row split replaced a margined steps table with a margined stack of level-1
 *  tables, and every group after the break, and the tables below it, printed that much too wide. The
 *  steps table carries the drawn width (`canvasWidth`, set on the table before it is wrapped, so the
 *  split finds it where it finds the table, by its layout), which the oversized-row measure reads, so
 *  it judges the rows at the width they print at; the split's groups and the stack replacing the
 *  table sit inside the block's column.
 *
 *  Null when the flow builder answers null, as `linesTable` and `quantityTable` do for a table with
 *  every column hidden: the canvas then prints no block, the flow's own convention (its
 *  `renderSection` drops a section with nothing left to draw). A refusal here would not be one: the
 *  validator accepts such a layout (only a locked column may not be hidden), so a throw would turn
 *  every print of a stored template into an unmapped 500. The sheet (`assembleCanvasSheet`) still
 *  emits the table's `end` and `regionEnd` marks and its region, so the float arithmetic holds: the
 *  missing table takes no height, and the region after it still carries the drawn gap from its
 *  drawn bottom, unless nothing prints from that region on: a trailing region from which nothing
 *  prints is left out (`nothingPrintsAfter`, #997), its `regionEnd` mark then on its `end` mark. */
function tableBlock(scope: SheetScope, item: TableItem): Content | null {
  const { ctx, sheet, flow } = scope;
  const node = item.key === "lines" ? flow.linesTable(ctx)
    : item.key === "quantities" ? flow.quantityTable(ctx, sheet)
      : item.key === "inspections" ? flow.inspectionsBlock(ctx)
        : flow.stepsTable(ctx);
  if (node === null) return null;
  if (item.key === "steps") {
    const steps = node as ContentTable & { canvasWidth?: number };
    if (steps.layout !== LAYOUT.steps) throw new Error("The canvas steps block is not the steps table.");
    steps.canvasWidth = item.box.w;
  }
  return drawnBlock(node as object, item);
}

/** The belt's barcode box: the header's right slot, `BARCODE_MIN` against the page's right margin,
 *  48 pt down (design §5.5). */
const BELT_BARCODE_BOX = { x: RIGHT - BARCODE_MIN.width, y: 48, w: BARCODE_MIN.width, h: BARCODE_MIN.height } as const;
/** The gap the belt leaves between the lowest table's drawn bottom and the steps table it adds, and
 *  the steps table's drawn top on a layout with no table at all. */
const BELT_STEPS_GAP = 8;
const BELT_STEPS_TOP = 140;
const BELT_STEPS_HEIGHT = 24;

/**
 * The canvas's locked-element belt (design §5.5), the counterpart of the flow builders'
 * `completeSections`: the barcode and the steps table are locked, and the validator refuses a
 * layout without either, but a layout that reaches the builder past it (a stored config read
 * without validation, a future code path) must still print both, as a flow config that omits a
 * locked section still prints it. A missing barcode is added in the header's right slot, page-top
 * and repeated, as the flow repeats it; a missing steps table is added the content width wide,
 * `BELT_STEPS_GAP` under the lowest table's drawn bottom (`BELT_STEPS_TOP` with no table), anchored
 * below the table above it by y as the model derives a table's anchor, with every column of the
 * contract's steps section shown at its own label and width (null: the contract's). Its handwriting
 * columns are restored, as every table's are, by `normalizeTravelerHandwritingFields` in the
 * builder. A layout holding both is handed back as it is; the layout passed in is never changed.
 */
export function completeCanvas(layout: CanvasLayout): CanvasLayout {
  const hasBarcode = layout.items.some((item) => item.kind === "barcode");
  const hasSteps = layout.items.some((item) => item.kind === "table" && item.key === "steps");
  if (hasBarcode && hasSteps) return layout;
  const items = [...layout.items];
  if (!hasBarcode) {
    items.push({
      kind: "barcode", id: crypto.randomUUID(), box: { ...BELT_BARCODE_BOX },
      anchor: { kind: "page-top" }, repeat: true,
    });
  }
  if (!hasSteps) {
    const tables = tablesByY(layout);
    const above = tables.at(-1);
    const top = tables.length === 0 ? BELT_STEPS_TOP
      : Math.max(...tables.map((table) => table.box.y + table.box.h)) + BELT_STEPS_GAP;
    const columns = defaultTableColumns(TRAVELER_CONTRACT, "steps");
    items.push({
      kind: "table", key: "steps", id: crypto.randomUUID(),
      box: { x: LEFT, y: top, w: RIGHT - LEFT, h: BELT_STEPS_HEIGHT },
      anchor: above === undefined ? { kind: "page-top" } : { kind: "below-table", table: above.key },
      repeat: false, heading: null, columns,
    });
  }
  return { ...layout, items };
}

/**
 * The canvas ctx every sheet's items and tables are built from, over the completed layout (`layout`,
 * `completeCanvas`'s answer): the flow runs its sections through the handwriting normaliser and the
 * omission belt, and the canvas runs its tables' sections through the same two, so a table prints
 * exactly as the flow prints it.
 */
function canvasCtx(input: TravelerData, config: TemplateConfig, layout: CanvasLayout, flow: FlowBuilders): Ctx {
  const tableConfigs = tablesByY(layout).map((item) => sectionConfigOf(TRAVELER_CONTRACT, item));
  const sectionConfigs = completeSections(
    TRAVELER_CONTRACT, normalizeTravelerHandwritingFields(tableConfigs, config.fonts.baseSize),
  );
  return {
    d: input,
    fonts: config.fonts,
    num: flow.makeNum(config.formats),
    sections: new Map(sectionConfigs.map((sc) => [sc.key, flow.sectionView(sc)] as const)),
    logo: null,
  };
}

/**
 * One definition per sheet, as `buildTravelerDefinitions` gives the flow path, each assembled by
 * the shared sheet (`assembleCanvasSheet`, `pdf/canvas-sheet.ts`) over the completed layout from
 * the traveler's item node and table block for that sheet, so a continuation page names its own
 * load and barcode.
 */
export function buildCanvasTravelerDefinitions(
  input: TravelerData, config: TemplateConfig, stored: CanvasLayout, flow: FlowBuilders, logoDataUri?: string,
): RenderableDefinition[] {
  // Everything below reads the completed layout: a below-table item under a belt steps table needs
  // that table for its region, and the repeat band a belt barcode for its height.
  const layout = completeCanvas(stored);
  const ctx = canvasCtx(input, config, layout, flow);
  return input.sheets.map((sheet) => {
    const scope: SheetScope = { ctx, sheet, flow, logoDataUri };
    return assembleCanvasSheet({
      layout,
      pageFooter: config.pageFooter,
      fonts: config.fonts,
      itemContent: travelerItemContent(ctx, sheet, flow, logoDataUri),
      tableBlock: (item) => tableBlock(scope, item),
    });
  });
}

/**
 * The item node the FIRST sheet is assembled with (`buildCanvasTravelerDefinitions`' own ctx, over
 * the completed layout), for the preview's alone layouts (`aloneLayouts`, `pdf/canvas-sheet.ts`; the
 * shipping ticket design's §5.2), which measure the first sheet group as the preview's measure does.
 * A traveler always has a sheet (an order with no loads prints one blank one).
 */
export function firstSheetItemContent(
  input: TravelerData, config: TemplateConfig, stored: CanvasLayout, flow: FlowBuilders, logoDataUri?: string,
): ItemContent {
  const ctx = canvasCtx(input, config, completeCanvas(stored), flow);
  return travelerItemContent(ctx, input.sheets[0], flow, logoDataUri);
}
