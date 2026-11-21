import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { createDraftStore } from "../src/lib/draft-store";
import { createBulkRecoveryAdapter, emptyBulkDraft, type BulkBaseline } from "../src/lib/bulk-grid-recovery";
import type { SerialFields } from "../src/lib/order-bulk-recovery";
import { serialsScope } from "../src/lib/unsaved-guard";
import { ApiError } from "../src/lib/fetcher";
import { unansweredStatus } from "../src/lib/line-field-saves";
import {
  NO_UNCONFIRMED_REMOVALS, alreadyRemovedMessage, removalProvesGone, removalUnanswered, removalUnconfirmed,
  removedNotRefreshedMessage, type UnconfirmedRemovals,
} from "../src/lib/line-removals";
import type { OrderLine } from "../src/app/orders/[id]/page";

const file = fileURLToPath(new URL("../src/app/orders/[id]/LinesSection.tsx", import.meta.url));
const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function actualFunction<T>(name: string, environment: Record<string, unknown>): T {
  let found: ts.FunctionDeclaration | undefined;
  function walk(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      if (found) throw new Error(`Ambiguous production function ${name}`);
      found = node;
    }
    ts.forEachChild(node, walk);
  }
  walk(source);
  if (!found) throw new Error(`Missing production function ${name}`);
  const text = ts.transpileModule(`return (${found.getText(source)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(environment), text)(...Object.values(environment)) as T;
}
const line: OrderLine = {
  id: "line-a", position: 1, partId: "part-a", revisionNumber: 1, qty: 10, weight: 20,
  quoteLineId: null, quoteId: null, quoteNumber: null,
  part: { id: "part-a", partNumber: "P-A", name: "Part A", customer: { code: "ACME" }, serializationRequired: true, eachWeight: 2 },
};
/** `marked` is the record of the line Removes the server did not answer (#475): a Remove of a
 *  marked line is the retry, through the same handler and the same refusal. */
function scenario(marked: readonly string[] = []) {
  const store = createDraftStore();
  const owner = store.acceptIdentity(store.beginIdentityCheck(), "scope-user")!;
  const adapter = createBulkRecoveryAdapter<SerialFields>("order-serials", "order-serials-v1");
  function retained(orderId: string, lineId: string) {
    const baseline: BulkBaseline<SerialFields> = {
      rows: [{ id: `${lineId}-serial`, fields: { serial: "saved serial", description: "saved description" } }],
      context: { orderId, lineId },
    };
    const binding = store.bind({ owner, record: { kind: "order", id: orderId }, editor: adapter.kind, childId: lineId },
      { label: "Serials", href: `/orders/${orderId}`, scope: serialsScope(lineId) }, adapter);
    const detach = binding.attach(`${orderId}/${lineId}/initial`);
    binding.acceptRead({ kind: "authorized", readId: binding.beginRead(), baseline, editable: true }, emptyBulkDraft<SerialFields>());
    binding.change(current => ({ ...current, edits: new Map([[`${lineId}-serial`, { serial: "  retained serial  " }]]) }));
    detach();
    binding.attach(`${orderId}/${lineId}/return`);
    expect(binding.getSnapshot().current).toBeUndefined();
    binding.acceptRead({ kind: "authorized", readId: binding.beginRead(), baseline, editable: true }, emptyBulkDraft<SerialFields>());
    expect(binding.getSnapshot().mode).toBe("offer");
    return binding;
  }
  const askConfirm = vi.fn<(q: object) => Promise<boolean>>(async () => true), api = vi.fn(async () => ({ ok: true })), onError = vi.fn();
  const unsavedPresentInScope = vi.fn(() => false);
  const applyMutation = vi.fn(async (run: () => Promise<unknown>) => { await run(); });
  let removals: UnconfirmedRemovals = marked.length === 0 ? NO_UNCONFIRMED_REMOVALS : new Set(marked);
  const setRemovals = (update: (cur: UnconfirmedRemovals) => UnconfirmedRemovals) => { removals = update(removals); };
  const readAfterRemoval = vi.fn(async () => {});
  const removeLine = actualFunction<(chosen: OrderLine) => Promise<void>>("removeLine", {
    orderId: "order-a", serialsScope, unsavedPresentInScope,
    // Either existing session accessor is acceptable; the callback must query this real store.
    getBrowserDraftSession: () => ({ store }), peekBrowserDraftSession: () => ({ store }),
    askConfirm, api, applyMutation, onError,
    lineLabel: actualFunction<(chosen: OrderLine) => string>("lineLabel", {}),
    // What the catch reads (#475), and the record as this render holds it, for a handler that would
    // consult it: none may get a retry past the refusal above.
    ApiError, unansweredStatus, removalProvesGone, removalUnanswered, removalUnconfirmed, alreadyRemovedMessage,
    removedNotRefreshedMessage, removals, setRemovals, readAfterRemoval,
  });
  return {
    store, retained, askConfirm, api, onError, unsavedPresentInScope, applyMutation, removeLine, readAfterRemoval,
    removals: () => removals,
  };
}

it("actual Remove refuses retained same-line serials before confirmation or DELETE while the legacy registry is empty", async () => {
  const h = scenario(); const selected = h.retained("order-a", "line-a");
  const before = selected.getSnapshot().current;
  expect(h.store.hasScope("/orders/order-a", serialsScope("line-a"))).toBe(true);
  await h.removeLine(line);
  expect(h.unsavedPresentInScope).toHaveBeenCalledWith(serialsScope("line-a"));
  expect(h.askConfirm).not.toHaveBeenCalled(); expect(h.api).not.toHaveBeenCalled(); expect(h.applyMutation).not.toHaveBeenCalled();
  expect(h.onError).toHaveBeenCalledExactlyOnceWith("Lead has unsaved serials. Removing the line deletes them, so save them first — or use Discard beside this line's Save serials button.");
  expect(selected.getSnapshot().current).toBe(before);
});

it("actual Remove allows another line and another record without consuming either retained draft", async () => {
  const h = scenario(); const sibling = h.retained("order-a", "line-b"), other = h.retained("order-other", "line-a");
  const siblingBefore = sibling.getSnapshot().current, otherBefore = other.getSnapshot().current;
  expect(h.store.hasScope("/orders/order-a", serialsScope("line-a"))).toBe(false);
  await h.removeLine(line);
  expect(h.askConfirm).toHaveBeenCalledExactlyOnceWith({ title: "Remove ACME · P-A (Lead) from this order?", body: "", confirm: "Remove line", danger: true });
  expect(h.api).toHaveBeenCalledExactlyOnceWith("/api/orders/order-a/lines/line-a", { method: "DELETE" });
  expect(h.onError).toHaveBeenLastCalledWith(null);
  expect(sibling.getSnapshot().current).toBe(siblingBefore); expect(other.getSnapshot().current).toBe(otherBefore);
  expect(h.store.getSnapshot().count).toBe(2);
});

it("exact Discard unblocks actual Remove while preserving a sibling's draft and stamp", async () => {
  const h = scenario(); const selected = h.retained("order-a", "line-a"), sibling = h.retained("order-a", "line-b");
  const siblingBefore = sibling.getSnapshot().current;
  await h.removeLine(line); expect(h.api).not.toHaveBeenCalled(); expect(h.askConfirm).not.toHaveBeenCalled();
  h.store.discard([selected.getSnapshot().current!.stamp]);
  expect(h.store.hasScope("/orders/order-a", serialsScope("line-a"))).toBe(false);
  await h.removeLine(line);
  expect(h.askConfirm).toHaveBeenCalledOnce();
  expect(h.api).toHaveBeenCalledExactlyOnceWith("/api/orders/order-a/lines/line-a", { method: "DELETE" });
  expect(sibling.getSnapshot().current).toBe(siblingBefore); expect(h.store.getSnapshot().count).toBe(1);
});

it("a retry of a removal the server did not answer is refused the same way, before confirmation or DELETE (#475)", async () => {
  const h = scenario(["line-a"]); const selected = h.retained("order-a", "line-a");
  const before = selected.getSnapshot().current, marks = h.removals();
  await h.removeLine(line);
  expect(h.unsavedPresentInScope).toHaveBeenCalledWith(serialsScope("line-a"));
  expect(h.askConfirm).not.toHaveBeenCalled(); expect(h.api).not.toHaveBeenCalled(); expect(h.applyMutation).not.toHaveBeenCalled();
  expect(h.readAfterRemoval).not.toHaveBeenCalled();
  expect(h.onError).toHaveBeenCalledExactlyOnceWith("Lead has unsaved serials. Removing the line deletes them, so save them first — or use Discard beside this line's Save serials button.");
  // The mark stays: nothing was sent, so nothing was answered.
  expect(h.removals()).toBe(marks);
  expect(selected.getSnapshot().current).toBe(before);
});
