/**
 * The bill of lading's canvas SEED (design `docs/superpowers/specs/2026-11-09-bol-canvas-design.md`
 * §5.3, §4.4): a bill of lading draft's canvas starts from today's paper. The flow config the editor
 * holds is laid out ONCE for the picked shipment, read as the template preview reads it (the
 * shipment's `bolNumber`, else its `shipperNumber`: NOTHING is allocated), and every piece is read
 * back from where it landed, so the `CanvasLayout` answered prints the same lines in the same places.
 * Nothing is stored. `seedCanvasLayout` (template-canvas-seed.ts) dispatches a BOL template here; it
 * lives in its own module beside that one (the plan's call: that file keeps the dispatch).
 *
 * The flow marks its pieces only when asked (`buildBolDefinition`'s `seedIds`, `BOL_SEED_IDS` in
 * pdf/bol.ts), each end mark before the piece's bottom margin, so a seeded box is the piece alone: a
 * form rule's box is its line and not the 3 pt the flow puts under it. Positions report a left and a
 * top only, so every width comes from the flow's own constants (`BOL_WIDTHS`, `BOL_PER_ROW`) and
 * every style from the flow's own (`bolSeedStyle`).
 *
 * What the seed does (§5.3):
 *  - it refuses a shipment whose bill of lading, as the seed lays it out, prints more than one page
 *    (the controller's call: the seed's own render, the PO list one line tall), in its own sentence
 *    naming the shipment and the template's settings;
 *  - it then prints the seeded layout once for the picked shipment's own data, its own PO list
 *    (`printsAsTheFlow`, #947), and answers it when that canvas prints one page. When it pages and the
 *    shipment's own flow prints one, it refuses in a sentence of its own that says the flow fits; when
 *    the flow pages too (the 80-order shipment, §4.4 "When it pages"), no print of the real data can
 *    answer, so it judges the seeded stack, the PO list one line tall, by its drawn bottoms
 *    (`fitsTheCanvas`) and refuses in the canvas sentence when one runs past the foot;
 *  - it lays the PO list out one line tall (`seedPlaceholders`), and the TRV list too (owner ruling of
 *    2026-11-15 on #943, "One line, like PO", once the list could wrap), so every real print grows down
 *    from the seed, and the items below each block take their offsets from that one line's bottom. On
 *    paper the canvas stands the whole repeat shift lower than the flow from the first block down, in
 *    every face (the shift is about 1.5 pt on the Standard's order, 1.502 in Liberation Sans): the
 *    row-floor `lift` draws a block lower than the shift alone, but the sheet spaces each
 *    block from the one above by their DRAWN distance and prints it at its rendered height, so the
 *    printed stack is the drawn one less the lift (drawn = flow + shift + lift; printed = flow +
 *    shift). A longer list grows the canvas by its wrap, as it grows the flow; under a left slot
 *    taller than the right (a header-left logo) it takes the whole wrap where the flow takes it inside
 *    the header's height (§4.4, call 5). So the picked shipment prints its canvas on one page whenever
 *    the seed answers and its flow prints one, and that is all the seed guarantees: every block prints
 *    at the flow's place plus the shift, so the layout printed for ANOTHER shipment whose flow ends
 *    within the repeat shift of the foot can still print two canvas pages where that shipment's flow
 *    prints one, whatever made that flow taller (a PO list that wraps further is one cause), and under
 *    a taller left slot by the whole wrap as well;
 *  - it seeds the furniture as statics where the flow printed it: the five full rules and the
 *    declared-value "Per" rule as Lines, the delivery caption, its footnote and "Per" as Text items;
 *  - it draws every block at least the profile's row floor tall (the PO list's one line is under it in
 *    the Liberation faces), and every later block lower by the clamps above it, so on paper the clamps
 *    cancel (the sheet spaces a block from the one above it by their drawn distance and prints it at its
 *    rendered height) and each block prints where the flow put it, plus the repeat shift below;
 *  - it seeds each ruled item and the PO block at the flow's widths (the label column, the gap and
 *    the rule, so `vehicle_no`, `agent_per` and `po_address` are as wide as their rules);
 *  - it flags `bol_number` to repeat wherever it prints at the page's top (above the first block),
 *    and moves EVERY block down by the shortfall rule 3 needs (`bolRepeatShift`, computed from the
 *    seeded boxes, never a constant): the blocks' tops are absolute, and the sheet spaces a block from
 *    the one above it by their drawn distance, so moving the first block alone would pull the
 *    region below it up by the shift and leave the later blocks at the flow's place.
 *
 * A piece's anchor is read from the laid-out document order: the last block whose end the walk has
 * passed (none: the page's top). The header's left slot and the right slot's rules before the PO list
 * come before the PO block in that order, so they stand at the page's top, and the rules after it,
 * the header's rule and everything to the TRV block ride the PO block, as the flow's do.
 *
 * This module imports nothing from template-canvas-seed.ts, which imports it: its few helpers that
 * mirror that file's (`tidy`, the read-only snapshot) are its own.
 */
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { bolSettings, readBolData } from "./shippers";
import {
  BOL_HEADER_GAP, BOL_PER_ROW, BOL_RULE_WEIGHTS, BOL_FURNITURE_TEXT, BOL_SEED_IDS, BOL_WIDTHS, bolSeedStyle, buildBolDefinition, pairLabelKey,
  type BolData,
} from "./pdf/bol";
import { renderSheetGroupsWithPositions, type LaidOutNode } from "./pdf/render";
import { bandTop, canvasProfile, drawnBox, pageFoot, tableSpec, tablesByY } from "@/lib/template-canvas";
import { BOL_CONTRACT } from "@/lib/template-contracts/bol";
import {
  CANVAS_GRID, CANVAS_PAGE, type CanvasAnchor, type CanvasBox, type CanvasColumn, type CanvasItem, type CanvasLayout,
  type CanvasTextStyle,
} from "@/lib/template-contracts/canvas";
import { CONTENT_WIDTH, type TemplateConfig } from "@/lib/template-contracts/types";

const W = BOL_WIDTHS;
const LEFT = CANVAS_PAGE.margin;
const RIGHT = CANVAS_PAGE.width - CANVAS_PAGE.margin;
/** A table's least drawn height, the profile's (one row). */
const ROW_FLOOR = canvasProfile(BOL_CONTRACT).rowFloor;
/** A form rule's box: the flow's label column, its gap and its rule (244 pt of the 250 pt slot). */
const FORM_RULE_WIDTH = W.formLabel + W.formGap + W.formRule;

/** The ruled pairs the seed reads from their value column: the flow's label column, gap and rule. */
const RULED_PAIRS: Record<string, { label: number; gap: number; rule: number }> = {
  destination: { label: W.destinationLabel, gap: W.rowGap, rule: W.destinationRule },
  destination_state: { label: W.stateLabel, gap: W.rowGap, rule: W.stateRule },
  destination_zip: { label: W.zipLabel, gap: W.rowGap, rule: W.zipRule },
  delivering_carrier: { label: W.deliveringLabel, gap: W.rowGap, rule: W.deliveringRule },
  vehicle_initials: { label: W.initialsLabel, gap: W.rowGap, rule: W.initialsRule },
  vehicle_no: { label: W.vehicleNoLabel, gap: W.rowGap, rule: W.vehicleNoRule },
  shipper_per: { label: W.signLabel, gap: W.signGap, rule: W.shipperRule },
  agent_per: { label: W.signLabel, gap: W.signGap, rule: W.agentRule },
  po_address: { label: W.poAddressLabel, gap: W.rowGap, rule: W.poAddressRule },
};
/** The full-width rules the seed places as Line items, each with the flow's weight. */
const FULL_RULES: Record<string, number> = {
  header_rule: BOL_RULE_WEIGHTS.heavy,
  preamble_rule: BOL_RULE_WEIGHTS.light,
  trv_rule: BOL_RULE_WEIGHTS.light,
  liability_rule: BOL_RULE_WEIGHTS.light,
  fibre_rule: BOL_RULE_WEIGHTS.light,
};
/** The wordings the seed places as text blocks (the eight the freight block does not print). */
const WORDINGS = new Set([
  "bol_received_text", "bol_property_text", "bol_certifies_text", "bol_water_note", "bol_value_note",
  "bol_declared_value_text", "bol_liability_note", "bol_fibre_note",
]);
/** The furniture the seed places as Text items. */
const FURNITURE = new Set<keyof typeof BOL_FURNITURE_TEXT>(["delivery_caption", "delivery_footnote", "per"]);
/** The field items placed in their slot's or the content's width, from their piece's left. */
const SLOT_FIELDS = new Set(["original_label", "title", "pro_number", "bol_number", "scac_code"]);
/** The blocks, by the id that opens each: the PO list is a piece, the two sections carry a start mark. */
const BLOCKS = ["consignee_ref", "trv", "freight"] as const;
type Block = (typeof BLOCKS)[number];

const pageTop: CanvasAnchor = { kind: "page-top" };

/**
 * The shift the first block needs below the repeated BOL number for rule 3 (design §4.4, call 2): the
 * number's bottom plus one grid step, less the block's top, never below 0. More than one grid step is
 * refused by name; no order of the header's right slot reaches it (the flow puts 3 pt under a form
 * rule, so the shortfall directly above the PO list is `CANVAS_GRID − 3`).
 */
export function bolRepeatShift(numberBottom: number, blockTop: number): number {
  const shift = numberBottom + CANVAS_GRID - blockTop;
  if (shift <= 0) return 0;
  if (shift > CANVAS_GRID) {
    throw new HttpError(400,
      `The canvas cannot repeat the bill-of-lading number above the Consignee's ref/PO table: it needs the table ${Math.round(shift * 100) / 100} pt lower, more than one grid step.`);
  }
  return shift;
}

/** The config's field entry, for its typed label and its visibility. */
function fieldConfig(config: TemplateConfig, section: string, key: string) {
  return config.sections.find((s) => s.key === section)?.fields.find((f) => f.key === key);
}

/** The contract section holding a field. */
const SECTION_OF = new Map(BOL_CONTRACT.sections.flatMap((s) => s.fields.map((f) => [f.key, s.key] as const)));

function style(key: string, config: TemplateConfig): CanvasTextStyle {
  const s = bolSeedStyle(key, config.fonts);
  if (s === null) throw new Error(`The bill of lading's seed has no style for ${key}.`);
  return s;
}

/** A field item, its label the config's (null: the contract's default, as the flow reads it). */
function fieldItem(config: TemplateConfig, key: string, box: CanvasBox, anchor: CanvasAnchor): CanvasItem {
  return {
    kind: "field", id: crypto.randomUUID(), key, label: fieldConfig(config, SECTION_OF.get(key)!, key)?.label ?? null,
    box, anchor, repeat: false, style: style(key, config),
  };
}

/** A block's table item: the PO block keyed by its field (its heading the header section's typed
 *  label), the TRV list keyed by its section (its heading the `trv_no` label), the freight block with
 *  the config's columns in its order and then its toggles, each with its visible and label (a toggle
 *  and an untyped width carry no width). */
function tableItem(config: TemplateConfig, key: Block, box: CanvasBox, anchor: CanvasAnchor): CanvasItem {
  const spec = tableSpec(BOL_CONTRACT, key)!;
  const heading = spec.heading === null ? null : fieldConfig(config, SECTION_OF.get(spec.heading)!, spec.heading)?.label ?? null;
  let columns: CanvasColumn[] = [];
  if (key === "freight") {
    const sc = config.sections.find((s) => s.key === "freight")!;
    const contractFields = BOL_CONTRACT.sections.find((s) => s.key === "freight")!.fields;
    const isColumn = (k: string) => contractFields.find((f) => f.key === k)?.column?.table === "freight";
    const toggles = spec.toggles ?? [];
    const column = (k: string, width: number | null): CanvasColumn => {
      const f = sc.fields.find((field) => field.key === k);
      return { key: k, visible: f?.visible ?? true, label: f?.label ?? null, width };
    };
    columns = [
      ...sc.fields.filter((f) => isColumn(f.key)).map((f) => column(f.key, typeof f.width === "number" ? f.width : null)),
      ...toggles.map((k) => column(k, null)),
    ];
  }
  return { kind: "table", id: crypto.randomUUID(), key, box, anchor, repeat: false, heading, columns };
}

/** A box's figures to a thousandth of a point, and its right edge never past the page's right margin
 *  (template-canvas-seed.ts's `tidy`, kept here so this module imports nothing back from that one). */
function tidy(item: CanvasItem): CanvasItem {
  const snap = (n: number) => Math.round(n * 1000) / 1000;
  const x = snap(item.box.x);
  const w = Math.min(snap(item.box.w), RIGHT - x);
  return { ...item, box: { x, y: snap(item.box.y), w, h: snap(item.box.h) } } as CanvasItem;
}

/**
 * The items, from the positions of the one layout, in the order the flow draws them. Each piece's
 * anchor is the last block whose end the walk has passed, its `y` its top less that block's laid-out
 * bottom (the page's top: 0). A hidden field, section or column prints nothing, so it has no position
 * and seeds nothing.
 */
export function seedBolItems(config: TemplateConfig, positions: LaidOutNode[], logoPlaced: boolean): CanvasItem[] {
  const byId = new Map(positions.map((n) => [n.id, n] as const));
  const must = (id: string): LaidOutNode => {
    const node = byId.get(id);
    if (node === undefined) throw new Error(`The seed's layout has no position for ${id}.`);
    return node;
  };
  const endOf = (key: string) => must(BOL_SEED_IDS.end(key)).top;

  // The header's left slot: the content less the right slot, its gap, and a centre logo's column and gap.
  const centre = logoPlaced && config.logo !== null && config.logo.placement === "header-center" ? config.logo.width + BOL_HEADER_GAP : 0;
  const leftWidth = CONTENT_WIDTH - W.headerRight - BOL_HEADER_GAP - centre;

  const items: CanvasItem[] = [];
  let anchor: CanvasAnchor = pageTop;
  let base = 0;
  const open = new Map<Block, LaidOutNode>();
  /** How much lower than its laid-out top a block is drawn: the row-floor clamps of the blocks above it. */
  let lift = 0;
  const passed = (block: Block, end: LaidOutNode) => {
    anchor = { kind: "below-table", table: block };
    base = end.top;
  };

  for (const node of positions) {
    const id = node.id;
    // The render reports every id'd node; one the seed did not place is none of the seed's business
    // (the certification's seed's skip, cert-canvas-seed.ts).
    if (!id.startsWith("seed:")) continue;
    // A section block's start mark opens it; its end mark (the same form as a piece's end) closes it.
    if (id.startsWith("seed:start:")) {
      open.set(id.slice("seed:start:".length) as Block, node);
      continue;
    }
    if (id.startsWith("seed:end:")) {
      const key = id.slice("seed:end:".length);
      const start = key === "consignee_ref" ? must(BOL_SEED_IDS.piece(key)) : open.get(key as Block);
      if (start === undefined || !(BLOCKS as readonly string[]).includes(key)) continue;
      const block = key as Block;
      const x = block === "consignee_ref" ? start.left : LEFT;
      const w = block === "consignee_ref" ? FORM_RULE_WIDTH : CONTENT_WIDTH;
      // A block's drawn box is absolute (its anchor is derived from the stack): its y is its top. Its
      // height is at least the profile's row floor, which the rules hold a table to: the PO list's one
      // line is under it in a smaller face (Liberation Sans 8.94 pt, Serif 8.86). The walk still passes
      // the block at its laid-out end, and the items below it ride its rendered bottom on paper, so
      // their offsets are the flow's. The sheet spaces the next block from this one's DRAWN bottom, so
      // every later block is drawn lower by the clamps above it (`lift`), and prints where the flow put
      // it (`withRepeat` then moves every block down by the repeat shift alike).
      const laidOut = node.top - start.top;
      const h = Math.max(ROW_FLOOR, laidOut);
      items.push(tableItem(config, block, { x, y: start.top + lift, w, h }, anchor));
      lift += h - laidOut;
      passed(block, node);
      continue;
    }
    const key = id.slice("seed:".length);
    if (key === "consignee_ref") continue; // the PO block, closed at its end mark
    if (key.endsWith(":label")) continue; // a ruled pair's label column, read with its value (below)
    const top = node.top - base;
    const h = endOf(key) - node.top;
    if (key === "logo") {
      if (!logoPlaced || config.logo === null) continue;
      items.push({ kind: "logo", id: crypto.randomUUID(), box: { x: node.left, y: top, w: config.logo.width, h }, anchor, repeat: false });
    } else if (SLOT_FIELDS.has(key)) {
      // The left slot's two at its width; the right slot's form rules at the flow's 244.
      const left = key === "original_label" || key === "title";
      items.push(fieldItem(config, key, { x: node.left, y: top, w: left ? leftWidth : FORM_RULE_WIDTH, h }, anchor));
    } else if (key in FULL_RULES) {
      items.push({
        kind: "line", id: crypto.randomUUID(), box: { x: LEFT, y: top, w: CONTENT_WIDTH, h: 0 }, anchor, repeat: false,
        weight: FULL_RULES[key],
      });
    } else if (key === "per_rule") {
      // The rule is drawn at its column's end mark (it follows the blank line above it).
      items.push({
        kind: "line", id: crypto.randomUUID(), box: { x: node.left, y: endOf(key) - base, w: BOL_PER_ROW.rule, h: 0 }, anchor,
        repeat: false, weight: BOL_RULE_WEIGHTS.light,
      });
    } else if (key in RULED_PAIRS) {
      // Read from its value column: the pair starts the flow's label column and gap to its left, and
      // is as tall as the taller of its label and its value on its rule.
      const pair = RULED_PAIRS[key];
      const x = node.left - pair.label - pair.gap;
      const tall = Math.max(endOf(key), endOf(pairLabelKey(key))) - node.top;
      items.push(fieldItem(config, key, { x, y: top, w: pair.label + pair.gap + pair.rule, h: tall }, anchor));
    } else if (key === "carrier_name") {
      items.push(fieldItem(config, key, { x: node.left, y: top, w: W.carrierRule, h }, anchor));
    } else if (key === "ship_from" || key === "consigned_to") {
      items.push(fieldItem(config, key, { x: LEFT, y: top, w: CONTENT_WIDTH, h }, anchor));
    } else if (WORDINGS.has(key)) {
      items.push({
        kind: "textBlock", id: crypto.randomUUID(), key, box: { x: node.left, y: top, w: RIGHT - node.left, h }, anchor,
        repeat: false, style: style(key, config),
      });
    } else if (FURNITURE.has(key as keyof typeof BOL_FURNITURE_TEXT)) {
      const furniture = key as keyof typeof BOL_FURNITURE_TEXT;
      const w = furniture === "per" ? BOL_PER_ROW.word : furniture === "delivery_footnote" ? CONTENT_WIDTH : RIGHT - node.left;
      const x = furniture === "delivery_footnote" ? LEFT : node.left;
      items.push({
        kind: "text", id: crypto.randomUUID(), text: BOL_FURNITURE_TEXT[furniture], box: { x, y: top, w, h }, anchor,
        repeat: false, style: style(furniture, config),
      });
    } else {
      throw new Error(`The bill of lading's seed has no item for ${key}.`);
    }
  }
  return items.map(tidy);
}

/**
 * The repeat (design §4.4, call 2): the BOL number repeats wherever it stands at the page's top, and
 * every block moves down by the shift rule 3 needs below it (`bolRepeatShift`), so everything anchored
 * below a block rides it and nothing above the first block moves. A number anchored below a block
 * (printed after the PO list) cannot repeat (rule 3), so nothing is flagged.
 */
export function withRepeat(items: CanvasItem[]): CanvasItem[] {
  const number = items.find((i) => i.kind === "field" && i.key === "bol_number" && i.anchor.kind === "page-top");
  if (number === undefined) return items;
  const first = tablesByY({ version: 1, items })[0];
  const shift = first === undefined ? 0 : bolRepeatShift(number.box.y + number.box.h, first.box.y);
  // To a thousandth, upward, so the snapped figures never fall short of the rule by a rounding error.
  const step = Math.ceil(shift * 1000) / 1000;
  return items.map((item) => {
    if (item === number) return { ...item, repeat: true };
    if (item.kind === "table" && step > 0) return { ...item, box: { ...item.box, y: Math.round((item.box.y + step) * 1000) / 1000 } };
    return item;
  });
}

/**
 * The clearance, in thousandths of a point, a drawn bottom keeps above its foot where the seed judges
 * the drawn stack (#947's review): only when the seeded canvas and the shipment's own flow both print
 * past one page, so that no print of the shipment's own data can say whether the seeded stack, the
 * PO list one line tall, fits. On paper the sheet starts the first block at its drawn top and spaces
 * each later block, and the last region's spacer, by DRAWN distances, but prints each block at its
 * RENDERED height, so the last region ends at the lowest drawn bottom plus, for every block, its
 * rendered height less its drawn one. In the Liberation faces the row-floor clamp makes that negative
 * (the PO block is drawn taller than it prints, by the `lift`), so this check refuses a stack drawn
 * past the foot by less than the lift that would print on one page. In Roboto nothing is clamped and
 * each block's drawn height is its rendered one snapped to the nearest thousandth (`tidy`), so the
 * printed bottom stands up to half a thousandth per block (three blocks: 1.5) either side of the
 * drawn one. Measured across Roboto's foot, a drawn bottom exactly on it printed one page at some
 * widths and two at others, and one a thousandth above it printed one page at every width tried; the
 * clearance is two thousandths from that 1.5 bound, not from a two-page print measured at one, so it
 * covers the three snaps whichever way they fall. No test pins the value: no case of the flow-pages
 * branch stands within a few thousandths of the foot, and at 0 the seed's and the canvas's suites
 * (template-canvas-seed, bol-canvas) stay green.
 */
const FIT_CLEARANCE = 2;

/**
 * Whether the seeded layout's drawn stack fits the canvas's one page (#947), asked only where the
 * seeded canvas and the shipment's own flow both page (`seedBolLayout`): every item's drawn bottom
 * (`drawnBox`, an item below a block included, which rule 4 does not judge) at least `FIT_CLEARANCE`
 * thousandths above the foot that applies to it, the band's top for a block, a page-top item and an
 * item below a block, the page's foot for a page-bottom item. The seed's render fits one page in the
 * flow, but the seed then draws every block lower than the render laid it out, by the repeat shift
 * (`withRepeat`) and by the row-floor clamps above it (`lift`), and the items below a block ride it,
 * so the last region can end past the foot and move whole to page 2. Both sides are counted in whole
 * thousandths, the grid every seeded figure is snapped to, so the float sum of four snapped figures
 * cannot blur the grain the clearance guards. The BOL seeds no page-bottom item, so that arm is a
 * backstop no seed reaches today.
 */
function fitsTheCanvas(layout: CanvasLayout, pageFooter: boolean): boolean {
  const band = bandTop(layout, pageFooter);
  const foot = pageFoot(pageFooter);
  const grains = (n: number) => Math.round(n * 1000);
  return layout.items.every((item) => {
    const box = drawnBox(item, layout);
    const limit = item.kind !== "table" && item.anchor.kind === "page-bottom" ? foot : band;
    return grains(box.y + box.h) <= grains(limit) - FIT_CLEARANCE;
  });
}

/** Read-only, on one RepeatableRead snapshot, as the preview reads. */
function readOnly<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/**
 * The layout that prints the submitted flow config's bill of lading for the picked shipment (§5.3).
 * `config` is validated by the caller with its own `layout` set aside; `logoDataUri` is the version's
 * logo where the config places it.
 */
export async function seedBolLayout(
  recordId: string, config: TemplateConfig, logoDataUri: string | undefined,
): Promise<CanvasLayout> {
  const settings = await bolSettings();
  const data = await readOnly(async (tx) => {
    const shipper = await tx.shipper.findFirst({ where: { id: recordId }, select: { bolNumber: true, shipperNumber: true } });
    if (!shipper) throw new HttpError(404, "Shipment not found");
    // Never allocated here (the preview's rule, §5.5): the number printed, or the shipment's own.
    return readBolData(tx, recordId, shipper.bolNumber ?? shipper.shipperNumber, settings);
  });
  const def = buildBolDefinition(data, config, logoDataUri, { seedIds: true, seedPlaceholders: true });
  const laid = await renderSheetGroupsWithPositions([def]);
  // A canvas stacks the blocks on one page: a block that starts on a second page has no drawn place
  // the rules accept, so the seed starts only from a bill of lading that fits one page as it lays it
  // out (the PO list one line tall). A template's own font or sizes can put every shipment on two pages
  // (Roboto Mono does, for one order), so the sentence names those settings beside the shipment.
  const pages = laid.groups[0].pages;
  if (pages > 1) {
    throw new HttpError(400,
      `The canvas starts from a one-page bill of lading; this shipment's bill of lading prints ${pages} pages. Pick a shipment whose bill of lading fits one page, or change this template's settings (its font or sizes) so it does.`);
  }
  const layout: CanvasLayout = { version: 1, items: withRepeat(seedBolItems(config, laid.groups[0].positions, logoDataUri !== undefined)) };
  // One page in the seed's render is not yet one page on the canvas (#947): the repeat shift draws the
  // stack lower than the render laid it out, and the shipment's own PO list grows it. So the seeded
  // layout is printed for the shipment's own data. When that canvas prints one page the seed answers
  // it, and the drawn stack is not judged: the shipment's own PO list prints at least the one line the
  // seed laid out (a list of no POs prints that blank line itself), so the stack the seed laid out,
  // printed, is no taller than the canvas that fit. Its drawn bottoms can still stand past the foot,
  // by less than the row-floor lift, since the sheet prints each block at its rendered height.
  const printed = await printsAsTheFlow(data, config, layout, logoDataUri);
  if (printed === "one page") return layout;
  // The canvas pages where the shipment's flow prints one: the shift (and, under a taller left slot,
  // the wrap) is what pushes it over, so the sentence says the flow fits and names the settings that
  // move the stack, the logo and the page line among them; the render printed one page, so it names no
  // page count.
  if (printed === "pages where the flow fits") {
    throw new HttpError(400,
      `The canvas starts from a one-page bill of lading; laid out on the canvas, this shipment's bill of lading runs past one page, though it fits one page in its sections. Pick another shipment, or change this template's settings (its font, sizes, logo or page line) so it fits.`);
  }
  // The flow pages too (the 80-order shipment): the canvas pages as the flow does (§4.4 "When it
  // pages"), so the print of the shipment's own data says nothing about the seeded stack, and the seed
  // judges it as drawn, the PO list one line tall (`fitsTheCanvas`, with its clearance). The shipment's
  // own lines and the template's settings are what put it there, so the sentence names both.
  if (!fitsTheCanvas(layout, config.pageFooter)) {
    throw new HttpError(400,
      `The canvas starts from a one-page bill of lading; laid out on the canvas, this shipment's bill of lading runs past one page. Pick a shipment whose bill of lading fits one page, or change this template's settings (its font, sizes or page line) so it does.`);
  }
  return layout;
}

/**
 * How the seeded layout prints for the picked shipment's own data, its own PO list (#947's review): on
 * one page; past one page where the shipment's flow (no layout, no placeholder) prints one; or past
 * one page with the flow. The canvas grows by the list's wrap as the flow does and stands the whole
 * repeat shift lower than the flow from the first block down, in every face (about 1.5 pt on the
 * Standard, 1.502 in Liberation Sans; the row-floor `lift` moves only the drawn stack, never the
 * printed one), and under a left slot taller than the right (a header-left logo) it grows by the whole
 * wrap where the flow grows inside the header's height (§4.4, call 5). So one layout render, and a
 * flow render only when that pages. Each render builds its own definition from the data already read,
 * since pdfmake uses up a node it laid out.
 */
async function printsAsTheFlow(
  data: BolData, config: TemplateConfig, layout: CanvasLayout, logoDataUri: string | undefined,
): Promise<"one page" | "pages where the flow fits" | "pages with the flow"> {
  const pagesOf = async (c: TemplateConfig) =>
    (await renderSheetGroupsWithPositions([buildBolDefinition(data, c, logoDataUri)])).groups[0].pages;
  if (await pagesOf({ ...config, layout }) === 1) return "one page";
  return await pagesOf({ ...config, layout: null }) === 1 ? "pages where the flow fits" : "pages with the flow";
}
