/**
 * The container tag's canvas SEED (the container tag design of 2026-11-13 §7.4, call 14; container tag
 * PR 3): a tag draft's canvas starts from today's tag. Unlike the Letter documents' seeds, nothing is
 * laid out and read back: the flow (`buildContainerTags`) prints one `noWrap` line per field, top to
 * bottom from the label's top margin, so each field's place is worked from the line heights the print
 * and the rules both read (`lineHeightOf`, through the designer's `oneLineHeight`).
 *
 * What the seed does:
 *  - it reads the picked order as the preview reads it, on one read-only RepeatableRead transaction,
 *    and refuses it in the preview's own sentences (`TAG_ORDER_NOT_FOUND` 404, `TAG_ORDER_VOIDED`
 *    400, `TAG_NO_ROWS` 400), so the seed answers only for an order Print tags would print; nothing
 *    of the order reaches the layout, which is the same for every order;
 *  - it lays out each visible field of the config, in the config's order (the order the flow prints
 *    them in), as one page-top field item: `tag-<key>`, x the label's left margin and w its content
 *    width (14 and 260 on 4 × 3), its label the config's (null when untyped, as the flow's own), its
 *    style the flow's for that field (Order # at the heading size bold, Customer at the base size
 *    plus 2 bold, every other field at the base size), left-aligned;
 *  - each box is one line tall at its size (`oneLineHeight`, rounded UP to 0.001, so a box never
 *    holds less than its line and the part lines' `floor(h / line)` never loses one), and the part
 *    lines' box seven such lines: the flow's six and its more line, so a seeded tag lists what
 *    today's does (an order of exactly seven parts prints all seven on the canvas where the flow
 *    prints six and `and 1 more part`: call 14's one difference);
 *  - each item's y follows the flow's top margins (Customer 2, PO 4, the part lines 6), stacked from
 *    the label's top margin under the drawn boxes above it, so boxes that abut in the flow abut on
 *    the seed; every figure snapped to 0.001 pt;
 *  - it places nothing else: the flow prints no logo, line or box.
 *
 * The seed is the same for every order, so it draws the part lines' box at the flow's most. Two
 * differences from the flow's paper follow by design: an order of exactly seven parts (six with a typed
 * parts label) prints them all, where the flow prints one fewer and its more line; and a field the
 * config puts below the part lines sits under the seven-line box, where the flow puts it under the
 * lines it printed.
 *
 * It refuses, as a 400, two configs the flow's own rules accept (the controller's ruling of 2026-11-13,
 * overturning the plan's "no seed refusal": R11 proves the FLOW's stack fits, and a sweep found the
 * seed's stack is not quite the flow's):
 *  - a shown Customer at a body size over 70, which the flow prints at `baseSize + 2`, past the 72 pt
 *    a canvas item's style takes (`SEED_SIZE_CAP`), checked after the order's three refusals, so an
 *    order the preview refuses is refused first;
 *  - a seeded layout the canvas rules refuse on the tag's page with the config's fonts
 *    (`seedNoFit`): every box rounded UP to 0.001, the part lines' seven times, can put the stack a
 *    few thousandths past the foot where the flow's raw stack is just under it (Roboto, every field
 *    shown, heading 34, base 10.38: the flow 187.992 pt, the seed's part lines past 202). Only a
 *    `TemplateConfigError` or a `ZodError` from that final judgement maps to it; anything else rethrows.
 * R11 itself stays as PR 1 built it. It writes nothing. This module imports nothing from
 * template-canvas-seed.ts.
 */
import { ZodError } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { TAG_NO_ROWS, TAG_ORDER_NOT_FOUND, TAG_ORDER_VOIDED, readContainerTagsOrder } from "./container-tags";
import { oneLineHeight } from "@/lib/canvas-designer";
import { validateCanvasLayout } from "@/lib/template-canvas";
import { CONTAINER_TAG_CONTRACT } from "@/lib/template-contracts/container-tag";
import { TAG_LABEL_SIZES, canvasPageFor, type CanvasItem, type CanvasLayout, type CanvasTextStyle } from "@/lib/template-contracts/canvas";
import { TemplateConfigError, completeSections, type TemplateConfig } from "@/lib/template-contracts/types";

/** The part lines' box, in lines: the flow's six and its more line. */
export const SEEDED_PART_LINES = 7;

/** The size cap's refusal: Customer prints at the body size plus 2, and no canvas item takes over 72 pt. */
export const SEED_SIZE_CAP = "Customer prints at the body size plus 2 pt, past the 72 pt a canvas item can take; lower the body size.";
/** The largest size a canvas item's style takes (`canvasLayoutSchema`'s). */
const ITEM_SIZE_MAX = 72;

/** The refusal of a seeded layout the canvas rules refuse, the rounding at the label's foot included. */
export const seedNoFit = (labelName: string) =>
  `The tag's text sizes do not fit one ${labelName} label as a canvas; lower the base or heading size.`;

const snap = (n: number) => Math.round(n * 1000) / 1000;

/** The flow's style and top margin for each field (`tagStack` in src/server/pdf/container-tags.ts). */
function flowLine(key: string, config: TemplateConfig): { style: CanvasTextStyle; above: number } {
  const { baseSize, headingSize } = config.fonts;
  switch (key) {
    case "order_number": return { style: { size: headingSize, bold: true, align: "left" }, above: 0 };
    case "customer": return { style: { size: baseSize + 2, bold: true, align: "left" }, above: 2 };
    case "po_number": return { style: { size: baseSize, bold: false, align: "left" }, above: 4 };
    case "parts": return { style: { size: baseSize, bold: false, align: "left" }, above: 6 };
    default: return { style: { size: baseSize, bold: false, align: "left" }, above: 0 };
  }
}

/** The seeded tag's items, pure: the config's visible fields in its order, each at the flow's place. */
export function seedContainerTagItems(config: TemplateConfig): CanvasItem[] {
  const page = canvasPageFor("CONTAINER_TAG", config.formats.labelSize);
  const x = page.margin;
  const w = page.width - 2 * page.margin;
  const section = completeSections(CONTAINER_TAG_CONTRACT, config.sections).find((s) => s.key === "tag");
  const items: CanvasItem[] = [];
  let y = page.margin;
  for (const field of section?.fields ?? []) {
    if (!field.visible) continue;
    const { style, above } = flowLine(field.key, config);
    const item: Extract<CanvasItem, { kind: "field" }> = {
      id: `tag-${field.key}`, kind: "field", key: field.key, label: field.label ?? null, style,
      box: { x, y: snap(y + above), w, h: 0 }, anchor: { kind: "page-top" }, repeat: false,
    };
    const line = oneLineHeight(item, config.fonts);
    item.box.h = snap(field.key === "parts" ? line * SEEDED_PART_LINES : line);
    items.push(item);
    y = item.box.y + item.box.h;
  }
  return items;
}

/** Read-only, on one RepeatableRead snapshot, as the preview reads. */
function readOnly<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/**
 * The layout that prints the submitted flow config's tag (§7.4). `config` is validated by the caller
 * with its own `layout` set aside. The picked order is read and refused as the preview refuses it;
 * `logoDataUri` is taken for the dispatcher's shape and places nothing, the flow printing no logo.
 */
export async function seedContainerTagLayout(
  recordId: string, config: TemplateConfig, logoDataUri?: string,
): Promise<CanvasLayout> {
  void logoDataUri;
  const order = await readOnly((tx) => readContainerTagsOrder(tx, recordId));
  if (!order) throw new HttpError(404, TAG_ORDER_NOT_FOUND);
  if (order.deletedAt !== null) throw new HttpError(400, TAG_ORDER_VOIDED);
  if (order.containers.length === 0) throw new HttpError(400, TAG_NO_ROWS);
  // The size cap after the order's three refusals, so an order the preview refuses is refused here first.
  const section = completeSections(CONTAINER_TAG_CONTRACT, config.sections).find((s) => s.key === "tag");
  const customerShown = section?.fields.some((f) => f.key === "customer" && f.visible) ?? false;
  if (customerShown && config.fonts.baseSize + 2 > ITEM_SIZE_MAX) throw new HttpError(400, SEED_SIZE_CAP);
  const layout: CanvasLayout = { version: 1, items: seedContainerTagItems(config) };
  try {
    validateCanvasLayout(layout, CONTAINER_TAG_CONTRACT, {
      pageFooter: config.pageFooter, page: canvasPageFor("CONTAINER_TAG", config.formats.labelSize), fonts: config.fonts,
    });
  } catch (err) {
    if (err instanceof TemplateConfigError || err instanceof ZodError) {
      throw new HttpError(400, seedNoFit(TAG_LABEL_SIZES[config.formats.labelSize ?? "4x3-landscape"].name));
    }
    throw err;
  }
  return layout;
}
