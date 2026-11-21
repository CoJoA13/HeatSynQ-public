import { describe, expect, it, vi } from "vitest";
import { shareInFlight, type ReadAuthorization } from "../src/lib/inflight-share";
import { createOrderBulkSource } from "../src/lib/order-bulk-recovery";
import { createBulkRecoverySource } from "../src/lib/bulk-recovery-source";
import { shipmentBulkOptions } from "../src/lib/shipment-bulk-recovery";
import { orderBulkFixture } from "./helpers/order-bulk-fixture";
import { shipmentFixture } from "./helpers/remaining-bulk-fixtures";
import { api as apiTransport } from "../src/lib/fetcher";

vi.mock("../src/lib/fetcher", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/fetcher")>(), api: vi.fn(),
}));

// #608 (2026-10-22 review, Speed 2): every bulk grid ran its own recovery read, so the hub's eight
// grids sent eight order GETs, eight /me and eight pick-list reads on mount, and a shipment's three
// grids per order read that order three times after every accept. A read begun while another is in
// flight UNDER THE SAME READ AUTHORIZATION joins it; nothing is kept past the flight (not a cache:
// a settled flight is forgotten, and a flight begun under a ticket that is no longer authorized is
// not joined). Each grid still checks its own ticket when the read lands (bulk-grid.ts).
// Mutations: drop the `authorized` check and the "ticket changed" cases red; keep the flight after
// settle and the "sequential reads read again" cases red.

function fakeAuth() {
  let current = 1;
  const auth: ReadAuthorization = {
    ticket: () => ({ id: current }),
    authorized: (ticket) => (ticket as { id: number }).id === current,
  };
  return { auth, change: () => { current++; } };
}
function deferred<T>() {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("shareInFlight", () => {
  it("joins a flight begun under the same authorization and forgets it once settled", async () => {
    const { auth } = fakeAuth();
    const d = deferred<number>();
    const read = vi.fn(() => d.promise);
    const shared = shareInFlight(auth, read);
    const a = shared.read(); const b = shared.read();
    expect(read).toHaveBeenCalledTimes(1);
    d.resolve(7);
    expect(await a).toBe(7); expect(await b).toBe(7);
    await shared.read();
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("does not join a flight whose ticket is no longer authorized", async () => {
    const { auth, change } = fakeAuth();
    const d = deferred<number>();
    const read = vi.fn(() => d.promise);
    const shared = shareInFlight(auth, read);
    void shared.read();
    change();
    void shared.read();
    expect(read).toHaveBeenCalledTimes(2);
    d.resolve(1);
  });
  it("reads unshared, and shares nothing, while no ticket is held", async () => {
    const auth: ReadAuthorization = { ticket: () => null, authorized: () => true };
    const read = vi.fn(async () => 1);
    const shared = shareInFlight(auth, read);
    void shared.read(); void shared.read();
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("a rejected flight rejects every joiner and is forgotten", async () => {
    const { auth } = fakeAuth();
    const d = deferred<number>();
    const read = vi.fn(() => d.promise);
    const shared = shareInFlight(auth, read);
    const a = shared.read().catch(e => e); const b = shared.read().catch(e => e);
    d.reject(new Error("offline"));
    expect((await a).message).toBe("offline"); expect((await b).message).toBe("offline");
    read.mockImplementation(async () => 2);
    expect(await shared.read()).toBe(2);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("a mutation boundary retires the flight (Codex on #738)", () => {
  // A save does not retire the session's ticket, so without this a flight begun before the save
  // would answer the saving grid's post-acknowledgement refresh with the pre-save record.
  // Mutation: drop `shared.retire()` from either `begin()` and its case reds.
  it("shareInFlight.retire: a read after retire starts its own flight; the old flight still answers its joiners", async () => {
    const { auth } = fakeAuth();
    const first = deferred<number>(); const second = deferred<number>();
    const flights = [first, second];
    const read = vi.fn(() => flights.shift()!.promise);
    const shared = shareInFlight(auth, read);
    const early = shared.read();
    shared.retire();
    const late = shared.read();
    expect(read).toHaveBeenCalledTimes(2);
    first.resolve(1); second.resolve(2);
    expect(await early).toBe(1); expect(await late).toBe(2);
  });
  it("createOrderBulkSource: a read asked for after begin() does not join the flight begun before it", async () => {
    const { auth } = fakeAuth();
    const saved = orderBulkFixture().order;
    const stale = deferred<typeof saved>();
    const readOrder = vi.fn<() => Promise<typeof saved>>().mockImplementationOnce(() => stale.promise).mockImplementation(async () => ({ ...saved, poNumber: "after-save" }));
    const source = createOrderBulkSource(readOrder, async () => ({ editable: true, containerTypes: [] }), auth);
    const before = source.read();
    source.begin();
    const after = await source.read();
    expect(readOrder).toHaveBeenCalledTimes(2);
    expect(after.order.poNumber).toBe("after-save");
    stale.resolve(saved);
    expect((await before).order.poNumber).toBe(saved.poNumber);
  });
  // Codex's second P1: a read begun DURING the save (after begin(), before accept()) carries the
  // pre-save record, and the post-acknowledgement refresh must not join it either. Settlement
  // retires it. Mutation: drop `shared.retire()` from `accept()` and these two cases red.
  it("createOrderBulkSource: a read asked for after accept() does not join a flight begun during the save", async () => {
    const { auth } = fakeAuth();
    const saved = orderBulkFixture().order;
    const during = deferred<typeof saved>();
    const readOrder = vi.fn<() => Promise<typeof saved>>().mockImplementationOnce(() => during.promise).mockImplementation(async () => ({ ...saved, poNumber: "after-save" }));
    const source = createOrderBulkSource(readOrder, async () => ({ editable: true, containerTypes: [] }), auth);
    const dispatch = source.begin();
    void source.read(); // a sibling grid's retry while the save is out
    await dispatch.accept({ ...saved, poNumber: "after-save" });
    const refresh = await source.read();
    expect(readOrder).toHaveBeenCalledTimes(2);
    expect(refresh.order.poNumber).toBe("after-save");
    during.resolve(saved);
  });
  it("createBulkRecoverySource: a read after accept() or unavailable() does not join a during-save flight", async () => {
    const { auth } = fakeAuth();
    let v = 1;
    const readRecord = vi.fn(async () => ({ id: "r1", v }));
    const source = createBulkRecoverySource(readRecord, async () => ["edit"], auth);
    const gate = deferred<void>();
    readRecord.mockImplementationOnce(async () => { await gate.promise; return { id: "r1", v: 1 }; });
    const dispatch = source.begin();
    void source.read();
    v = 2;
    await dispatch.accept({ id: "r1", v: 2 });
    expect((await source.read()).record.v).toBe(2);
    const second = source.begin();
    readRecord.mockImplementationOnce(async () => { await gate.promise; return { id: "r1", v: 2 }; });
    void source.read();
    v = 3;
    second.unavailable();
    expect((await source.read()).record.v).toBe(3);
    gate.resolve();
  });
  it("createBulkRecoverySource: the same", async () => {
    const { auth } = fakeAuth();
    const stale = deferred<{ id: string; v: number }>();
    const readRecord = vi.fn<() => Promise<{ id: string; v: number }>>().mockImplementationOnce(() => stale.promise).mockImplementation(async () => ({ id: "r1", v: 2 }));
    const source = createBulkRecoverySource(readRecord, async () => ["edit"], auth);
    void source.read();
    source.begin();
    expect((await source.read()).record.v).toBe(2);
    expect(readRecord).toHaveBeenCalledTimes(2);
    stale.resolve({ id: "r1", v: 1 });
  });
});

describe("createOrderBulkSource.read", () => {
  it("serves concurrent readers from one order GET and one access read, and reads again for a later reader", async () => {
    const { auth } = fakeAuth();
    const saved = orderBulkFixture().order;
    const readOrder = vi.fn(async () => saved);
    const readAccess = vi.fn(async () => ({ editable: true, containerTypes: [] }));
    const source = createOrderBulkSource(readOrder, readAccess, auth);
    const [a, b, c] = await Promise.all([source.read(), source.read(), source.read()]);
    expect(readOrder).toHaveBeenCalledTimes(1); expect(readAccess).toHaveBeenCalledTimes(1);
    expect(a).toBe(b); expect(b).toBe(c);
    await source.read();
    expect(readOrder).toHaveBeenCalledTimes(2);
  });
  it("a reader under a changed ticket gets its own flight", async () => {
    const { auth, change } = fakeAuth();
    const saved = orderBulkFixture().order;
    const gate = deferred<typeof saved>();
    const readOrder = vi.fn(() => gate.promise);
    const source = createOrderBulkSource(readOrder, async () => ({ editable: true, containerTypes: [] }), auth);
    void source.read();
    change();
    void source.read();
    expect(readOrder).toHaveBeenCalledTimes(2);
    gate.resolve(saved);
  });
});

describe("createBulkRecoverySource.read", () => {
  it("serves concurrent readers from one record read and one access read", async () => {
    const { auth } = fakeAuth();
    const readRecord = vi.fn(async () => ({ id: "r1" }));
    const readAccess = vi.fn(async () => ["edit"]);
    const source = createBulkRecoverySource(readRecord, readAccess, auth);
    const [a, b] = await Promise.all([source.read(), source.read()]);
    expect(readRecord).toHaveBeenCalledTimes(1); expect(readAccess).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    await source.read();
    expect(readRecord).toHaveBeenCalledTimes(2);
  });
});

describe("shipmentBulkOptions catalog reads", () => {
  it("three grids of one order mounting at once read that order once, from one shared snapshot", async () => {
    const fixture = shipmentFixture();
    const transport = vi.mocked(apiTransport);
    transport.mockResolvedValue({ lines: [], containers: [], serials: [] });
    const snapshot = { record: fixture.shipper, access: fixture.permissions };
    const flight = Promise.resolve(snapshot);
    const source = { read: () => flight, register: vi.fn(), begin: vi.fn() };
    const grids = (["lines", "containers", "serials"] as const).map(kind => shipmentBulkOptions(source, "ship-1", "so-1", kind));
    await Promise.all(grids.map(grid => grid.read()));
    expect(transport.mock.calls.map(call => call[0])).toEqual(["/api/orders/order-1"]);
    // A later read is a new snapshot object: it reads the order again.
    source.read = () => Promise.resolve({ ...snapshot });
    await grids[0].read();
    expect(transport.mock.calls.map(call => call[0])).toEqual(["/api/orders/order-1", "/api/orders/order-1"]);
    transport.mockReset();
  });
  it("the acceptors of one dispatch share one order read per order; the next dispatch reads again", async () => {
    // Through the REAL source (Codex on #738: a mock dispatch handing one object proved nothing;
    // `accept()` built a snapshot per acceptor, so the three grids keyed three reads).
    const fixture = shipmentFixture();
    const transport = vi.mocked(apiTransport);
    transport.mockResolvedValue({ lines: [], containers: [], serials: [] });
    const { auth } = fakeAuth();
    const source = createBulkRecoverySource(async () => fixture.shipper, async () => fixture.permissions, auth);
    const accepted = vi.fn();
    for (const kind of ["lines", "containers", "serials"] as const) shipmentBulkOptions(source, "ship-1", "so-1", kind).register(() => accepted);
    const dispatch = async () => {
      await source.begin().accept(fixture.shipper);
      await new Promise(r => setTimeout(r, 0));
    };
    await dispatch();
    expect(transport.mock.calls.map(call => call[0])).toEqual(["/api/orders/order-1"]);
    expect(accepted).toHaveBeenCalledTimes(3);
    await dispatch();
    expect(transport.mock.calls.map(call => call[0])).toEqual(["/api/orders/order-1", "/api/orders/order-1"]);
    transport.mockReset();
  });
});
