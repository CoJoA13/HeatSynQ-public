import assert from "node:assert/strict";

/**
 * The counted way for a flow to make a mutating request outside the page (fix-round finding 1) —
 * the `lockRevision` precedent. Playwright emits no `context` request/response event for an
 * APIRequestContext call, so a raw write through `page.request` reaches the dev DB with the retry
 * gate's counters reading zero. `assertNoRawApiMutations` refuses a raw one; this is what it
 * points people at. Lifted out of run.mjs so its retry contract is testable (#321); it sits beside
 * run.mjs rather than in lib/ because it IS the counted raw call the lib/ and flows/ sweeps refuse.
 *
 * Indeterminate first, resolved after: a request that throws or never answers may have committed
 * server-side anyway, and that is the direction that must not be guessed at.
 *
 * `idempotent: true` lets Playwright retry one reset socket (it retries ECONNRESET only). An idle
 * keep-alive socket can be reset as the flow reuses it, and a flow's state-restoring PUT failing
 * that way left a shared role narrowed for every later flow (#321). Only an exact-value PUT may ask
 * for it: a replayed create is a duplicate. A raw retry count is refused, so the decision cannot be
 * made without naming it. The retry is one logical write, so the counters see one.
 *
 * Every write is first preceded by a read-only GET of /api/health (unauthenticated, `SELECT 1`),
 * allowed one reset retry. Measured on 2026-09-24: Playwright pools with a keep-alive agent that never
 * idles sockets out, Node's server closes an idle one at 6 s (5 s timeout + 1 s buffer), and a reuse
 * landing within milliseconds of that close resets (2 of 6 at a 5,995 ms gap, 0 of 102 at other gaps).
 * `next dev` offers no keep-alive option, so the race is closed client-side: the warming GET absorbs
 * any expiring socket, and the agent's LIFO reuse puts the write on the socket that GET just used.
 * That protects writes which may never be replayed, not only idempotent ones. A warming failure
 * throws before the write is counted or sent.
 */
const WARM_PATH = "/api/health";
export function makeApiMutate(outOfBand) {
  return async (page, url, options = {}) => {
    const { idempotent = false, ...rest } = options;
    const method = (rest.method ?? "POST").toUpperCase();
    assert.equal(Object.hasOwn(rest, "maxRetries"), false, "Pass idempotent: true, never a raw retry count");
    assert.ok(!idempotent || method === "PUT", `Only an exact-value PUT may retry a reset socket, not ${method}`);
    await page.request.get(new URL(WARM_PATH, url).href, { maxRetries: 1 });
    outOfBand.indeterminate += 1;
    const res = await page.request.fetch(url, { ...rest, method, ...(idempotent ? { maxRetries: 1 } : {}) });
    outOfBand.indeterminate -= 1;
    if (res.ok()) outOfBand.committed += 1;
    return res;
  };
}
