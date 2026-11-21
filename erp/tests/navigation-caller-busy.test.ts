import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createNavigationAttempts } from "../src/lib/navigation-attempts";
import { createDiscardIntents } from "../src/lib/draft-navigation";
import { openScalarDraft } from "./helpers/draft-store";
import { reasonPromptText } from "@/lib/reason-prompt";
function deferred() { let resolve!: (data: { invoice: { id: string }; shipper: { id: string } }) => void; const promise = new Promise<{ invoice: { id: string }; shipper: { id: string } }>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(kind: "invoice" | "reversal") {
  const h = openScalarDraft(); h.binding.change(() => ({ value: "retained" }));
  const owner = h.store.getSnapshot().owner!; const holder = createNavigationAttempts(createDiscardIntents());
  const navigationLifetime: { current: { live: boolean; request?: object } } = { current: { live: true } };
  const response = [deferred(), deferred()]; let index = 0;
  const api = vi.fn(() => response[index++].promise); const setBusy = vi.fn(); const setError = vi.fn(); const router = { push: vi.fn() };
  const captureDiscardNavigation = (isLive: () => boolean) => {
    const a = holder.capture({ owner, stamps: h.store.stampsForPath("/orders/o1") });
    const isCurrent = () => isLive() && a.isCurrent();
    return { isCurrent, attach: (href: string) => isCurrent() && a.attach(href), cancel: a.cancel };
  };
  const environment = { api, reasonPromptText, setCreating: setBusy, setReversing: setBusy, setError, load: vi.fn(async () => {}), invalidateHistory: vi.fn(), router, navigationLifetime, captureDiscardNavigation, peekBrowserDraftSession: () => ({ store: h.store }), confirmDiscard: () => true, prompt: () => "reason", askDiscard: async () => true, askReason: async () => "reason", orderId: "o1", id: "s1", shipper: { shipperNumber: 42 } };
  const path = kind === "invoice" ? "src/app/orders/[id]/InvoicesSection.tsx" : "src/app/shipping/[id]/ShipmentDetail.tsx";
  const name = kind === "invoice" ? "createInvoice" : "reverseAction";
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: ts.FunctionDeclaration | undefined; const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node; ts.forEachChild(node, visit); }; visit(file); expect(found).toBeDefined();
  const code = ts.transpileModule(`return (${found!.getText(file)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const run = new Function(...Object.keys(environment), code)(...Object.values(environment)) as () => Promise<void>;
  const finish = (at: number) => response[at].resolve({ invoice: { id: "created" }, shipper: { id: "reversed" } });
  return { ...h, owner, holder, navigationLifetime, api, setBusy, setError, router, run, finish };
}
/** The reversal answers two modal dialogs before its POST (PR 4); one macrotask drains them. */
const answered = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
describe.each(["invoice", "reversal"] as const)("%s original-request busy ownership", kind => {
  it("cancelled newer Shell departure cannot strand the original mounted request busy", async () => {
    const h = fixture(kind); const pending = h.run(); await answered(); expect(h.api).toHaveBeenCalledTimes(1);
    const shell = h.holder.capture({ owner: h.owner, stamps: [] }); shell.cancel();
    h.finish(0); await pending; await new Promise((done) => setTimeout(done, 0)); // lets the re-read land (both kinds read again after a cancelled departure, #568 and #581)
    expect(h.setBusy.mock.calls).toEqual([[true], [false]]); expect(h.router.push).not.toHaveBeenCalled();
    // The reversal re-read clears the action line first (#581); the invoice section sets no message (#568). Neither sets a message after the landed success.
    expect(h.setError.mock.calls).toEqual(kind === "reversal" ? [[null]] : []);
  });
  it("older same-component completion cannot clear a newer request's busy state", async () => {
    const h = fixture(kind); const first = h.run(); await answered(); const second = h.run(); await answered(); expect(h.api).toHaveBeenCalledTimes(2);
    h.finish(0); await first; expect(h.setBusy.mock.calls).toEqual([[true], [true]]); expect(h.router.push).not.toHaveBeenCalled();
    h.finish(1); await second; expect(h.setBusy.mock.calls).toEqual([[true], [true], [false]]); expect(h.router.push).toHaveBeenCalledTimes(1);
  });
  it("unmounted original callback cannot clear a replacement instance's busy state", async () => {
    const h = fixture(kind); const pending = h.run(); await answered(); expect(h.api).toHaveBeenCalledTimes(1);
    h.navigationLifetime.current.live = false; h.navigationLifetime.current = { live: true }; h.finish(0); await pending;
    expect(h.setBusy.mock.calls).toEqual([[true]]); expect(h.router.push).not.toHaveBeenCalled();
  });
  it("changed owner completion cannot publish a busy reset", async () => {
    const h = fixture(kind); const pending = h.run(); await answered(); expect(h.api).toHaveBeenCalledTimes(1);
    h.store.resetIdentity(); h.store.acceptIdentity(h.store.beginIdentityCheck(), "u2"); h.finish(0); await pending;
    expect(h.setBusy.mock.calls).toEqual([[true]]); expect(h.router.push).not.toHaveBeenCalled();
  });
});
