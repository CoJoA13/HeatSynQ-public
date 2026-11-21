/**
 * The certification's canvas SEED (design `docs/superpowers/specs/2026-11-10-cert-canvas-design.md`
 * §5.3, §4.4): a certification draft's canvas starts from today's paper. The flow config the editor
 * holds is laid out ONCE for a stand-in copy of the picked certification (`certStandIn`), and every
 * piece is read back from where it landed, so the `CanvasLayout` answered prints the same lines in the
 * same places. Nothing is stored. `seedCanvasLayout` (template-canvas-seed.ts) dispatches a CERT
 * template here; it lives in its own module beside that one, as the bill of lading's does
 * (`bol-canvas-seed.ts`, the model).
 *
 * The flow marks its pieces and blocks only when asked (`buildCertDefinition`'s `seedIds`,
 * `CERT_SEED_IDS` in pdf/cert.ts): a piece's end mark before its bottom margin, so a seeded box is
 * the piece alone; a block's marks by the wrapper and margin rule's kind (§5.2). Positions report a
 * left and a top only, so every width comes from the flow's own constants (`CERT_WIDTHS`) and every
 * style from the flow's own (`certSeedStyle`).
 *
 * What the seed does (§5.3, the plan's calls):
 *  - it lays every growing block out at its least, from a stand-in whose growing pieces are always
 *    placeholders (`CERT_STAND_IN`: the To box with no `attn` line, one part line (two where the
 *    config shows the multi-part heading row alone of the requirements' rows, `certStandIn`), one
 *    requirement of one line of three readings, one serial, one line of freeform text, the
 *    statement as the template's wording or one placeholder line when it is empty); the picked
 *    cert's own company, order label, dates, PO, packing list and material, and the acting user as
 *    the signer, are kept;
 *  - it refuses only where the template's settings stop the least layout fitting one page, in one of
 *    its sentences, each naming those settings: where that render runs past one page; where the
 *    header or the parties do not fit the page's width (`pastTheRightMargin`: a logo's width, or a
 *    font and heading size whose title is one long word, can leave the header's centre column no
 *    width, or push its right column past the page's right margin, where `tidy`'s clamp leaves it
 *    none; a long unbroken To label, or a large font, does the same to the parties' right column,
 *    which the To column pushes); and where it
 *    fits one page in the flow but the drawn stack does not fit the canvas's page (`fitsTheCanvas`:
 *    the strip's band and the page line's room above the flow's bottom margin, and the row-floor
 *    `lift`, can each put a block's drawn bottom past the band's top); then the seeded layout is
 *    judged by the canvas rules, and any other refusal is the seed's own fault and surfaces unmapped;
 *  - it draws every block at least the profile's row floor tall, and every later block lower by the
 *    clamps above it (`lift`), so each still prints at the flow's place (the sheet spaces a block from
 *    the one above it by their drawn distance);
 *  - it anchors every piece by the walk (the last block whose end the walk has passed, else the
 *    page's top), but for the parties' right column (`po_number`, `packing_list_no`, `material`),
 *    which is anchored as the To block is: in the flow those three print in the same columns node as
 *    the To stack and after it in document order, where the walk would put them below the To block;
 *  - it seeds the parties' rule as a Line riding the To block (by the walk: page-top with the To
 *    field hidden);
 *  - it places the company strip in the page-bottom band from the flow's column arithmetic, each of
 *    its two fields repeated, their heights from one alone layout (`certStrip`), at the flow's 754 pt
 *    where the taller fits above the page's foot, else with that one's bottom at the foot;
 *  - it flags `order_no` to repeat where it stands page-top at least one grid step above the first
 *    block, with no shift ever.
 *
 * This module imports nothing from template-canvas-seed.ts, which imports it.
 */
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { CERT_SIGNER_SELECT, certPrintSettings, readCertPdfData } from "./certs";
import {
  CERT_PAGE, CERT_SEED_IDS, CERT_WIDTHS, buildCertDefinition, certCanvasItemContent, certSeedStyle, type CertPdfData,
} from "./pdf/cert";
import { layOutSheetGroups, renderSheetGroupsWithPositions, type LaidOutNode } from "./pdf/render";
import { CANVAS_IDS, aloneLayouts } from "./pdf/canvas-sheet";
import { formatDateOnly, todayDateOnly } from "../lib/business-days";
import { bandTop, canvasProfile, pageFoot, tablesByY, floorRefusal, validateCanvasLayout, widthFloorRefusal } from "@/lib/template-canvas";
import { CERT_CONTRACT } from "@/lib/template-contracts/cert";
import {
  CANVAS_GRID, CANVAS_PAGE, type CanvasAnchor, type CanvasBox, type CanvasColumn, type CanvasItem, type CanvasLayout,
  type CanvasTextStyle,
} from "@/lib/template-contracts/canvas";
import { CONTENT_WIDTH, type TemplateConfig } from "@/lib/template-contracts/types";

const W = CERT_WIDTHS;
const LEFT = CANVAS_PAGE.margin;
const RIGHT = CANVAS_PAGE.width - CANVAS_PAGE.margin;
/** A block's least drawn height, the profile's. */
const ROW_FLOOR = canvasProfile(CERT_CONTRACT).rowFloor;
/** The flow's strip top: the page less its 44 pt bottom margin, plus the strip's 6 pt inset (754). */
const STRIP_TOP = CANVAS_PAGE.height - CERT_PAGE.bottomMargin + CERT_PAGE.stripInset;

/** The seven blocks, each opened by its `start` mark and closed by its `sectionEnd` mark. */
const BLOCKS = ["to", "parts", "statement", "requirements", "serials", "freeform", "signature"] as const;
type Block = (typeof BLOCKS)[number];
/** The header's centre column and right column, and the parties' right column. */
const HEADER_CENTRE = new Set(["company_name", "title"]);
const HEADER_RIGHT = new Set(["order_no", "print_date", "entry_date"]);
const PARTIES_RIGHT = ["po_number", "packing_list_no", "material"];
/** The rows blocks' rows, in their fixed print order (§4.2). */
const ROWS: Partial<Record<Block, string[]>> = {
  requirements: ["part_heading", "spec_line", "readings"],
  signature: ["signature_mark", "signer_name", "signer_title", "signer_company"],
};
/** The list blocks keyed by one field of their own: that field hidden, the block prints nothing on
 *  any cert and a canvas cannot carry its `visible: false` (a list stores no column), so no block. */
const LIST_FIELD: Partial<Record<Block, { section: string; key: string }>> = {
  to: { section: "parties", key: "to" },
  serials: { section: "serials", key: "serials" },
  freeform: { section: "freeform", key: "freeform" },
};

const pageTop: CanvasAnchor = { kind: "page-top" };

/**
 * The stand-in's placeholders (the controller's call 3): every growing piece at its least, a block
 * the picked cert lacks invented so it has a position. The statement's is used only when the
 * template's wording is empty.
 */
export const CERT_STAND_IN = {
  to: { attn: "", name: "Customer", street: "Street", city: "City", state: "ST", zip: "00000" },
  part: { qty: 1, partNumber: "Part", partName: "", partDescription: "", pounds: 1 },
  requirement: {
    lineIdentity: "stand-in-1", linePosition: 1, partNumber: "Part", partName: "", specification: "Specification",
    scale: "", readings: [1, 2, 3],
  },
  serialBlock: { partNumber: "Part", serials: [{ serial: "Serial", description: "" }] },
  freeform: "Freeform text",
  statement: "Certification statement",
} as const;

/** The config's field entry, for its typed label and its visibility. */
function fieldConfig(config: TemplateConfig, section: string, key: string) {
  return config.sections.find((s) => s.key === section)?.fields.find((f) => f.key === key);
}
const shown = (config: TemplateConfig, section: string, key: string) => fieldConfig(config, section, key)?.visible ?? true;

/**
 * The stand-in the seed lays out (§5.3): the picked cert's own company, order label, dates, PO,
 * packing list, material and signer; the template's statement (the placeholder when it is empty);
 * every growing piece `CERT_STAND_IN`'s. Two part lines (`Part`, `Part 2`) where the config shows the
 * multi-part heading and hides both the specification line and the readings, so the heading prints
 * and the requirements block has a height.
 */
export function certStandIn(d: CertPdfData, config: TemplateConfig): CertPdfData {
  const s = CERT_STAND_IN;
  const twoParts = shown(config, "requirements", "part_heading")
    && !shown(config, "requirements", "spec_line") && !shown(config, "requirements", "readings");
  const wording = config.textBlocks.cert_statement ?? "";
  return {
    ...d,
    statement: wording === "" ? s.statement : wording,
    to: { ...s.to },
    parts: twoParts ? [{ ...s.part }, { ...s.part, partNumber: "Part 2" }] : [{ ...s.part }],
    requirements: [{ ...s.requirement, readings: [...s.requirement.readings] }],
    serialBlocks: [{ partNumber: s.serialBlock.partNumber, serials: s.serialBlock.serials.map((x) => ({ ...x })) }],
    freeform: s.freeform,
  };
}

function style(key: string, config: TemplateConfig): CanvasTextStyle {
  const s = certSeedStyle(key, config.fonts);
  if (s === null) throw new Error(`The certification's seed has no style for ${key}.`);
  return s;
}

/** The contract section holding a field. */
const SECTION_OF = new Map(CERT_CONTRACT.sections.flatMap((s) => s.fields.map((f) => [f.key, s.key] as const)));

/** A field item, its label the config's (null: the contract's default, as the flow reads it). */
function fieldItem(config: TemplateConfig, key: string, box: CanvasBox, anchor: CanvasAnchor, repeat = false): CanvasItem {
  return {
    kind: "field", id: crypto.randomUUID(), key, label: fieldConfig(config, SECTION_OF.get(key)!, key)?.label ?? null,
    box, anchor, repeat, style: style(key, config),
  };
}

/** A block's table item: the To block headed by the parties' `to` label and the serials by their
 *  label (null when untyped); the part lines with the config's columns in its order, each with its
 *  visible, label and typed width; a rows block with its rows in their fixed order, each with the
 *  config's visible and label and no width; the other lists with none. */
function tableItem(config: TemplateConfig, key: Block, box: CanvasBox, anchor: CanvasAnchor): CanvasItem {
  const heading = key === "to" ? fieldConfig(config, "parties", "to")?.label ?? null
    : key === "serials" ? fieldConfig(config, "serials", "serials")?.label ?? null : null;
  let columns: CanvasColumn[] = [];
  if (key === "parts") {
    const isColumn = (k: string) => CERT_CONTRACT.sections.find((s) => s.key === "parts")!.fields
      .find((f) => f.key === k)?.column?.table === "parts";
    columns = config.sections.find((s) => s.key === "parts")!.fields.filter((f) => isColumn(f.key)).map((f) => ({
      key: f.key, visible: f.visible ?? true, label: f.label ?? null, width: typeof f.width === "number" ? f.width : null,
    }));
  } else if (ROWS[key] !== undefined) {
    columns = ROWS[key]!.map((k) => {
      const f = fieldConfig(config, key, k);
      return { key: k, visible: f?.visible ?? true, label: f?.label ?? null, width: null };
    });
  }
  return { kind: "table", id: crypto.randomUUID(), key, box, anchor, repeat: false, heading, columns };
}

const snap = (n: number) => Math.round(n * 1000) / 1000;

/** A box's figures to a thousandth of a point, and its right edge never past the page's right margin
 *  (template-canvas-seed.ts's `tidy`, kept here so this module imports nothing back from that one). */
function tidy(item: CanvasItem): CanvasItem {
  const x = snap(item.box.x);
  const w = Math.min(snap(item.box.w), RIGHT - x);
  return { ...item, box: { x, y: snap(item.box.y), w, h: snap(item.box.h) } } as CanvasItem;
}

/** The most a snapped block may start above the block before it's drawn bottom and still be read as
 *  meeting it: the thousandth `tidy` rounds to, twice (its top and the bottom above it), with room for
 *  the sum's binary error. */
const ROUNDING = 0.0025;

/** The blocks' stack after the snap: two blocks the flow lays out with nothing between them (the
 *  requirements and the serials, both several-node) meet exactly, and a thousandth rounded the wrong
 *  way, or the binary error of `y + h`, would draw the lower one above the upper one's bottom (rule 5).
 *  Each such block is moved down to the first thousandth at or below that bottom, and only by a
 *  rounding step (`ROUNDING`): a real overlap is left for the rules to refuse. Every later block moves
 *  with it (`shift`, the invoice's `sealed`; #960), so the drawn distances stay the flow's and the
 *  moves do not add up: moved each on its own, blocks back to back would add their moves up past
 *  `ROUNDING`. On the Standard in Roboto and Liberation Sans the serials move a thousandth, and the
 *  freeform and signature blocks with them. */
function sealed(items: CanvasItem[]): CanvasItem[] {
  const moved = new Map<string, number>();
  let bottom: number | null = null;
  let shift = 0;
  for (const t of tablesByY({ version: 1, items })) {
    let y = shift === 0 ? t.box.y : snap(t.box.y + shift);
    if (bottom !== null && y < bottom && bottom - y <= ROUNDING) {
      y = Math.ceil(bottom * 1000) / 1000;
      while (y < bottom) y = snap(y + 0.001);
    }
    if (y !== t.box.y) {
      moved.set(t.id, y);
      shift = y - t.box.y;
    }
    bottom = y + t.box.h;
  }
  return items.map((i) => (moved.has(i.id) ? { ...i, box: { ...i.box, y: moved.get(i.id)! } } as CanvasItem : i));
}

/**
 * The company strip's two band items (§4.4, call 6), given each one's height (null: not shown, the
 * footer section or the field hidden): x and widths from the flow's column arithmetic (both shown,
 * the address `564 − footerPhone` wide at the left margin and the phone `footerPhone` wide at the
 * right; the address alone the full width; the phone alone `footerPhone` wide at the LEFT margin, the
 * strip's first column), one top for both, the flow's 754 where the taller ends at or above the
 * page's foot, else the taller's bottom at the foot. Each repeated, so the strip prints on every page.
 */
function stripItems(config: TemplateConfig, strip: { address: number | null; phone: number | null }, pageFooter: boolean): CanvasItem[] {
  const heights = [strip.address, strip.phone].filter((h): h is number => h !== null).map(snap);
  if (heights.length === 0) return [];
  const taller = Math.max(...heights);
  const foot = pageFoot(pageFooter);
  const top = STRIP_TOP + taller <= foot ? STRIP_TOP : snap(foot - taller);
  const bottom: CanvasAnchor = { kind: "page-bottom" };
  const items: CanvasItem[] = [];
  if (strip.address !== null) {
    const w = strip.phone !== null ? CONTENT_WIDTH - W.footerPhone : CONTENT_WIDTH;
    items.push(fieldItem(config, "footer_address", { x: LEFT, y: top, w, h: snap(strip.address) }, bottom, true));
  }
  if (strip.phone !== null) {
    const x = strip.address !== null ? RIGHT - W.footerPhone : LEFT;
    items.push(fieldItem(config, "footer_phone", { x, y: top, w: W.footerPhone, h: snap(strip.phone) }, bottom, true));
  }
  return items;
}

/**
 * The company strip's two heights, each laid out ALONE at its seeded x and width (the `aloneLayouts`
 * technique, the preview's measure's), from the item node the sheet prints it with; null for a field
 * not shown (the footer section or the field hidden). Both are placed at one top, so the offset
 * `aloneLayouts` takes off each is 0 and each height is its end mark's top.
 */
export async function certStrip(
  d: CertPdfData, config: TemplateConfig, logoDataUri?: string,
): Promise<{ address: number | null; phone: number | null }> {
  const footer = config.sections.find((s) => s.key === "footer");
  const visible = footer?.visible ?? true;
  const candidate = {
    address: visible && shown(config, "footer", "footer_address") ? 0 : null,
    phone: visible && shown(config, "footer", "footer_phone") ? 0 : null,
  };
  const items = stripItems(config, candidate, config.pageFooter);
  if (items.length === 0) return candidate;
  const layout: CanvasLayout = { version: 1, items };
  const itemContent = certCanvasItemContent(d, { ...config, layout }, logoDataUri);
  const alone = aloneLayouts({ layout, pageFooter: config.pageFooter, fonts: config.fonts, itemContent });
  const [positions] = await layOutSheetGroups(alone.map((a) => a.def));
  const heightOf = (key: string): number | null => {
    const item = items.find((i) => i.kind === "field" && i.key === key);
    if (item === undefined) return null;
    const end = positions.find((n) => n.id === CANVAS_IDS.itemEnd(item.id));
    if (end === undefined) throw new Error(`The strip's alone layout has no end for ${key}.`);
    return end.top;
  };
  return { address: heightOf("footer_address"), phone: heightOf("footer_phone") };
}

/**
 * The items, from the positions of the one layout, in the order the flow draws them, and the strip's
 * band items. Each piece's anchor is the last block whose end the walk has passed, its `y` its top
 * less that block's laid-out end (the page's top: 0), but the parties' right column, which takes the
 * anchor in force when the To block opened (the calls). A hidden field, section or column prints
 * nothing, so it has no position and seeds nothing; a list block whose one field is hidden seeds no
 * block; a block whose builder answered nothing seeds at the row floor from its start mark.
 */
export function seedCertItems(
  config: TemplateConfig, positions: LaidOutNode[], strip: { address: number | null; phone: number | null },
  logoPlaced: boolean, pageFooter: boolean,
): CanvasItem[] {
  const byId = new Map(positions.map((n) => [n.id, n] as const));
  const endOf = (key: string): number => {
    const node = byId.get(CERT_SEED_IDS.end(key));
    if (node === undefined) throw new Error(`The seed's layout has no position for ${CERT_SEED_IDS.end(key)}.`);
    return node.top;
  };

  // The header's centre column: the content less the left column (a header-left logo's width, else
  // the 100 pt spacer), the right column and the two gaps.
  const leftColumn = logoPlaced && config.logo !== null && config.logo.placement === "header-left" ? config.logo.width : W.headerLeft;
  const centreWidth = CONTENT_WIDTH - leftColumn - W.headerRight - 2 * W.headerGap;
  const partiesShowRight = PARTIES_RIGHT.some((k) => shown(config, "parties", k));

  const items: CanvasItem[] = [];
  let anchor: CanvasAnchor = pageTop;
  let base = 0;
  /** The anchor in force when the To block opened, which the parties' right column takes. */
  let partiesAnchor: { anchor: CanvasAnchor; base: number } | null = null;
  const open = new Map<Block, LaidOutNode>();
  /** How much lower than its laid-out top a block is drawn: the row-floor clamps of the blocks above it. */
  let lift = 0;

  for (const node of positions) {
    const id = node.id;
    // The render reports every id'd node; one the seed did not place is none of the seed's business.
    if (!id.startsWith("seed:")) continue;
    if (id.startsWith("seed:start:")) {
      const key = id.slice("seed:start:".length) as Block;
      open.set(key, node);
      if (key === "to") partiesAnchor = { anchor, base };
      continue;
    }
    if (id.startsWith("seed:end:")) {
      const key = id.slice("seed:end:".length);
      const start = open.get(key as Block);
      if (start === undefined || !(BLOCKS as readonly string[]).includes(key)) continue; // a piece's end
      const block = key as Block;
      const list = LIST_FIELD[block];
      if (list !== undefined && !shown(config, list.section, list.key)) continue;
      const x = block === "signature" ? RIGHT - W.signature : LEFT;
      const w = block === "signature" ? W.signature
        : block === "to" && partiesShowRight ? CONTENT_WIDTH - W.partiesRight - W.partiesGap : CONTENT_WIDTH;
      // A block's drawn box is absolute: its y is its top. Its height is at least the profile's row
      // floor; the walk still passes it at its laid-out end, and the items below it ride its rendered
      // bottom on paper, so their offsets are the flow's. The sheet spaces the next block from this
      // one's DRAWN bottom, so every later block is drawn lower by the clamps above it (`lift`).
      const laidOut = node.top - start.top;
      const h = Math.max(ROW_FLOOR, laidOut);
      items.push(tableItem(config, block, { x, y: start.top + lift, w, h }, anchor));
      lift += h - laidOut;
      anchor = { kind: "below-table", table: block };
      base = node.top;
      continue;
    }
    const key = id.slice("seed:".length);
    const h = endOf(key) - node.top;
    if (PARTIES_RIGHT.includes(key)) {
      const at = partiesAnchor ?? { anchor, base };
      items.push(fieldItem(config, key, { x: node.left, y: node.top - at.base, w: W.partiesRight, h }, at.anchor));
      continue;
    }
    const top = node.top - base;
    if (key === "logo") {
      if (!logoPlaced || config.logo === null) continue;
      items.push({ kind: "logo", id: crypto.randomUUID(), box: { x: node.left, y: top, w: config.logo.width, h }, anchor, repeat: false });
    } else if (HEADER_CENTRE.has(key)) {
      items.push(fieldItem(config, key, { x: node.left, y: top, w: centreWidth, h }, anchor));
    } else if (HEADER_RIGHT.has(key)) {
      items.push(fieldItem(config, key, { x: node.left, y: top, w: W.headerRight, h }, anchor));
    } else if (key === "parties_rule") {
      items.push({
        kind: "line", id: crypto.randomUUID(), box: { x: LEFT, y: top, w: CONTENT_WIDTH, h: 0 }, anchor, repeat: false, weight: 1.5,
      });
    } else {
      throw new Error(`The certification's seed has no item for ${key}.`);
    }
  }
  return sealed([...items, ...stripItems(config, strip, pageFooter)].map(tidy));
}

/**
 * The repeat (§4.4): the order number repeats where it stands page-top at least one grid step above
 * the first block's top (rule 3's own comparison), with no shift ever; otherwise nothing repeats (the
 * number hidden, or printed below a block, or no block placed). Today's flow never reaches the
 * comparison's refusing side: a page-top number prints in the header, whose node carries
 * `CERT_PAGE.headerBottom` (6 pt, pdf/cert.ts) under it ahead of every block, more than one
 * `CANVAS_GRID` step (4.5). It stays as rule 3's guard should that margin shrink, and is exported so
 * a hand-built layout proves it (tests/template-canvas-seed.test.ts).
 */
export function withRepeat(items: CanvasItem[]): CanvasItem[] {
  const number = items.find((i) => i.kind === "field" && i.key === "order_no" && i.anchor.kind === "page-top");
  const first = tablesByY({ version: 1, items })[0];
  if (number === undefined || first === undefined) return items;
  if (number.box.y + number.box.h + CANVAS_GRID > first.box.y) return items;
  return items.map((item) => (item === number ? { ...item, repeat: true } : item));
}

/** The header's items: its centre and right columns' fields and the logo, which prints in it. */
const inHeader = (item: CanvasItem): boolean =>
  item.kind === "logo" || (item.kind === "field" && (HEADER_CENTRE.has(item.key) || HEADER_RIGHT.has(item.key)));
/** The parties' right column, which prints beside the To column. */
const inPartiesRight = (item: CanvasItem): boolean => item.kind === "field" && PARTIES_RIGHT.includes(item.key);

/**
 * The part of the seeded layout that runs past the page's right margin, else null: a header item, or
 * one of the parties' right column, left no width once `tidy` has clamped its right edge to the margin.
 * The flow sizes the header's centre column as the content less the left column (a header-left logo's
 * width) and the 165 pt right column, and pdfmake widens a "*" column to its longest word (a
 * header-center logo's width, or the title at a large heading size), pushing the right column along;
 * the parties' To column is a "*" column too (a long unbroken To label, or a large font). Each can
 * leave a column with no width, which the template's settings alone cause, as the stand-in's own text
 * is fixed. A column pushed only part of the way keeps a clamped width and seeds.
 */
function pastTheRightMargin(layout: CanvasLayout): "header" | "parties" | null {
  if (layout.items.some((item) => inHeader(item) && item.box.w <= 0)) return "header";
  if (layout.items.some((item) => inPartiesRight(item) && item.box.w <= 0)) return "parties";
  return null;
}

/**
 * Whether the seeded layout's drawn stack fits the canvas's one page: rule 4's comparison for a block
 * or a page-top item (its drawn bottom at most the band's top) and rule 8's room for the first block's
 * heading and one row above the band, the two refusals the template's settings alone can cause on a
 * stand-in that fits one page in the flow. The flow may run its content down to its bottom margin
 * (748); the canvas stops a block at the band's top, which with the page line on is the strip's top
 * (about 739), and the row-floor `lift` draws later blocks lower than the flow laid them out. The
 * block clause is the one a template reaches (the seed's cases pin it); the page-top and first-block
 * clauses are backstops no stand-in reaches today, since every page-top item is laid out above the
 * first block and the first block starts near the page's top, so no case reaches either.
 */
function fitsTheCanvas(layout: CanvasLayout, pageFooter: boolean): boolean {
  const band = bandTop(layout, pageFooter);
  for (const item of layout.items) {
    if (item.kind !== "table" && item.anchor.kind !== "page-top") continue;
    if (item.box.y + item.box.h > band) return false;
  }
  const first = tablesByY(layout)[0];
  return first === undefined || first.box.y + canvasProfile(CERT_CONTRACT).firstTableRoom <= band;
}

/** Read-only, on one RepeatableRead snapshot, as the preview reads. */
function readOnly<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/** The blocks' width floors at the content width, before the stand-in is laid out (#991 review I2, the
 *  controller's ruling of 2026-11-17): a template whose columns leave the page no room for a block is
 *  refused in rule 9's or rule 4's own sentence (`widthFloorRefusal`), as before #991, never in the
 *  one-page sentence a stand-in squeezed by the column clamp would reach first. Each shown section's
 *  block is drawn as the seed draws it, at the content width; the To box, a field's block, is drawn at its field's place and judged with the layout. */
function widthFloorsFirst(config: TemplateConfig): void {
  const box = { x: LEFT, y: 0, w: RIGHT - LEFT, h: ROW_FLOOR };
  const items = BLOCKS.filter((block) => block !== "to" && config.sections.find((s) => s.key === block)?.visible === true)
    .map((block) => tableItem(config, block, box, pageTop));
  const floor = widthFloorRefusal({ version: 1, items }, CERT_CONTRACT, { fonts: config.fonts });
  if (floor !== null) throw new HttpError(400, floor.sentence);
}

/**
 * The layout that prints the submitted flow config's certification for the picked cert (§5.3).
 * `config` is validated by the caller with its own `layout` set aside; `logoDataUri` is the version's
 * logo where the config places it; `signerUserId` is the acting user, who signs the seed's render as
 * the preview's (§3.11). The cert is read as the preview reads it, the submitted config's statement at
 * the data seam, so a reversal shipment's cert is refused in #183's sentence there.
 */
export async function seedCertLayout(
  recordId: string, config: TemplateConfig, logoDataUri: string | undefined, signerUserId: string,
): Promise<CanvasLayout> {
  // A config check, before any read: the record cannot change it.
  widthFloorsFirst(config);
  const settings = await certPrintSettings();
  const data = await readOnly(async (tx) => {
    const signer = await tx.user.findFirst({ where: { id: signerUserId }, select: CERT_SIGNER_SELECT });
    if (!signer) throw new HttpError(404, "User not found");
    const { data: read } = await readCertPdfData(tx, recordId,
      { ...settings, statement: config.textBlocks.cert_statement }, signer, formatDateOnly(todayDateOnly()));
    return read;
  });
  const standIn = certStandIn(data, config);
  const laid = await renderSheetGroupsWithPositions([buildCertDefinition(standIn, config, logoDataUri, { seedIds: true })]);
  // A canvas stacks the blocks on one page. At the stand-in's lengths only the template's settings can
  // put the certification on a second page, so the sentence names them.
  const pages = laid.groups[0].pages;
  if (pages > 1) {
    throw new HttpError(400,
      `The canvas starts from a one-page certification; laid out at its least, this template's certification prints ${pages} pages. Change this template's settings (its font, sizes, logo or certification statement) so it fits one page.`);
  }
  const strip = await certStrip(standIn, config, logoDataUri);
  const items = seedCertItems(config, laid.groups[0].positions, strip, logoDataUri !== undefined, config.pageFooter);
  const layout: CanvasLayout = { version: 1, items: withRepeat(items) };
  // The width first: a column left with no width can make the stack taller, and the height sentence
  // would then name the wrong settings.
  const past = pastTheRightMargin(layout);
  if (past === "header") {
    throw new HttpError(400,
      `The canvas starts from a certification whose header fits the page; laid out at its least, this template's header runs past the page's right margin. Change this template's settings (its logo's width, font or heading size) so the header fits the page's width.`);
  }
  if (past === "parties") {
    throw new HttpError(400,
      `The canvas starts from a certification whose To / order fields fit the page; laid out at its least, this template's To / order fields run past the page's right margin. Change this template's settings (its font, sizes or To label) so they fit the page's width.`);
  }
  // One page in the flow is not yet one page on the canvas (design §5.3: the drawn stack must fit the
  // page rule 4 judges). Where it does not, only the template's settings put it there, so the sentence
  // names them, the page line among them; the flow printed one page, so it names no page count.
  if (!fitsTheCanvas(layout, config.pageFooter)) {
    throw new HttpError(400,
      `The canvas starts from a one-page certification; laid out at its least on the canvas, this template's certification runs past one page. Change this template's settings (its font, sizes, logo, page line or certification statement) so it fits one page.`);
  }
  // A block the template's columns leave narrower than its least width (rule 4's or rule 9's floor,
  // #971 design §6) is the template's to change: the 400 in the rule's own sentence.
  const floor = floorRefusal(layout, CERT_CONTRACT, { pageFooter: config.pageFooter, fonts: config.fonts });
  if (floor !== null) throw new HttpError(400, floor.sentence);
  // Every other rule the layout must pass is the seed's to meet: the settings that can break one (the
  // page count, the header's and the parties' widths, the drawn stack's fit) are refused above in their own sentences,
  // so a refusal here is the seed's fault, not mapped to a 400, and surfaces as the fault it is.
  validateCanvasLayout(layout, CERT_CONTRACT, { pageFooter: config.pageFooter, fonts: config.fonts });
  return layout;
}
