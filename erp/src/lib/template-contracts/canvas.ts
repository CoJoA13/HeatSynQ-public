/**
 * The traveler's optional free-canvas layout: a page of positioned items, each with an anchor.
 *
 * This file imports zod and one type alone (`LabelSize`, from `types.ts`, a type-only import erased
 * at build), so `types.ts` can import it without a runtime cycle. It states the shape and the bounds
 * of one item only; the rules over a whole layout (stacking, regions, the barcode floor, the repeat
 * rule) live in `src/lib/template-canvas.ts`.
 */
import { z } from "zod";
import type { LabelSize } from "./types";

export const CANVAS_PAGE = { width: 612, height: 792, margin: 24 } as const;
/** A canvas's page, in points: its size and the margin on every side. Letter (`CANVAS_PAGE`) for the
 *  eight Letter documents, the label stock's for the container tag (`canvasPageFor`). */
export type CanvasPage = { width: number; height: number; margin: number };
/** The container tag's page for each label stock (owner ruling R3, the container tag design of
 *  2026-11-13 §5, §7.1), in points: `name` is how a sentence names the stock ("one 4 × 3 label"),
 *  and the content box is the page less `margin` on every side (260 × 188 on 4 × 3). */
export const TAG_LABEL_SIZES: Record<LabelSize, { name: string; width: number; height: number; margin: number }> = {
  "4x3-landscape": { name: "4 × 3", width: 288, height: 216, margin: 14 },
};
/** The page a template's canvas is judged on: the container tag's label stock (`labelSize`, the
 *  4 × 3 landscape when none is given), Letter for every other type. Takes a plain string, since this
 *  file imports nothing at runtime but zod. */
const TAG_PAGES: Record<LabelSize, CanvasPage> = Object.fromEntries(
  Object.entries(TAG_LABEL_SIZES).map(([size, { width, height, margin }]) => [size, { width, height, margin }]),
) as Record<LabelSize, CanvasPage>;
export function canvasPageFor(docType: string, labelSize?: LabelSize): CanvasPage {
  if (docType !== "CONTAINER_TAG") return CANVAS_PAGE;
  return TAG_PAGES[labelSize ?? "4x3-landscape"];
}
export const CANVAS_GRID = 4.5;
export const BARCODE_MIN = { width: 186, height: 44 } as const;
/** The "(continued)" line a canvas traveler prints on its continuation pages (Ruling 16, PR B of
 *  #926): its size, and the height and width of the box it takes at the repeat band's bottom-left
 *  (`continuedBox` in `src/lib/template-canvas.ts`). On Letter the band holds the box: its least height,
 *  the page margin (24), passes the line's height plus one grid step (10 + 4.5). A tag page (margin 14)
 *  never repeats, since its rules refuse repeat (PR 3). */
export const CONTINUED_FONT_SIZE = 8;
export const CONTINUED_LINE_HEIGHT = 10;
export const CONTINUED_WIDTH = 60;
/** The traveler's four tables, the keys its profile names (`TRAVELER_CANVAS`). A layout's table key
 *  is a string the contract's profile judges (rule 1), so one schema reads every document's layout. */
export const CANVAS_TABLES = ["lines", "quantities", "inspections", "steps"] as const;
export type CanvasTableKey = string;

export type CanvasAnchor =
  | { kind: "page-top" }
  | { kind: "below-table"; table: string }
  | { kind: "page-bottom" };
/** Points from the page's top-left; for a below-table item `y` is the offset from the table's rendered bottom. */
export type CanvasBox = { x: number; y: number; w: number; h: number };
export type CanvasTextStyle = { size: number; bold: boolean; align: "left" | "center" | "right" };
export type CanvasColumn = { key: string; visible: boolean; label: string | null; width: number | null };
type Common = { id: string; box: CanvasBox; anchor: CanvasAnchor; repeat: boolean };
export type CanvasItem =
  | (Common & { kind: "field"; key: string; label: string | null; style: CanvasTextStyle })
  | (Common & { kind: "table"; key: string; heading: string | null; columns: CanvasColumn[] })
  | (Common & { kind: "logo" })
  | (Common & { kind: "barcode" })
  | (Common & { kind: "textBlock"; key: string; style: CanvasTextStyle })
  | (Common & { kind: "text"; text: string; style: CanvasTextStyle })
  | (Common & { kind: "line"; weight: number })
  | (Common & { kind: "box"; weight: number });
export type CanvasLayout = { version: 1; items: CanvasItem[] };

const num = z.number().finite();
const boxSchema = z.object({ x: num, y: num, w: num, h: num }).strict();
const anchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page-top") }).strict(),
  z.object({ kind: z.literal("below-table"), table: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("page-bottom") }).strict(),
]);
const styleSchema = z
  .object({ size: num.min(4).max(72), bold: z.boolean(), align: z.enum(["left", "center", "right"]) })
  .strict();
const columnSchema = z
  .object({ key: z.string(), visible: z.boolean(), label: z.string().nullable(), width: num.positive().nullable() })
  .strict();
const weight = num.min(0.25).max(4);
const common = { id: z.string().min(1), box: boxSchema, anchor: anchorSchema, repeat: z.boolean() };

const itemSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("field"), key: z.string(), label: z.string().nullable(), style: styleSchema }).strict(),
  z.object({
    ...common, kind: z.literal("table"), key: z.string().min(1),
    heading: z.string().nullable(), columns: z.array(columnSchema),
  }).strict(),
  z.object({ ...common, kind: z.literal("logo") }).strict(),
  z.object({ ...common, kind: z.literal("barcode") }).strict(),
  z.object({ ...common, kind: z.literal("textBlock"), key: z.string().min(1), style: styleSchema }).strict(),
  z.object({ ...common, kind: z.literal("text"), text: z.string(), style: styleSchema }).strict(),
  // A line is drawn along one axis: a stroke with both sides drawn would ink a filled box.
  z.object({ ...common, kind: z.literal("line"), weight }).strict()
    .refine((line) => (line.box.w === 0) !== (line.box.h === 0), { message: "a line is horizontal (h 0) or vertical (w 0)" }),
  z.object({ ...common, kind: z.literal("box"), weight }).strict(),
]);

export const canvasLayoutSchema: z.ZodType<CanvasLayout> = z
  .object({ version: z.literal(1), items: z.array(itemSchema) })
  .strict();
