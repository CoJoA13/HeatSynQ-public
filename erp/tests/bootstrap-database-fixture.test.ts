import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import type { PrismaClient } from "../prisma/generated/prisma/client";
import { bootstrapAdminQuery, BOOTSTRAP_HOOK_MS, createBootstrapDatabaseFixture, type BootstrapContext } from "./helpers/bootstrap-database";
import { bootstrapCommands } from "./helpers/bootstrap-process";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function context(events: string[] = [], runner?: BootstrapContext) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (runner?.signal.aborted) abort();
  else runner?.signal.addEventListener("abort", abort, { once: true });
  let hook: (() => Promise<void>) | undefined;
  let finished: Promise<void> | undefined;
  const finish = () => finished ??= (hook ? hook() : Promise.resolve()).finally(() => {
    runner?.signal.removeEventListener("abort", abort);
  });
  const ctx: BootstrapContext = { signal: controller.signal, onTestFinished: (callback, timeout) => {
    events.push("registered");
    expect(timeout).toBe(BOOTSTRAP_HOOK_MS);
    hook = callback;
    runner?.onTestFinished(finish, timeout);
  } };
  return { ctx, controller, finish };
}

function fakeFixture(events: string[], options: Parameters<typeof createBootstrapDatabaseFixture>[0] = {}) {
  return createBootstrapDatabaseFixture({
    source: () => "postgresql://localhost/fixture_test",
    admin: async (_source, _name, operation) => { events.push(operation); },
    client: () => ({ $disconnect: async () => { events.push("disconnected"); } }) as PrismaClient,
    ...options,
  });
}

describe("bootstrap fixture lifecycle", () => {
  it("registers before CREATE and holds the next fixture outside pending cleanup", async () => {
    const events: string[] = [];
    const drop = deferred(), dropping = deferred();
    const fixture = fakeFixture(events, { admin: async (_source, _name, operation) => {
      events.push(operation);
      if (operation === "drop") { dropping.resolve(); await drop.promise; }
    } });
    const first = context(events);
    await fixture(first.ctx, async () => { events.push("body"); });
    expect(events).toEqual(["registered", "create", "body"]);
    const cleanup = first.finish();
    await dropping.promise;
    try {
      await expect(fixture(context().ctx, async () => { events.push("escaped"); })).rejects.toThrow("cleanup is still pending");
      expect(events).toEqual(["registered", "create", "body", "disconnected", "drop"]);
    } finally { drop.resolve(); await cleanup; }
    const second = context(events);
    await fixture(second.ctx, async () => { events.push("second body"); });
    await second.finish();
    expect(events.at(-3)).toBe("second body");
  });

  it("joins an aborted body before disconnect/drop and attributes cleanup failure to that owner", async () => {
    const events: string[] = [];
    const entered = deferred(), stopped = deferred(), release = deferred();
    const fixture = fakeFixture(events, { admin: async (_source, _name, operation) => {
      events.push(operation);
      if (operation === "terminate") stopped.resolve();
    } });
    const owner = context(events);
    const body = fixture(owner.ctx, async () => { entered.resolve(); await release.promise; events.push("body settled"); });
    await entered.promise;
    owner.controller.abort();
    const cleanup = owner.finish();
    await stopped.promise;
    try {
      expect(events).not.toContain("disconnected");
      expect(events).not.toContain("drop");
      await expect(fixture(context().ctx, async () => { events.push("escaped"); })).rejects.toThrow("cleanup is still pending");
    } finally { release.resolve(); await body; await cleanup; }
    expect(events.indexOf("body settled")).toBeLessThan(events.indexOf("disconnected"));
    expect(events.indexOf("disconnected")).toBeLessThan(events.indexOf("drop"));
  });

  it.each(["before", "during"])("handles abort %s CREATE without entering the callback", async when => {
    const events: string[] = [];
    const creating = deferred(), release = deferred();
    const fixture = fakeFixture(events, { admin: async (_source, _name, operation) => {
      events.push(operation);
      if (operation === "create") { creating.resolve(); await release.promise; }
    } });
    const owner = context(events);
    if (when === "before") owner.controller.abort();
    const result = fixture(owner.ctx, async () => { events.push("unexpected body"); }).catch(error => error);
    if (when === "during") { await creating.promise; owner.controller.abort(); }
    const cleanup = owner.finish();
    release.resolve();
    expect(String(await result)).toContain(`cancelled ${when}`);
    await cleanup;
    expect(events).not.toContain("unexpected body");
    expect(events.at(-1)).toBe("drop");
    if (when === "during") expect(events).toEqual(["registered", "create", "disable", "terminate", "drop"]);
  });

  it("preserves the body error and cleanup error and refuses all subsequent fixture work", async () => {
    const events: string[] = [];
    const original = new Error("body sentinel"), cleanupError = Object.assign(new Error("drop sentinel"), { code: "55006" });
    const fixture = fakeFixture(events, { admin: async (_source, _name, operation) => {
      events.push(operation); if (operation === "drop") throw cleanupError;
    } });
    const owner = context(events);
    await expect(fixture(owner.ctx, async () => { throw original; })).rejects.toBe(original);
    const failed = await owner.finish().catch(error => error);
    expect(failed).toBeInstanceOf(AggregateError);
    expect(failed.errors).toEqual([original, cleanupError]);
    await expect(fixture(context().ctx, async () => { events.push("escaped"); })).rejects.toBe(failed);
    expect(events.filter(event => event === "drop")).toHaveLength(1);
    expect(events.filter(event => event === "create")).toHaveLength(1);
  });

  it("allows subsequent fixture work after two server-cancelled drops succeed on the third attempt", async () => {
    const events: string[] = [];
    let drops = 0;
    const fixture = fakeFixture(events, { admin: async (_source, _name, operation) => {
      events.push(operation);
      if (operation === "drop" && ++drops <= 2) {
        throw Object.assign(new Error("server cancellation"), { code: "57014" });
      }
    } });
    const first = context();
    await fixture(first.ctx, async () => { events.push("first body"); });
    await first.finish();
    expect(events).toEqual(["create", "first body", "disconnected", "drop", "drop", "drop"]);
    const second = context();
    await fixture(second.ctx, async () => { events.push("second body"); });
    await second.finish();
    expect(events.slice(6)).toEqual(["create", "second body", "disconnected", "drop"]);
  });

  it("stops after three server-cancelled drops and refuses subsequent fixture work", async () => {
    const events: string[] = [];
    const cancelled = Object.assign(new Error("server cancellation"), { code: "57014" });
    let drops = 0;
    const fixture = fakeFixture(events, { admin: async (_source, _name, operation) => {
      if (operation === "drop" && ++drops <= 3) throw cancelled;
      // A broken retry ceiling reaches success here and must fail this test.
    } });
    const owner = context();
    await fixture(owner.ctx, async () => {});
    const failure = await owner.finish().catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual([cancelled]);
    expect(drops).toBe(3);
    await expect(fixture(context().ctx, async () => {})).rejects.toBe(failure);
    expect(drops).toBe(3);
  });

  it("fails closed if an arbitrary callback ignores cancellation instead of claiming it settled", async () => {
    const events: string[] = [];
    const release = deferred(), entered = deferred();
    const fixture = fakeFixture(events, { drainMs: 20 });
    const owner = context(events);
    const body = fixture(owner.ctx, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    owner.controller.abort();
    try {
      const failed = await owner.finish().catch(error => error);
      expect(failed.errors.map(String)).toContain("Error: Bootstrap body did not settle");
      await expect(fixture(context().ctx, async () => {})).rejects.toBe(failed);
    } finally { release.resolve(); await body; }
  });

  it("does not launder unconfirmed CREATE completion through a successful DROP", async () => {
    const events: string[] = [];
    const fixture = fakeFixture(events, { admin: async (_source, _name, operation) => {
      if (operation === "create") throw Object.assign(new Error("unconfirmed CREATE"), { unsafe: true });
    } });
    const owner = context();
    await expect(fixture(owner.ctx, async () => {})).rejects.toThrow("unconfirmed CREATE");
    const failure = await owner.finish().catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError);
    await expect(fixture(context().ctx, async () => {})).rejects.toBe(failure);
  });

  it("Vitest waits for cleanup beyond the body deadline and keeps timeout failure on its own case", async (ctx) => {
    const directory = await mkdtemp(join(tmpdir(), "bootstrap-runner-"));
    const commands = bootstrapCommands(ctx.signal);
    try {
      const result = await commands.exec(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config",
        "tests/helpers/fixtures/bootstrap-runner.config.ts", "--reporter=json", "--outputFile", join(directory, "report.json")],
      { cwd: process.cwd(), env: { ...process.env, BOOTSTRAP_PROBE_DIRECTORY: directory } }).catch(error => error);
      expect(result).toMatchObject({ code: 1 });
      const report = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
      const cases = report.testResults.flatMap((file: { assertionResults: unknown[] }) => file.assertionResults);
      expect(cases.map((test: { status: string }) => test.status)).toEqual(["passed", "failed", "passed"]);
      expect(cases[1].failureMessages.join(" ")).toContain("timed out");
      const events = (await readFile(join(directory, "events"), "utf8")).trim().split("\n");
      expect(events).toEqual(["ordinary body", "ordinary drop", "aborted body settled", "aborted drop", "later body", "later drop"]);
    } finally { await commands.stopAll(); await rm(directory, { recursive: true, force: true }); }
  }, 20_000);

  it("rejects excessive command output only after its real child has stopped", async (ctx) => {
    const directory = await mkdtemp(join(tmpdir(), "bootstrap-output-"));
    const commands = bootstrapCommands(ctx.signal);
    const pidFile = join(directory, "pid");
    try {
      const script = "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); "
        + "setTimeout(() => process.exit(99), 4000); process.stdout.write('x'.repeat(2048));";
      await expect(commands.exec(process.execPath, ["-e", script, pidFile], { maxBuffer: 1024 }))
        .rejects.toThrow("Bootstrap command output exceeded its bound");
      const pid = Number(await readFile(pidFile, "utf8"));
      const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return "";
      });
      expect(stat === "" || /\) [ZX] /.test(stat)).toBe(true);
    } finally { await commands.stopAll(); await rm(directory, { recursive: true, force: true }); }
  });
});

describe("bootstrap fixture real owned resources", () => {
  it("publishes the migration PID only after its complete write", async (ctx) => {
    const directory = await mkdtemp(join(tmpdir(), "bootstrap-publication-"));
    const commands = bootstrapCommands(ctx.signal);
    try {
      const result = await commands.exec(process.execPath, ["tests/helpers/fixtures/bootstrap-pid-publication.mjs"], {
        cwd: process.cwd(), env: { ...process.env, BOOTSTRAP_PROBE_DIRECTORY: directory },
      });
      const observation = JSON.parse(result.stdout);
      expect(observation.duringWrite).toBe(null);
      expect(observation.published).toBe(String(observation.pid));
      expect(observation.pid).toBeGreaterThan(0);
    } finally { await commands.stopAll(); await rm(directory, { recursive: true, force: true }); }
  }, 20_000);

  it("retries a server-cancelled statement and removes the generated database", async (ctx) => {
    const source = process.env.DATABASE_URL_TEST!;
    const owner = context([], ctx);
    let name = "", drops = 0;
    const outcomes: string[] = [];
    // Inject one actual server cancellation, leaving a retry for the real DROP
    // if it hits its own server deadline on a loaded runner. The deterministic
    // lifecycle cases cover two cancellations and the three-attempt ceiling.
    const fixture = createBootstrapDatabaseFixture({ admin: async (url, identity, operation, budget) => {
      name = identity;
      if (operation === "create") await bootstrapAdminQuery(url, `CREATE DATABASE "${identity}"`, [], budget, 10_000);
      else if (operation === "drop") {
        drops++;
        try {
          await bootstrapAdminQuery(url, drops === 1 ? "SELECT pg_sleep(10)" : `DROP DATABASE IF EXISTS "${identity}" WITH (FORCE)`, [], budget, drops === 1 ? 30 : 90_000);
          outcomes.push("dropped");
        } catch (error) {
          outcomes.push((error as { code?: string }).code ?? "unknown");
          throw error;
        }
      } else throw new Error("Unexpected operation in ordinary cleanup");
    } });
    await fixture(owner.ctx, async db => { await db.$queryRaw`SELECT 1`; });
    await owner.finish();
    expect([
      ["57014", "dropped"],
      ["57014", "57014", "dropped"],
    ]).toContainEqual(outcomes);
    const check = new Client({ connectionString: source, connectionTimeoutMillis: 5_000, statement_timeout: 5_000 });
    await check.connect();
    try {
      expect((await check.query("SELECT datname FROM pg_database WHERE datname = $1", [name])).rows).toEqual([]);
      expect((await check.query("SELECT pid FROM pg_stat_activity WHERE application_name = 'heatsynq_bootstrap_fixture'")).rows).toEqual([]);
    } finally { await check.end(); }
  }, 170_000);

  it("cancels and joins the real CLI, its migration descendant and active target SQL", async (ctx) => {
    const directory = await mkdtemp(join(tmpdir(), "bootstrap-cli-"));
    const owner = context([], ctx);
    const fixture = createBootstrapDatabaseFixture();
    let url = "", querySettled = false;
    const entered = deferred();
    const result = fixture(owner.ctx, async (db, databaseUrl, exec) => {
      url = databaseUrl;
      const query = db.$queryRaw`SELECT pg_sleep(120)`.then(() => { querySettled = true; }, () => { querySettled = true; });
      const command = exec(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/public-bootstrap.ts"], {
        cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url, BOOTSTRAP_PROBE_DIRECTORY: directory,
          NODE_OPTIONS: `--import=${join(process.cwd(), "tests/helpers/fixtures/bootstrap-block-migration.mjs")}` },
      });
      const joined = Promise.allSettled([query, command]);
      entered.resolve();
      await joined;
    });
    const enteredOrFailed = Promise.race([entered.promise, result.then(() => {
      throw new Error("CLI fixture body finished before entry");
    })]);
    let childPid = 0;
    let escaped = false;
    try {
      await enteredOrFailed;
      const deadline = Date.now() + 10_000;
      for (;;) {
        try { childPid = Number(await readFile(join(directory, "migration-pid"), "utf8")); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() > deadline) throw error; }
        await delay(20);
      }
      expect(childPid).toBeGreaterThan(0);
    } finally {
      owner.controller.abort();
      let cleanupFailure: unknown;
      try { await owner.finish(); } catch (error) { cleanupFailure = error; }
      try { await result; } catch (error) { cleanupFailure ??= error; }
      try {
        escaped = await readFile(join(directory, "migration-escaped"), "utf8").then(() => true, error => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return false;
        });
      } finally { await rm(directory, { recursive: true, force: true }); }
      if (cleanupFailure) throw cleanupFailure;
    }
    expect(escaped).toBe(false);
    expect(querySettled).toBe(true);
    // The process group helper joins descendants; independent OS state confirms
    // the recorded real Prisma child is gone or reaped to a non-running zombie.
    const stat = await readFile(`/proc/${childPid}/stat`, "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return "";
    });
    expect(stat === "" || /\) [ZX] /.test(stat)).toBe(true);
    const check = new Client({ connectionString: process.env.DATABASE_URL_TEST, connectionTimeoutMillis: 5_000, statement_timeout: 5_000 });
    await check.connect();
    try {
      const name = new URL(url).pathname.slice(1);
      expect((await check.query("SELECT datname FROM pg_database WHERE datname = $1", [name])).rows).toEqual([]);
      expect((await check.query("SELECT pid FROM pg_stat_activity WHERE datname = $1", [name])).rows).toEqual([]);
    } finally { await check.end(); }
  }, 170_000);
});
