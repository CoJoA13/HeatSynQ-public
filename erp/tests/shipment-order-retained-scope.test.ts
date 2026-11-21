import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { createDraftStore } from "../src/lib/draft-store";
import { createBulkRecoveryAdapter, emptyBulkDraft, type BulkBaseline } from "../src/lib/bulk-grid-recovery";
import { shipmentOrderScope } from "../src/lib/unsaved-guard";

const file = fileURLToPath(new URL("../src/app/shipping/[id]/ShipmentDetail.tsx", import.meta.url));
const sourceText = readFileSync(file, "utf8");
function callback(environment: Record<string, unknown>, removeRecoveryGuard = false) {
  let source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function find(): ts.FunctionDeclaration {
    let result: ts.FunctionDeclaration | undefined;
    function walk(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "removeOrder") {
        if (result) throw new Error("Ambiguous actual removeOrder callback");
        result = node;
      }
      ts.forEachChild(node, walk);
    }
    walk(source); if (!result) throw new Error("Missing actual removeOrder callback"); return result;
  }
  if (removeRecoveryGuard) {
    let initializer: ts.BinaryExpression | undefined;
    function walk(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "panelUnsaved"
        && node.initializer && ts.isBinaryExpression(node.initializer) && node.initializer.operatorToken.kind === ts.SyntaxKind.BarBarToken) initializer = node.initializer;
      ts.forEachChild(node, walk);
    }
    walk(find());
    if (!initializer) throw new Error("Missing exact recovery OR to mutate");
    const mutated = sourceText.slice(0, initializer.getStart(source)) + initializer.left.getText(source) + sourceText.slice(initializer.end);
    source = ts.createSourceFile(file, mutated, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  }
  const text = ts.transpileModule(`return (${find().getText(source)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(environment), text)(...Object.values(environment)) as (id: string, label: string) => Promise<void>;
}
function scenario(removeRecoveryGuard = false) {
  const store = createDraftStore(), owner = store.acceptIdentity(store.beginIdentityCheck(), "shipping-user")!;
  function retained(shipperId: string, shipperOrderId: string, kind: string) {
    const adapter = createBulkRecoveryAdapter<Record<string, string>>(kind, "scope-v1");
    const baseline: BulkBaseline<Record<string, string>> = { rows: [{ id: "saved-row", fields: { value: "saved" } }], context: { shipperId, shipperOrderId } };
    const binding = store.bind({ owner, record: { kind: "shipment", id: shipperId }, editor: kind, childId: shipperOrderId },
      { label: kind, href: `/shipping/${shipperId}`, scope: shipmentOrderScope(shipperOrderId) }, adapter);
    const detach = binding.attach("first");
    binding.acceptRead({ kind: "authorized", readId: binding.beginRead(), baseline, editable: true }, emptyBulkDraft<Record<string, string>>());
    binding.change(current => ({ ...current, edits: new Map([["saved-row", { value: "  retained  " }]]) }));
    detach(); binding.attach("return");
    expect(binding.getSnapshot().current).toBeUndefined();
    binding.acceptRead({ kind: "authorized", readId: binding.beginRead(), baseline, editable: true }, emptyBulkDraft<Record<string, string>>());
    expect(binding.getSnapshot().mode).toBe("offer"); return binding;
  }
  // Remove order asks through the modal (PR 4): `askConfirm` is the question, answered yes.
  const askConfirm = vi.fn(async () => true), api = vi.fn(async () => ({ ok: true })), setError = vi.fn();
  const applyMutation = vi.fn(async (run: () => Promise<unknown>) => { await run(); });
  const unsavedPresentInScope = vi.fn(() => false);
  const removeOrder = callback({ id: "ship-a", shipmentOrderScope, unsavedPresentInScope,
    getBrowserDraftSession: () => ({ store }), askConfirm, api, setError, applyMutation }, removeRecoveryGuard);
  return { store, retained, removeOrder, askConfirm, api, setError, applyMutation, unsavedPresentInScope };
}
async function requiresRefusal(h: ReturnType<typeof scenario>) {
  await h.removeOrder("so-a", "101");
  expect(h.askConfirm).not.toHaveBeenCalled(); expect(h.api).not.toHaveBeenCalled(); expect(h.applyMutation).not.toHaveBeenCalled();
  expect(h.setError).toHaveBeenCalledExactlyOnceWith("Order 101 has unsaved lines, containers or serials on this shipment. Removing it drops those rows, so save them first — or use Discard beside each unsaved grid's Save button.");
}
it.each(["shipment-lines", "shipment-containers", "shipment-serials"])("actual removal refuses retained %s with an empty legacy registry", async kind => {
  const h = scenario(), retained = h.retained("ship-a", "so-a", kind), before = retained.getSnapshot().current;
  await requiresRefusal(h);
  expect(h.unsavedPresentInScope).toHaveBeenCalledWith(shipmentOrderScope("so-a"));
  expect(retained.getSnapshot().current).toBe(before);
});
it("actual removal allows other order scopes and shipment records without discarding them", async () => {
  const h = scenario(), sibling = h.retained("ship-a", "so-b", "shipment-lines"), other = h.retained("ship-other", "so-a", "shipment-serials");
  const siblingBefore = sibling.getSnapshot().current, otherBefore = other.getSnapshot().current;
  await h.removeOrder("so-a", "101");
  expect(h.askConfirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    title: "Remove order 101 from this shipment?", body: "Its lines, containers and serials on this shipment are dropped.", confirm: "Remove order",
  }));
  expect(h.api).toHaveBeenCalledExactlyOnceWith("/api/shippers/ship-a/orders/so-a", { method: "DELETE" });
  expect(h.setError).toHaveBeenLastCalledWith(null);
  expect(sibling.getSnapshot().current).toBe(siblingBefore); expect(other.getSnapshot().current).toBe(otherBefore);
});
it("discarding all three selected grids unblocks removal and keeps another panel's stamp", async () => {
  const h = scenario();
  const selected = ["shipment-lines", "shipment-containers", "shipment-serials"].map(kind => h.retained("ship-a", "so-a", kind));
  const sibling = h.retained("ship-a", "so-b", "shipment-lines"), siblingBefore = sibling.getSnapshot().current;
  await requiresRefusal(h);
  h.store.discard(selected.map(binding => binding.getSnapshot().current!.stamp));
  await h.removeOrder("so-a", "101");
  expect(h.askConfirm).toHaveBeenCalledOnce();
  expect(h.api).toHaveBeenCalledExactlyOnceWith("/api/shippers/ship-a/orders/so-a", { method: "DELETE" });
  expect(sibling.getSnapshot().current).toBe(siblingBefore); expect(h.store.getSnapshot().count).toBe(1);
});
it("the refusal assertion kills removal of only the actual recovery half of the scoped guard", async () => {
  const h = scenario(true); h.retained("ship-a", "so-a", "shipment-lines");
  await expect(requiresRefusal(h)).rejects.toHaveProperty("name", "AssertionError");
  expect(h.api).toHaveBeenCalledExactlyOnceWith("/api/shippers/ship-a/orders/so-a", { method: "DELETE" });
});
