import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyFailure, retryRefusal } from "../e2e/lib/failure-classify.mjs";
import { clickOpensNewTab, newTabVerdict, openSession, within } from "../e2e/lib/new-tab.mjs";

// #345: clickOpensNewTab (e2e/lib/new-tab.mjs) confirms a board Ctrl+click through the browser's
// target list instead of Playwright's context page event. The first block pins its pure decision,
// newTabVerdict. The rest drive the real helper against a stub page and stub CDP sessions under fake
// timers, so every guard in it runs without a browser. Each case pins one guard; the implementer
// report records the mutation that reds each one.

const CONTEXT = "context-board";
const TITLE = "HeatSynQ";
const BOARD_URL = "http://localhost:3100/";
const ORDER_URL = "http://localhost:3100/orders/order-1";
const PENDING_TITLE = "localhost:3100/orders/order-1";
const PATH = /^\/orders\/order-1$/;
// Any recorded request failure: classifyFailure calls a code-less error "network" once one exists.
const NET_FAILURE = [{ at: 0, line: "GET /api/orders — net::ERR_NETWORK_CHANGED" }];

type TabTarget = {
  targetId: string;
  type: string;
  url: string;
  title: string;
  browserContextId?: string;
  subtype?: string;
};

function target(overrides: Partial<TabTarget> = {}): TabTarget {
  return { targetId: "new-tab", type: "page", url: ORDER_URL, title: TITLE, browserContextId: CONTEXT, ...overrides };
}

const BOARD = target({ targetId: "board-tab", url: BOARD_URL });

function verdict(targets: TabTarget[], before: Iterable<string> = [BOARD.targetId]) {
  return newTabVerdict({ targets, before: new Set(before), contextId: CONTEXT, pathPattern: PATH, title: TITLE });
}

const ids = (targets: TabTarget[]) => targets.map((t) => t.targetId);

describe("newTabVerdict (#345)", () => {
  it("matches exactly one new page tab that has committed the app document at the expected path", () => {
    const result = verdict([BOARD, target()]);
    expect(result.match?.targetId).toBe("new-tab");
    expect(ids(result.fresh)).toEqual(["new-tab"]);
    expect(ids(result.opened)).toEqual(["new-tab"]);
  });

  it("never counts a tab that already existed before the click", () => {
    const result = verdict([BOARD, target({ targetId: "older-tab" })], [BOARD.targetId, "older-tab"]);
    expect(result.match).toBeNull();
    expect(result.fresh).toEqual([]);
  });

  it("never counts a tab in another browser context", () => {
    const result = verdict([BOARD, target({ browserContextId: "context-other" })]);
    expect(result.match).toBeNull();
    expect(result.fresh).toEqual([]);
  });

  it("never counts a target that is not a page", () => {
    const result = verdict([BOARD, target({ type: "iframe" })]);
    expect(result.match).toBeNull();
    expect(result.fresh).toEqual([]);
  });

  it("does not match a prerender target, but still lists it for closing", () => {
    const result = verdict([BOARD, target({ subtype: "prerender" })]);
    expect(result.match).toBeNull();
    expect(ids(result.fresh)).toEqual(["new-tab"]);
    expect(result.opened).toEqual([]);
  });

  it("does not count a prerender target as a second tab beside the real one", () => {
    const result = verdict([BOARD, target({ targetId: "prerendered", subtype: "prerender" }), target()]);
    expect(result.match?.targetId).toBe("new-tab");
    expect(ids(result.fresh)).toEqual(["prerendered", "new-tab"]);
    expect(ids(result.opened)).toEqual(["new-tab"]);
  });

  it("does not match a pending URL whose title is still the URL (no document has committed)", () => {
    const result = verdict([BOARD, target({ title: PENDING_TITLE })]);
    expect(result.match).toBeNull();
    expect(ids(result.fresh)).toEqual(["new-tab"]);
  });

  it("does not match a committed tab at the wrong path, and says no tab committed that document", () => {
    const result = verdict([BOARD, target({ url: "http://localhost:3100/orders/order-2" })]);
    expect(result.match).toBeNull();
    expect(ids(result.fresh)).toEqual(["new-tab"]);
    // One new tab that does not match is not "more than one tab": the message must not say so.
    expect(result.description).toMatch(
      /^expected a new tab at .* titled "HeatSynQ", and no new tab has committed that document; new page targets: /);
  });

  it("fails on two matching new tabs rather than picking one", () => {
    const result = verdict([BOARD, target({ targetId: "first" }), target({ targetId: "second" })]);
    expect(result.match).toBeNull();
    expect(ids(result.fresh)).toEqual(["first", "second"]);
    expect(result.description).toMatch(/^2 new tabs are open \(2 of them at that document\)/);
  });

  it("fails on one committed tab beside a second new tab that has not committed yet", () => {
    const result = verdict([BOARD, target({ targetId: "first" }), target({ targetId: "second", title: PENDING_TITLE })]);
    expect(result.match).toBeNull();
    expect(ids(result.opened)).toEqual(["first", "second"]);
    expect(result.description).toMatch(/^2 new tabs are open \(1 of them at that document\)/);
  });

  it("fails on one committed tab beside a second new tab at another URL", () => {
    const other = target({ targetId: "second", url: "http://localhost:3100/orders/order-2" });
    const result = verdict([BOARD, target({ targetId: "first" }), other]);
    expect(result.match).toBeNull();
    expect(result.description).toMatch(/^2 new tabs are open \(1 of them at that document\)/);
  });

  it("skips an unparseable URL without failing", () => {
    for (const url of ["", "not a url"]) {
      const result = verdict([BOARD, target({ url })]);
      expect(result.match, JSON.stringify(url)).toBeNull();
      expect(ids(result.fresh)).toEqual(["new-tab"]);
      expect(result.description).toContain(`${JSON.stringify(url)} titled "HeatSynQ"`);
    }
  });

  it("describes every new page target by URL and title for the failure message", () => {
    const pending = verdict([BOARD, target({ title: ORDER_URL }), target({ targetId: "prerendered", subtype: "prerender" })]);
    expect(pending.description).toContain(`expected a new tab at ${PATH} titled "HeatSynQ"`);
    expect(pending.description).toContain(`"${ORDER_URL}" titled "${ORDER_URL}"`);
    expect(pending.description).toContain(`"${ORDER_URL}" titled "HeatSynQ" (prerender)`);
    expect(verdict([BOARD]).description).toMatch(/new page targets: none$/);
  });
});

type AssertionLike = Error & { code?: string; cause?: unknown };
type Session = { send: (method: string, params?: { targetId?: string }) => Promise<unknown>; detach: () => Promise<void> };

afterEach(() => vi.useRealTimers());

/** Collects the unhandled rejections Node reports while `body` runs, on real timers. Node reports one
 *  once the microtasks of the task that caused it have drained, so two macrotasks are waited out. */
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

describe("within and openSession (#345)", () => {
  it("turns a call that never finishes into an assertion failure naming the call", async () => {
    vi.useFakeTimers();
    const pending = within(new Promise(() => {}), "the browser's Target.getTargets", 20).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20);
    const error = (await pending) as AssertionLike;
    expect(error.code).toBe("ERR_ASSERTION");
    expect(error.message).toBe("the browser's Target.getTargets did not finish within 20 ms");
    expect(classifyFailure(error, NET_FAILURE)).toBe("assertion");
  });

  it("turns a rejected browser call into an assertion failure that keeps the browser's error", async () => {
    const cause = new Error("Protocol error (Target.getTargets): Target page, context or browser has been closed");
    const error = (await within(Promise.reject(cause), "the browser's Target.getTargets")
      .catch((failure: unknown) => failure)) as AssertionLike;
    expect(error.code).toBe("ERR_ASSERTION");
    expect(error.message).toBe(`the browser's Target.getTargets failed: ${cause.message}`);
    expect(error.cause).toBe(cause);
    // The claim the helper's header makes: such a failure is never retried as a network one.
    expect(classifyFailure(error, NET_FAILURE)).toBe("assertion");
    expect(classifyFailure(cause, NET_FAILURE)).toBe("network");
    expect(retryRefusal({ kind: classifyFailure(error, NET_FAILURE), committed: 0, indeterminate: 0 })).not.toBeNull();
  });

  it("passes a call's answer through and leaves no timer behind", async () => {
    vi.useFakeTimers();
    await expect(within(Promise.resolve(7), "a call")).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("detaches a session that attaches only after its bound expired", async () => {
    vi.useFakeTimers();
    let attach: (session: { detach: () => Promise<void> }) => void = () => {};
    const opening = new Promise<{ detach: () => Promise<void> }>((resolve) => { attach = resolve; });
    const pending = openSession(opening, "opening a browser-level CDP session", 20).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20);
    expect(((await pending) as AssertionLike).message).toBe("opening a browser-level CDP session did not finish within 20 ms");
    let detached = false;
    attach({ detach: async () => { detached = true; } });
    await vi.advanceTimersByTimeAsync(0);
    expect(detached).toBe(true);
  });

  // run.mjs turns any unhandled rejection into a fatal cancellation of the whole E2E run, so each
  // way a session open can fail must leave every promise it derives from the opening handled.
  it("reports an open that rejects before its bound, leaving no unhandled rejection", async () => {
    const cause = new Error("Target page, context or browser has been closed");
    let error: AssertionLike | undefined;
    const unhandled = await unhandledDuring(async () => {
      error = (await openSession(Promise.reject(cause), "opening a browser-level CDP session", 20)
        .catch((failure: unknown) => failure)) as AssertionLike;
    });
    expect(error?.code).toBe("ERR_ASSERTION");
    expect(error?.message).toBe(`opening a browser-level CDP session failed: ${cause.message}`);
    expect(error?.cause).toBe(cause);
    expect(unhandled).toEqual([]);
  });

  it("absorbs an open that rejects only after its bound expired", async () => {
    let fail: (error: Error) => void = () => {};
    const opening = new Promise<Session>((_, reject) => { fail = reject; });
    let error: AssertionLike | undefined;
    const unhandled = await unhandledDuring(async () => {
      error = (await openSession(opening, "opening a browser-level CDP session", 20)
        .catch((failure: unknown) => failure)) as AssertionLike;
      fail(new Error("Target page, context or browser has been closed"));
    });
    expect(error?.message).toBe("opening a browser-level CDP session did not finish within 20 ms");
    expect(unhandled).toEqual([]);
  });

  it("absorbs a failing detach of a session that attached only after its bound expired", async () => {
    let attach: (session: Session) => void = () => {};
    const opening = new Promise<Session>((resolve) => { attach = resolve; });
    let detachCalled = false;
    const unhandled = await unhandledDuring(async () => {
      await openSession(opening, "opening a browser-level CDP session", 20).catch(() => {});
      attach({
        send: async () => ({}),
        detach: async () => { detachCalled = true; throw new Error("Target page, context or browser has been closed"); },
      });
    });
    expect(detachCalled).toBe(true);
    expect(unhandled).toEqual([]);
  });
});

type Kind = "page" | "browser";
type Handler = (params: { targetId?: string } | undefined) => unknown;
type Frame = { url: () => string };

/** A stub board tab, its browser context and two CDP sessions. Everything the helper reaches is here. */
function tabWorld() {
  const targets: TabTarget[] = [{ ...BOARD }];
  const sent: string[] = [];
  let url = BOARD_URL;
  const mainFrame: Frame = { url: () => url };
  const page = Object.assign(new EventEmitter(), {
    url: () => url,
    title: (): Promise<string> => world.readTitle(),
    mainFrame: () => mainFrame,
    context: () => context,
  });
  const world = {
    targets,
    sent,
    /** Every targetId Target.closeTarget was sent for, in order. */
    closed: [] as string[],
    page,
    mainFrame,
    /** What Target.getTargetInfo reports for the board tab. */
    self: { ...BOARD } as TabTarget,
    /** The board tab's own document title, which page.title() answers by default. */
    boardTitle: TITLE,
    readTitle: async (): Promise<string> => world.boardTitle,
    hasBrowser: true,
    /** Whether Target.closeTarget removes a tab (for every tab, or per targetId), and after how long. */
    closeTakes: true as boolean | ((targetId: string | undefined) => boolean),
    closeDelayMs: 0,
    /** Runs at the start of every Target.getTargets, before the list is copied. */
    beforeList: () => {},
    detach: async (kind: Kind): Promise<void> => { void kind; },
    openPageSession: async (): Promise<Session> => session("page"),
    openBrowserSession: async (): Promise<Session> => session("browser"),
    handlers: {} as Record<string, Handler>,
    setUrl: (next: string) => { url = next; },
    ids: () => targets.map((t) => t.targetId),
  };
  const remove = (targetId?: string) => {
    const at = targets.findIndex((t) => t.targetId === targetId);
    if (at >= 0) targets.splice(at, 1);
  };
  world.handlers = {
    "Target.getTargetInfo": () => ({ targetInfo: { ...world.self } }),
    "Target.getTargets": () => {
      world.beforeList();
      return { targetInfos: targets.map((t) => ({ ...t })) };
    },
    "Target.closeTarget": (params) => {
      world.closed.push(String(params?.targetId));
      const takes = typeof world.closeTakes === "function" ? world.closeTakes(params?.targetId) : world.closeTakes;
      if (takes) {
        if (world.closeDelayMs > 0) setTimeout(() => remove(params?.targetId), world.closeDelayMs);
        else remove(params?.targetId);
      }
      return { success: true };
    },
  };
  const session = (kind: Kind): Session => ({
    async send(method: string, params?: { targetId?: string }) {
      sent.push(`${kind}:${method}`);
      const handler = world.handlers[method];
      return handler ? handler(params) : {};
    },
    async detach() {
      sent.push(`${kind}:detach`);
      await world.detach(kind);
    },
  });
  const context = {
    newCDPSession: async (of: unknown) => {
      if (of !== page) throw new TypeError("the page session must be opened on the board tab itself");
      return world.openPageSession();
    },
    browser: () => (world.hasBrowser ? { newBrowserCDPSession: () => world.openBrowserSession() } : null),
  };
  return world;
}

type World = ReturnType<typeof tabWorld>;

/** Runs the real helper to completion under fake timers. */
async function run(world: World, click: () => unknown, timeoutMs = 300) {
  vi.useFakeTimers();
  let settled = false;
  const outcome = clickOpensNewTab(world.page as never, async () => { await click(); }, { pathPattern: PATH, timeoutMs })
    .then(
      (value) => ({ value, error: undefined as AssertionLike | undefined }),
      (error: unknown) => ({ value: undefined, error: error as AssertionLike }),
    )
    .finally(() => { settled = true; });
  const startedAt = Date.now();
  for (let step = 0; step < 600 && !settled; step++) await vi.advanceTimersByTimeAsync(100);
  expect(settled, "the helper should settle within 60 s of fake time").toBe(true);
  return { ...(await outcome), elapsedMs: Date.now() - startedAt };
}

const opensTab = (world: World, tab: TabTarget = target()) => () => { world.targets.push(tab); };

describe("clickOpensNewTab (#345)", () => {
  it("confirms the new tab, closes it, and sends only the CDP methods it is allowed to", async () => {
    const world = tabWorld();
    world.closeDelayMs = 250;
    const { value, error } = await run(world, opensTab(world));
    expect(error).toBeUndefined();
    expect(value?.target.targetId).toBe("new-tab");
    expect(value?.matchedAt).toBeGreaterThan(0);
    expect(value?.newTargetIds).toEqual(["new-tab"]);
    expect(world.closed).toEqual(["new-tab"]);
    expect(world.ids()).toEqual(["board-tab"]);
    // The never-auto-attach rule: the page session only reads its own target info, and the browser
    // session only lists and closes targets. Any other method, auto-attach above all, reds this.
    expect([...new Set(world.sent)].sort()).toEqual([
      "browser:Target.closeTarget", "browser:Target.getTargets", "browser:detach",
      "page:Target.getTargetInfo", "page:detach",
    ]);
    expect(world.page.listenerCount("framenavigated")).toBe(0);
  });

  it("closes a prerender target too, without counting it as a second tab", async () => {
    const world = tabWorld();
    const { value, error } = await run(world, () => {
      world.targets.push(target({ targetId: "prerendered", subtype: "prerender" }), target());
    });
    expect(error).toBeUndefined();
    expect(value?.target.targetId).toBe("new-tab");
    expect(value?.newTargetIds).toEqual(["prerendered", "new-tab"]);
    expect(world.ids()).toEqual(["board-tab"]);
  });

  it("fails at its deadline when the click opens no tab, naming what it saw", async () => {
    const world = tabWorld();
    const { error } = await run(world, () => {});
    expect(error?.code).toBe("ERR_ASSERTION");
    expect(error?.message).toBe(`the click opened no confirmed new tab within 300 ms: expected a new tab at ${PATH} `
      + `titled "HeatSynQ", and no new tab has committed that document; new page targets: none`);
    expect(world.page.listenerCount("framenavigated")).toBe(0);
  });

  it("fails at its deadline on a tab that never commits, and still closes it", async () => {
    const world = tabWorld();
    const { error } = await run(world, opensTab(world, target({ title: PENDING_TITLE })));
    expect(error?.code).toBe("ERR_ASSERTION");
    // One tab that never committed is not "more than one tab": the message must not say so.
    expect(error?.message).toMatch(/^the click opened no confirmed new tab within 300 ms: expected a new tab at .* titled "HeatSynQ", and no new tab has committed that document; new page targets: /);
    expect(error?.message).toContain(`new page targets: "${ORDER_URL}" titled "${PENDING_TITLE}"`);
    expect(world.ids()).toEqual(["board-tab"]);
  });

  it("fails when the click opens a second tab beside the committed one", async () => {
    const world = tabWorld();
    const { error } = await run(world, () => {
      world.targets.push(target(), target({ targetId: "second-tab", title: PENDING_TITLE }));
    });
    expect(error?.message).toMatch(/^the click opened no confirmed new tab within 300 ms: 2 new tabs are open/);
    expect(world.ids()).toEqual(["board-tab"]);
  });

  it("fails when a second tab appears only after the match", async () => {
    const world = tabWorld();
    let listedMatch = false;
    let added = false;
    world.beforeList = () => {
      if (listedMatch && !added) {
        world.targets.push(target({ targetId: "late-tab", title: PENDING_TITLE }));
        added = true;
      }
      if (world.ids().includes("new-tab")) listedMatch = true;
    };
    const { error } = await run(world, opensTab(world));
    expect(error?.code).toBe("ERR_ASSERTION");
    // node:assert appends its own actual/expected diff to a deepEqual message, so match the prefix.
    expect(error?.message.startsWith(`the click should open exactly one new tab, but 2 appeared: "${ORDER_URL}" `
      + `titled "HeatSynQ"; "${ORDER_URL}" titled "${PENDING_TITLE}"`), error?.message).toBe(true);
    expect(world.ids()).toEqual(["board-tab"]);
  });

  it("fails when a second tab came and went before the match", async () => {
    const world = tabWorld();
    let polls = 0;
    world.beforeList = () => {
      if (!world.ids().includes("brief-tab")) return;
      polls += 1;
      if (polls < 2) return;
      world.targets.splice(world.ids().indexOf("brief-tab"), 1);
      world.targets.push(target());
    };
    const { error } = await run(world, opensTab(world, target({ targetId: "brief-tab", title: PENDING_TITLE })));
    expect(error?.message).toMatch(/^the click should open exactly one new tab, but 2 appeared: /);
  });

  it("fails when a closed tab never leaves the target list, after waiting for it", async () => {
    const world = tabWorld();
    world.closeTakes = false;
    const { error, elapsedMs } = await run(world, opensTab(world));
    expect(error?.code).toBe("ERR_ASSERTION");
    expect(error?.message).toMatch(/^every tab the click opened should be closed again after the check/);
    expect(elapsedMs).toBeGreaterThanOrEqual(5000);
  });

  it("fails when the board tab's main frame navigates, even back to the same URL", async () => {
    const world = tabWorld();
    const { error } = await run(world, () => {
      world.targets.push(target());
      world.page.emit("framenavigated", world.mainFrame);
    });
    expect(error?.message).toMatch(/^the board tab's main frame should not navigate while a modified click opens a new tab/);
  });

  it("ignores a navigation inside a sub-frame of the board tab", async () => {
    const world = tabWorld();
    const { error } = await run(world, () => {
      world.targets.push(target());
      world.page.emit("framenavigated", { url: () => "http://localhost:3100/embedded" } satisfies Frame);
    });
    expect(error).toBeUndefined();
  });

  it("fails when the board tab's URL changes", async () => {
    const world = tabWorld();
    const { error } = await run(world, () => {
      world.targets.push(target());
      world.setUrl(ORDER_URL);
    });
    expect(error?.message).toMatch(/^the board tab should keep its URL while a modified click opens a new tab/);
  });

  it("refuses before clicking when the target list does not include the board tab itself", async () => {
    const world = tabWorld();
    world.self = { ...BOARD, targetId: "unlisted-tab" };
    let clicked = false;
    const { error } = await run(world, () => { clicked = true; });
    expect(error?.message).toBe(
      "the browser's target list does not include the board tab itself, so its snapshot cannot be trusted");
    expect(clicked).toBe(false);
    expect(world.sent.filter((m) => m.endsWith(":detach")).sort()).toEqual(["browser:detach", "page:detach"]);
    expect(world.closed).toEqual([]);
  });

  it("refuses without listing or closing anything more when only the first listing leaves the board out", async () => {
    const world = tabWorld();
    let lists = 0;
    const list = world.handlers["Target.getTargets"];
    world.handlers["Target.getTargets"] = (params) => {
      lists += 1;
      return lists === 1 ? { targetInfos: [] } : list(params);
    };
    let clicked = false;
    const { error } = await run(world, () => { clicked = true; });
    expect(error?.message).toBe(
      "the browser's target list does not include the board tab itself, so its snapshot cannot be trusted");
    expect(clicked).toBe(false);
    // A rejected snapshot must not reach cleanup: judged against it, the board itself would look new.
    expect(world.sent).toEqual(["page:Target.getTargetInfo", "browser:Target.getTargets", "page:detach", "browser:detach"]);
    expect(world.closed).toEqual([]);
    expect(world.ids()).toEqual(["board-tab"]);
  });

  it("refuses when the board tab's target info names no browser context", async () => {
    const world = tabWorld();
    world.self = { ...BOARD, browserContextId: undefined };
    const { error } = await run(world, () => {});
    expect(error?.message).toBe("the board tab's target info names no browser context");
  });

  it("refuses when the page's context has no browser behind it", async () => {
    const world = tabWorld();
    world.hasBrowser = false;
    const { error } = await run(world, () => {});
    expect(error?.code).toBe("ERR_ASSERTION");
    expect(error?.message).toMatch(/^the new-tab check needs the browser behind this page's context/);
    expect(world.sent).toEqual([]);
  });

  it("reports a rejected CDP call as an assertion failure carrying the browser's error", async () => {
    const world = tabWorld();
    const cause = new Error("Protocol error (Target.getTargets): Browser has been closed");
    let lists = 0;
    const list = world.handlers["Target.getTargets"];
    world.handlers["Target.getTargets"] = (params) => {
      lists += 1;
      if (lists > 1) throw cause;
      return list(params);
    };
    const { error } = await run(world, opensTab(world));
    expect(error?.code).toBe("ERR_ASSERTION");
    expect(error?.message).toBe(`the browser's Target.getTargets failed: ${cause.message}`);
    expect(error?.cause).toBe(cause);
    expect(classifyFailure(error, NET_FAILURE)).toBe("assertion");
  });

  it("lets the click's own error through unchanged, whatever cleanup then hits", async () => {
    const world = tabWorld();
    const clickError = new Error("locator.click: Timeout 45000ms exceeded.");
    let broken = false;
    const list = world.handlers["Target.getTargets"];
    world.handlers["Target.getTargets"] = (params) => {
      if (broken) throw new Error("the target list broke during cleanup");
      return list(params);
    };
    world.detach = async () => { throw new Error("detach broke during cleanup"); };
    const { error } = await run(world, () => {
      world.targets.push(target());
      broken = true;
      throw clickError;
    });
    expect(error).toBe(clickError);
    expect(world.page.listenerCount("framenavigated")).toBe(0);
  });

  // The before-click snapshot must be in place before the click runs: a click that opens its tab and
  // then fails (a Playwright timeout after dispatch) still leaves a tab that cleanup has to close.
  it("closes a tab the click opened before the click itself failed", async () => {
    const world = tabWorld();
    const clickError = new Error("locator.click: Timeout 45000ms exceeded.");
    const { error } = await run(world, () => {
      world.targets.push(target());
      throw clickError;
    });
    expect(error).toBe(clickError);
    expect(world.closed).toEqual(["new-tab"]);
    expect(world.ids()).toEqual(["board-tab"]);
  });

  it("keeps its deadline failure when closing the new tab fails", async () => {
    const world = tabWorld();
    world.handlers["Target.closeTarget"] = () => { throw new Error("closeTarget broke during cleanup"); };
    const { error } = await run(world, opensTab(world, target({ title: PENDING_TITLE })));
    expect(error?.message).toMatch(/^the click opened no confirmed new tab within 300 ms: /);
  });

  // Each awaited browser call the helper makes before the click: a rejection of any of them must
  // reach the caller as an assertion failure naming the call, or the retry gate could grant a retry.
  const REJECTED_CALLS: {
    site: string;
    what: string;
    detached: string[];
    breakCall: (world: World, cause: Error) => void;
  }[] = [
    {
      site: "page session open",
      what: "opening a CDP session on the board tab",
      detached: [],
      breakCall: (world, cause) => { world.openPageSession = async () => { throw cause; }; },
    },
    {
      site: "browser session open",
      what: "opening a browser-level CDP session",
      detached: ["page:detach"],
      breakCall: (world, cause) => { world.openBrowserSession = async () => { throw cause; }; },
    },
    {
      site: "Target.getTargetInfo",
      what: "the board tab's Target.getTargetInfo",
      detached: ["browser:detach", "page:detach"],
      breakCall: (world, cause) => { world.handlers["Target.getTargetInfo"] = () => { throw cause; }; },
    },
    {
      site: "title read",
      what: "reading the board tab's title",
      detached: ["browser:detach", "page:detach"],
      breakCall: (world, cause) => { world.readTitle = async () => { throw cause; }; },
    },
  ];

  it.each(REJECTED_CALLS)("reports a rejected $site as an assertion failure carrying the browser's error", async ({ what, detached, breakCall }) => {
    const world = tabWorld();
    const cause = new Error("Target page, context or browser has been closed");
    breakCall(world, cause);
    let clicked = false;
    const { error } = await run(world, () => { clicked = true; });
    expect(error?.code).toBe("ERR_ASSERTION");
    expect(error?.message).toBe(`${what} failed: ${cause.message}`);
    expect(error?.cause).toBe(cause);
    expect(classifyFailure(error, NET_FAILURE)).toBe("assertion");
    expect(clicked).toBe(false);
    expect(world.sent.filter((m) => m.endsWith(":detach")).sort()).toEqual(detached);
    expect(world.closed).toEqual([]);
  });

  it("still settles when a close is never answered", async () => {
    const world = tabWorld();
    const close = world.handlers["Target.closeTarget"];
    world.handlers["Target.closeTarget"] = (params) => {
      close(params);
      return new Promise(() => {});
    };
    const { value, error, elapsedMs } = await run(world, opensTab(world));
    expect(error).toBeUndefined();
    expect(value?.target.targetId).toBe("new-tab");
    expect(world.ids()).toEqual(["board-tab"]);
    // Only the call's own bound can end the wait for a reply that never comes.
    expect(elapsedMs).toBeGreaterThanOrEqual(5000);
  });

  it("still settles when a detach is never answered", async () => {
    const world = tabWorld();
    world.detach = () => new Promise<void>(() => {});
    const { value, error, elapsedMs } = await run(world, opensTab(world));
    expect(error).toBeUndefined();
    expect(value?.target.targetId).toBe("new-tab");
    expect(world.sent.filter((m) => m.endsWith(":detach")).sort()).toEqual(["browser:detach", "page:detach"]);
    expect(elapsedMs).toBeGreaterThanOrEqual(5000);
  });

  it("reads the board tab's own title instead of assuming the app's", async () => {
    const matching = tabWorld();
    matching.boardTitle = "Board 7";
    const found = await run(matching, opensTab(matching, target({ title: "Board 7" })));
    expect(found.error).toBeUndefined();
    expect(found.value?.target.title).toBe("Board 7");

    const other = tabWorld();
    other.boardTitle = "Board 7";
    const missed = await run(other, opensTab(other, target({ title: TITLE })));
    expect(missed.error?.message).toMatch(
      /^the click opened no confirmed new tab within 300 ms: expected a new tab at .* titled "Board 7", /);
  });

  it("neither counts nor closes a tab that was already open in the board's context", async () => {
    const world = tabWorld();
    // Already at the very document the click opens, so only the before-click snapshot can exclude it.
    world.targets.push(target({ targetId: "older-tab" }));
    const { value, error } = await run(world, opensTab(world));
    expect(error).toBeUndefined();
    expect(value?.target.targetId).toBe("new-tab");
    expect(value?.newTargetIds).toEqual(["new-tab"]);
    expect(world.closed).toEqual(["new-tab"]);
    expect(world.ids()).toEqual(["board-tab", "older-tab"]);
  });

  it("fails when a closed prerender target never leaves the target list", async () => {
    const world = tabWorld();
    world.closeTakes = (targetId) => targetId !== "prerendered";
    const { error } = await run(world, () => {
      world.targets.push(target({ targetId: "prerendered", subtype: "prerender" }), target());
    });
    expect(error?.code).toBe("ERR_ASSERTION");
    expect(error?.message).toMatch(/^every tab the click opened should be closed again after the check/);
    expect(world.closed.sort()).toEqual(["new-tab", "prerendered"]);
  });

  it("reports matchedAt as the time of the listing that confirmed the match", async () => {
    const world = tabWorld();
    let clicked = false;
    let clickedAt = 0;
    let listsAfterClick = 0;
    let committedAt = 0;
    world.beforeList = () => {
      if (!clicked) return;
      listsAfterClick += 1;
      if (listsAfterClick !== 3) return;
      const tab = world.targets.find((t) => t.targetId === "new-tab");
      if (tab) tab.title = TITLE;
      committedAt = Date.now();
    };
    const { value, error } = await run(world, () => {
      clicked = true;
      clickedAt = Date.now();
      world.targets.push(target({ title: PENDING_TITLE }));
    });
    expect(error).toBeUndefined();
    // The tab commits on the third poll, 200 ms of fake time after the click.
    expect(committedAt - clickedAt).toBe(200);
    expect(value?.matchedAt).toBe(committedAt);
  });
});
