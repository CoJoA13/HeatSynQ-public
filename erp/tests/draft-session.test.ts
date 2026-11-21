import { describe, expect, it, vi } from "vitest";
import { createDraftSession, getBrowserDraftStore, installDraftUnload, sessionCheckStatus } from "../src/lib/draft-session";
import { openScalarDraft, scalarAdapter } from "./helpers/draft-store";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  const harness = openScalarDraft();
  harness.binding.change(() => ({ value: "private draft" }));
  return { ...harness, session: createDraftSession(harness.store) };
}
describe("document identity lifecycle", () => {
  it("does not create a browser store during server rendering", () => {
    expect(getBrowserDraftStore()).toBeNull();
  });
  it("hides drafts during transient identity retry and requires fresh record authorization", async () => {
    const { session, store, binding, baseline, clean } = setup();
    const read = deferred<{ id: string }>();
    const pending = session.validateIdentity(() => read.promise);
    expect(binding.getSnapshot().current).toBeUndefined();
    expect(store.getSnapshot().rows).toEqual([]);
    expect(store.getSnapshot().count).toBe(1);
    read.reject(new Error("offline"));
    expect((await pending).kind).toBe("retry");
    expect(store.getSnapshot().count).toBe(1);
    expect((await session.validateIdentity(async () => ({ id: "u1" }))).kind).toBe("ready");
    expect(binding.getSnapshot().current).toBeUndefined();
    const readId = binding.beginRead();
    binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
    expect(binding.getSnapshot().current?.data.value).toBe("private draft");
  });
  for (const id of ["u1", "u2"]) it(`explicit successful login purges previous drafts for ${id}`, async () => {
    const { session, store, binding } = setup();
    const stale = deferred<{ id: string }>();
    const pending = session.validateIdentity(() => stale.promise);
    session.loginSucceeded();
    await session.validateIdentity(async () => ({ id }));
    stale.resolve({ id: "u1" });
    expect((await pending).kind).toBe("stale");
    const reduce = vi.fn(() => ({ value: "late event" })); binding.change(reduce);
    expect(reduce).not.toHaveBeenCalled();
    expect(store.getSnapshot().count).toBe(0);
    expect(store.getSnapshot().owner?.userId).toBe(id);
  });
  it("different validated user purges previous work", async () => {
    const { session, store, binding } = setup();
    await session.validateIdentity(async () => ({ id: "u2" }));
    expect(store.getSnapshot().count).toBe(0);
    expect(binding.getSnapshot().current).toBeUndefined();
  });
  it("rejects stale me rejection after a newer successful read", async () => {
    const { session, store } = setup();
    const old = deferred<{ id: string }>(); const pending = session.validateIdentity(() => old.promise);
    await session.validateIdentity(async () => ({ id: "u1" }));
    old.reject({ status: 401 });
    expect((await pending).kind).toBe("stale");
    expect(store.getSnapshot().identityReady).toBe(true);
    expect(store.getSnapshot().count).toBe(1);
  });
  it("confirmed current expiry clears drafts", async () => {
    const { session, store } = setup();
    expect((await session.validateIdentity(async () => { throw { status: 401 }; })).kind).toBe("expired");
    expect(store.getSnapshot().count).toBe(0);
  });
  it("failed logout retains owner and edits; successful logout resets", async () => {
    const { session, store, binding } = setup();
    await expect(session.logout(async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(store.getSnapshot().identityReady).toBe(true);
    expect(binding.getSnapshot().current?.data.value).toBe("private draft");
    await session.logout(async () => undefined);
    expect(store.getSnapshot().count).toBe(0);
  });
  it("bfcache revalidation hides values and makes prior record callbacks inert", async () => {
    const { session, binding, baseline, clean, store } = setup();
    const readId = binding.beginRead(); const identity = deferred<{ id: string }>();
    const pending = session.validateIdentity(() => identity.promise);
    binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
    expect(binding.getSnapshot().current).toBeUndefined();
    identity.resolve({ id: "u1" }); await pending;
    expect(binding.getSnapshot().current).toBeUndefined();
    expect(store.getSnapshot().count).toBe(1);
  });
  it("a stale protected 401 cannot expire a replacement login; rejected login is not expiry", async () => {
    const { session, store } = setup();
    const old = session.requestTicket();
    session.observeUnauthorized(old, "/api/auth/login");
    expect(store.getSnapshot().count).toBe(1);
    session.loginSucceeded(); await session.validateIdentity(async () => ({ id: "u1" }));
    session.observeUnauthorized(old, "/api/orders/o1");
    expect(store.getSnapshot().identityReady).toBe(true);
    const current = session.requestTicket();
    session.observeUnauthorized(current, "/api/orders/o1");
    expect(store.getSnapshot().identityReady).toBe(false);
  });
  it("a current protected 401 asks for a fresh identity check only after its reset (#332)", async () => {
    const { session, store } = setup();
    const readyWhenAsked: boolean[] = [];
    const checks: Promise<{ kind: string }>[] = [];
    const off = session.subscribeUnauthorized(() => {
      readyWhenAsked.push(store.getSnapshot().identityReady);
      checks.push(session.validateIdentity(async () => { throw { status: 401 }; }));
    });
    // The check's own /me 401 must not ask again, or every check would start the next one.
    session.observeUnauthorized(session.requestTicket(), "/api/auth/me");
    expect(readyWhenAsked).toEqual([]);
    const ticket = session.requestTicket();
    session.observeUnauthorized(ticket, "/api/orders/o1");
    session.observeUnauthorized(ticket, "/api/orders/o2");
    expect(readyWhenAsked).toEqual([false]);
    expect(await Promise.all(checks)).toEqual([{ kind: "expired" }]);
    off();
    session.observeUnauthorized(session.requestTicket(), "/api/orders/o3");
    expect(readyWhenAsked).toHaveLength(1);
  });
  it("the failed-check status names hidden drafts only while some are retained (#332)", async () => {
    const { session, store } = setup();
    expect(sessionCheckStatus(false, store.getSnapshot())).toBe("Confirming your session…");
    expect((await session.validateIdentity(async () => { throw new Error("offline"); })).kind).toBe("retry");
    expect(sessionCheckStatus(true, store.getSnapshot()))
      .toBe("Could not confirm your session. Your retained drafts are hidden. Please retry.");
    session.observeUnauthorized(session.requestTicket(), "/api/orders/o1");
    expect((await session.validateIdentity(async () => { throw new Error("offline"); })).kind).toBe("retry");
    expect(sessionCheckStatus(true, store.getSnapshot())).toBe("Could not confirm your session. Please retry.");
  });
  it("late successful logout cannot reset a newer login", async () => {
    const { session, store } = setup(); const transport = deferred<void>();
    const pending = session.logout(() => transport.promise);
    session.loginSucceeded(); await session.validateIdentity(async () => ({ id: "u2" }));
    transport.resolve(); expect(await pending).toBe(false);
    expect(store.getSnapshot().owner?.userId).toBe("u2");
  });
});

describe("document controls", () => {
  it("selection is exact, consumed once and cleared by login", () => {
    const { session, binding } = setup(); const key = binding.getSnapshot().current!.stamp.key;
    expect(session.select(key)).toBe(true);
    expect(session.consumeSelection({ ...key, childId: "other" })).toBe(false);
    expect(session.consumeSelection(key)).toBe(true);
    expect(session.consumeSelection(key)).toBe(false);
    session.select(key); session.loginSucceeded();
    expect(session.consumeSelection(key)).toBe(false);
  });
});

it("arms unload synchronously on first edit, retains it during checks and disarms on reset", () => {
  const { store, binding } = openScalarDraft();
  const addEventListener = vi.fn(); const removeEventListener = vi.fn();
  const cleanup = installDraftUnload(store, { addEventListener, removeEventListener });
  expect(addEventListener).not.toHaveBeenCalled();
  binding.change(() => ({ value: "first event" }));
  expect(addEventListener).toHaveBeenCalledTimes(1);
  expect(addEventListener.mock.calls[0][0]).toBe("beforeunload");
  const event = { preventDefault: vi.fn(), returnValue: undefined };
  addEventListener.mock.calls[0][1](event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  store.beginIdentityCheck(); expect(removeEventListener).not.toHaveBeenCalled();
  store.resetIdentity(); expect(removeEventListener).toHaveBeenCalledTimes(1);
  cleanup();
});

it("different-user validation invalidates previously dispatched protected requests", async () => {
  const { session, store } = setup(); const old = session.requestTicket();
  await session.validateIdentity(async () => ({ id: "u2" }));
  session.observeUnauthorized(old, "/api/orders/o1");
  expect(store.getSnapshot().owner?.userId).toBe("u2");
});


it("identity invalidation hides all editor snapshots before notifying any subscriber", async () => {
  const { store, binding, session, baseline, clean } = setup();
  const second = store.bind({ owner: store.getSnapshot().owner!, record: {kind: "order", id: "o2"}, editor: scalarAdapter.kind }, {label: "Draft", href: "/orders/o2"}, scalarAdapter);
  second.attach("second-view");
  const readId = second.beginRead(); second.acceptRead({kind: "authorized", readId, baseline, editable: true}, clean);
  second.change(() => ({value: "second editor private value"}));
  const observed: (string | undefined)[] = [];
  const off = binding.subscribe(() => { observed.push(second.getSnapshot().current?.data.value); });
  const identity = deferred<{id: string}>();
  const pending = session.validateIdentity(() => identity.promise);
  expect(observed.length).toBeGreaterThan(0);
  expect(observed.every(value => value === undefined)).toBe(true);
  off(); identity.resolve({id: "u1"}); await pending;
});


it("late rejected logout does not surface an error in a replacement login", async () => {
  const { session, store } = setup();
  const transport = deferred<void>();
  const pending = session.logout(() => transport.promise);
  session.loginSucceeded(); await session.validateIdentity(async () => ({id: "u2"}));
  transport.reject(new Error("old request failed"));
  await expect(pending).resolves.toBe(false);
  expect(store.getSnapshot().owner?.userId).toBe("u2");
});
