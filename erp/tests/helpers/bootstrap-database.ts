import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../prisma/generated/prisma/client";
import { bootstrapCommands, type BootstrapCommand } from "./bootstrap-process";

export const BOOTSTRAP_CLEANUP_MS = 150_000;
export const BOOTSTRAP_HOOK_MS = 170_000;
export type BootstrapContext = {
  signal: AbortSignal;
  onTestFinished: (hook: () => Promise<void>, timeout: number) => void;
};
type AdminOperation = "create" | "disable" | "terminate" | "drop";
type Admin = (source: string, name: string, operation: AdminOperation, budget: number) => Promise<void>;

// This timeout is an inability-to-join alarm, never evidence of cancellation.
// Every caller must fail closed if it fires; the original promise stays handled.
async function joinWithin<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle`)), Math.max(1, ms));
    })]);
  } finally { clearTimeout(timer); }
}

// Dedicated, non-pipeline session. statement_timeout stops the SERVER operation;
// query_timeout would reject early while allowing the SQL to keep executing.
export async function bootstrapAdminQuery(source: string, sql: string, values: string[], budget: number, statementMs: number) {
  const client = new Client({ connectionString: source,
    connectionTimeoutMillis: Math.min(5_000, Math.max(1, budget - 5_000)),
    statement_timeout: Math.max(1, Math.min(statementMs, budget - 10_000)),
    application_name: "heatsynq_bootstrap_fixture",
  });
  // Socket errors also reject the active query. Keep an idle error from becoming
  // an uncaught exception while end() is being joined.
  client.on("error", () => {});
  let closing: Promise<void> | undefined;
  const close = () => closing ??= client.end();
  let watchdogFired = false;
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    void close().catch(() => {});
  }, Math.max(1, budget - 3_000));
  const query = (async () => {
    await client.connect();
    return await client.query(sql, values);
  })();
  let result: Awaited<typeof query> | undefined;
  let failure: unknown;
  try { result = await joinWithin(query, Math.max(1, budget - 1_000), "Maintenance query"); }
  catch (error) { failure = error; }
  finally {
    clearTimeout(watchdog);
    try { await joinWithin(Promise.all([close(), query.catch(() => {})]), 1_000, "Maintenance connection/query close"); }
    catch { throw Object.assign(new Error("Maintenance connection/query could not be joined"), { unsafe: true }); }
  }
  // Closing a socket joins local work, but is not proof that CREATE stopped on
  // the server. Do not retry/declare safe completion after an unanswered query.
  if (watchdogFired) throw Object.assign(new Error("Maintenance watchdog fired; server completion is unconfirmed"), { unsafe: true });
  if (failure) {
    const code = (failure as { code?: string }).code;
    throw Object.assign(new Error(`Maintenance query failed${code ? ` (${code})` : ""}`), { code, unsafe: !code || !/^[0-9A-Z]{5}$/.test(code) });
  }
  return result!;
}

const admin: Admin = async (source, name, operation, budget) => {
  if (!/^heatsynq_bootstrap_[a-f0-9]{32}$/.test(name)) throw new Error("Invalid bootstrap fixture identity");
  const sql = {
    create: `CREATE DATABASE "${name}"`,
    disable: `ALTER DATABASE "${name}" ALLOW_CONNECTIONS false`,
    terminate: "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    drop: `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
  }[operation];
  await bootstrapAdminQuery(source, sql, operation === "terminate" ? [name] : [], budget, operation === "drop" ? 90_000 : 10_000);
};

type Dependencies = {
  source: () => string | undefined;
  admin: Admin;
  client: (url: string) => PrismaClient;
  commands: typeof bootstrapCommands;
  cleanupMs: number;
  drainMs: number;
};

/** One instance owns the original sequential bootstrap file. The factory seam is
 * for lifecycle tests with deferred resource boundaries, not a general DB pool.
 * Callbacks must use this Prisma client, tracked commands and ctx.signal. After
 * owned I/O stops, an arbitrary callback still has only five seconds to settle;
 * a callback that ignores cancellation poisons this fixture instance.
 */
export function createBootstrapDatabaseFixture(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = {
    source: () => process.env.DATABASE_URL_TEST, admin,
    client: url => new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }),
    commands: bootstrapCommands, cleanupMs: BOOTSTRAP_CLEANUP_MS, drainMs: 5_000, ...overrides,
  };
  let active = false;
  let poisoned: Error | undefined;
  return async (ctx: BootstrapContext, run: (db: PrismaClient, url: string, exec: BootstrapCommand) => Promise<void>) => {
    if (poisoned) throw poisoned;
    // A runner hook is the barrier. Refuse accidental concurrent use rather than
    // enqueue a CREATE that could begin after its own runner has timed out.
    if (active) throw new Error("Previous bootstrap fixture cleanup is still pending");
    const source = deps.source();
    if (!source) throw new Error("DATABASE_URL_TEST is required");
    const url = new URL(source);
    const name = "heatsynq_bootstrap_" + randomUUID().replaceAll("-", "");
    active = true;
    let db: PrismaClient | undefined;
    let commands: ReturnType<typeof bootstrapCommands> | undefined;
    let created = false;
    let firstFailure: unknown;
    let unsafeCreation: unknown;
    let body: Promise<void> = Promise.resolve();
    ctx.onTestFinished(async () => {
      const deadline = Date.now() + deps.cleanupMs;
      const remaining = (max: number) => {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error("Bootstrap cleanup budget exhausted");
        return Math.min(max, left);
      };
      const failures: unknown[] = [];
      const attempt = async (action: () => Promise<unknown>) => {
        try { await action(); } catch (error) { failures.push(error); }
      };
      // CREATE is part of body. It has its own finite server deadline and is
      // joined even if Vitest aborts during its await. run() checks abort again.
      if (ctx.signal.aborted) {
        if (commands) await attempt(() => joinWithin(commands!.stopAll(), remaining(5_000), "Bootstrap children"));
        await attempt(() => joinWithin(creation.catch(() => {}), remaining(20_000), "Bootstrap creation"));
        if (created) {
          await attempt(() => deps.admin(source, name, "disable", remaining(20_000)));
          await attempt(() => deps.admin(source, name, "terminate", remaining(20_000)));
        }
      }
      await attempt(() => joinWithin(body.catch(() => {}), remaining(deps.drainMs), "Bootstrap body"));
      if (unsafeCreation) failures.push(unsafeCreation);
      if (commands) await attempt(() => joinWithin(commands!.stopAll(), remaining(5_000), "Bootstrap children"));
      if (db) await attempt(() => joinWithin(db!.$disconnect(), remaining(5_000), "Bootstrap Prisma disconnect"));
      await attempt(async () => {
        // 90s per server attempt covers the measured 73s checkpoint wait. The
        // absolute150s budget also includes cancellation, drain and disconnect.
        for (let attempt = 1; ; attempt++) {
          try { await deps.admin(source, name, "drop", remaining(100_000)); return; }
          catch (error) {
            if ((error as { code?: string }).code !== "57014" || attempt === 3 || deadline - Date.now() < 10_001) throw error;
          }
        }
      });
      if (failures.length) {
        poisoned = new AggregateError(firstFailure === undefined ? failures : [firstFailure, ...failures],
          `Bootstrap fixture ${name} cleanup failed; subsequent fixture work refused`);
        throw poisoned;
      }
      active = false;
    }, BOOTSTRAP_HOOK_MS);
    // Register first, then start CREATE and retain the exact promise returned to
    // Vitest. No finally inside the behavior deadline performs deletion.
    const creation = (async () => {
      if (ctx.signal.aborted) throw new Error("Bootstrap fixture cancelled before creation");
      try { await deps.admin(source, name, "create", 20_000); }
      catch (error) {
        if ((error as { unsafe?: boolean }).unsafe) unsafeCreation = error;
        throw error;
      }
      created = true;
    })();
    body = (async () => {
      await creation;
      if (ctx.signal.aborted) throw new Error("Bootstrap fixture cancelled during creation");
      url.pathname = "/" + name;
      db = deps.client(url.toString());
      commands = deps.commands(ctx.signal);
      await run(db, url.toString(), commands.exec);
    })();
    void body.catch(error => { firstFailure = error; });
    return body;
  };
}

export const withBootstrapDatabase = createBootstrapDatabaseFixture();
