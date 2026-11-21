// A record page's traffic in a #573 part (discard-grid-edits on the saved shipment, invoice-shipped-
// order on the invoice): one route at the record's address, through the keep-alive, that answers a
// header save with a refusal of the flow's own and can keep a read's answer from the page; the log
// the parts order their beats by; and the cleanup shape the parts end in. Swept (#192): what is
// described here is described in prose, never written.
import assert from "node:assert/strict";
import { bounded } from "./order-entry-workspace.mjs";
import { routeRequests } from "../route-keep-alive.mjs";

/**
 * The record's own traffic in a #573 part, as the page sends and hears it, and the flow's route at
 * the record's address. The log holds "POST" and "POST answered" for the page's write at
 * `writePath` (Add order on the shipment, Finalize on the invoice), "GET" and "GET answered" for
 * each read of the record at `recordPath` (the page's own and the grids' recovery reads alike:
 * they share the address), "PATCH" and "PATCH answered" for each header save there, and "GET
 * served" for each read the route held. A request the flow sends apart from the page (the hold
 * forwarding the write to the server) is not in it.
 *
 * The route answers a PATCH with a 503 carrying `refusal`, which never reaches the server. A GET
 * goes to the server at once; while `holdReads(true)` its answer is kept from the page until
 * `releaseReads()`, what the server answered with noted in `served` as `summarise(body)` gives it
 * (the shipment's order ids; the invoice's status); otherwise, and for anything else, the request
 * goes on its way. `heard(test)` resolves once `test` holds of the log, and is raced against a
 * time limit where it is awaited; `heardWithin(test, timeoutMs)` is that race, resolving true or
 * false and asserting nothing. `stop` lets every held answer go, takes the listeners off and
 * removes the route, with no held request of the page's in flight (#340).
 */
export async function wireRecordReads(page, ctx, { recordPath, writePath, refusal, summarise }) {
  const log = [];
  const served = [];
  const waiters = new Set();
  let holding = false;
  let held = []; // { release, done } for each answer kept from the page
  let beingServed = 0; // reads the route has sent to the server while holding and not yet held
  // Resolves true once `test` holds, polled; false once 20 seconds have passed without it (the
  // `bounded` limit), so no poll outlives the part that asked.
  const settled = (test) => new Promise((resolve) => {
    const deadline = Date.now() + 20000;
    const poll = () => {
      if (test()) resolve(true);
      else if (Date.now() > deadline) resolve(false);
      else setTimeout(poll, 20);
    };
    poll();
  });
  const note = (entry) => {
    log.push(entry);
    for (const waiter of waiters) waiter();
  };
  const kind = (req) => {
    const path = new URL(req.url()).pathname;
    if (path === recordPath && (req.method() === "GET" || req.method() === "PATCH")) return req.method();
    if (path === writePath && req.method() === "POST") return "POST";
    return null;
  };
  const onRequest = (req) => { const k = kind(req); if (k !== null) note(k); };
  const onResponse = (res) => { const k = kind(res.request()); if (k !== null) note(`${k} answered`); };
  page.on("request", onRequest);
  page.on("response", onResponse);
  const handler = async (route) => {
    const method = route.request().method();
    if (method === "PATCH") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: refusal }) });
      return;
    }
    if (method !== "GET" || !holding) { await route.continue(); return; }
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    beingServed += 1;
    let done;
    try {
      const response = await route.fetch();
      served.push(summarise(await response.json()));
      done = gate.then(() => route.fulfill({ response }));
      held.push({ release, done });
      note("GET served");
    } catch (error) {
      // A read the server could not be asked for: the page's copy fails, and the log says so.
      note(`GET failed: ${error}`);
      await route.abort().catch(() => {});
      return;
    } finally { beingServed -= 1; }
    await done;
  };
  const stopRoute = await routeRequests(page, `${ctx.baseURL}${recordPath}`, handler);
  // Lets go every answer held so far, once each read the server is still serving has been held
  // too, so a read sent while holding is never left behind an earlier release.
  const releaseReads = async () => {
    assert.ok(await settled(() => beingServed === 0), `every read of ${recordPath} sent while holding must be served`);
    const releasing = held;
    held = [];
    for (const entry of releasing) entry.release();
    await bounded(Promise.all(releasing.map((entry) => entry.done)),
      `every held answer to a read of ${recordPath} must reach the page`);
  };
  const heard = (test) => new Promise((resolve) => {
    const check = () => {
      if (!test(log)) return;
      waiters.delete(check);
      resolve();
    };
    waiters.add(check);
    check();
  });
  return {
    log,
    served,
    holdReads(on) { holding = on; },
    releaseReads,
    heard,
    /** Resolves true once `test` holds of the log, or false once `timeoutMs` has passed without it:
     *  a wait that orders the flow's next step and asserts nothing. */
    heardWithin(test, timeoutMs) {
      let timer;
      const expired = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
      return Promise.race([heard(test).then(() => true), expired]).finally(() => clearTimeout(timer));
    },
    async stop() {
      holding = false;
      try { await releaseReads(); } finally {
        page.off("request", onRequest);
        page.off("response", onResponse);
        waiters.clear();
        await stopRoute();
      }
    },
  };
}

/** Whether, in a wire log, `later` was heard after `entry`. Every check of the log is relative to
 *  an entry of its own: a read the page had in flight as the listeners went on is in the log as an
 *  answer with no request, and must not decide anything. */
export function heardAfter(log, entry, later) {
  const at = log.indexOf(entry);
  return at !== -1 && log.indexOf(later, at + 1) !== -1;
}

/** Whether, in a wire log, the page read the record after the write went out: the condition under
 *  which the page reads once more after that write's answer. */
export function writeBeforeRead(log) {
  return heardAfter(log, "POST", "GET");
}

/** Whether, in a wire log, the page read the record after `entry` was heard. */
export function readAfter(log, entry) {
  return heardAfter(log, entry, "GET");
}

/** Whether, in a wire log, the page sent a read after the first read answered at or past `mark`
 *  (the index the flow took before it let a held answer go); with `held`, whether that read was then
 *  served and held. An answer logged for a grid's read, before or after the page's own, leaves the
 *  page's next read as the one found. The log cannot tell the page's read from a grid's: what proves
 *  the page read again is what the released read does on screen. */
export function readAfterAnswerFrom(log, mark, { held = false } = {}) {
  const landed = log.indexOf("GET answered", mark);
  if (landed === -1) return false;
  const sent = log.indexOf("GET", landed + 1);
  if (sent === -1) return false;
  return !held || log.indexOf("GET served", sent + 1) !== -1;
}

/**
 * Runs `body`, then every cleanup in order, each one whether or not an earlier one threw. What
 * `body` threw is what is thrown, its message extended with what any cleanup threw after it, so the
 * flow's first failure is the one named and keeps its code; when `body` succeeded, the first
 * cleanup's failure is thrown as it came, the others' text added to it.
 */
export async function withCleanups(body, cleanups) {
  let failure = null;
  let failed = false;
  let result;
  try { result = await body(); } catch (error) { failed = true; failure = error; }
  const afterwards = [];
  for (const cleanup of cleanups) {
    try { await cleanup(); } catch (error) { afterwards.push(error); }
  }
  if (!failed && afterwards.length > 0) { failed = true; failure = afterwards.shift(); }
  if (failed) {
    if (afterwards.length > 0 && failure instanceof Error) {
      failure.message += ` (then, cleaning up: ${afterwards.map((e) => (e instanceof Error ? e.message : String(e))).join("; ")})`;
    }
    throw failure;
  }
  return result;
}
