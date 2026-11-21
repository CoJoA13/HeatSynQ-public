// #332: an operator's session expires while a page is open, and the next background read answers
// 401. The app must end on /login by itself. The Shell's session check is the one place that routes
// an expired identity there, so the 401 has to re-run that check. When the check itself cannot
// answer (a transient failure), the holding screen's Retry control must look like a button.
//
// The server session is ended through the counted `ctx.apiMutate` logout, then the dead cookie is
// put back: an idle expiry leaves the cookie in the browser, which is what lets the cookie-presence
// proxy pass and makes the in-page 401 the only signal the app receives. No business writes.
import assert from "node:assert/strict";
import { login } from "../lib/auth.mjs";
import { routeRequests } from "../route-keep-alive.mjs";

const search = (page) => page.getByRole("combobox", { name: "Global search", exact: true });

async function within(promise, message, ms = 10000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new assert.AssertionError({ message })), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function openBoard(page, ctx) {
  await page.goto(`${ctx.baseURL}/`);
  await page.getByRole("heading", { name: "Orders", exact: true }).waitFor({ state: "visible" });
  await search(page).waitFor({ state: "visible" });
}

// Ends this context's server session but keeps its cookie, as an idle timeout does.
async function expireSession(page, ctx) {
  const cookies = await page.context().cookies(ctx.baseURL);
  assert.ok(cookies.length > 0, "The signed-in context must hold a session cookie");
  const res = await ctx.apiMutate(page, `${ctx.baseURL}/api/auth/logout`, { method: "POST" });
  assert.equal(res.ok(), true, "The out-of-band logout must end the server session");
  await page.context().addCookies(cookies);
}

// The read an operator makes on return from idle. A mount read still in flight when the session
// ended (the setup banner's readiness check runs an argon2 verify) can answer 401 first and replace
// the board, leaving no search box. That 401 is equally in-page, so the flow asserts only outcomes
// and never which read answered. Waiting for the page to go quiet instead depended on Playwright
// network events, which one full run failed to deliver for reads the page had completed.
async function readAfterExpiry(page, term) {
  await search(page).fill(term, { timeout: 5000 }).catch(() => {});
}

async function reachesLogin(page, ctx, message) {
  await page.waitForURL(`${ctx.baseURL}/login`, { timeout: 15000 }).catch(() => assert.fail(message));
  await page.getByLabel("Username").waitFor({ state: "visible" });
}

export async function run(page, shot, ctx) {
  await openBoard(page, ctx);
  await expireSession(page, ctx);
  await readAfterExpiry(page, "expired-session");
  await reachesLogin(page, ctx, "An in-page 401 must end an expired session on /login without operator action");
  await shot("expired-at-login");

  // A session check that fails transiently leaves the holding screen up; Retry must be usable.
  await login(page, ctx.baseURL, ctx.fixtures.adminUsername, ctx.fixtures.adminPassword);
  await openBoard(page, ctx);
  const me = `${ctx.baseURL}/api/auth/me`;
  let rechecked;
  const recheck = new Promise((resolve) => { rechecked = resolve; });
  const routeErrors = [];
  const unavailable = async (route) => {
    rechecked();
    await route.fulfill({ status: 503, json: { error: "Service unavailable" } })
      .catch((error) => { routeErrors.push(error); });
  };
  const stopUnavailable = await routeRequests(page, me, unavailable);
  await expireSession(page, ctx);
  await readAfterExpiry(page, "session-check-retry");
  await within(recheck, "An in-page 401 must re-run the session check");
  const status = page.getByRole("status").filter({ hasText: "Could not confirm your session" });
  await status.waitFor({ state: "visible" });
  // The 401 purged this tab's drafts, so the status must not say any are hidden.
  assert.equal((await status.textContent())?.trim(), "Could not confirm your session. Please retry.",
    "A failed check after a 401 must not claim retained drafts");
  const retry = page.getByRole("button", { name: "Retry session check", exact: true });
  const look = await retry.evaluate((el) => {
    const style = getComputedStyle(el);
    return { border: style.borderTopWidth, padding: style.paddingLeft };
  });
  // Width, not style: Tailwind's preflight gives every element `border: 0 solid`.
  assert.notEqual(look.border, "0px", "Retry session check must draw a button border");
  assert.notEqual(look.padding, "0px", "Retry session check must be padded like a button");
  await shot("session-check-retry");
  // The holding screen issues no requests of its own, and this is not the page's last route (#342).
  await stopUnavailable();
  assert.deepEqual(routeErrors, [], "The unavailable session check must be answered");
  await retry.click();
  await reachesLogin(page, ctx, "Retrying the session check must end an expired session on /login");
}
