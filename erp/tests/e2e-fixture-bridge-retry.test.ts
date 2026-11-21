import { describe, expect, it } from "vitest";
import { harnessRuntime, type AttemptResult } from "./helpers/e2e-harness-runtime";

const passed: AttemptResult = { ok: true, contextClosed: true, error: null, kind: null, committed: 0, indeterminate: 0, netFailures: [] };
const network: AttemptResult = { ...passed, ok: false, error: new Error("net::ERR_CONNECTION_REFUSED"), kind: "network", netFailures: [{ at: 0, line: "GET lost" }] };
const flows = ["draft-recovery", "close-month-end"];
async function finish(runtime: ReturnType<typeof harnessRuntime>) {
  runtime.cleanup.resolve();
  let error: unknown;
  try { await runtime.main(); } catch (caught) { error = caught; }
  return error;
}

describe("actual recovery loop keeps every context authoritative", () => {
  it("first unclosed attempt cannot be overwritten by a safe-looking second attempt", async () => {
    const runtime = harnessRuntime({ flowNames: flows, runAttempt: ({ attempt }) => attempt === 1 ? { ...network, contextClosed: false } : passed });
    const error = await finish(runtime);
    expect(runtime.dispatches).toEqual([{ name: "draft-recovery", attempt: 1 }]);
    expect(runtime.dbCommands).not.toContain("reap-draft-recovery");
    expect(error !== undefined || runtime.signalProcess.exitCode === 1).toBe(true);
    expect(runtime.events.indexOf("server stopped")).toBeLessThan(runtime.events.indexOf("db:cleanup"));
    expect(runtime.teardownEvents).toContain("browser closed");
  });

  it("mutation-free closed-context retry remains allowed before mandatory pre-close reap", async () => {
    const runtime = harnessRuntime({ flowNames: flows, runAttempt: ({ name, attempt }) => name === "draft-recovery" && attempt === 1 ? network : passed });
    expect(await finish(runtime)).toBeUndefined();
    expect(runtime.dispatches).toEqual([{ name: "draft-recovery", attempt: 1 }, { name: "draft-recovery", attempt: 2 }, { name: "close-month-end", attempt: 1 }]);
    expect(runtime.dbCommands.filter(command => command === "reap-draft-recovery")).toHaveLength(1);
    expect(runtime.events.indexOf("db:reap-draft-recovery")).toBeLessThan(runtime.events.indexOf("flow:close-month-end:1"));
    expect(runtime.logs.some(line => /^  RETRIED\s+draft-recovery/.test(line))).toBe(true);
  });

  it.each([
    { label: "unclosed retry", result: { ...network, contextClosed: false } },
    { label: "indeterminate retry", result: { ...network, indeterminate: 1 } },
  ])("a closed first attempt does not erase an $label", async ({ result }) => {
    const runtime = harnessRuntime({ flowNames: flows, runAttempt: ({ attempt }) => attempt === 1 ? network : result });
    const error = await finish(runtime);
    expect(runtime.dispatches).toEqual([{ name: "draft-recovery", attempt: 1 }, { name: "draft-recovery", attempt: 2 }]);
    expect(runtime.dbCommands).not.toContain("reap-draft-recovery");
    expect(error !== undefined || runtime.signalProcess.exitCode === 1).toBe(true);
  });

  it("acknowledged assertion failure still reaps before month-end and stays failed", async () => {
    const runtime = harnessRuntime({ flowNames: flows, runAttempt: ({ name }) => name === "draft-recovery" ? { ...network, kind: "assertion", committed: 1 } : passed });
    expect(await finish(runtime)).toBeUndefined();
    expect(runtime.dispatches).toEqual([{ name: "draft-recovery", attempt: 1 }, { name: "close-month-end", attempt: 1 }]);
    expect(runtime.events.indexOf("db:reap-draft-recovery")).toBeLessThan(runtime.events.indexOf("flow:close-month-end:1"));
    expect(runtime.signalProcess.exitCode).toBe(1);
  });

  it("reaper failure aborts before month-end while shared cleanup remains attempted", async () => {
    const runtime = harnessRuntime({ flowNames: flows, runAttempt: () => passed, recoveryReapError: new Error("owned reap refused") });
    expect(await finish(runtime)).toBeInstanceOf(Error);
    expect(runtime.dispatches).toEqual([{ name: "draft-recovery", attempt: 1 }]);
    expect(runtime.dbCommands).toContain("cleanup");
    expect(runtime.events.indexOf("server stopped")).toBeLessThan(runtime.events.indexOf("db:cleanup"));
  });
});
