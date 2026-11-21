import { describe, expect, it } from "vitest";
import { prepareOrderPrintIntent, storeOrderPrintIntent, takeOrderPrintIntent, type CreatedOrderForPrint, type OrderPrintIntent } from "@/lib/order-print-intent";

class MemoryStorage implements Storage {
  private entries = new Map<string, string>();
  reads: string[] = [];
  removals: string[] = [];
  fail: "get" | "set" | "remove" | null = null;
  get length() { return this.entries.size; }
  clear() { this.entries.clear(); }
  key(index: number) { return [...this.entries.keys()][index] ?? null; }
  getItem(key: string) {
    this.reads.push(key);
    if (this.fail === "get") throw new Error("Storage unavailable");
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.fail === "set") throw new Error("Storage unavailable");
    this.entries.set(key, value);
  }
  removeItem(key: string) {
    this.removals.push(key);
    if (this.fail === "remove") throw new Error("Storage unavailable");
    this.entries.delete(key);
  }
}

const intent: OrderPrintIntent = {
  version: 1,
  orderId: "order-1",
  selection: { mode: "loads", loadNumbers: [1, 3] },
  expectedPrintFingerprint: "a".repeat(64),
};

describe("same-tab order print intent", () => {
  it("stores only the validated handoff under unique opaque keys", () => {
    const storage = new MemoryStorage();
    const first = storeOrderPrintIntent(storage, intent);
    const second = storeOrderPrintIntent(storage, intent);
    expect(first).not.toBe(second);
    expect(first).not.toContain(intent.orderId);
    expect(first).not.toContain(intent.expectedPrintFingerprint);
    expect(first).toMatch(/^[a-zA-Z0-9:_-]+$/);
    expect(JSON.parse(storage.getItem(first)!)).toEqual(intent);
    expect(storage.length).toBe(2);
  });

  it("removes synchronously before returning and cannot print again on a reload", () => {
    const storage = new MemoryStorage();
    const key = storeOrderPrintIntent(storage, intent);
    expect(takeOrderPrintIntent(storage, key, "order-1")).toEqual(intent);
    expect(storage.getItem(key)).toBeNull();
    expect(takeOrderPrintIntent(storage, key, "order-1")).toBeNull();
  });

  it("does not find the handoff in a different tab's storage", () => {
    const storage = new MemoryStorage();
    const key = storeOrderPrintIntent(storage, intent);
    expect(takeOrderPrintIntent(new MemoryStorage(), key, "order-1")).toBeNull();
    expect(takeOrderPrintIntent(storage, key, "order-1")).toEqual(intent);
  });

  it("consumes a wrong-order handoff without returning a printable selection", () => {
    const storage = new MemoryStorage();
    const key = storeOrderPrintIntent(storage, intent);
    expect(takeOrderPrintIntent(storage, key, "other-order")).toBeNull();
    expect(storage.getItem(key)).toBeNull();
    expect(takeOrderPrintIntent(storage, key, "order-1")).toBeNull();
  });

  it.each(["unrelated-draft", "", "../draft", "order-print-intent:untrusted", "x".repeat(10_000)])(
    "never reads or removes an arbitrary URL key: %s", (key) => {
      const storage = new MemoryStorage();
      storage.setItem(key, JSON.stringify(intent));
      expect(takeOrderPrintIntent(storage, key, "order-1")).toBeNull();
      expect(storage.reads).toEqual([]);
      expect(storage.removals).toEqual([]);
      expect(storage.length).toBe(1);
    },
  );

  const invalidPayloads: [string, unknown][] = [
    ["unknown version", { ...intent, version: 2 }],
    ["missing order", { ...intent, orderId: "" }],
    ["oversized order identity", { ...intent, orderId: "o".repeat(10_000) }],
    ["missing fingerprint", { ...intent, expectedPrintFingerprint: undefined }],
    ["invalid fingerprint", { ...intent, expectedPrintFingerprint: "not-a-sha256" }],
    ["empty selection", { ...intent, selection: { mode: "loads", loadNumbers: [] } }],
    ["duplicate selection", { ...intent, selection: { mode: "loads", loadNumbers: [1, 1] } }],
    ["invalid load", { ...intent, selection: { mode: "loads", loadNumbers: [0, 1.5] } }],
    ["oversized selection", { ...intent, selection: { mode: "loads", loadNumbers: Array.from({ length: 101 }, (_, i) => i + 1) } }],
    ["unrecognized data", { ...intent, privateInstructions: "Not part of a print handoff" }],
  ];

  it.each(invalidPayloads)("refuses to store %s", (_name, value) => {
    const storage = new MemoryStorage();
    expect(() => storeOrderPrintIntent(storage, value as OrderPrintIntent)).toThrow();
    expect(storage.length).toBe(0);
  });

  it.each([
    ...invalidPayloads.map(([name, value]) => [name, JSON.stringify(value)]),
    ["malformed JSON", "{"],
    ["null JSON", "null"],
    ["oversized JSON", " ".repeat(65_536) + JSON.stringify(intent)],
  ])("consumes and rejects stored %s without falling back to all loads", (_name, raw) => {
    const storage = new MemoryStorage();
    const key = storeOrderPrintIntent(storage, intent);
    storage.setItem(key, raw);
    expect(takeOrderPrintIntent(storage, key, "order-1")).toBeNull();
    expect(storage.getItem(key)).toBeNull();
  });

  it("normalizes selected load order while preserving explicit all-load intent", () => {
    const storage = new MemoryStorage();
    const key = storeOrderPrintIntent(storage, { ...intent, selection: { mode: "loads", loadNumbers: [3, 1] } });
    expect(takeOrderPrintIntent(storage, key, "order-1")).toEqual(intent);
    const all = { ...intent, selection: { mode: "all" as const } };
    expect(takeOrderPrintIntent(storage, storeOrderPrintIntent(storage, all), "order-1")).toEqual(all);
  });

  it("does not return a usable navigation key when storage refuses the write", () => {
    const storage = new MemoryStorage();
    storage.fail = "set";
    expect(() => storeOrderPrintIntent(storage, intent)).toThrow();
    expect(storage.length).toBe(0);
  });

  it.each(["get", "remove"] as const)("fails closed when storage %s throws", (operation) => {
    const storage = new MemoryStorage();
    const key = storeOrderPrintIntent(storage, intent);
    storage.fail = operation;
    expect(takeOrderPrintIntent(storage, key, "order-1")).toBeNull();
  });
});


// This seam uses the saved create DTO and real storage functions. Browser acceptance owns
// warning acknowledgement, React effects, tracked POST timing, and archive UI recovery.
describe("reviewed create response to selected print handoff", () => {
  const reviewed = [
    { loadNumber: 1, qty: 10, weight: 125.5 },
    { loadNumber: 2, qty: 10, weight: 125.5 },
    { loadNumber: 3, qty: 5, weight: 62.75 },
  ];
  const created = (): CreatedOrderForPrint => ({
    order: { id: "persisted-order", loads: reviewed.map(load => ({ ...load })) },
    printExpectation: "b".repeat(64),
  });

  it("carries the actual saved order and its expectation through storage without widening the subset", () => {
    const result = created();
    result.order.loads.reverse();
    const prepared = prepareOrderPrintIntent(result, { mode: "loads", loadNumbers: [3, 1] }, reviewed);
    expect(prepared).toEqual({ version: 1, orderId: "persisted-order",
      selection: { mode: "loads", loadNumbers: [1, 3] }, expectedPrintFingerprint: "b".repeat(64) });
    const storage = new MemoryStorage();
    expect(storage.length).toBe(0); // Preparing a warning receipt must not write an intent yet.
    const key = storeOrderPrintIntent(storage, prepared!);
    expect(takeOrderPrintIntent(storage, key, "persisted-order")).toEqual(prepared);
    expect(takeOrderPrintIntent(storage, key, "persisted-order")).toBeNull();
  });

  it("never prepares a replay for automatic printing even with valid saved loads and expectation", () => {
    expect(prepareOrderPrintIntent({ ...created(), deduped: true }, { mode: "all" }, reviewed)).toBeNull();
  });

  it.each(["missing expectation", "malformed expectation", "load removed", "load renumbered", "quantity changed", "weight changed", "duplicate identity"])(
    "requires manual review when the create response has %s", (change) => {
      const result = created();
      if (change === "missing expectation") delete result.printExpectation;
      if (change === "malformed expectation") result.printExpectation = "unsafe";
      if (change === "load removed") result.order.loads.pop();
      if (change === "load renumbered") result.order.loads[0].loadNumber = 4;
      if (change === "quantity changed") result.order.loads[0].qty = 11;
      if (change === "weight changed") result.order.loads[0].weight = 125.51;
      if (change === "duplicate identity") result.order.loads[0].loadNumber = 2;
      expect(prepareOrderPrintIntent(result, { mode: "all" }, reviewed)).toBeNull();
    },
  );

  it("does not turn an absent selected load into a printable all-load request", () => {
    expect(prepareOrderPrintIntent(created(), { mode: "loads", loadNumbers: [4] }, reviewed)).toBeNull();
  });

  it("requires a bounded print selection even when the saved load plan is larger", () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ loadNumber: i + 1, qty: 1, weight: 1 }));
    const result = { ...created(), order: { id: "persisted-order", loads: many } };
    expect(prepareOrderPrintIntent(result, { mode: "all" }, many)).toBeNull();
    expect(prepareOrderPrintIntent(result, { mode: "loads", loadNumbers: [1, 101] }, many)?.selection)
      .toEqual({ mode: "loads", loadNumbers: [1, 101] });
  });
});
