import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../src/lib/fetcher";
import { createDraftStore, type EditorView } from "../src/lib/draft-store";
import { NewShipment } from "../src/app/shipping/new/NewShipment";
import { SHIPMENT_BOX, shipmentContainerBoxId, shipmentLineBoxId } from "../src/lib/shipment-box-ids";
import {
  newShipmentDraftFrom, newShipmentBaselineFrom, newShipmentRecoveryAdapter, resetNewShipmentCustomer, removeNewShipmentOrder,
  prepareNewShipmentSave, runNewShipmentSave, runNewShipmentRetry, runNewShipmentRead, readNewShipmentAccess, newShipmentRecoveryPreviews, runNewShipmentCustomer, runNewShipmentAddOrder, runNewShipmentRemoveOrder,
  type ShipmentSeed, type NewShipmentSource, type NewShipmentDraft, type NewShipmentBaseline, type NewShipmentBinding,
  type ShipmentCreateResult, type ShipmentCreationReceipt, type ShipmentBody, type NewShipmentRead, type NewShipmentReadRequirements,
} from "../src/lib/new-shipment-recovery";
const rendered = vi.hoisted(() => ({ view: null as unknown, catalogs: null as unknown[] | null }));
vi.mock("react", async original => {
  const real = await original<typeof import("react")>();
  return { ...real, useState: (initial: unknown) => {
    const state = real.useState(initial);
    return Array.isArray(initial) && rendered.catalogs ? [rendered.catalogs, state[1]] : state;
  } };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }), useSearchParams: () => new URLSearchParams() }));
vi.mock("../src/lib/use-permissions", () => ({ usePermissions: () => ({ permissions: ["shipping.create", "shipping.view", "customers.view", "orders.view"], error: null }) }));
// Only the external-store render snapshot is supplied for SSR. The actual
// NewShipment component and its owning preview/receipt boundary remain real.
vi.mock("../src/lib/use-recoverable-draft", async original => ({ ...await original<typeof import("../src/lib/use-recoverable-draft")>(), useRecoverableDraft: () => rendered.view }));
afterEach(() => { vi.restoreAllMocks(); rendered.view = null; rendered.catalogs = null; });
const seed: ShipmentSeed = { clientRequestId: "3f6a1b2c-1111-4d22-8e33-9f0a1b2c3d4e", defaultShipDate: "2026-09-12", defaultFreightTerms: "PREPAID" };
const nextNonce = "3f6a1b2c-1111-4d22-8e33-9f0a1b2c3d4f";
function source() {
  return {
    permissions: ["shipping.create", "shipping.view", "customers.view", "orders.view", "action.override_credit_hold"],
    customer: { id: "c1", code: "ACME", name: "Example customer", creditHold: false as boolean },
    addresses: [{ id: "address-1", kind: "SHIP_TO", name: "Dock" }], carriers: [{ id: "carrier-1", name: "Freight carrier" }],
    orders: [{ id: "order-1", customerId: "c1", orderNumber: 701, poNumber: "PO-1", customerJobNo: "JOB-1", status: "OPEN", voided: false as boolean,
      lines: [{ id: "line-1", position: 1, qty: 10, weight: 50, part: { partNumber: "P-1", name: "Shaft" } }, { id: "line-2", position: 2, qty: 5, weight: 15, part: { partNumber: "P-2", name: "Pin" } }],
      containers: [{ id: "container-1", count: 2, customerContainerId: "BOX-1", type: { name: "Box" }, tareEach: 42.5 as number | null }],
      serials: [{ id: "serial-1", lineId: "line-1", serial: "S001", description: "Blue" }],
      orderLineShippedToDate: [{ orderLineId: "line-1", shippedToDateQty: 2, shippedToDateWeight: 10 }],
    }],
  } satisfies NewShipmentSource;
}
function selected(): NewShipmentDraft["selected"] {
  return [{ orderId: "order-1", lines: [{ key: "uuid-line-1", isNew: true, orderLineId: "line-1", qty: "08", weight: " 40.00 ", lineComplete: "false" }],
    containers: [{ key: "uuid-container-1", isNew: true, orderContainerId: "container-1", count: "02", tareEach: " 42.50 " }],
    serials: [{ key: "uuid-serial-1", isNew: true, orderSerialId: "serial-1", printOnShipper: "true" }] }];
}
function open() {
  const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
  const key = { owner, record: { kind: "new-shipment", id: "new" }, editor: newShipmentRecoveryAdapter.kind };
  const binding = store.bind(key, { label: "New shipment", href: "/shipping/new" }, newShipmentRecoveryAdapter);
  const detach = binding.attach("first"); const baseline = newShipmentBaselineFrom(source()); const clean = { ...newShipmentDraftFrom(seed), customerId: "c1" };
  const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
  return { store, owner, key, binding, baseline, clean, detach, readId };
}
function ready(binding: NewShipmentBinding, id = "save") {
  const prepared = prepareNewShipmentSave(binding, id); expect(prepared.kind).toBe("ready");
  if (prepared.kind !== "ready") return null; return prepared.submission;
}
function result(warnings: readonly string[] = ["Review load quantities", "Review missing serial coverage"]): ShipmentCreateResult {
  return { shipper: { id: "created-1", shipperNumber: 702 }, warnings };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const receiptBaseline = (): NewShipmentBaseline => ({ kind: "completed", permissions: ["shipping.view"], created: { id: "created-1", shipperNumber: 702 }, readableCopies: [] });
function receiptRead(): NewShipmentRead { return { kind: "authorized", baseline: receiptBaseline(), editable: false }; }
function cleanFromSeed(captured: ShipmentSeed | undefined) { return newShipmentDraftFrom(captured ?? { ...seed, clientRequestId: nextNonce }); }

describe("new shipment retained raw state and writer baseline", () => {
  it("restores exact last-event raw values and nested keys without changing captured defaults after date rollover", () => {
    const h = open(); h.binding.change(d => ({ ...d, shipToAddressId: "address-1", carrierId: "carrier-1", shipDate: "2026-09-13",
      route: " route ", comments: "\nprivate note\n", billFreight: true, freightAmount: "bad amount", freightTerms: "COLLECT", freightClass: " 50 ",
      freightDescription: " raw freight ", packageCount: "not integer", proNumber: " PRO ", scacCode: " SCAC ", creditHoldReason: " raw reason ", selected: selected() }));
    const expected = h.binding.getSnapshot().current!.data;
    h.detach(); h.binding.attach("return-next-day"); const id = h.binding.beginRead();
    h.binding.acceptRead({ kind: "authorized", readId: id, baseline: newShipmentBaselineFrom(source()), editable: true }, h.clean);
    expect(h.binding.getSnapshot().mode).toBe("offer"); expect(h.binding.restore(h.binding.getSnapshot().current!.stamp, id)).toBe(true);
    expect(h.binding.getSnapshot().current?.data).toEqual(expected);
    expect(h.binding.getSnapshot().current?.data).toMatchObject({ clientRequestId: seed.clientRequestId, defaultShipDate: "2026-09-12", defaultFreightTerms: "PREPAID", freightAmount: "bad amount", packageCount: "not integer" });
    expect(h.binding.getSnapshot().current?.data.selected[0].lines[0]).toEqual({ key: "uuid-line-1", isNew: true, orderLineId: "line-1", qty: "08", weight: " 40.00 ", lineComplete: "false" });
  });
  it("keeps customer-only and whitespace-only filters clean, but counts every existing header dirty field", () => {
    const h = open(); expect(h.store.getSnapshot().count).toBe(0);
    expect(newShipmentRecoveryAdapter.dirty({ ...h.clean, customerId: "c2", route: " \n ", comments: "\t" }, h.baseline)).toBe(false);
    const patches: Partial<NewShipmentDraft>[] = [{ shipToAddressId: "address-1" }, { carrierId: "carrier-1" }, { route: "R" }, { comments: "C" },
      { shipDate: "2026-09-13" }, { billFreight: true }, { freightAmount: "bad" }, { freightTerms: "COLLECT" }, { freightClass: "50" },
      { freightDescription: "freight" }, { packageCount: "bad" }, { proNumber: "P" }, { scacCode: "SCAC" }, { creditHoldReason: "reason" }];
    for (const patch of patches) expect(newShipmentRecoveryAdapter.dirty({ ...h.clean, ...patch }, h.baseline), JSON.stringify(patch)).toBe(true);
  });
  it("customer and remove-order resets destroy only their existing scope", () => {
    const draft: NewShipmentDraft = { ...newShipmentDraftFrom(seed), customerId: "c1", shipToAddressId: "address-1", creditHoldReason: "reason",
      route: "keep route", comments: "keep notes", freightAmount: "bad amount", selected: [...selected(), { ...selected()[0], orderId: "order-2" }] };
    const changed = resetNewShipmentCustomer(draft, "c2");
    expect(changed).toMatchObject({ customerId: "c2", shipToAddressId: "", creditHoldReason: "", selected: [], route: "keep route", comments: "keep notes", freightAmount: "bad amount", clientRequestId: seed.clientRequestId });
    const removed = removeNewShipmentOrder(draft, "order-1"); expect(removed.selected.map(o => o.orderId)).toEqual(["order-2"]);
    expect(removed.shipToAddressId).toBe("address-1"); expect(removed.creditHoldReason).toBe("reason"); expect(draft.selected).toHaveLength(2);
  });
  for (const change of ["add-line", "remove-line", "change-line", "reidentify", "position", "container", "serial", "ledger", "credit", "status", "customer", "address", "carrier"] as const) {
    it(`does not restore against changed ${change}, including untouched source rows`, () => {
      const h = open(); h.binding.change(d => ({ ...d, selected: selected(), comments: "raw" })); const fresh = source();
      if (change === "add-line") fresh.orders[0].lines.push({ ...fresh.orders[0].lines[1], id: "line-3", position: 3 });
      if (change === "remove-line") fresh.orders[0].lines.pop();
      if (change === "change-line") fresh.orders[0].lines[1].qty = 6;
      if (change === "reidentify") fresh.orders[0].lines[1].id = "replaced";
      if (change === "position") fresh.orders[0].lines[1].position = 7;
      if (change === "container") fresh.orders[0].containers[0].count = 3;
      if (change === "serial") fresh.orders[0].serials[0].lineId = "line-2";
      if (change === "ledger") fresh.orders[0].orderLineShippedToDate[0].shippedToDateQty = 9;
      if (change === "credit") fresh.customer.creditHold = true;
      if (change === "status") fresh.orders[0].status = "SHIPPED";
      if (change === "customer") fresh.orders[0].customerId = "different";
      if (change === "address") fresh.addresses = [];
      if (change === "carrier") fresh.carriers = [];
      h.detach(); h.binding.attach("return"); const id = h.binding.beginRead(); h.binding.acceptRead({ kind: "authorized", readId: id, baseline: newShipmentBaselineFrom(fresh), editable: true }, h.clean);
      expect(h.binding.getSnapshot().canRestore).toBe(false); expect(h.binding.getSnapshot().mode).toBe("conflict");
      expect(h.binding.getSnapshot().current?.data.comments).toBe("raw");
    });
  }
  it("a changed tare each on an order's container row sets no draft aside: the draft is offered again", () => {
    const h = open(); h.binding.change(d => ({ ...d, selected: selected(), comments: "raw" }));
    const fresh = source(); fresh.orders[0].containers[0].tareEach = 99;
    h.detach(); h.binding.attach("return"); const id = h.binding.beginRead();
    h.binding.acceptRead({ kind: "authorized", readId: id, baseline: newShipmentBaselineFrom(fresh), editable: true }, h.clean);
    expect(h.binding.getSnapshot()).toMatchObject({ mode: "offer", canRestore: true });
  });
  it("a container row of the draft has its tare each as text: a row without one is not a valid draft", () => {
    const h = open();
    const draft = (container: Record<string, unknown>) => ({ ...h.clean, selected: [{ orderId: "order-1", lines: [], containers: [container], serials: [] }] });
    const row = { key: "uuid-container-1", isNew: true, orderContainerId: "container-1", count: "2" };
    expect([draft({ ...row, tareEach: "" }), draft(row)].map(data => newShipmentRecoveryAdapter.valid(data, h.baseline))).toEqual([true, false]);
  });
  it("a draft is valid over an order container row with no tareEach key, which is how the baseline holds a row with no tare each", () => {
    const fresh = source(); fresh.orders[0].containers[0].tareEach = null;
    const baseline = newShipmentBaselineFrom(fresh);
    const held = (baseline as Extract<NewShipmentBaseline, { kind: "form" }>).source.orders[0].containers[0];
    const draft = { ...newShipmentDraftFrom(seed), customerId: "c1", selected: selected() };
    expect(["tareEach" in held, newShipmentRecoveryAdapter.valid(draft, baseline)]).toEqual([false, true]);
  });
  it("names its recovery schema v2: a container row gained a field", () => {
    expect(newShipmentRecoveryAdapter.schema).toBe("new-shipment-v2");
  });
  it("compares a baseline with itself without writing out its orders (#703: the same object after a read)", () => {
    const built = newShipmentBaselineFrom(source());
    if (built.kind !== "form") throw new Error("a form baseline");
    const trap = new Proxy([] as typeof built.source.orders, { get() { throw new Error("orders read"); } });
    const baseline: NewShipmentBaseline = { ...built, source: { ...built.source, orders: trap } };
    expect(newShipmentRecoveryAdapter.baselineEqual(baseline, baseline)).toBe(true);
  });
  it("permits display-only changes but rejects malformed nested state", () => {
    const first = source(); const display = source(); display.orders[0].lines[0].part.name = "Renamed display";
    expect(newShipmentRecoveryAdapter.baselineEqual(newShipmentBaselineFrom(first), newShipmentBaselineFrom(display))).toBe(true);
    const h = open(); expect(newShipmentRecoveryAdapter.valid({ ...h.clean, selected: [{ orderId: "order-1", lines: "invalid", containers: [], serials: [] }] }, h.baseline)).toBe(false);
  });
});

describe("new shipment attributed creation outcomes", () => {
  it("preserves literal body conventions and refuses validation before capture or transport", async () => {
    const h = open(); h.binding.change(d => ({ ...d, selected: selected(), route: " raw route ", comments: " raw notes ", freightAmount: " 12.50 ", packageCount: "03" }));
    const submission = ready(h.binding); if (!submission) return;
    expect(submission.payload).toEqual({ clientRequestId: seed.clientRequestId, customerId: "c1", shipToAddressId: null, shipDate: "2026-09-12", carrierId: null,
      route: " raw route ", comments: " raw notes ", billFreight: false, freightAmount: "12.50", freightTerms: "PREPAID", freightClass: "", freightDescription: "", packageCount: 3, proNumber: "", scacCode: "",
      orders: [{ orderId: "order-1", lines: [{ orderLineId: "line-1", qty: 8, weight: "40.00", lineComplete: false }], containers: [{ orderContainerId: "container-1", count: 2, tareEach: "42.50" }], serials: [{ orderSerialId: "serial-1", printOnShipper: true }] }] });
    const invalid = open(); invalid.binding.change(d => ({ ...d, selected: selected(), freightAmount: "bad" }));
    const capture = vi.spyOn(invalid.binding, "capture"); const writes: ShipmentBody[] = [];
    const outcome = await runNewShipmentSave({ binding: invalid.binding, requestId: "refused", write: async b => { writes.push(b); return result(); }, persisted: () => {} });
    expect(outcome.kind).toBe("invalid"); expect(capture).not.toHaveBeenCalled(); expect(writes).toEqual([]);
  });
  it("sends a close-short tick only on a row that ships under its ordered quantity", () => {
    // line-1: ordered 10, 2 already shipped elsewhere. Typing 8 finishes it; typing 5 does not.
    const wire = (qty: string) => {
      const h = open();
      h.binding.change(d => ({ ...d, selected: [{ ...selected()[0], lines: [{ ...selected()[0].lines[0], qty, lineComplete: "true" }] }] }));
      const submission = ready(h.binding, `close-short-${qty}`); if (!submission) throw new Error("not ready");
      return submission.payload.orders[0].lines[0].lineComplete;
    };
    expect(wire("8")).toBe(false);
    expect(wire("5")).toBe(true);
  });
  it("keeps the close-short tick through a mistyped completing quantity", () => {
    // One draft, one ticked row: only the typed quantity moves. 8 finishes line-1 (10 ordered, 2 shipped elsewhere).
    const h = open();
    const typed = (qty: string, id: string) => {
      h.binding.change(d => ({ ...d, selected: [{ ...selected()[0], lines: [{ ...selected()[0].lines[0], qty, lineComplete: "true" }] }] }));
      const submission = ready(h.binding, id); if (!submission) throw new Error("not ready");
      return submission.payload.orders[0].lines[0].lineComplete;
    };
    expect(typed("5", "short-1")).toBe(true);
    expect(typed("8", "completing")).toBe(false);
    expect(typed("5", "short-2")).toBe(true);
  });
  it("names a refused Ship now net weight with the order first, in the rule's words, and a blank one too", () => {
    const prepared = (patch: { qty?: string; weight?: string }) => {
      const h = open();
      h.binding.change(d => ({ ...d, selected: [{ ...selected()[0], lines: [{ ...selected()[0].lines[0], ...patch }] }] }));
      return prepareNewShipmentSave(h.binding, "refused");
    };
    const refused = (sentence: string) => ({ kind: "invalid", error: `Order #701, Line 1, Ship now net weight (lb): ${sentence}`,
      fieldIds: [shipmentLineBoxId("order-1", 0, "weight")] });
    expect(prepared({ weight: " " })).toEqual(refused("enter a number without $ or commas, such as 0.36."));
    expect(prepared({ weight: "heavy" })).toEqual(refused("enter a number without $ or commas, such as 0.36."));
    expect(prepared({ weight: "-1" })).toEqual(refused("cannot be negative."));
    expect(prepared({ weight: "1.234" })).toEqual(refused("use at most 2 digits after the point."));
    expect(prepared({ weight: "10000000000" })).toEqual(refused("must be less than 10,000,000,000."));
    // 0 and a half typed figure are figures the rule reads: the same row is then ready to send.
    expect(prepared({ weight: "0" }).kind).toBe("ready");
    expect(prepared({ weight: "40." }).kind).toBe("ready");
    // A refused quantity keeps its words and its place; a blank weight on the same line is listed with it.
    expect(prepared({ qty: "1.5", weight: " " })).toEqual({ kind: "invalid", error: [
      "Order #701 line 1: ship-now quantity must be a whole number of at least 0.",
      "Order #701, Line 1, Ship now net weight (lb): enter a number without $ or commas, such as 0.36.",
    ].join("\n"), fieldIds: [shipmentLineBoxId("order-1", 0, "qty"), shipmentLineBoxId("order-1", 0, "weight")] });
  });
  it("refuses a number of containers that is not a whole number of at least 1 and a Tare each the rule refuses, naming the order and the container", () => {
    const prepared = (patch: { count?: string; tareEach?: string }) => {
      const h = open();
      h.binding.change(d => ({ ...d, selected: [{ ...selected()[0], containers: [{ ...selected()[0].containers[0], ...patch }] }] }));
      return prepareNewShipmentSave(h.binding, "refused");
    };
    const containers = { kind: "invalid", error: "Order #701 container 1: containers must be a whole number of at least 1.",
      fieldIds: [shipmentContainerBoxId("order-1", 0, "count")] };
    expect([" ", "0", "1.5"].map(count => prepared({ count }))).toEqual([containers, containers, containers]);
    const tare = (sentence: string) => ({ kind: "invalid", error: `Order #701, Container 1, Tare each (lb): ${sentence}`,
      fieldIds: [shipmentContainerBoxId("order-1", 0, "tareEach")] });
    expect(prepared({ tareEach: "-1" })).toEqual(tare("cannot be negative."));
    expect(prepared({ tareEach: "heavy" })).toEqual(tare("enter a number without $ or commas, such as 0.36."));
    expect(prepared({ tareEach: "42.555" })).toEqual(tare("use at most 2 digits after the point."));
    expect(prepared({ tareEach: "12345678901" })).toEqual(tare("must be less than 10,000,000,000."));
    // A blank Tare each is no figure and passes; so do the figures the rule reads.
    for (const tareEach of ["", "  ", "0", "42.5", ".5", "9999999999.99"]) expect(prepared({ tareEach }).kind).toBe("ready");
    // The count and the tare each of one row are both listed, the count first.
    expect(prepared({ count: "0", tareEach: "-1" })).toEqual({ kind: "invalid", error: `${containers.error}\n${tare("cannot be negative.").error}`,
      fieldIds: [...containers.fieldIds, ...tare("cannot be negative.").fieldIds] });
  });
  it("lists every refusal on the shipment at once, one per line, in the order the form is read", () => {
    const h = open();
    const base = selected()[0];
    h.binding.change(d => ({ ...d, shipDate: "", packageCount: "x", freightAmount: "bad",
      selected: [{ ...base,
        lines: [{ ...base.lines[0], qty: "1.5", weight: "-1" }, { ...base.lines[0], key: "uuid-line-2", orderLineId: "line-2", qty: "3", weight: "1.234" }],
        containers: [{ ...base.containers[0], count: "0", tareEach: "heavy" }] }] }));
    expect(prepareNewShipmentSave(h.binding, "refused")).toEqual({ kind: "invalid", error: [
      "Enter a ship date.",
      "Order #701 line 1: ship-now quantity must be a whole number of at least 0.",
      "Order #701, Line 1, Ship now net weight (lb): cannot be negative.",
      "Order #701, Line 2, Ship now net weight (lb): use at most 2 digits after the point.",
      "Order #701 container 1: containers must be a whole number of at least 1.",
      "Order #701, Container 1, Tare each (lb): enter a number without $ or commas, such as 0.36.",
      "Package count must be a whole number of at least 0.",
      "Freight amount: enter a number without $ or commas, such as 0.36.",
    ].join("\n"), fieldIds: [SHIPMENT_BOX.shipDate, shipmentLineBoxId("order-1", 0, "qty"), shipmentLineBoxId("order-1", 0, "weight"),
      shipmentLineBoxId("order-1", 1, "weight"), shipmentContainerBoxId("order-1", 0, "count"), shipmentContainerBoxId("order-1", 0, "tareEach"),
      SHIPMENT_BOX.packageCount, SHIPMENT_BOX.freightAmount] });
  });
  it("names a bad weight, a bad tare and a bad freight amount of one shipment, and reads a freight amount by the rule", () => {
    const h = open();
    const base = selected()[0];
    h.binding.change(d => ({ ...d, freightAmount: "-5",
      selected: [{ ...base, lines: [{ ...base.lines[0], weight: "x" }], containers: [{ ...base.containers[0], tareEach: "-1" }] }] }));
    expect(prepareNewShipmentSave(h.binding, "refused")).toEqual({ kind: "invalid", error: [
      "Order #701, Line 1, Ship now net weight (lb): enter a number without $ or commas, such as 0.36.",
      "Order #701, Container 1, Tare each (lb): cannot be negative.",
      "Freight amount: cannot be negative.",
    ].join("\n"), fieldIds: [shipmentLineBoxId("order-1", 0, "weight"), shipmentContainerBoxId("order-1", 0, "tareEach"), SHIPMENT_BOX.freightAmount] });
    // Freight amount: a blank passes, and the other faults are the rule's own.
    const freight = (freightAmount: string) => {
      const g = open(); g.binding.change(d => ({ ...d, selected: selected(), freightAmount }));
      return prepareNewShipmentSave(g.binding, "refused");
    };
    expect(["", "  ", "0", "12.50", "12."].map(t => freight(t).kind)).toEqual(Array(5).fill("ready"));
    expect(freight("1.234")).toEqual({ kind: "invalid", error: "Freight amount: use at most 2 digits after the point.", fieldIds: [SHIPMENT_BOX.freightAmount] });
    expect(freight("10000000000")).toEqual({ kind: "invalid", error: "Freight amount: must be less than 10,000,000,000.", fieldIds: [SHIPMENT_BOX.freightAmount] });
  });
  it("skips a check that rests on one that failed: no customer, no orders; a refused quantity, no 'at least one line'", () => {
    const noCustomer = open(); noCustomer.binding.change(d => ({ ...d, customerId: "", shipDate: "", selected: [] }));
    expect(prepareNewShipmentSave(noCustomer.binding, "refused")).toEqual({ kind: "invalid", error: ["Pick a customer.", "Enter a ship date."].join("\n"),
      fieldIds: [SHIPMENT_BOX.customer, SHIPMENT_BOX.shipDate] });
    const noOrders = open(); noOrders.binding.change(d => ({ ...d, selected: [] }));
    expect(prepareNewShipmentSave(noOrders.binding, "refused")).toEqual({ kind: "invalid", error: "Add at least one order.", fieldIds: [SHIPMENT_BOX.addOrder] });
    const base = selected()[0];
    const zero = open(); zero.binding.change(d => ({ ...d, selected: [{ ...base, lines: [{ ...base.lines[0], qty: "0" }] }] }));
    expect(prepareNewShipmentSave(zero.binding, "refused")).toEqual({ kind: "invalid", error: "A shipment needs at least one line with a positive quantity.",
      fieldIds: [shipmentLineBoxId("order-1", 0, "qty")] });
    // The quantity is refused, so what the lines add up to is not asked: only the quantity is listed.
    const bad = open(); bad.binding.change(d => ({ ...d, selected: [{ ...base, lines: [{ ...base.lines[0], qty: "-1" }] }] }));
    expect(prepareNewShipmentSave(bad.binding, "refused")).toEqual({ kind: "invalid", error: "Order #701 line 1: ship-now quantity must be a whole number of at least 0.",
      fieldIds: [shipmentLineBoxId("order-1", 0, "qty")] });
    // A credit-held customer and an actor without the override: the missing action is the problem, so the reason is not asked for.
    const held = open(); const heldSource = source();
    const heldBaseline = newShipmentBaselineFrom({ ...heldSource, permissions: heldSource.permissions.filter(p => p !== "action.override_credit_hold"), customer: { ...heldSource.customer, creditHold: true } });
    held.detach(); held.binding.attach("return"); const heldRead = held.binding.beginRead();
    held.binding.acceptRead({ kind: "authorized", readId: heldRead, baseline: heldBaseline, editable: true }, held.clean);
    held.binding.change(d => ({ ...d, selected: selected(), creditHoldReason: "" }));
    // That refusal names no box, so the form holds none to jump to.
    expect(prepareNewShipmentSave(held.binding, "refused")).toEqual({ kind: "invalid", error: "Saving requires the override_credit_hold action.", fieldIds: [] });
    // With the override, the missing reason names the reason box.
    const reasoned = open(); const reasonSource = source();
    reasoned.detach(); reasoned.binding.attach("return"); const reasonRead = reasoned.binding.beginRead();
    reasoned.binding.acceptRead({ kind: "authorized", readId: reasonRead, baseline: newShipmentBaselineFrom({ ...reasonSource, customer: { ...reasonSource.customer, creditHold: true } }), editable: true }, reasoned.clean);
    reasoned.binding.change(d => ({ ...d, selected: selected(), creditHoldReason: " " }));
    expect(prepareNewShipmentSave(reasoned.binding, "refused")).toEqual({ kind: "invalid", error: "A reason is required to override the credit hold.",
      fieldIds: [SHIPMENT_BOX.creditHoldReason] });
  });
  it("sends a blank Tare each box as null, and a figure the screen's own check lets through as typed", () => {
    const sent = (tareEach: string) => {
      const h = open();
      h.binding.change(d => ({ ...d, selected: [{ ...selected()[0], containers: [{ ...selected()[0].containers[0], tareEach }] }] }));
      const submission = ready(h.binding, `tare-${tareEach}`); if (!submission) throw new Error("not ready");
      return submission.payload.orders[0].containers;
    };
    expect(sent("  ")).toEqual([{ orderContainerId: "container-1", count: 2, tareEach: null }]);
    expect(sent("42.")).toEqual([{ orderContainerId: "container-1", count: 2, tareEach: "42." }]);
  });
  it("the recovery notice lists a container's count and then its tare each", () => {
    const h = open();
    const preview = newShipmentRecoveryAdapter.preview({ ...h.clean, selected: selected() }, h.baseline);
    expect(preview.filter(row => row.label.startsWith("Order #701 container 1 "))).toEqual([
      { label: "Order #701 container 1 count", value: "02" }, { label: "Order #701 container 1 tare each", value: " 42.50 " },
    ]);
  });
  it("the recovery notice still calls a line's weight box weight, beside quantity and close short", () => {
    // Kept (the weights design §11.3, K27c): the label follows the box's spoken name, which stays.
    const h = open();
    const preview = newShipmentRecoveryAdapter.preview({ ...h.clean, selected: selected() }, h.baseline);
    expect(preview.filter(row => row.label.startsWith("Order #701 line 1 "))).toEqual([
      { label: "Order #701 line 1 quantity", value: "08" }, { label: "Order #701 line 1 weight", value: " 40.00 " },
      { label: "Order #701 line 1 close short", value: "false" },
    ]);
  });
  it("omits blank optional numerics and sends credit override only when actually active", () => {
    const h = open(); h.binding.change(d => ({ ...d, selected: selected(), freightAmount: "  ", packageCount: "\t", creditHoldReason: " dormant reason " }));
    const submission = ready(h.binding); if (!submission) return;
    const wire = JSON.parse(JSON.stringify(submission.payload)); expect(wire).not.toHaveProperty("freightAmount"); expect(wire).not.toHaveProperty("packageCount"); expect(wire).not.toHaveProperty("creditHoldReason");
    const heldHarness = open(); const held = source(); held.customer.creditHold = true;
    heldHarness.binding.acceptRead({ kind: "authorized", readId: heldHarness.binding.beginRead(), baseline: newShipmentBaselineFrom(held), editable: true }, heldHarness.clean);
    heldHarness.binding.change(d => ({ ...d, selected: selected(), creditHoldReason: " actual override " })); const heldSubmission = ready(heldHarness.binding, "held");
    if (heldSubmission) expect(heldSubmission.payload.creditHoldReason).toBe("actual override");
  });
  for (const warnings of [[], ["Review load quantities", "Review serial coverage"]]) it(`records detached success with ${warnings.length} warnings and never recreates the submitted form`, async () => {
    const h = open(); h.binding.change(d => ({ ...d, selected: selected() })); const held = deferred<ShipmentCreateResult>(); const writes: ShipmentBody[] = [];
    let onPage = true; const navigation: string[] = [];
    const save = runNewShipmentSave({ binding: h.binding, requestId: "held", write: b => { writes.push(b); return held.promise; }, persisted: r => { if (onPage) navigation.push(r.shipper.id); } });
    expect(writes).toHaveLength(1); h.detach(); onPage = false; held.resolve(result(warnings)); await save;
    h.binding.attach("return"); const id = h.binding.beginRead(); h.binding.acceptRead({ kind: "authorized", readId: id, baseline: receiptBaseline(), editable: false }, h.clean);
    expect(h.binding.getSnapshot().completed).toEqual({ id: "created-1", shipperNumber: 702, warnings });
    expect(h.binding.getSnapshot().current).toBeUndefined(); expect(navigation).toEqual([]); expect(writes).toHaveLength(1);
    expect(prepareNewShipmentSave(h.binding, "accidental-second").kind).not.toBe("ready");
  });
  it("acknowledges raw success before a throwing UI callback and preserves later input only as reference", async () => {
    const h = open(); h.binding.change(d => ({ ...d, selected: selected(), comments: "submitted" })); const held = deferred<ShipmentCreateResult>();
    const saving = runNewShipmentSave({ binding: h.binding, requestId: "late", write: () => held.promise, persisted: () => { throw new Error("UI failed"); } });
    h.binding.change(d => ({ ...d, comments: "later PRIVATE input" })); held.resolve(result()); await saving.catch(() => {});
    expect(h.binding.getSnapshot().completed).toEqual({ id: "created-1", shipperNumber: 702, warnings: ["Review load quantities", "Review missing serial coverage"] });
    expect(h.binding.getSnapshot().reference?.data.comments).toBe("later PRIVATE input"); expect(h.binding.getSnapshot().canRestore).toBe(false);
  });
  it("the existing automatic 409 retry reuses the original object and settles the raw successful response", async () => {
    const h = open(); h.binding.change(d => ({ ...d, selected: selected() })); const writes: ShipmentBody[] = [];
    await runNewShipmentSave({ binding: h.binding, requestId: "retry-409", write: async b => { writes.push(b); if (writes.length === 1) throw new ApiError("conflict", 409); return result(["Actual replay warning"]); }, persisted: () => {} });
    expect(writes).toHaveLength(2); expect(writes[1]).toBe(writes[0]); expect(writes[0].clientRequestId).toBe(seed.clientRequestId);
    expect(h.binding.getSnapshot().completed?.warnings).toEqual(["Actual replay warning"]);
  });
  it("retains every raw field after a known API rejection without offering unknown replay", async () => {
    const h = open(); h.binding.change(d => ({ ...d, selected: selected(), comments: "raw input" })); const before = h.binding.getSnapshot().current!.data; const write = vi.fn(async () => { throw new ApiError("Validation refused", 400); });
    await runNewShipmentSave({ binding: h.binding, requestId: "rejected", write, persisted: () => {} });
    expect(write).toHaveBeenCalledTimes(1); expect(h.binding.getSnapshot().current?.data).toEqual(before); expect(h.binding.getSnapshot().completed).toBeUndefined();
    expect((h.binding.getSnapshot() as { canRetryUnknown?: boolean }).canRetryUnknown).not.toBe(true);
  });
  it("only explicitly retries unknown changed-source creation using its original body", async () => {
    const h = open(); h.binding.change(d => ({ ...d, selected: selected(), comments: "ORIGINAL" })); const writes: ShipmentBody[] = [];
    await runNewShipmentSave({ binding: h.binding, requestId: "lost", write: async b => { writes.push(b); throw new TypeError("connection lost"); }, persisted: () => {} });
    expect(writes).toHaveLength(1); const original = writes[0]; const fresh = source(); fresh.orders[0].status = "SHIPPED"; fresh.orders[0].orderLineShippedToDate[0].shippedToDateQty = 10;
    h.detach(); h.binding.attach("return"); const id = h.binding.beginRead(); h.binding.acceptRead({ kind: "authorized", readId: id, baseline: newShipmentBaselineFrom(fresh), editable: true }, h.clean);
    const view = h.binding.getSnapshot() as EditorView<NewShipmentDraft, NewShipmentBaseline, ShipmentCreationReceipt> & { canRetryUnknown?: boolean };
    expect(view.mode).toBe("conflict"); expect(view.canRestore).toBe(false); expect(view.canRetryUnknown).toBe(true); expect(writes).toHaveLength(1);
    const retry = await runNewShipmentRetry({ binding: h.binding, stamp: view.current!.stamp, readId: id, requestId: "explicit-retry", write: async b => { writes.push(b); return result(["Fresh replay warning", "Another actual warning"]); }, persisted: () => {} });
    expect(retry.kind).toBe("persisted"); expect(writes).toHaveLength(2); expect(writes[1]).toBe(original); expect(writes[1].clientRequestId).toBe(seed.clientRequestId);
    expect(h.binding.getSnapshot().completed?.warnings).toEqual(["Fresh replay warning", "Another actual warning"]);
  });
});

describe("new shipment read callbacks and receipt authorization", () => {
  it("automatically replaces a stale source-order read with a created-record read after held settlement", async () => {
    const h = open(); h.binding.change(d => ({ ...d, selected: selected() })); const submission = ready(h.binding); if (!submission) return; h.binding.dispatched(submission);
    h.detach(); h.binding.attach("returned"); const oldRead = deferred<NewShipmentRead>(); const seen: NewShipmentReadRequirements[] = [];
    const loading = runNewShipmentRead({ binding: h.binding, authorized: () => true, initialize: cleanFromSeed,
      read: async q => { seen.push(q); return q.createdId ? receiptRead() : oldRead.promise; } });
    expect(seen).toHaveLength(1); expect(seen[0].current?.orderIds).toEqual(["order-1"]); expect(h.binding.getSnapshot().current).toBeUndefined();
    h.binding.settle(submission, { kind: "persisted", response: result(["Late warning"]) });
    oldRead.resolve({ kind: "authorized", baseline: h.baseline, editable: true }); await loading;
    expect(seen).toHaveLength(2); expect(seen[1].createdId).toBe("created-1");
    expect(h.binding.getSnapshot().mode).toBe("completed"); expect(h.binding.getSnapshot().completed?.warnings).toEqual(["Late warning"]);
  });
  it("an obsolete read callback does not restart over a separately newer loader", async () => {
    const h = open(); h.binding.change(d => ({ ...d, selected: selected() })); const sub = ready(h.binding); if (!sub) return; h.binding.dispatched(sub);
    h.detach(); h.binding.attach("return"); const old = deferred<NewShipmentRead>(); let oldCalls = 0; let newCalls = 0;
    const first = runNewShipmentRead({ binding: h.binding, authorized: () => true, initialize: cleanFromSeed, read: async () => { oldCalls++; return old.promise; } });
    expect(oldCalls).toBe(1); h.binding.settle(sub, { kind: "persisted", response: result([]) });
    await runNewShipmentRead({ binding: h.binding, authorized: () => true, initialize: cleanFromSeed, read: async q => { newCalls++; expect(q.createdId).toBe("created-1"); return receiptRead(); } });
    const completed = h.binding.getSnapshot(); old.resolve({ kind: "authorized", baseline: h.baseline, editable: true }); await first;
    expect(oldCalls).toBe(1); expect(newCalls).toBe(1); expect(h.binding.getSnapshot()).toBe(completed);
  });
  it("does not mint or publish after authorization changes while actual read callback is pending", async () => {
    const h = open(); const pending = deferred<NewShipmentRead>(); let authorized = true; const init = vi.fn(cleanFromSeed);
    const read = vi.fn(() => pending.promise);
    const loading = runNewShipmentRead({ binding: h.binding, authorized: () => authorized, initialize: init, read });
    expect(read).toHaveBeenCalledTimes(1);
    authorized = false; h.store.beginIdentityCheck(); pending.resolve({ kind: "authorized", baseline: h.baseline, editable: true }); await loading;
    expect(init).not.toHaveBeenCalled(); expect(h.binding.getSnapshot().current).toBeUndefined();
  });
  it("reads a completed shipment directly even when its original source order cannot be read or selected", async () => {
    const paths: string[] = [];
    const access = await readNewShipmentAccess({ seed, createdId: "created-1", reference: { customerId: "forbidden", shipToAddressId: "", carrierId: "", orderIds: ["gone-order"] } }, ["shipping.view"], async path => {
      paths.push(path); if (path === "/api/shippers/created-1") return { shipper: { id: "created-1", shipperNumber: 702, deletedAt: null } }; throw new ApiError("Forbidden", 403);
    });
    expect(access.kind).toBe("authorized"); if (access.kind !== "authorized") return;
    expect(access.baseline).toMatchObject({ kind: "completed", created: { id: "created-1", shipperNumber: 702 }, readableCopies: [] });
    expect(paths).toContain("/api/shippers/created-1"); expect(paths.some(p => p.startsWith("/api/orders?"))).toBe(false);
  });
  it("the actual NewShipment receipt view shows every warning without revealing an unauthorized later-input reference", () => {
    const h = open(); const hiddenReference = { stamp: { key: h.key, generation: 12, version: 1 }, schema: newShipmentRecoveryAdapter.schema, data: { ...h.clean, selected: selected(), comments: "SECRET LATER NOTES" }, baseline: h.baseline };
    const view: EditorView<NewShipmentDraft, NewShipmentBaseline, ShipmentCreationReceipt> = { mode: "completed", savedBaseline: receiptBaseline(), completed: { id: "created-1", shipperNumber: 702, warnings: ["First actual warning", "Second actual warning"] }, reference: hiddenReference, canRestore: false, needsRefresh: false };
    expect(newShipmentRecoveryPreviews(view).referencePreview).toBeUndefined(); rendered.view = view;
    const html = renderToStaticMarkup(<NewShipment />);
    expect(html).toContain("702"); expect(html).toContain("First actual warning"); expect(html).toContain("Second actual warning");
    expect(html).not.toContain("SECRET LATER NOTES"); expect(html).not.toContain(">Save shipment</button>");
    expect(html).toMatch(/(?:View|Go to) shipment/);
  });
});

// Execute the actual committed read effect and its dependency expression. A
// coalesced identity check can finish with the same owner and ready values.
// The changing authorization revision must still schedule the actual loader.
import { readFileSync } from "node:fs";
import ts from "typescript";
it("the actual committed read effect revalidates after coalesced same-user authorization", async () => {
  const path = new URL("../src/app/shipping/new/NewShipment.tsx", import.meta.url);
  const src = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let effect: ts.CallExpression | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(src) === "useEffect" && node.arguments[0]?.getText(src).includes("load()")
      && node.arguments[1]?.getText(src).includes("authorizationRevision")) effect = node;
    ts.forEachChild(node, visit);
  }
  visit(src); expect(effect, "NewShipment needs its committed authorized load effect").toBeDefined(); if (!effect) return;
  const load = vi.fn(async () => {}); const setError = vi.fn();
  function evaluate(expression: ts.Node, authorizationRevision: number) {
    const code = ts.transpileModule(`return (${expression.getText(src)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    return new Function("load", "authorizationRevision", "setError", code)(load, authorizationRevision, setError);
  }
  const before = evaluate(effect.arguments[1], 10) as unknown[];
  const after = evaluate(effect.arguments[1], 11) as unknown[];
  expect(before.some((value, index) => !Object.is(value, after[index]))).toBe(true);
  const cleanup = evaluate(effect.arguments[0], 10)(); if (typeof cleanup === "function") cleanup();
  const cleanupAgain = evaluate(effect.arguments[0], 11)(); await Promise.resolve();
  expect(load).toHaveBeenCalledTimes(2); expect(setError).not.toHaveBeenCalled();
  if (typeof cleanupAgain === "function") cleanupAgain();
});


describe("new shipment explicit context commands", () => {
  it("latest customer choice wins while preserving later typing and original pending submission", async () => {
    const h = open(); h.binding.change(d => ({ ...d, selected: selected(), comments: "submitted" }));
    const sub = ready(h.binding)!; h.binding.dispatched(sub);
    const first = deferred<NewShipmentRead>(); const second = deferred<NewShipmentRead>();
    const a = runNewShipmentCustomer({ binding: h.binding, customerId: "c2", authorized: () => true, read: () => first.promise });
    const b = runNewShipmentCustomer({ binding: h.binding, customerId: "c3", authorized: () => true, read: () => second.promise });
    h.binding.change(d => ({ ...d, comments: "later typed", route: "keep" }));
    const c3 = source(); c3.customer.id = "c3"; c3.orders = [];
    second.resolve({ kind: "authorized", baseline: newShipmentBaselineFrom(c3), editable: true }); expect(await b).toBe(true);
    const c2 = source(); c2.customer.id = "c2"; c2.orders = [];
    first.resolve({ kind: "authorized", baseline: newShipmentBaselineFrom(c2), editable: true }); expect(await a).toBe(false);
    expect(h.binding.getSnapshot().current?.data).toMatchObject({ customerId: "c3", selected: [], shipToAddressId: "", creditHoldReason: "", comments: "later typed", route: "keep" });
    expect(h.binding.getSnapshot().submitted).toBe(sub.submitted); expect(sub.payload.comments).toBe("submitted");
  });
  it("rejects wrong-customer or nonshippable add context without partial publication, naming why (#695)", async () => {
    // A duplicate is refused before anything is read; the other two by the read's own answer.
    const expected = { "wrong-customer": "changed", shipped: "shipped", invoiced: "shipped", duplicate: "stale" } as const;
    for (const cause of ["wrong-customer", "shipped", "invoiced", "duplicate"] as const) {
      const h = open(); if (cause === "duplicate") h.binding.change(d => ({ ...d, selected: selected() }));
      const before = h.binding.getSnapshot().current; const fresh = source();
      if (cause === "wrong-customer") fresh.orders[0].customerId = "other";
      if (cause === "shipped") fresh.orders[0].status = "SHIPPED";
      if (cause === "invoiced") fresh.orders[0].status = "INVOICED";
      const mint = vi.fn(() => "new-row");
      expect(await runNewShipmentAddOrder({ binding: h.binding, orderId: "order-1", authorized: () => true, newKey: mint,
        read: async () => ({ kind: "authorized", baseline: newShipmentBaselineFrom(fresh), editable: true }) }), cause).toBe(expected[cause]);
      expect(h.binding.getSnapshot().current).toBe(before); expect(mint).not.toHaveBeenCalled();
    }
  });
  it("a failed read is unavailable, and an answer the page has moved past is stale (#695)", async () => {
    const failed = open();
    expect(await runNewShipmentAddOrder({ binding: failed.binding, orderId: "order-1", authorized: () => true, newKey: () => "unused",
      read: async () => { throw new Error("offline"); } })).toBe("unavailable");
    expect(failed.binding.getSnapshot().mode).toBe("unavailable");
    const moved = open(); const before = moved.binding.getSnapshot().current;
    expect(await runNewShipmentAddOrder({ binding: moved.binding, orderId: "order-1", authorized: () => false, newKey: () => "unused",
      read: async () => ({ kind: "authorized", baseline: newShipmentBaselineFrom(source()), editable: true }) })).toBe("stale");
    expect(moved.binding.getSnapshot().current).toBe(before);
  });
  it("adds from actual fresh remaining quantities and keeps raw typing during its await", async () => {
    const h = open(); const pending = deferred<NewShipmentRead>(); let key = 0;
    const add = runNewShipmentAddOrder({ binding: h.binding, orderId: "order-1", authorized: () => true, newKey: () => `new-${++key}`, read: () => pending.promise });
    h.binding.change(d => ({ ...d, comments: "typed while reading" }));
    pending.resolve({ kind: "authorized", baseline: newShipmentBaselineFrom(source()), editable: true }); expect(await add).toBe("added");
    const data = h.binding.getSnapshot().current!.data;
    expect(data.comments).toBe("typed while reading"); expect(data.selected[0].lines[0]).toMatchObject({ qty: "8", weight: "40", key: "new-1" });
    // The container row is the order's row as Add order prefills it: its number of containers and its tare each.
    expect(data.selected[0].containers).toEqual([{ key: "new-3", isNew: true, orderContainerId: "container-1", count: "2", tareEach: "42.5" }]);
    expect(data.selected[0].serials[0].printOnShipper).toBe("true");
  });
  it("removes only owned order context synchronously, without adding fresh facts", () => {
    const h = open(); h.binding.change(d => ({ ...d, selected: selected(), comments: "keep", shipToAddressId: "address-1" }));
    expect(runNewShipmentRemoveOrder(h.binding, "missing")).toBe(false);
    expect(runNewShipmentRemoveOrder(h.binding, "order-1")).toBe(true);
    expect(h.binding.getSnapshot().current?.data).toMatchObject({ selected: [], comments: "keep", shipToAddressId: "address-1" });
    expect(h.binding.getSnapshot().current?.baseline).toEqual(newShipmentBaselineFrom({ ...source(), orders: [] }));
  });
});


describe("new shipment follow-up boundaries", () => {
  // Owner ruling R22 (#696): Add order reads the header context and the new order alone. An order
  // already on the form is neither read again nor compared, so a change to it no longer refuses the
  // add, and the form keeps it as it was last read until the next full read or Save.
  it("adds over a changed existing order and keeps that order as it was last read", async () => {
    const h = open(); h.binding.change(d => ({ ...d, selected: selected() }));
    const fresh = source(); fresh.orders.push({ ...structuredClone(fresh.orders[0]), id: "order-2", orderNumber: 702 });
    fresh.orders[0].orderLineShippedToDate[0].shippedToDateQty = 9;
    expect(await runNewShipmentAddOrder({ binding: h.binding, orderId: "order-2", authorized: () => true, newKey: () => "new-key",
      read: async () => ({ kind: "authorized", baseline: newShipmentBaselineFrom(fresh), editable: true }) })).toBe("added");
    const after = h.binding.getSnapshot().current!;
    expect(after.data.selected.map(o => o.orderId)).toEqual(["order-1", "order-2"]);
    expect(after.data.selected[0]).toEqual(selected()[0]);
    if (after.baseline.kind !== "form") throw new Error("form baseline expected");
    expect(after.baseline.source.orders.map(o => o.id)).toEqual(["order-1", "order-2"]);
    // Not rebased: order 1's ledger is the one read before, not the 9 the add's read carried.
    expect(after.baseline.source.orders[0].orderLineShippedToDate[0].shippedToDateQty).toBe(2);
  });
  it("asks for the new order alone, beside the header context", async () => {
    const h = open(); h.binding.change(d => ({ ...d, selected: selected(), shipToAddressId: "address-1", carrierId: "carrier-1" }));
    const fresh = source(); fresh.orders = [{ ...structuredClone(fresh.orders[0]), id: "order-2", orderNumber: 702 }];
    const read = vi.fn<(q: NewShipmentReadRequirements) => Promise<NewShipmentRead>>(async () => ({ kind: "authorized", baseline: newShipmentBaselineFrom(fresh), editable: true }));
    expect(await runNewShipmentAddOrder({ binding: h.binding, orderId: "order-2", authorized: () => true, newKey: () => "new-key", read })).toBe("added");
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][0].current).toMatchObject({ customerId: "c1", shipToAddressId: "address-1", carrierId: "carrier-1", orderIds: ["order-2"] });
    // The read held order 2 alone; the form still renders order 1 from the baseline it already had.
    const after = h.binding.getSnapshot().current!;
    if (after.baseline.kind !== "form") throw new Error("form baseline expected");
    expect(after.baseline.source.orders.map(o => o.id)).toEqual(["order-1", "order-2"]);
  });
  it("clears customer-owned scope synchronously without a read or loss of neutral header typing", async () => {
    const h = open(); h.binding.change(d => ({ ...d, selected: selected(), shipToAddressId: "address-1", creditHoldReason: "reason", comments: "keep" }));
    const read = vi.fn(async (): Promise<NewShipmentRead> => ({ kind: "unavailable" }));
    const clearing = runNewShipmentCustomer({ binding: h.binding, customerId: "", authorized: () => true, read });
    expect(h.binding.getSnapshot().current?.data).toMatchObject({ customerId: "", selected: [], shipToAddressId: "", creditHoldReason: "", comments: "keep" });
    expect(read).not.toHaveBeenCalled(); expect(await clearing).toBe(true);
  });
  it("refuses a context whose new carrier membership cannot validate later selected header intent", async () => {
    const h = open(); const pending = deferred<NewShipmentRead>();
    const adding = runNewShipmentAddOrder({ binding: h.binding, orderId: "order-1", authorized: () => true, newKey: () => "unused", read: () => pending.promise });
    h.binding.change(d => ({ ...d, carrierId: "carrier-1", comments: "typed" })); const before = h.binding.getSnapshot().current;
    const fresh = source(); fresh.carriers = []; pending.resolve({ kind: "authorized", baseline: newShipmentBaselineFrom(fresh), editable: true });
    expect(await adding).toBe("changed"); expect(h.binding.getSnapshot().current).toBe(before);
  });
  for (const field of ["customerCode", "customerName", "carrierName", "addressName", "partNumber", "partName", "containerType", "serial", "serialDescription"] as const) {
    it(`rejects malformed display shape ${field} before any render projection`, () => {
      const raw = source(); const malformed = { impossible: "render object" } as unknown as string;
      if (field === "customerCode") raw.customer.code = malformed;
      if (field === "customerName") raw.customer.name = malformed;
      if (field === "carrierName") raw.carriers[0].name = malformed;
      if (field === "addressName") raw.addresses[0].name = malformed;
      if (field === "partNumber") raw.orders[0].lines[0].part.partNumber = malformed;
      if (field === "partName") raw.orders[0].lines[0].part.name = malformed;
      if (field === "containerType") raw.orders[0].containers[0].type.name = malformed;
      if (field === "serial") raw.orders[0].serials[0].serial = malformed;
      if (field === "serialDescription") raw.orders[0].serials[0].description = malformed;
      expect(newShipmentRecoveryAdapter.valid(newShipmentDraftFrom(seed), newShipmentBaselineFrom(raw))).toBe(false);
    });
  }
  it("the actual hidden authorization view never displays retained customer catalog labels", () => {
    rendered.view = { mode: "loading", canRestore: false, needsRefresh: false };
    rendered.catalogs = [{ id: "old-customer", code: "SECRET CODE", name: "SECRET CUSTOMER NAME", creditHold: false, shippingNotes: "SECRET NOTES" }];
    const html = renderToStaticMarkup(<NewShipment />);
    expect(html).not.toContain("SECRET");
  });
  it("previews show user values with human labels without internal nonce/default/row-key fields", () => {
    const h = open(); const data = { ...h.clean, route: " raw route ", comments: "raw comment", selected: selected() };
    const preview = newShipmentRecoveryAdapter.preview(data, h.baseline);
    expect(preview).toContainEqual({ label: "Comments", value: "raw comment" });
    const serialized = JSON.stringify(preview);
    expect(serialized).toContain("08"); expect(serialized).not.toContain(seed.clientRequestId);
    expect(serialized).not.toContain("uuid-line-1"); expect(serialized).not.toContain("defaultShipDate");
  });
});

it("the actual readContext rejects a different fresh me identity before catalog reads or adoption", async () => {
  const h = open(); const path = new URL("../src/app/shipping/new/NewShipment.tsx", import.meta.url);
  const src = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "readContext" && node.initializer
      && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(src); expect(callback).toBeDefined(); if (!callback) return;
  const api = vi.fn(async () => ({ id: "foreign-user", permissions: source().permissions }));
  const readAccess = vi.fn(async (): Promise<NewShipmentRead> => ({ kind: "authorized", baseline: h.baseline, editable: true }));
  const session = { store: h.store, readAuthorizationTicket: () => ({}), isReadAuthorized: () => true };
  const code = ts.transpileModule(`return (${callback.getText(src)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const read = new Function("api", "getBrowserDraftSession", "readNewShipmentAccess", code)(api, () => session, readAccess) as (q: NewShipmentReadRequirements) => Promise<NewShipmentRead>;
  await runNewShipmentRead({ binding: h.binding, read, initialize: cleanFromSeed, authorized: () => true });
  expect(api).toHaveBeenCalledTimes(1); expect(api).toHaveBeenCalledWith("/api/auth/me"); expect(readAccess).not.toHaveBeenCalled();
  expect(h.binding.getSnapshot().current).toBeUndefined(); expect(h.binding.getSnapshot().mode).toBe("unavailable");
});

it("reads the actual order-detail voided DTO and refuses a voided or missing-status order", async () => {
  const fixture = source();
  // OrderDetail/readDetail returns voided, not the database's deletedAt field.
  const actual = { ...fixture.orders[0], voided: false } as Record<string, unknown>;
  delete actual.deletedAt;
  const q: NewShipmentReadRequirements = { seed, current: { customerId: "c1", shipToAddressId: "address-1", carrierId: "carrier-1", orderIds: ["order-1"] } };
  const read = vi.fn(async (path: string): Promise<unknown> => {
    if (path === "/api/customers/c1") return fixture.customer;
    if (path === "/api/customers/c1/addresses") return fixture.addresses;
    if (path === "/api/picklists/carrier") return fixture.carriers;
    if (path === "/api/orders/order-1") return actual;
    throw new Error(`Unexpected endpoint ${path}`);
  });
  const allowed = await readNewShipmentAccess(q, fixture.permissions, read);
  expect(allowed.kind).toBe("authorized");
  expect(read).toHaveBeenCalledWith("/api/orders/order-1");
  if (allowed.kind === "authorized") expect(allowed.baseline).toMatchObject({ kind: "form", source: { orders: [{ id: "order-1", voided: false }] } });
  actual.voided = true; expect((await readNewShipmentAccess(q, fixture.permissions, read)).kind).toBe("unavailable");
  delete actual.voided; expect((await readNewShipmentAccess(q, fixture.permissions, read)).kind).toBe("unavailable");
});

// #239 item C2b. `disabled={saving || createGate.disabled || holdBlocked}` knew about the
// `shipping.create` permission and the §5.4 credit hold, and nothing about whether a customer had
// been picked — while every other control on the form waits for one. Pressing it on a blank form
// reached `validate`, which refuses for the first thing it happens to notice ("A shipment needs at
// least one line with a positive quantity"), naming a grid the operator cannot even reach yet.
describe("C2b — Save shipment waits for a customer", () => {
  /** An editing view of the form at the state it actually opens in: authorized, no customer picked,
   *  so the baseline carries `customer: null` and no addresses, carriers or orders of its own. */
  function blankForm(permissions = ["shipping.create", "shipping.view", "customers.view", "orders.view"]) {
    const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
    const binding = store.bind({ owner, record: { kind: "new-shipment", id: "new" }, editor: newShipmentRecoveryAdapter.kind },
      { label: "New shipment", href: "/shipping/new" }, newShipmentRecoveryAdapter);
    binding.attach("first");
    const baseline = newShipmentBaselineFrom({ permissions, customer: null, addresses: [], carriers: [], orders: [] });
    binding.acceptRead({ kind: "authorized", readId: binding.beginRead(), baseline, editable: true }, newShipmentDraftFrom(seed));
    return binding;
  }
  /** The Save shipment button's own tag, found by the label it carries. */
  function saveButton(html: string): string {
    const tag = /<button[^>]*>Save shipment<\/button>/.exec(html)?.[0];
    expect(tag, "Save shipment button").toBeDefined();
    return tag!;
  }

  it("disables it, and says why, while no customer is picked", () => {
    rendered.view = blankForm().getSnapshot();
    const html = renderToStaticMarkup(<NewShipment />);
    // The form is genuinely on screen and editable — this is the blank editing state, not a
    // loading or refused one in which every control would be absent or dead for another reason.
    expect(html).toContain('aria-label="Customer"');
    expect(html).toContain("Pick a customer to add their orders.");
    const save = saveButton(html);
    expect(save).toContain('disabled=""');
    expect(save).toContain('title="Pick a customer first"');
  });

  it("releases it once a customer is picked", () => {
    const h = open(); // its clean draft already carries customerId "c1", the fixture customer
    rendered.view = h.binding.getSnapshot();
    const save = saveButton(renderToStaticMarkup(<NewShipment />));
    expect(save).not.toContain('disabled=""');
    expect(save).not.toContain("Pick a customer first");
  });

  // The permission refusal is the one the actor cannot do anything about, so it keeps precedence
  // over the field they can fill in — asserted in both directions so neither title can swallow the
  // other by accident.
  it("still names the missing permission first when both are true", () => {
    rendered.view = blankForm(["shipping.view", "customers.view", "orders.view"]).getSnapshot();
    const save = saveButton(renderToStaticMarkup(<NewShipment />));
    expect(save).toContain('disabled=""');
    expect(save).toContain("shipping.create");
    expect(save).not.toContain("Pick a customer first");
  });
});

it("reads an order whose container row has no tare each, and refuses one whose tare each is text", async () => {
  const fixture = source();
  const q: NewShipmentReadRequirements = { seed, current: { customerId: "c1", shipToAddressId: "address-1", carrierId: "carrier-1", orderIds: ["order-1"] } };
  /** The form's read of the order, whose one container row carries this tare each. */
  const read = (tareEach: unknown) => readNewShipmentAccess(q, fixture.permissions, async (path) => {
    if (path === "/api/customers/c1") return fixture.customer;
    if (path === "/api/customers/c1/addresses") return fixture.addresses;
    if (path === "/api/picklists/carrier") return fixture.carriers;
    if (path === "/api/orders/order-1") return { ...fixture.orders[0], containers: [{ ...fixture.orders[0].containers[0], tareEach }] };
    throw new Error(`Unexpected endpoint ${path}`);
  });
  expect((await read(null)).kind).toBe("authorized");
  expect((await read("42.5")).kind).toBe("unavailable");
});
