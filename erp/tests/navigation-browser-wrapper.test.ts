import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftSession } from "../src/lib/draft-session";

const accessor = vi.hoisted(() => ({ current: null as DraftSession | null, get: vi.fn(), peek: vi.fn() }));
vi.mock("../src/lib/draft-session", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/lib/draft-session")>();
  return { ...actual, getBrowserDraftSession: accessor.get, peekBrowserDraftSession: accessor.peek };
});
beforeEach(() => {
  vi.resetModules(); accessor.current = null; accessor.get.mockReset(); accessor.peek.mockReset();
  accessor.get.mockImplementation(() => accessor.current); accessor.peek.mockImplementation(() => accessor.current);
  vi.stubGlobal("window", { location: { pathname: "/orders/o1", origin: "http://example.test" } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture() {
  const { openScalarDraft } = await import("./helpers/draft-store");
  const { createDraftSession } = await import("../src/lib/draft-session");
  const h = openScalarDraft(); h.binding.change(() => ({ value: "consented raw" }));
  accessor.current = createDraftSession(h.store);
  const navigation = await import("../src/lib/draft-navigation");
  const make = navigation.createDiscardIntents;
  const ledgers: ReturnType<typeof make>[] = [];
  // Observational call-through spies retain the real ledger implementation and outcomes.
  const factory = vi.spyOn(navigation, "createDiscardIntents").mockImplementation(() => {
    const ledger = make(); vi.spyOn(ledger, "prepare"); vi.spyOn(ledger, "attach"); vi.spyOn(ledger, "consume");
    ledgers.push(ledger); return ledger;
  });
  const wrapper = await import("../src/lib/use-unsaved-section");
  return { ...h, ...wrapper, factory, ledgers, session: accessor.current };
}
describe("actual browser discard-navigation wrapper", () => {
  it("does not initialize a browser session or ledger during SSR import or invocation", async () => {
    vi.stubGlobal("window", undefined);
    const h = await fixture();
    expect(h.factory).not.toHaveBeenCalled();
    expect(h.captureDiscardNavigation(() => true)).toBeNull(); h.invalidateDiscardNavigation();
    expect(accessor.get).not.toHaveBeenCalled(); expect(accessor.peek).not.toHaveBeenCalled(); expect(h.factory).not.toHaveBeenCalled();
  });
  it("returns null when identity is unavailable or the originating instance is not live", async () => {
    const h = await fixture();
    expect(h.captureDiscardNavigation(() => false)).toBeNull();
    h.store.beginIdentityCheck(); expect(h.captureDiscardNavigation(() => true)).toBeNull();
    expect(h.store.getSnapshot().identityReady).toBe(false);
  });
  it("attaches the exact originally captured owner and stamps despite newer input", async () => {
    const h = await fixture(); const owner = h.store.getSnapshot().owner!; const stamps = h.store.stampsForPath("/orders/o1");
    const attempt = h.captureDiscardNavigation(() => true); expect(attempt).not.toBeNull();
    h.binding.change(() => ({ value: "later raw" }));
    expect(attempt!.attach("/invoicing/created")).toBe(true);
    expect(h.ledgers).toHaveLength(1);
    expect(h.ledgers[0].prepare).toHaveBeenCalledExactlyOnceWith({ operationId: expect.any(String), owner, stamps, destination: "/invoicing/created" });
    expect(h.ledgers).toHaveLength(1); expect(h.ledgers[0].consume).not.toHaveBeenCalled(); expect(h.binding.getSnapshot().current!.data.value).toBe("later raw");
  });
  it.each(["checking", "owner-change", "owner-reset"] as const)("fresh %s refuses a formerly authorized callback", async state => {
    const h = await fixture(); const attempt = h.captureDiscardNavigation(() => true); expect(attempt).not.toBeNull();
    if (state === "checking") h.store.beginIdentityCheck();
    else { h.store.resetIdentity(); h.store.acceptIdentity(h.store.beginIdentityCheck(), state === "owner-reset" ? "u1" : "u2"); }
    expect(attempt!.isCurrent()).toBe(false); expect(attempt!.attach("/shipping/late")).toBe(false);
    expect(h.ledgers).toHaveLength(1); expect(h.ledgers[0].prepare).not.toHaveBeenCalled(); expect(h.ledgers).toHaveLength(1); expect(h.ledgers[0].consume).not.toHaveBeenCalled();
  });
  it("checks its original lifetime again at attach and cannot revive through a new instance", async () => {
    const h = await fixture(); const original = { live: true }; let current = original;
    const attempt = h.captureDiscardNavigation(() => original.live && current === original); expect(attempt).not.toBeNull();
    original.live = false; current = { live: true };
    expect(attempt!.isCurrent()).toBe(false); expect(attempt!.attach("/invoicing/late")).toBe(false); expect(h.ledgers).toHaveLength(1); expect(h.ledgers[0].consume).not.toHaveBeenCalled();
  });
  it("shares precommit supersession across caller handles and ignores stale cancellation", async () => {
    const h = await fixture(); const invoice = h.captureDiscardNavigation(() => true); expect(invoice).not.toBeNull();
    const shell = h.captureDiscardNavigation(() => true); expect(shell).not.toBeNull(); invoice!.cancel();
    expect(invoice!.attach("/invoicing/late")).toBe(false); expect(shell!.isCurrent()).toBe(true);
    expect(shell!.attach("/orders/other")).toBe(true); expect(h.ledgers).toHaveLength(1); expect(h.ledgers[0].consume).not.toHaveBeenCalled();
  });
  it("public invalidation retains drafts even when the pathname matches an attached destination", async () => {
    const h = await fixture(); const attempt = h.captureDiscardNavigation(() => true); expect(attempt).not.toBeNull();
    expect(attempt!.attach("/orders/other")).toBe(true); window.location.pathname = "/orders/other"; h.invalidateDiscardNavigation();
    expect(attempt!.isCurrent()).toBe(false); expect(h.store.getSnapshot().count).toBe(1); expect(h.ledgers).toHaveLength(1); expect(h.ledgers[0].consume).not.toHaveBeenCalled();
  });
});
