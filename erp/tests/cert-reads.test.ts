import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { drainOtherKeys, makeWriteSignals, reReadAfter } from "@/lib/drain-queue";
import { ApiError, UnreadableAnswerError, WRITE_ANSWER_UNREADABLE } from "@/lib/fetcher";
import { makeEditGuard } from "@/lib/use-edit-guard";
import { makeMutationGate } from "@/lib/use-latest";
import { source } from "./helpers/lift-callback";
import { all, run } from "./helpers/source-lift";

// #573 (owner ruling 2026-10-20, amendment 1: the hub's #550 rule on the certification page). The
// page's `load` sends its GET at once and takes the newest ticket, so a read served before a write
// still out had committed holds the newer ticket: it reverts that write on screen, or has the
// write's answer dropped at the gate. The page's two rollback reads (the notes PATCH's and the
// readings save's) drain every other key first, so the exposed read was the print's follow-up
// `load()`: Print is not closed by a notes blur-save, so a notes PATCH out as the print answered
// could be served after the follow-up read, and the notes box showed the old text (the PATCH's
// answer dropped at the gate) or reverted to it, until the next payload.
//
// Now `applyMutation` registers each dispatch in the page's one registry of writes in flight
// (`makeWriteSignals`, drain-queue.ts), in the same synchronous run as its ticket, and the entry
// goes when the request settles, however it ends. `load` snapshots the registry as its GET is sent;
// when the snapshot held a write, the page reads once more after every write in it has settled,
// whether or not one was still out when the read landed, and detached, so nothing `load`'s caller
// does waits on a write (the plan's amendment 1: the follow-up obeys the same rule; this page's
// `load` has no recovery read to mark, so a failed follow-up does nothing, shows no message and is
// not retried). The drains stay, and keep only their timing effect.
//
// vitest has no DOM, so nothing here renders. Both functions are lifted out of CertDetail.tsx's
// syntax tree and run closed over one environment and nothing else: the real mutation gate, the
// real edit guard, the real registry, the real follow-up decision and the real drain, with each
// request and the one state a read sets recorded. A lifted function that gains a free identifier on
// a path these cases take must gain it here in the same change, or it is a ReferenceError in this
// file. The environment hands both functions one registry, so whether the page builds its registry
// once per mount is pinned on the source instead (the source pin at the end of the registration
// describe). Some cases are green on the page before #573, where no read was followed, so "one GET"
// and "not followed" held trivially; the progress record's mutation table says which cases each
// guard reds. The print action itself is not lifted (it needs `window`, `URL`, `trackedFetch` and a
// timer): its follow-up read is pinned on the source to be one `load()` call, after History is
// told, so the cases below are its cases too.

type Cert = { id: string; orderId: string; printedAt: string | null; deletedAt: string | null; freeform: string; internalNotes: string; requirements: never[] };
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** One macrotask: every promise reaction queued so far has run. */
const flush = () => new Promise<void>((done) => { setTimeout(done, 0); });

const STORED: Cert = { id: "cert-1", orderId: "order-1", printedAt: null, deletedAt: null, freeform: "", internalNotes: "", requirements: [] };
const PRINTED_AT = "2026-10-20T15:00:00.000Z";

/** The `useCallback(…)` call CertDetail.tsx declares under `name`. */
function declaredCallback(file: ts.SourceFile, name: string): ts.CallExpression {
  const found = all(file, ts.isVariableDeclaration).filter((d) => ts.isIdentifier(d.name) && d.name.text === name);
  expect(found, name).toHaveLength(1);
  const wrapped = found[0].initializer;
  if (!wrapped || !ts.isCallExpression(wrapped) || wrapped.expression.getText(file) !== "useCallback") {
    throw new Error(`${name} is no longer a useCallback in CertDetail.tsx`);
  }
  return wrapped;
}

const PAGE = "app/certs/[id]/CertDetail.tsx";

/** The `useCallback` argument CertDetail.tsx declares under `name`, closed over `environment`. */
function lifted<T>(name: string, environment: Record<string, unknown>): T {
  const file = source(PAGE);
  return run<T>(declaredCallback(file, name).arguments[0].getText(file), environment);
}

/** One mounted certification page: `load` and `applyMutation` over one environment, the page
 *  holding `initial`. Each GET `load` sends waits in `requests` until the case answers it. */
function page(initial: Cert) {
  let state: Cert | null = initial;
  const editGuard = makeEditGuard();
  const requests: Array<{ url: string; answer: Deferred<Cert> }> = [];
  // Each GET sent, in the order they happen; a case adds its own.
  const events: string[] = [];
  const writes = makeWriteSignals();
  const invalidateHistory = vi.fn();
  // Every setter of the page's messages: its banner (`error`) and the print's. Neither function
  // sets one; a case asserts it stays so.
  const messages = { setError: vi.fn(), setPrintError: vi.fn() };
  const environment: Record<string, unknown> = {
    id: "cert-1",
    mutations: makeMutationGate(),
    writes,
    reReadAfter,
    api: (url: string) => {
      const answer = deferred<Cert>();
      requests.push({ url, answer });
      events.push("GET");
      return answer.promise;
    },
    editGuard,
    setCert: (update: Cert | null | ((cur: Cert | null) => Cert | null)) => {
      state = typeof update === "function" ? update(state) : update;
    },
    // No `ApiError` here: the cert's `applyMutation` never names it (it has no recovery read to mark
    // on a 401 or 403), so a lifted body that gained one would be a ReferenceError in this file,
    // which is the point.
    UnreadableAnswerError,
    invalidateHistory,
    ...messages,
  };
  return {
    load: lifted<() => Promise<Cert>>("load", environment),
    applyMutation: lifted<(work: () => Promise<Cert>) => Promise<void>>("applyMutation", environment),
    editGuard, requests, events, messages, writes, invalidateHistory,
    state: () => state,
    /** A key typed into a notes box: the page's own setter, not a server payload. */
    type: (patch: Partial<Cert>) => { state = state && { ...state, ...patch }; },
  };
}

/** The user enters the freeform notes box, which shows `shown`. */
const focusNotes = (p: ReturnType<typeof page>, shown: string) =>
  p.editGuard.onFocusField("freeform")({ target: { value: shown } } as never);

/** The cert as the server holds it, its freeform notes reading `freeform`. */
const noting = (freeform: string, rest: Partial<Cert> = {}): Cert => ({ ...STORED, freeform, ...rest });
/** The freeform notes the page shows. */
const shownNotes = (p: ReturnType<typeof page>) => p.state()?.freeform;

/** A notes PATCH sent through `applyMutation` (the shape `patchNotes` sends), its answer held until
 *  the case gives it. */
function notesPatch(p: ReturnType<typeof page>) {
  const answer = deferred<Cert>();
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

describe("cert: load and applyMutation apply the cert an answer carries", () => {
  it("load applies the cert", async () => {
    const p = page(STORED);
    const done = p.load();
    expect(p.requests.map((r) => r.url)).toEqual(["/api/certs/cert-1"]);
    const read = noting("noted", { printedAt: PRINTED_AT });
    p.requests[0].answer.resolve(read);
    await expect(done).resolves.toBe(read);
    expect(p.state()).toEqual(read);
  });

  it("load: a focused notes box the user has typed into keeps its text in the same apply", async () => {
    const p = page(STORED);
    focusNotes(p, "");
    p.type({ freeform: "typed" });
    const done = p.load();
    p.requests[0].answer.resolve(noting("from the server", { internalNotes: "internal" }));
    await done;
    expect(p.state()).toEqual({ ...STORED, freeform: "typed", internalNotes: "internal" });
  });

  it("applyMutation: a focused notes box the user has typed into keeps its text in the same apply, and tells History nothing (its callers tell)", async () => {
    const p = page(STORED);
    focusNotes(p, "");
    p.type({ freeform: "typed" });
    await p.applyMutation(async () => noting("from the server", { internalNotes: "internal" }));
    expect(p.state()).toEqual({ ...STORED, freeform: "typed", internalNotes: "internal" });
    expect(p.invalidateHistory).not.toHaveBeenCalled();
  });
});

describe("cert: applyMutation registers each dispatch (#573, the hub's #550 ruling 1)", () => {
  it("a write is in the registry from the instant it is sent, and stays while its request is out", async () => {
    const p = page(STORED);
    const answer = deferred<Cert>();
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
    answer.resolve(noting("noted"));
    await done;
    expect(thunk).toHaveBeenCalledTimes(1);
  });

  it("a write whose answer lands leaves the registry, and History is not told here: its callers tell", async () => {
    const p = page(STORED);
    const answer = deferred<Cert>();
    const done = p.applyMutation(() => answer.promise);
    expect(p.writes.outstanding()).toHaveLength(1);
    answer.resolve(noting("noted"));
    await done;
    await flush();
    expect(p.writes.outstanding()).toEqual([]);
    expect(shownNotes(p)).toBe("noted");
    expect(p.invalidateHistory).not.toHaveBeenCalled();
  });

  it("a write that fails leaves the registry however it fails, and the rejection still reaches the caller", async () => {
    const failures = [
      new ApiError("Certification is printed — its readings are frozen", 409),
      new ApiError("Request failed (500)", 500),
      new ApiError("Not signed in", 401),
      new TypeError("Failed to fetch"),
      new UnreadableAnswerError(WRITE_ANSWER_UNREADABLE, { cause: new SyntaxError("Unexpected end of JSON input") }),
    ];
    for (const failure of failures) {
      const p = page(STORED);
      const answer = deferred<Cert>();
      const thunk = vi.fn(() => answer.promise);
      const done = p.applyMutation(thunk);
      expect(p.writes.outstanding(), failure.message).toHaveLength(1);
      answer.reject(failure);
      await expect(done, failure.message).rejects.toBe(failure);
      expect(thunk, failure.message).toHaveBeenCalledTimes(1);
      await flush();
      expect(p.writes.outstanding(), failure.message).toEqual([]);
      // #547: an unreadable 2xx committed its write, so History is told; nothing else is, and on
      // this page a landed write is told by its caller, not here.
      const told = failure instanceof UnreadableAnswerError ? 1 : 0;
      expect(p.invalidateHistory, failure.message).toHaveBeenCalledTimes(told);
      expect(p.state(), failure.message).toBe(STORED);
    }
  });

  it("a thunk that throws before it returns sent nothing, registers nothing, and its error reaches the caller", async () => {
    const p = page(STORED);
    const thrown = new Error("Reading 2, Value: cannot be negative.");
    const done = p.applyMutation(() => { throw thrown; });
    expect(p.writes.outstanding()).toEqual([]);
    await expect(done).rejects.toBe(thrown);
    await flush();
    expect(p.writes.outstanding()).toEqual([]);
  });

  it("the page holds one registry per mount, and applyMutation and load both read that one", () => {
    const file = source(PAGE);
    const pages = file.statements.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "CertDetail");
    expect(pages).toHaveLength(1);
    const body = pages[0].body!;
    // Every binding of the name in CertDetail, at any depth: exactly one, `const [writes] =
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
    // second site that sets the cert. No wiring test counts this page's setters (the shipment's
    // does), so that is proved by behaviour: "the follow-up is dropped under a write sent after it
    // and answered first" below, where a setter site outside the gate would apply the stale
    // follow-up.
    const followUps = all(loadCallback, ts.isCallExpression).filter((c) =>
      ts.isIdentifier(c.expression) && c.expression.text === "reReadAfter");
    expect(followUps).toHaveLength(1);
  });
});

// The read in these cases is the print's follow-up `load()` (sent after the print answered, so it
// carries `printedAt`), beside a notes PATCH the user's blur sent while the print was out.
describe("cert: load reads now and once more after the writes it overlapped (#573)", () => {
  it("ordering (a): the read lands before the PATCH's answer, which the gate drops, and the read after the PATCH shows the notes, under the follow-up's ticket", async () => {
    const p = page(noting(""));
    const w = notesPatch(p); // the user typed "noted" and left the box
    const read = p.load();
    expect(p.requests.map((r) => r.url)).toEqual(["/api/certs/cert-1"]);
    // Served before the PATCH committed, it lands first and is applied: the old notes, and the
    // print's `printedAt`.
    const first = noting("", { printedAt: PRINTED_AT });
    p.requests[0].answer.resolve(first);
    await expect(read).resolves.toBe(first);
    expect(shownNotes(p)).toBe("");
    expect(p.state()?.printedAt).toBe(PRINTED_AT);
    await flush();
    expect(p.requests).toHaveLength(1); // nothing more while the PATCH is out
    // The PATCH's answer holds the older ticket and is dropped.
    w.answer.resolve(noting("noted", { printedAt: PRINTED_AT }));
    await w.done;
    expect(shownNotes(p)).toBe("");
    await flush();
    expect(p.requests.map((r) => r.url)).toEqual(["/api/certs/cert-1", "/api/certs/cert-1"]);
    const second = noting("noted", { printedAt: PRINTED_AT });
    p.requests[1].answer.resolve(second);
    await flush();
    // The follow-up's own ticket is the newest, so it is applied.
    expect(p.state()).toEqual(second);
    expect(shownNotes(p)).toBe("noted");
    expect(p.requests).toHaveLength(2);
  });

  it("ordering (b): the PATCH's answer lands first and the stale read reverts it, and the read after it shows the notes again", async () => {
    const p = page(noting(""));
    const w = notesPatch(p);
    const read = p.load();
    w.answer.resolve(noting("noted"));
    await w.done;
    expect(shownNotes(p)).toBe("noted");
    await flush();
    // The PATCH has settled, but the read has not landed: no follow-up yet.
    expect(p.requests).toHaveLength(1);
    expect(p.writes.outstanding()).toEqual([]);
    p.requests[0].answer.resolve(noting("", { printedAt: PRINTED_AT }));
    await read;
    expect(shownNotes(p)).toBe("");
    await flush();
    // No write is out as the read lands; one was as it was sent, so the page reads once more.
    expect(p.requests).toHaveLength(2);
    p.requests[1].answer.resolve(noting("noted", { printedAt: PRINTED_AT }));
    await flush();
    expect(shownNotes(p)).toBe("noted");
    expect(p.state()?.printedAt).toBe(PRINTED_AT);
    expect(p.requests).toHaveLength(2);
  });

  it("a read sent with no write out is read once", async () => {
    const p = page(noting(""));
    const read = p.load();
    p.requests[0].answer.resolve(noting(""));
    await read;
    await flush();
    expect(p.requests).toHaveLength(1);
  });

  it("a write sent after the read went out brings no follow-up: the gate orders it", async () => {
    const p = page(noting(""));
    const read = p.load();
    const w = notesPatch(p);
    p.requests[0].answer.resolve(noting(""));
    await read;
    await flush();
    expect(p.requests).toHaveLength(1);
    w.answer.resolve(noting("noted"));
    await w.done;
    await flush();
    expect(p.requests).toHaveLength(1);
    expect(shownNotes(p)).toBe("noted"); // newer ticket than the read: applied over it
  });

  it("the caller does not wait on a write: load resolves with its read while the write it overlapped never answers", async () => {
    const p = page(noting(""));
    void p.applyMutation(() => new Promise<Cert>(() => {})); // no answer, ever (api() has no timeout)
    let settled = false;
    void p.load().then(() => { settled = true; });
    expect(p.requests).toHaveLength(1); // the GET went out at once
    p.requests[0].answer.resolve(noting(""));
    await flush();
    expect(settled).toBe(true);
    expect(p.requests).toHaveLength(1);
  });

  it("a read that fails rejects to its caller and brings no follow-up", async () => {
    const p = page(noting(""));
    const w = notesPatch(p);
    const read = p.load();
    const failure = new TypeError("Failed to fetch");
    p.requests[0].answer.reject(failure);
    await expect(read).rejects.toBe(failure);
    expect(p.state()).toEqual(noting(""));
    w.answer.resolve(noting("noted"));
    await w.done;
    await flush();
    expect(p.requests).toHaveLength(1);
    expect(shownNotes(p)).toBe("noted");
  });

  it("a follow-up that fails applies nothing, shows no message, is not retried, and nothing is unhandled", async () => {
    const p = page(noting(""));
    const w = notesPatch(p);
    const reported = await unhandledDuring(async () => {
      const read = p.load();
      p.requests[0].answer.resolve(noting("", { printedAt: PRINTED_AT }));
      await read;
      w.answer.resolve(noting("noted", { printedAt: PRINTED_AT }));
      await w.done;
      await flush();
      expect(p.requests).toHaveLength(2);
      p.requests[1].answer.reject(new ApiError("Request failed (500)", 500));
      await flush();
    });
    expect(reported).toEqual([]);
    // The page keeps what the first read showed: ordering (a) as it was before #573, a residual.
    expect(p.state()).toEqual(noting("", { printedAt: PRINTED_AT }));
    expect(Object.keys(p.messages)).toHaveLength(2);
    for (const [name, setter] of Object.entries(p.messages)) expect(setter, name).not.toHaveBeenCalled();
    await flush();
    expect(p.requests).toHaveLength(2);
  });

  it("the follow-up takes its own ticket as it is sent: applied over a write answered before it was sent", async () => {
    const p = page(noting(""));
    const w = notesPatch(p);
    const read = p.load();
    p.requests[0].answer.resolve(noting(""));
    await read;
    // A second write, sent and answered while the first is still out.
    const w2 = notesPatch(p);
    w2.answer.resolve(noting("", { internalNotes: "internal" }));
    await w2.done;
    expect(p.state()?.internalNotes).toBe("internal");
    w.answer.resolve(noting("noted"));
    await w.done;
    await flush();
    expect(p.requests).toHaveLength(2);
    p.requests[1].answer.resolve(noting("noted", { internalNotes: "internal" }));
    await flush();
    expect(p.state()).toEqual(noting("noted", { internalNotes: "internal" }));
  });

  it("the follow-up is dropped under a write sent after it and answered first", async () => {
    const p = page(noting(""));
    const w = notesPatch(p);
    const read = p.load();
    p.requests[0].answer.resolve(noting(""));
    await read;
    w.answer.resolve(noting("noted"));
    await w.done;
    await flush();
    expect(p.requests).toHaveLength(2);
    const w2 = notesPatch(p);
    w2.answer.resolve(noting("noted", { internalNotes: "internal" }));
    await w2.done;
    expect(p.state()).toEqual(noting("noted", { internalNotes: "internal" }));
    p.requests[1].answer.resolve(noting("noted"));
    await flush();
    expect(p.state()).toEqual(noting("noted", { internalNotes: "internal" }));
    expect(p.requests).toHaveLength(2); // the follow-up was sent with no write out
  });

  it("a follow-up sent while a later write is out is followed in turn, and the chain ends at the first read sent with none out", async () => {
    const p = page(noting(""));
    const w1 = notesPatch(p);
    const read = p.load();
    p.requests[0].answer.resolve(noting(""));
    await read;
    const w2 = notesPatch(p);
    w1.answer.resolve(noting("noted"));
    await w1.done;
    await flush();
    expect(p.requests).toHaveLength(2); // sent with w2 out
    p.requests[1].answer.resolve(noting("noted"));
    await flush();
    expect(p.requests).toHaveLength(2); // nothing more while w2 is out
    w2.answer.resolve(noting("noted", { internalNotes: "internal" }));
    await w2.done;
    await flush();
    expect(p.requests).toHaveLength(3); // sent with nothing out
    p.requests[2].answer.resolve(noting("noted", { internalNotes: "internal" }));
    await flush();
    expect(p.state()).toEqual(noting("noted", { internalNotes: "internal" }));
    await flush();
    expect(p.requests).toHaveLength(3);
  });

  it("a read the gate drops is followed all the same when a write was out as it was sent", async () => {
    const p = page(noting(""));
    const w1 = notesPatch(p);
    const read = p.load();
    // A second write, sent after the read and answered before it: its answer is applied, and the
    // read, older-ticketed, is dropped when it lands. Its snapshot still holds the first write,
    // whose own answer the gate will drop as older than the second's.
    const w2 = notesPatch(p);
    w2.answer.resolve(noting("", { internalNotes: "internal" }));
    await w2.done;
    p.requests[0].answer.resolve(noting(""));
    await read;
    expect(p.state()).toEqual(noting("", { internalNotes: "internal" }));
    w1.answer.resolve(noting("noted"));
    await w1.done;
    expect(p.state()).toEqual(noting("", { internalNotes: "internal" }));
    await flush();
    expect(p.requests).toHaveLength(2);
    p.requests[1].answer.resolve(noting("noted", { internalNotes: "internal" }));
    await flush();
    expect(p.state()).toEqual(noting("noted", { internalNotes: "internal" }));
  });

  it("the follow-up is sent after the write settled, and not before", async () => {
    const p = page(noting(""));
    const answer = deferred<Cert>();
    const done = p.applyMutation(() => { p.events.push("write"); return answer.promise; });
    const read = p.load();
    p.requests[0].answer.resolve(noting(""));
    await read;
    await flush();
    expect(p.events).toEqual(["write", "GET"]);
    p.events.push("write settled");
    answer.resolve(noting("noted"));
    await done;
    await flush();
    expect(p.events).toEqual(["write", "GET", "write settled", "GET"]);
    p.requests[1].answer.resolve(noting("noted"));
    await flush();
    expect(shownNotes(p)).toBe("noted");
  });
});

// `patchNotes`'s shape, modelled: the notes PATCH goes through `applyMutation` (so the registry
// holds it), its request-settled signal is set in the page's per-key `inFlight` map at dispatch,
// and on a refusal the other keys (the other notes field, every readings block) are drained
// through the real `drainOtherKeys` before the rollback `load()`. The PATCH's own request has
// settled by the time its catch runs, and a drained sibling's request has settled by the time the
// drain releases; the registry entry of each goes with its request, before either signal, so the
// rollback GET's snapshot holds neither and the drain keeps only its timing effect (never a spare
// follow-up).
// The "alone" case is green on the page before #573 (nothing followed a read then) and pins the
// order of the delete reaction against the leaf; the sibling case reds there at its `outstanding()`
// length.
describe("cert: the rollback drains and the registry do not interact (#573)", () => {
  const noop = () => {};

  it("a refused notes save alone: its rollback read is one GET, not followed (an ordering pin: the notes save's own entry has left the registry before its catch reads; green before #573, when no read was followed)", async () => {
    const p = page(noting(""));
    const inFlight = new Map<string, Promise<unknown>>();
    const own = notesPatch(p);
    inFlight.set("freeform", own.done.then(noop, noop));
    own.answer.reject(new ApiError("Certification is voided", 409));
    await expect(own.done).rejects.toBeInstanceOf(ApiError);
    await drainOtherKeys(inFlight, "freeform");
    expect(p.writes.outstanding()).toEqual([]);
    const rollback = p.load();
    expect(p.requests).toHaveLength(1);
    p.requests[0].answer.resolve(noting(""));
    await rollback;
    await flush();
    expect(p.requests).toHaveLength(1);
  });

  it("a refused notes save beside a readings block's save: the block is drained, and the rollback read is not followed for it (the pin, for the shape as modelled: patchNotes's drain is modelled here, not lifted)", async () => {
    const p = page(noting(""));
    const inFlight = new Map<string, Promise<unknown>>();
    const sibling = notesPatch(p); // a readings PUT, the same shape through applyMutation
    inFlight.set("readings:req-1", sibling.done.then(noop, noop));
    const own = notesPatch(p);
    inFlight.set("freeform", own.done.then(noop, noop));
    own.answer.reject(new ApiError("Certification is voided", 409));
    await expect(own.done).rejects.toBeInstanceOf(ApiError);
    expect(p.writes.outstanding()).toHaveLength(1); // the sibling, still out
    let drained = false;
    const drain = drainOtherKeys(inFlight, "freeform").then(() => { drained = true; });
    await flush();
    expect(drained).toBe(false);
    sibling.answer.resolve(noting("", { internalNotes: "internal" }));
    await drain;
    // Released after the sibling's request settled, by which time its registry entry is gone.
    expect(p.writes.outstanding()).toEqual([]);
    const rollback = p.load();
    expect(p.requests).toHaveLength(1);
    p.requests[0].answer.resolve(noting("", { internalNotes: "internal" }));
    await rollback;
    await flush();
    expect(p.requests).toHaveLength(1);
    expect(p.state()?.internalNotes).toBe("internal");
  });
});

// The print action is not lifted: it opens a window, builds an object URL, fetches through
// `trackedFetch` and sets a timer. Its follow-up read is `load`, so the cases above are its cases,
// provided that is what it calls: once, in its try, after History is told, and with `load` among
// its dependencies so the read it calls is the page's current one.
// Green on the page before #573 by design: it pins the print's read to be `load`, whose rule the
// cases above prove.
describe("cert: the print's follow-up read is the page's load (#573)", () => {
  it("printCertAction's try calls load() exactly once, after invalidateHistory(), and depends on [id, load]", () => {
    const file = source(PAGE);
    const wrapped = declaredCallback(file, "printCertAction");
    const [callback, deps] = wrapped.arguments;
    if (!deps || !ts.isArrayLiteralExpression(deps)) throw new Error("printCertAction has no dependency array");
    expect(deps.elements.map((e) => e.getText(file))).toEqual(["id", "load"]);
    // The outer try: its block holds the print, the tell and the follow-up read; its catch shows
    // the print's own failure.
    const tries = all(callback, ts.isTryStatement);
    expect(tries.length).toBeGreaterThanOrEqual(1);
    const outer = tries[0];
    const callsIn = (root: ts.Node, name: string) => all(root, ts.isCallExpression)
      .filter((c) => ts.isIdentifier(c.expression) && c.expression.text === name);
    // In the whole callback, `load()` is called exactly once, and that call is in the outer try's
    // block (not its catch, not its finally): a print that failed reads nothing.
    const loads = callsIn(callback, "load");
    expect(loads).toHaveLength(1);
    expect(callsIn(outer.tryBlock, "load")).toHaveLength(1);
    expect(loads[0].arguments).toHaveLength(0);
    // Awaited: a failed refresh is the inner try's to name, which a detached call would never reach.
    expect(ts.isAwaitExpression(loads[0].parent)).toBe(true);
    // Sent after the print itself: `load()` starts after the one `trackedFetch(` of the try starts, so
    // the read postdates the print's answer and carries `printedAt`.
    const prints = callsIn(outer.tryBlock, "trackedFetch");
    expect(prints).toHaveLength(1);
    expect(prints[0].getStart(file)).toBeLessThan(loads[0].getStart(file));
    // History is told in that block too, once, before the read is sent (#158's order).
    const tells = callsIn(outer.tryBlock, "invalidateHistory");
    expect(tells).toHaveLength(1);
    expect(tells[0].getStart(file)).toBeLessThan(loads[0].getStart(file));
  });
});
