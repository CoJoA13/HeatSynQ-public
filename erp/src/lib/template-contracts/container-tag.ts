/**
 * The container tag's template contract (the container tag design of 2026-11-13, §5; owner rulings
 * R1 to R12 of that day), derived from `src/server/pdf/container-tags.ts`'s `buildContainerTags`: one
 * section, the tag's six printed lines in today's order, Order # locked (R6) and the rest removable.
 *
 * The tag is a download that is never stored (spec §8 does not reach it, #743's ruling 4), printed on
 * one label stock (`labelSize`, R3; its page is `TAG_LABEL_SIZES`, ./canvas.ts). It has no text block
 * and no column table. Its canvas profile (`CONTAINER_TAG_CANVAS`, PR 3, §7.2) places no table, requires
 * the order number and turns on the one-label rules (`oneLabel`, src/lib/template-canvas.ts); the tag is
 * in the registry's `CANVAS_PRINTS` since its canvas prints (PR 3). It withholds the header logo and the page line, which the validator refuses
 * (`assertWithheld`), and the small size, which the editor hides: the flow prints nothing at it.
 *
 * The two flow fit rules (`assertTagFits`) run on a flow config alone (call 17), through the registry
 * (`withTagRules`, ./index.ts): R11, the flow's height at the config's sizes, the parts at their cap
 * and the more line, within the label's content height; and R10's flow half, the order number's
 * label joined to seven of the face's widest digit, bold at the heading size, within its content
 * width. Both read the client-safe metrics leaf `src/lib/tag-font-metrics.ts`, generated from the
 * vendored fonts. The width is judged before the height, so a heading too wide for the label is
 * named by the sentence that names the heading.
 */
import {
  TemplateConfigError, defaultConfig,
  type CanvasProfile, type ContractField, type FieldConfig, type FontFamily, type TemplateConfig, type TemplateContract,
} from "./types";
import { TAG_LABEL_SIZES } from "./canvas";
import { TAG_FONT_METRICS, lineHeightOf, textWidthOf, type Face } from "../tag-font-metrics";

/** The digits an order number is measured at: seven leave headroom over today's numbers (R10). */
const ORDER_DIGITS = 7;

/** The tag's canvas profile (the container tag design of 2026-11-13 §7.2): no table, no barcode, the
 *  order number required (R6), and one label (`oneLabel`): page-top only, no repeat, a text box at least
 *  one line tall (R12) and the order number whole within the label's width at seven digits (R10).
 *  `rowFloor` and `firstTableRoom` are read only for a table, and the tag places none. */
export const CONTAINER_TAG_CANVAS: CanvasProfile = {
  paper: "container tag",
  tables: [],
  required: [{ kind: "field", key: "order_number", reason: "a tag exists to say which work order a container belongs to" }],
  barcode: false,
  notFields: [],
  boxedFields: [],
  ruledFields: [],
  leastWidths: {},
  rowFloor: 0,
  firstTableRoom: 0,
  oneLabel: { wholeField: { key: "order_number", digits: ORDER_DIGITS } },
};

export const CONTAINER_TAG_CONTRACT: TemplateContract = {
  docType: "CONTAINER_TAG",
  name: "Container tag",
  sections: [
    {
      // The tag's one stack. Not hideable: it holds the locked Order #. Not reorderable: it is alone.
      key: "tag", name: "Tag", hideable: false, reorderable: false,
      lockReason: "A tag is one stack, and it holds the order number, which cannot be hidden.",
      fields: [
        {
          key: "order_number", name: "Order number", defaultLabel: "Order #", removable: false,
          lockReason: "A tag exists to say which work order a container belongs to.",
        },
        { key: "customer", name: "Customer", defaultLabel: "", removable: true },
        { key: "po_number", name: "PO number", defaultLabel: "PO", removable: true },
        { key: "containers_total", name: "Containers", defaultLabel: "Containers:", removable: true },
        { key: "received", name: "Received", defaultLabel: "Received", removable: true },
        { key: "parts", name: "Part lines", defaultLabel: "", removable: true },
      ],
    },
  ],
  textBlocks: [],
  formats: { labelSize: "4x3-landscape" },
  // Today's builder: Order # at 20 pt (the heading), the customer at 12 (the base plus 2) and the
  // rest at 10 (call 4). The small size is declared, as every type's is, and prints nothing.
  fonts: { family: "Roboto", baseSize: 10, headingSize: 20, smallSize: 10 },
  withholds: ["logo", "pageFooter", "smallSize"],
  blankLabels: true,
  canvas: CONTAINER_TAG_CANVAS,
};

export const DEFAULT_CONFIG: TemplateConfig = defaultConfig(CONTAINER_TAG_CONTRACT);

/** A label printed before its value (call 7): a label ending in `#` takes no space (`Order #1234`),
 *  any other one space (`PO 5531`), and a blank label prints the value alone. */
export function TAG_JOIN(label: string, value: string): string {
  if (label === "") return value;
  return label.endsWith("#") ? `${label}${value}` : `${label} ${value}`;
}

/** The part lines the flow lists in full; the rest are one more line (call 8). Restates
 *  `TAG_PARTS_SHOWN` (src/server/pdf/container-tags.ts), which this client-safe file cannot import. */
const FLOW_PARTS_SHOWN = 6;

const TAG_FIELDS: ReadonlyMap<string, ContractField> = new Map(
  CONTAINER_TAG_CONTRACT.sections[0].fields.map((f) => [f.key, f]));

function tagFields(config: TemplateConfig): FieldConfig[] {
  return config.sections.find((s) => s.key === "tag")?.fields ?? [];
}

function labelSizeOf(config: TemplateConfig) {
  return TAG_LABEL_SIZES[config.formats.labelSize ?? "4x3-landscape"];
}

/** The flow's height at the config's sizes, in points: over the shown fields in the config's order,
 *  each field's top margin and its line heights as the flow prints them, the parts at their cap and
 *  the more line in italics, the tallest a tag can print. */
export function flowTagHeight(config: TemplateConfig): number {
  const { family, baseSize, headingSize } = config.fonts;
  const line = (face: Face, size: number) => lineHeightOf(family, face, size);
  let height = 0;
  for (const field of tagFields(config)) {
    if (!field.visible) continue;
    switch (field.key) {
      case "order_number": height += line("bold", headingSize); break;
      case "customer": height += 2 + line("bold", baseSize + 2); break;
      case "po_number": height += 4 + line("normal", baseSize); break;
      case "containers_total":
      case "received": height += line("normal", baseSize); break;
      case "parts": height += 6 + FLOW_PARTS_SHOWN * line("normal", baseSize) + line("italics", baseSize); break;
    }
  }
  return height;
}

/** The face's widest digit, the character an order number is measured in (code points 48 to 57,
 *  the widths table starting at 32). Read by the flow's R10 (`orderNumberWidth`) and the canvas's
 *  (src/lib/template-canvas.ts, rule 10). */
export function widestDigitOf(family: FontFamily, face: Face): string {
  const { widths } = TAG_FONT_METRICS[family][face];
  let best = 0;
  for (let d = 1; d <= 9; d++) if (widths[16 + d] > widths[16 + best]) best = d;
  return String(best);
}

/** The order number's printed width at the heading size, bold, in points: its effective label (the
 *  typed one, a blank one included, else `Order #`) joined to seven of the face's widest digit. */
export function orderNumberWidth(config: TemplateConfig): number {
  const { family, headingSize } = config.fonts;
  const field = tagFields(config).find((f) => f.key === "order_number");
  const label = field?.label ?? TAG_FIELDS.get("order_number")!.defaultLabel;
  const digits = widestDigitOf(family, "bold").repeat(ORDER_DIGITS);
  return textWidthOf(TAG_JOIN(label, digits), family, "bold", headingSize);
}

/** Refuses a flow tag that does not fit one label: an order number wider than the content (R10),
 *  then a flow taller than it (R11). */
export function assertTagFits(config: TemplateConfig): void {
  const size = labelSizeOf(config);
  if (orderNumberWidth(config) > size.width - 2 * size.margin) {
    throw new TemplateConfigError(
      `The tag's heading size does not fit an order number on one ${size.name} label; lower the heading size or shorten its label.`);
  }
  if (flowTagHeight(config) > size.height - 2 * size.margin) {
    throw new TemplateConfigError(
      `The tag's text sizes do not fit one ${size.name} label; lower the base or heading size.`);
  }
}
