/**
 * The customer statement's canvas SEED (design `docs/superpowers/specs/2026-11-11-statement-canvas-design.md`
 * §5.3, §4.4): a statement draft's canvas starts from today's paper. The flow config the editor holds
 * is laid out ONCE for a stand-in statement (`statementStandIn`), and every piece is read back from
 * where it landed, so the `CanvasLayout` answered prints the same lines in the same places. Nothing is
 * stored: no document, no audit row, no draft edit. `seedCanvasLayout` (template-canvas-seed.ts)
 * dispatches a STATEMENT template here, the statement being in `CANVAS_PRINTS` (since statement
 * canvas PR 2); it lives in its own module beside that one, as the bill of lading's, the certification's
 * and the invoice's do (`invoice-canvas-seed.ts`, the model).
 *
 * The flow marks its pieces and blocks only when asked (`buildStatementDefinition`'s `seedIds`,
 * `STATEMENT_SEED_IDS` in pdf/statement.ts): a piece's end mark before its bottom margin, so a seeded
 * box is the piece alone; the Remit To column's wrapper reporting the box's own corner; the Bill To's
 * marks inside the identity's left stack, the stack's own bottom (`leftColumnEnd`) after it, and a
 * top-level mark where the identity opens (`identityStart`); a one-node block's marks inside its
 * node's own margins, the finance block's as top-level siblings above its kept 2 pt (design §5.2).
 * Positions report a left and a top only, so every width comes from the flow's own constants
 * (`STATEMENT_WIDTHS`) and every style from the flow's own (`statementSeedStyle`).
 *
 * What the seed does (§5.3, the plan's calls):
 *  - it reads the picked customer only to refuse a missing one (the preview's 404), and lays out a
 *    stand-in whose every customer-dependent piece is a placeholder (`STATEMENT_STAND_IN`: the
 *    customer line's code and name, a one-line Bill To, one open item at $0.00, the aging at zero, a
 *    finance charge of $0.00 so the finance block is laid out at its line, Total Due $0.00), keeping
 *    the company, the Remit To box and today's date (call 8): the seeded layout is the same whichever
 *    customer is picked;
 *  - it draws every block at least the profile's row floor tall, and every later block lower by the
 *    clamps above it (`lift`), so each still prints at the flow's place; a block that holds its drawn
 *    height (`holdsHeight`, the Bill To) adds nothing to `lift`, since it prints that height and the
 *    sheet spaces the next block from it;
 *  - it draws the Bill To block down to the Remit To box's bottom where the Bill To is the left
 *    column's last shown field and the Remit To is shown, so the open items start under the lower of
 *    the two columns as the flow's do; elsewhere the block is its own content (the left-slot residual,
 *    design §4.5);
 *  - it anchors every piece by the walk (the last block whose end the walk has passed, else the
 *    page's top), its `y` its top less that block's drawn bottom (a held block's) or laid-out end,
 *    but the Remit To box, which takes the anchor in force where the identity opens (the
 *    certification's parties' right column): its marks follow the left stack's in document order;
 *  - it seeds each block's rows or columns in the config's order with the config's visibility and
 *    labels (an untyped label stays null, #162's finance label and ruling 8's aging headings among
 *    them) and the aging's typed widths; a hidden section gives no block, and so does a hidden Bill To
 *    field; any other shown block whose builder answers nothing seeds at the row floor;
 *  - it refuses only where the template's settings stop the canvas starting from today's paper, in
 *    one of its sentences, each naming those settings (open question 5's, the invoice's four in its
 *    order, but that the identity's names the font and the labels alone, never the sizes, which the
 *    identity's lines do not read: the controller's correction, 2026-11-12), in this order: where the stand-in's render runs past one page (its font, sizes or logo,
 *    or the company address, whose lines the Remit To box prints); where the header, or the
 *    identity lines and the Remit To box, do not fit the page's width (`pastTheRightMargin`: a side
 *    logo's width, or a font and heading size whose title is one long word, can leave the header's
 *    pieces no width once `tidy` has clamped them to the margin; a long unbroken identity label,
 *    which pdfmake's "*" column widens to, pushes the Remit To box past it); and where it fits one
 *    page in the flow but the drawn stack does not fit the canvas's page (`fitsTheCanvas`: the page
 *    line's room above the flow's bottom margin, and the row-floor `lift`, can each put a drawn
 *    bottom past the band's top); then the seeded layout is judged by the canvas rules, and any
 *    other refusal is the seed's own fault and surfaces unmapped;
 *  - it flags `customer` to repeat where it stands page-top at least one grid step above the first
 *    block, with no shift ever (call 2, ruled option (a));
 *  - it places nothing in the band (the statement prints no strip).
 *
 * This module imports nothing from template-canvas-seed.ts.
 */
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { invoicePrintSettings, type InvoicePrintSettings } from "./invoices";
import {
  STATEMENT_SEED_IDS, STATEMENT_WIDTHS, buildStatementDefinition, statementSeedStyle, type StatementData,
} from "./pdf/statement";
import { renderSheetGroupsWithPositions, type LaidOutNode } from "./pdf/render";
import { bandTop, canvasProfile, drawnBox, pageFoot, tableSpec, tablesByY, floorRefusal, validateCanvasLayout, widthFloorRefusal } from "@/lib/template-canvas";
import { STATEMENT_CONTRACT } from "@/lib/template-contracts/statement";
import {
  CANVAS_GRID, CANVAS_PAGE, type CanvasAnchor, type CanvasBox, type CanvasColumn, type CanvasItem, type CanvasLayout,
  type CanvasTextStyle,
} from "@/lib/template-contracts/canvas";
import type { TemplateConfig } from "@/lib/template-contracts/types";
import { formatDateOnly, todayDateOnly } from "@/lib/business-days";

const W = STATEMENT_WIDTHS;
const LEFT = CANVAS_PAGE.margin;
const RIGHT = CANVAS_PAGE.width - CANVAS_PAGE.margin;
/** A block's least drawn height, the profile's. */
const ROW_FLOOR = canvasProfile(STATEMENT_CONTRACT).rowFloor;

/** The five blocks, each opened by its `start` mark and closed by its `sectionEnd` mark. */
const BLOCKS = ["bill_to", "open_items", "aging", "finance_charge", "total"] as const;
type Block = (typeof BLOCKS)[number];
/** The header's two pieces, which print as wide as the content less a side logo's column. */
const HEADER = new Set(["title", "company_name"]);
/** The identity lines, which print in the identity's left column past its indent. */
const IDENTITY_LINES = new Set(["customer", "statement_date"]);
/** The identity's left column, in the flow's terms: the fields its left stack can hold. */
const LEFT_COLUMN = ["customer", "statement_date", "bill_to"];

const pageTop: CanvasAnchor = { kind: "page-top" };

/**
 * The stand-in's placeholders (open question 4, design §5.3, call 8): every customer-dependent piece
 * at its least, the customer line's code and name a short fixed pair laid out one line tall at any
 * template's sizes. The company, the Remit To box and today's date are kept.
 */
export const STATEMENT_STAND_IN = {
  customer: { code: "CODE", name: "Customer" },
  billTo: ["Customer"],
  openItem: { documentNumber: "Document", kind: "INVOICE", original: 0, open: 0 },
  financeCharge: 0,
} as const;

/**
 * The stand-in the seed lays out (§5.3): the settings' company and Remit To; `asOf` as the statement
 * date and as the one open item's date and due date; the aging all zeros, carrying the customer's id
 * and the stand-in's code and name; Total Due 0; and `STATEMENT_STAND_IN`'s placeholders.
 */
export function statementStandIn(settings: InvoicePrintSettings, customerId: string, asOf: string): StatementData {
  const s = STATEMENT_STAND_IN;
  return {
    asOf,
    company: settings.company,
    remitTo: settings.remitTo,
    customer: { code: s.customer.code, name: s.customer.name, billTo: [...s.billTo] },
    openItems: [{ ...s.openItem, date: asOf, dueDate: asOf }],
    aging: {
      customerId, customerCode: s.customer.code, customerName: s.customer.name,
      current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, unapplied: 0, net: 0,
    },
    financeCharge: s.financeCharge,
    totalDue: 0,
  };
}

/** The config's field entry, for its typed label and its visibility. */
function fieldConfig(config: TemplateConfig, section: string, key: string) {
  return config.sections.find((s) => s.key === section)?.fields.find((f) => f.key === key);
}

function style(key: string, config: TemplateConfig): CanvasTextStyle {
  const s = statementSeedStyle(key, config.fonts);
  if (s === null) throw new Error(`The statement's seed has no style for ${key}.`);
  return s;
}

/** The contract section holding a field. */
const SECTION_OF = new Map(STATEMENT_CONTRACT.sections.flatMap((s) => s.fields.map((f) => [f.key, s.key] as const)));

/** A field item, its label the config's (null: the contract's default, as the flow reads it). */
function fieldItem(config: TemplateConfig, key: string, box: CanvasBox, anchor: CanvasAnchor): CanvasItem {
  return {
    kind: "field", id: crypto.randomUUID(), key, label: fieldConfig(config, SECTION_OF.get(key)!, key)?.label ?? null,
    box, anchor, repeat: false, style: style(key, config),
  };
}

/** A block's table item: the Bill To headed by the identity's `bill_to` label (null when untyped) with
 *  no columns; every other block with its section's fields in the config's order (the order its
 *  builder prints them in), each with the config's visible and label (`label: f.label`, so an untyped
 *  label stays null and re-resolves at every print) and, on the aging strip, its typed width. */
function tableItem(config: TemplateConfig, key: Block, box: CanvasBox, anchor: CanvasAnchor): CanvasItem {
  if (key === "bill_to") {
    const heading = fieldConfig(config, "identity", "bill_to")?.label ?? null;
    return { kind: "table", id: crypto.randomUUID(), key, box, anchor, repeat: false, heading, columns: [] };
  }
  const columns: CanvasColumn[] = config.sections.find((s) => s.key === key)!.fields.map((f) => ({
    key: f.key, visible: f.visible ?? true, label: f.label ?? null, width: key === "aging" ? f.width ?? null : null,
  }));
  return { kind: "table", id: crypto.randomUUID(), key, box, anchor, repeat: false, heading: null, columns };
}

const snap = (n: number) => Math.round(n * 1000) / 1000;

/** A box's figures to a thousandth of a point, and its right edge never past the page's right margin
 *  (template-canvas-seed.ts's `tidy`, copied as the invoice's seed copies it: this module imports
 *  nothing back from that one). */
function tidy(item: CanvasItem): CanvasItem {
  const x = snap(item.box.x);
  const w = Math.min(snap(item.box.w), RIGHT - x);
  return { ...item, box: { x, y: snap(item.box.y), w, h: snap(item.box.h) } } as CanvasItem;
}

/** The most a snapped block may start above the block before it's drawn bottom and still be read as
 *  meeting it: the thousandth `tidy` rounds to, twice, with room for the sum's binary error. */
const ROUNDING = 0.0025;

/** The blocks' stack after the snap (the invoice's `sealed`, copied): a block the flow lays out
 *  directly under another (the finance line's kept 2 pt inside its own block, so the aging's end and
 *  the finance block's start meet across the aging's 10 pt only by the drawn distance, and a block
 *  reordered under another with no margin between) can be drawn a rounding step above the upper one's
 *  bottom (rule 5). Each such block is moved down to the first thousandth at or below that bottom,
 *  only by a rounding step (`ROUNDING`), and every later block moves with it (`shift`), so the drawn
 *  distances stay the flow's and the moves do not add up (the certification's moved each on its own,
 *  #960). A real overlap is left for the rules. */
function sealed(items: CanvasItem[]): CanvasItem[] {
  const moved = new Map<string, number>();
  let bottom: number | null = null;
  let shift = 0;
  for (const t of tablesByY({ version: 1, items })) {
    let y = shift === 0 ? t.box.y : snap(t.box.y + shift);
    if (bottom !== null && y < bottom && bottom - y <= ROUNDING) {
      y = snap(bottom);
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

/** Whether the Bill To is the last field the identity's left column prints (the config's order, its
 *  shown fields): only then does the column's bottom stand at the Bill To's, and the block may be
 *  drawn down to the Remit To box's bottom. */
function billToLast(config: TemplateConfig): boolean {
  const identity = config.sections.find((s) => s.key === "identity");
  const left = (identity?.fields ?? []).filter((f) => LEFT_COLUMN.includes(f.key) && (f.visible ?? true));
  return left.length > 0 && left[left.length - 1].key === "bill_to";
}

/**
 * The items, from the positions of the one layout, in the order the flow draws them. Each piece's
 * anchor is the last block whose end the walk has passed, its `y` its top less that block's drawn
 * bottom (the page's top: 0), but the Remit To box, which takes the anchor and the base in force when
 * the walk passed `identityStart`. A hidden field or section prints nothing, so it has no position and
 * seeds nothing; a shown block whose builder answered nothing seeds at the row floor from its start
 * mark; a hidden Bill To field has no marks and seeds no block. The walk skips every id outside the
 * seed's namespace.
 */
export function seedStatementItems(config: TemplateConfig, positions: LaidOutNode[], logoPlaced: boolean): CanvasItem[] {
  const byId = new Map(positions.map((n) => [n.id, n] as const));
  const endOf = (key: string): number => {
    const node = byId.get(STATEMENT_SEED_IDS.end(key));
    if (node === undefined) throw new Error(`The seed's layout has no position for ${STATEMENT_SEED_IDS.end(key)}.`);
    return node.top;
  };

  const sideLogo = logoPlaced && config.logo !== null
    && (config.logo.placement === "header-left" || config.logo.placement === "header-right");
  const headerWidth = W.content - (sideLogo ? config.logo!.width + W.headerLogoGap : 0);
  const remitShown = byId.has(STATEMENT_SEED_IDS.piece("remit_to"));
  const identityWidth = W.content - W.identityIndent - (remitShown ? W.remitTo + W.identityGap : 0);
  // The Remit To box's bottom, which the Bill To block is drawn down to where the Bill To ends the
  // left column (its marks come after the left stack's, so it is looked up, not walked to).
  const remitEnd = remitShown ? endOf("remit_to") : null;
  const holdsToRemit = remitEnd !== null && billToLast(config);

  const items: CanvasItem[] = [];
  let anchor: CanvasAnchor = pageTop;
  let base = 0;
  /** The anchor and base in force where the identity opened, which the Remit To box takes. */
  let identityAt: { anchor: CanvasAnchor; base: number } | null = null;
  const open = new Map<Block, LaidOutNode>();
  /** How much lower than its laid-out top a block is drawn: the row-floor clamps of the blocks above it. */
  let lift = 0;

  for (const node of positions) {
    const id = node.id;
    // The render reports every id'd node; one the seed did not place is none of the seed's business.
    if (!id.startsWith("seed:")) continue;
    if (id === STATEMENT_SEED_IDS.identityStart) {
      identityAt = { anchor, base };
      continue;
    }
    if (id.startsWith("seed:start:")) {
      open.set(id.slice("seed:start:".length) as Block, node);
      continue;
    }
    if (id.startsWith("seed:end:")) {
      const key = id.slice("seed:end:".length);
      const start = open.get(key as Block);
      // A piece's end, or the left stack's (`leftColumnEnd`): neither closes a block.
      if (start === undefined || !(BLOCKS as readonly string[]).includes(key)) continue;
      const block = key as Block;
      const laidOut = node.top - start.top;
      if (tableSpec(STATEMENT_CONTRACT, block)?.holdsHeight === true) {
        // The Bill To prints at least its drawn height beside the Remit To box (`holdsHeight`): drawn
        // down to the box's bottom where it ends the left column, so its drawn bottom is the identity
        // row's (the lower of the two flow marks), and the open items under it start where the flow's
        // do. It prints that height, so it lifts nothing below it.
        const reach = holdsToRemit ? Math.max(node.top, remitEnd!) : node.top;
        const h = Math.max(ROW_FLOOR, reach - start.top);
        const x = LEFT + W.identityIndent;
        items.push(tableItem(config, block, { x, y: start.top + lift, w: identityWidth, h }, anchor));
        anchor = { kind: "below-table", table: block };
        base = start.top + h;
        continue;
      }
      // A block's drawn box is absolute: its y is its top. Its height is at least the profile's row
      // floor; the walk still passes it at its laid-out end, and the items below it ride its rendered
      // bottom on paper, so their offsets are the flow's. The sheet spaces the next block from this
      // one's DRAWN bottom, so every later block is drawn lower by the clamps above it (`lift`).
      const h = Math.max(ROW_FLOOR, laidOut);
      items.push(tableItem(config, block, { x: LEFT, y: start.top + lift, w: W.content, h }, anchor));
      lift += h - laidOut;
      anchor = { kind: "below-table", table: block };
      base = node.top;
      continue;
    }
    const key = id.slice("seed:".length);
    const h = endOf(key) - node.top;
    if (key === "remit_to") {
      const at = identityAt ?? { anchor, base };
      items.push(fieldItem(config, key, { x: node.left, y: node.top - at.base, w: W.remitTo, h }, at.anchor));
      continue;
    }
    const top = node.top - base;
    if (key === "logo") {
      if (!logoPlaced || config.logo === null) continue;
      items.push({ kind: "logo", id: crypto.randomUUID(), box: { x: node.left, y: top, w: config.logo.width, h }, anchor, repeat: false });
    } else if (HEADER.has(key)) {
      items.push(fieldItem(config, key, { x: node.left, y: top, w: headerWidth, h }, anchor));
    } else if (IDENTITY_LINES.has(key)) {
      items.push(fieldItem(config, key, { x: node.left, y: top, w: identityWidth, h }, anchor));
    } else {
      throw new Error(`The statement's seed has no item for ${key}.`);
    }
  }
  return sealed(items.map(tidy));
}

/**
 * The repeat (§4.4, call 2, ruled option (a)): the customer line repeats where it stands page-top at
 * least one grid step above the first block's top (rule 3's own comparison), with no shift ever;
 * otherwise nothing repeats (the customer hidden, or printed below a block, or no block placed).
 */
export function withRepeat(items: CanvasItem[]): CanvasItem[] {
  const customer = items.find((i) => i.kind === "field" && i.key === "customer" && i.anchor.kind === "page-top");
  const first = tablesByY({ version: 1, items })[0];
  if (customer === undefined || first === undefined) return items;
  if (customer.box.y + customer.box.h + CANVAS_GRID > first.box.y) return items;
  return items.map((item) => (item === customer ? { ...item, repeat: true } : item));
}

/** The header's pieces, which print in the header's row beside a side logo. */
const inHeader = (item: CanvasItem): boolean => item.kind === "logo" || (item.kind === "field" && HEADER.has(item.key));
/** The identity's pieces: its two lines and the Remit To box beside them. */
const inIdentity = (item: CanvasItem): boolean =>
  item.kind === "field" && (IDENTITY_LINES.has(item.key) || item.key === "remit_to");

/**
 * The part of the seeded layout that runs past the page's right margin, else null (the invoice's,
 * copied): a header piece, or an identity line or the Remit To box, left no width once `tidy` has
 * clamped its right edge to the margin. A side logo takes its own width and the gap from the header's
 * "*" column, and pdfmake widens a "*" column to its longest word (the title at a large heading
 * size), pushing the pieces past the margin; the identity's "*" column widens the same way to a long
 * unbroken label and pushes the Remit To box along (the identity lines' own width is the flow's
 * constant, so only the box can be left none). The stand-in's own text is fixed, so only the
 * template's settings cause either. A piece pushed only part of the way keeps a clamped width and
 * seeds (the invoice's open question 11).
 */
function pastTheRightMargin(layout: CanvasLayout): "header" | "identity" | null {
  if (layout.items.some((item) => inHeader(item) && item.box.w <= 0)) return "header";
  if (layout.items.some((item) => inIdentity(item) && item.box.w <= 0)) return "identity";
  return null;
}

/**
 * How many thousandths of a point a drawn bottom must stand above the band's top (the bill of lading's
 * `FIT_CLEARANCE`, bol-canvas-seed.ts, carried through the invoice's, whose reasoning carries: every
 * seeded figure is snapped to a thousandth, so a printed bottom stands up to half a thousandth per
 * block either side of the drawn one). The statement's suite pins it: a drawn bottom one thousandth
 * above the band's top, which the rules accept, is refused; exported for that suite alone.
 */
export const FIT_CLEARANCE = 2;

/**
 * Whether the seeded layout's drawn stack fits the canvas's one page (design §5.3; the invoice's,
 * over the statement's profile): every item's drawn box (`drawnBox`, an item below a block included,
 * which rule 4 does not judge), counted in whole thousandths. A block, a page-top item and an item
 * below a block end at least `FIT_CLEARANCE` thousandths above the band's top; a page-bottom item
 * ends at most on the page's foot (the statement seeds none: it prints no strip); and the first block
 * has the profile's room for its first lines above the band (rule 8's room, a backstop no stand-in
 * reaches). The flow runs its content down to its 40 pt bottom margin (752); the canvas stops at the
 * band's top, which with the page line on is 748 (`pageFoot`), the statement placing nothing in it.
 */
function fitsTheCanvas(layout: CanvasLayout, pageFooter: boolean): boolean {
  const band = bandTop(layout, pageFooter);
  const foot = pageFoot(pageFooter);
  const grains = (n: number) => Math.round(n * 1000);
  const drawnFits = layout.items.every((item) => {
    const box = drawnBox(item, layout);
    if (item.kind !== "table" && item.anchor.kind === "page-bottom") return grains(box.y + box.h) <= grains(foot);
    return grains(box.y + box.h) <= grains(band) - FIT_CLEARANCE;
  });
  const first = tablesByY(layout)[0];
  return drawnFits && (first === undefined || first.box.y + canvasProfile(STATEMENT_CONTRACT).firstTableRoom <= band);
}

/** Read-only, on one RepeatableRead snapshot, as the preview reads. */
function readOnly<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/** The blocks' width floors at the content width, before the stand-in is laid out (#991 review I2, the
 *  controller's ruling of 2026-11-17): a template whose columns leave the page no room for a block is
 *  refused in rule 9's or rule 4's own sentence (`widthFloorRefusal`), as before #991, never in the
 *  one-page sentence a stand-in squeezed by the column clamp would reach first. Each shown section's
 *  block is drawn as the seed draws it, at the content width; the Bill To, a field's block, is drawn at its field's place and judged with the layout. */
function widthFloorsFirst(config: TemplateConfig): void {
  const box = { x: LEFT, y: 0, w: RIGHT - LEFT, h: ROW_FLOOR };
  const items = BLOCKS.filter((block) => block !== "bill_to" && config.sections.find((s) => s.key === block)?.visible === true)
    .map((block) => tableItem(config, block, box, pageTop));
  const floor = widthFloorRefusal({ version: 1, items }, STATEMENT_CONTRACT, { fonts: config.fonts });
  if (floor !== null) throw new HttpError(400, floor.sentence);
}

/**
 * The layout that prints the submitted flow config's statement for any customer (§5.3). `config` is
 * validated by the caller with its own `layout` set aside; `logoDataUri` is the version's logo where
 * the config places it. The picked customer is read, live, only to refuse a deleted or unknown one in
 * the preview's 404; the company block is read through `invoicePrintSettings` outside that read, as
 * every statement print reads it; the statement date is today, as `buildStatementInTx` defaults its
 * `asOf`. It refuses, in a 400, only what the template's settings or the company address cause (the
 * module header's four, in its order), and writes nothing.
 */
export async function seedStatementLayout(
  recordId: string, config: TemplateConfig, logoDataUri: string | undefined,
): Promise<CanvasLayout> {
  // A config check, before any read: the record cannot change it.
  widthFloorsFirst(config);
  const customer = await readOnly((tx) => tx.customer.findFirst({ where: { id: recordId, deletedAt: null }, select: { id: true } }));
  if (customer === null) throw new HttpError(404, "Customer not found");
  const settings = await invoicePrintSettings();
  const asOf = formatDateOnly(todayDateOnly());
  const standIn = statementStandIn(settings, customer.id, asOf);
  const laid = await renderSheetGroupsWithPositions([buildStatementDefinition(standIn, config, logoDataUri, { seedIds: true })]);
  // A canvas stacks the blocks on one page. At the stand-in's lengths only the template's settings or
  // the company address (the Remit To box's lines) can put the statement on a second page, so the
  // sentence names them. It comes before the walk: a second page's positions are its own page's.
  const pages = laid.groups[0].pages;
  if (pages > 1) {
    throw new HttpError(400,
      `The canvas starts from a one-page statement; laid out at its least, this template's statement prints ${pages} pages. Change this template's settings (its font, sizes or logo) or the company address so it fits one page.`);
  }
  const items = seedStatementItems(config, laid.groups[0].positions, logoDataUri !== undefined);
  const layout: CanvasLayout = { version: 1, items: withRepeat(items) };
  // The width first: a piece left with no width can make the stack taller, and the height sentence
  // would then name the wrong settings.
  const past = pastTheRightMargin(layout);
  if (past === "header") {
    throw new HttpError(400,
      `The canvas starts from a statement whose header fits the page; laid out at its least, this template's header runs past the page's right margin. Change this template's settings (its logo's width, font or heading size) so the header fits the page's width.`);
  }
  // The identity sentence names the font and the labels alone: the identity row's every node sets its
  // own size (the customer and statement date lines 10 pt, the Bill To's label 9 and its lines 10, the
  // Remit To's label 13), so the template's sizes neither cause this refusal nor cure it (the
  // controller's correction of open question 5's default, 2026-11-12; the invoice's sentence keeps
  // its sizes, since its identity lines read the base size).
  if (past === "identity") {
    throw new HttpError(400,
      `The canvas starts from a statement whose identity lines and Remit To box fit the page; laid out at its least, this template's Remit To box runs past the page's right margin. Change this template's settings (its font or labels) so they fit the page's width.`);
  }
  // One page in the flow is not yet one page on the canvas (design §5.3: the drawn stack must fit the
  // page rule 4 judges). Where it does not, only the template's settings or the company address put
  // it there, so the sentence names them, the page line among them; the flow printed one page, so it
  // names no page count.
  if (!fitsTheCanvas(layout, config.pageFooter)) {
    throw new HttpError(400,
      `The canvas starts from a one-page statement; laid out at its least on the canvas, this template's statement runs past one page. Change this template's settings (its font, sizes, logo or page line) or the company address so it fits one page.`);
  }
  // A block the template's columns leave narrower than its least width (rule 4's or rule 9's floor,
  // #971 design §6) is the template's to change: the 400 in the rule's own sentence.
  const floor = floorRefusal(layout, STATEMENT_CONTRACT, { pageFooter: config.pageFooter, fonts: config.fonts });
  if (floor !== null) throw new HttpError(400, floor.sentence);
  // Every other rule the layout must pass is the seed's to meet: the settings that can break one (the
  // page count, the header's and the identity's widths, the drawn stack's fit) are refused above in
  // their own sentences, so a refusal here is the seed's fault, not mapped to a 400, and surfaces as
  // the fault it is.
  validateCanvasLayout(layout, STATEMENT_CONTRACT, { pageFooter: config.pageFooter, fonts: config.fonts });
  return layout;
}
