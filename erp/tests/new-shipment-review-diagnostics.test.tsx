import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createDraftStore } from "../src/lib/draft-store";
import {
  newShipmentDraftFrom, newShipmentBaselineFrom, newShipmentRecoveryAdapter,
  runNewShipmentAddOrder, runNewShipmentCustomer, runNewShipmentRemoveOrder, runNewShipmentSave, runNewShipmentRetry, runNewShipmentRead,
  type NewShipmentSource, type NewShipmentRead, type ShipmentBody, type ShipmentCreateResult,
} from "../src/lib/new-shipment-recovery";
import { addOrderRefusalSentence, ORDER_CAN_NO_LONGER_BE_ADDED } from "../src/lib/add-order-refusal";

afterEach(() => vi.restoreAllMocks());
const seed = { clientRequestId: "3f6a1b2c-1111-4d22-8e33-9f0a1b2c3d4e", defaultShipDate: "2026-09-12", defaultFreightTerms: "PREPAID" as const };
const nextSeed = { ...seed, clientRequestId: "3f6a1b2c-1111-4d22-8e33-9f0a1b2c3d4f" };
function source(withOrder = false): NewShipmentSource {
  return { permissions: ["shipping.create", "shipping.view", "customers.view", "orders.view"],
    customer: { id: "customer", code: "C", name: "Customer", creditHold: false }, addresses: [], carriers: [],
    orders: withOrder ? [{ id: "order", customerId: "customer", orderNumber: 42, poNumber: "PO", customerJobNo: "JOB", status: "OPEN", voided: false,
      lines: [{ id: "line", position: 1, qty: 10, weight: 20, part: { partNumber: "P", name: "Part" } }],
      containers: [], serials: [], orderLineShippedToDate: [{ orderLineId: "line", shippedToDateQty: 0, shippedToDateWeight: 0 }] }] : [] };
}
function open() {
  const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "user")!;
  const binding = store.bind({ owner, record: { kind: "new-shipment", id: "new" }, editor: newShipmentRecoveryAdapter.kind },
    { label: "New shipment", href: "/shipping/new" }, newShipmentRecoveryAdapter);
  const detach = binding.attach("initial-view"); const readId = binding.beginRead();
  binding.acceptRead({ kind: "authorized", readId, baseline: newShipmentBaselineFrom(source()), editable: true }, { ...newShipmentDraftFrom(seed), customerId: "customer" });
  return { store, binding, detach, readId };
}
const response = (): ShipmentCreateResult => ({ shipper: { id: "created", shipperNumber: 77 }, warnings: ["Actual warning"] });
async function add(binding: ReturnType<typeof open>["binding"]) {
  expect(await runNewShipmentAddOrder({ binding, orderId: "order", authorized: () => true, newKey: () => "original-line-key",
    read: async () => ({ kind: "authorized", baseline: newShipmentBaselineFrom(source(true)), editable: true }) })).toBe("added");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}
function actual<T>(file: string, name: string, environment: Record<string, unknown>, jsx = false): T {
  const path = new URL(file, import.meta.url);
  const source = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: ts.FunctionDeclaration | ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (!jsx && ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    if (jsx && ts.isJsxAttribute(node) && node.name.getText(source) === name && node.initializer && ts.isJsxExpression(node.initializer)) found = node.initializer.expression;
    ts.forEachChild(node, visit);
  }
  visit(source); expect(found, `Actual ${name} callback`).toBeDefined();
  const expression = found!.getText(source).replace(/^export\s+/, "");
  const code = ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(environment), code)(...Object.values(environment)) as T;
}
const component = "../src/app/shipping/new/NewShipment.tsx";

it("an advertised on-page unknown retry uses the read accepted by the actual add-order command", async () => {
  const h = open(); const readIdRef = { current: h.readId };
  const session = { store: h.store, readAuthorizationTicket: () => ({}), isReadAuthorized: () => true };
  const readContext = vi.fn(async (): Promise<NewShipmentRead> => ({ kind: "authorized", baseline: newShipmentBaselineFrom(source(true)), editable: true }));
  const addOrder = actual<() => Promise<void>>(component, "addOrder", {
    binding: h.binding, addChoice: "order", addingOrder: false, readIdRef,
    getBrowserDraftSession: () => session, mounted: { current: true },
    setAddingOrder: vi.fn(), setAddChoice: vi.fn(), setError: vi.fn(), setAddRefusal: vi.fn(), addOrderRefusalSentence,
    runNewShipmentAddOrder, readContext, newId: () => "original-line-key",
  });
  await addOrder();
  expect(readContext).toHaveBeenCalledTimes(1);
  expect(h.binding.getSnapshot().current?.data.selected.map(o => o.orderId)).toEqual(["order"]);
  let original!: ShipmentBody;
  const write = vi.fn(async (body: ShipmentBody): Promise<ShipmentCreateResult> => { original = body; throw new TypeError("Lost acknowledgement"); });
  await runNewShipmentSave({ binding: h.binding, requestId: "first", write, persisted: () => {} });
  expect(write).toHaveBeenCalledTimes(1);
  const view = h.binding.getSnapshot(); expect(view.canRetryUnknown).toBe(true);
  const api = vi.fn(async () => response());
  const retry = actual<() => Promise<void>>(component, "retryOriginal", {
    binding: h.binding, view, readIdRef, runNewShipmentRetry,
    setSaving: vi.fn(), setError: vi.fn(), mounted: { current: true }, persisted: () => {},
    newId: () => "explicit-retry", api,
  });
  await retry();
  expect(api).toHaveBeenCalledTimes(1);
  expect(api).toHaveBeenCalledWith("/api/shippers", { method: "POST", body: JSON.stringify(original) });
  expect(h.binding.getSnapshot().completed?.id).toBe("created");
});

async function completedWithReference() {
  const h = open(); await add(h.binding); const held = deferred<ShipmentCreateResult>();
  const saving = runNewShipmentSave({ binding: h.binding, requestId: "save", write: () => held.promise, persisted: () => {} });
  h.binding.change(d => ({ ...d, comments: "later input to deliberately discard" }));
  held.resolve(response()); await saving;
  const completed = h.binding.getSnapshot();
  expect(completed.completed?.id).toBe("created"); expect(completed.reference?.data.comments).toBe("later input to deliberately discard");
  expect(h.binding.dismissCompleted(completed.completedStamp!)).toBe(true);
  const init = vi.fn(() => newShipmentDraftFrom(nextSeed));
  const read = async (): Promise<NewShipmentRead> => ({ kind: "authorized", baseline: newShipmentBaselineFrom(source(true)), editable: true });
  await runNewShipmentRead({ binding: h.binding, authorized: () => true, initialize: init, read });
  expect(init).not.toHaveBeenCalled(); expect(h.binding.getSnapshot().current).toBeUndefined();
  expect(h.binding.getSnapshot().reference).toBeDefined();
  return { ...h, init, read };
}

it("discarding the last post-receipt reference ends its nonce and initializes exactly one clean intent", async () => {
  const h = await completedWithReference();
  h.binding.discard(h.binding.getSnapshot().reference!.stamp);
  await runNewShipmentRead({ binding: h.binding, authorized: () => true, initialize: h.init, read: h.read });
  expect(h.init).toHaveBeenCalledTimes(1);
  expect(h.binding.getSnapshot().current?.data).toEqual(newShipmentDraftFrom(nextSeed));
  expect(h.binding.getSnapshot().reference).toBeUndefined();
  await runNewShipmentRead({ binding: h.binding, authorized: () => true, initialize: h.init, read: h.read });
  expect(h.init).toHaveBeenCalledTimes(1);
});

it("the actual last-reference dismissal callback automatically continues the mounted loader", async () => {
  const h = await completedWithReference(); const view = h.binding.getSnapshot();
  const load = vi.fn(() => runNewShipmentRead({ binding: h.binding, authorized: () => true, initialize: h.init, read: h.read }));
  const discard = actual<() => void>(component, "discardReference", { binding: h.binding, view, load }, true);
  discard();
  expect(load).toHaveBeenCalledTimes(1);
  await Promise.all(load.mock.results.map(result => result.value));
  expect(h.init).toHaveBeenCalledTimes(1);
  expect(h.binding.getSnapshot().current?.data.clientRequestId).toBe(nextSeed.clientRequestId);
});

it("reference-only dismissal beside a working new generation preserves that current copy and nonce", () => {
  const h = open(); h.binding.change(d => ({ ...d, comments: "older retained work" })); h.detach(); h.binding.attach("return");
  const fresh = source(); const baseline = newShipmentBaselineFrom({ ...fresh, customer: { ...fresh.customer!, creditHold: true } });
  const readId = h.binding.beginRead(); h.binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, newShipmentDraftFrom(seed));
  expect(h.binding.startFresh(readId, () => newShipmentDraftFrom(nextSeed))).toBe(true);
  h.binding.change(d => ({ ...d, route: "new current work" }));
  const before = h.binding.getSnapshot().current;
  h.binding.discard(h.binding.getSnapshot().reference!.stamp);
  expect(h.binding.getSnapshot().current).toBe(before);
  expect(h.binding.getSnapshot().current?.data.clientRequestId).toBe(nextSeed.clientRequestId);
});

it("the actual preview projection trusts admitted copies instead of rerunning full validation during render", () => {
  const h = open(); h.binding.change(d => ({ ...d, comments: "user text" }));
  const validate = vi.fn(() => true); const preview = vi.fn(() => [{ label: "Comments", value: "user text" }]);
  const project = actual<(view: ReturnType<typeof h.binding.getSnapshot>) => unknown>("../src/lib/new-shipment-recovery.ts", "newShipmentRecoveryPreviews", {
    valid: validate, newShipmentRecoveryAdapter: { preview },
  });
  expect(project(h.binding.getSnapshot())).toMatchObject({ currentPreview: [{ label: "Comments", value: "user text" }] });
  expect(preview).toHaveBeenCalledTimes(1); expect(validate).not.toHaveBeenCalled();
});

it("only the latest accepted customer context reports its read ID, never a stale or refused result", async () => {
  const h = open(); const first = deferred<NewShipmentRead>(); const second = deferred<NewShipmentRead>();
  const begin = vi.spyOn(h.binding, "beginEditRead"); const firstAccepted = vi.fn(); const secondAccepted = vi.fn();
  const firstArgs = { binding: h.binding, customerId: "first", authorized: () => true, read: () => first.promise, accepted: firstAccepted };
  const secondArgs = { binding: h.binding, customerId: "second", authorized: () => true, read: () => second.promise, accepted: secondAccepted };
  const a = runNewShipmentCustomer(firstArgs); const b = runNewShipmentCustomer(secondArgs);
  const fresh = source();
  second.resolve({ kind: "authorized", baseline: newShipmentBaselineFrom({ ...fresh, customer: { ...fresh.customer!, id: "second" } }), editable: true });
  expect(await b).toBe(true); expect(secondAccepted).toHaveBeenCalledTimes(1); expect(secondAccepted).toHaveBeenCalledWith(begin.mock.results[1].value);
  first.resolve({ kind: "authorized", baseline: newShipmentBaselineFrom({ ...fresh, customer: { ...fresh.customer!, id: "first" } }), editable: true });
  expect(await a).toBe(false); expect(firstAccepted).not.toHaveBeenCalled();
  const refused = vi.fn();
  const refusedArgs = { binding: h.binding, customerId: "third", authorized: () => true, accepted: refused,
    read: async (): Promise<NewShipmentRead> => ({ kind: "authorized", baseline: newShipmentBaselineFrom(fresh), editable: true }) };
  expect(await runNewShipmentCustomer(refusedArgs)).toBe(false); expect(refused).not.toHaveBeenCalled();
});

it("successful remove and synchronous empty-customer commands report their read IDs and refusals do not", async () => {
  const h = open(); await add(h.binding); const begin = vi.spyOn(h.binding, "beginEditRead"); const accepted = vi.fn();
  const remove = runNewShipmentRemoveOrder as (binding: typeof h.binding, orderId: string, accepted?: (id: number) => void) => boolean;
  expect(remove(h.binding, "missing", accepted)).toBe(false); expect(accepted).not.toHaveBeenCalled();
  expect(remove(h.binding, "order", accepted)).toBe(true); expect(accepted).toHaveBeenCalledTimes(1); expect(accepted).toHaveBeenCalledWith(begin.mock.results[0].value);
  accepted.mockClear(); const args = { binding: h.binding, customerId: "", authorized: () => true, accepted,
    read: async (): Promise<NewShipmentRead> => ({ kind: "unavailable" }) };
  const cleared = runNewShipmentCustomer(args);
  expect(accepted).toHaveBeenCalledTimes(1); expect(accepted).toHaveBeenCalledWith(begin.mock.results[1].value); expect(await cleared).toBe(true);
});

// #695 (a): a refused Add order says so beside the control, through the page's own `addOrder`,
// and never in `error`, which is Save's page-top banner.
it("the actual add-order command shows a refused add beside Add order and leaves Save's banner alone", async () => {
  for (const status of ["SHIPPED", "OPEN"] as const) {
    const h = open(); const session = { store: h.store, readAuthorizationTicket: () => ({}), isReadAuthorized: () => true };
    const fresh = source(true); const shipped = { ...fresh, orders: [{ ...fresh.orders[0], status }] };
    const setAddRefusal = vi.fn(); const setError = vi.fn(); const setAddChoice = vi.fn();
    const addOrder = actual<() => Promise<void>>(component, "addOrder", {
      binding: h.binding, addChoice: "order", addingOrder: false, readIdRef: { current: h.readId },
      getBrowserDraftSession: () => session, mounted: { current: true },
      setAddingOrder: vi.fn(), setAddChoice, setError, setAddRefusal, addOrderRefusalSentence,
      runNewShipmentAddOrder, newId: () => "key",
      readContext: async (): Promise<NewShipmentRead> => ({ kind: "authorized", baseline: newShipmentBaselineFrom(shipped), editable: true }),
    });
    await addOrder();
    if (status === "SHIPPED") {
      expect(setAddRefusal).toHaveBeenLastCalledWith(ORDER_CAN_NO_LONGER_BE_ADDED);
      expect(setError).not.toHaveBeenCalled(); expect(setAddChoice).not.toHaveBeenCalled();
      expect(h.binding.getSnapshot().current?.data.selected).toEqual([]);
    } else {
      expect(setAddRefusal).toHaveBeenLastCalledWith(null);
      expect(setAddChoice).toHaveBeenCalledWith("");
    }
  }
});

it("only an order that cannot be added, or a read the form moved past, words the refusal", () => {
  expect(addOrderRefusalSentence("shipped")).toBe(ORDER_CAN_NO_LONGER_BE_ADDED);
  expect(addOrderRefusalSentence("changed")).toBe(ORDER_CAN_NO_LONGER_BE_ADDED);
  for (const quiet of ["added", "unavailable", "stale"] as const) expect(addOrderRefusalSentence(quiet), quiet).toBeNull();
  expect(ORDER_CAN_NO_LONGER_BE_ADDED).toBe("This order can no longer be added. Check the saved records again, then pick an order.");
});

/** The page's source, each run of white space as one space. */
const page = () => readFileSync(new URL(component, import.meta.url), "utf8").replace(/\s+/g, " ");

it("the refusal is drawn beside Add order in the shared panel message, with the notice's retry", () => {
  expect(page()).toContain('{addingOrder ? "Adding…" : "Add order"} </button> </div> <PanelMessage message={addRefusal} /> '
    + '{addRefusal && <button type="button" className="mt-1 text-sm underline" onClick={() => void load()}>{CHECK_AGAIN}</button>}');
  // A full read that lands clears it.
  expect(page()).toContain('if (outcome.kind === "authorized") { setError(null); setAddRefusal(null); }');
});

// The retry reads the order list again because a full read leaves editing until it lands, and the
// list's read is keyed on the editor's mode.
it("a full read mid-edit leaves editing until it lands, then keeps the typed draft", async () => {
  const h = open(); await add(h.binding); h.binding.change(d => ({ ...d, comments: "typed" }));
  const id = h.binding.beginRead();
  expect(h.binding.getSnapshot().mode).toBe("loading");
  expect(h.binding.acceptRead({ kind: "authorized", readId: id, baseline: newShipmentBaselineFrom(source(true)), editable: true }, () => newShipmentDraftFrom(seed))).toBe(true);
  expect(h.binding.getSnapshot().mode).toBe("editing");
  expect(h.binding.getSnapshot().current?.data).toMatchObject({ comments: "typed", selected: [{ orderId: "order" }] });
});

// #695 (b): with no form to show, the page draws the recovery notice alone (its first sentence is
// `editorAccessSentence(view.mode)`), never a Save or read message beside it, and "Loading…" before
// the draft store binds (PageStatus, #634).
it("the form's absence shows the notice alone, or PageStatus before there is one", () => {
  expect(page()).toContain('if (["loading", "unavailable", "error"].includes(view.mode)) return notice ? <div className="p-6">{notice}</div> : <PageStatus />;');
});

// #699: the list's read is keyed off the orders on the form, which are filtered out at render.
it("the candidates read is not keyed on the orders on the form", () => {
  expect(page()).toContain("}, [customerId, ordersGate.allowed, authorizationRevision, view.mode]);");
  expect(page()).toContain('setCandidates(rows); setCandidatesState("ready");');
  expect(page()).toContain('.catch(() => { if (!stale && session.isReadAuthorized(ticket)) setCandidatesState("failed"); });');
});
