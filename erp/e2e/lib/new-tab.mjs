// #345: proves that a click opened a new browser tab by reading the browser's own target list over
// the Chrome DevTools Protocol, instead of waiting for Playwright's context page event.
//
// Why it exists. Upstream microsoft/playwright#42142: on the default headless shell, from Playwright
// 1.62 onward (the repo pins 1.63.0), a modifier or middle click on a plain link intermittently
// opens a tab that Playwright never finishes setting up. A Playwright maintainer bisected it to a
// headless-shell change in Chromium, filed as crbug 543471700; neither issue has a released fix.
// Playwright announces a new page to the context only after that page's initialization resolves, and
// the initialization awaits several browser replies, the tab's first real navigation commit among
// them, with no bound. When it hangs (upstream has not yet named the step), the tab is attached and
// its video is recorded, but the context page event never arrives and never recovers. #345 measured
// 3 to 5 misses per 60 board Ctrl+clicks this way. The browser's target list does not depend on that
// initialization, so it cannot hang the same way.
//
// What it proves. The board tab's own page session is used for one thing only: reading the tab's
// target id and browser context. A browser-level session lists and closes targets. The helper
// snapshots the page targets in that browser context before the click, then polls the target list
// every 100 ms until a snapshot holds exactly one new, non-prerender page target in the same context,
// and that target has a URL path matching the caller's pattern and a title equal to the board tab's
// own title. The title is the commit proof: for a new Ctrl+click tab Chromium reports the pending URL
// before the navigation commits, and the title falls back to that URL string until a real document
// commits. A matching title therefore proves the app document committed at that URL. It does NOT
// prove the load event, which the step this replaced waited for.
//
// Exactly one new tab. Every new, non-prerender page target in the board's context that the helper
// judges counts as a tab the click opened: those in each poll after the click, and those in the one
// late snapshot cleanup takes just before it starts closing. A second one fails the check even when
// it never committed, sat at another URL, came and went before the match, or appeared after it. The
// close wait that follows re-reads the target list only to see the closed tabs leave it: a tab that
// first appears there, or after the helper returns, is neither counted nor closed. Prerender targets
// are not tabs; they are closed, never counted.
//
// Cleanup. Every new page target judged, including one caught by the late snapshot, is closed over
// the browser session; the helper waits for each to leave the target list and then detaches both
// sessions. Cleanup never replaces the original failure. Only on the success path does it then
// assert that the click opened exactly one new tab, that no new tab remains, that the board tab's
// main frame never navigated from the click to the confirmed close, and that the board tab's URL is
// unchanged.
//
// A late page event for a closed tab, observed. Closing a tab over CDP before Playwright finished
// initializing it disposes that initialization, and Playwright then reports the page anyway: a late
// context page event for a page that is already closed, followed at once by that page's close event.
// Playwright 1.63's source gives this for any tab the helper closes that early, a stranded #42142 tab
// or a slow healthy one. The #345 probe observed it for each of its 5 stranded tabs (5 of 5), 6-7 ms
// after the helper's match, the page already closed when the event arrived. A later wait for the
// context's next page event, in the same browser context, could therefore receive this stale closed
// page instead of the tab it wanted, and the stale page can carry the very URL that wait wants. Each
// flow gets its own browser context, and nothing that runs after this helper in the board-search-scan
// flow waits on that event today; a later step that needs to should identify its page by URL and skip
// a page that is already closed, or use this helper.
//
// The never-auto-attach rule. One browser serves every flow in a run, and the browser session
// opened here can see all of it. The helper never sends Target.setAutoAttach or
// Target.setDiscoverTargets on either session. An automatic attachment that holds new targets until
// a debugger releases them would freeze every tab that every later flow opens, long after this
// helper had detached. It only lists targets, reads its own tab's info, and closes the tabs it saw
// appear.
//
// How failures are classified. Every check the helper makes is a node:assert assertion, and every
// browser call it awaits (both session opens, each CDP command, the title read) goes through
// `within`. That turns the call's timeout, and a rejection of the call itself, into an AssertionError
// naming the call, with the browser's own error kept as its cause. A CDP reply comes from the local
// browser and says nothing about the network, so classifyFailure keeps each of these an assertion
// failure and the retry gate never grants a retry on one. The one exception is the click: it is the
// caller's own Playwright action, so its failure reaches the caller unchanged and is classified like
// any other action in the flow. The helper makes no HTTP calls of its own and builds no row locator;
// the caller scopes its link with boardRow.
import assert from "node:assert/strict";

const CDP_CALL_MS = 5000;
const POLL_MS = 100;
const CLOSE_WAIT_MS = 5000;

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Bounds one awaited browser call, which `what` names, and makes any failure of it an assertion
 * failure. When the bound expires it rejects with an AssertionError saying the call did not finish.
 * When the call itself rejects (a protocol error, or a closed target, page or context), it rejects
 * with an AssertionError naming the call and repeating the browser's message, and keeps the original
 * error as `cause`. Exported for its tests.
 */
export async function within(promise, what, ms = CDP_CALL_MS) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new assert.AssertionError({ message: `${what} did not finish within ${ms} ms` })), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err;
    const failure = new assert.AssertionError({ message: `${what} failed: ${err?.message ?? String(err)}` });
    failure.cause = err;
    throw failure;
  } finally { clearTimeout(timer); }
}

/** Opens a CDP session within the bound. A session that attaches only after its bound expired is
 *  detached as soon as it arrives, so a slow attach can never leave a session behind the flow.
 *  Exported for its tests. */
export async function openSession(opening, what, ms = CDP_CALL_MS) {
  try {
    return await within(opening, what, ms);
  } catch (err) {
    opening.then((late) => late.detach().catch(() => {}), () => {});
    throw err;
  }
}

/**
 * @typedef {{ targetId: string, type: string, url: string, title: string,
 *   browserContextId?: string, subtype?: string }} TabTarget
 */

/** @param {TabTarget} target */
function describeTarget(target) {
  const subtype = target.subtype ? ` (${target.subtype})` : "";
  return `${JSON.stringify(target.url)} titled ${JSON.stringify(target.title)}${subtype}`;
}

/**
 * The pure matching decision for one snapshot of the target list. `fresh` is every page target in
 * the board's browser context that was not in the before-click snapshot, prerender targets included;
 * the caller closes all of them. `opened` is the same list without prerender targets: the new tabs.
 * `match` is set only when `opened` holds exactly one tab and that tab's parsed URL path matches
 * `pathPattern` and its title equals `title`; with no new tab, an uncommitted one, or more than one
 * new tab (committed or not) it is null. `description` names the outcome and lists every fresh
 * target's URL and title, for the failure message.
 *
 * @param {{ targets: TabTarget[], before: Set<string>, contextId: string, pathPattern: RegExp,
 *   title: string }} input
 * @returns {{ match: TabTarget | null, fresh: TabTarget[], opened: TabTarget[], description: string }}
 */
export function newTabVerdict({ targets, before, contextId, pathPattern, title }) {
  const fresh = targets.filter((target) => target.type === "page"
    && target.browserContextId === contextId
    && !before.has(target.targetId));
  const opened = fresh.filter((target) => target.subtype !== "prerender");
  const committed = opened.filter((target) => URL.canParse(target.url)
    && pathPattern.test(new URL(target.url).pathname)
    && target.title === title);
  const listing = fresh.length > 0 ? fresh.map(describeTarget).join("; ") : "none";
  const wanted = `a new tab at ${pathPattern} titled ${JSON.stringify(title)}`;
  if (opened.length === 1 && committed.length === 1) {
    return { match: committed[0], fresh, opened, description: `found ${wanted}; new page targets: ${listing}` };
  }
  const problem = opened.length > 1
    ? `${opened.length} new tabs are open (${committed.length} of them at that document), but the click `
      + `should open exactly one: expected ${wanted}`
    : `expected ${wanted}, and no new tab has committed that document`;
  return { match: null, fresh, opened, description: `${problem}; new page targets: ${listing}` };
}

/**
 * Runs `click` and confirms, through the browser's target list, that it opened exactly one new tab
 * and that the tab committed its document at a path matching `pathPattern`. The commit proof is a
 * title equal to the clicking tab's own, so this can confirm only a tab whose document is titled like
 * the clicking tab: an app page, never a PDF or another file. "Exactly one" covers every new,
 * non-prerender page target in the board's browser context from the first poll after the click
 * through the late snapshot cleanup takes before closing; see this file's header for what that
 * proves and why it does not use Playwright's context page event. Every new tab judged is closed
 * again before this returns. Returns the matched target, the time the match was confirmed
 * (`matchedAt`, epoch milliseconds, read when the matching listing is judged, before cleanup begins
 * closing tabs), and the ids of every new page target judged and closed (`newTargetIds`, prerender
 * targets included).
 *
 * @param {import("playwright").Page} page the tab the click happens in
 * @param {() => Promise<unknown>} click performs the click
 * @param {{ pathPattern: RegExp, timeoutMs?: number }} options
 * @returns {Promise<{ target: TabTarget, matchedAt: number, newTargetIds: string[] }>}
 */
export async function clickOpensNewTab(page, click, { pathPattern, timeoutMs = 20000 }) {
  const browser = page.context().browser();
  assert.ok(browser, "the new-tab check needs the browser behind this page's context, to read its target list");

  let pageSession = null;
  let browserSession = null;
  let contextId;
  let before = null;
  let title;
  let originUrl;
  let matched = null;
  let matchedAt = 0;
  // Every new page target judged, prerender included: all of them are closed.
  const seen = new Set();
  // Every new tab judged (no prerender): the success path requires this to be the match alone.
  const opened = new Map();
  let remaining = ["(cleanup did not run)"];
  const navigations = [];
  const onNavigated = (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  };
  let listening = false;

  const listTargets = async () => (await within(browserSession.send("Target.getTargets"),
    "the browser's Target.getTargets")).targetInfos;
  const judge = (targets) => {
    const verdict = newTabVerdict({ targets, before, contextId, pathPattern, title });
    for (const target of verdict.fresh) seen.add(target.targetId);
    for (const target of verdict.opened) opened.set(target.targetId, target);
    return verdict;
  };

  try {
    pageSession = await openSession(page.context().newCDPSession(page), "opening a CDP session on the board tab");
    browserSession = await openSession(browser.newBrowserCDPSession(), "opening a browser-level CDP session");
    const { targetInfo: self } = await within(pageSession.send("Target.getTargetInfo"),
      "the board tab's Target.getTargetInfo");
    contextId = self.browserContextId;
    assert.ok(contextId, "the board tab's target info names no browser context");

    const initial = await listTargets();
    const snapshot = new Set(initial
      .filter((target) => target.type === "page" && target.browserContextId === contextId)
      .map((target) => target.targetId));
    assert.ok(snapshot.has(self.targetId),
      "the browser's target list does not include the board tab itself, so its snapshot cannot be trusted");
    // Only a trusted snapshot becomes `before`: cleanup runs only once it is set, so a rejected
    // snapshot can never make cleanup treat a tab it left out, the board included, as new and close it.
    before = snapshot;
    originUrl = page.url();
    title = await within(page.title(), "reading the board tab's title");
    page.on("framenavigated", onNavigated);
    listening = true;

    await click();

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const verdict = judge(await listTargets());
      if (verdict.match) {
        matched = verdict.match;
        matchedAt = Date.now();
        break;
      }
      assert.ok(Date.now() < deadline,
        `the click opened no confirmed new tab within ${timeoutMs} ms: ${verdict.description}`);
      await pause(POLL_MS);
    }
  } finally {
    // Nothing in this block may raise: a failure above must reach the caller as itself.
    if (browserSession && before) {
      await listTargets().then(judge).catch(() => {});
      await Promise.all([...seen].map((targetId) => within(
        browserSession.send("Target.closeTarget", { targetId }),
        `the browser's Target.closeTarget for ${targetId}`,
      ).catch(() => {})));
      const closeDeadline = Date.now() + CLOSE_WAIT_MS;
      for (;;) {
        const now = await listTargets().catch(() => null);
        remaining = now
          ? now.filter((target) => seen.has(target.targetId)).map(describeTarget)
          : ["(the target list could not be read after closing)"];
        if ((now && remaining.length === 0) || Date.now() >= closeDeadline) break;
        await pause(POLL_MS);
      }
    }
    if (listening) page.off("framenavigated", onNavigated);
    await Promise.all([pageSession, browserSession].filter(Boolean).map((session) =>
      within(session.detach(), "detaching a CDP session").catch(() => {})));
  }

  assert.deepEqual([...opened.keys()], [matched.targetId],
    `the click should open exactly one new tab, but ${opened.size} appeared: `
    + [...opened.values()].map(describeTarget).join("; "));
  assert.deepEqual(remaining, [], "every tab the click opened should be closed again after the check");
  assert.deepEqual(navigations, [],
    "the board tab's main frame should not navigate while a modified click opens a new tab");
  assert.equal(page.url(), originUrl, "the board tab should keep its URL while a modified click opens a new tab");
  return { target: matched, matchedAt, newTargetIds: [...seen] };
}
