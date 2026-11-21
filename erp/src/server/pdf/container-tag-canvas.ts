/**
 * The container tag's canvas (the container tag design of 2026-11-13 §7.3, rulings R4, R7, R8, R10):
 * a tag template whose `config.layout` is not null prints each item at its drawn place on the label,
 * one label per container row, through this one-page builder. It shares the designer, the layout
 * model and the rules with the eight Letter documents, and none of their print: no
 * `assembleCanvasSheet`, no `canvas-measure.ts`, no measurement path of `render.ts` (R8). PURE, as
 * the flow builder (`container-tags.ts`) is: `ContainerTagData[]` in, a plain-JSON pdfmake definition
 * and the first tag's measure out.
 *
 * - The page is the label stock's, its margins [0, 0, 0, 0]: every item is a detached node
 *   (`absolutePosition`) at its box's page coordinates, so the label's margin is a rule-4 bound, not
 *   a pdfmake margin. Each tag is one stack of its items' nodes, and every stack after the first
 *   carries `pageBreak: "before"`, so each tag starts its own page whichever of its items prints.
 * - Every node is built afresh for each tag: pdfmake uses up a text node it has laid out.
 * - A field prints `TAG_JOIN(label, value)` through `oneLine` as one `noWrap` line in its style, its
 *   label the one rule 10 measures (`printedLabel`). A value too wide for its box is cut at the
 *   box's right edge (R7, `fitToWidth`), with no ellipsis; Order # never is (R10): wider than its
 *   box it starts at the box's left and runs right, moved left to end at the label's right margin
 *   when it would pass it, never left of the left margin. Every line is placed by its measured width
 *   at an explicit x (the box's alignment taken within the box), never by pdfmake's alignment.
 * - The part lines (R4) fill their box: `k = floor(box.h / lineHeight + 1e-6)` lines, a typed label
 *   the first of them from two lines up (call 12); when the parts outnumber the rest, the last line is
 *   `and N more parts` in italics. At one line the label takes no line (R4 outranks call 12 there, the
 *   final review's I2): one part prints, and more than one print as `and N more parts`, N every part,
 *   with no label. The epsilon absorbs floating-point noise alone: a box exactly k lines tall can divide to
 *   a hair under k (3 × 15.826176 / 15.826176 is 2.9999999999999996). A box whose height was rounded
 *   DOWN holds one line fewer, so a seed or the designer rounds a height up.
 * - Widths and line heights come from the client-safe metrics leaf (`textWidthOf`: ASCII at its glyph
 *   advances plus the kern of each adjacent pair that kerns wider (#986), Latin-1 and the common
 *   punctuation at theirs with a kerning allowance (#984), any other character at its face's widest
 *   glyph; `lineHeightOf`, pdfmake's line height), the figures the designer and the rules read, so a cut
 *   value never passes its box's edge. A line is
 *   measured in the face it prints in, the more line in italics or bold italics.
 * - Beside each printed item's node, a hidden mark (`mark(CANVAS_IDS.item(id))`, a 0 × 0 rect filled
 *   at opacity 0) carries its id, on the canvas node alone, never a text node: no id here is one of
 *   `render.ts`'s kept-together or measured rows, and none starts with the canvas table prefix, so
 *   the definition takes no measurement path (the design's §3 rule for every tag definition). The
 *   marks repeat on every tag; pdfmake refuses a repeated id only on text nodes.
 *
 * The measure is built here, from the same arithmetic, not read back from a layout pass: one entry
 * per printed item of the FIRST tag (every tag of one order prints the same text, so one measure
 * serves all), at its drawn box, with `cut`, `past` and `parts` where they apply (warning (h)). An
 * item that prints nothing (a part lines box over no parts, a Logo with no bytes) is not in it, as
 * a null item node is not on the other canvases.
 */
import type { Content, ContentText } from "pdfmake/interfaces";
import type { RenderableDefinition } from "./render";
import type { ContainerTagData } from "./container-tags";
import { moreParts } from "./container-tags";
import { CANVAS_IDS, logoContent, strokeContent } from "./canvas-sheet";
import { mark } from "./canvas-nodes";
import { oneLine } from "../../lib/line-break";
import { CONTAINER_TAG_CONTRACT, TAG_JOIN } from "../../lib/template-contracts/container-tag";
import { TAG_LABEL_SIZES, type CanvasItem, type CanvasTextStyle } from "../../lib/template-contracts/canvas";
import type { FontFamily, TemplateConfig } from "../../lib/template-contracts/types";
import { printedLabel, type CanvasMeasure } from "../../lib/template-canvas";
import { lineHeightOf, textWidthOf, type Face } from "../../lib/tag-font-metrics";

/** The floating-point slack in `floor(h / lineHeight + ε)` (see the header); never a rounding allowance. */
const LINE_EPSILON = 1e-6;

type MeasureItem = CanvasMeasure["items"][number];
type FieldItem = Extract<CanvasItem, { kind: "field" }>;
type Page = { width: number; height: number; margin: number };
type Printed = { nodes: Content[]; flags: Pick<MeasureItem, "cut" | "past" | "parts"> } | null;

/** The longest prefix of `text`, by code point, whose `textWidthOf` is at most `width`, and whether
 *  anything was dropped. No ellipsis (call 11). */
export function fitToWidth(
  text: string, family: FontFamily, face: Face, size: number, width: number,
): { text: string; cut: boolean } {
  if (textWidthOf(text, family, face, size) <= width) return { text, cut: false };
  const chars = Array.from(text);
  // The width grows with the prefix, so the longest fitting one is found by bisection.
  let lo = 0;
  let hi = chars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidthOf(chars.slice(0, mid).join(""), family, face, size) <= width) lo = mid;
    else hi = mid - 1;
  }
  return { text: chars.slice(0, lo).join(""), cut: true };
}

/** The x a line `width` wide takes inside a box at its alignment. */
function alignedX(box: { x: number; w: number }, width: number, align: CanvasTextStyle["align"]): number {
  if (align === "right") return box.x + box.w - width;
  if (align === "center") return box.x + (box.w - width) / 2;
  return box.x;
}

const faceOf = (bold: boolean, italics = false): Face =>
  italics ? (bold ? "bolditalics" : "italics") : (bold ? "bold" : "normal");

/** One `noWrap` line detached at its page coordinates. */
function lineAt(text: string, x: number, y: number, style: CanvasTextStyle, italics = false): Content {
  const node: ContentText = { text, noWrap: true, fontSize: style.size, bold: style.bold, ...(italics ? { italics: true } : {}) };
  return { absolutePosition: { x, y }, stack: [node] };
}

/** An item's node detached at its box's top-left. */
const placed = (item: CanvasItem, node: Content): Content => ({ absolutePosition: { x: item.box.x, y: item.box.y }, stack: [node] });

/** A tag field's value, as the flow prints it. */
function valueOf(tag: ContainerTagData, key: string): string | null {
  switch (key) {
    case "order_number": return tag.orderNumber;
    case "customer": return tag.customer;
    case "po_number": return tag.poNumber;
    case "containers_total": return tag.containersTotal;
    case "received": return tag.received;
    default: return null;
  }
}

/** One line of text in a box at the box's alignment, cut at its right edge (R7). */
function cutLine(
  text: string, box: { x: number; w: number }, y: number, style: CanvasTextStyle, family: FontFamily, italics = false,
): { node: Content; cut: boolean } {
  const face = faceOf(style.bold, italics);
  const fitted = fitToWidth(text, family, face, style.size, box.w);
  const width = textWidthOf(fitted.text, family, face, style.size);
  return { node: lineAt(fitted.text, alignedX(box, width, style.align), y, style, italics), cut: fitted.cut };
}

/** Order # (R10): whole, at the box's alignment when it fits; wider, from the box's left, moved left
 *  to end at the label's right margin, never past its left margin. */
function wholeLine(text: string, item: FieldItem, family: FontFamily, page: Page): { node: Content; past: boolean } {
  const { box, style } = item;
  const width = textWidthOf(text, family, faceOf(style.bold), style.size);
  if (width <= box.w) return { node: lineAt(text, alignedX(box, width, style.align), box.y, style), past: false };
  const x = Math.max(page.margin, Math.min(box.x, page.width - page.margin - width));
  return { node: lineAt(text, x, box.y, style), past: true };
}

/** The part lines (R4): as many as the box holds, a typed label the first of them when the box holds
 *  two or more; at one line the line is the part, or the more line naming every part. */
function partLines(tag: ContainerTagData, item: FieldItem, family: FontFamily): Printed {
  const total = tag.parts.length;
  if (total === 0) return null;
  const { box, style } = item;
  const lineHeight = lineHeightOf(family, faceOf(style.bold), style.size);
  const k = Math.floor(box.h / lineHeight + LINE_EPSILON);
  const label = printedLabel(CONTAINER_TAG_CONTRACT, item);
  const texts: { text: string; italics: boolean }[] = [];
  if (label !== "" && k >= 2) texts.push({ text: oneLine(label), italics: false });
  const room = Math.max(0, k - texts.length);
  const shown = total <= room ? total : Math.max(0, room - 1);
  for (const part of tag.parts.slice(0, shown)) texts.push({ text: oneLine(part), italics: false });
  if (shown < total && room > 0) texts.push({ text: moreParts(total - shown), italics: true });
  let cut = false;
  const nodes = texts.map((line, i) => {
    const printed = cutLine(line.text, box, box.y + i * lineHeight, style, family, line.italics);
    cut ||= printed.cut;
    return printed.node;
  });
  return { nodes, flags: { ...(cut ? { cut: true } : {}), parts: { shown, total } } };
}

/** An item's nodes on one tag and what the measure says of it, or null when it prints nothing. */
function printItem(
  tag: ContainerTagData, item: CanvasItem, config: TemplateConfig, page: Page, logoDataUri: string | undefined,
): Printed {
  const { family } = config.fonts;
  switch (item.kind) {
    case "field": {
      if (item.key === "parts") return partLines(tag, item, family);
      const value = valueOf(tag, item.key);
      if (value === null) throw new Error(`A container tag has no field ${item.key}`);
      const text = oneLine(TAG_JOIN(printedLabel(CONTAINER_TAG_CONTRACT, item), value));
      if (item.key === CONTAINER_TAG_CONTRACT.canvas?.oneLabel?.wholeField.key) {
        const printed = wholeLine(text, item, family, page);
        return { nodes: [printed.node], flags: printed.past ? { past: true } : {} };
      }
      const printed = cutLine(text, item.box, item.box.y, item.style, family);
      return { nodes: [printed.node], flags: printed.cut ? { cut: true } : {} };
    }
    case "text": {
      const printed = cutLine(oneLine(item.text), item.box, item.box.y, item.style, family);
      return { nodes: [printed.node], flags: printed.cut ? { cut: true } : {} };
    }
    case "line":
    case "box":
      return { nodes: [placed(item, strokeContent(item))], flags: {} };
    case "logo": {
      const node = logoContent(item, logoDataUri);
      return node === null ? null : { nodes: [placed(item, node)], flags: {} };
    }
    default:
      // The profile places no table, barcode or text block on a tag (rule 1 refuses each).
      throw new Error(`A container tag prints no ${item.kind} item`);
  }
}

/**
 * The canvas tags: one page per tag, every item at its drawn place, and the first tag's measure.
 * `logoDataUri` is the template's logo, which a Logo item prints; with none, a Logo item prints nothing.
 */
export function buildContainerTagCanvas(
  tags: ContainerTagData[], config: TemplateConfig, logoDataUri?: string,
): { def: RenderableDefinition; measure: CanvasMeasure } {
  if (tags.length === 0) throw new Error("A container tag file needs at least one tag");
  const layout = config.layout;
  if (layout === null) throw new Error("A canvas container tag needs a layout");
  const page = TAG_LABEL_SIZES[config.formats.labelSize ?? "4x3-landscape"];
  let measured: MeasureItem[] = [];
  const content = tags.map((tag, i): Content => {
    const nodes: Content[] = [];
    const items: MeasureItem[] = [];
    for (const item of layout.items) {
      const printed = printItem(tag, item, config, page, logoDataUri);
      if (printed === null) continue;
      nodes.push(placed(item, mark(CANVAS_IDS.item(item.id))), ...printed.nodes);
      items.push({ id: item.id, page: 1, left: item.box.x, top: item.box.y, height: item.box.h, ...printed.flags });
    }
    if (i === 0) measured = items;
    return { stack: nodes, ...(i === 0 ? {} : { pageBreak: "before" as const }) };
  });
  return {
    def: {
      pageSize: { width: page.width, height: page.height },
      pageMargins: [0, 0, 0, 0],
      defaultStyle: { font: config.fonts.family, fontSize: config.fonts.baseSize },
      content,
    },
    measure: { pages: 1, tables: [], regions: [], items: measured },
  };
}
