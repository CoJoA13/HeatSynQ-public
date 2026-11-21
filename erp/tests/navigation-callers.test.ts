import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createNavigationAttempts } from "../src/lib/navigation-attempts";
import { newId } from "../src/lib/client-id";
import type { DiscardIntent } from "../src/lib/draft-navigation";
import { openScalarDraft } from "./helpers/draft-store";
import { reasonPromptText } from "@/lib/reason-prompt";

// Execute the actual named callback, not a replacement workflow. Injected router records
// requests only: neither its return nor a matching pathname is a commit acknowledgement.
function callback(path: string, name: string, environment: Record<string, unknown>) {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node; ts.forEachChild(node, visit); };
  visit(source);
  if (!found) throw new Error(`Missing actual callback ${name}`);
  const js = ts.transpileModule(`return (${found.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(environment), js)(...Object.values(environment)) as (...args: unknown[]) => Promise<void>;
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const invoicePath = "src/app/orders/[id]/InvoicesSection.tsx";
const reversalPath = "src/app/shipping/[id]/ShipmentDetail.tsx";
// #651 (P11 step 1): Raise credit is the third action that navigates after its write, under the
// same departure-attempt shape; its busy hold (`hold`/`release`) is the page's, stubbed open here.
const creditPath = "src/app/invoicing/[id]/InvoiceDetail.tsx";
const CALLBACKS = { invoice: [invoicePath, "createInvoice"], reversal: [reversalPath, "reverseAction"], credit: [creditPath, "raiseCredit"] } as const;
function fixture(kind: "invoice" | "reversal" | "credit") {
  const h = openScalarDraft(); h.binding.change(() => ({ value: "original raw" }));
  const owner = h.store.getSnapshot().owner!; const stamps = h.store.stampsForPath("/orders/o1");
  const intents = { prepare: vi.fn((_intent: DiscardIntent) => { void _intent; }), attach: vi.fn((_id: string, _href: string) => { void _id; void _href; }), consume: vi.fn(() => []), invalidate: vi.fn() };
  const holder = createNavigationAttempts(intents); const events: string[] = [];
  const navigationLifetime = { current: { live: true } };
  const captureDiscardNavigation = vi.fn((isLive: () => boolean) => {
    events.push("capture"); const a = holder.capture({ owner: h.store.getSnapshot().owner!, stamps: h.store.stampsForPath("/orders/o1") });
    const live = () => { const snapshot = h.store.getSnapshot(); return isLive() && snapshot.identityReady && snapshot.owner?.userId === owner.userId && snapshot.owner.authGeneration === owner.authGeneration && a.isCurrent(); };
    return { isCurrent: live, attach: (href: string) => live() && a.attach(href), cancel: a.cancel };
  });
  const response = deferred<{ invoice: { id: string }; shipper: { id: string } }>();
  const api = vi.fn(() => { events.push("POST"); return response.promise; });
  const router = { push: vi.fn((_href: string) => { void _href; events.push("push"); }) };
  const confirmDiscard = vi.fn(() => { events.push("confirm"); return true; });
  const prompt = vi.fn((): string | null => "audit reason"); const setError = vi.fn();
  const run = callback(CALLBACKS[kind][0], CALLBACKS[kind][1], {
    // The reversal asks through the modal since PR 4 (`askDiscard`, `askReason`); each delegates to
    // the shared stub so every case below drives the three kinds alike.
    api, router, confirmDiscard, askDiscard: async () => confirmDiscard(), prompt, askReason: async () => prompt(), reasonPromptText, setError, load: vi.fn(async () => {}), invalidateHistory: vi.fn(), peekBrowserDraftSession: () => ({ store: h.store }), setCreating: vi.fn(), setReversing: vi.fn(), orderId: "o1", id: "s1", shipper: { shipperNumber: 42 }, captureDiscardNavigation, navigationLifetime,
    busyRef: { current: null }, hold: () => true, release: vi.fn(),
  });
  const success = () => response.resolve({ invoice: { id: "created" }, shipper: { id: "reversed" } });
  return { ...h, owner, stamps, intents, holder, events, navigationLifetime, captureDiscardNavigation, response, api, router, confirmDiscard, prompt, setError, run, success };
}
/** The reversal answers two modal dialogs before its POST (PR 4); one macrotask drains them, and
 *  costs the two synchronous callbacks nothing. */
const answered = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe.each(["invoice", "reversal", "credit"] as const)("actual %s navigation callback", kind => {
  it("captures original consent before confirm and the real POST; later edits are excluded", async () => {
    const h = fixture(kind);
    h.confirmDiscard.mockImplementation(() => { h.events.push("confirm"); h.binding.change(() => ({ value: "edit during confirm" })); return true; });
    const pending = h.run(); await answered(); h.success(); await pending;
    expect(h.events.slice(0, 3)).toEqual(["capture", "confirm", "POST"]);
    expect(h.intents.prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ owner: h.owner, stamps: h.stamps, destination: kind === "reversal" ? "/shipping/reversed" : "/invoicing/created" }));
    expect(h.router.push).toHaveBeenCalledTimes(1); expect(h.intents.consume).not.toHaveBeenCalled();
    expect(h.binding.getSnapshot().current!.data.value).toBe("edit during confirm");
  });
  it("cancelled consent sends no request and retains raw work", async () => {
    const h = fixture(kind); h.confirmDiscard.mockReturnValue(false); await h.run();
    expect(h.api).not.toHaveBeenCalled(); expect(h.router.push).not.toHaveBeenCalled(); expect(h.store.getSnapshot().count).toBe(1);
  });
  it("a different caller supersedes a held success before commit", async () => {
    const h = fixture(kind); const pending = h.run(); await answered(); expect(h.api).toHaveBeenCalledTimes(1);
    const shell = h.holder.capture({ owner: h.owner, stamps: h.stamps }); h.success(); await pending;
    expect(h.router.push).not.toHaveBeenCalled(); expect(h.intents.prepare).not.toHaveBeenCalled();
    expect(shell.isCurrent()).toBe(true); expect(h.store.getSnapshot().count).toBe(1);
  });
  it("old committed lifetime cannot revive when another instance mounts", async () => {
    const h = fixture(kind); const pending = h.run(); await answered(); expect(h.api).toHaveBeenCalledTimes(1);
    h.navigationLifetime.current.live = false; h.navigationLifetime.current = { live: true }; h.success(); await pending;
    expect(h.router.push).not.toHaveBeenCalled(); expect(h.intents.prepare).not.toHaveBeenCalled(); expect(h.intents.consume).not.toHaveBeenCalled();
  });
  it("changed identity closes a held callback without attaching old-owner intent", async () => {
    const h = fixture(kind); const pending = h.run(); await answered(); expect(h.api).toHaveBeenCalledTimes(1);
    h.store.resetIdentity(); h.store.acceptIdentity(h.store.beginIdentityCheck(), "u2"); h.success(); await pending;
    expect(h.router.push).not.toHaveBeenCalled(); expect(h.intents.prepare).not.toHaveBeenCalled();
  });
  it("identity checking blocks a held navigation without using old read authority", async () => {
    const h = fixture(kind); const pending = h.run(); await answered(); expect(h.api).toHaveBeenCalledTimes(1);
    h.store.beginIdentityCheck(); h.success(); await pending;
    expect(h.router.push).not.toHaveBeenCalled(); expect(h.intents.prepare).not.toHaveBeenCalled();
  });
  it("a push exception after a successful POST preserves known business success", async () => {
    const h = fixture(kind); h.router.push.mockImplementation(() => { throw new Error("router unavailable"); });
    const pending = h.run(); await answered(); h.success(); await pending;
    expect(h.api).toHaveBeenCalledTimes(1); expect(h.router.push).toHaveBeenCalledTimes(1);
    const messages = h.setError.mock.calls.map(([value]) => value).filter((value): value is string => typeof value === "string");
    expect(messages.some(message => /created|reversed|reversal.*succeed/i.test(message))).toBe(true);
    expect(h.intents.consume).not.toHaveBeenCalled(); expect(h.store.getSnapshot().count).toBe(1);
    expect(h.intents.invalidate).toHaveBeenLastCalledWith("navigation-1"); // the push-catch's attempt.cancel() (ShipmentDetail.tsx:962, InvoicesSection.tsx:144)
  });
  it("failed old request cannot invalidate a newer operation", async () => {
    const h = fixture(kind); const pending = h.run(); await answered(); const shell = h.holder.capture({ owner: h.owner, stamps: h.stamps });
    h.response.reject(new Error("request refused")); await pending;
    expect(h.router.push).not.toHaveBeenCalled(); expect(shell.isCurrent()).toBe(true); expect(h.store.getSnapshot().count).toBe(1);
  });
});
// A cancelled reason dialog; a blank one never comes back, since the modal holds it open (PR 4).
it.each([null])("actual reversal reason %s never sends a request", async reason => {
  const h = fixture("reversal"); h.prompt.mockReturnValue(reason); await h.run();
  expect(h.api).not.toHaveBeenCalled(); expect(h.router.push).not.toHaveBeenCalled(); expect(h.store.getSnapshot().count).toBe(1);
});

const shellPath = "src/components/Shell.tsx";
function shellFixture() {
  const h = fixture("invoice"); const search = deferred<{ exactOrderId: string; exactLoadNumber?: number }>();
  const confirmDiscardBefore = vi.fn((href: string) => href === "/orders/o1" || h.confirmDiscard());
  const environment = {
    captureDiscardNavigation: h.captureDiscardNavigation, navigationLifetime: h.navigationLifetime,
    confirmDiscardBefore, closeSearchDropdown: vi.fn(), setQuery: vi.fn(), setResults: vi.fn(), router: h.router,
    setSearchError: vi.fn(), pathname: "/orders/o1", leavesCurrentPage: (path: string, current: string) => path !== current,
    cancelDebounce: vi.fn(), runSearch: vi.fn(() => search.promise), query: "100", activeHref: undefined,
    open: false, resultHrefs: [], setActiveIndex: vi.fn(), newId,
  };
  const selectResult = callback(shellPath, "selectResult", environment);
  const enter = callback(shellPath, "onSearchKeyDown", { ...environment, selectResult });
  return { ...h, search, selectResult, enter, environment };
}
it("actual Shell selection captures before confirmation and attaches without consuming", async () => {
  const h = shellFixture(); await h.selectResult("/orders/other");
  expect(h.events.slice(0, 2)).toEqual(["capture", "confirm"]);
  expect(h.intents.prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ stamps: h.stamps, destination: "/orders/other" }));
  expect(h.router.push).toHaveBeenCalledExactlyOnceWith("/orders/other"); expect(h.intents.consume).not.toHaveBeenCalled();
});
it("actual same-route Shell selection preserves native no-prompt behavior and drafts", async () => {
  const h = shellFixture(); await h.selectResult("/orders/o1");
  expect(h.confirmDiscard).not.toHaveBeenCalled(); expect(h.intents.prepare).not.toHaveBeenCalled();
  expect(h.store.getSnapshot().count).toBe(1);
});
it("actual Enter captures before lookup and cannot navigate after another caller supersedes it", async () => {
  const h = shellFixture(); const pending = h.enter({ key: "Enter", preventDefault: vi.fn() });
  expect(h.environment.runSearch).toHaveBeenCalledExactlyOnceWith("100");
  const other = h.holder.capture({ owner: h.owner, stamps: h.stamps }); h.search.resolve({ exactOrderId: "other" }); await pending;
  expect(h.captureDiscardNavigation).toHaveBeenCalledTimes(1);
  expect(h.router.push).not.toHaveBeenCalled(); expect(other.isCurrent()).toBe(true);
});
it("Shell wires an actual popstate invalidation listener, without treating it as a commit", () => {
  const source = ts.createSourceFile(shellPath, readFileSync(shellPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const popListeners: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "addEventListener" && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "popstate") popListeners.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(popListeners).toHaveLength(1);
  const arg = popListeners[0].arguments[1];
  // Require the registered function to be the invalidator itself or a closure calling it.
  expect(arg.getText(source)).toMatch(/invalidateDiscardNavigation/);
});

it("#318 actual Enter routes a load scan to that load", async () => {
  const h = shellFixture(); const pending = h.enter({ key: "Enter", preventDefault: vi.fn() });
  h.search.resolve({ exactOrderId: "other", exactLoadNumber: 2 }); await pending;
  expect(h.router.push).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^\/orders\/other\?load=2&scan=[\w-]+#load-2$/));
});
it("#318 same-order load selection preserves unsaved drafts without a discard intent", async () => {
  const h = shellFixture();
  const confirm = callback(shellPath, "confirmDiscardBefore", {
    pathname: "/orders/o1", leavesCurrentPage: h.environment.leavesCurrentPage, confirmDiscard: h.confirmDiscard,
  });
  const select = callback(shellPath, "selectResult", { ...h.environment, confirmDiscardBefore: confirm });
  await select("/orders/o1?load=2#load-2");
  expect(h.confirmDiscard).not.toHaveBeenCalled();
  expect(h.intents.prepare).not.toHaveBeenCalled();
  expect(h.store.getSnapshot().count).toBe(1);
  expect(h.router.push).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^\/orders\/o1\?load=2&scan=[\w-]+#load-2$/));
});

it("#318 repeated same-load scans request distinct refreshes without remounting the order", async () => {
  const h = shellFixture();
  await h.selectResult("/orders/o1?load=2#load-2");
  await h.selectResult("/orders/o1?load=2#load-2");
  const urls = h.router.push.mock.calls.map(([href]) => new URL(href, "http://localhost"));
  expect(urls).toHaveLength(2);
  expect(urls[0].searchParams.get("scan")).toBeTruthy();
  expect(urls[1].searchParams.get("scan")).not.toBe(urls[0].searchParams.get("scan"));
  expect(urls.map(url => url.pathname)).toEqual(["/orders/o1", "/orders/o1"]);
});
