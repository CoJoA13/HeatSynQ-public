import { describe, expect, it, vi } from "vitest";
import type { DiscardIntent } from "../src/lib/draft-navigation";
import { createNavigationAttempts } from "../src/lib/navigation-attempts";
import { openScalarDraft } from "./helpers/draft-store";

function fixture() {
  const h = openScalarDraft();
  h.binding.change(() => ({ value: "consented" }));
  const stamps = h.store.stampsForPath("/orders/o1");
  const intents = { prepare: vi.fn((_intent: DiscardIntent) => { void _intent; }), attach: vi.fn((_id: string, _destination: string) => { void _id; void _destination; }), consume: vi.fn(() => []), invalidate: vi.fn() };
  return { ...h, stamps, intents, holder: createNavigationAttempts(intents), owner: h.store.getSnapshot().owner! };
}
describe("shared navigation attempts before the destination exists", () => {
  it("captures without inventing a destination and attaches exact original stamps once", () => {
    const h = fixture(); const a = h.holder.capture({ owner: h.owner, stamps: h.stamps });
    expect(a.isCurrent()).toBe(true); expect(h.intents.prepare).not.toHaveBeenCalled();
    h.binding.change(() => ({ value: "later" }));
    expect(a.attach("/invoicing/created")).toBe(true);
    expect(h.intents.prepare).toHaveBeenCalledExactlyOnceWith({ operationId: expect.any(String), owner: h.owner, stamps: h.stamps, destination: "/invoicing/created" });
    const operationId = h.intents.prepare.mock.calls[0][0].operationId;
    expect(h.intents.attach).toHaveBeenCalledExactlyOnceWith(operationId, "/invoicing/created");
    expect(a.attach("/invoicing/other")).toBe(false);
    expect(h.intents.consume).not.toHaveBeenCalled();
    expect(h.binding.getSnapshot().current!.data.value).toBe("later");
  });
  it("a Shell attempt supersedes a held invoice before any pathname commit", () => {
    const h = fixture(); const invoice = h.holder.capture({ owner: h.owner, stamps: h.stamps });
    const shell = h.holder.capture({ owner: h.owner, stamps: h.stamps });
    expect(invoice.isCurrent()).toBe(false); expect(invoice.attach("/invoicing/late")).toBe(false);
    expect(shell.isCurrent()).toBe(true); expect(shell.attach("/orders/other")).toBe(true);
    expect(h.intents.prepare).toHaveBeenCalledTimes(1); expect(h.intents.consume).not.toHaveBeenCalled();
  });
  it("a stale request failure cannot cancel a newer Shell attempt", () => {
    const h = fixture(); const old = h.holder.capture({ owner: h.owner, stamps: h.stamps });
    const next = h.holder.capture({ owner: h.owner, stamps: h.stamps }); old.cancel();
    expect(next.isCurrent()).toBe(true); expect(next.attach("/orders/next")).toBe(true);
  });
  it("popstate and ambiguous public commits invalidate and retain all data", () => {
    const h = fixture(); const a = h.holder.capture({ owner: h.owner, stamps: h.stamps });
    expect(a.attach("/orders/next")).toBe(true); h.holder.invalidate();
    expect(a.isCurrent()).toBe(false); expect(a.attach("/orders/next")).toBe(false);
    expect(h.intents.consume).not.toHaveBeenCalled(); expect(h.store.getSnapshot().count).toBe(1);
  });
  it("cancel before response leaves no attachable operation", () => {
    const h = fixture(); const a = h.holder.capture({ owner: h.owner, stamps: h.stamps }); a.cancel();
    expect(a.isCurrent()).toBe(false); expect(a.attach("/shipping/reversal")).toBe(false);
    expect(h.intents.prepare).not.toHaveBeenCalled(); expect(h.store.getSnapshot().count).toBe(1);
  });
});
