import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { drainOtherKeys, makeWriteSignals, reReadAfter } from "@/lib/drain-queue";
import { ApiError, UnreadableAnswerError, WRITE_ANSWER_UNREADABLE } from "@/lib/fetcher";
import { offersStepSuggestions } from "@/lib/invoice-step-pick";
import { makeEditGuard } from "@/lib/use-edit-guard";
import { makeMutationGate } from "@/lib/use-latest";
import { source } from "./helpers/lift-callback";
import { all, run } from "./helpers/source-lift";

// #573 (owner ruling 2026-10-20, amendment 1: the hub's #550 rule on the invoice page). The page's
// `load` sends its GET at once and takes the newest ticket, so a read served before a write still
// out had committed holds the newer ticket: it reverts that write on screen, or has the write's
// answer dropped at the gate. The page's header PATCH drains its sibling header keys before its
// rollback read, but the writes `applyMutation` sends that the drain never sees (the lines save,
// Recalculate, Finalize, Unlock) were not waited for, and a rollback read beside one of them lost
// the write's answer until the next payload: with Finalize out, the page showed the invoice as a
// draft, its draft controls open, while the server had finalized it.
//
// Now `applyMutation` registers each dispatch in the page's one registry of writes in flight
// (`makeWriteSignals`, drain-queue.ts), in the same synchronous run as its ticket, and the entry
// goes when the request settles, however it ends. `load` snapshots the registry as its GET is sent;
// when the snapshot held a write, the page reads once more after every write in it has settled,
// whether or not one was still out when the read landed, and detached, so nothing `load`'s caller
// does waits on a write (the plan's amendment 1: the follow-up obeys the same rule, a failed one is
// any failed read of the invoice, which marks the lines grid's recovery read unavailable with no
// message, and none is retried). The drains stay, and keep only their timing effect.
//
// vitest has no DOM, so nothing here renders. Both functions are lifted out of InvoiceDetail.tsx's
// syntax tree and run closed over one environment and nothing else: the real mutation gate, the
// real edit guard, the real registry, the real follow-up decision and the real drain, with each
// request, each recovery read and the two states a read sets recorded. A lifted function that
// gains a free identifier on a path these cases take must gain it here in the same change, or it
// is a ReferenceError in this file. The environment hands both functions one registry, so whether
// the page builds its registry once per mount is pinned on the source instead (the source pin at
// the end of the registration describe). Some cases are green on the page before #573, where no
// read was followed, so "one GET" and "not followed" held trivially; the progress record's mutation
// table says which cases each guard reds. The lines grid's own recovery read (the bulk recovery
// source's `read` and the grid's Check again) waits for no write: a recorded residual (the plan's
// amendment 2), outside what this file proves.

type InvoiceLine = { id: string; amount: number };
type Invoice = { id: string; status: "DRAFT" | "FINALIZED"; poNumber: string; termsName: string; lines: InvoiceLine[] };
type Answer = { invoice: Invoice; warnings: string[] };
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** One macrotask: every promise reaction queued so far has run. */
const flush = () => new Promise<void>((done) => { setTimeout(done, 0); });

const line = (amount: number): InvoiceLine => ({ id: `L-${amount}`, amount });
const STORED: Invoice = { id: "invoice-1", status: "DRAFT", poNumber: "", termsName: "Net 30", lines: [line(100)] };

/** The `useCallback(…)` call InvoiceDetail.tsx declares under `name`. */
function declaredCallback(file: ts.SourceFile, name: string): ts.CallExpression {
  const found = all(file, ts.isVariableDeclaration).filter((d) => ts.isIdentifier(d.name) && d.name.text === name);
  expect(found, name).toHaveLength(1);
  const wrapped = found[0].initializer;
  if (!wrapped || !ts.isCallExpression(wrapped) || wrapped.expression.getText(file) !== "useCallback") {
    throw new Error(`${name} is no longer a useCallback in InvoiceDetail.tsx`);
  }
  return wrapped;
}

const PAGE = "app/invoicing/[id]/InvoiceDetail.tsx";

/** The `useCallback` argument InvoiceDetail.tsx declares under `name`, closed over `environment`. */
function lifted<T>(name: string, environment: Record<string, unknown>): T {
  const file = source(PAGE);
  return run<T>(declaredCallback(file, name).arguments[0].getText(file), environment);
}

/** One mounted invoice page: `load` and `applyMutation` over one environment, the page holding
 *  `initial`. Each GET `load` sends waits in `requests` until the case answers it. */
function page(initial: Invoice) {
  let state: Invoice | null = initial;
  const editGuard = makeEditGuard();
  const requests: Array<{ url: string; answer: Deferred<Answer> }> = [];
  const reads: Array<{ unavailable: ReturnType<typeof vi.fn>; accept: ReturnType<typeof vi.fn> }> = [];
  // Each recovery read begun and each GET sent, in the order they happen; a case adds its own.
  const events: string[] = [];
  const writes = makeWriteSignals();
  const invalidateHistory = vi.fn();
  const setWarnings = vi.fn();
  // Every setter of the page's messages: its banner (`error`), the print's and the print's folder
  // line (#588). Neither function sets one; a case asserts it stays so.
  const messages = { setError: vi.fn(), setPrintError: vi.fn(), setPrintWarning: vi.fn() };
  const environment: Record<string, unknown> = {
    id: "invoice-1",
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
    setInvoice: (update: Invoice | null | ((cur: Invoice | null) => Invoice | null)) => {
      state = typeof update === "function" ? update(state) : update;
    },
    setWarnings,
    ApiError,
    UnreadableAnswerError,
    invalidateHistory,
    ...messages,
  };
  return {
    load: lifted<() => Promise<Invoice>>("load", environment),
    applyMutation: lifted<(work: () => Promise<Answer>) => Promise<void>>("applyMutation", environment),
    editGuard, requests, reads, events, messages, setWarnings, writes, invalidateHistory,
    state: () => state,
    /** A key typed into a header box: the page's own setter, not a server payload. */
    type: (patch: Partial<Invoice>) => { state = state && { ...state, ...patch }; },
  };
}

/** The user enters the PO number box, which shows `shown`. */
const focusPoNumber = (p: ReturnType<typeof page>, shown: string) =>
  p.editGuard.onFocusField("poNumber")({ target: { value: shown } } as never);

/** The invoice as the server holds it, a draft carrying the lines of `amounts`. */
const holding = (...amounts: number[]): Invoice => ({ ...STORED, lines: amounts.map(line) });
/** That invoice finalized: what Finalize's answer, and a read after it, carry. */
const finalized = (invoice: Invoice): Invoice => ({ ...invoice, status: "FINALIZED" });
/** An answer of that invoice: what a read and a write both carry. */
const answerOf = (invoice: Invoice, rest: Partial<Omit<Answer, "invoice">> = {}): Answer =>
  ({ invoice, warnings: [], ...rest });
/** The line amounts the page shows, in order. */
const shownLines = (p: ReturnType<typeof page>) => p.state()?.lines.map((l) => l.amount);

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

describe("invoice: load and applyMutation apply the two states an answer carries", () => {
  it("load applies the invoice and its warnings, and hands the recovery read the invoice", async () => {
    const p = page(STORED);
    const done = p.load();
    expect(p.requests.map((r) => r.url)).toEqual(["/api/invoices/invoice-1"]);
    const read = answerOf(holding(100, 250), { warnings: ["w1"] });
    p.requests[0].answer.resolve(read);
    await expect(done).resolves.toBe(read.invoice);
    expect(p.state()).toEqual(read.invoice);
    expect(p.setWarnings).toHaveBeenCalledWith(["w1"]);
    expect(p.reads).toHaveLength(1);
    expect(p.reads[0].accept).toHaveBeenCalledWith(read.invoice);
  });

  it("load: a focused PO number box the user has typed into keeps its text in the same apply", async () => {
    const p = page(STORED);
    focusPoNumber(p, "");
    p.type({ poNumber: "typed" });
    const done = p.load();
    p.requests[0].answer.resolve(answerOf({ ...STORED, poNumber: "from the server", termsName: "Net 45" }));
    await done;
    expect(p.state()).toEqual({ ...STORED, poNumber: "typed", termsName: "Net 45" });
  });

  it("applyMutation: a focused PO number box the user has typed into keeps its text in the same apply", async () => {
    const p = page(STORED);
    focusPoNumber(p, "");
    p.type({ poNumber: "typed" });
    await p.applyMutation(async () => answerOf({ ...STORED, poNumber: "from the server", termsName: "Net 45" }));
    expect(p.state()).toEqual({ ...STORED, poNumber: "typed", termsName: "Net 45" });
    expect(p.invalidateHistory).toHaveBeenCalledTimes(1);
  });
});

describe("invoice: applyMutation registers each dispatch (#573, the hub's #550 ruling 1)", () => {
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
    answer.resolve(answerOf(holding(100, 250)));
    await done;
    expect(thunk).toHaveBeenCalledTimes(1);
  });

  it("a write whose answer lands leaves the registry, and History is told once", async () => {
    const p = page(STORED);
    const answer = deferred<Answer>();
    const done = p.applyMutation(() => answer.promise);
    expect(p.writes.outstanding()).toHaveLength(1);
    answer.resolve(answerOf(holding(100, 250)));
    await done;
    await flush();
    expect(p.writes.outstanding()).toEqual([]);
    expect(shownLines(p)).toEqual([100, 250]);
    expect(p.invalidateHistory).toHaveBeenCalledTimes(1);
  });

  it("a write that fails leaves the registry however it fails, and the rejection still reaches the caller", async () => {
    const failures = [
      new ApiError("The invoice's shipments changed since it was calculated. Recalculate it first.", 409),
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
    }
  });

  it("a thunk that throws before it returns sent nothing, registers nothing, and its error reaches the caller", async () => {
    const p = page(STORED);
    const thrown = new Error("Part / operation line 2, Net weight (lb): must be greater than zero.");
    const done = p.applyMutation(() => { throw thrown; });
    expect(p.writes.outstanding()).toEqual([]);
    await expect(done).rejects.toBe(thrown);
    await flush();
    expect(p.writes.outstanding()).toEqual([]);
  });

  it("the page holds one registry per mount, and applyMutation and load both read that one", () => {
    const file = source(PAGE);
    const pages = file.statements.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "InvoiceDetail");
    expect(pages).toHaveLength(1);
    const body = pages[0].body!;
    // Every binding of the name in InvoiceDetail, at any depth: exactly one, `const [writes] =
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
    // second site that sets the two states. No wiring test counts this page's setters (the
    // shipment's does), so that is proved by behaviour: "the follow-up is dropped under a write sent
    // after it and answered first" below, where a setter site outside the gate would apply the
    // stale follow-up.
    const followUps = all(loadCallback, ts.isCallExpression).filter((c) =>
      ts.isIdentifier(c.expression) && c.expression.text === "reReadAfter");
    expect(followUps).toHaveLength(1);
  });
});

describe("invoice: load reads now and once more after the writes it overlapped (#573)", () => {
  it("ordering (a): the read lands before the write's answer, which the gate drops, and the read after the write shows it, both states under the follow-up's ticket", async () => {
    const p = page(holding(100));
    const w = write(p); // Finalize, say
    const read = p.load();
    expect(p.requests.map((r) => r.url)).toEqual(["/api/invoices/invoice-1"]);
    // Served before the write committed, it lands first and is applied: the invoice shown as a
    // draft, which it no longer is.
    const first = answerOf(holding(100), { warnings: ["before"] });
    p.requests[0].answer.resolve(first);
    await expect(read).resolves.toBe(first.invoice);
    expect(p.state()?.status).toBe("DRAFT");
    expect(p.setWarnings.mock.calls).toEqual([[["before"]]]);
    await flush();
    expect(p.requests).toHaveLength(1); // nothing more while the write is out
    // The write's answer holds the older ticket and is dropped: History is still told.
    w.answer.resolve(answerOf(finalized(holding(100)), { warnings: ["after"] }));
    await w.done;
    expect(p.state()?.status).toBe("DRAFT");
    expect(p.setWarnings.mock.calls).toEqual([[["before"]]]);
    expect(p.invalidateHistory).toHaveBeenCalledTimes(1);
    await flush();
    expect(p.requests.map((r) => r.url)).toEqual(["/api/invoices/invoice-1", "/api/invoices/invoice-1"]);
    const second = answerOf(finalized(holding(100)), { warnings: ["after"] });
    p.requests[1].answer.resolve(second);
    await flush();
    // The follow-up's own ticket is the newest, so both of its states are applied.
    expect(p.state()).toEqual(second.invoice);
    expect(p.state()?.status).toBe("FINALIZED");
    expect(p.setWarnings.mock.calls).toEqual([[["before"]], [["after"]]]);
    expect(p.reads).toHaveLength(3);
    expect(p.reads[2].accept).toHaveBeenCalledWith(second.invoice);
    expect(p.requests).toHaveLength(2);
  });

  it("ordering (b): the write's answer lands first and the stale read reverts it, and the read after it shows the write again", async () => {
    const p = page(holding(100));
    const w = write(p); // the lines save, say
    const read = p.load();
    w.answer.resolve(answerOf(holding(100, 250)));
    await w.done;
    expect(shownLines(p)).toEqual([100, 250]);
    await flush();
    // The write has settled, but the read has not landed: no follow-up yet.
    expect(p.requests).toHaveLength(1);
    expect(p.writes.outstanding()).toEqual([]);
    p.requests[0].answer.resolve(answerOf(holding(100)));
    await read;
    expect(shownLines(p)).toEqual([100]);
    await flush();
    // No write is out as the read lands; one was as it was sent, so the page reads once more.
    expect(p.requests).toHaveLength(2);
    p.requests[1].answer.resolve(answerOf(holding(100, 250)));
    await flush();
    expect(shownLines(p)).toEqual([100, 250]);
    expect(p.requests).toHaveLength(2);
  });

  it("a read sent with no write out is read once", async () => {
    const p = page(holding(100));
    const read = p.load();
    p.requests[0].answer.resolve(answerOf(holding(100)));
    await read;
    await flush();
    expect(p.requests).toHaveLength(1);
  });

  it("a write sent after the read went out brings no follow-up: the gate orders it", async () => {
    const p = page(holding(100));
    const read = p.load();
    const w = write(p);
    p.requests[0].answer.resolve(answerOf(holding(100)));
    await read;
    await flush();
    expect(p.requests).toHaveLength(1);
    w.answer.resolve(answerOf(holding(100, 250)));
    await w.done;
    await flush();
    expect(p.requests).toHaveLength(1);
    expect(shownLines(p)).toEqual([100, 250]); // newer ticket than the read: applied over it
  });

  it("the caller does not wait on a write: load resolves with its read while the write it overlapped never answers", async () => {
    const p = page(holding(100));
    void p.applyMutation(() => new Promise<Answer>(() => {})); // no answer, ever (api() has no timeout)
    let settled = false;
    void p.load().then(() => { settled = true; });
    expect(p.requests).toHaveLength(1); // the GET went out at once
    p.requests[0].answer.resolve(answerOf(holding(100)));
    await flush();
    expect(settled).toBe(true);
    expect(p.requests).toHaveLength(1);
  });

  it("a read that fails rejects to its caller, marks its recovery read unavailable and brings no follow-up", async () => {
    const p = page(holding(100));
    const w = write(p);
    const read = p.load();
    const failure = new TypeError("Failed to fetch");
    p.requests[0].answer.reject(failure);
    await expect(read).rejects.toBe(failure);
    expect(p.reads).toHaveLength(2);
    expect(p.reads[1].unavailable).toHaveBeenCalledTimes(1);
    expect(p.reads[1].accept).not.toHaveBeenCalled();
    w.answer.resolve(answerOf(holding(100, 250)));
    await w.done;
    await flush();
    expect(p.requests).toHaveLength(1);
    expect(shownLines(p)).toEqual([100, 250]);
  });

  it("a follow-up that fails is any failed read of the invoice: its recovery read unavailable, no message, no retry, nothing unhandled", async () => {
    const p = page(holding(100));
    const w = write(p);
    const reported = await unhandledDuring(async () => {
      const read = p.load();
      p.requests[0].answer.resolve(answerOf(holding(100)));
      await read;
      w.answer.resolve(answerOf(finalized(holding(100))));
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
    expect(p.state()?.status).toBe("DRAFT");
    expect(Object.keys(p.messages)).toHaveLength(3);
    for (const [name, setter] of Object.entries(p.messages)) expect(setter, name).not.toHaveBeenCalled();
    await flush();
    expect(p.requests).toHaveLength(2);
  });

  it("the follow-up takes its own ticket as it is sent: applied over a write answered before it was sent", async () => {
    const p = page(holding(100));
    const w = write(p);
    const read = p.load();
    p.requests[0].answer.resolve(answerOf(holding(100)));
    await read;
    // A second write, sent and answered while the first is still out.
    const w2 = write(p);
    w2.answer.resolve(answerOf(holding(100, 300)));
    await w2.done;
    expect(shownLines(p)).toEqual([100, 300]);
    w.answer.resolve(answerOf(holding(100, 250)));
    await w.done;
    await flush();
    expect(p.requests).toHaveLength(2);
    p.requests[1].answer.resolve(answerOf(holding(100, 250, 300)));
    await flush();
    expect(shownLines(p)).toEqual([100, 250, 300]);
  });

  it("the follow-up is dropped under a write sent after it and answered first", async () => {
    const p = page(holding(100));
    const w = write(p);
    const read = p.load();
    p.requests[0].answer.resolve(answerOf(holding(100)));
    await read;
    w.answer.resolve(answerOf(holding(100, 250)));
    await w.done;
    await flush();
    expect(p.requests).toHaveLength(2);
    const w2 = write(p);
    w2.answer.resolve(answerOf(holding(100, 250, 300)));
    await w2.done;
    expect(shownLines(p)).toEqual([100, 250, 300]);
    p.requests[1].answer.resolve(answerOf(holding(100, 250)));
    await flush();
    expect(shownLines(p)).toEqual([100, 250, 300]);
    expect(p.requests).toHaveLength(2); // the follow-up was sent with no write out
  });

  it("a follow-up sent while a later write is out is followed in turn, and the chain ends at the first read sent with none out", async () => {
    const p = page(holding(100));
    const w1 = write(p);
    const read = p.load();
    p.requests[0].answer.resolve(answerOf(holding(100)));
    await read;
    const w2 = write(p);
    w1.answer.resolve(answerOf(holding(100, 250)));
    await w1.done;
    await flush();
    expect(p.requests).toHaveLength(2); // sent with w2 out
    p.requests[1].answer.resolve(answerOf(holding(100, 250)));
    await flush();
    expect(p.requests).toHaveLength(2); // nothing more while w2 is out
    w2.answer.resolve(answerOf(holding(100, 250, 300)));
    await w2.done;
    await flush();
    expect(p.requests).toHaveLength(3); // sent with nothing out
    p.requests[2].answer.resolve(answerOf(holding(100, 250, 300)));
    await flush();
    expect(shownLines(p)).toEqual([100, 250, 300]);
    await flush();
    expect(p.requests).toHaveLength(3);
  });

  it("a read the gate drops is followed all the same when a write was out as it was sent", async () => {
    const p = page(holding(100));
    const w1 = write(p);
    const read = p.load();
    // A second write, sent after the read and answered before it: its answer is applied, and the
    // read, older-ticketed, is dropped when it lands. Its snapshot still holds the first write,
    // whose own answer the gate will drop as older than the second's.
    const w2 = write(p);
    w2.answer.resolve(answerOf(holding(100, 300)));
    await w2.done;
    p.requests[0].answer.resolve(answerOf(holding(100)));
    await read;
    expect(shownLines(p)).toEqual([100, 300]);
    w1.answer.resolve(answerOf(holding(100, 250)));
    await w1.done;
    expect(shownLines(p)).toEqual([100, 300]);
    await flush();
    expect(p.requests).toHaveLength(2);
    p.requests[1].answer.resolve(answerOf(holding(100, 250, 300)));
    await flush();
    expect(shownLines(p)).toEqual([100, 250, 300]);
  });

  it("the follow-up begins its own recovery read as it is sent, after the write settled, and hands it the invoice it read", async () => {
    const p = page(holding(100));
    const answer = deferred<Answer>();
    const done = p.applyMutation(() => { p.events.push("write"); return answer.promise; });
    const read = p.load();
    const first = answerOf(holding(100));
    p.requests[0].answer.resolve(first);
    await read;
    await flush();
    expect(p.events).toEqual(["begin", "write", "begin", "GET"]);
    p.events.push("write settled");
    answer.resolve(answerOf(holding(100, 250)));
    await done;
    await flush();
    expect(p.events).toEqual(["begin", "write", "begin", "GET", "write settled", "begin", "GET"]);
    const second = answerOf(holding(100, 250));
    p.requests[1].answer.resolve(second);
    await flush();
    expect(p.reads).toHaveLength(3);
    expect(p.reads[0].accept).not.toHaveBeenCalled(); // the write's answer, dropped at the gate
    expect(p.reads[1].accept).toHaveBeenCalledWith(first.invoice);
    expect(p.reads[2].accept).toHaveBeenCalledWith(second.invoice);
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
describe("invoice: the header drain and the registry do not interact (#573)", () => {
  const noop = () => {};

  it("a refused header save alone: its rollback read is one GET, not followed (an ordering pin: the header's own entry has left the registry before its catch reads; green before #573, when no read was followed)", async () => {
    const p = page(holding(100));
    const inFlight = new Map<string, Promise<unknown>>();
    const header = write(p);
    inFlight.set("poNumber", header.done.then(noop, noop));
    header.answer.reject(new ApiError("Invoice date: must be a date", 400));
    await expect(header.done).rejects.toBeInstanceOf(ApiError);
    await drainOtherKeys(inFlight, "poNumber");
    expect(p.writes.outstanding()).toEqual([]);
    const rollback = p.load();
    expect(p.requests).toHaveLength(1);
    p.requests[0].answer.resolve(answerOf(holding(100)));
    await rollback;
    await flush();
    expect(p.requests).toHaveLength(1);
  });

  it("a refused header save beside a sibling key's save: the sibling is drained, and the rollback read is not followed for it (the pin, for the shape as modelled: patchHeader's drain is modelled here, not lifted)", async () => {
    const p = page(holding(100));
    const inFlight = new Map<string, Promise<unknown>>();
    const sibling = write(p);
    inFlight.set("termsName", sibling.done.then(noop, noop));
    const header = write(p);
    inFlight.set("poNumber", header.done.then(noop, noop));
    header.answer.reject(new ApiError("Invoice date: must be a date", 400));
    await expect(header.done).rejects.toBeInstanceOf(ApiError);
    expect(p.writes.outstanding()).toHaveLength(1); // the sibling, still out
    let drained = false;
    const drain = drainOtherKeys(inFlight, "poNumber").then(() => { drained = true; });
    await flush();
    expect(drained).toBe(false);
    sibling.answer.resolve(answerOf({ ...holding(100), termsName: "Net 45" }));
    await drain;
    // Released after the sibling's request settled, by which time its registry entry is gone.
    expect(p.writes.outstanding()).toEqual([]);
    const rollback = p.load();
    expect(p.requests).toHaveLength(1);
    p.requests[0].answer.resolve(answerOf({ ...holding(100), termsName: "Net 45" }));
    await rollback;
    await flush();
    expect(p.requests).toHaveLength(1);
    expect(p.state()?.termsName).toBe("Net 45");
  });
});

// #587 (Amendment 22): the page reads its step suggestions in an effect of its own, never inside
// `load` (whose requests the cases above pin), and only for a draft invoice
// (`offersStepSuggestions`, tests/invoice-step-pick.test.ts). Each run first clears the list it held.
// The effect is lifted from the source and run over an environment holding only what it may touch,
// so a banner set on a failed read (`setError`, here a spy) or a read on any other invoice reds a
// case.
describe("invoice: the step suggestions read (#587)", () => {
  const file = source(PAGE);
  const effects = all(file, ts.isCallExpression).filter((call) => call.expression.getText(file) === "useEffect"
    && call.arguments[0]?.getText(file).includes("step-suggestions"));
  const URL_READ = "/api/invoices/invoice-1/step-suggestions";

  function mount(offersSteps: boolean) {
    const answer = deferred<unknown>();
    const api = vi.fn<(url: string) => Promise<unknown>>(() => answer.promise);
    const setStepSuggestions = vi.fn();
    const setError = vi.fn();
    const cleanup = run<() => (() => void) | undefined>(effects[0].arguments[0].getText(file),
      { id: "invoice-1", offersSteps, api, setStepSuggestions, setError })();
    return { answer, api, setStepSuggestions, setError, cleanup };
  }

  it("is one effect, keyed by the invoice and whether it asks, never by the invoice payload (a payload lands on every write)", () => {
    expect(effects).toHaveLength(1);
    expect(effects[0].arguments[1]?.getText(file)).toBe("[id, offersSteps]");
  });

  it("asks exactly when the leaf says the invoice offers suggestions, and not before the invoice is read", () => {
    const declared = all(file, ts.isVariableDeclaration).filter((d) => ts.isIdentifier(d.name) && d.name.text === "offersSteps");
    expect(declared).toHaveLength(1);
    const asks = (invoice: unknown) => run<boolean>(declared[0].initializer!.getText(file), { invoice, offersStepSuggestions });
    expect(asks({ kind: "INVOICE", status: "DRAFT", deletedAt: null })).toBe(true);
    expect(asks({ kind: "CREDIT", status: "DRAFT", deletedAt: null })).toBe(false);
    expect(asks({ kind: "INVOICE", status: "FINALIZED", deletedAt: null })).toBe(false);
    expect(asks(null)).toBe(false);
  });

  it("a draft invoice: one GET of its own suggestions, and the answer is what the grid is handed", async () => {
    const m = mount(true);
    expect(m.api.mock.calls).toEqual([[URL_READ]]);
    const data = { byOrderLine: { "ol-1": [] }, others: [{ id: "code-ah", code: "AH", name: "Age Harden" }] };
    m.answer.resolve(data);
    await flush();
    // The run's own clearing first (the case below), then the answer.
    expect(m.setStepSuggestions.mock.calls).toEqual([[null], [data]]);
    expect(m.setError).not.toHaveBeenCalled();
  });

  // #587 fix wave (F9): each run clears the list it held before anything else, so a new invoice id,
  // or a draft just finalized, never keeps the list read for what the page showed before.
  it.each([true, false])("each run first clears the list it held, before it asks or returns (asks: %s)", (offersSteps) => {
    const order: string[] = [];
    const answer = deferred<unknown>();
    const api = vi.fn(() => { order.push("GET"); return answer.promise; });
    const setStepSuggestions = vi.fn((value: unknown) => { order.push(`set ${JSON.stringify(value)}`); });
    run<() => (() => void) | undefined>(effects[0].arguments[0].getText(file),
      { id: "invoice-1", offersSteps, api, setStepSuggestions, setError: vi.fn() })();
    expect(order).toEqual(offersSteps ? ["set null", "GET"] : ["set null"]);
  });

  it("any other invoice (a credit, a finalized or a discarded one): no read at all, and no list", () => {
    const m = mount(false);
    expect(m.api).not.toHaveBeenCalled();
    expect(m.cleanup).toBeUndefined();
    expect(m.setStepSuggestions.mock.calls).toEqual([[null]]);
  });

  it("a failed read: the box is a plain typing box (no list), and no message is shown", async () => {
    const m = mount(true);
    m.answer.reject(new ApiError("Forbidden", 403));
    await flush();
    expect(m.setStepSuggestions.mock.calls).toEqual([[null], [null]]);
    expect(m.setError).not.toHaveBeenCalled();
  });

  it.each(["answer", "failure"] as const)("an %s that lands after the effect was cleaned up sets nothing (the stale-load discipline)", async (outcome) => {
    const m = mount(true);
    m.cleanup?.();
    if (outcome === "answer") m.answer.resolve({ byOrderLine: {}, others: [] });
    else m.answer.reject(new Error("network"));
    await flush();
    // Only the run's own clearing, made before the cleanup.
    expect(m.setStepSuggestions.mock.calls).toEqual([[null]]);
    expect(m.setError).not.toHaveBeenCalled();
  });
});
