import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type RequestListener } from "node:http";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { advanceCheck, appJwt, fetchJson, firingComment, heartbeatBody, openIncidents, recoveryComment, validateConfig, runCycle, diskHealth,
  waitSeconds } from "../scripts/monitor-health.mjs";

const servers: Server[] = [];
const dirs: string[] = [];
async function server(handler: RequestListener) {
  const srv = createServer(handler); servers.push(srv);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const address = srv.address(); if (!address || typeof address === "string") throw new Error("test listener address missing");
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((resolve) => s.close(() => resolve())); }
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const time = (n: number) => new Date(Date.UTC(2026, 8, 9, 12, n)).toISOString();
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
function readJwt(token: string) {
  const [header, payload, signature] = token.split(".");
  return {
    signed: createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(keys.publicKey, signature, "base64url"),
    header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { iss: string; iat: number; exp: number },
  };
}

describe("monitor transition policy", () => {
  it("requires three failed samples, then two successes to resolve", () => {
    let s = advanceCheck(undefined, false, time(0));
    expect(s.incident).toBeUndefined();
    s = advanceCheck(s, false, time(1)); expect(s.incident).toBeUndefined();
    s = advanceCheck(s, false, time(2)); expect(s.incident?.start_time).toBe(time(0));
    const fingerprint = s.incident!.fingerprint;
    s = advanceCheck(s, false, time(3)); expect(s.incident?.fingerprint).toBe(fingerprint);
    s = advanceCheck(s, true, time(4)); expect(s.incident?.end_time).toBeUndefined();
    s = advanceCheck(s, true, time(5)); expect(s.incident?.end_time).toBe(time(5));
  });
  it("unknown observations cannot resolve an existing failure", () => {
    let s; for (let i = 0; i < 3; i++) s = advanceCheck(s, false, time(i));
    expect(advanceCheck(s, null, time(3))).toEqual(s);
  });
  it("starts a new incident when a check whose firing was delivered fails again after it ended", () => {
    let s; for (let i = 0; i < 3; i++) s = advanceCheck(s, false, time(i));
    s!.incident!.firingSent = true; s!.incident!.recoveryTried = time(5);
    s = advanceCheck(advanceCheck(s, true, time(3)), true, time(4));
    const ended = s.incident!;
    expect(ended.end_time).toBe(time(4));
    for (let i = 5; i < 8; i++) s = advanceCheck(s, false, time(i));
    expect(s.incident).toEqual({ fingerprint: expect.not.stringMatching(ended.fingerprint), start_time: time(5), firingSent: false });
  });
  it("keeps the incident when its firing never left: it ends, fails again, and still owes that one firing", () => {
    let s; for (let i = 0; i < 3; i++) s = advanceCheck(s, false, time(i));
    s!.incident!.firingTried = time(2);
    const fingerprint = s!.incident!.fingerprint;
    s = advanceCheck(advanceCheck(s, true, time(3)), true, time(4));
    for (let i = 5; i < 8; i++) s = advanceCheck(s, false, time(i));
    expect(s.incident).toEqual({ fingerprint, start_time: time(0), firingSent: false, firingTried: time(2) });
  });
  it("resets a transient failure before it opens an incident", () => {
    let s = advanceCheck(undefined, false, time(0));
    s = advanceCheck(s, true, time(1));
    s = advanceCheck(s, false, time(2));
    expect(s.failures).toBe(1); expect(s.incident).toBeUndefined();
  });
});

describe("bounded monitor transport", () => {
  it("rejects redirects without forwarding the bearer credential", async () => {
    let targetHits = 0;
    const target = await server((_req, res) => { targetHits++; res.end("{}"); });
    const origin = await server((_req, res) => { res.writeHead(302, { location: target }); res.end(); });
    await expect(fetchJson(origin, { token: "private-token", timeoutMs: 500 })).rejects.toThrow();
    expect(targetHits).toBe(0);
  });
  it("bounds a stalled response body as well as connection time", async () => {
    const url = await server((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); });
    await expect(fetchJson(url, { timeoutMs: 50 })).rejects.toThrow();
  });
  it("rejects oversized bodies", async () => {
    const url = await server((_req, res) => res.end(JSON.stringify({ value: "x".repeat(9000) })));
    await expect(fetchJson(url, { timeoutMs: 500 })).rejects.toThrow();
  });
  it("refuses a body that is not JSON, unless the caller asks for the status and headers of any answer", async () => {
    const url = await server((_req, res) => { res.writeHead(429, { "retry-after": "9" }); res.end("<html>slow down</html>"); });
    await expect(fetchJson(url, { timeoutMs: 500 })).rejects.toThrow();
    const answer = await fetchJson(url, { timeoutMs: 500, anyBody: true });
    expect([answer.status, answer.body, answer.headers.get("retry-after")]).toEqual([429, null, "9"]);
  });
  it("reads a larger body only when the caller raises the limit, and sends the method and headers it is given", async () => {
    let seen: { method?: string; version?: string | string[]; type?: string; body?: string } = {};
    const url = await server((req, res) => {
      let body = ""; req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        seen = { method: req.method, version: req.headers["x-github-api-version"], type: req.headers["content-type"], body };
        res.setHeader("retry-after", "7"); res.end(JSON.stringify({ value: "x".repeat(20000) }));
      });
    });
    await expect(fetchJson(url, { timeoutMs: 500 })).rejects.toThrow();
    const answer = await fetchJson(url, { timeoutMs: 500, method: "PATCH", payload: { a: 1 }, maxBytes: 262144, headers: { "X-GitHub-Api-Version": "2022-11-28" } });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("retry-after")).toBe("7");
    expect(seen).toEqual({ method: "PATCH", version: "2022-11-28", type: "application/json", body: '{"a":1}' });
  });
  it.each(["http://example.com", "https://user:pass@example.com", "https://example.com?token=secret"])("refuses unsafe target configuration %s", (baseUrl) => {
    expect(() => validateConfig({ baseUrl, serviceId: "test", tokenFile: "/tmp/token", stateDir: "/tmp/state", diskPaths: ["/tmp"] })).toThrow();
  });
  const base = { baseUrl: "http://127.0.0.1:1", serviceId: "test", tokenFile: "/tmp/token", stateDir: "/tmp/state", diskPaths: ["/tmp"] };
  const github = { repository: "owner/repo", issue: 5, mention: "owner", appClientId: "Iv23test", privateKeyFile: "/tmp/app.pem" };
  it("accepts a GitHub target and keeps exactly its five fields", () => {
    expect(validateConfig({ ...base, github: { ...github, extra: "ignored" } }).github).toEqual(github);
    expect(validateConfig(base).github).toBeUndefined();
  });
  it("refuses a config that still names gitlab", () => {
    expect(() => validateConfig({ ...base, gitlab: { url: "https://gitlab.com/group/project/alerts/notify/x.json", tokenFile: "/tmp/token" } })).toThrow();
    expect(() => validateConfig({ ...base, github, gitlab: null })).toThrow();
  });
  it.each([
    { repository: "owner" }, { repository: "owner/.." }, { repository: "owner/." }, { repository: "owner/repo/extra" }, { repository: "own er/repo" },
    { repository: "../repo" }, { repository: "ow.ner/repo" }, { repository: 5 }, { repository: ["owner/repo"] },
    { issue: 0 }, { issue: -1 }, { issue: 1.5 }, { issue: "5" },
    { mention: "@owner" }, { mention: "a b" }, { mention: "" }, { mention: "-owner" }, { mention: "owner-" }, { mention: 5 },
    { appClientId: "" }, { appClientId: "a/b" }, { appClientId: 5120765 },
    { privateKeyFile: "app.pem" }, { privateKeyFile: 7 },
  ])("refuses the GitHub target %j", (bad) => {
    expect(() => validateConfig({ ...base, github: { ...github, ...bad } })).toThrow();
  });
  // Each row is wrapped so the title prints the value; a bare empty array prints as nothing.
  it.each([[null], [[]], ["owner/repo"]])("refuses a GitHub target that is not an object: %j", (bad) => {
    expect(() => validateConfig({ ...base, github: bad })).toThrow();
  });
});

describe("signing in as the GitHub App", () => {
  it("signs a token GitHub can verify, for the Client ID, with a lifetime inside ten minutes", () => {
    const { signed, header, claims } = readJwt(appJwt("Iv23test", keys.privateKey, 1_000_000));
    expect(signed).toBe(true);
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(claims.iss).toBe("Iv23test");
    expect(claims.iat).toBe(1_000_000 - 60);
    expect(claims.exp).toBe(1_000_000 + 540);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  });
  it("writes every part of the token in unpadded base64url, which is the only form GitHub decodes", () => {
    // Node's own base64url decoder also accepts plain base64, so the verifying helper above cannot
    // see this. At a ten-digit time the two encodings of the claims differ.
    expect(appJwt("Iv23test", keys.privateKey, 1_760_000_000)).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
  it("writes whole seconds, whatever fraction it is handed", () => {
    expect(readJwt(appJwt("Iv23test", keys.privateKey, 1_760_000_000.678)).claims).toEqual({ iss: "Iv23test", iat: 1_760_000_000 - 60, exp: 1_760_000_000 + 540 });
  });
  it.each([
    ["an elliptic-curve key", () => generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey],
    ["an RSA-PSS key", () => generateKeyPairSync("rsa-pss", { modulusLength: 2048 }).privateKey],
  ])("refuses %s: Node would sign with it, and GitHub would refuse the result on every run", (_name, key) => {
    expect(() => appJwt("Iv23test", key(), 1_000_000)).toThrow();
  });
});

describe("how long GitHub asks the monitor to wait", () => {
  const headers = (values: Record<string, string>) => new Headers(values);
  it("takes the seconds GitHub names", () => {
    expect(waitSeconds(429, headers({ "retry-after": "120" }), 1000)).toBe(120);
    expect(waitSeconds(403, headers({ "retry-after": "5" }), 1000)).toBe(5);
  });
  it("waits for the reset time when the allowance is spent", () => {
    expect(waitSeconds(403, headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1300" }), 1000)).toBe(300);
    expect(waitSeconds(403, headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "900" }), 1000)).toBe(0);
  });
  it("takes the named seconds first when GitHub sends both", () => {
    expect(waitSeconds(429, headers({ "retry-after": "30", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1300" }), 1000)).toBe(30);
  });
  it("falls back to the reset time when the named wait is not a number of seconds", () => {
    expect(waitSeconds(429, headers({ "retry-after": "Sat, 10 Oct 2026 05:00:00 GMT", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1300" }), 1000)).toBe(300);
  });
  it("names no wait when the allowance is spent and the reset time is missing or unreadable", () => {
    expect(waitSeconds(403, headers({ "x-ratelimit-remaining": "0" }), 1000)).toBeNull();
    expect(waitSeconds(403, headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "" }), 1000)).toBeNull();
    expect(waitSeconds(403, headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "later" }), 1000)).toBeNull();
  });
  it("names no wait for a plain refusal or for any other status", () => {
    expect(waitSeconds(403, headers({}), 1000)).toBeNull();
    expect(waitSeconds(403, headers({ "x-ratelimit-remaining": "12", "x-ratelimit-reset": "1300" }), 1000)).toBeNull();
    expect(waitSeconds(200, headers({ "retry-after": "120" }), 1000)).toBeNull();
    expect(waitSeconds(500, headers({ "retry-after": "120" }), 1000)).toBeNull();
    expect(waitSeconds(429, headers({ "retry-after": "soon" }), 1000)).toBeNull();
  });
});

describe("what the owner reads", () => {
  const target = { mention: "owner", serviceId: "heatsynq-devtest", repository: "owner/repo" };
  const incident = { fingerprint: "f22b7c05-aa35-4e95-93a4-70e90d150764", start_time: "2026-10-03T13:26:33.897Z", end_time: "2026-10-10T03:12:41.086Z", firingSent: false };
  const runbook = "Runbook: https://github.com/owner/repo/blob/main/ops/monitoring/README.md";
  it.each([
    ["availability", "availability", "Check the app and database containers and their logs, then the URL or proxy."],
    ["backups", "backups", "Open Admin → Backups with an authorized account for the reason."],
    ["disk_2", "disk 2", "Free space or free inodes on entry 2 of the monitor's `diskPaths` are under the configured minimum, or that path could not be read."],
  ])("says a firing for %s with its next step", (key, label, step) => {
    expect(firingComment(target, key, incident)).toBe(
      `@owner The **${label}** check on \`heatsynq-devtest\` has failed three times in a row, first at 2026-10-03T13:26:33Z. ${step} ${runbook}` +
      "\n\n<!-- heatsynq-monitor incident: f22b7c05-aa35-4e95-93a4-70e90d150764 firing -->");
  });
  it("says a recovery with both times", () => {
    expect(recoveryComment(target, "backups", incident)).toBe(
      "@owner The **backups** check on `heatsynq-devtest` has passed twice in a row, as of 2026-10-10T03:12:41Z. " +
      "The incident began at 2026-10-03T13:26:33Z.\n\n<!-- heatsynq-monitor incident: f22b7c05-aa35-4e95-93a4-70e90d150764 recovery -->");
  });
  it("names a disk in a recovery the way its firing did", () => {
    expect(recoveryComment(target, "disk_1", incident)).toContain("@owner The **disk 1** check on `heatsynq-devtest` has passed twice in a row");
  });
  it("lists the incidents that are open, and none when all have ended", () => {
    const open = { failures: 3, successes: 0, incident: { ...incident, end_time: undefined } };
    const ended = { failures: 0, successes: 2, incident };
    expect(openIncidents({ availability: { failures: 0, successes: 2 }, backups: open, disk_1: open })).toBe(
      "backups since 2026-10-03T13:26:33Z; disk 1 since 2026-10-03T13:26:33Z");
    expect(openIncidents({ backups: ended })).toBe("none");
    expect(openIncidents({})).toBe("none");
  });
  it("writes the heartbeat with each check's state word and nothing else about the host", () => {
    const report = { checkedAt: "2026-10-10T04:23:29.678Z", availability: "ok", backups: "stale",
      disks: [{ state: "ok", freePercent: 52, freeInodesPercent: 87 }, { state: "low", freePercent: 4, freeInodesPercent: 90 }], delivery: "ok" };
    expect(heartbeatBody("heatsynq-devtest", report, "backups since 2026-10-03T13:26:33Z")).toBe([
      "<!-- heatsynq-monitor last-report: 2026-10-10T04:23:29Z -->",
      "**Install:** `heatsynq-devtest`",
      "**Last report:** 2026-10-10T04:23:29Z",
      "**Availability:** ok",
      "**Backups:** stale",
      "**Disk 1:** ok",
      "**Disk 2:** low",
      "**Open incidents:** backups since 2026-10-03T13:26:33Z",
      "",
      "The health monitor on this install rewrites this description about once an hour, and when an incident opens or ends. " +
        "The monitor watch reads it. The comments below need you.",
    ].join("\n"));
  });
});

describe("durable monitoring cycles", () => {
  type Call = { method: string; url: string; auth: string; version: string; accept: string; agent: string; body: unknown };
  type Answer = { status: number; headers?: Record<string, string>; body?: unknown; raw?: string } | "drop" | undefined;
  const ROUTES: Record<string, [number, unknown]> = {
    "GET /repos/owner/repo/installation": [200, { id: 77 }],
    "POST /app/installations/77/access_tokens": [201, { token: "ghs_installation" }],
    "POST /repos/owner/repo/issues/5/comments": [201, { id: 1 }],
    "PATCH /repos/owner/repo/issues/5": [200, { number: 5 }],
  };
  // A loopback stand-in for api.github.com: it records every request and answers as GitHub would,
  // unless the test's `answer` returns something else for that request.
  async function fakeGitHub() {
    const calls: Call[] = [];
    const held: { body: string }[] = []; // the comments this GitHub accepted, whether or not its answer got back
    const gh = {
      calls, held, origin: "", answer: undefined as undefined | ((call: Call) => Answer),
      comments: () => calls.filter((call) => call.method === "POST" && call.url.endsWith("/comments")).map((call) => (call.body as { body: string }).body),
      descriptions: () => calls.filter((call) => call.method === "PATCH").map((call) => (call.body as { body: string }).body),
    };
    gh.origin = await server((req, res) => {
      let raw = ""; req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const call = { method: req.method ?? "", url: req.url ?? "", auth: String(req.headers.authorization),
          version: String(req.headers["x-github-api-version"]), accept: String(req.headers.accept), agent: String(req.headers["user-agent"]),
          body: raw ? JSON.parse(raw) : undefined };
        calls.push(call);
        const listing = call.method === "GET" && call.url.startsWith("/repos/owner/repo/issues/5/comments?");
        const [status, body] = listing ? [200, held] : ROUTES[`${call.method} ${call.url}`] ?? [404, { message: "Not Found" }];
        const answer = gh.answer?.(call) ?? { status, body };
        const comment = call.method === "POST" && call.url.endsWith("/comments");
        // "drop" is a response lost after GitHub accepted the request.
        if (comment && (answer === "drop" || answer.status === 201)) held.push({ body: (call.body as { body: string }).body });
        if (answer === "drop") { res.destroy(); return; }
        res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers }); res.end(answer.raw ?? JSON.stringify(answer.body ?? {}));
      });
    });
    return gh;
  }
  const kind = (comment: string) => /(firing|recovery) -->$/.exec(comment)?.[1];
  const route = (call: Call) => `${call.method} ${call.url}`;
  async function setup(delivery = false) {
    const dir = await mkdtemp(path.join(tmpdir(), "heatsynq-monitor-cycle-")); dirs.push(dir);
    await writeFile(path.join(dir, "token"), "1".repeat(64), { mode: 0o600 });
    await writeFile(path.join(dir, "app.pem"), keys.privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });
    let healthy = true;
    let available = true;
    const url = await server((req, res) => {
      if (req.url?.endsWith("operations")) {
        expect(req.headers.authorization).toBe("Bearer " + "1".repeat(64));
        res.statusCode = healthy ? 200 : 503;
        res.end(JSON.stringify({ ok: healthy, db: true, backups: healthy ? "ok" : "failed" }));
      } else { res.statusCode = available ? 200 : 503; res.end(JSON.stringify({ ok: available, db: available })); }
    });
    const gh = await fakeGitHub();
    // The lowest free-space limit the config allows, so a full temp filesystem does not open a disk incident here.
    const config = validateConfig({ baseUrl: url, serviceId: "test", tokenFile: path.join(dir, "token"), stateDir: path.join(dir, "state"), diskPaths: [dir],
      minimumFreePercent: 1,
      ...(delivery ? { github: { repository: "owner/repo", issue: 5, mention: "owner", appClientId: "Iv23test", privateKeyFile: path.join(dir, "app.pem") } } : {}),
    });
    const stateFile = path.join(config.stateDir, "state.json");
    return { config, gh, dir, stateFile, run: (n: number) => runCycle(config, { now: time(n), api: gh.origin, clock: () => Date.parse(time(n)) }),
      state: async () => JSON.parse(await readFile(stateFile, "utf8")),
      fail: () => { healthy = false; }, recover: () => { healthy = true; }, outage: () => { available = false; } };
  }

  it("persists local failure and recovery, and asks GitHub nothing while delivery is disabled", async () => {
    const f = await setup();
    await f.run(0); f.fail();
    for (let n = 1; n < 4; n++) await f.run(n);
    // With nothing to post, the incident is still marked as fired, as the removed sender left it.
    expect((await f.state()).checks.backups.incident).toMatchObject({ firingSent: true, start_time: time(1) });
    f.recover(); await f.run(4); await f.run(5);
    const state = await f.state();
    expect(state.checks.backups.incident).toBeUndefined();
    expect(state.report.backups).toBe("ok"); expect(state.report.delivery).toBe("disabled");
    expect(f.gh.calls).toEqual([]);
  });
  it("signs in as the App and asks for a token that can only write issues on this repository", async () => {
    const f = await setup(true);
    expect((await f.run(0)).delivery).toBe("ok");
    expect(f.gh.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /repos/owner/repo/installation", "POST /app/installations/77/access_tokens", "PATCH /repos/owner/repo/issues/5"]);
    const { signed, claims } = readJwt(f.gh.calls[0].auth.replace(/^Bearer /, ""));
    expect(signed).toBe(true);
    expect(claims).toEqual({ iss: "Iv23test", iat: Date.parse(time(0)) / 1000 - 60, exp: Date.parse(time(0)) / 1000 + 540 });
    expect(f.gh.calls[1].auth).toBe(f.gh.calls[0].auth);
    expect(f.gh.calls[1].body).toEqual({ repositories: ["repo"], permissions: { issues: "write" } });
    expect(f.gh.calls[2].auth).toBe("Bearer ghs_installation");
    expect(f.gh.calls.every((call) => call.version === "2022-11-28" && call.accept === "application/vnd.github+json" && call.agent === "heatsynq-monitor")).toBe(true);
  });
  it("talks to api.github.com when it runs as the CLI: the origin is a constant, and main passes no other", async () => {
    const source = await readFile("scripts/monitor-health.mjs", "utf8");
    expect(source).toContain("const GITHUB_API = 'https://api.github.com';");
    expect(source).toContain("api = GITHUB_API");
    expect(source).toContain("const report = await runCycle(config);");
  });
  it("posts one firing after three failures and its recovery after two healthy readings", async () => {
    const f = await setup(true); f.fail();
    await f.run(0); await f.run(1);
    expect(f.gh.comments()).toEqual([]);
    await f.run(2);
    const fingerprint = (await f.state()).checks.backups.incident.fingerprint as string;
    expect(f.gh.comments()).toEqual([
      "@owner The **backups** check on `test` has failed three times in a row, first at 2026-09-09T12:00:00Z. " +
      "Open Admin → Backups with an authorized account for the reason. Runbook: https://github.com/owner/repo/blob/main/ops/monitoring/README.md" +
      `\n\n<!-- heatsynq-monitor incident: ${fingerprint} firing -->`]);
    await f.run(3);
    f.recover(); await f.run(4);
    expect(f.gh.comments()).toHaveLength(1);
    expect((await f.run(5)).delivery).toBe("ok");
    expect(f.gh.comments()[1]).toBe(
      "@owner The **backups** check on `test` has passed twice in a row, as of 2026-09-09T12:05:00Z. The incident began at 2026-09-09T12:00:00Z." +
      `\n\n<!-- heatsynq-monitor incident: ${fingerprint} recovery -->`);
    expect((await f.state()).checks.backups.incident).toBeUndefined();
    const sent = JSON.stringify(f.gh.calls.map((call) => call.body));
    expect(sent).not.toMatch(/127\.0\.0\.1|1{64}|BEGIN|PRIVATE/); expect(sent).not.toContain(f.dir);
  });
  it("keeps a refused notice pending, and sends the firing before its recovery once GitHub accepts", async () => {
    const f = await setup(true); await f.run(0); f.fail();
    let refuse = true;
    f.gh.answer = (call) => (refuse && call.url.endsWith("/comments") ? { status: 500, body: {} } : undefined);
    for (let n = 1; n < 4; n++) await f.run(n);
    expect(f.gh.comments()).toHaveLength(1);
    expect((await f.run(4)).delivery).toBe("failed");
    expect((await f.state()).checks.backups.incident.firingSent).toBe(false);
    f.recover(); await f.run(5); await f.run(6);
    expect(f.gh.comments().map(kind)).toEqual(["firing", "firing", "firing", "firing"]);
    refuse = false;
    expect((await f.run(7)).delivery).toBe("ok");
    expect(f.gh.comments().map(kind).slice(4)).toEqual(["firing", "recovery"]);
    expect((await f.state()).checks.backups.incident).toBeUndefined();
  });
  it("does not post a notice again when GitHub already has it: a lost response is confirmed by reading the issue", async () => {
    const f = await setup(true); await f.run(0); f.fail();
    f.gh.answer = (call) => (call.method === "POST" && call.url.endsWith("/comments") ? "drop" : undefined);
    await f.run(1); await f.run(2);
    expect((await f.run(3)).delivery).toBe("failed");
    expect((await f.state()).checks.backups.incident).toMatchObject({ firingSent: false, firingTried: time(3) });
    const before = f.gh.calls.length;
    expect((await f.run(4)).delivery).toBe("ok");
    // The second try read the issue from five minutes before the first try, found the firing, and posted nothing.
    expect(f.gh.calls.slice(before).map(route)).toEqual([
      "GET /repos/owner/repo/installation", "POST /app/installations/77/access_tokens",
      "GET /repos/owner/repo/issues/5/comments?since=2026-09-09T11:58:00Z&per_page=100", "PATCH /repos/owner/repo/issues/5"]);
    expect((await f.state()).checks.backups.incident).toMatchObject({ firingSent: true });
    f.recover(); await f.run(5); await f.run(6);
    expect((await f.state()).checks.backups.incident).toMatchObject({ end_time: time(6), recoveryTried: time(6) });
    await f.run(7);
    expect(f.gh.comments().map(kind)).toEqual(["firing", "recovery"]);
    expect((await f.state()).checks.backups.incident).toBeUndefined();
  });
  it("counts only this incident's own marker as the notice", async () => {
    const f = await setup(true); await f.run(0); f.fail();
    f.gh.held.push({ body: "an older firing\n\n<!-- heatsynq-monitor incident: 00000000-0000-4000-8000-000000000000 firing -->" });
    let refuse = true;
    f.gh.answer = (call) => (refuse && call.method === "POST" && call.url.endsWith("/comments") ? { status: 500, body: {} } : undefined);
    for (let n = 1; n < 4; n++) await f.run(n);
    refuse = false;
    expect((await f.run(4)).delivery).toBe("ok");
    expect(f.gh.comments().map(kind)).toEqual(["firing", "firing"]);
  });
  it("leaves a notice pending while the issue cannot be read, and posts nothing blind", async () => {
    const f = await setup(true); await f.run(0); f.fail();
    let unreadable = false;
    f.gh.answer = (call) => (call.method === "POST" && call.url.endsWith("/comments") && !unreadable ? { status: 500, body: {} }
      : unreadable && call.method === "GET" && call.url.includes("/comments?") ? { status: 502, body: {} } : undefined);
    for (let n = 1; n < 4; n++) await f.run(n);
    unreadable = true;
    expect((await f.run(4)).delivery).toBe("failed");
    expect(f.gh.comments()).toHaveLength(1);
    expect((await f.state()).checks.backups.incident.firingSent).toBe(false);
  });
  it("reads a long list of comments when it looks for its notice", async () => {
    const f = await setup(true); await f.run(0); f.fail();
    f.gh.answer = (call) => (call.method === "POST" && call.url.endsWith("/comments") ? "drop" : undefined);
    for (let n = 1; n < 4; n++) await f.run(n);
    for (let n = 0; n < 100; n++) f.gh.held.push({ body: "x".repeat(5000) });
    expect((await f.run(4)).delivery).toBe("ok");
    expect(f.gh.comments()).toHaveLength(1);
  });
  it("opens a new incident, with its own fingerprint and start, when a check fails again after a firing that was delivered", async () => {
    const f = await setup(true); f.fail();
    for (let n = 0; n < 3; n++) await f.run(n);
    const first = (await f.state()).checks.backups.incident.fingerprint as string;
    let refuse = true;
    f.gh.answer = (call) => (refuse && call.method === "POST" && call.url.endsWith("/comments") ? { status: 500, body: {} } : undefined);
    f.recover(); await f.run(3); await f.run(4);
    f.fail(); await f.run(5); await f.run(6);
    refuse = false; await f.run(7);
    const second = (await f.state()).checks.backups.incident;
    expect(second).toMatchObject({ start_time: time(5), firingSent: true });
    expect(second.fingerprint).not.toBe(first);
    // The first incident's recovery, refused three times, is not owed any more; the new firing says when the new trouble began.
    expect(f.gh.comments().map(kind)).toEqual(["firing", "recovery", "recovery", "recovery", "firing"]);
    expect(f.gh.comments().at(-1)).toContain("first at 2026-09-09T12:05:00Z");
    expect(f.gh.comments().at(-1)).toContain(`incident: ${second.fingerprint} firing`);
  });
  it("keeps a refused recovery pending and posts it on the next run", async () => {
    const f = await setup(true); f.fail();
    for (let n = 0; n < 3; n++) await f.run(n);
    let refuse = true;
    f.gh.answer = (call) => (refuse && call.url.endsWith("/comments") ? { status: 500, body: {} } : undefined);
    f.recover(); await f.run(3);
    expect((await f.run(4)).delivery).toBe("failed");
    expect((await f.state()).checks.backups.incident).toMatchObject({ firingSent: true, end_time: time(4) });
    refuse = false;
    expect((await f.run(5)).delivery).toBe("ok");
    expect(f.gh.comments().map(kind)).toEqual(["firing", "recovery", "recovery"]);
    expect((await f.state()).checks.backups.incident).toBeUndefined();
  });
  it("records each step on disk before the next request leaves", async () => {
    const f = await setup(true); await f.run(0); f.fail();
    let refuse = false; let onDisk: [string, unknown][] = [];
    f.gh.answer = (call) => {
      if (call.method === "GET" || call.url.endsWith("/access_tokens")) return undefined;
      onDisk.push([call.method, JSON.parse(readFileSync(f.stateFile, "utf8")).checks.backups.incident]);
      return refuse && call.method === "POST" ? { status: 500, body: {} } : undefined;
    };
    await f.run(1); await f.run(2); refuse = true; await f.run(3);
    // The run that opened the incident: its firing left only after the incident, and the time of this first try, were on disk.
    expect(onDisk).toEqual([["POST", expect.objectContaining({ firingSent: false, start_time: time(1), firingTried: time(3) })]]);
    f.recover(); await f.run(4); await f.run(5);
    refuse = false; onDisk = [];
    await f.run(66);
    // An hour on, so the heartbeat is due too: one run sends the firing, its recovery and the
    // heartbeat, and each finds the step before it recorded.
    expect(onDisk).toEqual([
      ["POST", expect.objectContaining({ firingSent: false, end_time: time(5) })],
      ["POST", expect.objectContaining({ firingSent: true, end_time: time(5) })],
      ["PATCH", undefined],
    ]);
  });
  it("writes no heartbeat in a run where a notice could not be delivered, so the watch sees a channel that refuses notices", async () => {
    const f = await setup(true); await f.run(0); f.fail();
    f.gh.answer = (call) => (call.url.endsWith("/comments") ? { status: 422, body: {} } : undefined);
    for (let n = 1; n < 4; n++) await f.run(n);
    expect((await f.run(70)).delivery).toBe("failed");
    expect(f.gh.descriptions()).toHaveLength(1);
    expect((await f.state()).heartbeat).toEqual({ at: time(0), incidents: "none" });
    f.gh.answer = undefined;
    expect((await f.run(71)).delivery).toBe("ok");
    expect(f.gh.descriptions()).toHaveLength(2);
  });
  it("makes no GitHub request on a run with nothing to send and no heartbeat due", async () => {
    const f = await setup(true); await f.run(0);
    expect(f.gh.calls).toHaveLength(3);
    await f.run(1); await f.run(59);
    expect(f.gh.calls).toHaveLength(3);
  });
  it("writes the heartbeat on the first run, after an hour, and when an incident opens or ends", async () => {
    const f = await setup(true); const report = await f.run(0);
    expect(f.gh.descriptions()).toEqual([[
      "<!-- heatsynq-monitor last-report: 2026-09-09T12:00:00Z -->", "**Install:** `test`", "**Last report:** 2026-09-09T12:00:00Z",
      "**Availability:** ok", "**Backups:** ok", `**Disk 1:** ${report.disks[0].state}`, "**Open incidents:** none", "",
      "The health monitor on this install rewrites this description about once an hour, and when an incident opens or ends. " +
        "The monitor watch reads it. The comments below need you.",
    ].join("\n")]);
    await f.run(59); expect(f.gh.descriptions()).toHaveLength(1);
    await f.run(60); expect(f.gh.descriptions()).toHaveLength(2);
    f.fail(); await f.run(61); await f.run(62);
    expect(f.gh.descriptions()).toHaveLength(2);
    await f.run(63);
    expect(f.gh.descriptions()).toHaveLength(3);
    expect(f.gh.descriptions()[2]).toContain("**Backups:** failed");
    expect(f.gh.descriptions()[2]).toContain("**Open incidents:** backups since 2026-09-09T13:01:00Z");
    f.recover(); await f.run(64);
    expect(f.gh.descriptions()).toHaveLength(3);
    await f.run(65);
    expect(f.gh.descriptions()[3]).toContain("**Open incidents:** none");
    expect((await f.state()).heartbeat).toEqual({ at: time(65), incidents: "none" });
  });
  it("fails the run when the heartbeat is refused, and writes it on the next run", async () => {
    const f = await setup(true);
    f.gh.answer = (call) => (call.method === "PATCH" ? { status: 500, body: {} } : undefined);
    expect((await f.run(0)).delivery).toBe("failed");
    expect((await f.state()).heartbeat).toBeUndefined();
    f.gh.answer = undefined;
    expect((await f.run(1)).delivery).toBe("ok");
    expect((await f.state()).heartbeat.at).toBe(time(1));
  });
  it("waits as long as GitHub asks before its next request, and the runs in between fail", async () => {
    const f = await setup(true); await f.run(0); f.fail();
    let limited = true;
    f.gh.answer = (call) => (limited && call.url.endsWith("/comments") ? { status: 429, headers: { "retry-after": "120" }, body: {} } : undefined);
    await f.run(1); await f.run(2);
    const before = f.gh.calls.length;
    await f.run(3);
    // The limited run stops at GitHub's answer: the heartbeat that the new incident made due is not sent after it.
    expect(f.gh.calls.slice(before).map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /repos/owner/repo/installation", "POST /app/installations/77/access_tokens", "POST /repos/owner/repo/issues/5/comments"]);
    expect((await f.state()).retryAt).toBe(time(5));
    const asked = f.gh.calls.length;
    limited = false;
    expect((await f.run(4)).delivery).toBe("failed");
    expect(f.gh.calls).toHaveLength(asked);
    expect((await f.run(5)).delivery).toBe("ok");
    expect(f.gh.comments().map(kind)).toEqual(["firing", "firing"]);
    expect((await f.state()).retryAt).toBeUndefined();
  });
  it("sends nothing more in a run once GitHub has named a wait, even with a second notice pending", async () => {
    const f = await setup(true); await f.run(0); f.fail();
    let answer: Answer = { status: 500, body: {} };
    f.gh.answer = (call) => (call.url.endsWith("/comments") ? answer : undefined);
    for (let n = 1; n < 4; n++) await f.run(n);
    f.outage(); await f.run(4); await f.run(5);
    answer = { status: 429, headers: { "retry-after": "120" }, body: {} };
    const before = f.gh.calls.length;
    await f.run(6);
    // Two firings are pending now: availability, opened by this run, and backups, refused since run 3.
    const checks = (await f.state()).checks as Record<string, { incident?: { firingSent: boolean } }>;
    expect(Object.keys(checks).filter((key) => checks[key].incident?.firingSent === false)).toEqual(["availability", "backups"]);
    expect(f.gh.calls.slice(before).map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /repos/owner/repo/installation", "POST /app/installations/77/access_tokens", "POST /repos/owner/repo/issues/5/comments"]);
  });
  it("stops the rest of a run at a wait of zero, and sends on the next run", async () => {
    const f = await setup(true); await f.run(0); f.fail();
    let answer: Answer = { status: 500, body: {} };
    f.gh.answer = (call) => (call.url.endsWith("/comments") ? answer : undefined);
    for (let n = 1; n < 4; n++) await f.run(n);
    f.outage(); await f.run(4); await f.run(5);
    answer = { status: 429, headers: { "retry-after": "0" }, body: {} };
    let before = f.gh.comments().length;
    await f.run(6);
    expect(f.gh.comments().length - before).toBe(1);
    answer = undefined; before = f.gh.comments().length;
    expect((await f.run(7)).delivery).toBe("ok");
    expect(f.gh.comments().length - before).toBe(2);
  });
  it("records the wait GitHub names even when the answer's body is not JSON", async () => {
    const f = await setup(true);
    f.gh.answer = () => ({ status: 429, headers: { "retry-after": "120", "content-type": "text/html" }, raw: "<html>slow down</html>" });
    expect((await f.run(0)).delivery).toBe("failed");
    expect((await f.state()).retryAt).toBe(time(2));
    expect(f.gh.calls).toHaveLength(1);
  });
  it("counts the wait from GitHub's answer, not from the start of a run that probed for a while first", async () => {
    const f = await setup(true); f.fail();
    f.gh.answer = () => ({ status: 429, headers: { "retry-after": "120" }, body: {} });
    await runCycle(f.config, { now: time(0), api: f.gh.origin, clock: () => Date.parse(time(0)) + 90_000 });
    expect((await f.state()).retryAt).toBe(new Date(Date.parse(time(0)) + 90_000 + 120_000).toISOString());
  });
  it("never waits longer than an hour, whatever GitHub names", async () => {
    const f = await setup(true);
    f.gh.answer = () => ({ status: 403, headers: { "retry-after": "86400" }, body: {} });
    await f.run(0);
    expect((await f.state()).retryAt).toBe(time(60));
    expect(f.gh.calls).toHaveLength(1);
  });
  it("asks for a token once in a run, however many notices are pending", async () => {
    const f = await setup(true); await f.run(0); f.fail();
    let refuseSignIn = false;
    f.gh.answer = (call) => (call.url.endsWith("/comments") || (refuseSignIn && call.url.endsWith("/installation")) ? { status: 500, body: {} } : undefined);
    for (let n = 1; n < 4; n++) await f.run(n);
    f.outage(); await f.run(4); await f.run(5);
    refuseSignIn = true;
    const before = f.gh.calls.length;
    expect((await f.run(6)).delivery).toBe("failed");
    // Two firings were pending in that run (availability and backups), and the refused sign-in was tried once.
    const checks = (await f.state()).checks as Record<string, { incident?: { firingSent: boolean } }>;
    expect(Object.keys(checks).filter((key) => checks[key].incident?.firingSent === false)).toEqual(["availability", "backups"]);
    expect(f.gh.calls.slice(before).map((call) => call.url)).toEqual(["/repos/owner/repo/installation"]);
  });
  it.each([
    ["/installation", 403, { id: 77 }], ["/access_tokens", 403, { token: "ghs_refused" }],
    ["/installation", 200, { id: "77" }], ["/installation", 200, {}], ["/access_tokens", 201, { token: "" }], ["/access_tokens", 201, {}],
  ])("stops at a sign-in step that was refused or answered without what the next step needs: %s %i %j", async (suffix, status, body) => {
      const f = await setup(true);
      f.gh.answer = (call) => (call.url.endsWith(suffix) ? { status, body } : undefined);
      expect((await f.run(0)).delivery).toBe("failed");
      expect(f.gh.calls.at(-1)?.url.endsWith(suffix)).toBe(true);
    });
  it("refuses a key file that others can read, before any request", async () => {
    const f = await setup(true);
    await chmod(path.join(f.dir, "app.pem"), 0o644);
    expect((await f.run(0)).delivery).toBe("failed");
    expect(f.gh.calls).toEqual([]);
  });
  it.each([
    ["a directory", async (file: string) => { await rm(file); await mkdir(file, { mode: 0o700 }); }],
    // Reading a pipe would wait for a writer for ever; the short limit below is what a missing guard trips.
    ["a named pipe", async (file: string) => { await rm(file); execFileSync("mkfifo", ["-m", "600", file]); }],
    // A real key with padding after it: it would parse, so only the size limit refuses it.
    ["a real key in a file far larger than a key", async (file: string) => {
      await writeFile(file, keys.privateKey.export({ type: "pkcs1", format: "pem" }) + "\n" + "#".repeat(20000) + "\n", { mode: 0o600 });
    }],
  ])("refuses a key path that is %s, before any request", async (_name, replace) => {
    const f = await setup(true);
    await replace(path.join(f.dir, "app.pem"));
    expect((await f.run(0)).delivery).toBe("failed");
    expect(f.gh.calls).toEqual([]);
  }, 3000);
  it("accepts a GitHub answer as large as a real issue", async () => {
    const f = await setup(true);
    f.gh.answer = (call) => (call.method === "PATCH" ? { status: 200, body: { number: 5, body: "x".repeat(20000) } } : undefined);
    expect((await f.run(0)).delivery).toBe("ok");
  });
  it("a clock that jumped forward silences neither the heartbeat nor the sender", async () => {
    const f = await setup(true); await f.run(0);
    const state = await f.state(); state.heartbeat.at = time(600); state.retryAt = time(600);
    await writeFile(f.stateFile, JSON.stringify(state));
    expect((await f.run(1)).delivery).toBe("ok");
    expect(f.gh.descriptions()).toHaveLength(2);
    expect((await f.state()).retryAt).toBeUndefined();
  });
  it("writes the heartbeat again when the last one is stamped at all ahead of now", async () => {
    const f = await setup(true); await f.run(0);
    const state = await f.state(); state.heartbeat.at = time(31);
    await writeFile(f.stateFile, JSON.stringify(state));
    await f.run(1);
    expect(f.gh.descriptions()).toHaveLength(2);
  });
  it("refuses a version 1 state file", async () => {
    const f = await setup(); await f.run(0);
    const state = await f.state(); expect(state.version).toBe(2);
    await writeFile(f.stateFile, JSON.stringify({ ...state, version: 1 }));
    await expect(f.run(1)).rejects.toThrow();
  });
  it("keeps the state when the App's Client ID, its key file or the mention changes", async () => {
    const f = await setup(true); await f.run(0);
    await copyFile(path.join(f.dir, "app.pem"), path.join(f.dir, "rotated.pem"));
    const rotated = validateConfig({ ...f.config, github: { ...f.config.github, appClientId: "Iv23other", privateKeyFile: path.join(f.dir, "rotated.pem"), mention: "someone-else" } });
    await expect(runCycle(rotated, { now: time(1), api: f.gh.origin })).resolves.toMatchObject({ availability: "ok", delivery: "ok" });
  });
  it.each([["issue", { issue: 6 }], ["repository", { repository: "owner/other" }]])("refuses the old state when the %s changes", async (_name, change) => {
    const f = await setup(true); await f.run(0);
    const other = validateConfig({ ...f.config, github: { ...f.config.github, ...change } });
    await expect(runCycle(other, { now: time(1), api: f.gh.origin })).rejects.toThrow();
  });
  it("refuses the old state when delivery is switched on or off, so an incident marked as fired with nothing posted is not carried over", async () => {
    const on = await setup(true); await on.run(0);
    await expect(runCycle(validateConfig({ ...on.config, github: undefined }), { now: time(1), api: on.gh.origin })).rejects.toThrow();
    const off = await setup(); await off.run(0);
    const enabled = validateConfig({ ...off.config, github: on.config.github });
    await expect(runCycle(enabled, { now: time(1), api: off.gh.origin })).rejects.toThrow();
    expect(off.gh.calls).toEqual([]);
  });
  it.each([["heartbeat", { at: "yesterday", incidents: "none" }], ["heartbeat", { at: time(0) }], ["retryAt", "soon"]])(
    "refuses a state file whose %s is malformed", async (field, value) => {
      const f = await setup(); await f.run(0);
      await writeFile(f.stateFile, JSON.stringify({ ...(await f.state()), [field]: value }));
      await expect(f.run(1)).rejects.toThrow();
    });
  it.each(["firingTried", "recoveryTried"])("refuses a state file whose incident has a malformed %s", async (field) => {
    const f = await setup(); f.fail();
    for (let n = 0; n < 3; n++) await f.run(n);
    const state = await f.state(); state.checks.backups.incident[field] = "earlier";
    await writeFile(f.stateFile, JSON.stringify(state));
    await expect(f.run(3)).rejects.toThrow();
  });
  it("rejects array-shaped check state instead of losing every named counter", async () => {
    const f = await setup(); await f.run(0);
    const state = await f.state(); state.checks = [];
    await writeFile(f.stateFile, JSON.stringify(state));
    await expect(f.run(1)).rejects.toThrow();
  });
  it("preserves an existing backup incident during a full application outage", async () => {
    const f = await setup(); f.fail();
    for (let n = 0; n < 3; n++) await f.run(n);
    const prior = (await f.state()).checks.backups.incident;
    f.outage(); f.recover();
    for (let n = 3; n < 6; n++) await f.run(n);
    const state = await f.state();
    expect(state.checks.backups.incident).toEqual(prior);
    expect(state.checks.availability.incident).toBeDefined();
  });
  it("runs the actual CLI and persists a private status report", async () => {
    const f = await setup();
    const configFile = path.join(path.dirname(f.config.stateDir), "config.json");
    await writeFile(configFile, JSON.stringify(f.config), { mode: 0o600 });
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["scripts/monitor-health.mjs", configFile]);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ availability: "ok", backups: "ok", delivery: "disabled" });
    expect((await stat(f.stateFile)).mode & 0o777).toBe(0o600);
    expect(stdout).not.toContain(f.config.baseUrl); expect(stdout).not.toContain("1".repeat(64));
  });
  it("the CLI exits 1 with its report when delivery failed", async () => {
    const f = await setup(true);
    await chmod(path.join(f.dir, "app.pem"), 0o644); // The key is refused before any request, so nothing leaves the host.
    const configFile = path.join(path.dirname(f.config.stateDir), "config.json");
    await writeFile(configFile, JSON.stringify(f.config), { mode: 0o600 });
    await expect(promisify(execFile)(process.execPath, ["scripts/monitor-health.mjs", configFile])).rejects.toMatchObject({
      code: 1, stderr: "", stdout: expect.stringContaining('"delivery":"failed"') });
  });
  it("refuses corrupt state instead of silently losing active incidents", async () => {
    const f = await setup(); await f.run(0);
    await writeFile(f.stateFile, "{broken");
    await expect(f.run(1)).rejects.toThrow();
  });
});


describe("filesystem capacity", () => {
  it("reports low blocks even when inodes are free", () => {
    expect(diskHealth({ blocks: 100, bavail: 9, files: 1000, ffree: 500 }, 10).state).toBe("low");
  });
  it("reports low inodes even when blocks are free", () => {
    expect(diskHealth({ blocks: 100, bavail: 50, files: 1000, ffree: 9 }, 10).state).toBe("low");
  });
  it("does not invent an inode count on a filesystem that reports none", () => {
    expect(diskHealth({ blocks: 100, bavail: 50, files: 0, ffree: 0 }, 10)).toEqual({ state: "ok", freePercent: 50, freeInodesPercent: null });
  });
});


describe("the image's actual Node healthcheck", () => {
  it.each([true, false])("exits from the response health, healthy=%s", async (healthy) => {
    const url = await server((_req, res) => { res.statusCode = healthy ? 200 : 503; res.end(JSON.stringify({ ok: healthy, db: healthy })); });
    const result = promisify(execFile)(process.execPath, ["scripts/container-health.mjs"], { env: { ...process.env, PORT: new URL(url).port } });
    if (healthy) expect(await result).toMatchObject({ stdout: "", stderr: "" });
    else await expect(result).rejects.toMatchObject({ code: 1, stdout: "", stderr: "" });
  });
});
