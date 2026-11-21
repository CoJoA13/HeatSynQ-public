// What the three grids of a saved shipment's order panel say on their controls (#472), and while a
// grid has no baseline yet (#483). The gates are proven in shipment-grid-gates.test.ts; this file
// proves the grids ask them, down to the rendered `disabled` and `title` attributes, and that an
// empty Add picker gives the true reason. The grid views both shipment pages draw are rendered on
// their own too, for that text and for what a picker's Add says while nothing is picked (#487).
// vitest has no DOM, so every render is static: no effect runs and no handler fires.
// The file's last two blocks hold a kept container row in the panel (the weights design §12.3),
// and then the totals table the panel draws (§12.2).
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ShipmentOrderPanel } from "../src/app/shipping/[id]/ShipmentOrderPanel";
import { ContainersGridView, LinesGridView, SerialsGridView } from "../src/app/shipping/ShipmentGrids";
import { createDraftStore } from "../src/lib/draft-store";
import {
  createBulkRecoveryAdapter, emptyBulkDraft, transitionBulkDraft, type BulkBaseline, type BulkRecoveryCustomization,
} from "../src/lib/bulk-grid-recovery";
import {
  shipmentBulkCustomization, shipmentContainersBaseline, shipmentLinesBaseline, shipmentSerialsBaseline,
  type ShipmentBulkSnapshot, type ShipmentGridKind,
} from "../src/lib/shipment-bulk-recovery";
import type { Gate } from "../src/lib/permission-ui";
import { DRAFT_RECOVERY_TITLE, OVERRIDE_REASON_REQUIRED, shipmentLinesGate } from "../src/lib/shipment-gates";
import { CHECKING_ACCESS, EDITOR_NOT_LOADED, EDITOR_UNAVAILABLE } from "../src/lib/draft-recovery-words";
import { NO_UNSAVED_CHANGES } from "../src/lib/waiting-titles";
import { declared, jsxTags } from "./helpers/jsx-source";
import { NO_REPORTS, savedShipmentTotalsInput, shipmentTotals, type TotalsTableView } from "../src/lib/shipment-totals";
import { shipmentFixture } from "./helpers/remaining-bulk-fixtures";
import { shipmentTotalsIn } from "./helpers/shipment-totals-markup";

type Fields = Record<string, string>;
const rendered = vi.hoisted(() => ({ views: [] as unknown[], index: 0 }));
// Only the SSR subscription seam is supplied, in hook-call order: lines, containers, serials (the
// shipment-recovery-access precedent). The panel, its three grids and useBulkGrid are production code.
vi.mock("../src/lib/use-recoverable-draft", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/use-recoverable-draft")>(),
  useRecoverableDraft: () => rendered.views[rendered.index++],
}));
afterEach(() => { rendered.views = []; rendered.index = 0; });

const OPEN: Gate = { allowed: true, disabled: false, title: undefined };
const closed = (title: string): Gate => ({ allowed: false, disabled: true, title });
const VOIDED = closed("Shipment is voided");
const HOLD = closed("ACME · Acme Heat is on credit hold — adding orders or changing lines requires the override_credit_hold action");
const REASON = closed(OVERRIDE_REASON_REQUIRED);

const kinds = ["lines", "containers", "serials"] as const;
const adapter = (kind: ShipmentGridKind) => createBulkRecoveryAdapter<Fields>(
  `shipment-${kind}`, `shipment-${kind}-v1`, shipmentBulkCustomization(kind) as BulkRecoveryCustomization<Fields>);
function project(kind: ShipmentGridKind, fixture: ShipmentBulkSnapshot): BulkBaseline<Fields> {
  return (kind === "lines" ? shipmentLinesBaseline : kind === "containers" ? shipmentContainersBaseline : shipmentSerialsBaseline)(fixture, "so-1");
}
/** One bound grid per kind, each with one accepted read of `fixture`, as `shipmentBulkOptions`
 *  projects it: the grid is editable, and a retained draft restorable, as the baseline itself says.
 *  `read` is a later read of the same fixture. */
function open(fixture: ShipmentBulkSnapshot) {
  const store = createDraftStore();
  const owner = store.acceptIdentity(store.beginIdentityCheck(), "shipping-clerk")!;
  const entries = kinds.map(kind => {
    const binding = store.bind({ owner, record: { kind: "shipment", id: "ship-1" }, editor: `shipment-${kind}`, childId: "so-1" },
      { label: kind, href: "/shipping/ship-1" }, adapter(kind));
    const read = () => {
      const baseline = project(kind, fixture);
      binding.acceptRead({ kind: "authorized", readId: binding.beginRead(), baseline,
        editable: baseline.context.editable === true, recoveryAllowed: baseline.context.catalogAuthorized === true }, emptyBulkDraft<Fields>());
    };
    const detach = binding.attach("initial");
    read();
    return { kind, binding, detach, read };
  });
  return { fixture, entries };
}
const modes = (h: ReturnType<typeof open>) => h.entries.map(e => e.binding.getSnapshot().mode);
/** The saved page's panel over these bindings. A gate not named is open. `totals` is the table the
 *  panel is handed: left out, it is what the page works out for this order with nothing reported. */
function render(h: ReturnType<typeof open>, gates: { editGate?: Gate; linesGate?: Gate; linesSaveGate?: Gate } = {},
  totals: TotalsTableView = shipmentTotals(savedShipmentTotalsInput(h.fixture.shipper.orders, NO_REPORTS)).orders[0]): string {
  rendered.views = h.entries.map(e => e.binding.getSnapshot()); rendered.index = 0;
  return renderToStaticMarkup(<ShipmentOrderPanel shipperId="ship-1" order={h.fixture.shipper.orders[0]}
    recoverySource={{ read: async () => ({ record: h.fixture.shipper, access: h.fixture.permissions }), register: vi.fn(), begin: vi.fn() }}
    editGate={gates.editGate ?? OPEN} linesGate={gates.linesGate ?? OPEN} linesSaveGate={gates.linesSaveGate}
    creditHoldReason="" applyMutation={async run => { await run(); }} onRemove={() => {}}
    printGate={OPEN} printing={false} certsGate={OPEN} onPrintTicket={() => {}}
    totals={totals} onTotalsReport={() => {}} />);
}

type Control = { name: string; disabled: boolean; title: string | undefined };
/** A control inside one of the three grids, by its name: an input's or a select's aria-label, a
 *  button's text. The panel's own controls (Remove order, the print row), a grid's Discard and a
 *  recovery notice's buttons are not among them. */
const IN_A_GRID = /^(?:(?:Line|Container|Kept container|Serial) \d+ .+|Add (?:line|container|serial)|Remove|Add|Add all remaining|Save (?:lines|containers|serials))$/;
/** Every grid control in this markup. `disabled` is the attribute, never the word: the Tailwind
 *  classes carry `disabled:` in every render (the shipment-reverse-control lesson). The fixture's
 *  two lines, two containers and two serials make 30: 15 boxes and pickers, 15 buttons. */
function gridControls(html: string): Control[] {
  const fields = (html.match(/<(?:input|select)\b[^>]*>/g) ?? []).map(tag => ({ name: tag.match(/aria-label="([^"]*)"/)?.[1] ?? "", tag }));
  const pressed = [...html.matchAll(/(<button\b[^>]*>)([^<]*)<\/button>/g)].map(m => ({ name: m[2], tag: m[1] }));
  return [...fields, ...pressed].filter(c => IN_A_GRID.test(c.name))
    .map(c => ({ name: c.name, disabled: /\sdisabled=""/.test(c.tag), title: c.tag.match(/\stitle="([^"]*)"/)?.[1] }));
}
function named(html: string, name: string): Control {
  const found = gridControls(html).filter(c => c.name === name);
  expect(found, name).toHaveLength(1);
  return found[0];
}
const SPAN = (text: string) => `<span class="text-sm text-ink-500">${text}</span>`;

describe("a saved shipment's grids: the title a closed control carries", () => {
  it("a voided shipment: all 30 grid controls are closed with the page's reason, and none speaks of a draft", () => {
    const fixture = shipmentFixture(); fixture.shipper.deletedAt = "2026-10-08T12:00:00.000Z";
    const h = open(fixture);
    // No grid's draft is editable on a voided shipment, and nothing is retained.
    expect(modes(h)).toEqual(["conflict", "conflict", "conflict"]);
    const html = render(h, { editGate: VOIDED, linesGate: VOIDED });
    const all = gridControls(html);
    expect(all).toHaveLength(30);
    expect(all.filter(c => !c.disabled || c.title !== "Shipment is voided")).toEqual([]);
    expect(html).not.toContain(DRAFT_RECOVERY_TITLE);
  });

  it("a held customer without the override: the Lines grid carries the hold, and Containers and Serials stay open", () => {
    const fixture = shipmentFixture(); fixture.shipper.customerCreditHold = true;
    const h = open(fixture);
    expect(modes(h)).toEqual(["conflict", "editing", "editing"]);
    const html = render(h, { linesGate: HOLD });
    const all = gridControls(html);
    expect(all).toHaveLength(30);
    // The Lines grid: six boxes, two Removes, the picker, Add, Add all remaining, Save lines.
    const held = all.filter(c => c.title === HOLD.title);
    expect(held).toHaveLength(12);
    expect(held.filter(c => !c.disabled)).toEqual([]);
    expect(held.map(c => c.name)).toContain("Save lines");
    // The only other titles are the two clean Saves, which have nothing to save (#487).
    expect(all.filter(c => c.title !== HOLD.title && c.title !== undefined)).toEqual([
      { name: "Save containers", disabled: true, title: NO_UNSAVED_CHANGES },
      { name: "Save serials", disabled: true, title: NO_UNSAVED_CHANGES },
    ]);
    expect(named(html, "Container 1 count").disabled).toBe(false);
    expect(named(html, "Serial 1 print on ticket").disabled).toBe(false);
    expect(html).not.toContain(DRAFT_RECOVERY_TITLE);
  });

  it("a finalized invoice: the Lines grid carries the server's sentence, and a Tare each box stays open", () => {
    const invoiced = shipmentLinesGate(OPEN, [{ orderId: "order-1", orderNumber: 101, invoiceId: "inv-1" }]);
    const html = render(open(shipmentFixture()), { linesGate: invoiced });
    // The Lines grid is closed, so the open box below is not open only because every gate is.
    expect(named(html, "Line 1 ship-now weight")).toEqual({ name: "Line 1 ship-now weight", disabled: true, title: invoiced.title });
    expect(named(html, "Container 1 tare each")).toEqual({ name: "Container 1 tare each", disabled: false, title: undefined });
  });

  it("a retained draft under an open page gate: the grids name draft recovery, the one case that sentence is for", () => {
    const h = open(shipmentFixture());
    for (const entry of h.entries) {
      const base = entry.binding.getSnapshot().current!.baseline;
      entry.binding.change(d => transitionBulkDraft(d, base, { kind: "remove-existing", id: base.rows[0].id }));
      // The page is left and come back to: the fresh read finds the draft and offers it.
      entry.detach(); entry.binding.attach("return"); entry.read();
    }
    expect(modes(h)).toEqual(["offer", "offer", "offer"]);
    const html = render(h);
    const all = gridControls(html);
    expect(all).toHaveLength(30);
    expect(all.filter(c => !c.disabled || c.title !== DRAFT_RECOVERY_TITLE)).toEqual([]);
    // The notice above each grid is the way out the title points at.
    expect(html).toContain("Restore them to continue editing.");
  });

  it("Save lines alone waits for a blank override reason: the boxes beside it stay open", () => {
    const h = open(shipmentFixture());
    const base = h.entries[0].binding.getSnapshot().current!.baseline;
    h.entries[0].binding.change(d => transitionBulkDraft(d, base, { kind: "edit", id: base.rows[0].id, patch: { weight: "5" } }));
    const html = render(h, { linesSaveGate: REASON });
    // The grid is dirty: a clean Save is disabled whatever its gate says, and would prove nothing.
    expect(html).toContain(">Unsaved changes</span>");
    expect(named(html, "Save lines")).toEqual({ name: "Save lines", disabled: true, title: OVERRIDE_REASON_REQUIRED });
    expect(named(html, "Line 1 ship-now weight")).toEqual({ name: "Line 1 ship-now weight", disabled: false, title: undefined });
    // The two clean Saves beside it say they have nothing to save (#487).
    expect(gridControls(html).filter(c => c.title !== undefined).map(c => [c.name, c.title])).toEqual([
      ["Save lines", OVERRIDE_REASON_REQUIRED], ["Save containers", NO_UNSAVED_CHANGES], ["Save serials", NO_UNSAVED_CHANGES],
    ]);
    // Handed no gate of its own, Save lines follows the Lines gate, open or closed.
    expect(named(render(h), "Save lines")).toEqual({ name: "Save lines", disabled: false, title: undefined });
    expect(named(render(h, { linesGate: VOIDED }), "Save lines")).toEqual({ name: "Save lines", disabled: true, title: "Shipment is voided" });
  });
});

// R23 (owner ruling 2026-10-22, #702): a grid closes its controls while its own Save is in
// transport, because the landed save installs its answer over an empty draft and would drop what was
// typed meanwhile. Each grid's save is the store's capture and dispatched, as the panel's `save` takes
// them; the grid's own Save keeps an open gate, so it carries no title while it runs (owner answer 9).
describe("a saved shipment's grids while one grid's own Save is in transport (R23, #702)", () => {
  const SAMPLE = { lines: "Line 1 ship-now weight", containers: "Container 1 count", serials: "Serial 1 print on ticket" } as const;
  const SAVE = { lines: "Save lines", containers: "Save containers", serials: "Save serials" } as const;
  const OWN = { lines: /^(?:Line \d+ |Add line$)/, containers: /^(?:(?:Kept )?[Cc]ontainer \d+ |Add container$)/, serials: /^(?:Serial \d+ |Add serial$)/ } as const;
  it.each(kinds)("the %s grid's controls close, untitled, its Save stays open, and the other two grids stay open", (kind) => {
    const h = open(shipmentFixture());
    const entry = h.entries.find(e => e.kind === kind)!;
    const base = entry.binding.getSnapshot().current!.baseline;
    entry.binding.change(d => transitionBulkDraft(d, base, { kind: "remove-existing", id: base.rows[0].id }));
    const submission = entry.binding.capture([], "request-1");
    expect(entry.binding.dispatched(submission)).toBe(true);
    expect(entry.binding.getSnapshot()).toMatchObject({ mode: "editing", pending: true });
    const html = render(h);
    const all = gridControls(html);
    // This grid's boxes and picker by their names, and its Removes: the other grids' are open.
    const own = all.filter(c => OWN[kind].test(c.name));
    expect(own.length).toBeGreaterThan(1);
    expect(own.filter(c => !c.disabled || c.title !== undefined)).toEqual([]);
    const removes = all.filter(c => c.name === "Remove" && c.disabled);
    expect(removes).toEqual(Array.from({ length: base.rows.length - 1 }, () => ({ name: "Remove", disabled: true, title: undefined })));
    expect(named(html, SAVE[kind])).toEqual({ name: SAVE[kind], disabled: false, title: undefined });
    for (const other of kinds.filter(k => k !== kind)) expect(named(html, SAMPLE[other]).disabled, other).toBe(false);
    // Refused, the save leaves the draft in place, and the grid opens again with it.
    entry.binding.settle(submission, { kind: "rejected" });
    expect(entry.binding.getSnapshot().pending).toBeUndefined();
    expect(named(render(h), SAMPLE[kind]).disabled).toBe(false);
  });
});

describe("a saved shipment's grids: the text beside an empty Add picker", () => {
  it("with orders.view and the whole catalog on the shipment, each picker says so", () => {
    const html = render(open(shipmentFixture()));
    for (const noun of ["line", "container", "serial"]) expect(html, noun).toContain(SPAN(`Every order ${noun} is on this shipment`));
    expect(html).not.toContain("Requires orders.view");
  });

  it("without orders.view the catalog was never read, and each picker names the permission", () => {
    const fixture = shipmentFixture(); fixture.permissions = ["shipping.view", "shipping.edit"];
    const html = render(open(fixture));
    expect(html.split(SPAN("Requires orders.view"))).toHaveLength(4);
    expect(html).not.toContain("Every order");
    expect(html).not.toContain(">Requires orders.view</option>");
  });
});

const noop = () => {};
/** Each view with no rows, offering one candidate or none, under `gate` (open unless given). A static
 *  render runs no handler, so nothing is picked. */
const views = {
  line: (emptyReason: string | undefined, offers: boolean, gate: Gate = OPEN) => renderToStaticMarkup(
    <LinesGridView rows={[]} candidates={offers ? [{ id: "ol-9", partNumber: "P-90", qty: 4, weight: 8 }] : []}
                   infoByLineId={new Map()} shippedByLineId={new Map()} savedQtyByLineId={new Map()}
                   gate={gate} onPatch={noop} onRemove={noop} onAddRows={noop} emptyReason={emptyReason} />),
  container: (emptyReason: string | undefined, offers: boolean, gate: Gate = OPEN, orderHasNone = false) => renderToStaticMarkup(
    <ContainersGridView rows={[]} candidates={offers ? [{ id: "oc-9", typeName: "Crate", customerContainerId: "", count: 1, tareEach: null }] : []}
                        infoById={new Map()} gate={gate} onPatch={noop} onRemove={noop} onAddRows={noop} emptyReason={emptyReason}
                        orderHasNone={orderHasNone} />),
  serial: (emptyReason: string | undefined, offers: boolean, gate: Gate = OPEN, orderHasNone = false) => renderToStaticMarkup(
    <SerialsGridView rows={[]} candidates={offers ? [{ id: "os-9", serial: "S009" }] : []}
                     infoById={new Map()} gate={gate} onPatch={noop} onRemove={noop} onAddRows={noop} emptyReason={emptyReason}
                     orderHasNone={orderHasNone} />),
};
const NOUNS = ["line", "container", "serial"] as const;

describe("the three grid views: the text beside an empty Add picker", () => {
  it.each(NOUNS)("%s: its own sentence when it is handed no reason", noun => {
    expect(views[noun](undefined, false)).toContain(SPAN(`Every order ${noun} is on this shipment`));
  });

  it.each(NOUNS)("%s: the reason it is handed, as text beside the picker and never as an option", noun => {
    const html = views[noun]("Requires orders.view", false);
    expect(html).toContain(SPAN("Requires orders.view"));
    expect(html).not.toContain("Every order");
    expect(html).not.toContain(">Requires orders.view</option>");
  });

  it.each(NOUNS)("%s: no text at all while the picker has something to offer, whatever reason it was handed", noun => {
    const html = views[noun]("Requires orders.view", true);
    expect(html).not.toContain("Requires orders.view");
    expect(html).not.toContain("Every order");
  });

  // #698 (G8-4): an order with no rows of the kind says so and where to add them, instead of the
  // sentence about every one of zero rows. The reason it is handed still wins.
  it.each([["container", "This order has no container rows. Add them on the order's Containers grid first."],
    ["serial", "This order has no serials. Add them on the order's Serials grid first."]] as const)(
    "%s: the order has none, so the text says where to add them", (noun, sentence) => {
      const html = views[noun](undefined, false, OPEN, true);
      // A static render escapes the apostrophe in "order's".
      expect(html).toContain(SPAN(sentence.replaceAll("'", "&#x27;")));
      expect(html).not.toContain("Every order");
      expect(views[noun]("Requires orders.view", false, OPEN, true)).toContain(SPAN("Requires orders.view"));
      expect(views[noun](undefined, true, OPEN, true)).not.toContain("This order has no");
    },
  );
});

// ---- #487: a picker's Add says what it waits for, on both shipment pages ----

const GRIDS = "src/app/shipping/ShipmentGrids.tsx";
/** The words each picker's Add waits with (owner answer 1, 2026-10-16). */
const PICK_FIRST = { line: "Pick a line first", container: "Pick a container first", serial: "Pick a serial first" } as const;

describe("the three grid views: a picker's Add says what it waits for (#487)", () => {
  it.each(NOUNS)("%s: the picker offers something and nothing is picked, so Add is closed and says so", noun => {
    const html = views[noun](undefined, true);
    expect(named(html, "Add")).toEqual({ name: "Add", disabled: true, title: PICK_FIRST[noun] });
    // The picker beside it and Add all remaining are open, and need no title.
    expect(named(html, `Add ${noun}`)).toEqual({ name: `Add ${noun}`, disabled: false, title: undefined });
    expect(named(html, "Add all remaining")).toEqual({ name: "Add all remaining", disabled: false, title: undefined });
  });

  it.each(NOUNS)("%s: the picker offers nothing, so the text beside it is the reason and Add stays untitled", noun => {
    const html = views[noun](undefined, false);
    expect(named(html, "Add")).toEqual({ name: "Add", disabled: true, title: undefined });
    expect(html).toContain(SPAN(`Every order ${noun} is on this shipment`));
    expect(html).not.toContain(PICK_FIRST[noun]);
  });

  it.each(NOUNS)("%s: a closed gate keeps its own reason on Add, whatever the picker offers", noun => {
    for (const offers of [true, false]) {
      expect(named(views[noun](undefined, offers, VOIDED), "Add"), String(offers))
        .toEqual({ name: "Add", disabled: true, title: "Shipment is voided" });
    }
  });

  it("each view's Add asks the leaf with its own gate, picker and noun, and closes as before", () => {
    const adds = jsxTags(GRIDS).filter(t => t.name === "button" && t.attr("onClick") === "addPicked");
    expect(adds.map(t => t.attr("title"))).toEqual([
      'pickerAddTitle(gate, candidates.length, pick, "line")',
      'pickerAddTitle(gate, candidates.length, pick, "container")',
      'pickerAddTitle(gate, candidates.length, pick, "serial")',
    ]);
    expect(adds.map(t => t.attr("disabled"))).toEqual(Array(3).fill("!gate.allowed || !pick"));
  });
});

// ---- #483 (b, c): a grid with no baseline, while its read is in flight or has failed ----

/** One bound grid per kind, attached, with a read begun and no baseline accepted. In `loading` the
 *  read is not answered. In `unavailable` it is answered unavailable. In `error` it is answered
 *  with rows the adapter's validity check refuses: the first row twice, so one row id repeats. */
function unread(fixture: ShipmentBulkSnapshot, state: "loading" | "unavailable" | "error"): ReturnType<typeof open> {
  const store = createDraftStore();
  const owner = store.acceptIdentity(store.beginIdentityCheck(), "shipping-clerk")!;
  const entries = kinds.map(kind => {
    const binding = store.bind({ owner, record: { kind: "shipment", id: "ship-1" }, editor: `shipment-${kind}`, childId: "so-1" },
      { label: kind, href: "/shipping/ship-1" }, adapter(kind));
    const detach = binding.attach("initial");
    const readId = binding.beginRead();
    if (state === "unavailable") binding.acceptRead({ kind: "unavailable", readId }, emptyBulkDraft<Fields>());
    if (state === "error") {
      const baseline = project(kind, fixture);
      binding.acceptRead({ kind: "authorized", readId, baseline: { ...baseline, rows: [baseline.rows[0], ...baseline.rows] },
        editable: baseline.context.editable === true, recoveryAllowed: baseline.context.catalogAuthorized === true }, emptyBulkDraft<Fields>());
    }
    return { kind, binding, detach, read: () => {} };
  });
  return { fixture, entries };
}

const PANEL = "src/app/shipping/[id]/ShipmentOrderPanel.tsx";

describe("a saved shipment's grids while a read is in flight or has failed (#483)", () => {
  // With no baseline each grid has no rows, so its controls are the picker, Add, Add all remaining
  // and its Save: 12 in the panel. "Add" and "Add all remaining" are three each, so these cases
  // filter the census and never ask `named`, which wants exactly one.

  it("loading, under open gates: all 12 grid controls are closed with the notice's first sentence, and so is each picker's text", () => {
    const h = unread(shipmentFixture(), "loading");
    expect(modes(h)).toEqual(["loading", "loading", "loading"]);
    const html = render(h);
    const all = gridControls(html);
    expect(all).toHaveLength(12);
    expect(all.filter(c => !c.disabled || c.title !== "Checking access to this editor…")).toEqual([]);
    expect(html.split(SPAN(CHECKING_ACCESS))).toHaveLength(4);
    expect(html).not.toContain("Every order");
    expect(html).not.toContain(DRAFT_RECOVERY_TITLE);
  });

  it("unavailable, which a grid reaches when its own read is refused (readBulkPermissions' identity check included), " +
     "when the page's load() read fails, or when a mutation is answered 401 or 403: every control and picker says so", () => {
    const h = unread(shipmentFixture(), "unavailable");
    expect(modes(h)).toEqual(["unavailable", "unavailable", "unavailable"]);
    const html = render(h);
    const all = gridControls(html);
    expect(all).toHaveLength(12);
    expect(all.filter(c => !c.disabled || c.title !== "This editor is unavailable.")).toEqual([]);
    expect(html.split(SPAN(EDITOR_UNAVAILABLE))).toHaveLength(4);
    expect(html).not.toContain(SPAN(CHECKING_ACCESS));
    expect(html).not.toContain("Every order");
    expect(html).not.toContain(DRAFT_RECOVERY_TITLE);
  });

  it("error, which only data the adapter's validity check refuses reaches: every control and picker says the editor could not be loaded", () => {
    const h = unread(shipmentFixture(), "error");
    expect(modes(h)).toEqual(["error", "error", "error"]);
    const html = render(h);
    const all = gridControls(html);
    expect(all).toHaveLength(12);
    expect(all.filter(c => !c.disabled || c.title !== "This editor could not be loaded.")).toEqual([]);
    expect(html.split(SPAN(EDITOR_NOT_LOADED))).toHaveLength(4);
    expect(html).not.toContain(SPAN(CHECKING_ACCESS));
    expect(html).not.toContain("Every order");
    expect(html).not.toContain(DRAFT_RECOVERY_TITLE);
  });

  it("loading, on a voided shipment: a closed page gate keeps its own reason, and each picker's text still follows the grid", () => {
    const h = unread(shipmentFixture(), "loading");
    const html = render(h, { editGate: VOIDED, linesGate: VOIDED });
    const all = gridControls(html);
    expect(all).toHaveLength(12);
    expect(all.filter(c => !c.disabled || c.title !== "Shipment is voided")).toEqual([]);
    expect(html.split(SPAN(CHECKING_ACCESS))).toHaveLength(4);
    expect(html).not.toContain(DRAFT_RECOVERY_TITLE);
  });

  it("each grid asks the gates with the mode useBulkGrid reports, never its view's own", () => {
    expect(declared(PANEL, "recoveryGate")).toEqual(Array(3).fill("gridGate(editGate, grid.mode)"));
    const tags = jsxTags(PANEL);
    expect(tags.filter(t => t.name === "SaveButton").map(t => t.attr("gate")))
      .toEqual(["gridGate(saveGate, grid.mode)", "recoveryGate", "recoveryGate"]);
    expect(tags.filter(t => t.name.endsWith("GridView")).map(t => [t.name, t.attr("emptyReason")])).toEqual([
      ["LinesGridView", "pickerEmptyReason(baseline?.context, grid.mode)"],
      ["ContainersGridView", "pickerEmptyReason(baseline?.context, grid.mode)"],
      ["SerialsGridView", "pickerEmptyReason(baseline?.context, grid.mode)"],
    ]);
    // #698: the order's own count reaches the two views only once the catalog was read.
    expect(tags.filter(t => t.name.endsWith("GridView")).map(t => [t.name, t.attr("orderHasNone")])).toEqual([
      ["LinesGridView", undefined],
      ["ContainersGridView", "baseline?.context.catalogAuthorized === true && catalog.containers.length === 0"],
      ["SerialsGridView", "baseline?.context.catalogAuthorized === true && catalog.serials.length === 0"],
    ]);
  });
});

// ---- a kept container row in the panel (the weights design §12.3: C7, C8, C12, A2) ----

describe("a saved shipment's panel: a kept container row", () => {
  const C7 = "Containers marked Kept are from earlier selections (the order-side rows were since corrected away). Only their Tare each can be changed.";
  const KEPT_BOX = "Kept container 1 tare each";
  // A finalized invoice closes the Lines gate and leaves the page's edit gate open (shipment-gates.ts).
  const INVOICED = shipmentLinesGate(OPEN, [{ orderId: "order-1", orderNumber: 101, invoiceId: "inv-1" }]);
  /** The fixture with its second container row kept: Drum · D-20, 3 at 42.5 lb, has lost its order
   *  row, and Box · B-10, 2 at 30 lb, still has one. Both tare each figures and the Drum's number of
   *  containers are set here: at 3, the Drum's Tare total is not its tare each. */
  function keptFixture(): ShipmentBulkSnapshot {
    const fixture = shipmentFixture();
    const [box, drum] = fixture.shipper.orders[0].containers;
    box.tareEach = 30; drum.count = 3; drum.tareEach = 42.5; drum.orderContainerId = null;
    return fixture;
  }
  /** Every run of text in this markup, in order. */
  const texts = (html: string): string[] => html.replace(/<[^>]+>/g, "\n").split("\n").map(t => t.trim()).filter(t => t !== "");
  /** The body of the Containers table: from that grid's title to the Serials grid's, inside `<tbody>`. */
  const containerRows = (html: string): string =>
    html.split(">Containers</h4>")[1].split(">Shipment serials</h4>")[0].split("<tbody>")[1].split("</tbody>")[0];

  it("draws the kept row in the Containers table, first, from the shipment row's own data", () => {
    expect(texts(containerRows(render(open(keptFixture())))))
      .toEqual(["Drum", "D-20", "3", "127.50", "Kept", "Box", "B-10", "60.00", "Remove"]);
  });

  it("says what Kept means once (C7), and draws no Containers strip", () => {
    expect(texts(render(open(keptFixture()))).filter(text => text.includes("earlier selections"))).toEqual([C7]);
  });

  it("the kept row has its own Tare each box and no box for its number of containers, and the other row keeps its names", () => {
    expect(gridControls(render(open(keptFixture()))).map(c => c.name).filter(name => /ontainer/.test(name)))
      .toEqual([KEPT_BOX, "Container 1 count", "Container 1 tare each", "Add container", "Save containers"]);
  });

  it("the kept row's box is open under a finalized invoice, in a render whose Lines box is closed with the invoice's sentence", () => {
    const html = render(open(keptFixture()), { linesGate: INVOICED });
    // The Lines box is read in the same render, so the kept box is not open only because every gate is.
    expect([named(html, "Line 1 ship-now weight"), named(html, KEPT_BOX)]).toEqual([
      { name: "Line 1 ship-now weight", disabled: true, title: INVOICED.title },
      { name: KEPT_BOX, disabled: false, title: undefined },
    ]);
  });

  it("the kept row's box is closed on a voided shipment, with the page's reason", () => {
    expect(named(render(open(keptFixture()), { editGate: VOIDED, linesGate: VOIDED }), KEPT_BOX))
      .toEqual({ name: KEPT_BOX, disabled: true, title: "Shipment is voided" });
  });

  it("a retained draft of a kept row's tare each is offered, and closes its box with the grid's own reason", () => {
    const h = open(keptFixture());
    const containers = h.entries[1];
    const base = containers.binding.getSnapshot().current!.baseline;
    containers.binding.change(d => transitionBulkDraft(d, base, { kind: "edit", id: "sc-2", patch: { tareEach: "40" } }));
    // The page is left and come back to: the fresh read finds the draft and offers it.
    containers.detach(); containers.binding.attach("return"); containers.read();
    expect([modes(h), named(render(h), KEPT_BOX)])
      .toEqual([["editing", "offer", "editing"], { name: KEPT_BOX, disabled: true, title: DRAFT_RECOVERY_TITLE }]);
  });
});

describe("a saved shipment's order panel: its totals table", () => {
  // Test input, not figures worked out here: the panel draws the view it is handed and adds nothing up.
  const VIEW: TotalsTableView = {
    caption: "Totals for 101-1", net: "1,600.00", tare: "Incomplete", gross: "Not available", note: "1 row has no Tare each", unsaved: false,
  };

  it("draws the view it is handed, once, under the Containers grid's Save row and above the Serials grid", () => {
    const html = render(open(shipmentFixture()), {}, VIEW);
    expect(shipmentTotalsIn(html).map(({ name, caption, cells, note }) => ({ name, caption, cells, note }))).toEqual([
      { name: "Totals for 101-1", caption: "Totals for 101-1", cells: ["1,600.00", "Incomplete", "Not available"], note: "1 row has no Tare each" },
    ]);
    // In the markup's own order: the Containers grid's Save button, the table's root, the Serials grid's title.
    expect(html).toMatch(/>Save containers<\/button>[\s\S]*\sdata-shipment-totals[\s=>][\s\S]*>Shipment serials<\/h4>/);
  });

  it.each([true, false])("shows the tag exactly while the view it is handed says unsaved: %s", (unsaved) => {
    const [table] = shipmentTotalsIn(render(open(shipmentFixture()), {}, { ...VIEW, unsaved }));
    expect(table.tag !== null).toBe(unsaved);
  });
});
