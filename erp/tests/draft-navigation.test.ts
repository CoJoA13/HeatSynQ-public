import { expect, it } from "vitest";
import { createDiscardIntents } from "../src/lib/draft-navigation";
import { createDraftStore, type Adapter, type Owner, type Stamp } from "../src/lib/draft-store";
import { confirmMessage } from "../src/lib/unsaved-guard";

const owner: Owner = { userId: "user", authGeneration: 1 };
const stamp = (version = 1): Stamp => ({ key: { owner, record: { kind: "order", id: "one" }, editor: "lines" }, generation: 10, version });
const intent = (operationId = "search-1", destination = "/orders/two") => ({ operationId, destination, owner, stamps: [stamp()] });

it("consumes only one exact attached operation and destination", () => {
  const ledger = createDiscardIntents(); const chosen = intent(); ledger.prepare(chosen);
  expect(ledger.consume(chosen.operationId, chosen.destination)).toEqual([]);
  ledger.attach(chosen.operationId, chosen.destination);
  expect(ledger.consume(chosen.operationId, chosen.destination)).toEqual(chosen.stamps);
  expect(ledger.consume(chosen.operationId, chosen.destination)).toEqual([]);
});
it.each(["request failed", "same route", "canceled document exit", "ambiguous landing", "popstate"])("%s invalidates consent without consuming copies", reason => {
  const ledger = createDiscardIntents(); const chosen = intent(); ledger.prepare(chosen);
  if (reason !== "request failed" && reason !== "same route") ledger.attach(chosen.operationId, chosen.destination);
  // Concrete caller observations: this ledger cannot infer a browser landing.
  ledger.invalidate(reason === "popstate" || reason === "ambiguous landing" ? undefined : chosen.operationId);
  expect(ledger.consume(chosen.operationId, chosen.destination)).toEqual([]);
});
it("pathname equality without an attributable operation cannot consume consent", () => {
  const ledger = createDiscardIntents(); const chosen = intent(); ledger.prepare(chosen); ledger.attach(chosen.operationId, chosen.destination);
  expect(ledger.consume("unattributed", chosen.destination)).toEqual([]);
  ledger.invalidate(); expect(ledger.consume(chosen.operationId, chosen.destination)).toEqual([]);
});
it("new preparation supersedes old consent while stale notifications cannot steal the new operation", () => {
  const ledger = createDiscardIntents(); const old = intent(), next = intent("scan-2", "/shipping/two");
  ledger.prepare(old); ledger.attach(old.operationId, old.destination); ledger.prepare(next);
  ledger.invalidate(old.operationId); ledger.attach(old.operationId, old.destination);
  expect(ledger.consume(old.operationId, old.destination)).toEqual([]);
  ledger.attach(next.operationId, next.destination); expect(ledger.consume(next.operationId, next.destination)).toEqual(next.stamps);
});
it("mismatched attachment cannot authorize a matching pathname", () => {
  const ledger = createDiscardIntents(); const chosen = intent(); ledger.prepare(chosen); ledger.attach(chosen.operationId, "/wrong");
  expect(ledger.consume(chosen.operationId, chosen.destination)).toEqual([]);
});
it("an attributed wrong destination ends that operation without discarding", () => {
  const ledger = createDiscardIntents(); const chosen = intent(); ledger.prepare(chosen); ledger.attach(chosen.operationId, chosen.destination);
  expect(ledger.consume(chosen.operationId, "/redirected")).toEqual([]);
  expect(ledger.consume(chosen.operationId, chosen.destination)).toEqual([]);
});
it("preparation owns stamp metadata and excludes stamps for another owner", () => {
  const ledger = createDiscardIntents(); const original = stamp(); const stamps = [original]; const chosen = { ...intent(), stamps };
  ledger.prepare(chosen); stamps.length = 0; ledger.attach(chosen.operationId, chosen.destination);
  expect(ledger.consume(chosen.operationId, chosen.destination)).toEqual([original]);
  const wrong = { ...stamp(), key: { ...stamp().key, owner: { userId: "other", authGeneration: 2 } } };
  ledger.prepare({ ...chosen, stamps: [wrong] }); ledger.attach(chosen.operationId, chosen.destination);
  expect(ledger.consume(chosen.operationId, chosen.destination)).toEqual([]);
});
it("later mutation of supplied owner or stamp objects cannot alter captured consent", () => {
  const ledger = createDiscardIntents(); const original = stamp();
  const mutableOwner = { ...owner }; const mutableStamp = { ...original, key: { ...original.key, owner: { ...owner }, record: { ...original.key.record } } };
  ledger.prepare({ ...intent(), owner: mutableOwner, stamps: [mutableStamp] });
  mutableOwner.userId = "other"; mutableStamp.version = 99; mutableStamp.key.owner.userId = "other"; mutableStamp.key.record.id = "other";
  ledger.attach("search-1", "/orders/two"); expect(ledger.consume("search-1", "/orders/two")).toEqual([original]);
});

const adapter: Adapter<string, string, string, string> = { kind: "scope-test", schema: "1", valid: (d, b) => typeof d === "string" && typeof b === "string",
  dirty: (d, b) => d !== b, baselineEqual: (a, b) => a === b, preview: () => [], reconcileRead: ({ current, fresh }) => ({ data: current.data, baseline: fresh }),
  settle: ({ current }) => ({ kind: "keep", data: current.data, baseline: current.baseline, needsRefresh: false }) };
function record(store = createDraftStore(), id = "one", label = "Lines", scope?: string) {
  const owner = store.getSnapshot().owner ?? store.acceptIdentity(store.beginIdentityCheck(), "user")!;
  const binding = store.bind({ owner, record: { kind: "order", id }, editor: adapter.kind }, { label, href: "/orders/" + id, scope }, adapter);
  const detach = binding.attach(id); const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline: "saved", editable: true }, "saved"); binding.change(() => "raw");
  return { store, binding, detach, owner };
}
it("store consumption rejects newer versions after a positively matched departure", () => {
  const h = record(); const ledger = createDiscardIntents(); const selected = h.binding.getSnapshot().current!.stamp;
  ledger.prepare({ operationId: "one", owner: h.owner, stamps: [selected], destination: "/orders/two" });
  h.binding.change(() => "later raw"); const later = h.binding.getSnapshot().current;
  ledger.attach("one", "/orders/two"); const consumed = ledger.consume("one", "/orders/two"); expect(consumed).toEqual([selected]); h.store.discard(consumed);
  expect(h.binding.getSnapshot().current).toBe(later); expect(h.store.getSnapshot().count).toBe(1);
});
it("accepted old consent cannot discard a replacement owner's copy", () => {
  const h = record(); const ledger = createDiscardIntents(); const selected = h.binding.getSnapshot().current!.stamp;
  ledger.prepare({ operationId: "one", owner: h.owner, stamps: [selected], destination: "/orders/two" }); h.store.resetIdentity();
  h.store.acceptIdentity(h.store.beginIdentityCheck(), "other"); const next = record(h.store); const before = next.binding.getSnapshot().current;
  ledger.attach("one", "/orders/two"); h.store.discard(ledger.consume("one", "/orders/two")); expect(next.binding.getSnapshot().current).toBe(before);
});
it("positive exact-version consent discards only the selected current-record copy", () => {
  const a = record(); const b = record(a.store, "two", "Charges"); const sibling = b.binding.getSnapshot().current;
  const selected = a.store.stampsForPath("/orders/one"); const ledger = createDiscardIntents();
  ledger.prepare({ operationId: "leave", owner: a.owner, stamps: selected, destination: "/orders/two" }); ledger.attach("leave", "/orders/two");
  a.store.discard(ledger.consume("leave", "/orders/two"));
  expect(a.binding.getSnapshot().current?.data).toBe("saved"); expect(b.binding.getSnapshot().current).toBe(sibling); expect(a.store.getSnapshot().count).toBe(1);
});
it("detached current-record scopes remain gated without blocking other records or ignored labels", () => {
  const a = record(undefined, "one", "Serials", "serials:line-a"); const b = record(a.store, "two", "Charges"); a.detach(); b.detach();
  expect(a.store.labelsForPath("/orders/one")).toEqual(["Serials"]); expect(a.store.labelsForPath("/orders/one", ["Serials"])).toEqual([]);
  expect(a.store.hasScope("/orders/one", "serials:line-a")).toBe(true); expect(a.store.hasScope("/orders/two", "serials:line-a")).toBe(false);
  expect(a.store.labelsForPath("/orders/three")).toEqual([]); expect(a.store.getSnapshot().count).toBe(2);
});
it("pending write wording remains truthful", () => {
  const text = confirmMessage(["Loads"], true);
  expect(text).toMatch(/request is still running/i); expect(text).toMatch(/not cancel|won.t cancel/i);
});
