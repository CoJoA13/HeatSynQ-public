// The saved order's Containers grid (the weights design §9.4): what a row shows, what a change of
// type does to it, and what Save containers sends. And the order totals drawn above its rows
// (§10.2): where the table sits, what it is handed and when it is tagged.
//
// vitest has no DOM, so the section is read three ways. Its markup is the section rendered to a
// string over the view of a real recovery binding; only the hook that subscribes to that binding
// is supplied (the shipment-grid-titles precedent). The binding holds one accepted read unless a
// case says otherwise, and one case takes a field off a view by hand. A static render runs no
// effect and fires no handler, so the section's own `patch`, `changeType`, `startTypeVisit`,
// `endTypeVisit` and `save` are lifted out of its source and run against the real leaves, the way
// lines-section-wiring.test.ts runs the Lines handlers. And the three attributes that tie the type
// list to `changeType` and to the two visit functions are read from the syntax tree. A lifted
// function that gains a free identifier must gain it in the environment given here, in the same
// change, or it is a ReferenceError. The syntax-tree walker `all` and the runner `run` are
// tests/helpers/source-lift.ts.
//
// The prefill rule itself is container-tare-prefill.test.ts's, and the tare total's arithmetic is
// net-weight.test.ts's. This file proves the grid asks them.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ContainersSection } from "../src/app/orders/[id]/ContainersSection";
import type { ContainerTypeOption, OrderContainer } from "../src/app/orders/[id]/page";
import { composeRows, type ComposedRow } from "../src/lib/bulk-grid";
import { createBulkRecoveryAdapter, emptyBulkDraft, transitionBulkDraft, type BulkAction } from "../src/lib/bulk-grid-recovery";
import { tareEachAfterTypeChange, typeDefaultTare } from "../src/lib/container-tare-prefill";
import { decimalRefusal } from "../src/lib/decimal-entry";
import { CHECKING_ACCESS } from "../src/lib/draft-recovery-words";
import { ApiError } from "../src/lib/fetcher";
import { SCALE_GROSS, TARE_EACH } from "../src/lib/order-boxes";
import {
  createOrderBulkSource, orderAckSnapshot, projectContainers, type ContainerFields, type OrderBulkSnapshot,
} from "../src/lib/order-bulk-recovery";
import type { SavedTotalsLine } from "../src/lib/order-totals";
import { gate, type Gate } from "../src/lib/permission-ui";
import { DRAFT_RECOVERY_TITLE } from "../src/lib/shipment-gates";
import { bindDraftHarness, openDraftHarness, scalarAdapter } from "./helpers/draft-store";
import { createDraftStore, type DraftStore } from "../src/lib/draft-store";
import { EMPTY_DRAFT_SUMMARY } from "../src/lib/draft-session";
import { TAGS_NO_ROWS_TITLE, TAGS_UNSAVED_TITLE, TAGS_VOIDED_TITLE } from "../src/lib/container-tags-gate";
import { jsxTags, renderedFrom } from "./helpers/jsx-source";
import { orderBulkFixture } from "./helpers/order-bulk-fixture";
import { totalsOf } from "./helpers/order-totals-markup";
import { all, run } from "./helpers/source-lift";

const rendered = vi.hoisted(() => ({ views: [] as unknown[], index: 0 }));
// Only the SSR subscription seams are supplied: the recovery view, and the browser draft store the
// Print tags gate asks about retained drafts (#743; the traveler test's shape). The section,
// useBulkGrid, the recovery adapter and the draft store are production code.
const drafts = vi.hoisted(() => ({ store: null as DraftStore | null }));
vi.mock("../src/lib/use-recoverable-draft", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/use-recoverable-draft")>(),
  useRecoverableDraft: () => rendered.views[rendered.index++],
  useDraftIdentity: () => { const s = drafts.store?.getSnapshot() ?? EMPTY_DRAFT_SUMMARY; return { store: drafts.store, owner: s.owner, identityReady: s.identityReady }; },
  useDraftStoreAnswer: <T,>(answer: (store: DraftStore) => T, fallback: T) => (drafts.store ? answer(drafts.store) : fallback),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/orders/order-1" }));
beforeEach(() => {
  drafts.store = createDraftStore();
  drafts.store.acceptIdentity(drafts.store.beginIdentityCheck(), "tags-user");
});
afterEach(() => { rendered.views = []; rendered.index = 0; });
/** A retained draft of a hub section named `label`, on this order's path, as the traveler test keeps
 *  one: what `useUnsavedPresent` sees of unsaved work in a static render. */
function retain(label: string) {
  const store = drafts.store!;
  const owner = store.getSnapshot().owner!;
  const binding = store.bind({ owner, record: { kind: "order", id: "order-1" }, editor: scalarAdapter.kind, childId: label },
    { label, href: "/orders/order-1" }, scalarAdapter);
  const detach = binding.attach("leaving-view");
  const readId = binding.beginRead();
  binding.acceptRead({ kind: "authorized", readId, baseline: { value: "1905" }, editable: true }, { value: "1905" });
  binding.change(() => ({ value: "1888" }));
  detach();
}

const FILE = "src/app/orders/[id]/ContainersSection.tsx";
type Row = ComposedRow<ContainerFields>;
const OPEN: Gate = { allowed: true, disabled: false, title: undefined };
const TYPES: ContainerTypeOption[] = [
  { id: "basket", name: "Steel Basket", tareEach: 42.5 },
  { id: "gaylord", name: "Cardboard Gaylord", tareEach: 60 },
  { id: "skid", name: "Skid", tareEach: null },
];
/** A saved container row as the order read sends it: 3 baskets, 252 pieces, 42.50 lb each. */
const container = (over: Partial<OrderContainer> = {}): OrderContainer => ({
  id: "container-1", position: 1, typeId: "basket", count: 3, pieces: 252, tareEach: 42.5, scaleGross: null,
  customerContainerId: "BIN-7", type: { name: "Steel Basket" }, ...over,
});
function snapshot(containers: OrderContainer[]): OrderBulkSnapshot {
  const base = orderBulkFixture();
  return { ...base, order: { ...base.order, containers }, containerTypes: TYPES };
}
const source = createOrderBulkSource(
  async () => { throw new Error("SSR must not read recovery"); }, async () => { throw new Error("SSR must not read access"); });

/** A bound Containers editor that has accepted one read of these saved rows. */
function open(containers: OrderContainer[]) {
  const adapter = createBulkRecoveryAdapter<ContainerFields>("order-containers", "order-containers-v2");
  const { binding, detach } = openDraftHarness(adapter, emptyBulkDraft<ContainerFields>(), projectContainers(snapshot(containers)).baseline);
  return {
    binding, containers,
    /** Detaches the editor's first view, the one `openDraftHarness` attached. */
    detach,
    /** One change to the unsaved rows, through the grid's own reducer. */
    change(action: BulkAction<ContainerFields>) {
      binding.change(data => transitionBulkDraft(data, binding.getSnapshot().current!.baseline, action));
    },
  };
}
type Editor = ReturnType<typeof open>;
/** The rows the grid draws now: saved rows under their unsaved edits, then added rows. */
function composed(editor: Editor): Row[] {
  const { data, baseline } = editor.binding.getSnapshot().current!;
  return composeRows({ serverRows: baseline.rows, toFields: row => row.fields, ...data });
}
/** The saved order's lines as the page hands them to the section: order 1004's one line, 250
 *  pieces and 1,600.00 lb, of a part at 6.4 lb each. */
const LINES: SavedTotalsLine[] = [{ partId: "part-1", qty: 250, weight: 1600, part: { eachWeight: 6.4 } }];
function render(editor: Pick<Editor, "binding" | "containers">, editGate: Gate = OPEN,
  tags: { viewGate?: Gate; voided?: boolean } = {}): string {
  rendered.views = [editor.binding.getSnapshot()]; rendered.index = 0;
  return renderToStaticMarkup(<ContainersSection recoverySource={source} orderId="order-1" containers={editor.containers} lines={LINES}
    containerTypes={TYPES} editGate={editGate} viewGate={tags.viewGate ?? OPEN} voided={tags.voided ?? false}
    applyMutation={async mutation => { await mutation(); }} />);
}
/** A bound Containers editor that has accepted no read. `containers` is what the page holds
 *  meanwhile. */
function waiting(containers: OrderContainer[]): Pick<Editor, "binding" | "containers"> {
  const adapter = createBulkRecoveryAdapter<ContainerFields>("order-containers", "order-containers-v2");
  return { binding: bindDraftHarness(adapter).binding, containers };
}

// ---- readers of the markup ----

/** Every input and select, in order: its accessible name, and an input's value. */
function boxes(html: string): { name: string; value: string | undefined }[] {
  return (html.match(/<(?:input|select)\b[^>]*>/g) ?? []).map(tag => ({
    name: tag.match(/\saria-label="([^"]*)"/)?.[1] ?? "",
    value: tag.match(/\svalue="([^"]*)"/)?.[1],
  }));
}
/** The words each cell opens with, in order: a box's label, or the display cell's. */
const cellLabels = (html: string) => [...html.matchAll(/<(?:label|div)\b[^>]*>([^<]+)</g)].map(match => match[1]);
/** What each row's Tare total cell shows, in order. */
const tareTotals = (html: string) => [...html.matchAll(/Tare total \(lb\)<p\b[^>]*>([^<]*)<\/p>/g)].map(match => match[1]);
const LABELS = ["Type", "Containers", "Pieces (total)", "Tare each (lb)", "Tare total (lb)", "Scale gross (lb)", "Cust Cont Id"];
/** What the totals table shows, through the shared reader: its tag as text, each row's four cells,
 *  the note and the weighed lines. The caption, the name and the headings are
 *  order-totals-table.test.tsx's to hold. */
function totalsShown(html: string) {
  const { tag, rows, note, weighed } = totalsOf(html);
  return { tag: tag === null ? null : tag.replace(/<[^>]*>/g, ""), rows, note, weighed };
}

// ---- the section's own functions, lifted from its source ----

const path = fileURLToPath(new URL(`../${FILE}`, import.meta.url));
const tree = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
/** The production function declaration `name`, closed over `environment` and nothing else. Its
 *  types are dropped. Throws unless the file declares exactly one function of that name. */
function actual<T>(name: string, environment: Record<string, unknown>): T {
  const found = all(tree, ts.isFunctionDeclaration).filter(declaration => declaration.name?.text === name);
  if (found.length !== 1) throw new Error(`Expected one function ${name} in ${FILE}, found ${found.length}`);
  return run<T>(found[0].getText(tree), environment);
}
type GridWrites = {
  updateExisting: (id: string, fields: Partial<ContainerFields>) => void;
  updateAdded: (id: string, fields: Partial<ContainerFields>) => void;
};
/** What the section's `typeVisit` ref holds: the row as it stood when its Type list took focus. */
type TypeVisit = { current: { key: string; typeId: string; tareEach: string } | null };
/** The section's `changeType` and its two visit functions, over its own `patch`, the real prefill
 *  leaf and this grid. The three share one `typeVisit`, as they share the component's one ref. A
 *  case that never calls `startTypeVisit` runs `changeType` outside any visit. */
function typeListOver(grid: GridWrites) {
  const typeVisit: TypeVisit = { current: null };
  const patch = actual<(row: Row, fields: Partial<ContainerFields>) => void>("patch", { grid });
  return {
    typeVisit,
    changeType: actual<(row: Row, next: string) => void>(
      "changeType", { containerTypes: TYPES, patch, tareEachAfterTypeChange, typeDefaultTare, typeVisit }),
    startTypeVisit: actual<(row: Row) => void>("startTypeVisit", { typeVisit }),
    endTypeVisit: actual<() => void>("endTypeVisit", { typeVisit }),
  };
}
/** The section's Type list functions writing through the grid's real reducer, as the page's grid
 *  does. `focus` and `step` act on the row as the grid draws it at that moment, which is what the
 *  list's handlers close over in a browser: `step` is one change event per type passed, as a
 *  closed list fires one for each arrow key. */
function typeListIn(editor: Editor, key = "container-1") {
  const list = typeListOver({
    updateExisting: (id, patch) => editor.change({ kind: "edit", id, patch }),
    updateAdded: (id, patch) => editor.change({ kind: "patch-added", id, patch }),
  });
  const row = () => composed(editor).find(candidate => candidate.key === key)!;
  return {
    ...list, row,
    focus: () => list.startTypeVisit(row()),
    blur: () => list.endTypeVisit(),
    step: (...types: string[]) => { for (const type of types) list.changeType(row(), type); },
  };
}
/** A grid that records each edit it is asked to make. */
function recording() {
  const grid = { updateExisting: vi.fn<GridWrites["updateExisting"]>(), updateAdded: vi.fn<GridWrites["updateAdded"]>() };
  return { grid, ...typeListOver(grid) };
}
/** A saved row as the grid holds it: every field the text a box shows. */
const saved = (over: Partial<ContainerFields> = {}): Row => ({
  key: "container-1", isNew: false, typeId: "basket", count: "3", pieces: "252", tareEach: "42.5", scaleGross: "",
  customerContainerId: "", ...over,
});
const added = (over: Partial<ContainerFields> = {}): Row => ({ ...saved(over), key: "added-1", isNew: true });

describe("the saved order's Containers grid: what a row shows", () => {
  it("names its cells Type, Containers, Pieces, Tare each, Tare total, Scale gross and Cust Cont Id, and ends with Remove", () => {
    const html = render(open([container()]));
    expect(cellLabels(html)).toEqual(LABELS);
    expect(html.split(">Remove</button>")).toHaveLength(2);
    expect(html.indexOf(">Remove</button>")).toBeGreaterThan(html.indexOf('aria-label="Container 1 customer container id"'));
    // The row total the old grid worked out from a row gross is gone.
    expect(html).not.toContain("Net:");
  });

  it("lays a row out four cells wide below 1280 px, and all eight in one row from 1280 px up", () => {
    // The owner's ruling of 2026-10-09 on the design's §9.9, point 6: "Default is fine, wrap it to
    // two rows". Tailwind's `xl` starts at 1280 px. The eight cells keep their order (the case
    // above), so below it the first row is Type, Containers, Pieces and Tare each, and the second
    // is Tare total, Scale gross, Cust Cont Id and Remove.
    const html = render(open([container(), container({ id: "container-2", position: 2 })]));
    const rowClasses = [...html.matchAll(/<div class="([^"]*)"><label\b/g)].map(match => match[1].split(" "));
    expect(rowClasses).toHaveLength(2);
    for (const classes of rowClasses) {
      expect(classes).toContain("grid");
      expect(classes.filter(name => name.includes("grid-cols-"))).toEqual(["grid-cols-4", "xl:grid-cols-8"]);
      // Wrapped, a container is two lines. The space under a container is then wider than the
      // space between its own two lines (gap-2), so two containers do not read as four even lines.
      expect(classes.filter(name => /(^|:)mb-/.test(name))).toEqual(["mb-4", "xl:mb-2"]);
    }
  });

  it("keeps the names a flow finds a box by, and renames the three boxes whose meaning changed", () => {
    expect(boxes(render(open([container()]))).map(box => box.name)).toEqual([
      "Container 1 type", "Container 1 count", "Container 1 pieces", "Container 1 tare each",
      "Container 1 scale gross", "Container 1 customer container id",
    ]);
  });

  it("shows a stored row as the server holds it, with its tare total worked out", () => {
    const html = render(open([container()]));
    expect(html).toContain('<option value="basket" selected="">Steel Basket</option>');
    expect(boxes(html).slice(1).map(box => box.value)).toEqual(["3", "252", "42.5", "", "BIN-7"]);
    // 3 containers at 42.50 lb each.
    expect(tareTotals(html)).toEqual(["127.50"]);
    expect(html).not.toContain("Unsaved changes");
  });

  it("Tare total follows the row as it is typed, and is a dash while it cannot be worked out", () => {
    const editor = open([container(), container({ id: "container-2", position: 2, typeId: "skid", count: 1, pieces: 15, tareEach: null, customerContainerId: "" })]);
    expect(tareTotals(render(editor))).toEqual(["127.50", "—"]);
    // The owner's figure: 14 bins at 310 lb is 4,340 lb.
    editor.change({ kind: "edit", id: "container-1", patch: { count: "14", tareEach: "310" } });
    expect(tareTotals(render(editor))).toEqual(["4,340.00", "—"]);
    // A Containers box that is not a whole number yet shows no figure, never a wrong one.
    editor.change({ kind: "edit", id: "container-1", patch: { count: "1." } });
    expect(tareTotals(render(editor))).toEqual(["—", "—"]);
    // A typed 0 is a tare each: the total is 0.00, not a dash.
    editor.change({ kind: "edit", id: "container-2", patch: { tareEach: "0" } });
    expect(tareTotals(render(editor))).toEqual(["—", "0.00"]);
  });

  it("a row just added has the same cells, every box blank", () => {
    const editor = open([]);
    expect(render(editor)).toContain("None.");
    editor.change({ kind: "add", rows: [{ typeId: "", count: "", pieces: "", tareEach: "", scaleGross: "", customerContainerId: "", clientId: "added-1" }] });
    const html = render(editor);
    expect(cellLabels(html)).toEqual(LABELS);
    expect(boxes(html).slice(1).map(box => box.value)).toEqual(["", "", "", "", ""]);
    expect(tareTotals(html)).toEqual(["—"]);
    expect(html).toContain("Unsaved changes");
  });

  it("fills nothing when the grid loads: a stored blank shows blank though its type has a default", () => {
    // Owner ruling W4 (2026-10-09). The basket type's default is 42.5; the row has no tare each.
    const html = render(open([container({ tareEach: null })]));
    expect(boxes(html).find(box => box.name === "Container 1 tare each")?.value).toBe("");
    expect(tareTotals(html)).toEqual(["—"]);
    // And nothing can write to the grid without a person: the section runs no effect of its own.
    // The file does not write either hook's name at all: not imported, not called, not reached
    // through a namespace (`React.useEffect`), which a search for bare calls would let through.
    const written = (name: string) => all(tree, ts.isIdentifier).filter(identifier => identifier.text === name);
    expect(written("useEffect")).toHaveLength(0);
    expect(written("useLayoutEffect")).toHaveLength(0);
  });
});

describe("the saved order's Containers grid: the edit gate", () => {
  /** Each box of the row, its Remove and the Add container link, in order: what a person reads it
   *  as, whether it is closed, and its title. */
  function controls(html: string): [string, boolean, string | undefined][] {
    const tags = [
      ...(html.match(/<(?:input|select)\b[^>]*>/g) ?? []).map(tag => [tag.match(/\saria-label="([^"]*)"/)?.[1] ?? "", tag]),
      ...[...html.matchAll(/(<button\b[^>]*>)(Remove|Add container)</g)].map(match => [match[2], match[1]]),
    ];
    return tags.map(([name, tag]) => [name, /\sdisabled=""/.test(tag), tag.match(/\stitle="([^"]*)"/)?.[1]]);
  }
  const CONTROLS = [
    "Container 1 type", "Container 1 count", "Container 1 pieces", "Container 1 tare each",
    "Container 1 scale gross", "Container 1 customer container id", "Remove", "Add container",
  ];

  it("closes every box, Remove and Add container with the gate's own title, and leaves them open under an open gate", () => {
    // The page hands the section its edit gate: `orders.edit`, and the lock on a voided order.
    // This one is the gate of someone who holds no permission, built by the page's own function.
    const closed = gate([], "orders.edit");
    expect(closed).toEqual({ allowed: false, disabled: true, title: "Requires orders.edit" });
    const editor = open([container()]);
    // Open first: the same eight controls, none closed and none titled. So the recovery binding is
    // ready to edit, and what closes them below is the gate and nothing else.
    expect(controls(render(editor))).toEqual(CONTROLS.map(name => [name, false, undefined]));
    expect(controls(render(editor, closed))).toEqual(CONTROLS.map(name => [name, true, "Requires orders.edit"]));
  });

  // Save containers is handed `gridGate(editGate, grid.mode)` (#483, #487), and the boxes, Remove
  // and Add container keep `editGate` with `grid.canEdit`: #483 covers the saved shipment page, so
  // on the hub only the Save button carries the grid's beat. The two cases below pin that uneven
  // screen as the owner accepted it, under an open edit gate.

  /** Save containers' opening tag: whether it is closed, and its title. */
  function saveControl(html: string): [boolean, string | undefined] {
    const tags = [...html.matchAll(/(<button\b[^>]*>)Save containers</g)].map(match => match[1]);
    expect(tags).toHaveLength(1);
    return [/\sdisabled=""/.test(tags[0]), tags[0].match(/\stitle="([^"]*)"/)?.[1]];
  }

  it("while the grid's first read is in flight, Save containers says so in the notice's words, and Add container is closed and untitled", () => {
    const html = render(waiting([container()]));
    expect(boxes(html)).toEqual([]);
    expect(controls(html)).toEqual([["Add container", true, undefined]]);
    expect(saveControl(html)).toEqual([true, CHECKING_ACCESS]);
  });

  it("over a retained draft, Save containers names draft recovery, and the row's boxes, Remove and Add container are closed and untitled", () => {
    // The page is left with an unsaved edit and come back to: the fresh read is offered the draft.
    const editor = open([container()]);
    editor.change({ kind: "edit", id: "container-1", patch: { count: "14" } });
    editor.detach();
    editor.binding.attach("the-view-that-takes-its-place");
    const readId = editor.binding.beginRead();
    editor.binding.acceptRead({ kind: "authorized", readId, ...projectContainers(snapshot([container()])) }, emptyBulkDraft<ContainerFields>());
    expect(editor.binding.getSnapshot().mode).toBe("offer");
    const html = render(editor);
    expect(controls(html)).toEqual(CONTROLS.map(name => [name, true, undefined]));
    expect(saveControl(html)).toEqual([true, DRAFT_RECOVERY_TITLE]);
  });

  it("while its own Save is in transport, the row's boxes, Remove and Add container close, untitled, and Save containers stays open (R23, #702)", () => {
    // The store's steps for one Save containers, as the section's `save` takes them: capture, then
    // dispatched. The grid stays in editing mode, so only the save it is waiting on closes anything.
    const editor = open([container()]);
    editor.change({ kind: "edit", id: "container-1", patch: { count: "14" } });
    const submission = editor.binding.capture([], "request-1");
    expect(editor.binding.dispatched(submission)).toBe(true);
    expect(editor.binding.getSnapshot()).toMatchObject({ mode: "editing", pending: true });
    const html = render(editor);
    expect(controls(html)).toEqual(CONTROLS.map(name => [name, true, undefined]));
    expect(saveControl(html)).toEqual([false, undefined]);
    // A refused save keeps the draft, and the grid opens again over it, the 14 still in its box.
    editor.binding.settle(submission, { kind: "rejected" });
    const after = render(editor);
    expect(controls(after)).toEqual(CONTROLS.map(name => [name, false, undefined]));
    expect(boxes(after).find(box => box.name === "Container 1 count")?.value).toBe("14");
  });
});

describe("the saved order's Containers grid: a change of type", () => {
  it("the type list hands its change to changeType, and no other control does", () => {
    const selects = jsxTags(FILE).filter(tag => tag.name === "select");
    expect(selects).toHaveLength(1);
    expect(selects[0].attr("onChange")).toBe("(e) => changeType(row, e.target.value)");
    expect(jsxTags(FILE).filter(tag => tag.attr("onChange")?.includes("changeType"))).toHaveLength(1);
  });

  it("a row that followed its type keeps following: the type and the new default go in one edit", () => {
    // Owner ruling W3: the figure still equals the old type's default, so it is replaced.
    const { grid, changeType } = recording();
    changeType(saved(), "gaylord");
    expect(grid.updateExisting.mock.calls).toStrictEqual([["container-1", { typeId: "gaylord", tareEach: "60" }]]);
    expect(grid.updateAdded).not.toHaveBeenCalled();
  });

  it("a figure someone typed stays: the edit carries the type alone", () => {
    // W3: 44 is not the basket's 42.5.
    const { grid, changeType } = recording();
    changeType(saved({ tareEach: "44" }), "gaylord");
    expect(grid.updateExisting.mock.calls).toStrictEqual([["container-1", { typeId: "gaylord" }]]);
  });

  it("a blank box takes the default of the type picked, and stays blank when that type has none", () => {
    // W4, and the design's §9.9, point 4: "picks the type again" is a change of type.
    const { grid, changeType } = recording();
    changeType(saved({ tareEach: "" }), "gaylord");
    changeType(saved({ tareEach: "" }), "skid");
    expect(grid.updateExisting.mock.calls).toStrictEqual([
      ["container-1", { typeId: "gaylord", tareEach: "60" }],
      ["container-1", { typeId: "skid" }],
    ]);
  });

  it("a row that followed its type is cleared when the new type has no default", () => {
    // The design's §9.9, point 3.
    const { grid, changeType } = recording();
    changeType(saved(), "skid");
    expect(grid.updateExisting.mock.calls).toStrictEqual([["container-1", { typeId: "skid", tareEach: "" }]]);
  });

  it("a row set back to no type is cleared when its figure followed the type, and keeps any other figure", () => {
    // The design's §9.4: no type is a type with no default (§9.9, point 3).
    const { grid, changeType } = recording();
    changeType(saved(), "");
    changeType(saved({ tareEach: "44" }), "");
    changeType(saved({ tareEach: "" }), "");
    expect(grid.updateExisting.mock.calls).toStrictEqual([
      ["container-1", { typeId: "", tareEach: "" }],
      ["container-1", { typeId: "" }],
      ["container-1", { typeId: "" }],
    ]);
  });

  it("a row just added follows the same rule, through the added row's own edit", () => {
    // The design's §9.9, point 21.
    const { grid, changeType } = recording();
    changeType(added({ typeId: "", tareEach: "" }), "basket");
    changeType(added(), "gaylord");
    expect(grid.updateAdded.mock.calls).toStrictEqual([
      ["added-1", { typeId: "basket", tareEach: "42.5" }],
      ["added-1", { typeId: "gaylord", tareEach: "60" }],
    ]);
    expect(grid.updateExisting).not.toHaveBeenCalled();
  });

  it("away and back leaves a saved row as the server holds it, so the section reads clean", () => {
    // Through the grid's real reducer, which drops an edit equal to the saved row. It holds only
    // because a default is written into the box as the grid writes a stored figure ("42.5").
    const editor = open([container()]);
    const { changeType } = typeListIn(editor);
    changeType(composed(editor)[0], "gaylord");
    expect(composed(editor)[0]).toMatchObject({ typeId: "gaylord", tareEach: "60" });
    expect(render(editor)).toContain("Unsaved changes");
    changeType(composed(editor)[0], "basket");
    expect(composed(editor)[0]).toMatchObject({ typeId: "basket", tareEach: "42.5" });
    expect(editor.binding.getSnapshot().current!.data.edits.size).toBe(0);
    expect(render(editor)).not.toContain("Unsaved changes");
  });

  it("picking the type again fills a stored blank, and leaves it for Save containers", () => {
    // W4 with the design's §9.9, point 4: a list fires nothing when the type it shows is picked,
    // so "again" is to another type and back. The default then sits in the box as unsaved work.
    const editor = open([container({ tareEach: null })]);
    const { changeType } = typeListIn(editor);
    changeType(composed(editor)[0], "skid");
    expect(composed(editor)[0]).toMatchObject({ typeId: "skid", tareEach: "" });
    changeType(composed(editor)[0], "basket");
    expect(composed(editor)[0]).toMatchObject({ typeId: "basket", tareEach: "42.5" });
    expect(editor.binding.getSnapshot().current!.data.edits.get("container-1")).toStrictEqual({ tareEach: "42.5" });
  });
});

describe("the saved order's Containers grid: one visit to the Type list", () => {
  // A closed list fires a change for every option a keyboard user passes with the arrow keys. Each
  // case below is one of the review's findings on the rule run step by step, or a part of the
  // visit that keeps it from happening (the design's §9.10). TYPES: Steel Basket 42.5, Cardboard
  // Gaylord 60, Skid none.
  const second = (over: Partial<OrderContainer> = {}) => container({ id: "container-2", position: 2, ...over });
  /** The row's type and its Tare each box, as the grid draws them now. */
  const shown = (list: { row: () => Row }) => ({ typeId: list.row().typeId, tareEach: list.row().tareEach });

  it("the type list starts a visit when it takes focus and ends it when it loses focus, and nothing else does", () => {
    const [select] = jsxTags(FILE).filter(tag => tag.name === "select");
    expect(select.attr("onFocus")).toBe("() => startTypeVisit(row)");
    expect(select.attr("onBlur")).toBe("endTypeVisit");
    const written = (name: string) => all(tree, ts.isIdentifier).filter(identifier => identifier.text === name);
    // Each name is written twice: where it is declared, and on the list.
    expect(written("startTypeVisit")).toHaveLength(2);
    expect(written("endTypeVisit")).toHaveLength(2);
  });

  it("keeps the visit in a ref, so it outlives the render each step causes", () => {
    // Every step of a visit changes the draft, and the section is drawn again before the next one.
    // A plain object made in the component's body would be a new, empty one each time.
    const declared = all(tree, ts.isVariableDeclaration).filter(declaration => declaration.name.getText(tree) === "typeVisit");
    expect(declared).toHaveLength(1);
    const made = declared[0].initializer;
    expect(made !== undefined && ts.isCallExpression(made) ? made.expression.getText(tree) : made?.getText(tree)).toBe("useRef");
    expect(made !== undefined && ts.isCallExpression(made) ? made.arguments.map(argument => argument.getText(tree)) : []).toEqual(["null"]);
  });

  it("a visit holds the row's key, type and Tare each as they stood at focus, and nothing once the list is left", () => {
    const { typeVisit, startTypeVisit, endTypeVisit } = recording();
    expect(typeVisit.current).toBeNull();
    startTypeVisit(saved({ typeId: "skid", tareEach: "42.50", count: "7", pieces: "9" }));
    expect(typeVisit.current).toStrictEqual({ key: "container-1", typeId: "skid", tareEach: "42.50" });
    endTypeVisit();
    expect(typeVisit.current).toBeNull();
  });

  it.each<[string, Partial<OrderContainer>, string[], { typeId: string; tareEach: string }]>([
    // One pick from Skid to Cardboard Gaylord keeps a typed 42.5 (W3: Skid has no default). Step by
    // step the figure met Steel Basket's default on the way and was replaced at the next step.
    ["from a type with no default", { typeId: "skid" }, ["basket", "gaylord"], { typeId: "gaylord", tareEach: "42.5" }],
    // One pick from Cardboard Gaylord to Skid keeps a typed 42.5 (W3: it is not the gaylord's 60).
    // Step by step it was emptied at Skid.
    ["from a type with another default", { typeId: "gaylord" }, ["basket", "skid"], { typeId: "skid", tareEach: "42.5" }],
  ])("a typed figure that equals the default of a type only passed through stays, %s", (_from, start, through, end) => {
    const list = typeListIn(open([container({ tareEach: 42.5, ...start })]));
    list.focus();
    list.step(...through);
    expect(shown(list)).toEqual(end);
  });

  it("a blank box stepped through a type that has a default, to a type that has none, ends blank as it started", () => {
    // W4: a blank box takes the default of the type picked. The type picked here is Skid, which
    // has none. The 42.5 that the step over Steel Basket wrote must not stay on a skid.
    const editor = open([container({ typeId: "gaylord", tareEach: null })]);
    const list = typeListIn(editor);
    list.focus();
    list.step("basket");
    expect(shown(list)).toEqual({ typeId: "basket", tareEach: "42.5" });
    list.step("skid");
    expect(shown(list)).toEqual({ typeId: "skid", tareEach: "" });
    // The box holds the server's own blank again, so the type is the row's one unsaved change.
    expect(editor.binding.getSnapshot().current!.data.edits.get("container-1")).toStrictEqual({ typeId: "skid" });
  });

  it("stepping away and back in one visit ends with the figure it started with, and the section reads clean", () => {
    // A typed 42.5 on a skid, stepped to Steel Basket and back. Step by step the figure counted as
    // the basket's own on the way back and was emptied.
    const editor = open([container({ typeId: "skid", tareEach: 42.5 })]);
    const list = typeListIn(editor);
    list.focus();
    list.step("basket", "skid");
    expect(shown(list)).toEqual({ typeId: "skid", tareEach: "42.5" });
    expect(editor.binding.getSnapshot().current!.data.edits.size).toBe(0);
    expect(render(editor)).not.toContain("Unsaved changes");
    // A row that followed its type comes back to it too, as it does over two visits.
    const followed = typeListIn(open([container()]));
    followed.focus();
    followed.step("gaylord", "basket");
    expect(shown(followed)).toEqual({ typeId: "basket", tareEach: "42.5" });
  });

  it("a stored blank still fills when its type is stepped away from and back in one visit", () => {
    // W4 with the design's §9.9, point 4: "picks the type again" is away and back, in one visit
    // to the list or in two.
    const list = typeListIn(open([container({ typeId: "gaylord", tareEach: null })]));
    list.focus();
    list.step("basket", "gaylord");
    expect(shown(list)).toEqual({ typeId: "gaylord", tareEach: "60" });
  });

  it("a row that followed its type and is stepped through two others ends with the last one's default, or empty when it has none", () => {
    // W3 and the design's §9.9, point 3, as one pick from Steel Basket gives them.
    const toSkid = typeListIn(open([container()]));
    toSkid.focus();
    toSkid.step("gaylord", "skid");
    expect(shown(toSkid)).toEqual({ typeId: "skid", tareEach: "" });
    const toGaylord = typeListIn(open([container()]));
    toGaylord.focus();
    toGaylord.step("skid", "gaylord");
    expect(shown(toGaylord)).toEqual({ typeId: "gaylord", tareEach: "60" });
  });

  it.each<[string, Partial<ContainerFields>, string, Partial<ContainerFields>]>([
    ["a row that followed its type", {}, "gaylord", { typeId: "gaylord", tareEach: "60" }],
    ["a typed figure", { tareEach: "44" }, "gaylord", { typeId: "gaylord" }],
    ["a blank box, to a type that has a default", { tareEach: "" }, "gaylord", { typeId: "gaylord", tareEach: "60" }],
    ["a blank box, to a type that has none", { tareEach: "" }, "skid", { typeId: "skid" }],
    ["a row that followed its type, to a type that has none", {}, "skid", { typeId: "skid", tareEach: "" }],
    ["a typed figure, back to no type", { tareEach: "44" }, "", { typeId: "" }],
    ["text that is not a figure", { tareEach: "4x" }, "gaylord", { typeId: "gaylord" }],
  ])("one pick is one visit with one change, and makes the edit it made before: %s", (_what, start, next, edit) => {
    // A mouse pick: the list takes focus, and one change follows. The edit is the one the same
    // change makes outside any visit, key for key.
    const inVisit = recording();
    inVisit.startTypeVisit(saved(start));
    inVisit.changeType(saved(start), next);
    expect(inVisit.grid.updateExisting.mock.calls).toStrictEqual([["container-1", edit]]);
    const outside = recording();
    outside.changeType(saved(start), next);
    expect(outside.grid.updateExisting.mock.calls).toStrictEqual([["container-1", edit]]);
  });

  it("leaving the list and coming back starts a new visit", () => {
    // W3 as the design's §9.4 has it: a typed figure that equals the default of the type the row
    // was moved to follows that type when the row is moved again. "Again" is a later visit.
    const list = typeListIn(open([container({ typeId: "skid", tareEach: 42.5 })]));
    list.focus();
    list.step("basket");
    expect(shown(list)).toEqual({ typeId: "basket", tareEach: "42.5" });
    list.blur();
    // Nothing of the first visit is left to judge a later change against.
    expect(list.typeVisit.current).toBeNull();
    list.focus();
    expect(list.typeVisit.current).toStrictEqual({ key: "container-1", typeId: "basket", tareEach: "42.5" });
    list.step("gaylord");
    expect(shown(list)).toEqual({ typeId: "gaylord", tareEach: "60" });
  });

  it("a change that arrives after the list was left is judged against the row as it stands", () => {
    // No browser sends a change to a list that has not taken focus. If one did, the visit that
    // ended must not judge it.
    const list = typeListIn(open([container({ typeId: "skid", tareEach: 42.5 })]));
    list.focus();
    list.step("basket");
    list.blur();
    list.step("gaylord");
    expect(shown(list)).toEqual({ typeId: "gaylord", tareEach: "60" });
  });

  it("taking focus again starts a new visit, though the list never said it lost focus", () => {
    // Not every loss of focus is reported: a control that is closed while it has the cursor may
    // get no blur, and every box here closes with the edit gate. So a focus never trusts that the
    // last visit ended.
    const list = typeListIn(open([container({ typeId: "skid", tareEach: 42.5 })]));
    list.focus();
    list.step("basket");
    list.focus();
    list.step("gaylord");
    expect(shown(list)).toEqual({ typeId: "gaylord", tareEach: "60" });
  });

  it("two rows do not share a visit: a change on another row is judged against that row", () => {
    // One ref serves every row's list. The first row's visit is open when the second row changes.
    const editor = open([container({ typeId: "skid", tareEach: 42.5 }), second()]);
    const list = typeListIn(editor);
    list.focus();
    expect(list.typeVisit.current).toStrictEqual({ key: "container-1", typeId: "skid", tareEach: "42.5" });
    list.changeType(composed(editor)[1], "gaylord");
    // The second row followed Steel Basket, so it takes the gaylord's 60. Judged against the first
    // row's visit it would have kept 42.5, as a figure typed on a skid does.
    expect(composed(editor)[1]).toMatchObject({ typeId: "gaylord", tareEach: "60" });
    expect(composed(editor)[0]).toMatchObject({ typeId: "skid", tareEach: "42.5" });
  });
});

describe("the saved order's Containers grid: Save containers", () => {
  /** The section's own `save` over these rows. The request is answered at once with an order. */
  function saver(rows: Row[], answer: () => unknown = () => snapshot([container()]).order) {
    const onError = vi.fn<(message: string | null) => void>();
    const requests: { url: string; init: { method: string; body: string } }[] = [];
    const baseline = projectContainers(snapshot([container()])).baseline;
    const binding = { capture: vi.fn(() => ({ submitted: { baseline } })), dispatched: () => true, settle: vi.fn() };
    const save = actual<() => Promise<void>>("save", {
      rows, onError, grid: { binding, canEdit: true }, editGate: OPEN, newId: () => "request-1",
      applyMutation: async (mutation: () => Promise<unknown>) => { await mutation(); },
      api: async (url: string, init: { method: string; body: string }) => { requests.push({ url, init }); return answer(); },
      ApiError, orderId: "order-1", projectContainers, orderAckSnapshot, decimalRefusal, TARE_EACH, SCALE_GROSS,
    });
    return { save, onError, requests, binding };
  }

  it("sends each row's six keys, and a kept row's id: numbers for Containers and Pieces, text for the two weights, null for a blank figure", async () => {
    const { save, onError, requests, binding } = saver([
      saved({ customerContainerId: "BIN-7" }),
      added({ typeId: "skid", count: " 1 ", pieces: "", tareEach: " ", scaleGross: " 612.50 " }),
    ]);
    await save();
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/api/orders/order-1/containers");
    expect(requests[0].init.method).toBe("PUT");
    // Strict: no old key, and Tare total is never sent. A kept row names itself by its server id
    // (#493); an added row has none, and so is created.
    expect(JSON.parse(requests[0].init.body)).toStrictEqual([
      { id: "container-1", typeId: "basket", count: 3, pieces: 252, tareEach: "42.5", scaleGross: null, customerContainerId: "BIN-7" },
      { typeId: "skid", count: 1, pieces: null, tareEach: null, scaleGross: "612.50", customerContainerId: "" },
    ]);
    expect(onError.mock.calls).toEqual([[null]]);
    expect(binding.settle).toHaveBeenCalledOnce();
    expect(binding.settle.mock.calls[0][1]).toMatchObject({ kind: "persisted" });
  });

  it("a refusal of a stale row (409) reaches the page in the server's sentence, settles the draft rejected and leaves it as typed", async () => {
    const sentence = "The containers changed since this page loaded. Reload, then save again.";
    const { save, onError, binding } = saver([saved({ count: "14" })], () => { throw new ApiError(sentence, 409); });
    await save();
    expect(onError.mock.calls).toEqual([[sentence]]);
    expect(binding.settle).toHaveBeenCalledOnce();
    expect(binding.settle.mock.calls[0][1]).toStrictEqual({ kind: "rejected" });
  });

  it.each<[string, Partial<ContainerFields>, string]>([
    ["a row with no type", { typeId: "" }, "Container 1: pick a type."],
    ["a blank Containers box", { count: "" }, "Container 1: Containers must be a whole number of at least 1."],
    ["Containers of 0", { count: "0" }, "Container 1: Containers must be a whole number of at least 1."],
    ["Containers of 1.5", { count: "1.5" }, "Container 1: Containers must be a whole number of at least 1."],
    ["Pieces of 0", { pieces: "0" }, "Container 1: Pieces must be a whole number of at least 1."],
    ["Pieces of 12.5", { pieces: "12.5" }, "Container 1: Pieces must be a whole number of at least 1."],
    ["a negative Tare each", { tareEach: "-1" }, "Container 1, Tare each (lb): cannot be negative."],
    ["a negative Scale gross", { scaleGross: "-0.01" }, "Container 1, Scale gross (lb): cannot be negative."],
    // The one rule's sentences (decimal entry design §1.2): text that is not a number, too many
    // decimals and too large each get their own, named by the row and the box's label.
    ["Tare each that is not a number", { tareEach: "abc" }, "Container 1, Tare each (lb): enter a number without $ or commas, such as 0.36."],
    ["Scale gross that is not a number", { scaleGross: "abc" }, "Container 1, Scale gross (lb): enter a number without $ or commas, such as 0.36."],
    ["Tare each with three decimals", { tareEach: "1.005" }, "Container 1, Tare each (lb): use at most 2 digits after the point."],
    ["Scale gross past the column", { scaleGross: "10000000000" }, "Container 1, Scale gross (lb): must be less than 10,000,000,000."],
  ])("refuses %s before any request, in the design's words", async (what, over, sentence) => {
    const { save, onError, requests, binding } = saver([saved(over)]);
    await save();
    expect(onError.mock.calls, what).toEqual([[sentence]]);
    expect(requests).toEqual([]);
    expect(binding.capture).not.toHaveBeenCalled();
  });

  it("names the row a refusal is about by its place in the grid", async () => {
    const { save, onError } = saver([saved(), added({ pieces: "x" })]);
    await save();
    expect(onError.mock.calls).toEqual([["Container 2: Pieces must be a whole number of at least 1."]]);
  });

  it("lists every refusal of every row at once, each row's checks in field order, and sends nothing", async () => {
    const { save, onError, requests, binding } = saver([
      saved({ typeId: "", count: "0", pieces: "x", tareEach: "-1", scaleGross: "1.234" }),
      added({ tareEach: "abc", scaleGross: "-2" }),
      { ...saved(), key: "container-3" },
    ]);
    await save();
    expect(onError.mock.calls).toEqual([[[
      "Container 1: pick a type.",
      "Container 1: Containers must be a whole number of at least 1.",
      "Container 1: Pieces must be a whole number of at least 1.",
      "Container 1, Tare each (lb): cannot be negative.",
      "Container 1, Scale gross (lb): use at most 2 digits after the point.",
      "Container 2, Tare each (lb): enter a number without $ or commas, such as 0.36.",
      "Container 2, Scale gross (lb): cannot be negative.",
    ].join("\n")]]);
    expect(requests).toEqual([]);
    expect(binding.capture).not.toHaveBeenCalled();
  });
});

describe("the saved order's Containers grid: the order totals above the rows", () => {
  // The weights design §10.2; owner rulings W9 and P5 (2026-10-09). Every cell and sentence is the
  // totals leaf's, and order-totals.test.ts holds each by value. This block holds what the section
  // adds: where the table is drawn, which lines and rows it is handed, and when it is tagged.
  const PAGE = "src/app/orders/[id]/page.tsx";
  /** Order 1004 as saved: 250 pieces and 1,600.00 lb, in 3 baskets that hold 252 pieces, at 42.50 lb each. */
  const SAVED = {
    Parts: ["250", "1,600.00", "", ""], Containers: ["252", "", "127.50", ""], Order: ["", "1,600.00", "127.50", "1,727.50"],
  };
  const AS_SAVED = { tag: null, rows: SAVED, note: null, weighed: [] };
  const squeezed = (text: string) => text.replace(/\s+/g, "");

  it("draws the table once, directly under the heading and above the notices and the rows, under no condition", () => {
    // In the source: one mount with nothing written round it, between the heading and the notice.
    expect(renderedFrom(FILE, "OrderTotalsTable").map(squeezed)).toEqual([
      "<OrderTotalsTabletotals={orderTotals(savedOrderTotalsInput(lines,totalsRows))}unsaved={grid.dirty}/>",
    ]);
    const names = jsxTags(FILE).map(tag => tag.name);
    const at = names.indexOf("OrderTotalsTable");
    expect(names.slice(at - 1, at + 2)).toEqual(["h2", "OrderTotalsTable", "DraftRecoveryNotice"]);
    // In the markup: the table's root is the element after the heading, with rows and with none.
    for (const html of [render(open([container()])), render(open([]))]) {
      expect(html).toMatch(/<h2\b[^>]*>Containers<\/h2><div\b[^>]*\bdata-order-totals\b/);
    }
  });

  it("adds up the saved lines it is handed and the grid's rows, and shows on an order with no container rows, above None.", () => {
    expect(totalsShown(render(open([container()])))).toEqual(AS_SAVED);
    // The edit gate closes the boxes and not the table.
    expect(totalsShown(render(open([container()]), gate([], "orders.edit")))).toEqual(AS_SAVED);
    const empty = render(open([]));
    expect(totalsShown(empty)).toEqual({
      tag: null, note: null, weighed: [],
      rows: { Parts: SAVED.Parts, Containers: ["Not entered", "", "Not entered", ""], Order: ["", "1,600.00", "Not entered", "Not available"] },
    });
    expect(empty.indexOf(">None.</p>")).toBeGreaterThan(empty.indexOf("</table>"));
  });

  it("follows the grid's rows as they are typed, tagged Unsaved totals, and returns to the saved figures on Discard", () => {
    const editor = open([container()]);
    // The owner's figure: 14 bins at 310 lb is 4,340.00 lb. The `containers` prop still holds 3 at 42.50.
    editor.change({ kind: "edit", id: "container-1", patch: { count: "14", tareEach: "310" } });
    expect(totalsShown(render(editor))).toEqual({
      tag: "Unsaved totals", note: null, weighed: [],
      rows: { Parts: SAVED.Parts, Containers: ["252", "", "4,340.00", ""], Order: ["", "1,600.00", "4,340.00", "5,940.00"] },
    });
    // Back to 3 at 42.50, and on a scale at 1,740.00 lb: order 1004's two weighed lines.
    editor.change({ kind: "edit", id: "container-1", patch: { count: "3", tareEach: "42.5", scaleGross: "1740" } });
    expect(totalsShown(render(editor))).toEqual({
      tag: "Unsaved totals", rows: SAVED, note: null,
      weighed: ["Weighed net 1,612.50 lb · 12.50 lb over", "Implied pieces 252 · 2 over"],
    });
    // A row just added counts at once: it has no Pieces, no Tare each and no Scale gross.
    editor.change({ kind: "add", rows: [{ typeId: "", count: "", pieces: "", tareEach: "", scaleGross: "", customerContainerId: "", clientId: "added-1" }] });
    expect(totalsShown(render(editor))).toEqual({
      tag: "Unsaved totals", note: "1 row has no Pieces · 1 row has no Tare each",
      weighed: ["Weighed net not available · 1 row has no Scale gross"],
      rows: { Parts: SAVED.Parts, Containers: ["252", "", "Incomplete", ""], Order: ["", "1,600.00", "Incomplete", "Not available"] },
    });
    // Discard is the grid's own reset, which discards the binding's current draft by its stamp.
    editor.binding.discard(editor.binding.getSnapshot().current!.stamp);
    expect(totalsShown(render(editor))).toEqual(AS_SAVED);
  });

  it("is handed the page's saved rows while the grid has none of its own: before its read lands, and when that read fails", () => {
    // The design's §10.7, point 7. In both states the grid draws no row and reads None., and an
    // order that has containers must not read Not entered above it.
    const failed = open([container()]);
    failed.binding.acceptRead({ kind: "unavailable", readId: failed.binding.beginRead() }, emptyBulkDraft<ContainerFields>());
    for (const editor of [waiting([container()]), failed]) {
      expect(editor.binding.getSnapshot().savedBaseline).toBeUndefined();
      const html = render(editor);
      expect(boxes(html)).toEqual([]);
      expect(html).toContain(">None.</p>");
      expect(totalsShown(html)).toEqual(AS_SAVED);
    }
  });

  it("is handed the page's rows again while the grid reads after its own save, though they can be the rows from before that save", () => {
    // The store's own steps for one Save containers, in the order the section's `save` and
    // useBulkGrid take them: capture, dispatched, settle as persisted, and then the read the hook
    // begins when a settled view owes one and has nothing submitted (src/lib/bulk-grid.ts). The
    // save here turns order 1004's 3 baskets at 42.50 lb into the owner's 14 bins at 310 lb. The
    // row keeps its id: a save updates it in place (#493).
    const before = [container()];
    const after = [container({ count: 14, tareEach: 310 })];
    const editor = open(before);
    editor.change({ kind: "edit", id: "container-1", patch: { count: "14", tareEach: "310" } });
    const submission = editor.binding.capture([], "request-1");
    expect(editor.binding.dispatched(submission)).toBe(true);
    editor.binding.settle(submission, { kind: "persisted", response: projectContainers(snapshot(after)).baseline });
    // Settled: the draft's baseline is the save's answer, so the table adds up the saved rows,
    // untagged. The view owes a read and has nothing submitted.
    const settled = editor.binding.getSnapshot();
    expect([settled.mode, settled.needsRefresh, settled.submitted]).toEqual(["editing", true, undefined]);
    const asSent = {
      tag: null, note: null, weighed: [],
      rows: { Parts: SAVED.Parts, Containers: ["252", "", "4,340.00", ""], Order: ["", "1,600.00", "4,340.00", "5,940.00"] },
    };
    expect(totalsShown(render(editor))).toEqual(asSent);
    // The read begins, and until it lands the grid has no baseline: it draws no row and reads None.
    editor.binding.beginRead();
    const reading = editor.binding.getSnapshot();
    expect([reading.mode, reading.current, reading.savedBaseline]).toEqual(["loading", undefined, undefined]);
    // `editor.containers` is still the rows from before the save, and the table adds those up.
    const html = render(editor);
    expect(boxes(html)).toEqual([]);
    expect(html).toContain(">None.</p>");
    expect(totalsShown(html)).toEqual(AS_SAVED);
    // The same view once the page holds the saved rows: the table adds those up.
    expect(totalsShown(render({ binding: editor.binding, containers: after }))).toEqual(asSent);
  });

  it("is handed the grid's rows while the view is editing, by the draft's own baseline and not by the view's saved one", () => {
    // While the view is editing, useBulkGrid draws its rows from the draft's baseline
    // (src/lib/bulk-grid.ts), and the section's `baseline` must read that field too. The view the
    // store answers here carries a saved baseline as well, the same object, so it cannot tell the
    // two fields apart. It is drawn a second time with its saved baseline taken off by hand: the
    // grid still draws the draft's rows, and the table must add up those and not the page's.
    //
    // That second view is hand-built. The draft store publishes no editing view without a saved
    // baseline: `emit` (src/lib/draft-store.ts) gives every view of an editable read that read's
    // baseline as its saved one unless the store has failed, and a failed store's mode is "error".
    // So this case holds the section's expression to the hook's, and not a state an operator can
    // reach.
    const editor = open([container()]);
    editor.change({ kind: "edit", id: "container-1", patch: { count: "14", tareEach: "310" } });
    const view = editor.binding.getSnapshot();
    expect(view.mode).toBe("editing");
    expect(view.savedBaseline).toBe(view.current!.baseline);
    const typed = {
      tag: "Unsaved totals", note: null, weighed: [],
      rows: { Parts: SAVED.Parts, Containers: ["252", "", "4,340.00", ""], Order: ["", "1,600.00", "4,340.00", "5,940.00"] },
    };
    expect(totalsShown(render(editor))).toEqual(typed);
    const html = render({
      containers: editor.containers,
      binding: { ...editor.binding, getSnapshot: () => ({ ...view, savedBaseline: undefined }) },
    });
    expect(boxes(html).slice(1, 4).map(box => box.value)).toEqual(["14", "252", "310"]);
    expect(totalsShown(html)).toEqual(typed);
  });

  it("is handed the grid's rows while the view is not editing, by the saved baseline of its own read, though the page holds other rows", () => {
    // A voided order's read is authorized and not editable. The view is then not editing: it
    // carries the read as its saved baseline and no draft, and the grid draws the read's rows.
    // The page here holds an order with no container row, so the two sets of rows differ: a
    // grid's read can be newer than the page's order (the design's §10.7, point 9).
    const base = snapshot([container()]);
    const read = projectContainers({ ...base, order: { ...base.order, voided: true } });
    expect(read.editable).toBe(false);
    const closed = waiting([]);
    closed.binding.acceptRead({ kind: "authorized", readId: closed.binding.beginRead(), ...read }, emptyBulkDraft<ContainerFields>());
    const view = closed.binding.getSnapshot();
    expect(view.mode).not.toBe("editing");
    expect(view.current).toBeUndefined();
    expect(view.savedBaseline).toBe(read.baseline);
    const html = render(closed);
    expect(boxes(html).slice(1).map(box => box.value)).toEqual(["3", "252", "42.5", "", "BIN-7"]);
    expect(totalsShown(html)).toEqual(AS_SAVED);
  });

  it("adds up the saved rows, untagged, while a kept draft is only offered, and the draft's rows, tagged, once it is restored", () => {
    // The design's §10.2. An unsaved edit outlives its view. The view that takes its place accepts
    // a read of its own and is offered the kept draft. useBulkGrid reads a draft's unsaved edits
    // only while the view is editing (src/lib/bulk-grid.ts), so until Restore the grid draws the
    // read's rows with nothing unsaved over them.
    const editor = open([container()]);
    editor.change({ kind: "edit", id: "container-1", patch: { count: "14", tareEach: "310" } });
    const typed = totalsShown(render(editor));
    expect(typed.tag).toBe("Unsaved totals");
    expect(typed.rows.Order).toEqual(["", "1,600.00", "4,340.00", "5,940.00"]);
    editor.detach();
    editor.binding.attach("the-view-that-takes-its-place");
    const readId = editor.binding.beginRead();
    editor.binding.acceptRead({ kind: "authorized", readId, ...projectContainers(snapshot([container()])) }, emptyBulkDraft<ContainerFields>());
    const offered = editor.binding.getSnapshot();
    expect(offered.mode).toBe("offer");
    const html = render(editor);
    expect(boxes(html).slice(1, 4).map(box => box.value)).toEqual(["3", "252", "42.5"]);
    expect(totalsShown(html)).toEqual(AS_SAVED);
    // Restore makes the kept draft the grid's own again: the table as it read before the view went.
    expect(editor.binding.restore(offered.current!.stamp, readId)).toBe(true);
    expect(totalsShown(render(editor))).toEqual(typed);
  });

  it("the page hands the section the saved order's lines", () => {
    const mounts = jsxTags(PAGE).filter(tag => tag.name === "ContainersSection");
    expect(mounts).toHaveLength(1);
    expect(mounts[0].attr("lines")).toBe("order.lines");
    expect(mounts[0].attr("containers")).toBe("order.containers");
  });

  it("keeps the lines out of the grid's recovery context: a line save sets no Containers draft aside", () => {
    const before = snapshot([container()]);
    const after: OrderBulkSnapshot = { ...before, order: { ...before.order,
      lines: before.order.lines.map(line => ({ ...line, qty: line.qty + 5, weight: line.weight + 10 })) } };
    const adapter = createBulkRecoveryAdapter<ContainerFields>("order-containers", "order-containers-v2");
    expect(adapter.baselineEqual(projectContainers(before).baseline, projectContainers(after).baseline)).toBe(true);
    // The same comparison does see a change that is the grid's own.
    expect(adapter.baselineEqual(projectContainers(before).baseline, projectContainers(snapshot([container({ count: 4 })])).baseline)).toBe(false);
  });
});

// ---- #743: Print tags ----

describe("the saved order's Containers grid: Print tags", () => {
  /** The Print tags control as rendered: a link with its address, or a closed span with its title. */
  function printTags(html: string): { link?: string; closedTitle?: string } {
    const link = html.match(/<a\b([^>]*)>Print tags<\/a>/);
    if (link) return { link: link[1].match(/\shref="([^"]*)"/)?.[1] };
    const span = html.match(/<span\b([^>]*)>Print tags<\/span>/);
    expect(span, "Print tags must be a link or a closed span").toBeTruthy();
    expect(span![1]).toContain('aria-disabled="true"');
    return { closedTitle: span![1].match(/\stitle="([^"]*)"/)?.[1] };
  }

  it("is a plain same-tab link to the order's tags route on a saved order with rows: a download, the ExportLink shape", () => {
    const html = render(open([container()]));
    expect(printTags(html)).toEqual({ link: "/api/orders/order-1/container-tags" });
    const tag = html.match(/<a\b[^>]*>Print tags<\/a>/)![0];
    // No new tab and no handler: the route answers an attachment and stores nothing, so the page
    // stays where it is, nothing here is in flight to track and no popup result to report.
    expect(tag).not.toContain("target=");
    expect(tag).not.toContain("onClick");
  });

  it("is closed with the gate's own title on a voided order, and under a view gate that refuses", () => {
    expect(printTags(render(open([container()]), OPEN, { voided: true }))).toEqual({ closedTitle: TAGS_VOIDED_TITLE });
    const noView = gate([], "orders.view");
    expect(printTags(render(open([container()]), OPEN, { viewGate: noView }))).toEqual({ closedTitle: noView.title });
  });

  it("is closed while a section the tag prints from holds unsaved work, and open while only Serials, Charges or Loads do", () => {
    retain("Loads"); retain("Serials"); retain("Charges");
    expect(printTags(render(open([container()])))).toEqual({ link: "/api/orders/order-1/container-tags" });
    retain("Containers");
    expect(printTags(render(open([container()])))).toEqual({ closedTitle: TAGS_UNSAVED_TITLE });
  });

  it("is closed while a Lines box reads Not saved: a quantity is on the tag", () => {
    retain("Lines");
    expect(printTags(render(open([container()])))).toEqual({ closedTitle: TAGS_UNSAVED_TITLE });
  });

  it("is closed on an order with no saved container row, by the rows the page holds, not the grid's", () => {
    expect(printTags(render(open([])))).toEqual({ closedTitle: TAGS_NO_ROWS_TITLE });
  });

  it("does not open the edit gate: a viewer who cannot edit can still print tags", () => {
    expect(printTags(render(open([container()]), gate([], "orders.edit")))).toEqual({ link: "/api/orders/order-1/container-tags" });
  });
});
