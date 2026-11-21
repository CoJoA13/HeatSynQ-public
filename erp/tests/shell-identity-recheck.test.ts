import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { identityCheckKey, bindIdentityRechecks } from "../src/lib/identity-recheck";
import ts from "typescript";

// Ruling R2 (owner 2026-10-22, #607): the Shell's identity check no longer re-runs on every
// client-side route change (each one raised the holding screen, unmounted the page and wasted its
// first reads). It runs on mount, on leaving /login and on Retry; and for the Shell's lifetime on a
// persisted `pageshow`, the tab becoming visible again and a 401. vitest renders no component, so
// the decision is a src/lib leaf and the Shell's effect is pinned from its source. Mutations: key
// the effect on `pathname` again and the source pin reds; drop a listener and its case reds; listen
// on window `focus` instead of visibility and the focus case reds.

function fakeDocument() {
  type AnyListener = (event: never) => void;
  const listeners = new Map<string, Set<AnyListener>>();
  const target = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener(type: string, listener: AnyListener) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(listener); },
    removeEventListener(type: string, listener: AnyListener) { listeners.get(type)?.delete(listener); },
    fire(type: string, event?: unknown) { for (const listener of listeners.get(type) ?? []) (listener as (e: unknown) => void)(event); },
    count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  };
  return target;
}

describe("identityCheckKey", () => {
  it("is the same for every app route, so a route change re-runs nothing", () => {
    expect(identityCheckKey("/orders")).toBe(identityCheckKey("/parts/abc"));
    expect(identityCheckKey("/")).toBe(identityCheckKey("/orders/new"));
  });
  it("differs on /login, so leaving it runs the check", () => {
    expect(identityCheckKey("/login")).not.toBe(identityCheckKey("/orders"));
  });
});

describe("bindIdentityRechecks", () => {
  function bind() {
    const win = fakeDocument();
    const doc = fakeDocument();
    const unauthorized = new Set<() => void>();
    const validate = vi.fn();
    const off = bindIdentityRechecks({
      window: win, document: doc,
      subscribeUnauthorized: (listener) => { unauthorized.add(listener); return () => { unauthorized.delete(listener); }; },
    }, validate);
    return { win, doc, unauthorized, validate, off };
  }
  it("re-checks on a persisted pageshow only", () => {
    const { win, validate } = bind();
    win.fire("pageshow", { persisted: false });
    expect(validate).not.toHaveBeenCalled();
    win.fire("pageshow", { persisted: true });
    expect(validate).toHaveBeenCalledTimes(1);
  });
  it("re-checks when the tab becomes visible again, never on window focus", () => {
    const { win, doc, validate } = bind();
    win.fire("focus");
    expect(validate).not.toHaveBeenCalled();
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    expect(validate).not.toHaveBeenCalled();
    doc.visibilityState = "visible";
    doc.fire("visibilitychange");
    expect(validate).toHaveBeenCalledTimes(1);
  });
  it("re-checks on a 401", () => {
    const { unauthorized, validate } = bind();
    for (const listener of unauthorized) listener();
    expect(validate).toHaveBeenCalledTimes(1);
  });
  it("unbinds every listener", () => {
    const { win, doc, unauthorized, validate, off } = bind();
    off();
    expect(win.count() + doc.count() + unauthorized.size).toBe(0);
    win.fire("pageshow", { persisted: true });
    doc.fire("visibilitychange");
    expect(validate).not.toHaveBeenCalled();
  });
});

describe("Shell's identity effect", () => {
  const source = readFileSync("src/components/Shell.tsx", "utf8");
  const sf = ts.createSourceFile("Shell.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function identityEffect(): ts.CallExpression {
    let found: ts.CallExpression | null = null;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect"
          && node.arguments[0]?.getText(sf).includes("validateIdentity")) found = node;
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (!found) throw new Error("Shell's identity effect not found");
    return found;
  }
  it("is keyed on identityCheckKey(pathname), authRetry and router, never on pathname itself", () => {
    const deps = identityEffect().arguments[1];
    expect(deps && ts.isArrayLiteralExpression(deps)).toBe(true);
    const names = (deps as ts.ArrayLiteralExpression).elements.map((e) => e.getText(sf));
    expect(names).toContain("identityKey");
    expect(names).toContain("authRetry");
    expect(names).not.toContain("pathname");
  });
  it("binds the lifetime rechecks through the leaf", () => {
    expect(identityEffect().arguments[0].getText(sf)).toContain("bindIdentityRechecks(");
    expect(source).toContain('const identityKey = identityCheckKey(pathname);');
  });
});
