import { describe, expect, it } from "vitest";
import { harnessRuntime, type AttemptResult } from "./helpers/e2e-harness-runtime";

const success: AttemptResult = {
  ok: true, error: null, kind: null, committed: 0, indeterminate: 0, netFailures: [],
};

describe("E2E production server mode (#326)", () => {
  it("builds before any fixture is written, artifacts are rotated, or a flow is dispatched", async () => {
    const runtime = harnessRuntime({ serverMode: "production", runAttempt: () => success });
    runtime.cleanup.resolve();
    await runtime.main();
    expect(runtime.events.indexOf("build")).toBeGreaterThanOrEqual(0);
    expect(runtime.events.indexOf("build")).toBeLessThan(runtime.events.indexOf("rotate"));
    expect(runtime.events.indexOf("build")).toBeLessThan(runtime.events.indexOf("db:create"));
    expect(runtime.events.indexOf("build")).toBeLessThan(runtime.events.findIndex((e) => e.startsWith("flow:")));
    expect(runtime.dispatches.length).toBeGreaterThan(0);
  });

  it("a failed build refuses before rotating artifacts or writing fixtures, and dispatches nothing", async () => {
    const runtime = harnessRuntime({ serverMode: "production", buildError: new Error("next build failed: exit 1"),
      runAttempt: () => success });
    runtime.cleanup.resolve();
    await expect(runtime.main()).rejects.toThrow(/next build failed/);
    // #335: teardown waits for the preparation and must outlive its failure. The build's error is
    // main()'s to report; were it to reject teardown too, the backup folder would stay behind.
    expect(runtime.teardownEvents).toContain("backups removed");
    expect(runtime.events).not.toContain("rotate");
    expect(runtime.events).not.toContain("db:create");
    expect(runtime.dispatches).toEqual([]);
  });

  it("removes the standalone tree only after the server has stopped", async () => {
    const runtime = harnessRuntime({ serverMode: "production", runAttempt: () => success });
    runtime.cleanup.resolve();
    await runtime.main();
    const stopped = runtime.teardownEvents.indexOf("server stopped");
    const removed = runtime.teardownEvents.indexOf("standalone removed");
    expect(stopped).toBeGreaterThanOrEqual(0);
    expect(removed).toBeGreaterThan(stopped);
  });

  it("keeps the standalone tree when the server's own termination cannot be proven", async () => {
    const runtime = harnessRuntime({
      serverMode: "production",
      runAttempt: () => success,
      stopServer: async () => { throw new Error("stop failed"); },
    });
    runtime.cleanup.resolve();
    await runtime.main();
    expect(runtime.teardownEvents).not.toContain("standalone removed");
    expect(runtime.state.cleanupFailed).toMatch(/owned-server termination unproven/);
  });

  it("re-checks the port after the build and refuses before rotating artifacts, seeding fixtures, or dispatching a flow", async () => {
    const runtime = harnessRuntime({
      serverMode: "production", runAttempt: () => success,
      // First call (pre-build) reports free; second call (post-build re-check) reports taken.
      portFreeResults: [true, false],
    });
    runtime.cleanup.resolve();
    await expect(runtime.main()).rejects.toThrow(/already in use/);
    expect(runtime.events).toContain("build");
    expect(runtime.events).not.toContain("rotate");
    expect(runtime.events).not.toContain("db:create");
    expect(runtime.dispatches).toEqual([]);
  });

  it("dev mode never builds", async () => {
    const runtime = harnessRuntime({ serverMode: "dev", runAttempt: () => success });
    runtime.cleanup.resolve();
    await runtime.main();
    expect(runtime.events).not.toContain("build");
    expect(runtime.teardownEvents).not.toContain("standalone removed");
  });
});
