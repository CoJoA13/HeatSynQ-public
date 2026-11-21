import { afterEach, describe, expect, it, vi } from "vitest";
import { harnessRuntime, type AttemptResult } from "./helpers/e2e-harness-runtime";
import { stopRuntime } from "./helpers/e2e-fixture-bridge-runtime";

const passed: AttemptResult = { ok: true, contextClosed: true, error: null, kind: null, committed: 0, indeterminate: 0, netFailures: [] };
function outcome(promise: Promise<void>) {
  const result = { settled: false, error: undefined as unknown };
  const done = promise.then(() => { result.settled = true; }, error => { result.settled = true; result.error = error; });
  return { result, done };
}
afterEach(() => vi.useRealTimers());

describe("actual owned process-group stop body", () => {
  it.each([
    { label: "held exit", options: {} },
    { label: "killed flag records signal delivery", options: { killed: true } },
    { label: "leader has already exited but a worker survives", options: { leaderExited: true } },
  ])("does not resolve for $label until the entire group is absent", async ({ options }) => {
    vi.useFakeTimers();
    const runtime = stopRuntime(options), stopped = outcome(runtime.stop());
    await vi.advanceTimersByTimeAsync(5);
    expect(stopped.result.settled).toBe(false);
    runtime.groupGone(); await vi.advanceTimersByTimeAsync(60); await stopped.done;
    expect(stopped.result.error).toBeUndefined();
    expect(runtime.signals.some(row => row.target === -73100 && row.signal === 0)).toBe(true);
  });

  it("leader exit event cannot release a surviving group", async () => {
    vi.useFakeTimers();
    const runtime = stopRuntime(), stopped = outcome(runtime.stop());
    runtime.leaderExit(); await vi.advanceTimersByTimeAsync(5);
    expect(stopped.result.settled).toBe(false);
    runtime.groupGone(); await vi.advanceTimersByTimeAsync(60); await stopped.done;
    expect(stopped.result.error).toBeUndefined();
  });

  it("SIGKILL delivery is followed by a held termination barrier", async () => {
    vi.useFakeTimers();
    const runtime = stopRuntime(), stopped = outcome(runtime.stop());
    await vi.advanceTimersByTimeAsync(21);
    expect(runtime.signals.some(row => row.signal === "SIGKILL")).toBe(true);
    expect(stopped.result.settled).toBe(false);
    runtime.groupGone(); await vi.advanceTimersByTimeAsync(25); await stopped.done;
    expect(stopped.result.error).toBeUndefined();
  });

  it("bounded timeout with a live group rejects instead of reporting stopped", async () => {
    vi.useFakeTimers();
    const runtime = stopRuntime(), stopped = outcome(runtime.stop());
    await vi.advanceTimersByTimeAsync(100); await stopped.done;
    expect(stopped.result.error).toBeInstanceOf(Error);
  });

  it("permission-denied signal/probe cannot be interpreted as ESRCH", async () => {
    vi.useFakeTimers();
    const runtime = stopRuntime({ signalError: "EPERM" }), stopped = outcome(runtime.stop());
    await vi.advanceTimersByTimeAsync(100); await stopped.done;
    expect(stopped.result.error).toBeInstanceOf(Error);
  });

  it("an already absent group needs no TERM or KILL", async () => {
    vi.useFakeTimers();
    const runtime = stopRuntime(); runtime.groupGone();
    const stopped = outcome(runtime.stop()); await vi.advanceTimersByTimeAsync(100); await stopped.done;
    expect(stopped.result.error).toBeUndefined();
    expect(runtime.signals.filter(row => row.signal !== 0)).toEqual([]);
  });
});

describe("actual teardown joins positive stop and preserves failure cleanup", () => {
  it("does not dispatch DB cleanup on leader exit while a worker remains", async () => {
    vi.useFakeTimers();
    const group = stopRuntime();
    const runtime = harnessRuntime({ runAttempt: () => passed, stopServer: group.stop });
    runtime.cleanup.resolve();
    const done = outcome(runtime.main()); await vi.advanceTimersByTimeAsync(5);
    expect(runtime.dbCommands).not.toContain("cleanup");
    group.leaderExit(); await vi.advanceTimersByTimeAsync(5);
    expect(runtime.dbCommands).not.toContain("cleanup");
    group.groupGone(); await vi.advanceTimersByTimeAsync(60); await done.done;
    expect(done.result.error).toBeUndefined();
    expect(runtime.events.indexOf("server stopped")).toBeLessThan(runtime.events.indexOf("db:cleanup"));
    expect(runtime.teardownEvents).toContain("browser closed");
  });

  it("unresolved process-group stop refuses DB writes but still closes browser and records failed run", async () => {
    vi.useFakeTimers();
    const group = stopRuntime();
    const runtime = harnessRuntime({ runAttempt: () => passed, stopServer: group.stop });
    runtime.cleanup.resolve(); const done = outcome(runtime.main());
    await vi.advanceTimersByTimeAsync(100); await done.done;
    expect(runtime.dbCommands).not.toContain("cleanup");
    expect(runtime.state.cleanupFailed).toBeTruthy();
    expect(runtime.teardownEvents).toContain("browser closed");
    expect(runtime.signalProcess.exitCode).toBe(1);
  });

  it("a stop exception still attempts log/browser closure and records the original reason", async () => {
    const error = new Error("owned worker state cannot be proven");
    const runtime = harnessRuntime({ runAttempt: () => passed, stopServer: async () => { throw error; } });
    runtime.cleanup.resolve(); await outcome(runtime.main()).done;
    expect(runtime.dbCommands).not.toContain("cleanup");
    expect(runtime.state.cleanupFailed).toBeTruthy();
    expect(runtime.state.cleanupFailed).toContain(error.message);
    expect(runtime.teardownEvents).toContain("log closed");
    expect(runtime.teardownEvents).toContain("browser closed");
    expect(runtime.signalProcess.exitCode).toBe(1);
  });
});
