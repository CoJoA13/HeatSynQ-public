import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Script } from "node:vm";
import ts from "typescript";
import { makeApiMutate } from "../../e2e/api-mutate.mjs";
import { resultsLine, retryRefusal } from "../../e2e/lib/failure-classify.mjs";
import { HOST_RESOLVER_RULE, browserEnv } from "../../e2e/lib/insecure-origin.mjs";
import { STANDALONE_COPIES } from "../../e2e/lib/server-mode.mjs";
import { CUSTOMER_FOLDERS_MARKER } from "@/lib/invoice-folder-entry";

export type AttemptResult = {
  ok: boolean;
  contextClosed?: boolean;
  error: Error | null;
  kind: "network" | "assertion" | null;
  committed: number;
  indeterminate: number;
  netFailures: { at: number; line: string }[];
};

export type Dispatch = { name: string; attempt: number };

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

// Execute the complete production orchestration, signal registration and single-flight teardown.
// Importing run.mjs normally starts real services at module scope. The AST selects these intact
// declarations instead; no loop, guard or shutdown logic is copied or rewritten. Only the external
// operations below are replaced. In particular, process is a private EventEmitter, never the host.
const harnessPath = path.join(process.cwd(), "e2e/run.mjs");
const parsed = ts.createSourceFile(
  harnessPath, readFileSync(harnessPath, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS,
);
const names = new Set([
  "state", "teardownPromise", "teardown", "installSignalHandlers", "prepareProductionServer", "main",
]);
const declarations = parsed.statements.flatMap((statement) => {
  if (ts.isFunctionDeclaration(statement) && statement.name && names.has(statement.name.text)) {
    return [{ name: statement.name.text, source: statement.getText(parsed) }];
  }
  if (ts.isVariableStatement(statement)) {
    const wanted = statement.declarationList.declarations.filter(
      (declaration) => ts.isIdentifier(declaration.name) && names.has(declaration.name.text),
    );
    if (wanted.length) {
      assert.equal(statement.declarationList.declarations.length, 1, "select a whole declaration");
      return [{ name: wanted[0].name.getText(parsed), source: statement.getText(parsed) }];
    }
  }
  return [];
});
assert.deepEqual(new Set(declarations.map(({ name }) => name)), names);
const script = new Script(
  declarations.map(({ source }) => source).join("\n") + "\n({ main, teardown, installSignalHandlers, state, teardownStarted: () => teardownPromise !== null });",
  { filename: harnessPath },
);

export function harnessRuntime(options: {
  runAttempt: (dispatch: Dispatch) => AttemptResult | Promise<AttemptResult>;
  beforeFlows?: Promise<void>;
  flowNames?: string[];
  cleanupError?: Error;
  stopServer?: () => Promise<void>;
  recoveryReapError?: Error;
  serverMode?: "dev" | "production";
  buildError?: Error;
  // Consumed in call order, one result per isPortFree() call (the pre-build check, then — in
  // production mode — the post-build re-check); any call past the array's length defaults to
  // free. Lets a test make only the SECOND call report the port taken, e.g. [true, false].
  portFreeResults?: boolean[];
  // Called as each holdable setup step STARTS, with its name; a returned promise holds that step.
  // The steps are "sweep" (assertNoRawApiMutations), "mkdtemp", "cp:<from>" for each standalone
  // copy, the artifact rotation's "rm:<target>", "rename" and "mkdir:<target>" (#335), and the
  // share's "rm:<target>", "mkdir:<target>" and "write:<marker>" (#588). Each "rm:", "mkdir:" and
  // "write:" step is also recorded in `events` as it starts.
  hold?: (step: string) => Promise<void> | void;
  // Called inside the blocking runDbScript stand-in, before it returns: a signal that arrives
  // while the real call blocks the event loop.
  duringDbCommand?: (command: string) => void;
  // Called inside the blocking build stand-in, before it returns or throws buildError: a signal
  // that arrives while the real build blocks the event loop (#445).
  duringBuild?: () => void;
}) {
  const cleanup = deferred<void>();
  const launchStarted = deferred<void>();
  // Every settings object main() hands chromium.launch, so a test can pin a launch option (#348).
  const launchSettings: Record<string, unknown>[] = [];
  const dispatches: Dispatch[] = [];
  // The ctx main() hands each flow, so a test can pin what it carries (#588's `officeShare`).
  const flowContexts: unknown[] = [];
  const dbCommands: string[] = [];
  const events: string[] = [];
  const teardownEvents: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  // Declared before `sandbox`: the `rm` stand-in below asks the real harness whether teardown has
  // begun, through a reader that exists only once `script.runInNewContext` has run. `let`, not
  // `const`, for that deferred assignment.
  // eslint-disable-next-line prefer-const -- assigned once, after runInNewContext, deliberately
  let teardownStarted: (() => boolean) | undefined;
  const signalProcess = Object.assign(new EventEmitter(), {
    exitCode: 0,
    // A private, CI-shaped environment (the runner's egress proxy and its bypass list), never the
    // host's: the shared browser launch derives its env from it (browserEnv, #348).
    env: { http_proxy: "http://proxy:3128", no_proxy: "localhost,127.0.0.1,postgres" } as Record<string, string>,
    // Record exit instead of terminating this fixture. Continuing after simulated exit lets the
    // tests prove cancellation stays latched even when cleanup finishes before the held attempt.
    exit: (code: number) => {
      signalProcess.exitCode = code;
      exits.push(code);
    },
  });
  const browser = { close: async () => { teardownEvents.push("browser closed"); } };
  const devServer = { closeLog: async () => { teardownEvents.push("log closed"); } };
  const backupDir = "/fixture/e2e-backups";
  const shareDir = "/fixture/e2e-customer-folders";
  const erpRoot = "/fixture/erp";
  const standaloneDir = "/fixture/standalone";
  let portFreeCalls = 0;
  const flowDefinitions = (options.flowNames ?? ["first", "next"]).map((name) => ({ name }));
  const sandbox = {
    assert,
    process: signalProcess,
    console: {
      log: (...args: unknown[]) => { logs.push(args.map(String).join(" ")); },
      error: (...args: unknown[]) => { errors.push(args.map(String).join(" ")); },
      warn: (...args: unknown[]) => { logs.push(args.map(String).join(" ")); },
    },
    PORT: 3100,
    BASE_URL: "http://fixture.invalid",
    APP_DIR: "/fixture/app",
    ARTIFACTS_DIR: "/fixture/e2e-artifacts",
    PREV_ARTIFACTS_DIR: "/fixture/e2e-artifacts-prev",
    DEV_SERVER_LOG: "/fixture/e2e-artifacts/dev-server.log",
    BACKUP_DIR: backupDir,
    OFFICE_SHARE_DIR: shareDir,
    OFFICE_SHARE_ROOT: "Z:\\",
    UPDATES_DIR: "/fixture/e2e-updates",
    CUSTOMER_FOLDERS_MARKER,
    HEADED: false,
    FLOWS: flowDefinitions,
    activeFlows: flowDefinitions,
    BROWSER_CHANNEL: undefined,
    HOST_RESOLVER_RULE,
    browserEnv,
    isPortFree: async () => {
      const result = portFreeCalls < (options.portFreeResults?.length ?? 0)
        ? options.portFreeResults![portFreeCalls]
        : true;
      portFreeCalls += 1;
      return result;
    },
    assertNoRawApiMutations: async () => {
      await options.hold?.("sweep");
      return 1;
    },
    makeApiMutate,
    preflightRefusal: () => null,
    runDbScript: (command: string) => {
      dbCommands.push(command);
      events.push(`db:${command}`);
      options.duringDbCommand?.(command);
      if (command === "create-draft-recovery") return { customerId: "owned-recovery-customer" };
      if (command === "reap-draft-recovery") {
        if (options.recoveryReapError) throw options.recoveryReapError;
        return { ok: true };
      }
      if (command === "preflight") return {
        year: 2026, month: 9, unpostedBatchCount: 0, variance: "0.00", readinessGaps: [],
      };
      if (command === "create") return {
        customerCode: "fixture", partNumber: "fixture", stepCodeA: { code: "A" },
        stepCodeB: { code: "B" }, adminUsername: "admin", restrictedUsername: "restricted",
      };
      assert.equal(command, "cleanup");
      teardownEvents.push("fixtures cleaned");
      if (options.cleanupError) throw options.cleanupError;
    },
    mkdir: async (target: string) => {
      events.push(`mkdir:${target}`);
      await options.hold?.(`mkdir:${target}`);
    },
    // Only main()'s share setup writes a file (#588): the marker, at the top of the share.
    writeFile: async (target: string) => {
      assert.equal(target, `${shareDir}/${CUSTOMER_FOLDERS_MARKER}`, "setup writes only the share's marker");
      events.push(`write:${target}`);
      await options.hold?.(`write:${target}`);
    },
    // #326 fix round 1: only main()'s artifacts-ROTATION calls this in the sandboxed surface
    // (runFlow's own video rename is mocked separately and never reaches this stub), so "rotate"
    // unambiguously pins that one call's position relative to "build" — see
    // e2e-production-server.test.ts.
    rename: async () => {
      events.push("rotate");
      await options.hold?.("rename");
    },
    // Only teardown removes the standalone tree, so that removal is recorded whenever it happens:
    // a run cancelled during setup has no server, and killDevServer never runs to mark the start.
    // The backup folder and the share (#588) are removed by setup too, so those ask the harness
    // itself — one microtask later, because a teardown with no server reaches this call
    // synchronously, inside the async function whose promise is the mark, before that promise has
    // been assigned. The share's removal goes in `events` as well, on setup's timeline.
    rm: async (target: string) => {
      if (target === standaloneDir) { teardownEvents.push("standalone removed"); return; }
      await Promise.resolve();
      if (!teardownStarted!()) {
        assert.ok(target === backupDir || target === shareDir || target === "/fixture/e2e-artifacts-prev",
          `setup removed ${target}`);
        events.push(`rm:${target}`);
        await options.hold?.(`rm:${target}`);
        return;
      }
      assert.ok(target === backupDir || target === shareDir, `teardown preserves the attempt artifacts, not ${target}`);
      if (target === backupDir) {
        teardownEvents.push("backups removed");
        return;
      }
      teardownEvents.push("customer folders removed");
      events.push("customer folders removed");
    },
    SERVER_MODE: options.serverMode ?? "dev",
    // prepareProductionServer runs for real (#335); these are its external operations. runDbScript
    // is replaced whole above, so the build is the only caller of this execFileSync.
    ERP_ROOT: erpRoot,
    STANDALONE_COPIES,
    path,
    os: { tmpdir: () => "/fixture/tmp" },
    setImmediate,
    execFileSync: (command: string, args: string[]) => {
      assert.deepEqual([command, ...args], ["npx", "next", "build"]);
      events.push("build");
      options.duringBuild?.();
      if (options.buildError) throw options.buildError;
    },
    mkdtemp: async (prefix: string) => {
      assert.equal(prefix, "/fixture/tmp/heatsynq-e2e-standalone-");
      events.push("mkdtemp");
      await options.hold?.("mkdtemp");
      return standaloneDir;
    },
    cp: async (from: string, to: string, settings: { recursive?: boolean }) => {
      assert.equal(settings.recursive, true);
      assert.ok(to === standaloneDir || to.startsWith(`${standaloneDir}/`), `copied outside the run's tree: ${to}`);
      const step = `cp:${path.relative(erpRoot, from)}`;
      events.push(step);
      await options.hold?.(step);
    },
    startServer: () => {
      events.push("server:start");
      return devServer;
    },
    waitForServer: async () => {},
    devServerMemoryMeter: () => ({ stop: () => 0 }),
    warmRoutes: async () => ({}),
    warmupRefusal: () => null,
    chromium: { launch: async (settings: Record<string, unknown>) => {
      launchSettings.push(settings);
      assert.equal(settings.handleSIGINT, false);
      assert.equal(settings.handleSIGTERM, false);
      launchStarted.resolve();
      await options.beforeFlows;
      return browser;
    } },
    killDevServer: async (server: unknown) => {
      assert.equal(server, devServer);
      teardownEvents.push("server stopping");
      await cleanup.promise;
      await options.stopServer?.();
      teardownEvents.push("server stopped");
      events.push("server stopped");
    },
    runFlow: (actualBrowser: unknown, flow: { name: string }, ctx: unknown, attempt: number) => {
      assert.equal(actualBrowser, browser);
      flowContexts.push(ctx);
      const dispatch = { name: flow.name, attempt };
      dispatches.push(dispatch);
      events.push(`flow:${flow.name}:${attempt}`);
      return options.runAttempt(dispatch);
    },
    retryRefusal,
    resultsLine,
  };
  const runtime = script.runInNewContext(sandbox) as {
    main: () => Promise<void>;
    teardown: () => Promise<void>;
    installSignalHandlers: () => void;
    state: { cleanupFailed: string | null; standaloneDir: string | null };
    teardownStarted: () => boolean;
  };
  teardownStarted = runtime.teardownStarted;
  runtime.installSignalHandlers();
  return {
    ...runtime, cleanup, launchStarted, launchSettings, dispatches, teardownEvents, logs, errors, exits,
    signalProcess, dbCommands, events, flowContexts,
  };
}
