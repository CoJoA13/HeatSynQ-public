import { newShipmentTabForBox } from "@/lib/shipment-tabs";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createDraftStore, type EditorView } from "../src/lib/draft-store";
import { SHIPMENT_BOX, shipmentLineBoxId, shipmentServerRefusalBox } from "../src/lib/shipment-box-ids";
import { ApiError } from "../src/lib/fetcher";
import {
  newShipmentDraftFrom, newShipmentBaselineFrom, newShipmentRecoveryAdapter,
  runNewShipmentRead, runNewShipmentSave,
  type NewShipmentDraft, type NewShipmentBaseline, type NewShipmentSource,
  type ShipmentBody, type ShipmentCreateResult, type ShipmentCreationReceipt,
} from "../src/lib/new-shipment-recovery";

const originalNonce = "3f6a1b2c-1111-4d22-8e33-9f0a1b2c3d4e";
const replacementNonce = "3f6a1b2c-1111-4d22-8e33-9f0a1b2c3d4f";
const seed = { clientRequestId: originalNonce, defaultShipDate: "2026-09-12", defaultFreightTerms: "PREPAID" as const };
function source(): NewShipmentSource {
  return { permissions: ["shipping.create", "shipping.view", "customers.view", "orders.view"],
    customer: { id: "customer", code: "C", name: "Customer", creditHold: false }, addresses: [], carriers: [],
    orders: [{ id: "order", customerId: "customer", orderNumber: 42, poNumber: "PO", customerJobNo: "JOB", status: "OPEN", voided: false,
      lines: [{ id: "line", position: 1, qty: 10, weight: 20, part: { partNumber: "P", name: "Part" } }],
      containers: [], serials: [], orderLineShippedToDate: [{ orderLineId: "line", shippedToDateQty: 0, shippedToDateWeight: 0 }] }] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
// Execute both actual component declarations in the same lexical scope. Only
// external React/router/transport dependencies are supplied; settlement, raw
// projection and both callback bodies are the real production implementations.
function actualSave(environment: Record<string, unknown>): () => Promise<void> {
  const file = new URL("../src/app/shipping/new/NewShipment.tsx", import.meta.url);
  const tree = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = tree.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "NewShipment");
  expect(component?.body, "Actual NewShipment component body").toBeDefined();
  const declarations = ["persisted", "refuseSave", "handleSave"].map(name => {
    const matches = component!.body!.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
    expect(matches, `Actual ${name} callback`).toHaveLength(1);
    return matches[0].getText(tree);
  });
  const code = ts.transpileModule(`${declarations.join("\n")}\nreturn handleSave;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(environment), code)(...Object.values(environment)) as () => Promise<void>;
}
function open() {
  const store = createDraftStore();
  const owner = store.acceptIdentity(store.beginIdentityCheck(), "user")!;
  const binding = store.bind({ owner, record: { kind: "new-shipment", id: "new" }, editor: newShipmentRecoveryAdapter.kind },
    { label: "New shipment", href: "/shipping/new" }, newShipmentRecoveryAdapter);
  binding.attach("same-mounted-component");
  const readId = binding.beginRead();
  expect(binding.acceptRead({ kind: "authorized", readId, baseline: newShipmentBaselineFrom(source()), editable: true },
    { ...newShipmentDraftFrom(seed), customerId: "customer" })).toBe(true);
  binding.change(d => ({ ...d, comments: " original raw notes ", selected: [{ orderId: "order", lines: [
    { key: "line-key", isNew: true, orderLineId: "line", qty: "02", weight: " 4.00 ", lineComplete: "false" },
  ], containers: [], serials: [] }] }));
  const originalStamp = binding.getSnapshot().current!.stamp;
  const held = deferred<ShipmentCreateResult>();
  const api = vi.fn<(path: string, options: { method: string; body: string }) => Promise<ShipmentCreateResult>>(() => held.promise);
  const atNavigation: EditorView<NewShipmentDraft, NewShipmentBaseline, ShipmentCreationReceipt>[] = [];
  const push = vi.fn<(path: string) => void>(() => { atNavigation.push(binding.getSnapshot()); });
  const mounted = { current: true };
  const setError = vi.fn(); const setRefused = vi.fn();
  // The refused box's tab (PR 4): the page asks it open beside `setRefused`.
  const handleSave = actualSave({ binding, saving: false, mounted, setError, setRefused, setRefusedOpen: vi.fn(), refusalSeq: { current: 0 },
    newShipmentTabForBox, setSaving: vi.fn(), shipmentServerRefusalBox,
    runNewShipmentSave, api, router: { push }, newId: () => "one-local-attempt" });
  return { store, binding, originalStamp, held, api, push, mounted, atNavigation, setError, setRefused, handleSave };
}
function response(warnings: readonly string[] = []): ShipmentCreateResult {
  return { shipper: { id: "created-original", shipperNumber: 77 }, warnings };
}
function originalWire(h: ReturnType<typeof open>) {
  expect(h.api).toHaveBeenCalledTimes(1);
  const body: ShipmentBody = { clientRequestId: originalNonce, customerId: "customer", shipToAddressId: null,
    shipDate: "2026-09-12", carrierId: null, route: "", comments: " original raw notes ", billFreight: false,
    freightTerms: "PREPAID", freightClass: "", freightDescription: "", proNumber: "", scacCode: "",
    orders: [{ orderId: "order", lines: [{ orderLineId: "line", qty: 2, weight: "4.00", lineComplete: false }], containers: [], serials: [] }] };
  expect(h.api).toHaveBeenCalledWith("/api/shippers", { method: "POST", body: JSON.stringify(body) });
}

describe("actual NewShipment save continuation ownership", () => {
  it("an exact pending Discard and fresh generation prevent old known200 navigation without touching replacement", async () => {
    const h = open(); const saving = h.handleSave(); originalWire(h);
    const row = h.store.getSnapshot().rows.find(row => row.metadata.href === "/shipping/new")!;
    expect(row.pending).toBe(true); expect(row.stamps).toEqual([h.originalStamp]);
    // Same public stamped operation used by DraftsInTab; the component stays mounted.
    h.store.discard(row.stamps);
    expect(h.binding.getSnapshot().current).toBeUndefined();
    const initialize = vi.fn(() => newShipmentDraftFrom({ ...seed, clientRequestId: replacementNonce }));
    const fresh: NewShipmentSource = { ...source(), customer: null, orders: [] };
    const read = vi.fn(async () => ({ kind: "authorized" as const, editable: true, baseline: newShipmentBaselineFrom(fresh) }));
    expect(await runNewShipmentRead({ binding: h.binding, authorized: () => true, read, initialize })).toMatchObject({ kind: "authorized" });
    expect(initialize).toHaveBeenCalledTimes(1);
    h.binding.change(d => ({ ...d, route: " replacement route ", comments: " replacement private text " }));
    const replacement = h.binding.getSnapshot().current!;
    expect(replacement.stamp.generation).not.toBe(h.originalStamp.generation);
    expect(replacement.data.clientRequestId).toBe(replacementNonce);
    expect(h.store.getSnapshot().count).toBe(1);
    h.held.resolve(response()); await saving;
    originalWire(h); expect(h.mounted.current).toBe(true);
    expect(h.binding.getSnapshot().current).toBe(replacement);
    expect(h.binding.getSnapshot().completed).toBeUndefined();
    expect(h.binding.getSnapshot().reference).toBeUndefined();
    expect(h.store.getSnapshot().count).toBe(1);
    expect(h.push, "A retired request must not navigate away from a new intent").not.toHaveBeenCalled();
  });

  for (const laterEdit of [false, true]) it(`matching-generation no-warning Save keeps native navigation with later edit=${laterEdit}`, async () => {
    const h = open(); const saving = h.handleSave(); originalWire(h);
    if (laterEdit) h.binding.change(d => ({ ...d, comments: " later same-generation input " }));
    const submittedGeneration = h.binding.getSnapshot().current!.stamp.generation;
    expect(submittedGeneration).toBe(h.originalStamp.generation);
    h.held.resolve(response()); await saving;
    originalWire(h);
    expect(h.push).toHaveBeenCalledTimes(1); expect(h.push).toHaveBeenCalledWith("/shipping/created-original");
    expect(h.atNavigation[0].completed).toEqual({ id: "created-original", shipperNumber: 77, warnings: [] });
    expect(h.atNavigation[0].completedStamp?.generation).toBe(h.originalStamp.generation);
    expect(h.binding.getSnapshot().current).toBeUndefined();
    if (laterEdit) expect(h.binding.getSnapshot().reference?.data.comments).toBe(" later same-generation input ");
    else expect(h.binding.getSnapshot().reference).toBeUndefined();
  });

  it("matching known200 preserves every returned warning and later reference without automatic navigation", async () => {
    const h = open(); const saving = h.handleSave(); originalWire(h);
    h.binding.change(d => ({ ...d, comments: " later warning-case input " }));
    h.held.resolve(response(["Review load quantities", "Review serial coverage"])); await saving;
    originalWire(h);
    expect(h.binding.getSnapshot().completed).toEqual({ id: "created-original", shipperNumber: 77,
      warnings: ["Review load quantities", "Review serial coverage"] });
    expect(h.binding.getSnapshot().completedStamp?.generation).toBe(h.originalStamp.generation);
    expect(h.binding.getSnapshot().reference?.data.comments).toBe(" later warning-case input ");
    expect(h.binding.getSnapshot().current).toBeUndefined();
    expect(h.push).not.toHaveBeenCalled();
    expect(h.setError).toHaveBeenCalledTimes(1); expect(h.setError).toHaveBeenCalledWith(null);
  });
});

// Owner ruling R13 (G8-3): a refused Save shows its sentence and names the boxes the cursor jumps
// to and marks. The page's own check names them; a server sentence only when it names a box.
describe("actual NewShipment refused Save", () => {
  it("hands the page's own refusals and their boxes on, and sends nothing", async () => {
    const h = open();
    h.binding.change(d => ({ ...d, freightAmount: "-5", selected: d.selected.map(o => ({ ...o, lines: o.lines.map(l => ({ ...l, weight: "-1" })) })) }));
    await h.handleSave();
    expect(h.api).not.toHaveBeenCalled();
    const message = "Order #42, Line 1, Ship now net weight (lb): cannot be negative.\nFreight amount: cannot be negative.";
    expect(h.setError).toHaveBeenLastCalledWith(message);
    expect(h.setRefused).toHaveBeenLastCalledWith({ message, ids: [shipmentLineBoxId("order", 0, "weight"), SHIPMENT_BOX.freightAmount] });
  });

  it("routes a server refusal that names a box by its path, and leaves any other sentence with no box", async () => {
    for (const [sentence, ids] of [
      ["orders.0.lines.0.weight: cannot be negative.", [shipmentLineBoxId("order", 0, "weight")]],
      ["Order #42: that line does not belong to this order", []],
    ] as const) {
      const h = open();
      h.api.mockImplementationOnce(() => Promise.reject(new ApiError(sentence, 400)));
      await h.handleSave();
      expect(h.setError).toHaveBeenLastCalledWith(sentence);
      expect(h.setRefused).toHaveBeenLastCalledWith({ message: sentence, ids });
    }
  });
});
