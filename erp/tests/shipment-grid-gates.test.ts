// The saved shipment page's gates that Task 4 of #472 added: which title a grid's controls show,
// the blank override reason, what the Add order select says, and why an Add picker is empty. The
// first and the last of those take the grid's mode since #483. The first four blocks are pure. The
// last two read ShipmentDetail.tsx: one runs the page's own candidates effect, lifted out of its
// syntax tree (the remaining-bulk-callbacks shape), because vitest has no DOM and nothing renders
// that page whole.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { gate, type Gate } from "@/lib/permission-ui";
import { makeLatestGate } from "@/lib/use-latest";
import {
  DRAFT_RECOVERY_TITLE, OVERRIDE_REASON_REQUIRED, addOrderSelect, gridGate, pickerEmptyReason, reasonRequiredGate,
  type AddableState,
} from "@/lib/shipment-gates";
import {
  CHECKING_ACCESS, DRAFT_RECOVERY_MESSAGES, EDITOR_NOT_LOADED, EDITOR_UNAVAILABLE, type EditorMode,
} from "@/lib/draft-recovery-words";
import { shipmentContainersBaseline, shipmentLinesBaseline, shipmentSerialsBaseline } from "@/lib/shipment-bulk-recovery";
import { shipmentFixture } from "./helpers/remaining-bulk-fixtures";

const OPEN: Gate = { allowed: true, disabled: false, title: undefined };
const closed = (title: string): Gate => ({ allowed: false, disabled: true, title });
const VOIDED = closed("Shipment is voided");
const HOLD = closed("ACME · Acme Heat is on credit hold — adding orders or changing lines requires the override_credit_hold action");
const NO_EDIT = gate([], "shipping.edit");
const ORDERS = gate(["orders.view"], "orders.view");
const NO_ORDERS = gate([], "orders.view");
/** The ten modes, from the record tests/draft-recovery-words.test.tsx pins against a literal list. */
const MODES = Object.keys(DRAFT_RECOVERY_MESSAGES) as EditorMode[];

describe("gridGate: which title a grid's controls show", () => {
  it("covers the ten modes", () => {
    expect(MODES).toHaveLength(10);
  });

  it("is the page gate itself while the page gate is open and the grid is editing", () => {
    expect(gridGate(OPEN, "editing")).toBe(OPEN);
  });

  it.each([
    ["voided", VOIDED],
    ["a credit hold without the override", HOLD],
    ["no shipping.edit", NO_EDIT],
  ])("keeps a closed page gate's own reason, in every mode: %s", (_name, pageGate) => {
    // The grid is not editable for the very reason the page gate is closed. A sentence of the
    // grid's own over it would send the viewer to the wrong place.
    for (const mode of MODES) expect(gridGate(pageGate, mode), mode).toBe(pageGate);
  });

  // Under an open page gate, each mode but editing closes the gate with a title of the grid's own.
  const titles: [EditorMode, string, string][] = [
    ["loading", CHECKING_ACCESS, "the notice's first sentence"],
    ["unavailable", EDITOR_UNAVAILABLE, "the notice's first sentence"],
    ["error", EDITOR_NOT_LOADED,
      "the notice's first sentence, reached only where draft-store.ts sets `failed`: data that fails a validity check (including :326's recomputation after a discard), or a clean copy after a discard that is dirty (:342); :340 is a catch around cleanAfterDiscard, which no bulk grid's adapter defines"],
    ["offer", DRAFT_RECOVERY_TITLE, "the draft-recovery title"],
    ["conflict", DRAFT_RECOVERY_TITLE, "the draft-recovery title"],
    ["blocked-two-copies", DRAFT_RECOVERY_TITLE, "the draft-recovery title"],
    ["pending", DRAFT_RECOVERY_TITLE, "the draft-recovery title"],
    ["unknown", DRAFT_RECOVERY_TITLE, "the draft-recovery title"],
    ["completed", DRAFT_RECOVERY_TITLE,
      "unreachable for bulk grids: the adapter's settle returns only keep (bulk-grid-recovery.ts:145-150)"],
  ];

  it("names every mode but editing once in the table below", () => {
    expect([...titles.map(([mode]) => mode), "editing"].sort()).toEqual([...MODES].sort());
  });

  it.each(titles)("under an open page gate, %s reads %j: %s", (mode, title) => {
    expect(gridGate(OPEN, mode)).toEqual({ allowed: false, disabled: true, title });
  });

  it("the three modes with no draft to show take the notice's own first sentence, in its words", () => {
    expect(gridGate(OPEN, "loading").title).toBe("Checking access to this editor…");
    expect(gridGate(OPEN, "unavailable").title).toBe("This editor is unavailable.");
    expect(gridGate(OPEN, "error").title).toBe("This editor could not be loaded.");
    expect(DRAFT_RECOVERY_TITLE).toBe("Resolve draft recovery before editing.");
  });
});

describe("reasonRequiredGate: the blank override reason", () => {
  it("closes an open gate with Add order's sentence while a required reason is blank", () => {
    expect(reasonRequiredGate(OPEN, true, "")).toEqual({
      allowed: false, disabled: true, title: "A reason is required to override the credit hold",
    });
    expect(OVERRIDE_REASON_REQUIRED).toBe("A reason is required to override the credit hold");
  });

  it("whitespace is blank", () => {
    expect(reasonRequiredGate(OPEN, true, " \t ").title).toBe(OVERRIDE_REASON_REQUIRED);
  });

  it("a typed reason leaves the gate as it was handed", () => {
    expect(reasonRequiredGate(OPEN, true, " phone approval ")).toBe(OPEN);
  });

  it("asks for nothing when no reason is required: no hold, or no override to give one with", () => {
    expect(reasonRequiredGate(OPEN, false, "")).toBe(OPEN);
  });

  it("leaves a closed gate alone, so voided, the pair, the permission and the invoice keep their own reason", () => {
    expect(reasonRequiredGate(VOIDED, true, "")).toBe(VOIDED);
    expect(reasonRequiredGate(HOLD, true, "")).toBe(HOLD);
  });
});

describe("addOrderSelect: what the Add order select says", () => {
  const select = (over: Partial<Parameters<typeof addOrderSelect>[0]> = {}) =>
    addOrderSelect({ gate: OPEN, ordersGate: ORDERS, state: "ready", count: 2, ...over });

  it("offers the list once it has loaded with orders in it", () => {
    expect(select()).toEqual({ disabled: false, title: undefined, placeholder: "Choose an order…" });
  });

  it("says there is nothing to add only after a read that offered nothing", () => {
    expect(select({ count: 0 })).toEqual({ disabled: true, title: undefined, placeholder: "No unshipped orders for this customer" });
  });

  it.each<[AddableState, string]>([
    ["loading", "Loading orders…"],
    ["failed", "Orders could not be loaded"],
  ])("while the read is %s it is closed and says so, whatever an older list holds", (state, placeholder) => {
    expect(select({ state, count: 0 })).toEqual({ disabled: true, title: undefined, placeholder });
    expect(select({ state, count: 2 })).toEqual({ disabled: true, title: undefined, placeholder });
  });

  it("without orders.view it is closed and names the permission, in its title and its first option", () => {
    // The page never starts the read without the permission, so the state stays "loading" for
    // good. The permission is asked first, or the select would say "Loading orders…" for ever.
    for (const state of ["loading", "ready", "failed"] as const) {
      expect(select({ ordersGate: NO_ORDERS, state, count: 0 }), state)
        .toEqual({ disabled: true, title: "Requires orders.view", placeholder: "Requires orders.view" });
    }
  });

  it("a closed lines gate wins the title, and the first option still tells the truth about the list", () => {
    expect(select({ gate: VOIDED })).toEqual({ disabled: true, title: "Shipment is voided", placeholder: "Choose an order…" });
    expect(select({ gate: VOIDED, state: "failed", count: 0 }))
      .toEqual({ disabled: true, title: "Shipment is voided", placeholder: "Orders could not be loaded" });
    expect(select({ gate: VOIDED, ordersGate: NO_ORDERS, state: "loading", count: 0 }))
      .toEqual({ disabled: true, title: "Shipment is voided", placeholder: "Requires orders.view" });
  });
});

describe("pickerEmptyReason: why an Add picker has nothing in it", () => {
  const order = { id: "so-1", orderId: "order-1" };
  const projections = [shipmentLinesBaseline, shipmentContainersBaseline, shipmentSerialsBaseline];

  it("names the permission, in gate()'s own words, when the order's catalog was not read", () => {
    expect(pickerEmptyReason({ order, catalogAuthorized: false }, "editing")).toBe("Requires orders.view");
    expect(pickerEmptyReason({ order, catalogAuthorized: false }, "editing")).toBe(gate([], "orders.view").title);
  });

  it("gives no reason when the catalog was read: the view's own sentence is then true", () => {
    expect(pickerEmptyReason({ order, catalogAuthorized: true }, "editing")).toBeUndefined();
  });

  it("with a baseline, the mode changes nothing", () => {
    for (const mode of MODES) {
      expect(pickerEmptyReason({ order, catalogAuthorized: false }, mode), mode).toBe("Requires orders.view");
      expect(pickerEmptyReason({ order, catalogAuthorized: true }, mode), mode).toBeUndefined();
    }
  });

  it("before a baseline is accepted, follows the grid's mode with its notice's first sentence (#483 c)", () => {
    expect(pickerEmptyReason(undefined, "loading")).toBe(CHECKING_ACCESS);
    expect(pickerEmptyReason(undefined, "unavailable")).toBe(EDITOR_UNAVAILABLE);
    expect(pickerEmptyReason(undefined, "error")).toBe(EDITOR_NOT_LOADED);
    // The other seven modes carry a baseline whenever they are reached; with none, nothing is said.
    const others = MODES.filter(m => m !== "loading" && m !== "unavailable" && m !== "error");
    expect(others).toHaveLength(7);
    for (const mode of others) expect(pickerEmptyReason(undefined, mode), mode).toBeUndefined();
  });

  it("gives no reason for an order no longer on the shipment, in any mode", () => {
    for (const mode of MODES) {
      expect(pickerEmptyReason({}, mode), mode).toBeUndefined();
      expect(pickerEmptyReason({ order: null, catalogAuthorized: false }, mode), mode).toBeUndefined();
    }
  });

  it("reads the context each grid's real baseline carries", () => {
    const full = shipmentFixture();
    for (const project of projections) expect(pickerEmptyReason(project(full, "so-1").context, "editing")).toBeUndefined();
    const shippingOnly = shipmentFixture(); shippingOnly.permissions = ["shipping.view", "shipping.edit"];
    for (const project of projections) expect(pickerEmptyReason(project(shippingOnly, "so-1").context, "editing")).toBe("Requires orders.view");
    for (const project of projections) expect(pickerEmptyReason(project(shippingOnly, "so-gone").context, "editing")).toBeUndefined();
  });
});

// ---- the page's own read of the Add order candidates ----

const detailFile = fileURLToPath(new URL("../src/app/shipping/[id]/ShipmentDetail.tsx", import.meta.url));
const detailText = readFileSync(detailFile, "utf8");
const detail = ts.createSourceFile(detailFile, detailText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** The page's one `useEffect(…)` call that reads the Add order candidates: the one whose callback
 *  sets the list. */
function candidatesEffectCall(): ts.CallExpression {
  const found: ts.CallExpression[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect"
      && node.arguments[0]?.getText(detail).includes("setAddableOrders(")) found.push(node);
    ts.forEachChild(node, walk);
  };
  walk(detail);
  expect(found).toHaveLength(1);
  return found[0];
}

/** That effect's callback, closed over `environment` and nothing else. An effect that gains a free
 *  identifier must gain it in `mounted` below in the same change. */
function candidatesEffect(environment: Record<string, unknown>): () => void {
  const code = ts.transpileModule(`return (${candidatesEffectCall().arguments[0].getText(detail)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(environment), code)(...Object.values(environment)) as () => void;
}

type Row = { id: string; orderNumber: number; poNumber: string };
const row = (id: string): Row => ({ id, orderNumber: 1, poNumber: "" });
/** One macrotask: every continuation of the requests settled so far has run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The page as the effect sees it: a customer, `orders.view`, one order already on the shipment,
 *  and every request held open until the test lands or fails it. `run` is one run of the effect;
 *  a second `run` is the re-run after an order was added or removed, on the same ticket gate. */
function mounted(over: Record<string, unknown> = {}) {
  const requests: { lands: (rows: Row[]) => void; fails: (message: string) => void }[] = [];
  const api = vi.fn((url: string) => new Promise<Row[]>((resolve, reject) => {
    void url;
    requests.push({ lands: resolve, fails: (message) => reject(new Error(message)) });
  }));
  const setAddableOrders = vi.fn();
  const setAddableState = vi.fn();
  const addLoadError = vi.fn();
  const environment = {
    addableLatest: makeLatestGate(), customerId: "cust-1", ordersGate: ORDERS, onShipmentOrderIds: "order-1",
    api, setAddableOrders, setAddableState, addLoadError, ...over,
  };
  return {
    run: (again: Record<string, unknown> = {}) => candidatesEffect({ ...environment, ...again })(),
    requests, api, setAddableOrders, setAddableState, addLoadError,
  };
}

describe("ShipmentDetail: the Add order candidates read sets the select's state", () => {
  it("is loading from the moment the request goes out, and ready when the list is set", async () => {
    const s = mounted();
    s.run();
    expect(s.api.mock.calls).toEqual([["/api/orders?customerId=cust-1&status=OPEN,PARTIAL_SHIPPED"]]);
    expect(s.setAddableState.mock.calls).toEqual([["loading"]]);
    s.requests[0].lands([row("order-1"), row("order-2")]);
    await flush();
    // The order already on the shipment is not offered again.
    expect(s.setAddableOrders.mock.calls).toEqual([[[row("order-2")]]]);
    expect(s.setAddableState.mock.calls).toEqual([["loading"], ["ready"]]);
    expect(s.addLoadError).not.toHaveBeenCalled();
  });

  it("is failed when the read fails, and the amber banner still gives the detail", async () => {
    const s = mounted();
    s.run();
    s.requests[0].fails("Request failed (500)");
    await flush();
    expect(s.setAddableState.mock.calls).toEqual([["loading"], ["failed"]]);
    expect(s.addLoadError.mock.calls).toEqual([["Could not load orders available to add: Request failed (500)"]]);
    expect(s.setAddableOrders).not.toHaveBeenCalled();
  });

  it("goes back to loading on every re-read, so an older list is never offered as current", () => {
    const s = mounted();
    s.run();
    s.run({ onShipmentOrderIds: "order-1,order-2" });
    expect(s.setAddableState.mock.calls).toEqual([["loading"], ["loading"]]);
  });

  it.each(["lands", "fails"] as const)("an answer that a newer read replaced sets nothing when it %s", async (settle) => {
    const s = mounted();
    s.run();
    s.run({ onShipmentOrderIds: "order-1,order-2" });
    if (settle === "lands") s.requests[0].lands([row("order-3")]);
    else s.requests[0].fails("late");
    await flush();
    expect(s.setAddableState.mock.calls).toEqual([["loading"], ["loading"]]);
    expect(s.setAddableOrders).not.toHaveBeenCalled();
    expect(s.addLoadError).not.toHaveBeenCalled();
  });

  it.each([
    ["without orders.view", { ordersGate: NO_ORDERS }],
    ["before the shipment has loaded", { customerId: undefined }],
  ])("%s it asks nothing and sets nothing", (_name, over) => {
    const s = mounted(over);
    s.run();
    expect(s.api).not.toHaveBeenCalled();
    expect(s.setAddableState).not.toHaveBeenCalled();
  });

  // Every case above runs the callback by hand, so none of them sees WHEN React runs it. That is
  // the dependency list, and the select depends on it: the list starts as "loading" and is closed
  // until a run of this effect sets "ready". The two early returns above are the two things a run
  // can be waiting for. The shipment gives `customerId`; the permission read gives
  // `ordersGate.allowed`, and it can land second. With that dependency gone nothing would run the
  // effect again, and the list would read "Loading orders…" for a viewer who holds orders.view
  // until the orders on the shipment changed or the page was loaded again.
  it("runs again when the customer, the orders.view answer or the orders on the shipment change", () => {
    const dependencies = candidatesEffectCall().arguments[1];
    expect(dependencies?.getText(detail)).toBe(
      "[customerId, ordersGate.allowed, onShipmentOrderIds, addableLatest, addLoadError]");
  });
});

describe("ShipmentDetail: the Add order select's first option", () => {
  it("is the leaf's placeholder, and the page words none of the five sentences itself", () => {
    expect(detailText.split('<option value="">{addSelect.placeholder}</option>')).toHaveLength(2);
    for (const sentence of [
      "No unshipped orders for this customer", "Loading orders…", "Orders could not be loaded", "Choose an order…",
    ]) expect(detailText, sentence).not.toContain(sentence);
    // "Requires orders.view" is gate()'s, built from the key; the page holds the key and not the sentence.
    expect(detailText).not.toContain("Requires orders.view");
  });
});
