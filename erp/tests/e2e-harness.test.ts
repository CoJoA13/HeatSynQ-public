import { describe, it, expect, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  attemptDir,
  classifyFailure,
  retryRefusal,
  isSessionEndpoint,
  findRawApiMutations,
  resultsLine,
} from "../e2e/lib/failure-classify.mjs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { enumerateRoutes, warmRoutes, warmupRefusal } from "../e2e/lib/warmup.mjs";
import { preflightRefusal } from "../e2e/lib/preflight.mjs";
import {
  findAmbientRowLocators,
  findBareReads,
  findPlainErrorFailures,
  findRawRouteCalls,
  findUncheckedAbsenceAssertions,
} from "../e2e/lib/flow-lint.mjs";
import { suiteSourcesSync } from "../e2e/lib/suite-sources.mjs";

// #192: the sweeps read the flow files AND the shared lib helpers (minus the two detector modules,
// which hold the patterns as literals). One list, from suite-sources.mjs, read identically here and
// in run.mjs so a file can never be swept by one enforcement point and skipped by the other.
const E2E_DIR = path.join(process.cwd(), "e2e");
const sweptSources = () => suiteSourcesSync(E2E_DIR);
const sweep = (find: (src: string) => { line: number; snippet: string }[]) =>
  sweptSources().flatMap(({ relPath, source }) =>
    find(source).map((f) => `${relPath}:${f.line} ${f.snippet}`),
  );

/**
 * The E2E harness's decision predicates (#184, gate-infrastructure Task 2 fix round).
 *
 * These three — "was this a transport failure?", "is a retry safe?", "can the mutation counters
 * see this write?" — decide whether a red run is allowed to become a green one. They were
 * module-private inside `e2e/run.mjs` and therefore untestable: the round-1 proofs that they work
 * were genuine but were injected by hand and reverted, so nothing guarded the next edit to them.
 * In a group whose whole subject is checks that lie about their own coverage, that was the wrong
 * place to leave them.
 *
 * `e2e/run.mjs` is never imported here: it starts a dev server and a browser at module scope's
 * mercy. The predicates live in `e2e/lib/failure-classify.mjs` precisely so this file can reach
 * them without any of that.
 */

describe("isSessionEndpoint", () => {
  it("excludes the two session endpoints, which login() re-POSTs on every attempt", () => {
    expect(isSessionEndpoint("http://localhost:3100/api/auth/login")).toBe(true);
    expect(isSessionEndpoint("http://localhost:3100/api/auth/logout")).toBe(true);
    // Query strings and ports must not defeat the match — it is a pathname test, not a substring one.
    expect(isSessionEndpoint("http://localhost:3100/api/auth/login?next=%2Forders")).toBe(true);
  });

  it("counts every other mutation, including paths that merely start with a session path", () => {
    expect(isSessionEndpoint("http://localhost:3100/api/orders")).toBe(false);
    expect(isSessionEndpoint("http://localhost:3100/api/auth/login/extra")).toBe(false);
    expect(isSessionEndpoint("http://localhost:3100/api/auth/me")).toBe(false);
  });

  it("treats an unparseable url as countable rather than exempt (fails closed)", () => {
    expect(isSessionEndpoint("not a url")).toBe(false);
  });
});

describe("classifyFailure", () => {
  const netFailure = { at: 0, line: "GET /api/parts/x — net::ERR_NETWORK_CHANGED" };

  it("names a request that got no response as network-level", () => {
    const err = new Error("locator.waitFor: Timeout 45000ms exceeded.");
    expect(classifyFailure(err, [netFailure])).toBe("network");
  });

  it("calls a plain thrown error an assertion failure", () => {
    expect(classifyFailure(new Error("boom"), [])).toBe("assertion");
  });

  it("keeps a LOCATOR timeout an assertion failure when nothing failed on the wire", () => {
    const err = new Error("locator.waitFor: Timeout 45000ms exceeded.");
    expect(classifyFailure(err, [])).toBe("assertion");
  });

  it("reads a NAVIGATION timeout as network-level even with no requestfailed record", () => {
    const err = new Error("page.goto: Timeout 60000ms exceeded.");
    expect(classifyFailure(err, [])).toBe("network");
  });

  it("accepts a non-Error throw without crashing", () => {
    expect(classifyFailure("net::ERR_CONNECTION_REFUSED", [])).toBe("network");
    expect(classifyFailure(undefined, [])).toBe("assertion");
  });

  // --- Finding 2 (fix round): an ERR_ASSERTION must never launder into a green RETRIED. ---
  //
  // `netFailures` accumulates for the WHOLE flow with no time window, so one dropped request at
  // step 3 that the app recovered from made a step-40 assertion failure classify as "network" —
  // and, in a flow that had not yet mutated, retried into `RETRIED ... exit 0`. That is exactly the
  // outcome #184 says the gate must prevent.
  describe("an AssertionError hard-overrides the netFailures signal (finding 2)", () => {
    const assertionError = (): unknown => {
      try {
        assert.equal(1, 2, "the surcharge row count");
        return null;
      } catch (err) {
        return err;
      }
    };

    it("is an assertion failure even with a whole flow's worth of dropped requests behind it", () => {
      const err = assertionError();
      expect((err as { code?: string })?.code).toBe("ERR_ASSERTION");
      expect(classifyFailure(err, [netFailure, netFailure, netFailure])).toBe("assertion");
    });

    it("stays an assertion failure when the assertion's own message quotes a network error", () => {
      let err: unknown = null;
      try {
        assert.equal("net::ERR_CONNECTION_REFUSED", "", "the flow asserted on an error string");
      } catch (thrown) {
        err = thrown;
      }
      expect(classifyFailure(err, [netFailure])).toBe("assertion");
    });

    it("still calls a genuine transport failure network-level (the override is not a blanket)", () => {
      const err = new Error("page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3399/x");
      expect((err as { code?: string }).code).toBeUndefined();
      expect(classifyFailure(err, [])).toBe("network");
    });
  });

  // --- Finding 3 (fix round): the two ERR_ABORTED sides must agree. ---
  //
  // `requestfailed` deliberately DROPS net::ERR_ABORTED (a fetch superseded by a navigation, a
  // cancelled preload, a navigation that becomes a download) — but the error-text regex's
  // `net::ERR_` alternation admitted the very same string, so `page.goto` onto a URL that turns
  // into a download classified as network and burned a retry on a deterministic, reproducible bug.
  describe("net::ERR_ABORTED is excluded on BOTH sides (finding 3)", () => {
    it("does not read an aborted navigation as a transport failure", () => {
      const err = new Error("page.goto: net::ERR_ABORTED at http://localhost:3100/api/x/traveler");
      expect(classifyFailure(err, [])).toBe("assertion");
    });

    it("still sees a real net:: error sharing the same message", () => {
      const err = new Error(
        "page.goto: net::ERR_ABORTED at http://localhost:3100/x\n" +
        "Call log:\n  - net::ERR_NETWORK_CHANGED",
      );
      expect(classifyFailure(err, [])).toBe("network");
    });
  });
});

describe("retryRefusal", () => {
  const clean = { kind: "network", committed: 0, indeterminate: 0 };

  it("allows the retry only when the attempt provably changed nothing", () => {
    expect(retryRefusal(clean)).toBeNull();
  });

  it("refuses an assertion failure outright", () => {
    expect(retryRefusal({ ...clean, kind: "assertion" })).toMatch(/assertion failure/);
  });

  it("refuses once anything committed", () => {
    expect(retryRefusal({ ...clean, committed: 4 })).toMatch(/4 mutating request\(s\) already committed/);
  });

  it("refuses a mutating request whose outcome is unknown — the dangerous direction", () => {
    expect(retryRefusal({ ...clean, indeterminate: 1 })).toMatch(/unknown outcome/);
  });
});

// --- Finding 1 (fix round): the mutation counters are blind to page.request.*. ---
//
// `context.on("request"/"response")` only fires for requests issued FROM A PAGE. An
// APIRequestContext call (`page.request.patch(...)`) is issued from the Playwright process and
// produces no context event at all — so a flow could mutate the dev DB with the retry gate's
// counters reading zero, and be retried from step 1. `templates-admin.mjs` already had exactly one
// such call. The sweep below is what makes the next one a decision rather than a silent hole.
describe("findRawApiMutations", () => {
  it("finds a raw mutating APIRequestContext call, with its line number", () => {
    const src = "line one\nconst res = await page.request.patch(url, { data });\nline three\n";
    const found = findRawApiMutations(src);
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(2);
    expect(found[0].method).toBe("patch");
  });

  it("finds every mutating verb, and `fetch` (which carries its own method)", () => {
    for (const verb of ["post", "put", "patch", "delete", "fetch"]) {
      expect(findRawApiMutations(`await page.request.${verb}(u)`)).toHaveLength(1);
    }
  });

  it("finds them on any receiver, not just `page`", () => {
    expect(findRawApiMutations("await context.request.post(u)")).toHaveLength(1);
    expect(findRawApiMutations("await ctx.request.delete(u)")).toHaveLength(1);
  });

  it("flags a second APIRequestContext being built, which would carry its own cookies", () => {
    expect(findRawApiMutations("const api = await request.newContext({})")).toHaveLength(1);
  });

  // #192: the literal-`request`-receiver blind spot. The old regex matched only `request.post(`, so
  // three ways of reaching the very same call slipped past it while producing exactly the state the
  // refusal exists to prevent — a flow that mutated, counters that read zero, a retry granted on it.
  it("flags an ALIASED receiver — `const req = page.request; req.post(u)`", () => {
    expect(findRawApiMutations("const req = page.request;\nawait req.post(u)")).toHaveLength(1);
  });

  it("flags a DESTRUCTURED method — `const {post} = page.request; post(u)`", () => {
    expect(findRawApiMutations("const {post} = page.request;\nawait post(u)")).toHaveLength(1);
  });

  it("flags BRACKET access — `page[\"request\"].post(u)` and its alias", () => {
    expect(findRawApiMutations('await page["request"].post(u)')).toHaveLength(1);
    expect(findRawApiMutations('const r = page["request"];\nawait r.delete(u)')).toHaveLength(1);
  });

  // Codex P1: the capture detector flags the CAPTURE itself, not a fixed assignment shape, so the
  // parenthesized alias, a return, and an argument hand-off — all ways of smuggling the context out —
  // are caught, where an assignment-anchored pattern missed them.
  it("flags a PARENTHESIZED alias, a return, and an argument hand-off", () => {
    expect(findRawApiMutations("const req = (page.request);\nawait req.post(u)")).toHaveLength(1);
    expect(findRawApiMutations("return page.request")).toHaveLength(1);
    expect(findRawApiMutations("archive(page.request, url)")).toHaveLength(1);
  });

  it("flags COMPUTED method access — `page.request[\"post\"](u)` (Codex round 3, P1)", () => {
    expect(findRawApiMutations('await page.request["post"](u)')).toHaveLength(1);
    expect(findRawApiMutations('await page["request"]["delete"](u)')).toHaveLength(1);
    expect(findRawApiMutations('await context.request["patch"](u)')).toHaveLength(1);
  });

  it("flags a DESTRUCTURING capture — `const { request: req } = page` (Codex round 4, P1)", () => {
    expect(findRawApiMutations("const { request: req } = page;\nawait req.post(u)")).toHaveLength(1);
    expect(findRawApiMutations("const { a, request: req, b } = page;")).toHaveLength(1);
    // ...but an object LITERAL (RHS) and a PARAMETER destructure are not captures.
    expect(findRawApiMutations("const config = { request: foo };")).toEqual([]);
    expect(findRawApiMutations('page.route("**", ({ request }) => request.continue());')).toEqual([]);
    // ...and `requestId` is a different identifier.
    expect(findRawApiMutations("const { requestId } = x;")).toEqual([]);
  });

  it("does NOT misread a multi-line inline read as a capture (Codex round 3, P2 — the FP that would refuse a legit wrapped GET)", () => {
    // The continuation test lives INSIDE the lookahead, so the trailing whitespace cannot backtrack
    // the match into a false capture.
    expect(findRawApiMutations("const x = await page.request\n  .get(u)")).toEqual([]);
    expect(findRawApiMutations("page.request .get(u)")).toEqual([]);
    // ...but a multi-line MUTATION is still caught.
    expect(findRawApiMutations("await page.request\n  .post(u)")).toHaveLength(1);
  });

  // ...and the two forms it must NOT confuse with a capture, both all over the current flows.
  it("leaves `res.request()` alone — a response's METHOD, not the APIRequestContext property", () => {
    // ~20 flows read `res.request().method()` off a waited response. `request` there is followed by
    // `(`, not `.`, so it is a method call, never a captured context.
    expect(findRawApiMutations('res.request().method() === "POST"')).toEqual([]);
    expect(findRawApiMutations('res.url().includes("/lines") && res.request().method() === "PUT" && res.ok()')).toEqual([]);
  });

  it("leaves an inline `.request.get(...)` read alone — a trailing `.` is an access, not a capture", () => {
    expect(findRawApiMutations("const response = await page.request.get(exportUrl)")).toEqual([]);
    expect(findRawApiMutations("await (await page.request.get(u)).json()")).toEqual([]);
  });

  it("leaves reads alone — a GET cannot mutate, and the flows read this way constantly", () => {
    expect(findRawApiMutations("const pdf = await page.request.get(url)")).toEqual([]);
    expect(findRawApiMutations("await (await page.request.get(u)).json()")).toEqual([]);
  });

  it("leaves the counted wrapper alone — that is the sanctioned way to do it", () => {
    expect(findRawApiMutations('await ctx.apiMutate(page, url, { method: "PATCH", data })')).toEqual([]);
  });

  it("over-matches rather than under-matches: it fails CLOSED on a commented-out call", () => {
    // Deliberate, the `issuesMutatingRequest` precedent: a sweep that a comment can talk its way
    // past is a sweep that a real call can too. The escape hatch is ctx.apiMutate, not a comment.
    expect(findRawApiMutations("// await page.request.post(u) — disabled for now")).toHaveLength(1);
  });

  it("reports several findings in source order", () => {
    const src = "a\nawait page.request.post(u)\nb\nc\nawait page.request.delete(u)\n";
    expect(findRawApiMutations(src).map((f) => f.line)).toEqual([2, 5]);
  });

  // The guard itself, run centrally rather than only at harness startup — now over flows AND lib
  // (#192), the population run.mjs refuses on.
  it("every swept suite source is clean today", () => {
    expect(sweptSources().length).toBeGreaterThan(0);
    expect(sweep(findRawApiMutations)).toEqual([]);
  });
});

describe("enumerateRoutes", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "e2e-routes-"));
    const write = (rel: string) => {
      mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), "");
    };
    write("page.tsx");
    write("orders/page.tsx");
    write("orders/[id]/page.tsx");
    write("api/orders/route.ts");
    write("api/orders/[id]/loads/[loadId]/route.ts");
    write("orders/layout.tsx");        // not routable
    write("orders/OrdersTable.tsx");   // not routable
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("splits pages from API routes and ignores everything else", async () => {
    const { pages, apis } = await enumerateRoutes(dir);
    expect(pages).toEqual(["/", "/orders", "/orders/e2e-warmup"]);
    expect(apis).toEqual(["/api/orders", "/api/orders/e2e-warmup/loads/e2e-warmup"]);
  });
});

describe("warmupRefusal", () => {
  const budgetMs = 240000;

  it("passes a healthy warm-up", () => {
    expect(warmupRefusal({ count: 243, failures: [], skipped: 0, budgetMs })).toBeNull();
  });

  it("passes a warm-up with a handful of slow routes — a warm-up failure is not fatal", () => {
    const failures = [{ route: "/api/x", error: "TimeoutError" }];
    expect(warmupRefusal({ count: 243, failures, skipped: 0, budgetMs })).toBeNull();
  });

  it("refuses the run when most of the warm-up failed, naming the reason", () => {
    const failures = Array.from({ length: 200 }, () => ({ route: "/api/x", error: "fetch failed" }));
    const refusal = warmupRefusal({ count: 243, failures, skipped: 0, budgetMs });
    expect(refusal).toMatch(/200 of 243/);
    expect(refusal).toMatch(/fetch failed/);
  });

  it("refuses the run when the warm-up blew its aggregate budget", () => {
    const refusal = warmupRefusal({ count: 40, failures: [], skipped: 203, budgetMs });
    expect(refusal).toMatch(/203/);
    expect(refusal).toMatch(/240s/);
  });

  // Was pinned as "says nothing about an empty route set" and returned null. That made it the one
  // shape where the warm-up did NOTHING and the run proceeded anyway, printing `warmed 0 routes` —
  // a phase whose entire job is compiling every route before flow 1 compiling none of them, while
  // every other failure of it refuses. Flipped in the whole-branch review, 2026-08-22.
  it("refuses an empty route set — the warm-up did nothing, which is not a healthy warm-up", () => {
    const refusal = warmupRefusal({ count: 0, failures: [], skipped: 0, budgetMs });
    expect(refusal).toMatch(/no requests at all/);
    expect(refusal).toMatch(/src\/app/);
  });

  // ...but a blown budget still reads as a blown budget, not as an empty enumeration: `skipped`
  // is tested first, and with a zero count the two are otherwise indistinguishable from here.
  it("reports a budget blow-out that issued nothing as a budget blow-out", () => {
    const refusal = warmupRefusal({ count: 0, failures: [], skipped: 243, budgetMs });
    expect(refusal).toMatch(/blew its 240s budget/);
    expect(refusal).toMatch(/243 of 243/);
  });

  // The self-check that replaces "delete the third session-cookie literal" (finding 7). If this
  // file's cookie name ever drifts from the one src/proxy.ts checks, every page 307s to /login and
  // the warm-up compiles nothing while still reporting "warmed 45 pages".
  it("refuses when the warm-up's session cookie stopped defeating the proxy redirect", () => {
    const refusal = warmupRefusal({ count: 243, failures: [], skipped: 0, budgetMs, pages: 45, pagesRedirected: 44 });
    expect(refusal).toMatch(/44 of 45/);
    expect(refusal).toMatch(/SESSION_COOKIE/);
  });

  it("tolerates the odd page redirect — only a broad one means the cookie is wrong", () => {
    expect(warmupRefusal({ count: 243, failures: [], skipped: 0, budgetMs, pages: 45, pagesRedirected: 1 })).toBeNull();
  });

  // #333. A server that answers 404 for the app's own routes is up and serving nothing: every
  // request completes, none fails and none redirects, so no other shape here sees it. One run did
  // exactly that and spent ten minutes failing flows.
  it("refuses when most of the warm-up answered 404, saying how many", () => {
    const refusal = warmupRefusal({ count: 236, failures: [], skipped: 0, budgetMs, pages: 43, notFound: 236 });
    expect(refusal).toMatch(/236 of 236 warm-up requests answered 404/);
    expect(refusal).toMatch(/not serving/);
    // It reports what was measured. The cause of the one recorded case was never established.
    expect(refusal).not.toMatch(/\.next|Turbopack|cache/i);
  });

  it("draws the 404 line at more than half, like the failures beside it", () => {
    const at = (notFound: number) => warmupRefusal({ count: 236, failures: [], skipped: 0, budgetMs, pages: 43, notFound });
    expect([at(0), at(2), at(118)]).toEqual([null, null, null]);
    expect(at(119)).toMatch(/119 of 236/);
  });

  it("names the failures first when a warm-up both failed and answered 404", () => {
    const failures = Array.from({ length: 130 }, () => ({ route: "/api/x", error: "fetch failed" }));
    expect(warmupRefusal({ count: 236, failures, skipped: 0, budgetMs, notFound: 106 })).toMatch(/130 of 236 warm-up requests failed/);
    expect(warmupRefusal({ count: 236, failures: failures.slice(0, 100), skipped: 0, budgetMs, notFound: 136 }))
      .toMatch(/136 of 236 warm-up requests answered 404/);
  });

  it("names the 404s before the /login redirects", () => {
    expect(warmupRefusal({ count: 236, failures: [], skipped: 0, budgetMs, pages: 43, pagesRedirected: 40, notFound: 190 }))
      .toMatch(/answered 404/);
  });
});

// #333. The tally the refusal reads comes from the requests themselves: exactly status 404, and
// nothing else a healthy route answers a bare GET with.
describe("warmRoutes counts the requests that answered 404", () => {
  let dir: string;
  let server: Server;
  let baseURL: string;
  let answer: (url: string) => number;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "e2e-warm-404-"));
    for (const rel of ["page.tsx", "orders/page.tsx", "api/orders/route.ts", "api/health/route.ts", "api/parts/route.ts"]) {
      mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), "");
    }
    server = createServer((request, response) => { response.statusCode = answer(request.url ?? ""); response.end(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  // warmup.mjs is untyped JavaScript, and its default `log` takes no argument as far as tsc can tell.
  const warm = (log: (line: string) => void = () => {}) =>
    warmRoutes(baseURL, dir, { budgetMs: 30000, timeoutMs: 5000, log: log as () => void });

  it("counts every one when the server serves none of the routes, and the run is refused", async () => {
    answer = () => 404;
    const lines: string[] = [];
    const result = await warm((line) => lines.push(line));
    expect([result.count, result.notFound, result.failures.length]).toEqual([5, 5, 0]);
    expect(warmupRefusal(result)).toMatch(/5 of 5 warm-up requests answered 404/);
    expect(lines.filter((line) => line.includes("404"))).toEqual(["  5 route(s) answered 404"]);
  });

  it("counts only 404, never the other answers a healthy route gives a bare GET", async () => {
    const statuses: Record<string, number> = { "/": 200, "/orders": 200, "/api/orders": 401, "/api/parts": 405, "/api/health": 404 };
    answer = (url) => statuses[url];
    const lines: string[] = [];
    const result = await warm((line) => lines.push(line));
    expect([result.count, result.notFound]).toEqual([5, 1]);
    expect(warmupRefusal(result)).toBeNull();
    // A count below the refusal still leaves its line in the run's output.
    expect(lines.filter((line) => line.includes("404"))).toEqual(["  1 route(s) answered 404"]);
  });

  it("says nothing about 404 when no route answered it", async () => {
    answer = () => 200;
    const lines: string[] = [];
    const result = await warm((line) => lines.push(line));
    expect(result.notFound).toBe(0);
    expect(lines.filter((line) => line.includes("404"))).toEqual([]);
  });
});

// #167a. The pre-flight decides whether the dev database can host a run at all. Its whole value is
// being NARROW — a check that refuses a database the suite would in fact have passed on is one
// people start bypassing — so the clean case and each condition in isolation are pinned separately.
describe("preflightRefusal", () => {
  const clean = {
    year: 2026, month: 8, closePeriodStatus: null,
    preliminaryError: null, unpostedBatchCount: 0, variance: 0, readinessGaps: [],
  };

  it("passes a dev database with nothing ambient in the way", () => {
    expect(preflightRefusal(clean)).toBeNull();
  });

  it("refuses an OPEN receipt batch dated in the target month, with the count as evidence", () => {
    const refusal = preflightRefusal({ ...clean, unpostedBatchCount: 1, variance: 1250 });
    expect(refusal).toMatch(/1 OPEN receipt batch/);
    expect(refusal).toMatch(/2026-08/);
    expect(refusal).toMatch(/npm run db:reset/);
  });

  it("refuses a ClosePeriod already covering the target month, whatever its status", () => {
    expect(preflightRefusal({ ...clean, closePeriodStatus: "CLOSED" })).toMatch(/ClosePeriod row already covers/);
    expect(preflightRefusal({ ...clean, closePeriodStatus: "REOPENED" })).toMatch(/REOPENED/);
  });

  it("refuses a schedule that does not reconcile, and prints the variance", () => {
    expect(preflightRefusal({ ...clean, variance: -6750 })).toMatch(/variance -6750/);
  });

  it("collects every reason rather than short-circuiting on the first — they share one fix", () => {
    const refusal = preflightRefusal({
      year: 2026, month: 8, closePeriodStatus: "CLOSED", unpostedBatchCount: 2, variance: 1250,
    });
    expect(refusal).toMatch(/ClosePeriod/);
    expect(refusal).toMatch(/2 OPEN receipt batch/);
    expect(refusal).toMatch(/variance 1250/);
    expect(refusal!.split("\n  - ")).toHaveLength(4);   // the header plus three reasons
  });

  // The half that matters most: surcharges were half of #167 and are deliberately NOT a condition
  // here, because invoice-shipped-order now counts only its own surcharge row. A pre-flight that
  // over-refuses is a pre-flight people disable.
  it("says nothing about anything it is not responsible for", () => {
    const refusal = preflightRefusal(clean);
    expect(refusal).toBeNull();
  });

  it("names both directions of the recipe, since the refusal is the only place a developer reads it", () => {
    const refusal = preflightRefusal({ ...clean, unpostedBatchCount: 1 });
    expect(refusal).toMatch(/db:reset/);
    expect(refusal).toMatch(/docs\/manual\/dataset\.md/);
  });

  // The recipe has to WORK in the session that reads it. `db:reset` confirms before it truncates,
  // and a non-interactive shell (an agent, CI, a script) cannot be asked — so the flag form is
  // printed beside the bare one rather than left for the reader to discover from a second refusal.
  it("prints the non-interactive form of the recipe too, because db:reset now confirms", () => {
    const refusal = preflightRefusal({ ...clean, unpostedBatchCount: 1 });
    expect(refusal).toMatch(/npm run db:reset -- --yes/);
  });

  // --- Fix round. ---

  // #167a fix round, finding 3. `preliminaryReport` does not always ANSWER: `priorEndingAr` throws
  // 409 when an earlier month is closed and the immediately-prior one is not. The demonstration
  // dataset closes the month before its seed date, so it produces exactly that the moment the
  // calendar rolls over. Unwrapped it surfaced as an execFileSync "Command failed" and a raw stack.
  it("turns the close service REFUSING to report into a reason, not a stack trace", () => {
    const refusal = preflightRefusal({
      ...clean, preliminaryError: "The prior period 2026-08 is not closed",
    });
    expect(refusal).toMatch(/refuses to report on 2026-08 at all/);
    expect(refusal).toMatch(/The prior period 2026-08 is not closed/);
    expect(refusal).toMatch(/npm run db:reset/);
  });

  it("says the batch and variance figures were not computed rather than reporting them as clean", () => {
    // They are the probe's zero defaults in this state. Printing "0 unposted, variance 0" beside a
    // refusal to report would be the same lie in a smaller font.
    const refusal = preflightRefusal({ ...clean, preliminaryError: "The prior period 2026-07 is not closed" });
    expect(refusal).toMatch(/were NOT computed and are not being reported/);
    expect(refusal!.split("\n  - ")).toHaveLength(2);   // the header plus exactly one reason
  });

  // Finding 1 (minor). `readinessGaps.length === 0` is close-month-end's FOURTH plant-wide
  // assertion and was the one the pre-flight did not hoist.
  it("refuses ambient GL-export readiness gaps, and names them", () => {
    const refusal = preflightRefusal({
      ...clean,
      readinessGaps: ["Invoice 1042 has a line with no GL account — unlock and re-finalize it"],
    });
    expect(refusal).toMatch(/1 GL-export readiness gap/);
    expect(refusal).toMatch(/Invoice 1042/);
  });

  it("caps the named gaps rather than printing a hundred of them, and says how many it hid", () => {
    const gaps = Array.from({ length: 8 }, (_, i) => `Invoice ${1000 + i} has a line with no GL account`);
    const refusal = preflightRefusal({ ...clean, readinessGaps: gaps });
    expect(refusal).toMatch(/8 GL-export readiness gap/);
    expect(refusal).toMatch(/and 3 more/);
  });

  // Finding 4 (minor). `runDbScript` returns null when the probe printed nothing, and the old
  // signature destructured it — a TypeError inside the harness instead of a diagnosis.
  it("diagnoses a probe that answered with nothing instead of throwing a TypeError", () => {
    for (const bad of [null, undefined]) {
      const refusal = preflightRefusal(bad);
      expect(refusal).toMatch(/produced no readable answer/);
      expect(refusal).toMatch(/npx tsx e2e\/lib\/db-fixtures\.ts preflight/);
    }
  });

  it("still passes a clean probe that predates the two new fields", () => {
    // The probe and the policy ship together, but the policy must not depend on that: both new
    // fields default, so an older answer reads as clean rather than as a crash.
    expect(preflightRefusal({ year: 2026, month: 8, closePeriodStatus: null, unpostedBatchCount: 0, variance: 0 }))
      .toBeNull();
  });
});

// #167a fix round. The two sweeps in `e2e/lib/flow-lint.mjs` answer the question the retry gate
// does not: can a GREEN run be green while the thing it asserts is broken? Both shapes below were
// found in code that had already been reviewed, and both PASS rather than fail — which is why
// neither can be left to a census by hand. Enforced twice, the `findRawApiMutations` precedent:
// `run.mjs` refuses before flow 1, and the corpus sweeps at the bottom of each block run centrally.
describe("findAmbientRowLocators", () => {
  it("finds a board row locator taken off `page` and filtered by an order number", () => {
    const src = 'a\nconst row = page.locator("tr", { hasText: String(created.orderNumber) });\n';
    const found = findAmbientRowLocators(src);
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(2);
  });

  it("finds every unscoped row shape, including the tbody and role forms", () => {
    expect(findAmbientRowLocators('page.locator("tbody tr").filter({ hasText: String(order.number) });')).toHaveLength(1);
    expect(findAmbientRowLocators('page.locator("table tbody tr", { hasText: `${orderNumber}` });')).toHaveLength(1);
    expect(findAmbientRowLocators('page.getByRole("row", { name: String(orderNumber) });')).toHaveLength(1);
  });

  it("reads the whole STATEMENT, so a chained multi-line locator cannot hide the filter", () => {
    const src = 'const r = page.locator("tr")\n  .filter({ has: page.getByText(String(order.number), { exact: true }) });\n';
    expect(findAmbientRowLocators(src)).toHaveLength(1);
  });

  it("leaves a SCOPED row locator alone — that family is narrower and was left as found-not-fixed", () => {
    expect(findAmbientRowLocators(
      'readySection.locator("tr").filter({ has: page.getByText(String(order.number), { exact: true }) });',
    )).toEqual([]);
    expect(findAmbientRowLocators('receivables.locator("tbody tr").filter({ hasText: String(order.number) }).first();'))
      .toEqual([]);
  });

  it("leaves an unscoped row locator alone when it filters on something no other column prints", () => {
    // invoice-shipped-order's surcharge row and close-month-end's payment row: correct as written.
    expect(findAmbientRowLocators('page.locator("tr").filter({ has: page.locator("td", { hasText: "Surcharge" }) });'))
      .toEqual([]);
    expect(findAmbientRowLocators('page.locator("tr").filter({ has: page.getByText(fixtures.closePaymentTypeName) });'))
      .toEqual([]);
  });

  it("over-matches rather than under-matches: it fails CLOSED on a commented-out locator", () => {
    // The `findRawApiMutations` rule. The escape hatch is boardRow(), never a comment — which is
    // why board-search-scan.mjs describes the old shape in prose instead of quoting it.
    expect(findAmbientRowLocators('// const row = page.locator("tr", { hasText: String(orderNumber) });'))
      .toHaveLength(1);
  });

  it("every swept suite source uses boardRow today (flows AND the lib helpers, #192)", () => {
    expect(sweptSources().length).toBeGreaterThan(0);
    expect(sweep(findAmbientRowLocators)).toEqual([]);
  });
});

describe("findUncheckedAbsenceAssertions", () => {
  it("finds assert.rejects wrapped around a waitFor — the false-green absence assertion", () => {
    const src = 'x\nawait assert.rejects(\n  row.waitFor({ state: "visible", timeout: 1500 }),\n  "gone",\n);\n';
    const found = findUncheckedAbsenceAssertions(src);
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(2);
  });

  it("leaves assert.rejects around anything that is not a waitFor alone", () => {
    // Only the waitFor pairing can launder a strict-mode violation into a pass: "no such element"
    // and "several such elements" both reject there. A route that must 403 is a different thing.
    expect(findUncheckedAbsenceAssertions('await assert.rejects(lockRevision(id, 2), /409/);')).toEqual([]);
  });

  it("leaves the sanctioned helper alone", () => {
    expect(findUncheckedAbsenceAssertions('await assertNeverVisible(row, "should be gone", 500);')).toEqual([]);
  });

  it("over-matches rather than under-matches: it fails CLOSED on a commented-out assertion", () => {
    expect(findUncheckedAbsenceAssertions('// await assert.rejects(row.waitFor({ state: "visible" }));'))
      .toHaveLength(1);
  });

  it("every swept suite source states absence through assertNeverVisible today (flows AND lib, #192)", () => {
    expect(sweptSources().length).toBeGreaterThan(0);
    expect(sweep(findUncheckedAbsenceAssertions)).toEqual([]);
  });
});

// #193. The third false-green shape: a code-less Error minted as a flow failure carries no
// ERR_ASSERTION code, so classifyFailure's hard override (above) does not cover it and a stale
// netFailure earlier in the flow can launder it into FAIL [network] and a granted retry.
describe("findPlainErrorFailures", () => {
  it("finds a throw new Error, with its line number", () => {
    const src = 'line one\nif (!x) throw new Error("boom");\nline three\n';
    const found = findPlainErrorFailures(src);
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(2);
  });

  it("finds any built-in Error subclass, not just Error", () => {
    expect(findPlainErrorFailures('throw new TypeError("x")')).toHaveLength(1);
    expect(findPlainErrorFailures('throw new RangeError("x")')).toHaveLength(1);
  });

  it("finds the no-`new` and QUALIFIED forms too — all mint the identical code-less Error", () => {
    // Fails CLOSED on every equivalent idiom (Codex round 1, P1/P2).
    expect(findPlainErrorFailures('if (!x) throw Error("boom")')).toHaveLength(1);
    expect(findPlainErrorFailures('throw TypeError("x")')).toHaveLength(1);
    expect(findPlainErrorFailures('throw new globalThis.Error("x")')).toHaveLength(1);
    expect(findPlainErrorFailures('throw new errors.TimeoutError("x")')).toHaveLength(1);
    // ...but `throwError(...)` (a function call, no space) is not a throw statement.
    expect(findPlainErrorFailures("throwError(msg)")).toEqual([]);
  });

  it("finds a code-less Error delivered through a promise `reject(...)` (Codex round 2, P2)", () => {
    // A dialog handler that `reject(new Error(...))`s reaches classifyFailure with the same code-less
    // Error a throw would — so the sweep covers the reject verb too.
    expect(findPlainErrorFailures("reject(new Error(`got ${type}`))")).toHaveLength(1);
    expect(findPlainErrorFailures(".finally(() => reject(new Error(msg)))")).toHaveLength(1);
    expect(findPlainErrorFailures("Promise.reject(new TypeError(msg))")).toHaveLength(1);
  });

  it("finds a PARENTHESIZED delivery — `throw (new Error())` / `reject((new TypeError()))` (Codex round 3, P2)", () => {
    expect(findPlainErrorFailures('throw (new Error("boom"))')).toHaveLength(1);
    expect(findPlainErrorFailures('reject((new TypeError("boom")))')).toHaveLength(1);
  });

  it("leaves an AssertionError alone — the sanctioned promise-side fix carries ERR_ASSERTION", () => {
    expect(findPlainErrorFailures("reject(new assert.AssertionError({ message: msg }))")).toEqual([]);
    expect(findPlainErrorFailures("throw new AssertionError({ message: msg })")).toEqual([]);
  });

  it("leaves a re-raise alone — `throw err` / `reject(err)` preserve the original classification", () => {
    // assertNeverVisible re-throws a transport error untouched so the harness still sees it as
    // itself; only a freshly minted code-less Error is the problem.
    expect(findPlainErrorFailures("try { a(); } catch (err) { throw err; }")).toEqual([]);
    expect(findPlainErrorFailures("dialog.accept().catch((err) => reject(err))")).toEqual([]);
  });

  it("leaves the sanctioned replacements alone", () => {
    expect(findPlainErrorFailures('assert.fail("boom")')).toEqual([]);
    expect(findPlainErrorFailures('assert.ok(match, "could not parse")')).toEqual([]);
  });

  it("over-matches rather than under-matches: it fails CLOSED on a commented-out throw", () => {
    expect(findPlainErrorFailures('// throw new Error("disabled for now")')).toHaveLength(1);
  });

  it("every swept suite source delivers failures through node:assert today (flows AND lib, #193)", () => {
    expect(sweptSources().length).toBeGreaterThan(0);
    expect(sweep(findPlainErrorFailures)).toEqual([]);
  });
});

// #342. A page's last route going turns Playwright's interception off, and a request issued in that
// instant never settles. Suite sources register routes through e2e/route-keep-alive.mjs only.
describe("findRawRouteCalls", () => {
  it("finds a route registered or removed on a page, with its line number", () => {
    const found = findRawRouteCalls("line one\nawait page.route(url, handler);\nawait page.unroute(url, handler);\n");
    expect(found.map((hit) => hit.line)).toEqual([2, 3]);
    expect(found[0].snippet).toContain("page.route(url, handler)");
  });

  it("covers every routing method, on any receiver", () => {
    for (const call of ["page.route(u, h)", "page.unroute(u, h)", "page.unrouteAll()", "page.routeFromHAR(file)",
      "page.routeWebSocket(u, h)", "context.route(u, h)", "ctx.page.unroute(u, h)", "popup.route(u, h)",
      "(await opened).route(u, h)"]) {
      expect(findRawRouteCalls(`await ${call};`), call).toHaveLength(1);
    }
  });

  it("is not evaded by a line break, a bracket, bind, an alias or a destructuring", () => {
    for (const source of ["await page\n  .route(u, h)", "await page . route (u, h)", 'await page["route"](u, h)',
      "await page['unroute'](u, h)", "await page[`route`](u, h)", "const add = page.route.bind(page);",
      "page.unroute.call(page, u, h)", "page.route.apply(page, [u, h])", "const add = page.route;",
      "const add = (page.route)\n", "let add; add = ctx.page.unroute,", "const { route } = page;",
      "const { a, unroute: stop, b } = popup;", "const add = page.route\nawait add(u, h);\n",
      "const add = page.route // alias", "const add = page.route /* later */;", "const add = pages[0].route;",
      "const add = popup().unroute;", "const add = (await opened).route;", "const add = page?.route;",
      "await page?.route(u, h)", "await page.context().route(u, h)"]) {
      expect(findRawRouteCalls(source), source).toHaveLength(1);
    }
  });

  it("leaves the helper, a handler's own parameter and a data field of that name alone", () => {
    for (const source of ["const stop = await routeRequests(page, u, h);\nawait stop();",
      "const handler = (route) => route.continue();", "({ route }) => route.abort()",
      "route.fulfill({ response })", "route.request().method()", "const { request } = route;",
      "failures[0].route", "results.map((r) => `${r.route} ${r.ms}`)", "warmOne(baseURL, queue[i].route, x)",
      "if (a.route === b.route) return;", "x.routes.length", "const routed = page.url();",
      "if ({ route: 1 } === x) y();", "const same = { route } == other;",
      "const x = await warmOne(baseURL, queue[i].route, y);"]) {
      expect(findRawRouteCalls(source), source).toEqual([]);
    }
  });

  it("over-matches rather than under-matches: it fails CLOSED on a commented-out call", () => {
    expect(findRawRouteCalls("// await page.unroute(url, handler);")).toHaveLength(1);
  });

  it("also refuses a data field of that name that is assigned whole or destructured", () => {
    for (const source of ["const path = entry.route;", "const { route: path } = result;"]) {
      expect(findRawRouteCalls(source), source).toHaveLength(1);
    }
  });

  it("every swept suite source registers its routes through the helper today (flows AND lib)", () => {
    expect(sweptSources().length).toBeGreaterThan(0);
    expect(sweep(findRawRouteCalls)).toEqual([]);
  });

  it("the helper sits outside the swept set, and is the one module there that routes", () => {
    expect(sweptSources().some(({ relPath }) => relPath.includes("route-keep-alive"))).toBe(false);
    const helper = readFileSync(path.join(E2E_DIR, "route-keep-alive.mjs"), "utf8");
    expect(findRawRouteCalls(helper).length).toBeGreaterThan(0);
    const users = sweptSources().filter(({ source }) => /\brouteRequests\s*\(/.test(source));
    expect(users.length).toBeGreaterThan(0);
    for (const { relPath, source } of users) {
      expect(source, relPath).toMatch(/import \{[^}]*\brouteRequests\b[^}]*\} from "\.\.\/route-keep-alive\.mjs";/);
    }
  });
});

// #843. A read through the request context rides a pooled keep-alive socket the server closes
// after 6 s idle; a reuse landing on that close resets, and a flow that has mutated is red with no
// retry (`close-month-end` on #842). Every read in a swept suite source asks for one retry.
describe("findBareReads", () => {
  it("finds a read that asks for no retry, with its line number", () => {
    const found = findBareReads("line one\nconst res = await page.request.get(url);\nline three\n");
    expect(found.map((hit) => hit.line)).toEqual([2]);
    expect(found[0].snippet).toContain("page.request.get(url)");
  });

  it("leaves a read that asks for one retry alone, on one line or wrapped, by dot or bracket", () => {
    for (const source of ["await page.request.get(url, { maxRetries: 1 });",
      "const res = await page.request.get(\n  `${base}/api/x?${q}`,\n  { maxRetries: 1 },\n);",
      "await ctx.page.request.get(url, { headers, maxRetries: 1 });",
      'await page.request["get"](url, { maxRetries: 1 });',
      "const body = await (await page.request.get(url, { maxRetries: 1 })).body();"]) {
      expect(findBareReads(source), source).toEqual([]);
    }
  });

  it("refuses any other retry count, a bound or aliased method and a bracket access", () => {
    for (const source of ["await page.request.get(url, { maxRetries: 2 });", "await page.request.get(url, { maxRetries: 0 });",
      "await page.request.get(url, { maxRetries: 10 });", "await page.request.get(url, {});",
      'await page.request["get"](url);', "await page.request[`get`](url);", "const read = page.request.get.bind(page.request);",
      "const read = page.request.get;", "await page.request\n  .get(url);"]) {
      expect(findBareReads(source), source).toHaveLength(1);
    }
  });

  it("reads only the call's own argument list: another read's option in the same statement covers nothing (Codex, #846)", () => {
    expect(findBareReads("await page.request.get(a);\nawait page.request.get(b, { maxRetries: 1 });")).toHaveLength(1);
    for (const source of ["await Promise.all([page.request.get(a), page.request.get(b, { maxRetries: 1 })]);",
      "await Promise.all([page.request.get(b, { maxRetries: 1 }), page.request.get(a)]);",
      "const [x, y] = await Promise.all([\n  page.request.get(a),\n  page.request.get(b, { maxRetries: 1 }),\n]);"]) {
      const found = findBareReads(source);
      expect(found.map((hit) => hit.snippet.includes("get(a)")), source).toEqual([true]);
    }
    // Both asking: clean. A quoted paren in the first list does not swallow the second.
    expect(findBareReads("await Promise.all([page.request.get(a, { maxRetries: 1 }), page.request.get(b, { maxRetries: 1 })]);")).toEqual([]);
    expect(findBareReads('await Promise.all([page.request.get(":(", { maxRetries: 1 }), page.request.get(b)]);')).toHaveLength(1);
  });

  it("reaches the context by bracket access too (Codex, #846, third round)", () => {
    for (const source of ['await page["request"].get(url);', "await page['request'].get(url);", 'await page["request"]["get"](url);',
      "await ctx.page[`request`].get(url);", 'await page["request"]\n  .get(url);']) {
      expect(findBareReads(source), source).toHaveLength(1);
    }
    for (const source of ['await page["request"].get(url, { maxRetries: 1 });', 'await page["request"]["get"](url, { maxRetries: 1 });']) {
      expect(findBareReads(source), source).toEqual([]);
    }
  });

  it("accepts the option only at the top level of an argument, never nested in data (Codex, #846, third round)", () => {
    for (const source of ["await page.request.get(url, { params: { maxRetries: 1 } });",
      "await page.request.get(url, { headers: { maxRetries: 1 }, params: q });",
      "await page.request.get(url, options({ maxRetries: 1 }));", "await page.request.get(url, [{ maxRetries: 1 }]);",
      "await page.request.get(url, { params: { retries: 1 }, maxRetries: 2 });",
      "await page.request.get(`${base}/${f({ maxRetries: 1 })}`);"]) {
      expect(findBareReads(source), source).toHaveLength(1);
    }
    for (const source of ["await page.request.get(url, { headers: h, maxRetries: 1 });",
      "await page.request.get(url, { maxRetries: 1, params: { maxRetries: 2 } });",
      "await page.request.get(url, {\n  params: { q },\n  maxRetries: 1,\n});",
      "await page.request.get(url, { params: { label: \"(\" }, maxRetries: 1 });"]) {
      expect(findBareReads(source), source).toEqual([]);
    }
  });

  it("accepts the option only in an object literal that is itself an argument, never one inside an expression (Codex, #846, eighth round)", () => {
    for (const source of ["await page.request.get(url, retryEnabled ? { maxRetries: 1 } : {});", "await page.request.get(url, retryEnabled ? {} : { maxRetries: 1 });",
      "await page.request.get(url, options || { maxRetries: 1 });", "await page.request.get(url, options ?? { maxRetries: 1 });",
      "await page.request.get(url, (cond && { maxRetries: 1 }) || {});", "await page.request.get(url, { ...({ maxRetries: 1 }) });"]) {
      expect(findBareReads(source), source).toHaveLength(1);
    }
    for (const source of ["await page.request.get(url, { maxRetries: 1 });", "await page.request.get(url,{maxRetries:1});",
      "await page.request.get(url,\n  { maxRetries: 1 },\n);", "await page.request.get(cond ? a : b, { maxRetries: 1 });",
      "await page.request.get(url, { headers: cond ? h : {}, maxRetries: 1 });"]) {
      expect(findBareReads(source), source).toEqual([]);
    }
  });

  it("lets a later spread or a later duplicate key override the option, as the runtime does (Codex, #846, seventh round)", () => {
    for (const source of ["await page.request.get(url, { maxRetries: 1, ...options });", "await page.request.get(url, { maxRetries: 1, maxRetries: 2 });",
      "await page.request.get(url, { maxRetries: 1, ...(fast ? {} : slow) });", "await page.request.get(url, {\n  maxRetries: 1,\n  ...rest,\n});"]) {
      expect(findBareReads(source), source).toHaveLength(1);
    }
    for (const source of ["await page.request.get(url, { ...options, maxRetries: 1 });", "await page.request.get(url, { maxRetries: 1, ...options, maxRetries: 1 });",
      "await page.request.get(url, { maxRetries: 2, maxRetries: 1 });", "await page.request.get(url, { maxRetries: 1, params: { ...p } });",
      "await page.request.get(url, { maxRetries: 1, headers: h(...parts) });"]) {
      expect(findBareReads(source), source).toEqual([]);
    }
  });

  it("accepts the literal 1 as the whole value, never an expression starting with it (Codex, #846, sixth round)", () => {
    for (const source of ["await page.request.get(url, { maxRetries: 1 - 1 });", "await page.request.get(url, { maxRetries: 1 + 1 });",
      "await page.request.get(url, { maxRetries: 10 });", "await page.request.get(url, { maxRetries: 1.5 });",
      "await page.request.get(url, { maxRetries: 1 ? 2 : 3 });", "await page.request.get(url, { maxRetries: 1e1 });"]) {
      expect(findBareReads(source), source).toHaveLength(1);
    }
    for (const source of ["await page.request.get(url, { maxRetries: 1 });", "await page.request.get(url, { maxRetries: 1, a: 2 });",
      "await page.request.get(url, { maxRetries: 1 /* once */ });", "await page.request.get(url, { maxRetries: 1 // once\n});",
      "await page.request.get(url, {\n  maxRetries: 1\n});"]) {
      expect(findBareReads(source), source).toEqual([]);
    }
  });

  it("does not read regex literals: a `)` inside one closes the list early, which is the safe direction (ruled a limitation, round six)", () => {
    // The walker knows strings, templates and comments, not regex literals (telling `/` from
    // division needs a tokenizer). A protected read written this way is reported bare, never the
    // reverse, and the escape is a const: `const path = url.replace(/\\)/g, "");` before the call.
    expect(findBareReads("await page.request.get(url.replace(/\\)/g, ''), { maxRetries: 1 });")).toHaveLength(1);
    expect(findBareReads("const path = url.replace(/\\)/g, '');\nawait page.request.get(path, { maxRetries: 1 });")).toEqual([]);
  });

  it("accepts the whole property name only, never a longer one ending in it (Codex, #846, fifth round)", () => {
    for (const source of ["await page.request.get(url, { mymaxRetries: 1 });", "await page.request.get(url, { $maxRetries: 1 });",
      "await page.request.get(url, { _maxRetries: 1 });", "await page.request.get(url, { maxRetries2: 1 });",
      "await page.request.get(url, { maxRetriesX: 1 });"]) {
      expect(findBareReads(source), source).toHaveLength(1);
    }
    for (const source of ["await page.request.get(url, {maxRetries:1});", "await page.request.get(url, { a: 1,maxRetries: 1 });",
      "await page.request.get(url, {\n\tmaxRetries: 1,\n});"]) {
      expect(findBareReads(source), source).toEqual([]);
    }
  });

  it("reads a comment inside the list as a comment, not as the option (Codex, #846, fourth round)", () => {
    for (const source of ["await page.request.get(url, { /* maxRetries: 1 */ });",
      "await page.request.get(url, {\n  // maxRetries: 1,\n});",
      "await page.request.get(url, { params: q, // maxRetries: 1\n});"]) {
      expect(findBareReads(source), source).toHaveLength(1);
    }
    for (const source of ["await page.request.get(url, { maxRetries: 1 /* once */ });",
      "await page.request.get(url, { // the retry\n  maxRetries: 1,\n});",
      "await page.request.get(url /* ) */, { maxRetries: 1 });",
      'await page.request.get("http://x/y", { params: "//", maxRetries: 1 });',
      "await page.request.get(`${base}/a//b`, { maxRetries: 1 });"]) {
      expect(findBareReads(source), source).toEqual([]);
    }
  });

  it("reads a template literal's text as text, its interpolations as code (Codex, #846, second round)", () => {
    // A literal paren in the URL text neither closes the list early nor extends it into the next call.
    for (const source of ["await page.request.get(`${baseURL}/api/search?q=part)`, { maxRetries: 1 });",
      "await page.request.get(`${baseURL}/api/x?q=(`, { maxRetries: 1 });",
      "await page.request.get(`${base}/api/${enc(\")\")}/rows`, { maxRetries: 1 });",
      "await page.request.get(`${base}/${a ? `${b})` : c}`, { maxRetries: 1 });"]) {
      expect(findBareReads(source), source).toEqual([]);
    }
    for (const source of ["await Promise.all([page.request.get(`${base}/x(`), page.request.get(b, { maxRetries: 1 })]);",
      "await Promise.all([page.request.get(`${base}/${f(`(`)}`), page.request.get(b, { maxRetries: 1 })]);"]) {
      const found = findBareReads(source);
      expect(found.map((hit) => hit.line), source).toEqual([1]);
      expect(found[0].snippet, source).toContain("get(`${base}");
    }
  });

  it("over-matches rather than under-matches: it fails CLOSED on a commented-out call", () => {
    expect(findBareReads("// const res = await page.request.get(url);")).toHaveLength(1);
  });

  it("reads nothing into a write, which findRawApiMutations owns, nor into a data field named get", () => {
    for (const source of ["await ctx.apiMutate(page, url, { method: 'PUT', data, idempotent: true });",
      "const res = await page.request.fetch(url, { method, maxRetries: 1 });", "map.get(key)", "requests.get(id)",
      "const { get } = headers;", "x.request().get"]) {
      expect(findBareReads(source), source).toEqual([]);
    }
  });

  it("every swept suite source asks for one retry on each read today (flows AND lib)", () => {
    expect(sweptSources().length).toBeGreaterThan(0);
    expect(sweep(findBareReads)).toEqual([]);
  });

  it("the warming GET of api-mutate.mjs, outside the swept set, asks for it too", () => {
    const helper = readFileSync(path.join(E2E_DIR, "api-mutate.mjs"), "utf8");
    expect(/\brequest\s*\.\s*get\b/.test(helper)).toBe(true);
    expect(findBareReads(helper)).toEqual([]);
  });
});

// #192. The file set the sweeps read is the SHARED one from suite-sources.mjs — flows AND lib, minus
// the two detector modules — so a bad locator/mutation/absence/throw written into a shared helper is
// caught, and the same population is refused at both enforcement points.
describe("suiteSourcesSync (the swept file set, #192)", () => {
  const sources = suiteSourcesSync(E2E_DIR);
  const rels = sources.map((s) => s.relPath);

  it("includes the flow files AND the lib helpers", () => {
    expect(rels).toContain("flows/order-entry-full.mjs");
    // The two homes of the sanctioned helpers a bad edit would slip into — the whole point of #192.
    expect(rels).toContain("lib/orders.mjs"); // boardRow
    expect(rels).toContain("lib/ui.mjs"); // assertNeverVisible
  });

  it("excludes ONLY the two detector modules, which hold the patterns as literals", () => {
    expect(rels).not.toContain("lib/flow-lint.mjs");
    expect(rels).not.toContain("lib/failure-classify.mjs");
    // Nothing else is excluded — e.g. the lister itself is swept.
    expect(rels).toContain("lib/suite-sources.mjs");
  });

  it("carries each file's source, keyed by an e2e-relative path a refusal can print", () => {
    const ui = sources.find((s) => s.relPath === "lib/ui.mjs");
    expect(ui?.source).toContain("assertNeverVisible");
  });
});

// #190. The two harness OUTPUT surfaces a CI retry gate reads: a retried flow's artifacts land in
// `e2e-artifacts/<flow>__attempt-<n>`, and its results line starts `  RETRIED `. The private
// repository pins these against its own CI verdict script; this source ships no such script, so
// only the shapes themselves are pinned here.
describe("attemptDir / resultsLine (the CI retry-gate surfaces, #190)", () => {
  it("attempt 1 keeps the bare directory; a retry gets its own sibling", () => {
    expect(attemptDir("void-order", 1)).toBe("void-order");
    expect(attemptDir("void-order", 2)).toBe("void-order__attempt-2");
  });

  it("prints a retried flow as a RETRIED line, which neither a pass nor a failure starts with", () => {
    expect(resultsLine({ name: "close-month-end", ok: true, retried: true })).toMatch(/^  RETRIED /);
    expect(resultsLine({ name: "quotes", ok: true, retried: false })).not.toMatch(/^  RETRIED /);
    expect(resultsLine({ name: "void-order", ok: false, retried: false, kind: "assertion", committed: 0, indeterminate: 0 })).not.toMatch(/^  RETRIED /);
  });

  it("never prints a retried flow as a plain PASS, and a failure reads FAIL with its reason", () => {
    expect(resultsLine({ name: "quotes", ok: true, retried: false }).startsWith("  PASS   ")).toBe(true);
    const failed = resultsLine({ name: "void-order", ok: false, retried: false, kind: "assertion", committed: 0, indeterminate: 0 });
    expect(failed.startsWith("  FAIL   ")).toBe(true);
    expect(failed).toMatch(/assertion-level/);
  });
});
