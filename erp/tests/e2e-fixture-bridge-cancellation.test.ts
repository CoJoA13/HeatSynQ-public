import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { deferred, harnessRuntime, type AttemptResult } from "./helpers/e2e-harness-runtime";

const passed: AttemptResult = {
  ok: true, contextClosed: true, error: null, kind: null,
  committed: 0, indeterminate: 0, netFailures: [],
};
const acknowledgedFailure: AttemptResult = {
  ...passed, ok: false, kind: "assertion", error: new Error("raw fixture assertion failed"), committed: 1,
};
const completeTeardown = [
  "server stopping", "server stopped", "log closed", "fixtures cleaned", "browser closed", "backups removed",
  "customer folders removed",
];

describe("cancelled recovery has only the shared single-flight cleanup owner", () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const { label, result } of [
      { label: "success", result: passed },
      { label: "acknowledged failure", result: acknowledgedFailure },
    ]) {
      for (const cleanupFirst of [false, true]) {
        it(`${signal}: late ${label} never reaps after cancellation, shared teardown ${cleanupFirst ? "complete" : "pending"}`, async () => {
          const attempt = deferred<AttemptResult>(), started = deferred<void>();
          const runtime = harnessRuntime({ flowNames: ["draft-recovery", "close-month-end"], runAttempt: () => {
            started.resolve(); return attempt.promise;
          } });
          let mainSettled = false;
          const done = runtime.main().finally(() => { mainSettled = true; });
          await started.promise;
          expect(runtime.dbCommands).toContain("create-draft-recovery");

          runtime.signalProcess.emit(signal);
          const shared = runtime.teardown();
          runtime.signalProcess.emit(signal === "SIGINT" ? "SIGTERM" : "SIGINT");
          expect(runtime.teardown()).toBe(shared);
          expect(runtime.teardownEvents).toEqual(["server stopping"]);
          expect(runtime.dbCommands).not.toContain("reap-draft-recovery");
          expect(runtime.dbCommands).not.toContain("cleanup");
          if (cleanupFirst) {
            runtime.cleanup.resolve(); await shared;
            expect(runtime.dbCommands.filter(command => command === "cleanup")).toHaveLength(1);
          }

          const created = (runtime.state as typeof runtime.state & { created: { draftRecovery: { phase: string } } }).created;
          const owned = created.draftRecovery, originalPhase = owned.phase;
          attempt.resolve(result);
          // Drain runnable continuations without releasing the explicit server-stop barrier.
          await setImmediate();
          try {
            expect(runtime.dispatches).toEqual([{ name: "draft-recovery", attempt: 1 }]);
            expect(runtime.dbCommands).not.toContain("reap-draft-recovery");
            expect(runtime.events).not.toContain("flow:close-month-end:1");
            expect(runtime.teardown()).toBe(shared);
            expect(created.draftRecovery).toBe(owned);
            expect(owned.phase).toBe(originalPhase);
            if (!cleanupFirst) {
              expect(mainSettled).toBe(false);
              expect(runtime.dbCommands).not.toContain("cleanup");
              expect(runtime.teardownEvents).toEqual(["server stopping"]);
              expect(runtime.exits).toEqual([]);
            }
          } finally {
            runtime.cleanup.resolve(); await done;
          }
          await setImmediate();
          expect(runtime.dbCommands.filter(command => command === "cleanup")).toHaveLength(1);
          expect(runtime.dbCommands).not.toContain("reap-draft-recovery");
          expect(created.draftRecovery).toBe(owned);
          expect(owned.phase).toBe(originalPhase);
          expect(runtime.teardownEvents).toEqual(completeTeardown);
          expect(runtime.events.indexOf("server stopped")).toBeLessThan(runtime.events.indexOf("db:cleanup"));
          expect(runtime.exits.length).toBeGreaterThan(0);
          expect(runtime.exits.every(code => code === 1)).toBe(true);
          expect(runtime.signalProcess.exitCode).toBe(1);
          expect(runtime.logs.some(line => /All .* flows passed/.test(line))).toBe(false);
        });
      }
    }
  }
});
