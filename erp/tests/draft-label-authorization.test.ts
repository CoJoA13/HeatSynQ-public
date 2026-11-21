import { describe, expect, it } from "vitest";
import { createDraftSession } from "../src/lib/draft-session";
import { openScalarDraft } from "./helpers/draft-store";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe("identifying label authorization", () => {
  it("rejects a pre-check label response after same-user revalidation and accepts a newly dispatched read", async () => {
    const { store } = openScalarDraft();
    const session = createDraftSession(store);
    const oldLabel = deferred<string>();
    const oldTicket = session.readAuthorizationTicket();
    const previousRevision = session.getReadAuthorizationRevision();
    const pendingOld = oldLabel.promise.then(label => session.isReadAuthorized(oldTicket) ? label : null);
    const identity = deferred<{ id: string }>();
    const pendingIdentity = session.validateIdentity(() => identity.promise);
    expect(session.getReadAuthorizationRevision()).toBeGreaterThan(previousRevision);
    expect(session.readAuthorizationTicket()).toBeNull();
    expect(session.isReadAuthorized(oldTicket)).toBe(false);
    identity.resolve({ id: "u1" });
    expect((await pendingIdentity).kind).toBe("ready");
    // No intermediate component unmount or render is assumed between check and acceptance.
    oldLabel.resolve("stale identifying label");
    expect(await pendingOld).toBeNull();
    const newLabel = deferred<string>();
    const newTicket = session.readAuthorizationTicket();
    expect(newTicket).not.toBeNull();
    const pendingNew = newLabel.promise.then(label => session.isReadAuthorized(newTicket) ? label : null);
    newLabel.resolve("fresh authorized label");
    expect(await pendingNew).toBe("fresh authorized label");
  });

  it("keeps transport-generation tickets valid across same-user checks so a protected 401 still expires identity", async () => {
    const { store, binding } = openScalarDraft();
    binding.change(() => ({ value: "private draft" }));
    const session = createDraftSession(store);
    const transportTicket = session.requestTicket();
    const identity = deferred<{ id: string }>();
    const pending = session.validateIdentity(() => identity.promise);
    expect(session.isCurrent(transportTicket)).toBe(true);
    identity.resolve({ id: "u1" }); await pending;
    expect(session.isCurrent(transportTicket)).toBe(true);
    session.observeUnauthorized(transportTicket, "/api/orders/o1");
    expect(store.getSnapshot().identityReady).toBe(false);
    expect(store.getSnapshot().count).toBe(0);
  });
});
