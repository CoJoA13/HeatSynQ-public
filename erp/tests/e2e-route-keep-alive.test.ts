import { describe, expect, it } from "vitest";
import { KEEP_ALIVE_PATTERN, keptAlive, routeRequests } from "../e2e/route-keep-alive.mjs";

// #342. Playwright intercepts a page's requests while the page has any route and stops when the
// last one goes; a request issued in that instant never settles. The helper gives a page that
// routes a second route that is never removed. The race itself is measured by
// docs/execution/2026-10-04-e2e-route-keep-alive/repro.mjs; this pins what the helper asks of a page.

type Handler = (route: { continue: () => unknown }) => unknown;
/** A stand-in page that records what is registered and removed, in order. */
function fakePage({ failRoute = 0 } = {}) {
  const calls: string[] = [];
  const routes: { url: string; handler: Handler }[] = [];
  let failures = failRoute;
  return {
    calls, routes,
    async route(url: string, handler: Handler) {
      await Promise.resolve();
      if (failures-- > 0) throw new Error("route refused");
      calls.push(`route ${url}`); routes.push({ url, handler });
    },
    async unroute(url: string, handler: Handler) {
      await Promise.resolve();
      calls.push(`unroute ${url}`);
      const index = routes.findIndex((entry) => entry.url === url && entry.handler === handler);
      if (index >= 0) routes.splice(index, 1);
    },
  };
}
const handler: Handler = () => undefined;

describe("routeRequests", () => {
  it("gives a page its keep-alive route first, then the flow's own", async () => {
    const page = fakePage();
    expect(keptAlive(page)).toBe(false);
    await routeRequests(page, "/api/a", handler);
    expect(page.calls).toEqual([`route ${KEEP_ALIVE_PATTERN}`, "route /api/a"]);
    expect(keptAlive(page)).toBe(true);
  });

  it("removes only the flow's route, so the page never loses its last", async () => {
    const page = fakePage();
    const stop = await routeRequests(page, "/api/a", handler);
    await stop();
    expect(page.calls.at(-1)).toBe("unroute /api/a");
    expect(page.routes.map((entry) => entry.url)).toEqual([KEEP_ALIVE_PATTERN]);
  });

  it("removes the very handler it registered, and no other on the same URL", async () => {
    const page = fakePage();
    const other: Handler = () => undefined;
    const stop = await routeRequests(page, "/api/a", handler);
    await routeRequests(page, "/api/a", other);
    await stop();
    expect(page.routes.map((entry) => entry.handler)).toEqual([page.routes[0].handler, other]);
  });

  it("installs the keep-alive once for a page, however many routes come and go", async () => {
    const page = fakePage();
    for (const url of ["/api/a", "/api/b", "/api/a"]) await (await routeRequests(page, url, handler))();
    expect(page.calls.filter((call) => call === `route ${KEEP_ALIVE_PATTERN}`)).toHaveLength(1);
    expect(page.calls.filter((call) => call.startsWith("unroute")).every((call) => !call.includes("invalid"))).toBe(true);
  });

  it("installs it once when two registrations start together on one page", async () => {
    const page = fakePage();
    await Promise.all([routeRequests(page, "/api/a", handler), routeRequests(page, "/api/b", handler)]);
    expect(page.calls.filter((call) => call === `route ${KEEP_ALIVE_PATTERN}`)).toHaveLength(1);
    expect(page.routes).toHaveLength(3);
  });

  it("keeps one for each page", async () => {
    const first = fakePage(), second = fakePage();
    await routeRequests(first, "/api/a", handler);
    expect(keptAlive(second)).toBe(false);
    await routeRequests(second, "/api/a", handler);
    expect(second.calls[0]).toBe(`route ${KEEP_ALIVE_PATTERN}`);
  });

  it("does not count a keep-alive that failed to install, and installs it on the next call", async () => {
    const page = fakePage({ failRoute: 1 });
    await expect(routeRequests(page, "/api/a", handler)).rejects.toThrow("route refused");
    expect([keptAlive(page), page.routes]).toEqual([false, []]);
    await routeRequests(page, "/api/a", handler);
    expect(page.calls).toEqual([`route ${KEEP_ALIVE_PATTERN}`, "route /api/a"]);
  });

  it("the keep-alive lets a request through, and its pattern can match no request the suite makes", () => {
    const page = fakePage();
    return routeRequests(page, "/api/a", handler).then(() => {
      let continued = 0;
      page.routes[0].handler({ continue: () => { continued += 1; } });
      expect(continued).toBe(1);
      expect(new URL(KEEP_ALIVE_PATTERN.replace("/**", "/")).hostname.endsWith(".invalid")).toBe(true);
    });
  });
});
