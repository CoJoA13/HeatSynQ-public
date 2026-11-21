/**
 * The only way a suite source registers a request route (#342).
 *
 * While a page has any route, Playwright intercepts every request the page makes; when the LAST
 * route is removed it turns interception off, and a request the page issues in that instant is
 * stranded: reported as issued, never reaching the server, never settling (#340). The page is
 * usually busy when a flow removes its route, since the route was there to hold or fail a request
 * the page then reacts to.
 *
 * So the first route a flow registers on a page brings a second one with it, whose pattern matches
 * no request and which is never removed. Interception then stays on for the rest of that page's
 * life, and removing the flow's own route is no longer removing the last. A page that never routes
 * is not touched: it runs without interception, as before.
 *
 * It sits beside run.mjs rather than in lib/ because it makes the raw calls the lib/ and flows/
 * sweep refuses (`findRawRouteCalls`), the api-mutate.mjs precedent.
 */

/** No request has this host: `.invalid` never resolves (RFC 2606), and no flow browses it. */
export const KEEP_ALIVE_PATTERN = "http://route-keep-alive.invalid/**";

const kept = new WeakSet();

/** Whether this page already holds its keep-alive route. */
export function keptAlive(page) {
  return kept.has(page);
}

/**
 * Register `handler` for `url` on `page`, as `page.route` does, and return the function that
 * removes it again. The keep-alive route goes in first, once for each page.
 */
export async function routeRequests(page, url, handler) {
  if (!kept.has(page)) {
    // Marked before the await: two registrations racing on one page must not both install it.
    kept.add(page);
    try {
      await page.route(KEEP_ALIVE_PATTERN, (route) => route.continue());
    } catch (error) {
      kept.delete(page);
      throw error;
    }
  }
  await page.route(url, handler);
  return () => page.unroute(url, handler);
}
