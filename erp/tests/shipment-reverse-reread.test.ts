import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/fetcher";
import { createNavigationAttempts } from "@/lib/navigation-attempts";
import type { DiscardIntent } from "@/lib/draft-navigation";
import { callback } from "./helpers/lift-callback";
import { openScalarDraft } from "./helpers/draft-store";

// #581, owner ruling 2026-10-19 ("Yes, re-read", the #568 hub shape): when the saved shipment's
// Reverse finishes after its departure was cancelled (another caller captured or invalidated the one
// navigation attempt while the POST was out), the page tells History and reads the shipment again,
// on a success and on a failure (the reversal may have committed either way); a reversal that
// committed then shows the original frozen as a pair with Reverse closed, and one that was refused
// shows the shipment as it was. A request that is no longer this page's own (the page unmounted,
// the owner changed, a newer Reverse of the same page out) reads nothing, as before. The page stays
// busy until that re-read settles, and only then clears busy, and only while the request is still
// its own: busy cleared first would enable Reverse over the pre-reversal state, and a click there,
// once the reversal had committed, is refused 400. Unlike the hub's list read, this page's `load`
// rejects on a failed GET, so the re-read carries a rejection handler that sets the owner's
// sentence (owner ruling 2026-10-19, the plan's amendment 2,
// docs/execution/2026-10-19-581-reverse-reread/plan.md) while the request is its own; a failure
// whose re-read succeeds sets no message. vitest has no DOM, so the page's own `reverseAction` is
// lifted out of its source (helpers/lift-callback) and run over the real navigation-attempts
// holder, in tests/navigation-caller-busy.test.ts's fixture shape with a recording `load` and
// `invalidateHistory`. One log takes every call the handler makes, in order, so a case's one
// `toEqual` says what ran, in which order, and what did not; `flush` lets the re-read's own
// continuations run first.

const PAGE = "app/shipping/[id]/ShipmentDetail.tsx";
const REFUSED = "This shipment has already been reversed by Packing List 43 — void that reversal first";
const AFTER_SUCCESS = "Shipment reversed, but the page could not be refreshed — reload to see the current state. (boom)";
const AFTER_FAILURE = "refused — and the page could not be refreshed (boom). Reload to see the current state.";

type Answer = { shipper: { id: string } };
type Deferred = { promise: Promise<Answer>; resolve: (value: Answer) => void; reject: (error: Error) => void };
function deferred(): Deferred {
  let resolve!: Deferred["resolve"]; let reject!: Deferred["reject"];
  const promise = new Promise<Answer>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** The page's Reverse for shipment s1, with one draft open. `answers[n]` settles the n-th POST. */
function page() {
  const h = openScalarDraft(); h.binding.change(() => ({ value: "original raw" }));
  const owner = h.store.getSnapshot().owner!; const stamps = h.store.stampsForPath("/shipping/s1");
  const intents = { prepare: vi.fn((_intent: DiscardIntent) => { void _intent; }), attach: vi.fn((_id: string, _href: string) => { void _id; void _href; }), consume: vi.fn(() => []), invalidate: vi.fn() };
  const holder = createNavigationAttempts(intents); const log: string[] = [];
  const navigationLifetime: { current: { live: boolean; request?: object } } = { current: { live: true } };
  const captureDiscardNavigation = vi.fn((isLive: () => boolean) => {
    log.push("capture"); const a = holder.capture({ owner: h.store.getSnapshot().owner!, stamps: h.store.stampsForPath("/shipping/s1") });
    const live = () => { const snapshot = h.store.getSnapshot(); return isLive() && snapshot.identityReady && snapshot.owner?.userId === owner.userId && snapshot.owner.authGeneration === owner.authGeneration && a.isCurrent(); };
    return { isCurrent: live, attach: (href: string) => live() && a.attach(href), cancel: a.cancel };
  });
  const answers: Deferred[] = [];
  const api = vi.fn(() => { log.push("POST"); const answer = deferred(); answers.push(answer); return answer.promise; });
  const router = { push: vi.fn((href: string) => { log.push(`push ${href}`); }) };
  // The two questions through the modal (PR 4), logged under their old names.
  const askDiscard = vi.fn(async () => { log.push("confirm"); return true; });
  const askReason = vi.fn(async (): Promise<string | null> => { log.push("prompt"); return "reason"; });
  const setReversing = vi.fn((value: boolean) => { log.push(`reversing ${value}`); });
  const setError = vi.fn((message: string | null) => { log.push(`error ${message}`); });
  const load = vi.fn(async () => { log.push("load"); });
  const invalidateHistory = vi.fn(() => { log.push("history"); });
  const run = callback<() => Promise<void>>(PAGE, "ShipmentDetail", "reverseAction", {
    api, router, askDiscard, askReason, setError, setReversing, load, invalidateHistory, id: "s1", shipper: { shipperNumber: 42 },
    peekBrowserDraftSession: () => ({ store: h.store }), captureDiscardNavigation, navigationLifetime,
  });
  return { ...h, owner, stamps, intents, holder, log, navigationLifetime, answers, router, setError, load, invalidateHistory, run };
}

/** The page with its re-read held: `load` logs, then waits for `release` or `fail`. */
function held() {
  const s = page(); let release!: () => void; let fail!: (error: Error) => void;
  s.load.mockImplementationOnce(() => { s.log.push("load"); return new Promise<void>((yes, no) => { release = yes; fail = no; }); });
  return { ...s, release: () => release(), fail: (error: Error) => fail(error) };
}

/** What one run logs up to its POST, the answer still out. */
const SENT = ["capture", "confirm", "prompt", "reversing true", "POST"];
/** What a cancelled departure logs once its answer lands, the re-read out. */
const REREAD = [...SENT, "history", "error null", "load"];

/** Lets every pending promise reaction and timer run; after `run()` it also drains the two modal
 *  answers (the discard question and the reason, PR 4) that precede the POST. */
const flush = () => new Promise((done) => setTimeout(done, 0));

type Settle = (answer: Deferred) => void;
const succeed: Settle = (answer) => answer.resolve({ shipper: { id: "reversed" } });
const refuse: Settle = (answer) => answer.reject(new ApiError(REFUSED, 400));
const drop: Settle = (answer) => answer.reject(new TypeError("Failed to fetch"));

describe("shipment Reverse: a Reverse whose departure was cancelled reads the shipment again (#581)", () => {
  it("a cancelled departure, then success: History is told, the shipment is read once, then busy clears; no push, no message", async () => {
    const s = page(); const pending = s.run(); await flush();
    const shell = s.holder.capture({ owner: s.owner, stamps: s.stamps });
    succeed(s.answers[0]); await pending; await flush();
    expect(s.log).toEqual([...REREAD, "reversing false"]);
    expect(s.load).toHaveBeenCalledExactlyOnceWith(); expect(s.invalidateHistory).toHaveBeenCalledOnce();
    expect(s.setError.mock.calls).toEqual([[null]]);
    expect(s.intents.prepare).not.toHaveBeenCalled(); expect(shell.isCurrent()).toBe(true);
  });

  it.each([["an ApiError 400", refuse], ["a dropped connection", drop]] as const)(
    "a cancelled departure, then %s: History is told, the shipment is read once, then busy clears; the request's message is never set",
    async (_name, settle) => {
      const s = page(); const pending = s.run(); await flush();
      const shell = s.holder.capture({ owner: s.owner, stamps: s.stamps });
      settle(s.answers[0]); await pending; await flush();
      expect(s.log).toEqual([...REREAD, "reversing false"]);
      expect(s.load).toHaveBeenCalledExactlyOnceWith(); expect(s.invalidateHistory).toHaveBeenCalledOnce();
      expect(s.setError.mock.calls).toEqual([[null]]); expect(shell.isCurrent()).toBe(true);
    },
  );

  it("a current attempt's success goes to the reversal and reads nothing", async () => {
    const s = page(); const pending = s.run(); await flush();
    succeed(s.answers[0]); await pending; await flush();
    expect(s.log).toEqual([...SENT, "reversing false", "error null", "push /shipping/reversed"]);
    expect(s.load).not.toHaveBeenCalled(); expect(s.invalidateHistory).not.toHaveBeenCalled();
  });

  it("a current attempt's failure shows its message and reads nothing", async () => {
    const s = page(); const pending = s.run(); await flush();
    refuse(s.answers[0]); await pending; await flush();
    expect(s.log).toEqual([...SENT, "reversing false", `error ${REFUSED}`]);
    expect(s.load).not.toHaveBeenCalled(); expect(s.invalidateHistory).not.toHaveBeenCalled();
    expect(s.router.push).not.toHaveBeenCalled();
  });
});

describe.each([["success", succeed], ["an ApiError 400", refuse]] as const)(
  "shipment Reverse: a cancelled departure, then %s: busy holds until the re-read settles (#581)",
  (_name, settle) => {
    it("busy stays set while the re-read is out, and clears when it lands", async () => {
      const s = held(); const pending = s.run(); await flush();
      s.holder.capture({ owner: s.owner, stamps: s.stamps });
      settle(s.answers[0]); await pending; await flush();
      expect(s.log).toEqual(REREAD);
      s.release(); await flush();
      expect(s.log).toEqual([...REREAD, "reversing false"]);
    });

    it("an instance unmounted while the re-read is out never clears busy", async () => {
      const s = held(); const pending = s.run(); await flush();
      s.holder.capture({ owner: s.owner, stamps: s.stamps });
      settle(s.answers[0]); await pending; await flush();
      s.navigationLifetime.current.live = false; s.navigationLifetime.current = { live: true };
      s.release(); await flush();
      expect(s.log).toEqual(REREAD);
    });

    it("an owner changed while the re-read is out never clears busy", async () => {
      const s = held(); const pending = s.run(); await flush();
      s.holder.capture({ owner: s.owner, stamps: s.stamps });
      settle(s.answers[0]); await pending; await flush();
      s.store.resetIdentity(); s.store.acceptIdentity(s.store.beginIdentityCheck(), "u2");
      s.release(); await flush();
      expect(s.log).toEqual(REREAD);
    });
  },
);

describe.each([
  ["success", succeed, AFTER_SUCCESS],
  ["an ApiError 400", (answer: Deferred) => answer.reject(new ApiError("refused", 400)), AFTER_FAILURE],
] as const)(
  "shipment Reverse: a cancelled departure, then %s, whose re-read fails: the owner's sentence, then busy clears (#581)",
  (_name, settle, sentence) => {
    it("the sentence names the read's failure, and busy clears after it", async () => {
      const s = held(); const pending = s.run(); await flush();
      s.holder.capture({ owner: s.owner, stamps: s.stamps });
      settle(s.answers[0]); await pending; await flush();
      expect(s.log).toEqual(REREAD);
      s.fail(new Error("boom")); await flush();
      expect(s.log).toEqual([...REREAD, `error ${sentence}`, "reversing false"]);
      expect(s.router.push).not.toHaveBeenCalled();
    });

    it("an instance unmounted while the re-read is out sets nothing", async () => {
      const s = held(); const pending = s.run(); await flush();
      s.holder.capture({ owner: s.owner, stamps: s.stamps });
      settle(s.answers[0]); await pending; await flush();
      s.navigationLifetime.current.live = false; s.navigationLifetime.current = { live: true };
      s.fail(new Error("boom")); await flush();
      expect(s.log).toEqual(REREAD);
    });

    it("an owner changed while the re-read is out sets nothing", async () => {
      const s = held(); const pending = s.run(); await flush();
      s.holder.capture({ owner: s.owner, stamps: s.stamps });
      settle(s.answers[0]); await pending; await flush();
      s.store.resetIdentity(); s.store.acceptIdentity(s.store.beginIdentityCheck(), "u2");
      s.fail(new Error("boom")); await flush();
      expect(s.log).toEqual(REREAD);
    });

    it("a newer Reverse sent while the re-read is out sets nothing and clears no busy", async () => {
      const s = held(); const first = s.run(); await flush();
      s.holder.capture({ owner: s.owner, stamps: s.stamps });
      settle(s.answers[0]); await first; await flush();
      expect(s.log).toEqual(REREAD);
      // The newer request replaces `token.request`; its own answer stays out.
      void s.run(); await flush(); expect(s.log).toEqual([...REREAD, ...SENT]);
      s.fail(new Error("boom")); await flush();
      expect(s.log).toEqual([...REREAD, ...SENT]);
      // The newer request is undisturbed: its own answer goes on to the reversal.
      s.answers[1].resolve({ shipper: { id: "second" } }); await flush();
      expect(s.log).toEqual([...REREAD, ...SENT, "reversing false", "error null", "push /shipping/second"]);
    });
  },
);

describe.each([["success", succeed], ["an ApiError 400", refuse]] as const)(
  "shipment Reverse: %s for a request no longer the page's own reads nothing (#581)",
  (_name, settle) => {
    it("an unmounted instance", async () => {
      const s = page(); const pending = s.run(); await flush();
      s.navigationLifetime.current.live = false; s.navigationLifetime.current = { live: true };
      settle(s.answers[0]); await pending; await flush();
      expect(s.log).toEqual(SENT); expect(s.load).not.toHaveBeenCalled(); expect(s.invalidateHistory).not.toHaveBeenCalled();
    });

    it("a changed owner", async () => {
      const s = page(); const pending = s.run(); await flush();
      s.store.resetIdentity(); s.store.acceptIdentity(s.store.beginIdentityCheck(), "u2");
      settle(s.answers[0]); await pending; await flush();
      expect(s.log).toEqual(SENT); expect(s.load).not.toHaveBeenCalled(); expect(s.invalidateHistory).not.toHaveBeenCalled();
    });

    it("an older request of the same page, the newer one then landing on its current attempt", async () => {
      const s = page(); const first = s.run(); await flush(); const second = s.run(); await flush();
      expect(s.log).toEqual([...SENT, ...SENT]);
      settle(s.answers[0]); await first; await flush();
      expect(s.log).toEqual([...SENT, ...SENT]);
      s.answers[1].resolve({ shipper: { id: "second" } }); await second; await flush();
      expect(s.log).toEqual([...SENT, ...SENT, "reversing false", "error null", "push /shipping/second"]);
      expect(s.load).not.toHaveBeenCalled(); expect(s.invalidateHistory).not.toHaveBeenCalled();
    });
  },
);
