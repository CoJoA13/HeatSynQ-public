import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { drainOtherKeys, makeWriteSignals, reReadAfter } from "@/lib/drain-queue";
import { ApiError, UnreadableAnswerError, WRITE_ANSWER_UNREADABLE } from "@/lib/fetcher";
import { mergePrinted, NOTHING_PRINTED, type PrintedOrders } from "@/lib/shipment-remove-order";
import type { ShipToAddress } from "@/lib/shipment-ship-to";
import { makeEditGuard } from "@/lib/use-edit-guard";
import { makeMutationGate } from "@/lib/use-latest";
import { source } from "./helpers/lift-callback";
import { all, run } from "./helpers/source-lift";

// #573 (owner ruling 2026-10-20, amendment 1: the hub's #550 rule on the saved shipment page). The
// page's `load` sends its GET at once and takes the newest ticket, so a read served before a write
// still out had committed holds the newer ticket: it reverts that write on screen, or has the
// write's answer dropped at the gate. The page's header PATCH drains its sibling header keys before
// its rollback read, but the writes `applyMutation` sends that the drain never sees (the order
// panels' Lines, Containers and Serials saves, Add order, Remove order) were not waited for, and a
// rollback read beside one of them lost the write's answer until the next payload.
//
// Now `applyMutation` registers each dispatch in the page's one registry of writes in flight
// (`makeWriteSignals`, drain-queue.ts), in the same synchronous run as its ticket, and the entry
// goes when the request settles, however it ends. `load` snapshots the registry as its GET is sent;
// when the snapshot held a write, the page reads once more after every write in it has settled,
// whether or not one was still out when the read landed, and detached, so nothing `load`'s caller
// does waits on a write (the plan's amendment 1: the follow-up obeys the same rule, a failed one is
// any failed read of the shipment, which marks the grids' recovery read unavailable with no
// message, and none is retried). The drains stay, and keep only their timing effect.
//
// vitest has no DOM, so nothing here renders. Both functions are lifted out of ShipmentDetail.tsx's
// syntax tree and run closed over one environment and nothing else: the real mutation gate, the
// real edit guard, the real registry, the real follow-up decision, the real `mergePrinted` and the
// real drain, with each request, each recovery read and the four states a read sets recorded. A
// lifted function that gains a free identifier on a path these cases take must gain it here in the
// same change, or it is a ReferenceError in this file. The environment hands both functions one
// registry, so whether the page builds its registry once per mount is pinned on the source instead
// (the source pin at the end of the registration describe). Some cases are green on the page before
// #573, where no read was followed, so "one GET" and "not followed" held trivially; the progress
// record's mutation table says which cases each guard reds. The grids' own recovery reads (the bulk
// recovery source's `read` and a grid's Check again) wait for no write: a recorded residual (the
// plan's amendment 2), outside what this file proves.

type ShipperOrder = { id: string; orderNumber: number; lines: Array<{ id: string; qty: number }> };
type Shipper = { id: string; shipperNumber: number; carrierName: string | null; comments: string | null; orders: ShipperOrder[] };
type Answer = { shipper: Shipper; warnings: string[]; printed: PrintedOrders; shipToAddress: ShipToAddress | null };
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** One macrotask: every promise reaction queued so far has run. */
const flush = () => new Promise<void>((done) => { setTimeout(done, 0); });

const order = (orderNumber: number): ShipperOrder => ({ id: `order-${orderNumber}`, orderNumber, lines: [{ id: `L-${orderNumber}`, qty: 20 }] });
const STORED: Shipper = { id: "shipper-1", shipperNumber: 5001, carrierName: null, comments: null, orders: [order(1031)] };
const ADDRESS: ShipToAddress = { name: "Dock 4", street: "1 Mill Rd", city: "Elgin", state: "IL", zip: "60120" };

/** The `useCallback(…)` call ShipmentDetail.tsx declares under `name`. */
function declaredCallback(file: ts.SourceFile, name: string): ts.CallExpression {
  const found = all(file, ts.isVariableDeclaration).filter((d) => ts.isIdentifier(d.name) && d.name.text === name);
  expect(found, name).toHaveLength(1);
  const wrapped = found[0].initializer;
  if (!wrapped || !ts.isCallExpression(wrapped) || wrapped.expression.getText(file) !== "useCallback") {
    throw new Error(`${name} is no longer a useCallback in ShipmentDetail.tsx`);
  }
  return wrapped;
}

const PAGE = "app/shipping/[id]/ShipmentDetail.tsx";

/** The `useCallback` argument ShipmentDetail.tsx declares under `name`, closed over `environment`. */
function lifted<T>(name: string, environment: Record<string, unknown>): T {
  const file = source(PAGE);
  return run<T>(declaredCallback(file, name).arguments[0].getText(file), environment);
}

/** One mounted shipment page: `load` and `applyMutation` over one environment, the page holding
 *  `initial`. Each GET `load` sends waits in `requests` until the case answers it. */
function page(initial: Shipper) {
  let state: Shipper | null = initial;
  let printed: PrintedOrders = NOTHING_PRINTED;
  const editGuard = makeEditGuard();
  const requests: Array<{ url: string; answer: Deferred<Answer> }> = [];
  const reads: Array<{ unavailable: ReturnType<typeof vi.fn>; accept: ReturnType<typeof vi.fn> }> = [];
  // Each recovery read begun and each GET sent, in the order they happen; a case adds its own.
  const events: string[] = [];
  const writes = makeWriteSignals();
  const invalidateHistory = vi.fn();
  const setWarnings = vi.fn();
  const setShipToAddress = vi.fn();
  // Every setter of the page's messages: its banners (`error`, the first read's `initialLoadError`,
  // the supplementary fetches' `loadError`, which `addLoadError` appends to) and the print's.
  // Neither function sets one; a case asserts it stays so.
  const messages = {
    setError: vi.fn(), setInitialLoadError: vi.fn(), setLoadError: vi.fn(), addLoadError: vi.fn(), setPrintError: vi.fn(),
  };
  const environment: Record<string, unknown> = {
    id: "shipper-1",
    mutations: makeMutationGate(),
    writes,
    reReadAfter,
    recoverySource: {
      begin: () => {
        const read = { unavailable: vi.fn(), accept: vi.fn(async () => true) };
        reads.push(read);
        events.push("begin");
        return read;
      },
    },
    api: (url: string) => {
      const answer = deferred<Answer>();
      requests.push({ url, answer });
      events.push("GET");
      return answer.promise;
    },
    editGuard,
    setShipper: (update: Shipper | null | ((cur: Shipper | null) => Shipper | null)) => {
      state = typeof update === "function" ? update(state) : update;
    },
    setWarnings,
    setPrintedOrders: (update: PrintedOrders | ((cur: PrintedOrders) => PrintedOrders)) => {
      printed = typeof update === "function" ? update(printed) : update;
    },
    setShipToAddress,
    // #653: the server's last adopted Package count, noted beside each applyPayload adoption.
    storedPackageCount: { current: null },
    mergePrinted,
    ApiError,
    UnreadableAnswerError,
    invalidateHistory,
    ...messages,
  };
  return {
    load: lifted<() => Promise<Shipper>>("load", environment),
    applyMutation: lifted<(work: () => Promise<Answer>) => Promise<void>>("applyMutation", environment),
    editGuard, requests, reads, events, messages, setWarnings, setShipToAddress, writes, invalidateHistory,
    state: () => state,
    printed: () => printed,
    /** A key typed into a header box: the page's own setter, not a server payload. */
    type: (patch: Partial<Shipper>) => { state = state && { ...state, ...patch }; },
  };
}

/** The user enters the Comments box, which shows `shown`. */
const focusComments = (p: ReturnType<typeof page>, shown: string) =>
  p.editGuard.onFocusField("comments")({ target: { value: shown } } as never);

/** The shipment as the server holds it, carrying the orders numbered `orderNumbers`. */
const holding = (...orderNumbers: number[]): Shipper => ({ ...STORED, orders: orderNumbers.map(order) });
/** An answer of that shipment: what a read and a write both carry. */
const answerOf = (shipper: Shipper, rest: Partial<Omit<Answer, "shipper">> = {}): Answer =>
  ({ shipper, warnings: [], printed: NOTHING_PRINTED, shipToAddress: null, ...rest });
/** The order numbers the page shows, in order. */
const shownOrders = (p: ReturnType<typeof page>) => p.state()?.orders.map((o) => o.orderNumber);

/** A write sent through `applyMutation`, its answer held until the case gives it. */
function write(p: ReturnType<typeof page>) {
  const answer = deferred<Answer>();
  const done = p.applyMutation(() => answer.promise);
  return { answer, done };
}

/** Collects the unhandled rejections Node reports while `body` runs (the drain-queue.test.ts
 *  shape). Node reports one once the microtasks of the task that caused it have drained, so two
 *  macrotasks are waited out before the listener comes off. */
async function unhandledDuring(body: () => Promise<void>): Promise<unknown[]> {
  const reported: unknown[] = [];
  const record = (reason: unknown) => { reported.push(reason); };
  process.on("unhandledRejection", record);
  try {
    await body();
    await new Promise((resolve) => { setImmediate(resolve); });
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  } finally {
    process.off("unhandledRejection", record);
  }
  return reported;
}

describe("saved shipment: load and applyMutation apply the four states an answer carries", () => {
  it("load applies the shipment, its warnings, what has printed and the ship-to address, and hands the recovery read the shipment", async () => {
    const p = page(STORED);
    const done = p.load();
    expect(p.requests.map((r) => r.url)).toEqual(["/api/shippers/shipper-1"]);
    const read = answerOf(holding(1031, 1032), { warnings: ["w1"], printed: { paperOrderIds: ["order-1031"], certOrderIds: [] }, shipToAddress: ADDRESS });
    p.requests[0].answer.resolve(read);
    await expect(done).resolves.toBe(read.shipper);
    expect(p.state()).toEqual(read.shipper);
    expect(p.setWarnings).toHaveBeenCalledWith(["w1"]);
    expect(p.printed()).toEqual({ paperOrderIds: ["order-1031"], certOrderIds: [] });
    expect(p.setShipToAddress).toHaveBeenCalledWith(ADDRESS);
    expect(p.reads).toHaveLength(1);
    expect(p.reads[0].accept).toHaveBeenCalledWith(read.shipper);
  });

  it("load: a focused Comments box the user has typed into keeps its text in the same apply", async () => {
    const p = page(STORED);
    focusComments(p, "");
    p.type({ comments: "typed" });
    const done = p.load();
    p.requests[0].answer.resolve(answerOf({ ...STORED, comments: "from the server", carrierName: "UPS" }));
    await done;
    expect(p.state()).toEqual({ ...STORED, comments: "typed", carrierName: "UPS" });
  });

  it("applyMutation: a focused Comments box the user has typed into keeps its text in the same apply", async () => {
    const p = page(STORED);
    focusComments(p, "");
    p.type({ comments: "typed" });
    await p.applyMutation(async () => answerOf({ ...STORED, comments: "from the server", carrierName: "UPS" }));
    expect(p.state()).toEqual({ ...STORED, comments: "typed", carrierName: "UPS" });
    expect(p.invalidateHistory).toHaveBeenCalledTimes(1);
  });
});

describe("saved shipment: applyMutation registers each dispatch (#573, the hub's #550 ruling 1)", () => {
  it("a write is in the registry from the instant it is sent, and stays while its request is out", async () => {
    const p = page(STORED);
    const answer = deferred<Answer>();
    // Every call of the thunk is a request sent: it runs once, and the request registered is the
    // one awaited.
    const thunk = vi.fn(() => answer.promise);
    const done = p.applyMutation(thunk);
    // No await yet: registered in the same synchronous run as the ticket.
    expect(p.writes.outstanding()).toHaveLength(1);
    const [signal] = p.writes.outstanding();
    await flush();
    // Still out, and still the one entry: the signal is the request's, not one that settles alone.
    expect(p.writes.outstanding()).toHaveLength(1);
    expect(p.writes.outstanding()[0]).toBe(signal);
    answer.resolve(answerOf(holding(1031, 1032)));
    await done;
    expect(thunk).toHaveBeenCalledTimes(1);
  });

  it("a write whose answer lands leaves the registry, and History is told once", async () => {
    const p = page(STORED);
    const answer = deferred<Answer>();
    const done = p.applyMutation(() => answer.promise);
    expect(p.writes.outstanding()).toHaveLength(1);
    answer.resolve(answerOf(holding(1031, 1032)));
    await done;
    await flush();
    expect(p.writes.outstanding()).toEqual([]);
    expect(shownOrders(p)).toEqual([1031, 1032]);
    expect(p.invalidateHistory).toHaveBeenCalledTimes(1);
  });

  it("a write that fails leaves the registry however it fails, and the rejection still reaches the caller", async () => {
    const failures = [
      new ApiError("Order #1032 line 1: ship-now quantity exceeds the remainder", 409),
      new ApiError("Request failed (500)", 500),
      new ApiError("Not signed in", 401),
      new ApiError("You do not have permission for that", 403),
      new TypeError("Failed to fetch"),
      new UnreadableAnswerError(WRITE_ANSWER_UNREADABLE, { cause: new SyntaxError("Unexpected end of JSON input") }),
    ];
    for (const failure of failures) {
      const p = page(STORED);
      const answer = deferred<Answer>();
      const thunk = vi.fn(() => answer.promise);
      const done = p.applyMutation(thunk);
      expect(p.writes.outstanding(), failure.message).toHaveLength(1);
      answer.reject(failure);
      await expect(done, failure.message).rejects.toBe(failure);
      expect(thunk, failure.message).toHaveBeenCalledTimes(1);
      await flush();
      expect(p.writes.outstanding(), failure.message).toEqual([]);
      // #547: an unreadable 2xx committed its write, so History is told; nothing else is.
      const told = failure instanceof UnreadableAnswerError ? 1 : 0;
      expect(p.invalidateHistory, failure.message).toHaveBeenCalledTimes(told);
      // A 401 or 403 marks the write's own recovery read unavailable; no other failure touches it.
      const unavailable = failure instanceof ApiError && (failure.status === 401 || failure.status === 403) ? 1 : 0;
      expect(p.reads, failure.message).toHaveLength(1);
      expect(p.reads[0].unavailable, failure.message).toHaveBeenCalledTimes(unavailable);
      expect(p.state(), failure.message).toBe(STORED);
      expect(p.setWarnings, failure.message).not.toHaveBeenCalled();
      expect(p.setShipToAddress, failure.message).not.toHaveBeenCalled();
      expect(p.printed(), failure.message).toBe(NOTHING_PRINTED);
    }
  });

  it("a thunk that throws before it returns sent nothing, registers nothing, and its error reaches the caller", async () => {
    const p = page(STORED);
    const thrown = new Error("Container 1, Tare each (lb): cannot be negative.");
    const done = p.applyMutation(() => { throw thrown; });
    expect(p.writes.outstanding()).toEqual([]);
    await expect(done).rejects.toBe(thrown);
    await flush();
    expect(p.writes.outstanding()).toEqual([]);
  });

  it("the page holds one registry per mount, and applyMutation and load both read that one", () => {
    const file = source(PAGE);
    const pages = file.statements.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "ShipmentDetail");
    expect(pages).toHaveLength(1);
    const body = pages[0].body!;
    // Every binding of the name in ShipmentDetail, at any depth: exactly one, `const [writes] =
    // useState(makeWriteSignals)`, a statement of the component itself. Built once, as
    // useMutationGate's gate is: a registry built per render starts empty on every render.
    const bindsWrites = (d: ts.VariableDeclaration) => ts.isIdentifier(d.name)
      ? d.name.text === "writes"
      : all(d.name, ts.isBindingElement).some((e) => ts.isIdentifier(e.name) && e.name.text === "writes");
    const declarations = all(body, ts.isVariableDeclaration).filter(bindsWrites);
    expect(declarations).toHaveLength(1);
    const [declaration] = declarations;
    expect(declaration.name.getText(file)).toBe("[writes]");
    expect(declaration.initializer?.getText(file)).toBe("useState(makeWriteSignals)");
    expect(body.statements).toContain(declaration.parent.parent);
    // No second registry anywhere in the file: makeWriteSignals is handed to useState, never called.
    const calls = all(file, ts.isCallExpression).filter((c) => ts.isIdentifier(c.expression) && c.expression.text === "makeWriteSignals");
    expect(calls).toHaveLength(0);

    const wrapped = declaredCallback(file, "applyMutation");
    const [callback, deps] = wrapped.arguments;
    if (!deps || !ts.isArrayLiteralExpression(deps)) throw new Error("applyMutation has no dependency array");
    expect(deps.elements.map((e) => e.getText(file))).toContain("writes");
    // Each registration in the callback is on that registry, under that name.
    const registrations = all(callback, ts.isCallExpression).filter((c) =>
      ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === "dispatched");
    expect(registrations.map((c) => c.expression.getText(file))).toEqual(["writes.dispatched"]);

    // `load` reads the same registry, under the same name, and names it among its dependencies: the
    // lifted cases hand both functions one registry, so only the source says the page does too.
    const loadWrapped = declaredCallback(file, "load");
    const [loadCallback, loadDeps] = loadWrapped.arguments;
    if (!loadDeps || !ts.isArrayLiteralExpression(loadDeps)) throw new Error("load has no dependency array");
    expect(loadDeps.elements.map((e) => e.getText(file))).toContain("writes");
    const snapshots = all(loadCallback, ts.isCallExpression).filter((c) =>
      ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === "outstanding");
    expect(snapshots.map((c) => c.expression.getText(file))).toEqual(["writes.outstanding"]);
    // And decides the follow-up through the leaf, once: the follow-up is the same read, not a
    // second site that sets the four states (tests/shipment-detail-wiring.test.ts counts those).
    const followUps = all(loadCallback, ts.isCallExpression).filter((c) =>
      ts.isIdentifier(c.expression) && c.expression.text === "reReadAfter");
    expect(followUps).toHaveLength(1);
  });
});

describe("saved shipment: load reads now and once more after the writes it overlapped (#573)", () => {
  it("ordering (a): the read lands before the write's answer, which the gate drops, and the read after the write shows it, all four states under the follow-up's ticket", async () => {
    const p = page(holding(1031));
    const w = write(p); // Add order 1032, say
    const read = p.load();
    expect(p.requests.map((r) => r.url)).toEqual(["/api/shippers/shipper-1"]);
    // Served before the write committed, it lands first and is applied.
    const first = answerOf(holding(1031), { warnings: ["before"], shipToAddress: null });
    p.requests[0].answer.resolve(first);
    await expect(read).resolves.toBe(first.shipper);
    expect(shownOrders(p)).toEqual([1031]);
    expect(p.setWarnings.mock.calls).toEqual([[["before"]]]);
    await flush();
    expect(p.requests).toHaveLength(1); // nothing more while the write is out
    // The write's answer holds the older ticket and is dropped: History is still told.
    w.answer.resolve(answerOf(holding(1031, 1032), { warnings: ["after"] }));
    await w.done;
    expect(shownOrders(p)).toEqual([1031]);
    expect(p.setWarnings.mock.calls).toEqual([[["before"]]]);
    expect(p.invalidateHistory).toHaveBeenCalledTimes(1);
    await flush();
    expect(p.requests.map((r) => r.url)).toEqual(["/api/shippers/shipper-1", "/api/shippers/shipper-1"]);
    const second = answerOf(holding(1031, 1032), {
      warnings: ["after"], printed: { paperOrderIds: ["order-1031"], certOrderIds: ["order-1032"] }, shipToAddress: ADDRESS,
    });
    p.requests[1].answer.resolve(second);
    await flush();
    // The follow-up's own ticket is the newest, so every one of its four states is applied.
    expect(shownOrders(p)).toEqual([1031, 1032]);
    expect(p.state()).toEqual(second.shipper);
    expect(p.setWarnings.mock.calls).toEqual([[["before"]], [["after"]]]);
    expect(p.printed()).toEqual({ paperOrderIds: ["order-1031"], certOrderIds: ["order-1032"] });
    expect(p.setShipToAddress.mock.calls).toEqual([[null], [ADDRESS]]);
    expect(p.reads).toHaveLength(3);
    expect(p.reads[2].accept).toHaveBeenCalledWith(second.shipper);
    expect(p.requests).toHaveLength(2);
  });

  it("ordering (b): the write's answer lands first and the stale read reverts it, and the read after it shows the write again", async () => {
    const p = page(holding(1031));
    const w = write(p);
    const read = p.load();
    w.answer.resolve(answerOf(holding(1031, 1032)));
    await w.done;
    expect(shownOrders(p)).toEqual([1031, 1032]);
    await flush();
    // The write has settled, but the read has not landed: no follow-up yet.
    expect(p.requests).toHaveLength(1);
    expect(p.writes.outstanding()).toEqual([]);
    p.requests[0].answer.resolve(answerOf(holding(1031)));
    await read;
    expect(shownOrders(p)).toEqual([1031]);
    await flush();
    // No write is out as the read lands; one was as it was sent, so the page reads once more.
    expect(p.requests).toHaveLength(2);
    p.requests[1].answer.resolve(answerOf(holding(1031, 1032)));
    await flush();
    expect(shownOrders(p)).toEqual([1031, 1032]);
    expect(p.requests).toHaveLength(2);
  });

  it("a read sent with no write out is read once", async () => {
    const p = page(holding(1031));
    const read = p.load();
    p.requests[0].answer.resolve(answerOf(holding(1031)));
    await read;
    await flush();
    expect(p.requests).toHaveLength(1);
  });

  it("a write sent after the read went out brings no follow-up: the gate orders it", async () => {
    const p = page(holding(1031));
    const read = p.load();
    const w = write(p);
    p.requests[0].answer.resolve(answerOf(holding(1031)));
    await read;
    await flush();
    expect(p.requests).toHaveLength(1);
    w.answer.resolve(answerOf(holding(1031, 1032)));
    await w.done;
    await flush();
    expect(p.requests).toHaveLength(1);
    expect(shownOrders(p)).toEqual([1031, 1032]); // newer ticket than the read: applied over it
  });

  it("the caller does not wait on a write: load resolves with its read while the write it overlapped never answers", async () => {
    const p = page(holding(1031));
    void p.applyMutation(() => new Promise<Answer>(() => {})); // no answer, ever (api() has no timeout)
    let settled = false;
    void p.load().then(() => { settled = true; });
    expect(p.requests).toHaveLength(1); // the GET went out at once
    p.requests[0].answer.resolve(answerOf(holding(1031)));
    await flush();
    expect(settled).toBe(true);
    expect(p.requests).toHaveLength(1);
  });

  it("a read that fails rejects to its caller, marks its recovery read unavailable and brings no follow-up", async () => {
    const p = page(holding(1031));
    const w = write(p);
    const read = p.load();
    const failure = new TypeError("Failed to fetch");
    p.requests[0].answer.reject(failure);
    await expect(read).rejects.toBe(failure);
    expect(p.reads).toHaveLength(2);
    expect(p.reads[1].unavailable).toHaveBeenCalledTimes(1);
    expect(p.reads[1].accept).not.toHaveBeenCalled();
    w.answer.resolve(answerOf(holding(1031, 1032)));
    await w.done;
    await flush();
    expect(p.requests).toHaveLength(1);
    expect(shownOrders(p)).toEqual([1031, 1032]);
  });

  it("a follow-up that fails is any failed read of the shipment: its recovery read unavailable, no message, no retry, nothing unhandled", async () => {
    const p = page(holding(1031));
    const w = write(p);
    const reported = await unhandledDuring(async () => {
      const read = p.load();
      p.requests[0].answer.resolve(answerOf(holding(1031)));
      await read;
      w.answer.resolve(answerOf(holding(1031, 1032)));
      await w.done;
      await flush();
      expect(p.requests).toHaveLength(2);
      p.requests[1].answer.reject(new ApiError("Request failed (500)", 500));
      await flush();
    });
    expect(reported).toEqual([]);
    expect(p.reads).toHaveLength(3);
    expect(p.reads[2].unavailable).toHaveBeenCalledTimes(1);
    expect(p.reads[2].accept).not.toHaveBeenCalled();
    expect(p.reads[1].unavailable).not.toHaveBeenCalled();
    // The page keeps what the first read showed: ordering (a) as it was before #573, a residual.
    expect(shownOrders(p)).toEqual([1031]);
    expect(Object.keys(p.messages)).toHaveLength(5);
    for (const [name, setter] of Object.entries(p.messages)) expect(setter, name).not.toHaveBeenCalled();
    await flush();
    expect(p.requests).toHaveLength(2);
  });

  it("the follow-up takes its own ticket as it is sent: applied over a write answered before it was sent", async () => {
    const p = page(holding(1031));
    const w = write(p);
    const read = p.load();
    p.requests[0].answer.resolve(answerOf(holding(1031)));
    await read;
    // A second write, sent and answered while the first is still out.
    const w2 = write(p);
    w2.answer.resolve(answerOf(holding(1031, 1033)));
    await w2.done;
    expect(shownOrders(p)).toEqual([1031, 1033]);
    w.answer.resolve(answerOf(holding(1031, 1032)));
    await w.done;
    await flush();
    expect(p.requests).toHaveLength(2);
    p.requests[1].answer.resolve(answerOf(holding(1031, 1032, 1033)));
    await flush();
    expect(shownOrders(p)).toEqual([1031, 1032, 1033]);
  });

  it("the follow-up is dropped under a write sent after it and answered first", async () => {
    const p = page(holding(1031));
    const w = write(p);
    const read = p.load();
    p.requests[0].answer.resolve(answerOf(holding(1031)));
    await read;
    w.answer.resolve(answerOf(holding(1031, 1032)));
    await w.done;
    await flush();
    expect(p.requests).toHaveLength(2);
    const w2 = write(p);
    w2.answer.resolve(answerOf(holding(1031, 1032, 1033)));
    await w2.done;
    expect(shownOrders(p)).toEqual([1031, 1032, 1033]);
    p.requests[1].answer.resolve(answerOf(holding(1031, 1032)));
    await flush();
    expect(shownOrders(p)).toEqual([1031, 1032, 1033]);
    expect(p.requests).toHaveLength(2); // the follow-up was sent with no write out
  });

  it("a follow-up sent while a later write is out is followed in turn, and the chain ends at the first read sent with none out", async () => {
    const p = page(holding(1031));
    const w1 = write(p);
    const read = p.load();
    p.requests[0].answer.resolve(answerOf(holding(1031)));
    await read;
    const w2 = write(p);
    w1.answer.resolve(answerOf(holding(1031, 1032)));
    await w1.done;
    await flush();
    expect(p.requests).toHaveLength(2); // sent with w2 out
    p.requests[1].answer.resolve(answerOf(holding(1031, 1032)));
    await flush();
    expect(p.requests).toHaveLength(2); // nothing more while w2 is out
    w2.answer.resolve(answerOf(holding(1031, 1032, 1033)));
    await w2.done;
    await flush();
    expect(p.requests).toHaveLength(3); // sent with nothing out
    p.requests[2].answer.resolve(answerOf(holding(1031, 1032, 1033)));
    await flush();
    expect(shownOrders(p)).toEqual([1031, 1032, 1033]);
    await flush();
    expect(p.requests).toHaveLength(3);
  });

  it("a read the gate drops is followed all the same when a write was out as it was sent", async () => {
    const p = page(holding(1031));
    const w1 = write(p);
    const read = p.load();
    // A second write, sent after the read and answered before it: its answer is applied, and the
    // read, older-ticketed, is dropped when it lands. Its snapshot still holds the first write,
    // whose own answer the gate will drop as older than the second's.
    const w2 = write(p);
    w2.answer.resolve(answerOf(holding(1031, 1033)));
    await w2.done;
    p.requests[0].answer.resolve(answerOf(holding(1031)));
    await read;
    expect(shownOrders(p)).toEqual([1031, 1033]);
    w1.answer.resolve(answerOf(holding(1031, 1032)));
    await w1.done;
    expect(shownOrders(p)).toEqual([1031, 1033]);
    await flush();
    expect(p.requests).toHaveLength(2);
    p.requests[1].answer.resolve(answerOf(holding(1031, 1032, 1033)));
    await flush();
    expect(shownOrders(p)).toEqual([1031, 1032, 1033]);
  });

  it("the follow-up begins its own recovery read as it is sent, after the write settled, and hands it the shipment it read", async () => {
    const p = page(holding(1031));
    const answer = deferred<Answer>();
    const done = p.applyMutation(() => { p.events.push("write"); return answer.promise; });
    const read = p.load();
    const first = answerOf(holding(1031));
    p.requests[0].answer.resolve(first);
    await read;
    await flush();
    expect(p.events).toEqual(["begin", "write", "begin", "GET"]);
    p.events.push("write settled");
    answer.resolve(answerOf(holding(1031, 1032)));
    await done;
    await flush();
    expect(p.events).toEqual(["begin", "write", "begin", "GET", "write settled", "begin", "GET"]);
    const second = answerOf(holding(1031, 1032));
    p.requests[1].answer.resolve(second);
    await flush();
    expect(p.reads).toHaveLength(3);
    expect(p.reads[0].accept).not.toHaveBeenCalled(); // the write's answer, dropped at the gate
    expect(p.reads[1].accept).toHaveBeenCalledWith(first.shipper);
    expect(p.reads[2].accept).toHaveBeenCalledWith(second.shipper);
  });
});

// `patchHeader`'s shape, modelled: the header PATCH goes through `applyMutation` (so the registry
// holds it), its request-settled signal is set in the page's per-key `inFlight` map at dispatch,
// and on a refusal the other keys are drained through the real `drainOtherKeys` before the
// rollback `load()`. The header's own request has settled by the time its catch runs, and a
// drained sibling's request has settled by the time the drain releases; the registry entry of each
// goes with its request, before either signal, so the rollback GET's snapshot holds neither and
// the drain keeps only its timing effect (never a spare follow-up).
// The "alone" case is green on the page before #573 (nothing followed a read then) and pins the
// order of the delete reaction against the leaf; the sibling case reds there at its `outstanding()`
// length.
describe("saved shipment: the header drain and the registry do not interact (#573)", () => {
  const noop = () => {};

  it("a refused header save alone: its rollback read is one GET, not followed (an ordering pin: the header's own entry has left the registry before its catch reads; green before #573, when no read was followed)", async () => {
    const p = page(holding(1031));
    const inFlight = new Map<string, Promise<unknown>>();
    const header = write(p);
    inFlight.set("carrierName", header.done.then(noop, noop));
    header.answer.reject(new ApiError("Carrier not found", 400));
    await expect(header.done).rejects.toBeInstanceOf(ApiError);
    await drainOtherKeys(inFlight, "carrierName");
    expect(p.writes.outstanding()).toEqual([]);
    const rollback = p.load();
    expect(p.requests).toHaveLength(1);
    p.requests[0].answer.resolve(answerOf(holding(1031)));
    await rollback;
    await flush();
    expect(p.requests).toHaveLength(1);
  });

  it("a refused header save beside a sibling key's save: the sibling is drained, and the rollback read is not followed for it (the pin, for the shape as modelled: patchHeader's drain is modelled here, not lifted)", async () => {
    const p = page(holding(1031));
    const inFlight = new Map<string, Promise<unknown>>();
    const sibling = write(p);
    inFlight.set("comments", sibling.done.then(noop, noop));
    const header = write(p);
    inFlight.set("carrierName", header.done.then(noop, noop));
    header.answer.reject(new ApiError("Carrier not found", 400));
    await expect(header.done).rejects.toBeInstanceOf(ApiError);
    expect(p.writes.outstanding()).toHaveLength(1); // the sibling, still out
    let drained = false;
    const drain = drainOtherKeys(inFlight, "carrierName").then(() => { drained = true; });
    await flush();
    expect(drained).toBe(false);
    sibling.answer.resolve(answerOf({ ...holding(1031), comments: "sibling" }));
    await drain;
    // Released after the sibling's request settled, by which time its registry entry is gone.
    expect(p.writes.outstanding()).toEqual([]);
    const rollback = p.load();
    expect(p.requests).toHaveLength(1);
    p.requests[0].answer.resolve(answerOf({ ...holding(1031), comments: "sibling" }));
    await rollback;
    await flush();
    expect(p.requests).toHaveLength(1);
    expect(p.state()?.comments).toBe("sibling");
  });
});
