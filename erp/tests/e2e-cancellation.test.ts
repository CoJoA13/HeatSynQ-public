import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { deferred, harnessRuntime, type AttemptResult } from "./helpers/e2e-harness-runtime";

const success: AttemptResult = {
  ok: true, error: null, kind: null, committed: 0, indeterminate: 0, netFailures: [],
};
const retryable: AttemptResult = {
  ok: false, error: new Error("page.goto: net::ERR_CONNECTION_REFUSED"), kind: "network",
  committed: 0, indeterminate: 0,
  netFailures: [{ at: 0, line: "GET /orders — net::ERR_CONNECTION_REFUSED" }],
};
const cleanupEvents = [
  "server stopping", "server stopped", "log closed", "fixtures cleaned", "browser closed",
  "backups removed", "customer folders removed",
];
const signals = ["SIGINT", "SIGTERM"] as const;
const outcomes = [
  { label: "retryable failure", result: retryable },
  { label: "success", result: success },
];

describe("E2E cancellation stops dispatch", () => {
  for (const signal of signals) {
    for (const { label, result } of outcomes) {
      for (const cleanupFirst of [false, true]) {
        it(`${signal}: an in-flight ${label} dispatches nothing after cancellation, cleanup ${cleanupFirst ? "complete" : "pending"}`, async () => {
          const attempt = deferred<AttemptResult>();
          const started = deferred<void>();
          const runtime = harnessRuntime({ runAttempt: () => {
            started.resolve();
            return attempt.promise;
          } });
          let settled = false;
          const done = runtime.main().finally(() => { settled = true; });
          await started.promise;

          runtime.signalProcess.emit(signal);
          // A second signal must join the same teardown and must never reset cancellation.
          runtime.signalProcess.emit(signal === "SIGINT" ? "SIGTERM" : "SIGINT");
          const teardown = runtime.teardown();
          expect(runtime.teardown()).toBe(teardown);
          expect(runtime.teardownEvents).toEqual(["server stopping"]);
          expect(runtime.exits).toEqual([]);
          if (cleanupFirst) {
            runtime.cleanup.resolve();
            await teardown;
          }

          attempt.resolve(result);
          // There is no timed I/O in the fixture: one event-loop turn drains every runnable
          // continuation while the explicit cleanup barrier remains held.
          await setImmediate();
          try {
            expect(runtime.dispatches).toEqual([{ name: "first", attempt: 1 }]);
            expect(runtime.errors.some((line) => line.includes("retrying once"))).toBe(false);
            if (!cleanupFirst) {
              expect(settled).toBe(false);
              expect(runtime.teardownEvents).toEqual(["server stopping"]);
              expect(runtime.exits).toEqual([]);
            }
          } finally {
            runtime.cleanup.resolve();
            await done;
          }
          await setImmediate();
          expect(runtime.teardownEvents).toEqual(cleanupEvents);
          expect(runtime.exits.length).toBeGreaterThan(0);
          expect(runtime.exits.every((code) => code === 1)).toBe(true);
          expect(runtime.signalProcess.exitCode).toBe(1);
          expect(runtime.logs.some((line) => /All .* flows passed/.test(line))).toBe(false);
        });
      }
    }

    it(`${signal}: cancellation before flow one refuses the first dispatch`, async () => {
      const launch = deferred<void>();
      const runtime = harnessRuntime({ beforeFlows: launch.promise, runAttempt: () => success });
      const done = runtime.main();
      await runtime.launchStarted.promise;
      runtime.signalProcess.emit(signal);
      launch.resolve();
      await setImmediate();
      try {
        expect(runtime.dispatches).toEqual([]);
        expect(runtime.exits).toEqual([]);
      } finally {
        runtime.cleanup.resolve();
        await done;
      }
      await setImmediate();
      expect(runtime.teardownEvents).toEqual(cleanupEvents);
      expect(runtime.exits).toEqual([1]);
      expect(runtime.signalProcess.exitCode).toBe(1);
    });

    for (const { label, result } of outcomes) {
      it(`${signal}: cancellation during a retry ending in ${label} never starts the next flow`, async () => {
        const retry = deferred<AttemptResult>();
        const retryStarted = deferred<void>();
        const runtime = harnessRuntime({ runAttempt: ({ name, attempt }) => {
          if (name === "first" && attempt === 1) return retryable;
          if (name === "first" && attempt === 2) {
            retryStarted.resolve();
            return retry.promise;
          }
          return success;
        } });
        const done = runtime.main();
        await retryStarted.promise;
        runtime.signalProcess.emit(signal);
        retry.resolve(result);
        await setImmediate();
        try {
          expect(runtime.dispatches).toEqual([
            { name: "first", attempt: 1 }, { name: "first", attempt: 2 },
          ]);
          expect(runtime.exits).toEqual([]);
        } finally {
          runtime.cleanup.resolve();
          await done;
        }
        await setImmediate();
        expect(runtime.teardownEvents).toEqual(cleanupEvents);
        expect(runtime.exits).toEqual([1]);
      });
    }

    it(`${signal}: a successful final attempt cannot announce a green suite after cancellation`, async () => {
      const attempt = deferred<AttemptResult>();
      const started = deferred<void>();
      const runtime = harnessRuntime({ flowNames: ["final"], runAttempt: () => {
        started.resolve();
        return attempt.promise;
      } });
      const done = runtime.main();
      await started.promise;
      runtime.signalProcess.emit(signal);
      attempt.resolve(success);
      runtime.cleanup.resolve();
      await done;
      await setImmediate();
      expect(runtime.exits).toEqual([1]);
      expect(runtime.signalProcess.exitCode).toBe(1);
      expect(runtime.logs.some((line) => /All .* flows passed/.test(line))).toBe(false);
    });
  }
});

// #335. Everything above cancels a run that already has a server; setup comes before that. Nothing
// in setup read the latch, and teardown never waited for the standalone server copy, so a signal
// there left a temp tree behind or went on to create fixtures and start a server after teardown
// had finished. A run cancelled in setup has no server, fixtures or browser to clean up.
const setupTeardown = {
  dev: ["backups removed", "customer folders removed"],
  production: ["standalone removed", "backups removed", "customer folders removed"],
};
type Runtime = ReturnType<typeof harnessRuntime>;
// The fatal-error events latch through the same cancel() as the signals, so each setup check
// answers them too: one of them rides every case below.
const cancellations: { label: string; emit: (runtime: Runtime) => void }[] = [
  ...signals.map((signal) => ({ label: signal, emit: (runtime: Runtime) => { runtime.signalProcess.emit(signal); } })),
  { label: "uncaughtException", emit: (runtime) => {
    runtime.signalProcess.emit("uncaughtException", new Error("escaped during setup"));
  } },
];
/** Holds one named setup step (the helper's `hold` option) and reports when it has started. */
function heldAt(step: string) {
  const started = deferred<void>();
  const release = deferred<void>();
  return {
    started: started.promise,
    release: () => release.resolve(),
    hold: (name: string) => {
      if (name !== step) return;
      started.resolve();
      return release.promise;
    },
  };
}
const copies = (runtime: Runtime) => runtime.events.filter((event) => event.startsWith("cp:"));
const PREV = "/fixture/e2e-artifacts-prev";
/** The share's three setup steps, in order (#588). */
const SHARE_SETUP = [
  "rm:/fixture/e2e-customer-folders", "mkdir:/fixture/e2e-customer-folders",
  "write:/fixture/e2e-customer-folders/HeatSynQ - do not delete.txt",
];
/** Every step that touched the share, setup's and teardown's, in the order they ran. */
const shareSteps = (runtime: Runtime) => runtime.events.filter(
  (event) => event.includes("/fixture/e2e-customer-folders") || event === "customer folders removed",
);
function expectNothingStarted(runtime: Runtime) {
  expect(runtime.events).not.toContain("rotate");
  expect(runtime.events).not.toContain("db:create");
  expect(runtime.events).not.toContain("server:start");
  expect(runtime.dispatches).toEqual([]);
  expect(runtime.exits).toEqual([1]);
  expect(runtime.signalProcess.exitCode).toBe(1);
}

describe("E2E cancellation during setup (#335)", () => {
  for (const { label, emit } of cancellations) {
    it(`${label}: before the sweep has answered, nothing after it runs`, async () => {
      const sweep = heldAt("sweep");
      const runtime = harnessRuntime({ hold: sweep.hold, runAttempt: () => success });
      const done = runtime.main();
      await sweep.started;
      emit(runtime);
      sweep.release();
      await done;
      await setImmediate();
      expect(runtime.dbCommands).toEqual([]);
      expect(runtime.events).not.toContain("build");
      expect(runtime.teardownEvents).toEqual(setupTeardown.dev);
      expectNothingStarted(runtime);
    });

    // The ordering the wait in teardown exists for: teardown starts while the directory is not
    // recorded yet, so a teardown that read it at once would find nothing to remove.
    it(`${label}: before the standalone directory is recorded, teardown waits for it and removes it`, async () => {
      const mkdtemp = heldAt("mkdtemp");
      const runtime = harnessRuntime({ serverMode: "production", hold: mkdtemp.hold, runAttempt: () => success });
      const done = runtime.main();
      await mkdtemp.started;
      emit(runtime);
      expect(runtime.state.standaloneDir).toBeNull();
      await setImmediate();
      expect(runtime.teardownEvents).toEqual([]);
      expect(runtime.exits).toEqual([]);
      mkdtemp.release();
      await done;
      await setImmediate();
      expect(copies(runtime)).toEqual([]);
      expect(runtime.teardownEvents).toEqual(setupTeardown.production);
      expect(runtime.dbCommands).toEqual(["preflight"]);
      expectNothingStarted(runtime);
    });

    it(`${label}: mid-copy, the tree is removed only once the copy in flight has settled, and no later copy starts`, async () => {
      const copy = heldAt("cp:.next/static");
      const runtime = harnessRuntime({ serverMode: "production", hold: copy.hold, runAttempt: () => success });
      const done = runtime.main();
      await copy.started;
      emit(runtime);
      await setImmediate();
      expect(runtime.teardownEvents).toEqual([]);
      expect(runtime.exits).toEqual([]);
      copy.release();
      await done;
      await setImmediate();
      expect(copies(runtime)).toEqual(["cp:.next/standalone", "cp:.next/static"]);
      expect(runtime.teardownEvents).toEqual(setupTeardown.production);
      expectNothingStarted(runtime);
    });

    // The post-build port re-check would otherwise refuse a cancelled run as "port in use".
    it(`${label}: a cancelled preparation is not followed by the port re-check`, async () => {
      const mkdtemp = heldAt("mkdtemp");
      const runtime = harnessRuntime({
        serverMode: "production", hold: mkdtemp.hold, runAttempt: () => success, portFreeResults: [true, false],
      });
      const done = runtime.main();
      await mkdtemp.started;
      emit(runtime);
      mkdtemp.release();
      await expect(done).resolves.toBeUndefined();
      await setImmediate();
      expectNothingStarted(runtime);
    });

    // No signal handler can run inside the blocking pre-flight, so this stands for a latch that is
    // already set when it returns, and pins that the check before the rotation is not
    // production-only: dev mode has no preparation to check after.
    it(`${label}: dev mode, latched by the time the pre-flight returns, does not rotate the artifacts`, async () => {
      const runtime: Runtime = harnessRuntime({
        duringDbCommand: (command) => { if (command === "preflight") emit(runtime); },
        runAttempt: () => success,
      });
      await runtime.main();
      await setImmediate();
      expect(runtime.dbCommands).toEqual(["preflight"]);
      expect(runtime.teardownEvents).toEqual(setupTeardown.dev);
      expectNothingStarted(runtime);
    });

    for (const serverMode of ["dev", "production"] as const) {
      // The last await before fixture creation: nothing yields between that check, the fixture
      // CLI and the server start, so it is the one that keeps rows and a server from outliving
      // a teardown that has already passed its fixture and server steps.
      it(`${label}: ${serverMode} mode, during the rotation, creates no fixtures and starts no server`, async () => {
        const rotation = heldAt("mkdir:/fixture/e2e-backups");
        const runtime = harnessRuntime({ serverMode, hold: rotation.hold, runAttempt: () => success });
        const done = runtime.main();
        await rotation.started;
        emit(runtime);
        await setImmediate();
        // Teardown has finished: it had no server, fixtures or browser to wait for.
        expect(runtime.teardownEvents).toEqual(setupTeardown[serverMode]);
        expect(runtime.exits).toEqual([1]);
        rotation.release();
        await done;
        await setImmediate();
        expect(runtime.dbCommands).toEqual(["preflight"]);
        expect(runtime.events).not.toContain("db:create");
        expect(runtime.events).not.toContain("server:start");
        expect(runtime.dispatches).toEqual([]);
        expect(runtime.exits).toEqual([1]);
        // #588: the share was finished before the held step, so teardown removed it, and setup
        // touched it no more: a run cancelled at the last await leaves no share behind.
        expect(shareSteps(runtime)).toEqual([...SHARE_SETUP, "customer folders removed"]);
      });
    }
  }

  // #588: the share is set up after the rotation and before the backup folder, so the backup
  // folder's mkdir, the step the rotation case above holds, stays the last await before the check
  // that guards the fixtures and the server.
  for (const serverMode of ["dev", "production"] as const) {
    it(`${serverMode} mode: the share is set up between the rotation and the backup folder`, async () => {
      const runtime = harnessRuntime({ serverMode, runAttempt: () => success });
      runtime.cleanup.resolve();
      await runtime.main();
      const { events } = runtime;
      expect(events.slice(events.indexOf(`rm:${PREV}`), events.indexOf("db:create") + 1)).toEqual([
        `rm:${PREV}`, "rotate", "mkdir:/fixture/e2e-artifacts",
        ...SHARE_SETUP,
        "rm:/fixture/e2e-backups", "mkdir:/fixture/e2e-backups",
        "db:create",
      ]);
      expect(shareSteps(runtime)).toEqual([...SHARE_SETUP, "customer folders removed"]);
    });
  }

  for (const signal of signals) {
    // A signal sent to node alone while the pre-flight blocks is only read on a later turn of the
    // event loop. Measured on this Node (a blocking child, SIGTERM to the parent alone): the
    // handler had not run after ONE setImmediate turn and had after two, so the stand-in below
    // delivers it one whole turn late.
    for (const serverMode of ["dev", "production"] as const) {
      it(`${signal}: ${serverMode} mode, queued behind the blocking pre-flight, it is honoured before the build or the rotation`, async () => {
        const runtime: Runtime = harnessRuntime({
          serverMode,
          duringDbCommand: (command) => {
            if (command !== "preflight") return;
            globalThis.setImmediate(() => globalThis.setImmediate(() => { runtime.signalProcess.emit(signal); }));
          },
          runAttempt: () => success,
        });
        // Nothing here should reach the server. Were the yield or its check missing, setup would run
        // on and the late teardown would wait on this barrier; open it so that fails on the
        // assertions below and not on a timeout.
        runtime.cleanup.resolve();
        await runtime.main();
        await setImmediate();
        expect(runtime.dbCommands).toEqual(["preflight"]);
        expect(runtime.events).not.toContain("build");
        expect(runtime.teardownEvents).toEqual(["backups removed", "customer folders removed"]);
        expectNothingStarted(runtime);
      });
    }
  }

  // #445: Ctrl-C reaches the whole process group, so the build child dies of the signal and the
  // blocking call throws before this process has read the signal itself. The stand-in delivers it
  // one whole turn late, as above. Were the yield or the latch read missing, the refusal would be
  // thrown and main() would reject, which `resolves` below refuses; the `errors` list then pins
  // that the cancellation line is all that was printed.
  const killedBuild = () => new Error("Command failed: npx next build");
  for (const signal of signals) {
    it(`${signal}: a build that dies of the signal is reported as the cancellation, not as a failed build`, async () => {
      const runtime: Runtime = harnessRuntime({
        serverMode: "production",
        buildError: killedBuild(),
        duringBuild: () => {
          globalThis.setImmediate(() => globalThis.setImmediate(() => { runtime.signalProcess.emit(signal); }));
        },
        runAttempt: () => success,
      });
      // Open the server barrier so a miss fails on the assertions below and not on a timeout.
      runtime.cleanup.resolve();
      await expect(runtime.main()).resolves.toBeUndefined();
      await setImmediate();
      expect(runtime.errors).toEqual([
        `\nReceived ${signal} — cleaning up (dev server + dev-DB fixtures) before exit...`,
      ]);
      expect(runtime.events.filter((event) => event === "build")).toEqual(["build"]);
      expect(runtime.events).not.toContain("mkdtemp");
      expect(copies(runtime)).toEqual([]);
      expect(runtime.dbCommands).toEqual(["preflight"]);
      expect(runtime.teardownEvents).toEqual(["backups removed", "customer folders removed"]);
      expectNothingStarted(runtime);
    });
  }

  // The other side of the same read: with no signal the two turns pass and the refusal is thrown
  // as before, under its own wording, with nothing printed for a cancellation and no exit taken.
  it("a build that fails with no signal still refuses by name", async () => {
    const runtime = harnessRuntime({
      serverMode: "production", buildError: killedBuild(), runAttempt: () => success,
    });
    runtime.cleanup.resolve();
    await expect(runtime.main()).rejects.toThrow(
      "Refusing to run the flows: next build failed (Command failed: npx next build). Its output is above.",
    );
    await setImmediate();
    expect(runtime.errors).toEqual([]);
    expect(runtime.exits).toEqual([]);
    expect(runtime.teardownEvents).toEqual(["backups removed", "customer folders removed"]);
    expect(runtime.events).not.toContain("rotate");
    expect(runtime.events).not.toContain("db:create");
    expect(runtime.events).not.toContain("server:start");
    expect(runtime.dispatches).toEqual([]);
  });
});

// A throw that escapes a flow's own await (an async route or dialog handler) reached Node's default
// and exited mid-run with no teardown: the server kept its port and the dev-DB fixtures stayed.
describe("E2E an uncaught error tears down instead of killing the harness", () => {
  for (const event of ["unhandledRejection", "uncaughtException"] as const) {
    it(`${event}: stops dispatch, runs the whole teardown, reports the error and exits 1`, async () => {
      const attempt = deferred<AttemptResult>();
      const started = deferred<void>();
      const runtime = harnessRuntime({ runAttempt: () => {
        started.resolve();
        return attempt.promise;
      } });
      const done = runtime.main();
      await started.promise;

      runtime.signalProcess.emit(event, new Error("route.abort: Route is already handled!"));
      // A second escape during teardown joins the same teardown.
      runtime.signalProcess.emit(event, new Error("a second escape"));
      runtime.cleanup.resolve();
      attempt.resolve(success);
      await done;
      await setImmediate();

      expect(runtime.dispatches).toEqual([{ name: "first", attempt: 1 }]);
      expect(runtime.teardownEvents).toEqual(cleanupEvents);
      expect(runtime.errors.some((line) => line.includes("Route is already handled!"))).toBe(true);
      expect(runtime.exits.length).toBeGreaterThan(0);
      expect(runtime.exits.every((code) => code === 1)).toBe(true);
      expect(runtime.signalProcess.exitCode).toBe(1);
      expect(runtime.logs.some((line) => /All .* flows passed/.test(line))).toBe(false);
    });
  }
});

describe("E2E normal retry and teardown remain intact", () => {
  it("allows one safe retry, keeps RETRIED visible, and continues sequentially", async () => {
    const runtime = harnessRuntime({ runAttempt: ({ name, attempt }) =>
      name === "first" && attempt === 1 ? retryable : success,
    });
    runtime.cleanup.resolve();
    await runtime.main();
    expect(runtime.dispatches).toEqual([
      { name: "first", attempt: 1 }, { name: "first", attempt: 2 }, { name: "next", attempt: 1 },
    ]);
    expect(runtime.logs.some((line) => /^  RETRIED\s+first/.test(line))).toBe(true);
    expect(runtime.logs.some((line) => /^  PASS\s+next/.test(line))).toBe(true);
    expect(runtime.teardownEvents).toEqual(cleanupEvents);
    expect(runtime.signalProcess.exitCode).toBe(0);
    expect(runtime.exits).toEqual([]);
  });

  it.each([
    { label: "assertion", result: { ...retryable, kind: "assertion" as const } },
    { label: "committed mutation", result: { ...retryable, committed: 1 } },
    { label: "unknown mutation outcome", result: { ...retryable, indeterminate: 1 } },
  ])("refuses retry for $label and preserves the failed suite verdict", async ({ result }) => {
    const runtime = harnessRuntime({ runAttempt: ({ name }) => name === "first" ? result : success });
    runtime.cleanup.resolve();
    await runtime.main();
    expect(runtime.dispatches).toEqual([{ name: "first", attempt: 1 }, { name: "next", attempt: 1 }]);
    expect(runtime.errors.some((line) => line.includes("retrying once"))).toBe(false);
    expect(runtime.signalProcess.exitCode).toBe(1);
    expect(runtime.teardownEvents).toEqual(cleanupEvents);
  });

  it("never grants a third attempt after a retryable second failure", async () => {
    const runtime = harnessRuntime({ runAttempt: ({ name }) => name === "first" ? retryable : success });
    runtime.cleanup.resolve();
    await runtime.main();
    expect(runtime.dispatches).toEqual([
      { name: "first", attempt: 1 }, { name: "first", attempt: 2 }, { name: "next", attempt: 1 },
    ]);
    expect(runtime.signalProcess.exitCode).toBe(1);
  });

  it("keeps cleanup failure nonzero even when every flow passed", async () => {
    const runtime = harnessRuntime({ runAttempt: () => success, cleanupError: new Error("fixture cleanup failed") });
    runtime.cleanup.resolve();
    await runtime.main();
    expect(runtime.signalProcess.exitCode).toBe(1);
    expect(runtime.errors.some((line) => line.includes("cleanup FAILED"))).toBe(true);
    expect(runtime.teardownEvents).toEqual(cleanupEvents);
  });
});
