import { describe, it, expect, vi } from "vitest";
import { drainOtherKeys, makeWriteSignals, reReadAfter } from "@/lib/drain-queue";
import { ApiError, UnreadableAnswerError, WRITE_ANSWER_UNREADABLE } from "@/lib/fetcher";

// Group D Task 7: the §5.13 rollback-drain for the mutation-gate detail pages. A failed save's
// rollback `load()` takes the NEWEST mutation ticket, so its GET served before a SIBLING key's
// in-flight PATCH commits would revert that sibling's committed write on screen (the sibling's
// own response then drops as older-ticketed). The drain waits out every OTHER key's in-flight
// REQUEST before the GET dispatches. Fix round 1 (review CRITICAL): the map handed to the drain
// is the pages' request-settled SIGNAL map — registered at dispatch, settling with the request —
// NEVER the serial() chain-tail map: a tail settles only after its own catch (drain included)
// completes, so two failing keys draining each other's tails deadlock mutually (the
// mutual-failure case below). Pure module driven by hand-resolved deferreds — the
// save-scope.test.ts recipe (vitest runs `environment: "node"`).

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// One macrotask drains every microtask chain reachable from the deferreds resolved so far.
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Collects the unhandled rejections Node reports while `body` runs (the e2e-new-tab.test.ts shape).
 *  Node reports one once the microtasks of the task that caused it have drained, so two macrotasks
 *  are waited out before the listener comes off. */
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

describe("drainOtherKeys", () => {
  it("resolves immediately on an empty queue", async () => {
    await drainOtherKeys(new Map(), "a");
  });

  it("skips the own key — its entry is never awaited (no deadlock)", async () => {
    // Never resolved: under the signals contract the own entry is settled by the time the catch
    // drains (the own request just failed — that is why the catch is running), but the helper
    // must not DEPEND on that: an own entry that never settles still must not wedge the drain.
    const own = deferred();
    const signals = new Map<string, Promise<unknown>>([["a", own.promise]]);
    await drainOtherKeys(signals, "a");
  });

  it("waits out another key's in-flight request", async () => {
    const b = deferred();
    const signals = new Map<string, Promise<unknown>>([["b", b.promise]]);
    let done = false;
    const drain = drainOtherKeys(signals, "a").then(() => { done = true; });
    await flush();
    expect(done).toBe(false); // sibling still in flight — the GET must not dispatch yet
    b.resolve();
    await drain;
    expect(done).toBe(true);
  });

  it("waits out siblings while still skipping the pending own key", async () => {
    const own = deferred(); // stays pending forever
    const b = deferred();
    const signals = new Map<string, Promise<unknown>>([["a", own.promise], ["b", b.promise]]);
    let done = false;
    const drain = drainOtherKeys(signals, "a").then(() => { done = true; });
    await flush();
    expect(done).toBe(false);
    b.resolve(); // only the sibling needs to settle
    await drain;
    expect(done).toBe(true);
  });

  it("a rejecting sibling request releases the drain (allSettled, never all)", async () => {
    const b = deferred();
    const signals = new Map<string, Promise<unknown>>([["b", b.promise]]);
    const drain = drainOtherKeys(signals, "a");
    b.reject(new Error("sibling PATCH failed"));
    await drain; // must resolve, not reject — the drain orders the GET, it doesn't judge siblings
  });

  // Fix round 1 (review CRITICAL): the existing "skips own key" case models only ONE side of the
  // cycle. Two saves on DIFFERENT keys both failing while overlapping is ordinary use (one
  // network blip rejects both in-flight PATCHes), and a drain fed the serial() chain-TAIL map
  // deadlocks mutually: a key's tail settles only after its own catch (drain included) completes,
  // so A's catch awaits B's tail awaits A's tail — no rollback, no error banner, both queues
  // permanently wedged. The pages therefore hand the drain a second map of REQUEST-settled
  // signals, registered at dispatch: a signal settles with the request itself — which IS the
  // commit/failure the rollback GET must postdate — and never depends on a drain.
  it("mutual failure across two keys — both drains resolve, both rollbacks dispatch, both errors report", async () => {
    // Harness cloning the pages' wiring: the verbatim serial() queue for ordering, plus the
    // dispatch-time signal registration the fix adds. The catch drains the SIGNALS, never the
    // queue tails.
    const chain = new Map<string, Promise<unknown>>();
    const signals = new Map<string, Promise<unknown>>();
    function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const prev = chain.get(key) ?? Promise.resolve();
      const next = prev.then(fn, fn);
      chain.set(key, next.catch(() => {}));
      return next;
    }
    const state = { rollbacks: [] as string[], errors: [] as string[] };
    function failingSave(key: string, req: Promise<void>) {
      return serial(key, async () => {
        try {
          signals.set(key, req.then(() => {}, () => {})); // registered at dispatch
          await req;
        } catch (e) {
          await drainOtherKeys(signals, key);
          state.rollbacks.push(key); // stands in for the §5.13 rollback load()
          state.errors.push((e as Error).message);
        }
      });
    }
    const a = deferred();
    const b = deferred();
    const saveA = failingSave("poNumber", a.promise);
    const saveB = failingSave("notes", b.promise);
    a.reject(new Error("network A"));
    b.reject(new Error("network B"));
    await flush();
    await flush();
    // A deadlock shows here as empty arrays, not as a test timeout.
    expect(state.rollbacks.sort()).toEqual(["notes", "poNumber"]);
    expect(state.errors.sort()).toEqual(["network A", "network B"]);
    // And both chain tails must have settled — later saves on these keys chain behind them.
    await Promise.allSettled([saveA, saveB]);
  });

  it("re-drains a signal replaced during the wait — the park is itself a save window", async () => {
    const b1 = deferred();
    const signals = new Map<string, Promise<unknown>>([["b", b1.promise]]);
    let done = false;
    const drain = drainOtherKeys(signals, "a").then(() => { done = true; });
    await flush();
    // A new save on "b" dispatches while the drain sits on allSettled, registering a fresh
    // request signal under its key…
    const b2 = deferred();
    signals.set("b", b2.promise);
    b1.resolve();
    await flush();
    // …so the drain must not release on the OLD signal alone: b2's PATCH could still commit
    // after the rollback GET is served, which is the exact reversion the drain exists to prevent.
    expect(done).toBe(false);
    b2.resolve();
    await drain;
    expect(done).toBe(true);
  });
});

// #550 (owner ruling 2026-10-18, "read now, re-read after", with the owner's answers A to the build
// plan's questions 1 and 2): the order hub's write registry and the follow-up decision. A hub read
// goes out at once; when a hub write was out as it was sent, the page reads once more after those
// writes settle, whether or not they are still out when the read lands (answer A to question 1),
// and the follow-up obeys the same rule (answer A to question 2). Here `again` stands in for the
// page's follow-up read; the page's own wiring is order-hub-reads.test.ts's.
describe("makeWriteSignals and reReadAfter (#550)", () => {
  it("registers a dispatched request at once, synchronously", () => {
    const writes = makeWriteSignals();
    const w = deferred<unknown>();
    writes.dispatched(w.promise);
    expect(writes.outstanding()).toHaveLength(1);
  });

  it("deletes a write's signal when its request resolves", async () => {
    const writes = makeWriteSignals();
    const w = deferred<unknown>();
    writes.dispatched(w.promise);
    w.resolve({ id: "order-1" });
    await flush();
    expect(writes.outstanding()).toHaveLength(0);
  });

  it("deletes a write's signal when its request rejects, however it fails, and leaves no unhandled rejection", async () => {
    const failures = [
      new ApiError("Order line not found", 404),
      new TypeError("Failed to fetch"),
      new UnreadableAnswerError(WRITE_ANSWER_UNREADABLE, { cause: new SyntaxError("Unexpected end of JSON input") }),
    ];
    for (const failure of failures) {
      const writes = makeWriteSignals();
      const w = deferred<unknown>();
      const reported = await unhandledDuring(async () => {
        writes.dispatched(w.promise);
        // Rejected only after `dispatched` has its handler on the request: the test's own promise
        // must not be the unhandled one.
        w.reject(failure);
        await flush();
      });
      expect(reported, failure.constructor.name).toEqual([]);
      expect(writes.outstanding(), failure.constructor.name).toHaveLength(0);
    }
  });

  it("outstanding() is a copy: a write dispatched after a snapshot is not in it, and emptying it changes nothing", () => {
    const writes = makeWriteSignals();
    const w1 = deferred<unknown>();
    const w2 = deferred<unknown>();
    writes.dispatched(w1.promise);
    const snapshot = writes.outstanding();
    writes.dispatched(w2.promise);
    expect(snapshot).toHaveLength(1);
    expect(writes.outstanding()).toHaveLength(2);
    (snapshot as Promise<void>[]).splice(0);
    expect(writes.outstanding()).toHaveLength(2);
  });

  it("an empty snapshot: no write was out as the read was sent, so there is no follow-up", async () => {
    const again = vi.fn();
    reReadAfter([], again);
    await flush();
    await flush();
    expect(again).not.toHaveBeenCalled();
  });

  it("one write out: the follow-up waits for it, then runs once", async () => {
    const writes = makeWriteSignals();
    const w = deferred<unknown>();
    writes.dispatched(w.promise);
    const again = vi.fn();
    reReadAfter(writes.outstanding(), again);
    expect(again).not.toHaveBeenCalled();
    await flush();
    expect(again).not.toHaveBeenCalled(); // the write is still out
    w.resolve({ id: "order-1" });
    await flush();
    expect(again).toHaveBeenCalledTimes(1);
    await flush();
    await flush();
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("two writes out, one answered and one refused: one follow-up, after the second settles", async () => {
    const writes = makeWriteSignals();
    const w1 = deferred<unknown>();
    const w2 = deferred<unknown>();
    writes.dispatched(w1.promise);
    writes.dispatched(w2.promise);
    const again = vi.fn();
    reReadAfter(writes.outstanding(), again);
    w1.resolve({ id: "order-1" });
    await flush();
    expect(again).not.toHaveBeenCalled();
    w2.reject(new ApiError("Quantity must be a whole number.", 400));
    await flush();
    expect(again).toHaveBeenCalledTimes(1);
    await flush();
    expect(again).toHaveBeenCalledTimes(1);
  });

  // The registry's signals never reject (both arms), so on their own they cannot tell `allSettled`
  // from `all`. The wait must not rest on that: handed a rejecting promise, it still follows.
  it("a rejecting promise in the snapshot still brings one follow-up (allSettled, never all)", async () => {
    const w = deferred();
    const again = vi.fn();
    const reported = await unhandledDuring(async () => {
      reReadAfter([w.promise], again);
      w.reject(new TypeError("Failed to fetch"));
      await flush();
    });
    expect(reported).toEqual([]);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("ordering (b): a write out as the read was sent, settled before it landed, still brings a follow-up (answer A to question 1)", async () => {
    const writes = makeWriteSignals();
    const w = deferred<unknown>();
    writes.dispatched(w.promise);
    const atSend = writes.outstanding(); // the read is sent with the write out
    w.resolve({ id: "order-1" }); // the write's answer lands first…
    await flush();
    expect(writes.outstanding()).toHaveLength(0); // …so nothing is out when the read lands
    const again = vi.fn();
    reReadAfter(atSend, again);
    await flush();
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("a write dispatched after the snapshot does not delay the follow-up, and the follow-up's own snapshot holds it (the chain)", async () => {
    const writes = makeWriteSignals();
    const w1 = deferred<unknown>();
    const w2 = deferred<unknown>();
    writes.dispatched(w1.promise);
    const atSend = writes.outstanding();
    writes.dispatched(w2.promise); // sent after the read went out, and never answered here
    const [w2Signal] = writes.outstanding().filter((s) => !atSend.includes(s));
    let followUpSees: readonly Promise<void>[] | null = null;
    const again = vi.fn(() => { followUpSees = writes.outstanding(); });
    reReadAfter(atSend, again);
    w1.resolve({ id: "order-1" });
    await flush();
    expect(again).toHaveBeenCalledTimes(1);
    // The follow-up, sent now, snapshots the later write still out: under answer A to question 2
    // the page follows it in turn.
    expect(followUpSees).toHaveLength(1);
    expect(followUpSees![0]).toBe(w2Signal);
  });

  it("a stalled write withholds the follow-up, and the registry keeps working beside it", async () => {
    const writes = makeWriteSignals();
    const stalled = deferred<unknown>(); // no answer, ever: api() has no timeout (#276)
    writes.dispatched(stalled.promise);
    const again = vi.fn();
    reReadAfter(writes.outstanding(), again);
    await flush();
    await flush();
    expect(again).not.toHaveBeenCalled();
    const w = deferred<unknown>();
    writes.dispatched(w.promise);
    expect(writes.outstanding()).toHaveLength(2);
    w.resolve({ id: "order-1" });
    await flush();
    expect(writes.outstanding()).toHaveLength(1); // the stalled write alone
    expect(again).not.toHaveBeenCalled();
  });

  // Load-bearing. The delete reaction is attached to the signal at dispatch and `allSettled`'s when
  // the read lands, so a settled write's entry is gone before the follow-up runs: its own snapshot
  // never holds the writes it waited for, which is what ends the chain. Tested in the ordering that
  // can fail, the write still pending when the read lands; had it settled first, its entry would
  // already be gone.
  it("the delete runs before the follow-up: the follow-up never sees the writes it waited for", async () => {
    const writes = makeWriteSignals();
    const w = deferred<unknown>();
    writes.dispatched(w.promise);
    let followUpSees: readonly Promise<void>[] | null = null;
    reReadAfter(writes.outstanding(), () => { followUpSees = writes.outstanding(); });
    w.resolve({ id: "order-1" });
    await flush();
    expect(followUpSees).not.toBeNull();
    expect(followUpSees).toHaveLength(0);
  });
});
