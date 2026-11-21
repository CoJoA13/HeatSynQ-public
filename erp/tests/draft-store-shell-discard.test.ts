import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createBulkRecoveryAdapter, emptyBulkDraft, transitionBulkDraft } from "../src/lib/bulk-grid-recovery";
import { createDraftStore, type EditorView } from "../src/lib/draft-store";
import { newShipmentBaselineFrom, newShipmentDraftFrom, newShipmentRecoveryAdapter, runNewShipmentRead,
  type NewShipmentReadRequirements, type NewShipmentSource, type ShipmentBody, type ShipmentSeed } from "../src/lib/new-shipment-recovery";
import { projectLoads } from "../src/lib/order-bulk-recovery";
import { orderBulkFixture } from "./helpers/order-bulk-fixture";

// #441 (owner ruling 2026-10-05: store-level test, no production change). The Shell's "Drafts in
// this tab" panel discards a row with `store.discard(row.stamps)` (DraftsInTab.tsx), outside the
// editor that owns the draft. These cases pin what that leaves the order Loads editor showing.
type Fields = { loadNumber: string; qty: string; weight: string };
const adapter = createBulkRecoveryAdapter<Fields>("order-loads", "order-loads-v1");
const clean = () => emptyBulkDraft<Fields>();
const baseline = projectLoads(orderBulkFixture()).baseline;

/** An order Loads editor with one unsaved weight, left and come back to under a new lease. */
function returned() {
  const store = createDraftStore();
  const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
  const binding = store.bind(
    { owner, record: { kind: "order", id: "order-1" }, editor: adapter.kind }, { label: "Loads", href: "/orders/order-1" }, adapter);
  const detach = binding.attach("first-view");
  binding.acceptRead({ kind: "authorized", readId: binding.beginRead(), baseline, editable: true }, clean());
  binding.change(d => transitionBulkDraft(d, baseline, { kind: "edit", id: "load-1", patch: { weight: "1905" } }));
  detach();
  binding.attach("return");
  return { store, binding };
}

describe("discarding an order Loads draft from the Shell's drafts panel (#441)", () => {
  it("from an offered draft, lands the editor in clean editing with nothing left to restore", () => {
    const { store, binding } = returned();
    const readId = binding.beginRead();
    expect(binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean())).toBe(true);
    const offered = binding.getSnapshot();
    expect(offered.mode).toBe("offer");
    expect(offered.canRestore).toBe(true);
    expect(offered.current!.data.edits.get("load-1")).toEqual({ weight: "1905" });
    expect(store.getSnapshot().count).toBe(1);
    const old = offered.current!.stamp;

    store.discard(store.getSnapshot().rows[0].stamps);

    const after = binding.getSnapshot();
    expect(after.mode).toBe("editing");
    expect(after.canRestore).toBe(false);
    expect(after.reference).toBeUndefined();
    expect(after.current!.data).toEqual(clean());
    expect(after.current!.baseline).toBe(baseline);
    expect(after.current!.stamp.generation).not.toBe(old.generation);
    expect(store.getSnapshot().count).toBe(0);
    expect(binding.restore(old, readId)).toBe(false);
    expect(binding.getSnapshot().current!.data).toEqual(clean());
  });

  it("with the access read begun but not accepted, leaves the view loading until that read lands", () => {
    const { store, binding } = returned();
    const readId = binding.beginRead();
    expect(binding.getSnapshot().mode).toBe("loading");
    expect(store.getSnapshot().count).toBe(1);

    store.discard(store.getSnapshot().rows[0].stamps);

    expect(binding.getSnapshot().mode).toBe("loading");
    expect(binding.getSnapshot().current).toBeUndefined();
    expect(store.getSnapshot().count).toBe(0);

    // The read begun before the discard is still the one the store accepts.
    expect(binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean())).toBe(true);
    const after = binding.getSnapshot();
    expect(after.mode).toBe("editing");
    expect(after.canRestore).toBe(false);
    expect(after.reference).toBeUndefined();
    expect(after.current!.data).toEqual(clean());
    expect(store.getSnapshot().count).toBe(0);
  });
});

// #456 (owner rulings 2026-10-05). A new shipment's adapter takes a new seed after a discard, and
// only the page can fetch one. The page's own Discard buttons start that read by hand; the Shell's
// panel cannot, so the store says a read is owed and a page effect starts it.
const originalNonce = "3f6a1b2c-1111-4d22-8e33-9f0a1b2c3d4e";
const replacementNonce = "3f6a1b2c-1111-4d22-8e33-9f0a1b2c3d4f";
const seed: ShipmentSeed = { clientRequestId: originalNonce, defaultShipDate: "2026-09-12", defaultFreightTerms: "PREPAID" };
const shipmentSource = (creditHold = false): NewShipmentSource => ({ permissions: ["shipping.create", "shipping.view", "customers.view", "orders.view"],
  customer: { id: "customer", code: "C", name: "Customer", creditHold }, addresses: [], carriers: [], orders: [] });
const body = { clientRequestId: originalNonce } as ShipmentBody; // the store never reads a payload
function shipment() {
  const store = createDraftStore();
  const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
  const binding = store.bind({ owner, record: { kind: "new-shipment", id: "new" }, editor: newShipmentRecoveryAdapter.kind },
    { label: "New shipment", href: "/shipping/new" }, newShipmentRecoveryAdapter);
  let detach = binding.attach("page");
  const accept = (creditHold = false) => { const readId = binding.beginRead();
    expect(binding.acceptRead({ kind: "authorized", readId, baseline: newShipmentBaselineFrom(shipmentSource(creditHold)), editable: true },
      { ...newShipmentDraftFrom(seed), customerId: "customer" })).toBe(true); return readId; };
  accept(); binding.change(d => ({ ...d, comments: "typed" }));
  const shellDiscard = () => store.discard(store.getSnapshot().rows.find(row => row.metadata.href === "/shipping/new")!.stamps);
  const initialize = vi.fn((given: ShipmentSeed | undefined) => newShipmentDraftFrom(given ?? { ...seed, clientRequestId: replacementNonce }));
  const read = vi.fn(async (q: NewShipmentReadRequirements) => { void q; return { kind: "authorized" as const, editable: true, baseline: newShipmentBaselineFrom({ ...shipmentSource(), customer: null }) }; });
  const load = vi.fn(() => runNewShipmentRead({ binding, authorized: () => true, read, initialize }));
  return { store, binding, accept, shellDiscard, initialize, read, load, comeBack: () => { detach(); detach = binding.attach("return"); }, leave: () => detach() };
}
/** The page's own effect on the owed read, run as written; React and the page's load are supplied. */
function pageEffect(view: EditorView<unknown, unknown, unknown>, load: () => unknown) {
  const file = new URL("../src/app/shipping/new/NewShipment.tsx", import.meta.url);
  const tree = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = tree.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "NewShipment");
  const effects = component!.body!.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(tree) === "useEffect" && node.getText(tree).includes("view.needsRefresh"));
  expect(effects, "the page effect that reads view.needsRefresh").toHaveLength(1);
  // The dependency list is what makes React run the effect again after a discard: pin it as written.
  const written = ((effects[0] as ts.ExpressionStatement).expression as ts.CallExpression).arguments[1];
  expect(written && ts.isArrayLiteralExpression(written) ? written.elements.map(element => element.getText(tree)) : null,
    "the effect's dependency list").toEqual(["view.mode", "view.needsRefresh", "load"]);
  const code = ts.transpileModule(effects[0].getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  let dependencies: unknown;
  new Function("useEffect", "view", "load", code)((run: () => void, given: unknown) => { dependencies = given; run(); }, view, load);
  expect(dependencies).toEqual([view.mode, view.needsRefresh, load]);
}

describe("discarding a new shipment's draft from the Shell's drafts panel (#456)", () => {
  it("owes the page a read: loading with needsRefresh, which the next read's start clears", () => {
    const h = shipment();
    h.shellDiscard();
    const owed = h.binding.getSnapshot();
    expect(owed).toMatchObject({ mode: "loading", canRestore: false, needsRefresh: true });
    expect(owed.current).toBeUndefined(); expect(owed.savedBaseline).toBeUndefined();
    expect(h.store.getSnapshot().count).toBe(0);
    h.binding.beginRead();
    expect(h.binding.getSnapshot()).toMatchObject({ mode: "loading", needsRefresh: false });
  });
  it("the read it owes carries no seed, so the form comes back blank under a new request id", async () => {
    const h = shipment();
    h.shellDiscard();
    expect(await h.load()).toMatchObject({ kind: "authorized" });
    expect(h.read).toHaveBeenCalledTimes(1); expect(h.read).toHaveBeenCalledWith({});
    expect(h.initialize).toHaveBeenCalledTimes(1); expect(h.initialize).toHaveBeenCalledWith(undefined);
    const after = h.binding.getSnapshot();
    expect(after).toMatchObject({ mode: "editing", needsRefresh: false });
    expect(after.current!.data).toEqual(newShipmentDraftFrom({ ...seed, clientRequestId: replacementNonce }));
    expect(h.store.getSnapshot().count).toBe(0);
  });
  it("the page's effect starts that read once, and only for a loading view that owes one", async () => {
    const h = shipment();
    pageEffect(h.binding.getSnapshot(), h.load); // editing: nothing owed
    expect(h.load).not.toHaveBeenCalled();
    h.shellDiscard();
    pageEffect(h.binding.getSnapshot(), h.load);
    expect(h.load).toHaveBeenCalledTimes(1);
    pageEffect(h.binding.getSnapshot(), h.load); // the read has begun: the view no longer asks
    expect(h.load).toHaveBeenCalledTimes(1);
    await h.load.mock.results[0].value;
    expect(h.binding.getSnapshot().mode).toBe("editing");
    pageEffect(h.binding.getSnapshot(), h.load);
    expect(h.load).toHaveBeenCalledTimes(1);
    // A saved shipment's receipt also carries needsRefresh; that one is not this effect's to answer.
    h.binding.change(d => ({ ...d, comments: "submitted" }));
    const submission = h.binding.capture(body, "save"); expect(h.binding.dispatched(submission)).toBe(true);
    h.binding.settle(submission, { kind: "persisted", response: { shipper: { id: "made", shipperNumber: 7 }, warnings: ["look"] } });
    expect(h.binding.getSnapshot()).toMatchObject({ mode: "completed", needsRefresh: true });
    pageEffect(h.binding.getSnapshot(), h.load);
    expect(h.load).toHaveBeenCalledTimes(1);
  });
  // The one production adapter that both takes a new seed and has read requirements: a read held
  // by the real loader when the panel discards is restarted by that loader, not by the page.
  it("discarded while the loader's read is held: the loader restarts it once with no seed, and the page is asked for nothing (#454)", async () => {
    const h = shipment();
    const answer = h.read.getMockImplementation()!;
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    h.read.mockImplementationOnce(async q => { await held; return answer(q); });
    const reading = h.load();
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.read.mock.calls[0][0].seed).toMatchObject({ clientRequestId: originalNonce });
    h.shellDiscard();
    expect(h.binding.getSnapshot()).toMatchObject({ mode: "loading", needsRefresh: false });
    expect(h.store.getSnapshot().count).toBe(0);
    pageEffect(h.binding.getSnapshot(), h.load);
    expect(h.load).toHaveBeenCalledTimes(1); // only the call above
    release();
    expect(await reading).toMatchObject({ kind: "authorized" });
    expect(h.read).toHaveBeenCalledTimes(2); expect(h.read).toHaveBeenLastCalledWith({});
    expect(h.initialize).toHaveBeenCalledTimes(1); expect(h.initialize).toHaveBeenCalledWith(undefined);
    const after = h.binding.getSnapshot();
    expect(after).toMatchObject({ mode: "editing", needsRefresh: false });
    expect(after.current!.data).toEqual(newShipmentDraftFrom({ ...seed, clientRequestId: replacementNonce }));
    pageEffect(after, h.load);
    expect(h.load).toHaveBeenCalledTimes(1);
  });
  // Owner ruling 2026-10-05: with a save pending as well, the pending save wins over the restart.
  it("discarded while the loader's read is held and its save is in flight: no restart, no request, the manual re-check", async () => {
    const h = shipment();
    expect(h.binding.dispatched(h.binding.capture(body, "save"))).toBe(true);
    const answer = h.read.getMockImplementation()!;
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    h.read.mockImplementationOnce(async q => { await held; return answer(q); });
    const reading = h.load();
    expect(h.read).toHaveBeenCalledTimes(1);
    h.shellDiscard();
    expect(h.binding.getSnapshot()).toMatchObject({ mode: "loading", needsRefresh: false });
    release();
    expect(await reading).toEqual({ kind: "stale" });
    expect(h.read).toHaveBeenCalledTimes(1); expect(h.initialize).not.toHaveBeenCalled();
    expect(h.binding.getSnapshot()).toMatchObject({ mode: "loading", needsRefresh: false });
    expect(h.binding.getSnapshot().current).toBeUndefined();
    pageEffect(h.binding.getSnapshot(), h.load);
    expect(h.load).toHaveBeenCalledTimes(1);
  });
  it("owes nothing when the discarded copy had a save in flight: the page stays at its manual re-check", () => {
    const h = shipment();
    const submission = h.binding.capture(body, "save"); expect(h.binding.dispatched(submission)).toBe(true);
    expect(h.store.getSnapshot().rows[0].pending).toBe(true);
    h.shellDiscard();
    expect(h.binding.getSnapshot()).toMatchObject({ mode: "loading", needsRefresh: false });
    expect(h.binding.getSnapshot().current).toBeUndefined();
    pageEffect(h.binding.getSnapshot(), h.load);
    expect(h.load).not.toHaveBeenCalled();
    // The request was not cancelled; its late answer changes nothing here.
    h.binding.settle(submission, { kind: "persisted", response: { shipper: { id: "made", shipperNumber: 7 }, warnings: [] } });
    expect(h.binding.getSnapshot()).toMatchObject({ mode: "loading", needsRefresh: false });
    expect(h.binding.getSnapshot().completed).toBeUndefined();
  });
  for (const saving of [true, false]) it(`two copies discarded together, the current one ${saving ? "with" : "without"} a save in flight`, () => {
    const h = shipment(); h.comeBack(); const readId = h.accept(true);
    expect(h.binding.getSnapshot().mode).toBe("conflict");
    expect(h.binding.startFresh(readId, () => newShipmentDraftFrom({ ...seed, clientRequestId: replacementNonce }))).toBe(true);
    h.binding.change(d => ({ ...d, comments: "second" }));
    if (saving) expect(h.binding.dispatched(h.binding.capture(body, "save"))).toBe(true);
    expect(h.store.getSnapshot().rows[0].stamps).toHaveLength(2);
    h.shellDiscard();
    expect(h.store.getSnapshot().count).toBe(0);
    expect(h.binding.getSnapshot()).toMatchObject({ mode: "loading", needsRefresh: !saving });
  });
  // The memory of a discarded save lives for one discard call (owner ruling 2026-10-05). Here the
  // page's own button discards the saving copy alone, which leaves the earlier copy and no reload;
  // the panel's later discard of that earlier copy is a separate call and owes the read.
  it("a save discarded by the page's own button withholds nothing from a later panel discard of the other copy", () => {
    const h = shipment(); h.comeBack(); const readId = h.accept(true);
    expect(h.binding.startFresh(readId, () => newShipmentDraftFrom({ ...seed, clientRequestId: replacementNonce }))).toBe(true);
    h.binding.change(d => ({ ...d, comments: "second" }));
    expect(h.binding.dispatched(h.binding.capture(body, "save"))).toBe(true);
    h.binding.discard(h.binding.getSnapshot().current!.stamp);
    const left = h.binding.getSnapshot();
    expect(left).toMatchObject({ mode: "conflict", needsRefresh: false });
    expect(left.current).toBeUndefined(); expect(left.reference).toBeDefined();
    expect(h.store.getSnapshot().rows[0].stamps).toEqual([left.reference!.stamp]);
    h.shellDiscard();
    expect(h.store.getSnapshot().count).toBe(0);
    expect(h.binding.getSnapshot()).toMatchObject({ mode: "loading", needsRefresh: true });
  });
  it("a discarded save withholds only its own click's reload: the next plain discard owes one again", async () => {
    const h = shipment();
    expect(h.binding.dispatched(h.binding.capture(body, "save"))).toBe(true);
    h.shellDiscard();
    expect(h.binding.getSnapshot().needsRefresh).toBe(false);
    await h.load(); h.binding.change(d => ({ ...d, comments: "new work" }));
    h.shellDiscard();
    expect(h.binding.getSnapshot()).toMatchObject({ mode: "loading", needsRefresh: true });
  });
  it("owes nothing to an editor that is not mounted, before or after the discard", () => {
    const away = shipment(); away.leave(); away.shellDiscard(); away.binding.attach("later");
    expect(away.binding.getSnapshot()).toMatchObject({ mode: "loading", needsRefresh: false });
    const left = shipment(); left.shellDiscard();
    expect(left.binding.getSnapshot().needsRefresh).toBe(true);
    left.leave(); left.binding.attach("later");
    expect(left.binding.getSnapshot()).toMatchObject({ mode: "loading", needsRefresh: false });
  });
});
