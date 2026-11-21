import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  invalidateOrderShipments, subscribeOrderShipmentsInvalidations,
} from "@/app/orders/[id]/ShipmentsSection";

// #473 — the order hub's Shipments section follows an order mutation without a reload. A row's
// Complete or Partial tag is the ledger's completion rule's answer (`completionOfTargets`,
// ship-ledger.ts) over the order's CURRENT line quantities, so a line save can change it; the
// section used to read its list once per mount.
//
// Three things are proved here, and each is the wired path rather than a copy of it:
//   1. the module-level listener Set (the invalidateHistory idiom), through its two exports;
//   2. `applyMutation` in page.tsx, the one seam every order mutation reports through, tells the
//      section once the server has answered, whether or not that answer's payload is applied;
//   3. the section's two effects: one subscribes, the other reads, and a read that a newer one
//      replaced lands nothing, success or failure.
//
// vitest has no DOM, so nothing here renders. Parts 2 and 3 lift the production function out of
// its file's syntax tree and run it closed over the environment given and nothing else, the way
// lines-section-wiring.test.ts runs the Lines handlers. A lifted function that gains a free
// identifier on a path these cases take must gain it here in the same change, or it is a
// ReferenceError in this file.

function parse(relative: string): ts.SourceFile {
  const file = fileURLToPath(new URL(relative, import.meta.url));
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function all<T extends ts.Node>(root: ts.Node, is: (node: ts.Node) => node is T): T[] {
  const out: T[] = [];
  const walk = (node: ts.Node): void => { if (is(node)) out.push(node); ts.forEachChild(node, walk); };
  walk(root);
  return out;
}
const callsTo = (root: ts.Node, name: string) =>
  all(root, ts.isCallExpression).filter((c) => ts.isIdentifier(c.expression) && c.expression.text === name);
/** The production expression `node`, closed over `environment` and nothing else. */
function actual<T>(node: ts.Node, environment: Record<string, unknown>): T {
  const body = ts.transpileModule(`return (${node.getText()});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(environment), body)(...Object.values(environment)) as T;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
/** Every promise reaction queued so far has run. */
const settle = () => new Promise<void>((done) => setImmediate(done));

describe("order shipments invalidation: the listener Set", () => {
  it("notifies every subscriber per invalidation, until unsubscribed", () => {
    let a = 0;
    let b = 0;
    const unsubA = subscribeOrderShipmentsInvalidations(() => { a += 1; });
    const unsubB = subscribeOrderShipmentsInvalidations(() => { b += 1; });

    invalidateOrderShipments();
    expect([a, b]).toEqual([1, 1]);

    unsubA();
    unsubA(); // a second unsubscribe is harmless
    invalidateOrderShipments();
    expect([a, b]).toEqual([1, 2]);

    unsubB();
    expect(() => invalidateOrderShipments()).not.toThrow();
    expect([a, b]).toEqual([1, 2]);
  });
});

describe("order hub: applyMutation tells the Shipments section", () => {
  /** page.tsx's own `applyMutation`, with a mutation gate that DROPS every payload: a newer
   *  mutation has already been applied. Nothing past that gate runs, so nothing past it is given. */
  function hub() {
    const source = parse("../src/app/orders/[id]/page.tsx");
    const found = all(source, ts.isVariableDeclaration)
      .filter((d) => ts.isIdentifier(d.name) && d.name.text === "applyMutation");
    expect(found).toHaveLength(1);
    const wrapped = found[0].initializer;
    if (!wrapped || !ts.isCallExpression(wrapped) || wrapped.expression.getText() !== "useCallback") {
      throw new Error("applyMutation is no longer a useCallback in page.tsx");
    }
    let told = 0;
    const applyMutation = actual<(run: () => Promise<unknown>) => Promise<void>>(wrapped.arguments[0], {
      mutations: { next: () => 1, accept: () => false },
      recoverySource: { begin: () => ({ unavailable: () => {}, accept: async () => {} }) },
      writes: { dispatched: () => {} }, // #550's registry of writes in flight: order-hub-reads.test.ts
      ApiError: class extends Error {},
      UnreadableAnswerError: class extends Error {},
      invalidateHistory: () => {},
      invalidateOrderShipments: () => { told += 1; },
    });
    return { applyMutation, told: () => told };
  }

  it("once the server has answered, and not before, even when that answer's payload is dropped", async () => {
    const { applyMutation, told } = hub();
    const answer = deferred<unknown>();
    const done = applyMutation(() => answer.promise);
    await settle();
    expect(told()).toBe(0); // dispatched, not yet answered: the server may not have written
    // The bare order, which is what a mutation run through `applyMutation` answers. The gate
    // this `hub()` is given drops every payload, so nothing reads it.
    answer.resolve({ id: "order-1", lines: [], loads: [] });
    await done;
    expect(told()).toBe(1);
  });

  // A 2xx whose answer could not be read does tell it (#547): tests/unreadable-answer.test.ts.
  it("not at all for a mutation that failed with anything but an unreadable 2xx, whose rejection still reaches the caller", async () => {
    const { applyMutation, told } = hub();
    const refusal = new Error("cannot reduce qty below 20 already shipped");
    await expect(applyMutation(() => Promise.reject(refusal))).rejects.toBe(refusal);
    expect(told()).toBe(0);
  });
});

describe("ShipmentsSection: the two effects", () => {
  const ROWS_A = [{ id: "shipper-a" }];
  const ROWS_B = [{ id: "shipper-b" }];

  function effects() {
    const source = parse("../src/app/orders/[id]/ShipmentsSection.tsx");
    const component = all(source, ts.isFunctionDeclaration).filter((f) => f.name?.text === "ShipmentsSection");
    expect(component).toHaveLength(1);
    const every = callsTo(component[0], "useEffect");
    const subscribing = every.filter((e) => callsTo(e, "subscribeOrderShipmentsInvalidations").length > 0);
    const reading = every.filter((e) => callsTo(e, "api").length > 0);
    expect(subscribing).toHaveLength(1);
    expect(reading).toHaveLength(1);
    expect(subscribing[0]).not.toBe(reading[0]);
    // Every request this section makes is made inside the read effect, behind its stale flag.
    expect(callsTo(component[0], "api")).toHaveLength(1);
    const deps = (effect: ts.CallExpression): string[] => {
      const list = effect.arguments[1];
      if (!list || !ts.isArrayLiteralExpression(list)) throw new Error("an effect has no dependency list");
      return list.elements.map((e) => e.getText());
    };
    return { component: component[0], subscribing: subscribing[0], reading: reading[0], deps };
  }

  /** The read effect, run with its own request and state setters recorded. */
  function reader(over: Record<string, unknown> = {}) {
    const requests: Array<{ url: string; answer: ReturnType<typeof deferred<unknown>> }> = [];
    const rows: unknown[] = [];
    const errors: Array<string | null> = [];
    // Which order a read landed for (P6 step 3): the list says "Loading…" until one has.
    const loadedFor: Array<string | null> = [];
    const effect = actual<() => (() => void) | undefined>(effects().reading.arguments[0], {
      api: (url: string) => {
        const answer = deferred<unknown>();
        requests.push({ url, answer });
        return answer.promise;
      },
      orderId: "order-1",
      allowed: true,
      setRows: (next: unknown) => { rows.push(next); },
      setError: (next: string | null) => { errors.push(next); },
      setLoadedFor: (next: string | null) => { loadedFor.push(next); },
      ...over,
    });
    return { effect, requests, rows, errors, loadedFor };
  }

  it("subscribes for as long as it is mounted, and each invalidation moves the read's nonce", () => {
    const { subscribing, deps } = effects();
    let nonce = 0;
    const effect = actual<() => () => void>(subscribing.arguments[0], {
      subscribeOrderShipmentsInvalidations,
      setRefreshNonce: (update: (current: number) => number) => { nonce = update(nonce); },
    });
    expect(deps(subscribing)).toEqual([]);

    const unmount = effect();
    invalidateOrderShipments();
    invalidateOrderShipments();
    expect(nonce).toBe(2);

    unmount();
    invalidateOrderShipments();
    expect(nonce).toBe(2);
  });

  it("the read runs again when that nonce moves: it is one of the read effect's dependencies", () => {
    const { component, reading, deps } = effects();
    // The state whose setter the subscription calls, by that setter's name.
    const state = all(component, ts.isVariableDeclaration).filter((d) =>
      ts.isArrayBindingPattern(d.name) && d.name.elements[1]?.getText() === "setRefreshNonce");
    expect(state).toHaveLength(1);
    const nonce = (state[0].name as ts.ArrayBindingPattern).elements[0].getText();
    expect(deps(reading)).toEqual(["orderId", "allowed", nonce]);
  });

  it("reads this order's shipments and lands them, clearing an earlier error", async () => {
    const { effect, requests, rows, errors, loadedFor } = reader();
    effect();
    expect(requests.map((r) => r.url)).toEqual(["/api/orders/order-1/shipments"]);
    requests[0].answer.resolve(ROWS_A);
    await settle();
    expect(rows).toEqual([ROWS_A]);
    expect(errors).toEqual([null]);
    expect(loadedFor).toEqual(["order-1"]);
  });

  it("a failed read reports its message and replaces no rows", async () => {
    const { effect, requests, rows, errors, loadedFor } = reader();
    effect();
    requests[0].answer.reject(new Error("Requires shipping.view"));
    await settle();
    expect(rows).toEqual([]);
    expect(errors).toEqual(["Requires shipping.view"]);
    expect(loadedFor).toEqual([]);
  });

  it("a read that a newer one replaced lands nothing when it succeeds late", async () => {
    const { effect, requests, rows, errors } = reader();
    const replaced = effect();
    replaced?.(); // React runs the old effect's cleanup before the new effect
    effect();
    requests[1].answer.resolve(ROWS_B);
    await settle();
    requests[0].answer.resolve(ROWS_A); // the older read, answered last
    await settle();
    expect(rows).toEqual([ROWS_B]);
    expect(errors).toEqual([null]);
  });

  it("a read that a newer one replaced lands nothing when it fails late", async () => {
    const { effect, requests, rows, errors } = reader();
    const replaced = effect();
    replaced?.();
    effect();
    requests[1].answer.resolve(ROWS_B);
    await settle();
    requests[0].answer.reject(new Error("socket hang up"));
    await settle();
    expect(rows).toEqual([ROWS_B]);
    expect(errors).toEqual([null]);
  });

  it("without shipping.view it sends no request", () => {
    const { effect, requests } = reader({ allowed: false });
    expect(effect()).toBeUndefined();
    expect(requests).toEqual([]);
  });
});
