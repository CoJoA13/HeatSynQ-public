import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/fetcher";
import { createNavigationAttempts } from "@/lib/navigation-attempts";
import type { DiscardIntent } from "@/lib/draft-navigation";
import { callback } from "./helpers/lift-callback";
import { openScalarDraft } from "./helpers/draft-store";

// #568, owner ruling 2026-10-19 ("Hub re-reads"): when the hub's Create invoice finishes after its
// departure was cancelled (another caller captured or invalidated the one navigation attempt while
// the POST was out), the Invoices section reads its list again, so an invoice it created is listed
// and Create closes. A request that is no longer this section's own (the section unmounted, the
// owner changed, a newer Create of the same section out) reads nothing, as before. The section stays
// busy until that re-read lands, and only then clears busy, and only while the request is still its
// own (the #568 review's fix wave): busy cleared first would open Create over the rows read before
// the create, and a click there, once the create had committed, is refused 400. vitest has no DOM,
// so the section's own `createInvoice` is lifted out of its source (helpers/lift-callback) and run
// over the real navigation-attempts holder, in tests/navigation-callers.test.ts's fixture shape with
// a recording `load` that resolves (the section's `load` never rejects: its read's failure is its
// own message). One log takes every call the handler makes, in order, so a case's one `toEqual` says
// what ran, in which order, and what did not; `flush` lets the re-read's own continuation run first.

const SECTION = "app/orders/[id]/InvoicesSection.tsx";
const REFUSED = "Order #7 already has an invoice — discard its draft or credit the finalized one";

type Answer = { invoice: { id: string } };
type Deferred = { promise: Promise<Answer>; resolve: (value: Answer) => void; reject: (error: Error) => void };
function deferred(): Deferred {
  let resolve!: Deferred["resolve"]; let reject!: Deferred["reject"];
  const promise = new Promise<Answer>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** The section's Create invoice for order o1, with one draft open. `answers[n]` settles the n-th
 *  POST. */
function section() {
  const h = openScalarDraft(); h.binding.change(() => ({ value: "original raw" }));
  const owner = h.store.getSnapshot().owner!; const stamps = h.store.stampsForPath("/orders/o1");
  const intents = { prepare: vi.fn((_intent: DiscardIntent) => { void _intent; }), attach: vi.fn((_id: string, _href: string) => { void _id; void _href; }), consume: vi.fn(() => []), invalidate: vi.fn() };
  const holder = createNavigationAttempts(intents); const log: string[] = [];
  const navigationLifetime: { current: { live: boolean; request?: object } } = { current: { live: true } };
  const captureDiscardNavigation = vi.fn((isLive: () => boolean) => {
    log.push("capture"); const a = holder.capture({ owner: h.store.getSnapshot().owner!, stamps: h.store.stampsForPath("/orders/o1") });
    const live = () => { const snapshot = h.store.getSnapshot(); return isLive() && snapshot.identityReady && snapshot.owner?.userId === owner.userId && snapshot.owner.authGeneration === owner.authGeneration && a.isCurrent(); };
    return { isCurrent: live, attach: (href: string) => live() && a.attach(href), cancel: a.cancel };
  });
  const answers: Deferred[] = [];
  const api = vi.fn(() => { log.push("POST"); const answer = deferred(); answers.push(answer); return answer.promise; });
  const router = { push: vi.fn((href: string) => { log.push(`push ${href}`); }) };
  const askDiscard = vi.fn(async () => { log.push("confirm"); return true; });
  const setCreating = vi.fn((value: boolean) => { log.push(`creating ${value}`); });
  const setError = vi.fn((message: string | null) => { log.push(`error ${message}`); });
  const load = vi.fn(async () => { log.push("load"); });
  const run = callback<() => Promise<void>>(SECTION, "InvoicesSection", "createInvoice", {
    api, router, askDiscard, setError, setCreating, load, orderId: "o1",
    peekBrowserDraftSession: () => ({ store: h.store }), captureDiscardNavigation, navigationLifetime,
  });
  return { ...h, owner, stamps, intents, holder, log, navigationLifetime, answers, router, askDiscard, setError, load, run };
}

/** What one run logs up to its POST, the answer still out. */
const SENT = ["capture", "confirm", "creating true", "POST"];

/** Lets every pending promise reaction and timer run. */
const flush = () => new Promise((done) => setTimeout(done, 0));

type Settle = (answer: Deferred) => void;
const succeed: Settle = (answer) => answer.resolve({ invoice: { id: "created" } });
const refuse: Settle = (answer) => answer.reject(new ApiError(REFUSED, 400));
const drop: Settle = (answer) => answer.reject(new TypeError("Failed to fetch"));

describe("hub Create invoice: a Create whose departure was cancelled reads the Invoices list again (#568)", () => {
  it("a cancelled departure, then success: the list is read once, then busy clears; no push, no message", async () => {
    const s = section(); const pending = s.run(); await flush();
    const shell = s.holder.capture({ owner: s.owner, stamps: s.stamps });
    succeed(s.answers[0]); await pending; await flush();
    expect(s.log).toEqual([...SENT, "load", "creating false"]);
    expect(s.load).toHaveBeenCalledExactlyOnceWith();
    expect(s.intents.prepare).not.toHaveBeenCalled(); expect(shell.isCurrent()).toBe(true);
  });

  it.each([["an ApiError 400", refuse], ["a dropped connection", drop]] as const)(
    "a cancelled departure, then %s: the list is read once, then busy clears; the create's message is not shown",
    async (_name, settle) => {
      const s = section(); const pending = s.run(); await flush();
      const shell = s.holder.capture({ owner: s.owner, stamps: s.stamps });
      settle(s.answers[0]); await pending; await flush();
      expect(s.log).toEqual([...SENT, "load", "creating false"]);
      expect(s.load).toHaveBeenCalledExactlyOnceWith();
      expect(s.setError).not.toHaveBeenCalled(); expect(shell.isCurrent()).toBe(true);
    },
  );

  it("a current attempt's success goes to the invoice and reads nothing", async () => {
    const s = section(); const pending = s.run(); await flush();
    succeed(s.answers[0]); await pending; await flush();
    expect(s.log).toEqual([...SENT, "creating false", "push /invoicing/created"]);
    expect(s.load).not.toHaveBeenCalled();
  });

  it("a current attempt's failure shows its message and reads nothing", async () => {
    const s = section(); const pending = s.run(); await flush();
    refuse(s.answers[0]); await pending; await flush();
    expect(s.log).toEqual([...SENT, "creating false", `error ${REFUSED}`]);
    expect(s.load).not.toHaveBeenCalled(); expect(s.router.push).not.toHaveBeenCalled();
  });
});

// Ruling 5: the question is the modal's now, so its answer lands a tick later, and the page keeps
// running under it. `asked()` holds the answer until the case gives it.
describe("hub Create invoice: the discard question through the modal (ruling 5)", () => {
  function asked() {
    const s = section(); let answer!: (yes: boolean) => void;
    s.askDiscard.mockImplementationOnce(() => { s.log.push("confirm"); return new Promise<boolean>((done) => { answer = done; }); });
    return { ...s, pending: s.run(), answer: (yes: boolean) => answer(yes) };
  }

  it("sends nothing until the answer, and asks with no action: this one leaves the page", async () => {
    const s = asked(); await flush();
    expect(s.log).toEqual(["capture", "confirm"]);
    expect(s.askDiscard).toHaveBeenCalledExactlyOnceWith();
    s.answer(true); await flush();
    expect(s.log).toEqual(SENT);
    succeed(s.answers[0]); await s.pending;
    expect(s.log).toEqual([...SENT, "creating false", "push /invoicing/created"]);
  });

  it("a declined ask sends nothing and gives up the departure, so the next caller finds none", async () => {
    const s = asked(); await flush();
    expect(s.intents.invalidate).toHaveBeenCalledExactlyOnceWith(); // the capture's own
    s.answer(false); await s.pending;
    expect(s.log).toEqual(["capture", "confirm"]);
    expect(s.intents.invalidate).toHaveBeenLastCalledWith("navigation-1");
  });

  it("a departure superseded under the question sends nothing on a yes", async () => {
    const s = asked(); await flush();
    const shell = s.holder.capture({ owner: s.owner, stamps: s.stamps });
    s.answer(true); await flush();
    expect(s.log).toEqual(["capture", "confirm"]);
    await s.pending;
    expect(shell.isCurrent()).toBe(true);
  });

  it.each([
    ["the section unmounted", (s: ReturnType<typeof asked>) => { s.navigationLifetime.current.live = false; s.navigationLifetime.current = { live: true }; }],
    ["the owner changed", (s: ReturnType<typeof asked>) => { s.store.resetIdentity(); s.store.acceptIdentity(s.store.beginIdentityCheck(), "u2"); }],
    ["a newer Create took the request", (s: ReturnType<typeof asked>) => { s.navigationLifetime.current.request = {}; }],
  ])("%s under the question sends nothing on a yes", async (_name, happen) => {
    const s = asked(); await flush();
    happen(s);
    s.answer(true); await flush();
    expect(s.log).toEqual(["capture", "confirm"]);
    await s.pending;
  });
});

describe.each([["success", succeed], ["an ApiError 400", refuse]] as const)(
  "hub Create invoice: a cancelled departure, then %s: busy holds until the re-read lands (#568)",
  (_name, settle) => {
    /** The section with its re-read held: `load` logs, then waits for `release`. */
    function held() {
      const s = section(); let release!: () => void;
      s.load.mockImplementationOnce(async () => { s.log.push("load"); await new Promise<void>((done) => { release = done; }); });
      return { ...s, release: () => release() };
    }

    it("busy stays set while the re-read is out, and clears when it lands", async () => {
      const s = held(); const pending = s.run(); await flush();
      s.holder.capture({ owner: s.owner, stamps: s.stamps });
      settle(s.answers[0]); await pending; await flush();
      expect(s.log).toEqual([...SENT, "load"]);
      s.release(); await flush();
      expect(s.log).toEqual([...SENT, "load", "creating false"]);
    });

    it("an instance unmounted while the re-read is out never clears busy", async () => {
      const s = held(); const pending = s.run(); await flush();
      s.holder.capture({ owner: s.owner, stamps: s.stamps });
      settle(s.answers[0]); await pending; await flush();
      s.navigationLifetime.current.live = false; s.navigationLifetime.current = { live: true };
      s.release(); await flush();
      expect(s.log).toEqual([...SENT, "load"]);
    });

    it("an owner changed while the re-read is out never clears busy", async () => {
      const s = held(); const pending = s.run(); await flush();
      s.holder.capture({ owner: s.owner, stamps: s.stamps });
      settle(s.answers[0]); await pending; await flush();
      s.store.resetIdentity(); s.store.acceptIdentity(s.store.beginIdentityCheck(), "u2");
      s.release(); await flush();
      expect(s.log).toEqual([...SENT, "load"]);
    });
  },
);

describe.each([["success", succeed], ["an ApiError 400", refuse]] as const)(
  "hub Create invoice: %s for a request no longer the section's own reads nothing (#568)",
  (_name, settle) => {
    it("an unmounted instance", async () => {
      const s = section(); const pending = s.run(); await flush();
      s.navigationLifetime.current.live = false; s.navigationLifetime.current = { live: true };
      settle(s.answers[0]); await pending;
      expect(s.log).toEqual(SENT); expect(s.load).not.toHaveBeenCalled();
    });

    it("a changed owner", async () => {
      const s = section(); const pending = s.run(); await flush();
      s.store.resetIdentity(); s.store.acceptIdentity(s.store.beginIdentityCheck(), "u2");
      settle(s.answers[0]); await pending;
      expect(s.log).toEqual(SENT); expect(s.load).not.toHaveBeenCalled();
    });

    it("an older request of the same component, the newer one then landing on its current attempt", async () => {
      const s = section(); const first = s.run(); await flush(); const second = s.run(); await flush();
      expect(s.log).toEqual([...SENT, ...SENT]);
      settle(s.answers[0]); await first;
      expect(s.log).toEqual([...SENT, ...SENT]);
      s.answers[1].resolve({ invoice: { id: "second" } }); await second;
      expect(s.log).toEqual([...SENT, ...SENT, "creating false", "push /invoicing/second"]);
      expect(s.load).not.toHaveBeenCalled();
    });
  },
);
