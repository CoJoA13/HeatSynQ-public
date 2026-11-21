import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { invalidateOrderCerts, subscribeOrderCertsInvalidations } from "@/app/orders/[id]/CertificationsSection";
import { all, run } from "./helpers/source-lift";

// #693 — ticking Certification required on the hub with the scope By order (or setting the scope
// to By order with the box ticked) is a PATCH whose server side mints the order-scope cert in the
// same transaction (`updateOrder`, Phase 4 ruling 26). The Certifications section read its list
// once per mount, so it went on saying "No certifications yet." until a reload, and Create on its
// default target was refused by a cert the screen did not show. Three things are proved, each the
// wired path (the order-shipments-invalidation.test.ts shape):
//   1. the module-level listener Set, through its two exports;
//   2. the hub's `saveOrder` tells the section after a PATCH that carries `certRequired` or
//      `certScope` landed, or answered a 2xx the page could not read (#547: that write committed),
//      and after no other PATCH, and never after a refused one (a refused PATCH mints nothing);
//   3. the section's subscribing effect reads its list on each invalidation, for as long as it is
//      mounted.
// `invalidateHistory` is deliberately not called for cert writes (owner ruling 2026-08-21 at the
// section's `createCertFor`); this re-read touches the cert list only.
//
// vitest has no DOM, so nothing here renders: parts 2 and 3 lift the production function out of
// its file's syntax tree and run it closed over the environment given and nothing else.

function parse(relative: string): ts.SourceFile {
  const file = fileURLToPath(new URL(relative, import.meta.url));
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
const callsTo = (root: ts.Node, name: string) =>
  all(root, ts.isCallExpression).filter((c) => ts.isIdentifier(c.expression) && c.expression.text === name);
/** Every promise reaction queued so far has run. */
const settle = () => new Promise<void>((done) => setImmediate(done));

describe("order certs invalidation: the listener Set", () => {
  it("notifies every subscriber per invalidation, until unsubscribed", () => {
    let a = 0;
    let b = 0;
    const unsubA = subscribeOrderCertsInvalidations(() => { a += 1; });
    const unsubB = subscribeOrderCertsInvalidations(() => { b += 1; });
    invalidateOrderCerts();
    expect([a, b]).toEqual([1, 1]);
    unsubA();
    unsubA();
    invalidateOrderCerts();
    expect([a, b]).toEqual([1, 2]);
    unsubB();
    expect(() => invalidateOrderCerts()).not.toThrow();
    expect([a, b]).toEqual([1, 2]);
  });
});

describe("order hub: saveOrder tells the Certifications section", () => {
  class UnreadableAnswerError extends Error {}
  /** page.tsx's own `saveOrder`, run with a serial queue that runs at once and an `applyMutation`
   *  that answers what `answer` does. */
  function hub(answer: () => Promise<unknown>) {
    const source = parse("../src/app/orders/[id]/page.tsx");
    const found = all(source, ts.isFunctionDeclaration).filter((f) => f.name?.text === "saveOrder");
    expect(found).toHaveLength(1);
    let told = 0;
    const loads: number[] = [];
    const saveOrder = run<(patch: object) => Promise<boolean>>(found[0].getText(source), {
      setOrder: () => {},
      serial: (_key: string, fn: () => Promise<boolean>) => fn(),
      applyMutation: (thunk: () => Promise<unknown>) => thunk(),
      api: answer,
      id: "order-1",
      inFlight: { current: new Map() },
      setError: () => {},
      drainOtherKeys: async () => {},
      load: async () => { loads.push(1); },
      invalidateOrderCerts: () => { told += 1; },
      savedMarks: { mark: () => {}, shows: () => false },
      UnreadableAnswerError,
    });
    return { saveOrder, told: () => told };
  }

  it("once a PATCH carrying certRequired or certScope has landed", async () => {
    const { saveOrder, told } = hub(async () => ({ id: "order-1" }));
    expect(await saveOrder({ certRequired: true })).toBe(true);
    expect(told()).toBe(1);
    expect(await saveOrder({ certScope: "ORDER" })).toBe(true);
    expect(told()).toBe(2);
  });

  it("not for any other header field", async () => {
    const { saveOrder, told } = hub(async () => ({ id: "order-1" }));
    await saveOrder({ notes: "x" });
    await saveOrder({ poNumber: "PO-1" });
    expect(told()).toBe(0);
  });

  it("after a 2xx the page could not read (#547), whose write committed; never after a refusal", async () => {
    const unreadable = hub(async () => { throw new UnreadableAnswerError("unreadable"); });
    expect(await unreadable.saveOrder({ certRequired: true })).toBe(false);
    expect(unreadable.told()).toBe(1);
    const refused = hub(async () => { throw new Error("Order not found"); });
    expect(await refused.saveOrder({ certRequired: true })).toBe(false);
    expect(refused.told()).toBe(0);
    await settle();
  });
});

describe("CertificationsSection: the subscribing effect", () => {
  it("reads the list on each invalidation for as long as it is mounted", () => {
    const source = parse("../src/app/orders/[id]/CertificationsSection.tsx");
    const component = all(source, ts.isFunctionDeclaration).filter((f) => f.name?.text === "CertificationsSection");
    expect(component).toHaveLength(1);
    const subscribing = callsTo(component[0], "useEffect").filter((e) => callsTo(e, "subscribeOrderCertsInvalidations").length > 0);
    expect(subscribing).toHaveLength(1);
    const deps = subscribing[0].arguments[1];
    expect(deps && ts.isArrayLiteralExpression(deps) ? deps.elements.map((e) => e.getText()) : null).toEqual(["load"]);
    const load = vi.fn(async () => {});
    const effect = run<() => () => void>(subscribing[0].arguments[0].getText(source), { subscribeOrderCertsInvalidations, load });
    const unmount = effect();
    invalidateOrderCerts();
    invalidateOrderCerts();
    expect(load).toHaveBeenCalledTimes(2);
    unmount();
    invalidateOrderCerts();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
