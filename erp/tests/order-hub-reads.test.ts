import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { makeWriteSignals, reReadAfter } from "@/lib/drain-queue";
import { ApiError, UnreadableAnswerError, WRITE_ANSWER_UNREADABLE } from "@/lib/fetcher";
import { keepTravelerPrinted } from "@/lib/traveler-printed";
import { makeEditGuard } from "@/lib/use-edit-guard";
import { makeMutationGate } from "@/lib/use-latest";
import { source } from "./helpers/lift-callback";
import { all, run } from "./helpers/source-lift";

// #550: the order hub's two applies of a whole order from the server, `load`'s after a read of the
// order and `applyMutation`'s after a write's answer. Owner ruling 2 of 2026-10-18: `load` keeps
// `travelerPrinted` monotonic, as `applyMutation` already did, and both do it through one leaf
// (`keepTravelerPrinted`, src/lib/traveler-printed.ts). A read served before a traveler print
// committed, landing after the print's `onPrinted`, used to clear the traveler-printed banner until
// the next payload. The focused-field preserve (use-edit-guard.ts) composes over it in both.
//
// Owner ruling 1, "read now, re-read after": `applyMutation` registers each dispatch in the page's
// one registry of hub writes in flight (`makeWriteSignals`, drain-queue.ts), in the same synchronous
// run as its ticket, and the entry goes when the request settles, however it ends. `load` sends its
// GET at once and snapshots the registry as it does; when the snapshot held a write, the page reads
// once more after every write in it has settled, whether or not one was still out when the read
// landed, and detached, so nothing `load`'s caller does waits on a write (the plan's amendments 1-4:
// a follow-up obeys the same rule, a failed one is any failed read with no message, and none is
// retried).
//
// vitest has no DOM, so nothing here renders. Both functions are lifted out of page.tsx's syntax
// tree and run closed over one environment and nothing else: the real mutation gate, the real edit
// guard, the real registry, the real follow-up decision and the real leaf, with each request, each
// recovery read and the order state recorded. A lifted function that gains a free identifier on a
// path these cases take must gain it here in the same change, or it is a ReferenceError in this
// file. The environment hands both functions one registry, so whether the page builds its registry
// once per mount is pinned on the source instead (the source pin at the end of the registration
// describe).

type Order = {
  id: string; orderNumber: number; poNumber: string | null; notes: string | null;
  travelerPrinted: boolean; lines: Array<{ id: string; qty: number }>; loads: unknown[];
};
type Read = Order & { finalizedInvoiceId: string | null };
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** One macrotask: every promise reaction queued so far has run. */
const flush = () => new Promise<void>((done) => { setTimeout(done, 0); });

const STORED: Order = {
  id: "order-1", orderNumber: 1031, poNumber: "PO-1", notes: null, travelerPrinted: false, lines: [], loads: [],
};

/** The `useCallback(…)` call page.tsx declares under `name`. */
function declaredCallback(file: ts.SourceFile, name: string): ts.CallExpression {
  const found = all(file, ts.isVariableDeclaration).filter((d) => ts.isIdentifier(d.name) && d.name.text === name);
  expect(found, name).toHaveLength(1);
  const wrapped = found[0].initializer;
  if (!wrapped || !ts.isCallExpression(wrapped) || wrapped.expression.getText(file) !== "useCallback") {
    throw new Error(`${name} is no longer a useCallback in page.tsx`);
  }
  return wrapped;
}

/** The `useCallback` argument page.tsx declares under `name`, closed over `environment`. */
function lifted<T>(name: string, environment: Record<string, unknown>): T {
  const file = source("app/orders/[id]/page.tsx");
  return run<T>(declaredCallback(file, name).arguments[0].getText(file), environment);
}

/** One mounted hub: `load` and `applyMutation` over one environment, the page holding `initial`.
 *  Each GET `load` sends waits in `requests` until the case answers it. */
function hub(initial: Order) {
  let state: Order | null = initial;
  const editGuard = makeEditGuard();
  const requests: Array<{ url: string; answer: Deferred<Read> }> = [];
  const reads: Array<{ unavailable: ReturnType<typeof vi.fn>; accept: ReturnType<typeof vi.fn> }> = [];
  // Each recovery read begun and each GET sent, in the order they happen; a case adds its own.
  const events: string[] = [];
  const setFinalizedInvoiceId = vi.fn();
  const writes = makeWriteSignals();
  const invalidateHistory = vi.fn();
  const invalidateOrderShipments = vi.fn();
  // Every setter of the page's four messages: its three banners (`error`, `orderReadError` and the
  // supplementary fetches' `loadError`, which `addLoadError` appends to) and the scan status.
  // Neither function sets one; a case asserts it stays so.
  const messages = {
    setError: vi.fn(), setOrderReadError: vi.fn(), setLoadError: vi.fn(), addLoadError: vi.fn(), setScanRead: vi.fn(),
  };
  const environment: Record<string, unknown> = {
    id: "order-1",
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
      const answer = deferred<Read>();
      requests.push({ url, answer });
      events.push("GET");
      return answer.promise;
    },
    editGuard,
    keepTravelerPrinted,
    setOrder: (update: Order | null | ((cur: Order | null) => Order | null)) => {
      state = typeof update === "function" ? update(state) : update;
    },
    setFinalizedInvoiceId,
    ApiError,
    UnreadableAnswerError,
    invalidateHistory,
    invalidateOrderShipments,
    ...messages,
  };
  return {
    load: lifted<() => Promise<Read>>("load", environment),
    applyMutation: lifted<(work: () => Promise<Order>) => Promise<void>>("applyMutation", environment),
    editGuard, requests, reads, events, messages, setFinalizedInvoiceId, writes, invalidateHistory, invalidateOrderShipments,
    state: () => state,
    /** A key typed into a header box: the page's own setter, not a server payload. */
    type: (patch: Partial<Order>) => { state = state && { ...state, ...patch }; },
  };
}

/** The user enters the PO number box, which shows `shown`. */
const focusPoNumber = (h: ReturnType<typeof hub>, shown: string) =>
  h.editGuard.onFocusField("poNumber")({ target: { value: shown } } as never);

describe("order hub: load keeps travelerPrinted (#550 ruling 2)", () => {
  it("a read that says no traveler is printed leaves the page's true, and every other field is the read's", async () => {
    const h = hub({ ...STORED, travelerPrinted: true }); // as onPrinted leaves it
    const done = h.load();
    expect(h.requests.map((r) => r.url)).toEqual(["/api/orders/order-1"]);
    // Served before the print committed: the server's order still had no stored traveler.
    const read: Read = { ...STORED, poNumber: "PO-SERVER", notes: "from the server", travelerPrinted: false, finalizedInvoiceId: null };
    h.requests[0].answer.resolve(read);
    await expect(done).resolves.toBe(read);
    expect(h.state()).toEqual({ ...read, travelerPrinted: true });
    expect(h.setFinalizedInvoiceId).toHaveBeenCalledWith(null);
    // The preserve is the page's alone: the bulk grids' recovery read is handed the read itself.
    expect(h.reads).toHaveLength(1);
    expect(h.reads[0].accept).toHaveBeenCalledWith(read);
  });

  it("load: a focused PO number the user has typed into keeps its text in the same apply", async () => {
    const h = hub(STORED);
    focusPoNumber(h, "PO-1");
    h.type({ poNumber: "PO-1 typed" });
    const done = h.load();
    const read: Read = { ...STORED, poNumber: "PO-SERVER", notes: "from the server", finalizedInvoiceId: "inv-1" };
    h.requests[0].answer.resolve(read);
    await done;
    expect(h.state()).toEqual({ ...read, poNumber: "PO-1 typed" });
  });
});

describe("order hub: applyMutation keeps travelerPrinted through the same leaf", () => {
  it("an answer that says no traveler is printed leaves the page's true, and every other field is the answer's", async () => {
    const h = hub({ ...STORED, travelerPrinted: true });
    // Computed before the print committed, answered after it.
    const answer: Order = { ...STORED, poNumber: "PO-SERVER", notes: "from the server", travelerPrinted: false };
    await h.applyMutation(async () => answer);
    expect(h.state()).toEqual({ ...answer, travelerPrinted: true });
    expect(h.reads).toHaveLength(1);
    expect(h.reads[0].accept).toHaveBeenCalledWith(answer);
  });

  it("applyMutation: a focused PO number the user has typed into keeps its text in the same apply", async () => {
    const h = hub(STORED);
    focusPoNumber(h, "PO-1");
    h.type({ poNumber: "PO-1 typed" });
    const answer: Order = { ...STORED, poNumber: "PO-SERVER", notes: "from the server" };
    await h.applyMutation(async () => answer);
    expect(h.state()).toEqual({ ...answer, poNumber: "PO-1 typed" });
  });
});

describe("order hub: applyMutation registers each dispatch (#550 ruling 1)", () => {
  it("a write is in the registry from the instant it is sent, and stays while its request is out", async () => {
    const h = hub(STORED);
    const answer = deferred<Order>();
    // Every call of the thunk is a request sent: it runs once, and the request registered is the
    // one awaited.
    const thunk = vi.fn(() => answer.promise);
    const done = h.applyMutation(thunk);
    // No await yet: registered in the same synchronous run as the ticket.
    expect(h.writes.outstanding()).toHaveLength(1);
    const [signal] = h.writes.outstanding();
    await flush();
    // Still out, and still the one entry: the signal is the request's, not one that settles alone.
    expect(h.writes.outstanding()).toHaveLength(1);
    expect(h.writes.outstanding()[0]).toBe(signal);
    answer.resolve({ ...STORED, poNumber: "PO-2" });
    await done;
    expect(thunk).toHaveBeenCalledTimes(1);
  });

  it("a write whose answer lands leaves the registry", async () => {
    const h = hub(STORED);
    const answer = deferred<Order>();
    const done = h.applyMutation(() => answer.promise);
    expect(h.writes.outstanding()).toHaveLength(1);
    answer.resolve({ ...STORED, poNumber: "PO-2" });
    await done;
    await flush();
    expect(h.writes.outstanding()).toEqual([]);
    expect(h.state()?.poNumber).toBe("PO-2");
  });

  it("a write that fails leaves the registry however it fails, and the rejection still reaches the caller", async () => {
    const failures = [
      new ApiError("Cannot reduce qty below 20 already shipped", 409),
      new ApiError("Request failed (500)", 500),
      new ApiError("Not signed in", 401),
      new TypeError("Failed to fetch"),
      new UnreadableAnswerError(WRITE_ANSWER_UNREADABLE, { cause: new SyntaxError("Unexpected end of JSON input") }),
    ];
    for (const failure of failures) {
      const h = hub(STORED);
      const answer = deferred<Order>();
      const thunk = vi.fn(() => answer.promise);
      const done = h.applyMutation(thunk);
      expect(h.writes.outstanding(), failure.message).toHaveLength(1);
      answer.reject(failure);
      await expect(done, failure.message).rejects.toBe(failure);
      expect(thunk, failure.message).toHaveBeenCalledTimes(1);
      await flush();
      expect(h.writes.outstanding(), failure.message).toEqual([]);
      // #547: an unreadable 2xx committed its write, so History and Shipments are told; nothing else is.
      const told = failure instanceof UnreadableAnswerError ? 1 : 0;
      expect(h.invalidateHistory, failure.message).toHaveBeenCalledTimes(told);
      expect(h.invalidateOrderShipments, failure.message).toHaveBeenCalledTimes(told);
      expect(h.state(), failure.message).toBe(STORED);
    }
  });

  it("a thunk that throws before it returns sent nothing, registers nothing, and its error reaches the caller", async () => {
    const h = hub(STORED);
    const thrown = new Error("Container 1: Containers must be a whole number");
    const done = h.applyMutation(() => { throw thrown; });
    expect(h.writes.outstanding()).toEqual([]);
    await expect(done).rejects.toBe(thrown);
    await flush();
    expect(h.writes.outstanding()).toEqual([]);
  });

  it("the page holds one registry per mount, and applyMutation and load both read that one", () => {
    const file = source("app/orders/[id]/page.tsx");
    const hubs = file.statements.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "OrderHub");
    expect(hubs).toHaveLength(1);
    const body = hubs[0].body!;
    // Every binding of the name in OrderHub, at any depth: exactly one, `const [writes] =
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
  });
});

/** The order as the server holds it with the lead line's quantity at `qty`. */
const holding = (qty: number): Order => ({ ...STORED, lines: [{ id: "L1", qty }] });
/** A read of that order: the same, with the field only a read carries. */
const readOf = (qty: number): Read => ({ ...holding(qty), finalizedInvoiceId: null });
/** The lead line's quantity the page shows. */
const shownQty = (h: ReturnType<typeof hub>) => h.state()?.lines[0]?.qty;

/** A hub write sent through `applyMutation`, its answer held until the case gives it. */
function write(h: ReturnType<typeof hub>) {
  const answer = deferred<Order>();
  const done = h.applyMutation(() => answer.promise);
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

describe("order hub: load reads now and once more after the writes it overlapped (#550 ruling 1)", () => {
  it("ordering (a): the read lands before the write's answer, which the gate drops, and the read after the write shows it", async () => {
    const h = hub(holding(20));
    const w = write(h);
    const read = h.load();
    expect(h.requests.map((r) => r.url)).toEqual(["/api/orders/order-1"]);
    // Served before the write committed, it lands first and is applied.
    const first = readOf(20);
    h.requests[0].answer.resolve(first);
    await expect(read).resolves.toBe(first);
    expect(shownQty(h)).toBe(20);
    await flush();
    expect(h.requests).toHaveLength(1); // nothing more while the write is out
    // The write's answer holds the older ticket and is dropped.
    w.answer.resolve(holding(24));
    await w.done;
    expect(shownQty(h)).toBe(20);
    await flush();
    expect(h.requests.map((r) => r.url)).toEqual(["/api/orders/order-1", "/api/orders/order-1"]);
    h.requests[1].answer.resolve(readOf(24));
    await flush();
    expect(shownQty(h)).toBe(24);
    expect(h.requests).toHaveLength(2);
  });

  it("ordering (b): the write's answer lands first and the stale read reverts it, and the read after it shows the write again (amendment 1)", async () => {
    const h = hub(holding(20));
    const w = write(h);
    const read = h.load();
    w.answer.resolve(holding(24));
    await w.done;
    expect(shownQty(h)).toBe(24);
    await flush();
    // The write has settled, but the read has not landed: no follow-up yet.
    expect(h.requests).toHaveLength(1);
    expect(h.writes.outstanding()).toEqual([]);
    h.requests[0].answer.resolve(readOf(20));
    await read;
    expect(shownQty(h)).toBe(20);
    await flush();
    // No write is out as the read lands; one was as it was sent, so the page reads once more.
    expect(h.requests).toHaveLength(2);
    h.requests[1].answer.resolve(readOf(24));
    await flush();
    expect(shownQty(h)).toBe(24);
    expect(h.requests).toHaveLength(2);
  });

  it("a read sent with no hub write out is read once", async () => {
    const h = hub(holding(20));
    const read = h.load();
    h.requests[0].answer.resolve(readOf(20));
    await read;
    await flush();
    expect(h.requests).toHaveLength(1);
  });

  it("a write sent after the read went out brings no follow-up: the gate orders it", async () => {
    const h = hub(holding(20));
    const read = h.load();
    const w = write(h);
    h.requests[0].answer.resolve(readOf(20));
    await read;
    await flush();
    expect(h.requests).toHaveLength(1);
    w.answer.resolve(holding(24));
    await w.done;
    await flush();
    expect(h.requests).toHaveLength(1);
    expect(shownQty(h)).toBe(24); // newer ticket than the read: applied over it
  });

  it("the caller does not wait on a write: load resolves with its read while the write it overlapped never answers", async () => {
    const h = hub(holding(20));
    void h.applyMutation(() => new Promise<Order>(() => {})); // no answer, ever (api() has no timeout)
    let settled = false;
    void h.load().then(() => { settled = true; });
    expect(h.requests).toHaveLength(1); // the GET went out at once
    h.requests[0].answer.resolve(readOf(20));
    await flush();
    expect(settled).toBe(true);
    expect(h.requests).toHaveLength(1);
  });

  it("a read that fails rejects to its caller, marks its recovery read unavailable and brings no follow-up", async () => {
    const h = hub(holding(20));
    const w = write(h);
    const read = h.load();
    const failure = new TypeError("Failed to fetch");
    h.requests[0].answer.reject(failure);
    await expect(read).rejects.toBe(failure);
    expect(h.reads[1].unavailable).toHaveBeenCalledTimes(1);
    w.answer.resolve(holding(24));
    await w.done;
    await flush();
    expect(h.requests).toHaveLength(1);
    expect(shownQty(h)).toBe(24);
  });

  it("a follow-up that fails is any failed read of the order: its recovery read unavailable, no message, no retry, nothing unhandled (amendments 3 and 4)", async () => {
    const h = hub(holding(20));
    const w = write(h);
    const reported = await unhandledDuring(async () => {
      const read = h.load();
      h.requests[0].answer.resolve(readOf(20));
      await read;
      w.answer.resolve(holding(24));
      await w.done;
      await flush();
      expect(h.requests).toHaveLength(2);
      h.requests[1].answer.reject(new ApiError("Request failed (500)", 500));
      await flush();
    });
    expect(reported).toEqual([]);
    expect(h.reads).toHaveLength(3);
    expect(h.reads[2].unavailable).toHaveBeenCalledTimes(1);
    expect(h.reads[2].accept).not.toHaveBeenCalled();
    expect(h.reads[1].unavailable).not.toHaveBeenCalled();
    // The page keeps what the first read showed: ordering (a) as it was before #550, a residual.
    expect(shownQty(h)).toBe(20);
    expect(Object.keys(h.messages)).toHaveLength(5);
    for (const [name, setter] of Object.entries(h.messages)) expect(setter, name).not.toHaveBeenCalled();
    await flush();
    expect(h.requests).toHaveLength(2);
  });

  it("the follow-up takes its own ticket as it is sent: applied over a write answered before it was sent", async () => {
    const h = hub(holding(20));
    const w = write(h);
    const read = h.load();
    h.requests[0].answer.resolve(readOf(20));
    await read;
    // A second write, sent and answered while the first is still out.
    const w2 = write(h);
    w2.answer.resolve(holding(25));
    await w2.done;
    expect(shownQty(h)).toBe(25);
    w.answer.resolve(holding(24));
    await w.done;
    await flush();
    expect(h.requests).toHaveLength(2);
    h.requests[1].answer.resolve(readOf(26));
    await flush();
    expect(shownQty(h)).toBe(26);
  });

  it("the follow-up is dropped under a write sent after it and answered first", async () => {
    const h = hub(holding(20));
    const w = write(h);
    const read = h.load();
    h.requests[0].answer.resolve(readOf(20));
    await read;
    w.answer.resolve(holding(24));
    await w.done;
    await flush();
    expect(h.requests).toHaveLength(2);
    const w2 = write(h);
    w2.answer.resolve(holding(25));
    await w2.done;
    expect(shownQty(h)).toBe(25);
    h.requests[1].answer.resolve(readOf(24));
    await flush();
    expect(shownQty(h)).toBe(25);
    expect(h.requests).toHaveLength(2); // the follow-up was sent with no write out
  });

  it("a follow-up sent while a later write is out is followed in turn, and the chain ends at the first read sent with none out (amendment 2)", async () => {
    const h = hub(holding(20));
    const w1 = write(h);
    const read = h.load();
    h.requests[0].answer.resolve(readOf(20));
    await read;
    const w2 = write(h);
    w1.answer.resolve(holding(24));
    await w1.done;
    await flush();
    expect(h.requests).toHaveLength(2); // sent with w2 out
    h.requests[1].answer.resolve(readOf(24));
    await flush();
    expect(h.requests).toHaveLength(2); // nothing more while w2 is out
    w2.answer.resolve(holding(25));
    await w2.done;
    await flush();
    expect(h.requests).toHaveLength(3); // sent with nothing out
    h.requests[2].answer.resolve(readOf(25));
    await flush();
    expect(shownQty(h)).toBe(25);
    await flush();
    expect(h.requests).toHaveLength(3);
  });

  it("a read the gate drops is followed all the same when a write was out as it was sent", async () => {
    const h = hub(holding(20));
    const w1 = write(h);
    const read = h.load();
    // A second write, sent after the read and answered before it: its answer is applied, and the
    // read, older-ticketed, is dropped when it lands. Its snapshot still holds the first write,
    // whose own answer the gate will drop as older than the second's.
    const w2 = write(h);
    w2.answer.resolve(holding(25));
    await w2.done;
    h.requests[0].answer.resolve(readOf(20));
    await read;
    expect(shownQty(h)).toBe(25);
    w1.answer.resolve(holding(24));
    await w1.done;
    expect(shownQty(h)).toBe(25);
    await flush();
    expect(h.requests).toHaveLength(2);
    h.requests[1].answer.resolve(readOf(26));
    await flush();
    expect(shownQty(h)).toBe(26);
  });

  it("the follow-up begins its own recovery read as it is sent, after the write settled, and hands it the order it read", async () => {
    const h = hub(holding(20));
    const answer = deferred<Order>();
    const done = h.applyMutation(() => { h.events.push("write"); return answer.promise; });
    const read = h.load();
    const first = readOf(20);
    h.requests[0].answer.resolve(first);
    await read;
    await flush();
    expect(h.events).toEqual(["begin", "write", "begin", "GET"]);
    h.events.push("write settled");
    answer.resolve(holding(24));
    await done;
    await flush();
    expect(h.events).toEqual(["begin", "write", "begin", "GET", "write settled", "begin", "GET"]);
    const second = readOf(24);
    h.requests[1].answer.resolve(second);
    await flush();
    expect(h.reads).toHaveLength(3);
    expect(h.reads[0].accept).not.toHaveBeenCalled(); // the write's answer, dropped at the gate
    expect(h.reads[1].accept).toHaveBeenCalledWith(first);
    expect(h.reads[2].accept).toHaveBeenCalledWith(second);
  });
});
