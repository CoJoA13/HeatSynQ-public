import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LinesGridView, prefillLineRow,
  type GridRowHandle, type LineFields, type LineInfo, type LineRow, type ShippedInfo,
} from "@/app/shipping/ShipmentGrids";
import { ShipmentOrderPanel } from "@/app/shipping/[id]/ShipmentOrderPanel";
import { NewShipment } from "@/app/shipping/new/NewShipment";
import {
  createBulkRecoveryAdapter, emptyBulkDraft, transitionBulkDraft, type BulkBaseline, type BulkRecoveryCustomization,
} from "@/lib/bulk-grid-recovery";
import {
  shipmentBulkCustomization, shipmentContainersBaseline, shipmentLinesBaseline, shipmentSerialsBaseline,
} from "@/lib/shipment-bulk-recovery";
import {
  newShipmentBaselineFrom, newShipmentDraftFrom, newShipmentRecoveryAdapter, runNewShipmentAddOrder,
  type NewShipmentSource, type ShipmentOrderSource, type ShipmentSeed,
} from "@/lib/new-shipment-recovery";
import type { Gate } from "@/lib/permission-ui";
import { NO_REPORTS, savedShipmentTotalsInput, shipmentTotals } from "@/lib/shipment-totals";
import { shipmentFixture } from "./helpers/remaining-bulk-fixtures";
import { openDraftHarness } from "./helpers/draft-store";
import { headingRowsOf } from "./helpers/markup";
import { mentions } from "./helpers/jsx-source";
import { shipmentTotalsIn } from "./helpers/shipment-totals-markup";

// The offered weight in the shipment Lines grid (the quantity corrections design §4: "The same offer
// appears in the shipment Lines grid when ship-now quantity changes"). One view, `LinesGridView`,
// serves the saved shipment page and the new-shipment form. The first half of this file renders
// that view alone; the second half renders each real screen around it.
//
// vitest runs in "node" with no DOM renderer, so every render here is static: no effect runs and no
// handler fires. Two things a static render cannot show are reached another way. Accepting an offer
// is a handler, so the real `WeightOfferNote` is wrapped to keep the props it was handed. That a row
// is never remounted when its offer appears is a property of the element tree, so it is read from
// the view's syntax tree; only a browser proves the typing itself, and the flow
// `hub-line-corrections` types a ship-now quantity key by key for that reason.
// The offer's figures and its control are proven in net-weight.test.ts and weight-offer-note.test.tsx.
//
// The second half ends with the new-shipment form's totals tables (the weights design §12.2 and
// §12.3): which tables the form draws, what they read from its rows as typed, and where they sit.
// Their words and figures are the leaf's, which shipment-totals.test.ts holds. They are here
// because `newForm` below renders the whole form after its own Add order put each order's rows in.
//
// The block after those holds the grid's weight words (the weights design §11.3, S2 to S5): the
// heading row, the two read-only cells, and the saved page's strip of lines kept from earlier
// selections. Each is compared whole, so the old unit does not pass.
//
// The file's last block holds the share of the table each of the grid's seven columns is given
// (the owner's choice of 2026-10-10).

type NoteProps = Parameters<typeof import("@/components/WeightOfferNote").WeightOfferNote>[0];
const seen = vi.hoisted(() => ({ notes: [] as unknown[], views: [] as unknown[], index: 0 }));
// The real component renders. The wrapper only records its props.
vi.mock("@/components/WeightOfferNote", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/WeightOfferNote")>();
  return { ...real, WeightOfferNote: (props: NoteProps) => { seen.notes.push(props); return real.WeightOfferNote(props); } };
});
// For the two screens only: the SSR subscription seam, in hook-call order (the
// shipment-recovery-access precedent). `LinesGridView` itself never calls it.
vi.mock("@/lib/use-recoverable-draft", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/use-recoverable-draft")>(),
  useRecoverableDraft: () => seen.views[seen.index++],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }), usePathname: () => "/shipping/ship-1", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/use-permissions", () => ({
  usePermissions: () => ({ permissions: ["shipping.create", "shipping.view", "customers.view", "orders.view"], error: null }),
}));
afterEach(() => { seen.notes = []; seen.views = []; seen.index = 0; });
const notes = () => seen.notes as NoteProps[];

const OPEN: Gate = { allowed: true, disabled: false, title: undefined };
const VOIDED: Gate = { allowed: false, disabled: true, title: "Shipment is voided" };

/** ol-1: 10 pieces ordered at a received 130 lb. The part's each weight is 10 lb. A row of this line
 *  holds its quantity × each weight only where the test is about exactly that: `saved("0", "0")`,
 *  `saved("6", "60")` and `saved("6", "60.00")`. Every other row's weight is not that figure, so
 *  where one of them is offered nothing, equal weights are never the reason. */
const SHAFT: LineInfo = { partNumber: "P-10", partName: "Shaft", orderedQty: 10, orderedWeight: 130, eachWeight: 10 };
/** ol-2: 8 pieces ordered at 20 lb, each weight 2.5 lb. */
const PIN: LineInfo = { partNumber: "P-20", partName: "Pin", orderedQty: 8, orderedWeight: 20, eachWeight: 2.5 };
/** This shipment has saved 4 pieces / 55 lb of ol-1; nothing else has shipped. The ledger's "shipped
 *  to date" includes this shipment's own saved row, as the saved page's does. */
const SAVED_4 = { savedQty: { "ol-1": 4 }, shipped: { "ol-1": { qty: 4, weight: 55 } } };

/** A row this shipment has saved (ol-1 unless told otherwise). */
const saved = (qty: string, weight = "55", over: Partial<LineRow> = {}): LineRow =>
  ({ key: "sl-1", isNew: false, orderLineId: "ol-1", qty, weight, lineComplete: "false", ...over });
/** A row not saved yet, prefilled by the grid's own `prefillLineRow` from this ledger. */
const added = (shipped: ShippedInfo | undefined, over: Partial<LineRow> = {}): LineRow => ({
  key: "new-1", isNew: true,
  ...prefillLineRow({ id: "ol-1", qty: SHAFT.orderedQty, weight: SHAFT.orderedWeight }, shipped), ...over,
});

type Setup = {
  rows: LineRow[]; info?: Record<string, LineInfo>; shipped?: Record<string, ShippedInfo>; savedQty?: Record<string, number>;
  gate?: Gate; onPatch?: (row: GridRowHandle, field: keyof LineFields, value: string) => void;
};
function grid(setup: Setup): string {
  return renderToStaticMarkup(
    <LinesGridView rows={setup.rows} candidates={[]}
                   infoByLineId={new Map(Object.entries(setup.info ?? { "ol-1": SHAFT, "ol-2": PIN }))}
                   shippedByLineId={new Map(Object.entries(setup.shipped ?? {}))}
                   savedQtyByLineId={new Map(Object.entries(setup.savedQty ?? {}))}
                   gate={setup.gate ?? OPEN} onPatch={setup.onPatch ?? (() => {})}
                   onRemove={() => {}} onAddRows={() => {}} />,
  );
}
/** Every `<tr>…</tr>` of the lines table's body, in order. */
function bodyRows(html: string): string[] {
  const body = /<tbody>(.*?)<\/tbody>/.exec(html);
  expect(body).not.toBeNull();
  return body![1].match(/<tr\b.*?<\/tr>/g) ?? [];
}
/** The text of every element in this markup, in order. */
const texts = (html: string) => [...html.matchAll(/>([^<]+)</g)].map((m) => m[1]);
/** The grid shows exactly `count` rows and no offer anywhere. */
function nothingOffered(html: string, count: number): void {
  expect(bodyRows(html)).toHaveLength(count);
  expect(html).not.toContain(" lb = ");
  expect(html).not.toMatch(/>Use [^<]*</);
  expect(notes()).toHaveLength(0);
}
/** The `<button …>` opening tag of the control with this exact text. */
function control(html: string, text: string): string {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`<button\\b[^>]*>${escaped}</button>`).exec(html);
  expect(found, text).not.toBeNull();
  return found![0];
}

describe("LinesGridView: when a weight is offered", () => {
  it("offers nothing at rest for a saved row at its saved quantity", () => {
    // 4 × 10 lb = 40 lb is not the 55 lb in the box, and 6 pieces are left on the line. Only the
    // quantity this shipment saved, as the row's start, explains that nothing is offered.
    nothingOffered(grid({ rows: [saved("4")], ...SAVED_4 }), 1);
  });

  it("offers a saved row the figure when its quantity differs from the one the shipment saved", () => {
    // 6 is the line's remainder (10 ordered, 4 shipped), and it is still a change from the saved 4.
    const rows = bodyRows(grid({ rows: [saved("6")], ...SAVED_4 }));
    expect(rows).toHaveLength(2);
    expect(texts(rows[1])).toEqual(["6 × 10.0000 lb = 60.00 lb", "Use 60.00 lb"]);
  });

  it.each<[string, ShippedInfo | undefined, string, string]>([
    ["nothing has shipped", undefined, "10", "130"],
    ["another shipment took 4 pieces / 40 lb", { qty: 4, weight: 40 }, "6", "90"],
    // More pieces have shipped than were ordered, with weight still left: the remainder is 0, never -2.
    ["the line is over-shipped by quantity", { qty: 12, weight: 100 }, "0", "30"],
  ])("offers nothing at rest for a new row at its prefilled remainder: %s", (_name, shipped, qty, weight) => {
    const row = added(shipped);
    expect([row.qty, row.weight]).toEqual([qty, weight]);
    nothingOffered(grid({ rows: [row], shipped: shipped ? { "ol-1": shipped } : {} }), 1);
  });

  it("offers a new row the figure when its quantity differs from the prefilled remainder", () => {
    const shipped = { qty: 4, weight: 40 };
    const rows = bodyRows(grid({ rows: [added(shipped, { qty: "5" })], shipped: { "ol-1": shipped } }));
    expect(rows).toHaveLength(2);
    expect(texts(rows[1])).toEqual(["5 × 10.0000 lb = 50.00 lb", "Use 50.00 lb"]);
  });

  it("a line removed and added again on a saved shipment starts at its prefilled remainder, not at the saved quantity", () => {
    // The saved page still knows the shipment saved 4 of this line; the row added again is new.
    const row = added(SAVED_4.shipped["ol-1"]);
    expect([row.qty, row.weight]).toEqual(["6", "75"]);
    nothingOffered(grid({ rows: [row], ...SAVED_4 }), 1);
    // Typed down to 4, the quantity the shipment saved, it is a change from the 6 it started at.
    const rows = bodyRows(grid({ rows: [{ ...row, qty: "4" }], ...SAVED_4 }));
    expect(rows).toHaveLength(2);
    expect(texts(rows[1])).toEqual(["4 × 10.0000 lb = 40.00 lb", "Use 40.00 lb"]);
  });

  it("offers nothing without an each weight", () => {
    // A shipping editor without orders.view: the saved page hands the grid no each weight.
    nothingOffered(grid({ rows: [saved("6")], ...SAVED_4, info: { "ol-1": { ...SHAFT, eachWeight: null } } }), 1);
    // A line the grid cannot describe at all.
    const unknown = grid({ rows: [saved("6")], ...SAVED_4, info: {} });
    nothingOffered(unknown, 1);
    expect(unknown).toContain('<div class="font-mono">ol-1</div>');
  });

  it("offers nothing for a negative quantity", () => {
    // A reversal's rows are negative. Its page is read-only, and no control may appear on it.
    const reversal = { savedQty: { "ol-1": -10 }, shipped: { "ol-1": { qty: 0, weight: 0 } } };
    // At rest. -95 lb is not -10 × 10 lb, so equal weights do not explain the missing offer. Two
    // rules each do: the row is at the quantity the reversal saved, and that quantity is negative.
    // This line goes red only with both of them gone.
    nothingOffered(grid({ rows: [saved("-10", "-95")], ...reversal }), 1);
    // Changed from the quantity the reversal saved (and -9 × 10 lb is not -100 lb), so the negative
    // quantity is the one rule left to refuse it. This line goes red when that rule alone goes.
    nothingOffered(grid({ rows: [saved("-9", "-100")], ...reversal }), 1);
  });

  it("quantity 0 offers 0.00 against a non-zero weight, and nothing against 0", () => {
    const rows = bodyRows(grid({ rows: [saved("0")], ...SAVED_4 }));
    expect(rows).toHaveLength(2);
    expect(texts(rows[1])).toEqual(["0 × 10.0000 lb = 0.00 lb", "Use 0.00 lb"]);
    seen.notes = [];
    nothingOffered(grid({ rows: [saved("0", "0")], ...SAVED_4 }), 1);
  });

  it("offers nothing once the weight box holds the figure", () => {
    nothingOffered(grid({ rows: [saved("6", "60")], ...SAVED_4 }), 1);
    nothingOffered(grid({ rows: [saved("6", "60.00")], ...SAVED_4 }), 1);
  });

  it("each changed row is offered its own line's figure, directly under it", () => {
    const pin = saved("3", "9", { key: "sl-2", orderLineId: "ol-2" });
    const ledger = { savedQty: { "ol-1": 4, "ol-2": 2 }, shipped: { "ol-1": { qty: 4, weight: 55 }, "ol-2": { qty: 2, weight: 9 } } };
    const both = bodyRows(grid({ rows: [saved("6"), pin], ...ledger }));
    expect(both).toHaveLength(4);
    expect(both[0]).toContain('aria-label="Line 1 ship-now quantity"');
    expect(texts(both[1])).toEqual(["6 × 10.0000 lb = 60.00 lb", "Use 60.00 lb"]);
    expect(both[2]).toContain('aria-label="Line 2 ship-now quantity"');
    expect(texts(both[3])).toEqual(["3 × 2.5000 lb = 7.50 lb", "Use 7.50 lb"]);
    // Only the second row changed: its offer is under it, and the first row has none.
    const second = bodyRows(grid({ rows: [saved("4"), pin], ...ledger }));
    expect(second).toHaveLength(3);
    expect(second[1]).toContain('aria-label="Line 2 ship-now quantity"');
    expect(texts(second[2])).toEqual(["3 × 2.5000 lb = 7.50 lb", "Use 7.50 lb"]);
  });
});

describe("LinesGridView: the offer's row and control", () => {
  it("the offer is one cell across all seven columns, with no box in it", () => {
    const rows = bodyRows(grid({ rows: [saved("6")], ...SAVED_4 }));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatch(/^<tr><td colSpan="7" class="[^"]*">/);
    expect(rows[1].match(/<td\b/g)).toHaveLength(1);
    expect(rows[1]).not.toContain("<input");
  });

  it("the row's boxes keep their labels, numbered by row, with an offer between two rows", () => {
    const rows = bodyRows(grid({
      rows: [saved("6"), saved("2", "9", { key: "sl-2", orderLineId: "ol-2" })],
      savedQty: { "ol-1": 4, "ol-2": 2 }, shipped: { "ol-1": { qty: 4, weight: 55 }, "ol-2": { qty: 2, weight: 9 } },
    }));
    expect(rows).toHaveLength(3);
    const labels = (row: string) => [...row.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
    expect(labels(rows[0])).toEqual(["Line 1 ship-now quantity", "Line 1 ship-now weight", "Line 1 close short"]);
    expect(labels(rows[1])).toEqual([]);
    expect(labels(rows[2])).toEqual(["Line 2 ship-now quantity", "Line 2 ship-now weight", "Line 2 close short"]);
    // The boxes still show the typed text, offer or no offer.
    expect(rows[0]).toContain('value="6"');
    expect(rows[0]).toContain('value="55"');
  });

  it("Completes line stays in the row's own Close short cell when the row also has an offer", () => {
    // 10 typed over the saved 4 reaches the 10 ordered, and 10 × 10 lb = 100 lb is not the 55 lb typed.
    const html = grid({ rows: [saved("10")], ...SAVED_4 });
    const rows = bodyRows(html);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('<td class="text-center"><span class="text-xs text-ink-500">Completes line</span></td>');
    expect(rows[0]).not.toContain("close short");
    expect(texts(rows[1])).toEqual(["10 × 10.0000 lb = 100.00 lb", "Use 100.00 lb"]);
    expect(html.match(/Completes line/g)).toHaveLength(1);
    // A row that stays short keeps its Close short box, with an offer under it.
    const short = bodyRows(grid({ rows: [saved("6", "55", { lineComplete: "true" })], ...SAVED_4 }));
    expect(short).toHaveLength(2);
    expect(short[0]).toMatch(/<td class="text-center"><input type="checkbox"[^>]*aria-label="Line 1 close short"/);
    expect(short[0]).toContain('checked=""');
    expect(short.join("")).not.toContain("Completes line");
  });

  it("the control is enabled, with no title, while the gate is open", () => {
    const button = control(grid({ rows: [saved("6")], ...SAVED_4 }), "Use 60.00 lb");
    expect(button).toContain('type="button"');
    expect(button).not.toContain(' disabled=""');
    expect(button).not.toContain("title=");
  });

  it("the control is disabled, with the gate's title, when the gate is closed", () => {
    // A voided shipment's page must show no enabled control (the void and reverse flows sweep for one).
    const html = grid({ rows: [saved("6")], ...SAVED_4, gate: VOIDED });
    const button = control(html, "Use 60.00 lb");
    expect(button).toContain(' disabled=""');
    expect(button).toContain('title="Shipment is voided"');
    expect(notes()).toHaveLength(1);
    expect(notes()[0].disabled).toBe(true);
    expect(notes()[0].title).toBe("Shipment is voided");
  });

  it("accepting writes the figure into that row's weight box through onPatch, as plain text", () => {
    const onPatch = vi.fn();
    const rows = [saved("6"), saved("3", "9", { key: "sl-2", orderLineId: "ol-2" })];
    grid({ rows, onPatch, savedQty: { "ol-1": 4, "ol-2": 2 }, shipped: { "ol-1": { qty: 4, weight: 55 }, "ol-2": { qty: 2, weight: 9 } } });
    expect(notes().map((note) => note.offer.pounds)).toEqual([60, 7.5]);
    // Rendering sends nothing.
    expect(onPatch).not.toHaveBeenCalled();
    notes()[1].onUse();
    // "7.5", not "7.50": the saved page compares a box with its saved value as text, and a saved
    // weight is `String(number)`.
    expect(onPatch.mock.calls).toEqual([[expect.objectContaining({ key: "sl-2", isNew: false }), "weight", "7.5"]]);
    notes()[0].onUse();
    expect(onPatch.mock.calls[1]).toEqual([expect.objectContaining({ key: "sl-1", isNew: false }), "weight", "60"]);
    // A row not saved yet is named as one: the saved page routes the write by `isNew`.
    seen.notes = [];
    const onNewRow = vi.fn();
    const shipped = { qty: 4, weight: 40 };
    grid({ rows: [added(shipped, { qty: "5" })], shipped: { "ol-1": shipped }, onPatch: onNewRow });
    notes()[0].onUse();
    expect(onNewRow.mock.calls).toEqual([[expect.objectContaining({ key: "new-1", isNew: true }), "weight", "50"]]);
  });
});

// ---- the view's shape, read from its syntax tree ----

const file = fileURLToPath(new URL("../src/app/shipping/ShipmentGrids.tsx", import.meta.url));
const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function all<T extends ts.Node>(root: ts.Node, is: (node: ts.Node) => node is T): T[] {
  const out: T[] = [];
  const walk = (node: ts.Node): void => { if (is(node)) out.push(node); ts.forEachChild(node, walk); };
  walk(root);
  return out;
}
function linesGridView(): ts.FunctionDeclaration {
  const found = all(source, ts.isFunctionDeclaration).filter((f) => f.name?.text === "LinesGridView");
  expect(found).toHaveLength(1);
  return found[0];
}
const unwrapped = (node: ts.Expression | undefined) => {
  let inner = node;
  while (inner && ts.isParenthesizedExpression(inner)) inner = inner.expression;
  return inner;
};

describe("LinesGridView: the row is never remounted", () => {
  it("each row is an unconditional Fragment keyed by the row's key: its own row, then the offer's row when there is one", () => {
    const maps = all(linesGridView(), ts.isCallExpression).filter((c) => c.expression.getText(source) === "rows.map");
    expect(maps).toHaveLength(1);
    const each = maps[0].arguments[0];
    if (!ts.isArrowFunction(each) || !ts.isBlock(each.body)) throw new Error("rows.map must take a block-bodied arrow");
    // One return in the whole callback, and it is the Fragment itself: never an early return, never a
    // choice between two elements. Switching the element type at a stable key remounts the row, and
    // the offer appears and goes on the very keystrokes typed into that row.
    const returns = all(each.body, ts.isReturnStatement);
    expect(returns).toHaveLength(1);
    const returned = unwrapped(returns[0].expression);
    if (!returned || !ts.isJsxElement(returned)) throw new Error("rows.map must return one JSX element");
    expect(returned.openingElement.getText(source)).toBe("<Fragment key={row.key}>");
    const children = returned.children.filter((c) => !ts.isJsxText(c));
    expect(children).toHaveLength(2);
    // First the row's own <tr>, always. The key is the Fragment's, so the <tr> carries none.
    const own = children[0];
    if (!ts.isJsxElement(own)) throw new Error("the row's own <tr> must be an element, not an expression");
    expect(own.openingElement.tagName.getText(source)).toBe("tr");
    expect(own.openingElement.attributes.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText(source) === "key")).toBe(false);
    // Then the offer's <tr>, the only conditional thing.
    const second = children[1];
    const shown = ts.isJsxExpression(second) ? second.expression : undefined;
    if (!shown || !ts.isBinaryExpression(shown)) throw new Error("the offer's row must be `offer !== null && …`");
    expect(shown.left.getText(source)).toBe("offer !== null");
    expect(shown.operatorToken.kind).toBe(ts.SyntaxKind.AmpersandAmpersandToken);
    const offerRow = unwrapped(shown.right);
    expect(offerRow && ts.isJsxElement(offerRow) && offerRow.openingElement.tagName.getText(source)).toBe("tr");
  });

  it("the offer is derived at render: the view keeps its one piece of state, the add picker", () => {
    const hooks = all(linesGridView(), ts.isCallExpression)
      .filter((c) => ts.isIdentifier(c.expression) && /^use[A-Z]/.test(c.expression.text));
    expect(hooks.map((c) => c.getText(source))).toEqual(['useState("")']);
  });
});

// ---- the two screens ----

type Fields = Record<string, string>;
const adapterFor = (kind: "lines" | "containers" | "serials") => createBulkRecoveryAdapter<Fields>(
  `shipment-${kind}`, `shipment-${kind}-v1`, shipmentBulkCustomization(kind) as BulkRecoveryCustomization<Fields>);
/** The saved shipment page's order panel over `shipmentFixture()`, whose two parts weigh 2 lb each.
 *  Its first row is ol-1: 10 ordered, this shipment saved 2 pieces at `savedWeight` lb. `edit` is
 *  typed into that row and not saved. A shipment line named in `released` is given no order line,
 *  as one whose order-side row was corrected away: the panel lists it in its strip of kept lines. */
function savedPage(savedWeight: number, edit?: Partial<LineFields>, released: readonly string[] = []): string {
  const fixture = shipmentFixture();
  fixture.shipper.orders[0].lines[0].weight = savedWeight;
  for (const line of fixture.shipper.orders[0].lines) if (released.includes(line.id)) line.orderLineId = null;
  const base: BulkBaseline<Fields> = shipmentLinesBaseline(fixture, "so-1");
  const lines = openDraftHarness(adapterFor("lines"), emptyBulkDraft<Fields>(), base);
  if (edit) lines.binding.change((draft) => transitionBulkDraft(draft, base, { kind: "edit", id: "sl-1", patch: edit }));
  const clean = (kind: "containers" | "serials") => openDraftHarness(adapterFor(kind), emptyBulkDraft<Fields>(),
    (kind === "containers" ? shipmentContainersBaseline : shipmentSerialsBaseline)(fixture, "so-1")).binding.getSnapshot();
  seen.views = [lines.binding.getSnapshot(), clean("containers"), clean("serials")];
  return renderToStaticMarkup(
    <ShipmentOrderPanel shipperId="ship-1" order={fixture.shipper.orders[0]}
                        recoverySource={{ read: async () => ({ record: fixture.shipper, access: fixture.permissions }), register: vi.fn(), begin: vi.fn() }}
                        editGate={OPEN} linesGate={OPEN} creditHoldReason="" applyMutation={async (run) => { await run(); }}
                        onRemove={() => {}} printGate={OPEN} printing={false} certsGate={OPEN} onPrintTicket={() => {}} totals={shipmentTotals(savedShipmentTotalsInput(fixture.shipper.orders, NO_REPORTS)).orders[0]} onTotalsReport={() => {}} />,
  );
}

const seed: ShipmentSeed = { clientRequestId: "3f6a1b2c-1111-4d22-8e33-9f0a1b2c3d4e", defaultShipDate: "2026-09-12", defaultFreightTerms: "PREPAID" };
type OrderContainers = ShipmentOrderSource["containers"];
/** For the cases on the form's totals: order 43 of the same customer. One line of 5 pieces at a
 *  received 450 lb, nothing shipped, and no container row. */
const SECOND: ShipmentOrderSource = { id: "order-2", customerId: "customer", orderNumber: 43, poNumber: "", customerJobNo: "", status: "OPEN", voided: false,
  lines: [{ id: "line-2", position: 1, qty: 5, weight: 450, part: { partNumber: "P-2", name: "Pin" } }],
  containers: [], serials: [], orderLineShippedToDate: [] };
/** One customer and one order: 10 pieces ordered at a received 20 lb, each weight 1.5 lb, and another
 *  shipment has taken 4 pieces / 8 lb. `containers` are that order's container rows, none unless
 *  given. `second` puts order 43 after it. */
function orderSource(withOrder: boolean, containers: OrderContainers = [], second = false): NewShipmentSource {
  return { permissions: ["shipping.create", "shipping.view", "customers.view", "orders.view"],
    customer: { id: "customer", code: "C", name: "Customer", creditHold: false }, addresses: [], carriers: [],
    orders: withOrder ? [{ id: "order", customerId: "customer", orderNumber: 42, poNumber: "PO", customerJobNo: "JOB", status: "OPEN", voided: false,
      lines: [{ id: "line-1", position: 1, qty: 10, weight: 20, part: { partNumber: "P-1", name: "Shaft", eachWeight: 1.5 } }],
      containers, serials: [], orderLineShippedToDate: [{ orderLineId: "line-1", shippedToDateQty: 4, shippedToDateWeight: 8 }] },
      ...(second ? [SECOND] : [])] : [] };
}
/** What a totals case asks of `newForm` beyond a typed line. `orders` is how many orders Add order
 *  puts on the form: order 42 alone unless given, order 43 after it for 2, none for 0. `containers`
 *  are order 42's container rows on the order. `tareEach` is typed into each Tare each box of order
 *  42 once its rows are on the form. */
type FormSetup = { orders?: 0 | 1 | 2; containers?: OrderContainers; tareEach?: string };
/** The new-shipment form after its own Add order command put each order's rows in, so every row is
 *  the form's real prefill. `edit` is then typed into order 42's line. */
async function newForm(edit?: Partial<LineFields>, { orders = 1, containers = [], tareEach }: FormSetup = {}): Promise<string> {
  const clean = { ...newShipmentDraftFrom(seed), customerId: "customer" };
  const { binding } = openDraftHarness(newShipmentRecoveryAdapter, clean, newShipmentBaselineFrom(orderSource(false)));
  const add = (orderId: string, second: boolean) => runNewShipmentAddOrder({ binding, orderId, authorized: () => true, newKey: () => "row-1",
    read: async () => ({ kind: "authorized", baseline: newShipmentBaselineFrom(orderSource(true, containers, second)), editable: true }) });
  if (orders >= 1) {
    expect(await add("order", false)).toBe("added");
    expect(binding.getSnapshot().current?.data.selected[0].lines).toEqual([
      { key: "row-1", isNew: true, orderLineId: "line-1", qty: "6", weight: "12", lineComplete: "false" },
    ]);
  }
  if (orders === 2) expect(await add("order-2", true)).toBe("added");
  if (edit || tareEach !== undefined) binding.change((draft) => ({ ...draft, selected: draft.selected.map((o) => o.orderId !== "order" ? o : { ...o,
    lines: o.lines.map((l) => ({ ...l, ...edit })),
    containers: tareEach === undefined ? o.containers : o.containers.map((c) => ({ ...c, tareEach })) }) }));
  seen.views = [binding.getSnapshot()];
  return renderToStaticMarkup(<NewShipment />);
}
function screenShowsNoOffer(html: string): void {
  expect(html).toContain('aria-label="Line 1 ship-now quantity"');
  expect(html).not.toContain(" lb = ");
  expect(html).not.toMatch(/>Use [^<]*</);
}

describe("the offered weight on the two screens", () => {
  it("saved shipment page: nothing is offered at rest, over a saved weight that is not quantity × each weight", () => {
    // 2 pieces saved at a received 5 lb; 2 × 2 lb = 4 lb.
    screenShowsNoOffer(savedPage(5));
  });

  it("saved shipment page: a ship-now quantity typed over the saved one is offered the part's figure", () => {
    const html = savedPage(4, { qty: "3" });
    expect(html).toContain(">3 × 2.0000 lb = 6.00 lb</span>");
    const button = control(html, "Use 6.00 lb");
    expect(button).not.toContain(' disabled=""');
    // The other saved row, untouched, is offered nothing.
    expect(html.match(/ lb = /g)).toHaveLength(1);
  });

  it("new-shipment form: nothing is offered at rest for the row Add order prefilled", async () => {
    // 6 pieces / 12 lb left; 6 × 1.5 lb = 9 lb.
    screenShowsNoOffer(await newForm());
  });

  it("new-shipment form: a ship-now quantity typed over the prefilled one is offered the part's figure", async () => {
    const html = await newForm({ qty: "5" });
    expect(html).toContain(">5 × 1.5000 lb = 7.50 lb</span>");
    expect(control(html, "Use 7.50 lb")).not.toContain(' disabled=""');
  });
});

// ---- the new-shipment form's totals (the weights design §12.2; §12.3, T1, T3 to T5, T7, T9, T12 and T16) ----

const FORM = "src/app/shipping/new/NewShipment.tsx";
/** Order 42's container row as the order holds it: 3 Steel Baskets at 42.5 lb each. */
const BASKETS: OrderContainers = [{ id: "container-1", count: 3, customerContainerId: "BIN-0007", tareEach: 42.5, type: { name: "Steel Basket" } }];
/** A totals table as `shipmentTotalsIn` reads one that has no tag: its caption is also its name. */
const totalsTable = (caption: string, cells: string[], note: string | null = null) =>
  ({ name: caption, caption, tag: null, columns: ["Net (lb)", "Tare (lb)", "Gross (lb)"], cells, note });
/** What the form draws, in the order drawn, as far as the two placement cases read it: "[" and "]"
 *  where a `<section>` opens and closes, an order's link by its text, a grid's title by its text,
 *  "rule" for a `div` with nothing in it, "totals" for the root of a totals table, and the Save
 *  shipment button by its text. `shipmentTotalsIn` reads what a table says and not where it is, so
 *  this finds the root by its mark. */
function landmarks(html: string): string[] {
  const found = html.matchAll(/<(\/?)section\b[^>]*>|<a\b[^>]*>(#\d+)<\/a>|<h4\b[^>]*>([^<]*)<\/h4>|(<div\b[^>]*><\/div>)|(<div\b[^>]*\sdata-shipment-totals(?=[\s=>])[^>]*>)|<button\b[^>]*>(Save shipment)<\/button>/g);
  return [...found].map((m) => m[2] ?? m[3] ?? m[6] ?? (m[4] ? "rule" : m[5] ? "totals" : m[1] === "/" ? "]" : "["));
}

// Every table is compared whole, `tag: null` included: nothing on this form is saved yet, so no
// table carries the Unsaved totals tag.
describe("the new-shipment form's totals", () => {
  it.each<[string, Partial<LineFields> | undefined, string | undefined, string[]]>([
    // 6 pieces / 12 lb are left of the line, and the order's row is 3 baskets at 42.5 lb each.
    ["the rows Add order put in", undefined, undefined, ["12.00", "127.50", "139.50"]],
    // 3 baskets at a typed 310 lb each, under a typed 1,600 lb.
    ["a ship-now net weight and a tare each typed over them", { weight: "1600" }, "310", ["1,600.00", "930.00", "2,530.00"]],
  ])("one order: its own table and Shipment totals read the same, from %s", async (_name, edit, tareEach, cells) => {
    expect(shipmentTotalsIn(await newForm(edit, { containers: BASKETS, tareEach }))).toEqual([
      totalsTable("Totals for #42", cells), totalsTable("Shipment totals", cells),
    ]);
  });

  it("two orders, one with a container row and one with none: each has its own table, and the shipment has no Gross", async () => {
    expect(shipmentTotalsIn(await newForm({ weight: "1600" }, { orders: 2, containers: BASKETS }))).toEqual([
      totalsTable("Totals for #42", ["1,600.00", "127.50", "1,727.50"]),
      totalsTable("Totals for #43", ["450.00", "Not entered", "Not available"]),
      totalsTable("Shipment totals", ["2,050.00", "127.50", "Not available"], "1 order has no containers"),
    ]);
  });

  it("each order's table sits under its Containers grid and above the rule before Shipment serials, and Shipment totals in a section of its own after the last panel", async () => {
    // Save shipment is the header's (PR 4), ahead of everything. The tabs draw every panel in tab
    // order: Customer and Header (Customer & route), then Orders, the order panels and the
    // shipment's table (Orders & containers), then Freight (Freight & review). An order's panel is
    // the section that holds the order's link, which is how a browser flow finds one
    // (e2e/lib/orders.mjs), so the shipment's table is in no panel.
    expect(landmarks(await newForm(undefined, { orders: 2, containers: BASKETS }))).toEqual([
      "Save shipment",
      "[", "]", "[", "]", "[", "]",
      "[", "#42", "Lines", "rule", "Containers", "totals", "rule", "Shipment serials", "]",
      "[", "#43", "Lines", "rule", "Containers", "totals", "rule", "Shipment serials", "]",
      "[", "totals", "]",
      "[", "]",
    ]);
  });

  it("draws no table, and no section for one, before an order is added", async () => {
    // A customer is picked and no order is on the form: the button, then Customer, Header, Orders
    // and Freight.
    expect(landmarks(await newForm(undefined, { orders: 0 }))).toEqual(["Save shipment", "[", "]", "[", "]", "[", "]", "[", "]"]);
  });

  it("writes shipmentTotals twice in its source: the import and one call site", () => {
    // Read from the source, because a render cannot tell one call from two that answer alike. The
    // name is written twice: where it is imported and where it is called.
    expect(mentions(FORM, "shipmentTotals")).toBe(2);
  });
});

// ---- the grid's weight words (the weights design §11.3, S2 to S5) ----

describe("the Lines grid's weight words", () => {
  it("heads its seven columns, the weight box column with its term and its unit", () => {
    expect(headingRowsOf(grid({ rows: [saved("4")], ...SAVED_4 }))).toEqual([
      ["Part", "Ordered", "Shipped to date", "Ship now qty", "Ship now net weight (lb)", "Close line short", ""],
    ]);
  });

  it("the Ordered and Shipped to date cells each read a quantity, a slash and a net weight in lb", () => {
    // Two rows and eight figures, no two alike, so a cell left with the old unit, or one cell's
    // figures drawn in the other, is seen. Each row is at the quantity this shipment saved, so
    // neither is offered a weight and every `<tr>` of the body is a row of the grid.
    const rows = bodyRows(grid({
      rows: [saved("4"), saved("2", "9", { key: "sl-2", orderLineId: "ol-2" })],
      savedQty: { "ol-1": 4, "ol-2": 2 }, shipped: { "ol-1": { qty: 4, weight: 55 }, "ol-2": { qty: 2, weight: 9 } },
    }));
    expect(rows.map((row) => texts(row))).toEqual([
      ["P-10", "Shaft", "10 / 130.00 lb", "4 / 55.00 lb", "Remove"],
      ["P-20", "Pin", "8 / 20.00 lb", "2 / 9.00 lb", "Remove"],
    ]);
  });

  it("a line with nothing shipped reads 0 / 0.00 lb, and one the ledger does not list reads a dash", () => {
    // A row not saved yet, prefilled to all 10 pieces, so its Close short cell reads Completes line.
    const nothing: ShippedInfo = { qty: 0, weight: 0 };
    expect(bodyRows(grid({ rows: [added(nothing)], shipped: { "ol-1": nothing } })).map((row) => texts(row)))
      .toEqual([["P-10", "Shaft", "10 / 130.00 lb", "0 / 0.00 lb", "Completes line", "Remove"]]);
    expect(bodyRows(grid({ rows: [added(undefined)] })).map((row) => texts(row)))
      .toEqual([["P-10", "Shaft", "10 / 130.00 lb", "—", "Completes line", "Remove"]]);
  });

  it("saved shipment page: the strip of lines kept from earlier selections reads pcs and lb", () => {
    // sl-2 (P-20, 1 piece, 2 lb) has lost its order line. The filter keeps every strip the panel
    // draws and the list is compared whole: one strip, and this is all of its text.
    expect(texts(savedPage(4, undefined, ["sl-2"])).filter((text) => text.includes("kept from earlier selections"))).toEqual([
      "Lines kept from earlier selections (the order-side rows were since corrected away): P-20 · 1 pcs / 2.00 lb",
    ]);
  });
});

// ---- the grid's column shares (the owner's choice of 2026-10-10) ----

describe("the Lines grid's column shares", () => {
  it("gives each ship-now column 16 percent of the table, and the seven columns 100 in all", () => {
    const html = grid({ rows: [saved("4")], ...SAVED_4 });
    // Each `<col>` tag of the render, read whole. One that is not a percent share reads as NaN.
    const shares = [...html.matchAll(/<col\b[^>]*>/g)].map((col) => Number(/^<col class="w-\[(\d+)%\]"\/>$/.exec(col[0])?.[1]));
    expect(shares.reduce((sum, share) => sum + share, 0)).toBe(100);
    // The nth `<col>` sizes the nth column, so each share is paired with the heading over it.
    const [headings] = headingRowsOf(html);
    expect(shares.map((share, at) => [headings[at], share])).toEqual([
      ["Part", 19], ["Ordered", 15], ["Shipped to date", 13], ["Ship now qty", 16], ["Ship now net weight (lb)", 16],
      ["Close line short", 12], ["", 9],
    ]);
  });
});
