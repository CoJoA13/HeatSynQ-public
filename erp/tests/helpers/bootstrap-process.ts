import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export type BootstrapCommand = (file: string, args: string[], options: {
  cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number;
}) => Promise<{ stdout: string; stderr: string }>;

// Linux CI/development: descendants of tsx and the real bootstrap CLI inherit the
// detached process group. A zombie cannot execute or hold a database connection.
async function groupIsRunning(group: number) {
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === group && fields[0] !== "Z" && fields[0] !== "X") return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return false;
}

export function bootstrapCommands(signal: AbortSignal) {
  const children = new Set<{ stop: () => Promise<void>; done: Promise<unknown> }>();
  let stopped = false;
  const exec: BootstrapCommand = (file, args, options) => {
    if (stopped || signal.aborted) return Promise.reject(new Error("Bootstrap command cancelled"));
    if (process.platform !== "linux") return Promise.reject(new Error("Bootstrap process ownership requires Linux /proc"));
    const child = spawn(file, args, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    let outputExceeded = false;
    let failure: Error | undefined;
    const closed = new Promise<void>(resolve => {
      child.once("error", error => { failure = error; });
      child.once("close", (code, killed) => {
        if (code !== 0 && !failure) failure = Object.assign(new Error("Bootstrap command failed"), { code, signal: killed });
        resolve();
      });
    });
    let stopping: Promise<void> | undefined;
    const stop = () => stopping ??= (async () => {
      const group = child.pid;
      if (!group) { await closed; return; }
      const kill = (kind: NodeJS.Signals) => {
        try { process.kill(-group, kind); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      };
      kill("SIGTERM");
      const deadline = Date.now() + 4_000;
      const escalate = Date.now() + 1_000;
      while (await groupIsRunning(group)) {
        if (Date.now() >= escalate) kill("SIGKILL");
        if (Date.now() >= deadline) throw new Error("Bootstrap process group did not stop");
        await delay(20);
      }
      await closed;
    })();
    const cancel = () => { void stop().catch(() => { /* stopAll joins and reports this failure */ }); };
    const collect = (stream: "stdout" | "stderr", data: Buffer) => {
      // Retain at most maxBuffer plus one read chunk while cancellation joins.
      if (outputExceeded) return;
      if (stream === "stdout") stdout += data.toString(); else stderr += data.toString();
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > (options.maxBuffer ?? 1024 * 1024)) {
        outputExceeded = true;
        failure = new Error("Bootstrap command output exceeded its bound"); cancel();
      }
    };
    child.stdout.on("data", data => collect("stdout", data));
    child.stderr.on("data", data => collect("stderr", data));
    const done = (async () => {
      await closed;
      // Also stop descendants if the group leader exited without waiting for them.
      await stop();
      if (signal.aborted || stopped) throw new Error("Bootstrap command cancelled");
      if (failure) throw failure;
      return { stdout, stderr };
    })();
    const owned = { stop, done };
    children.add(owned);
    signal.addEventListener("abort", cancel, { once: true });
    void done.then(() => { children.delete(owned); signal.removeEventListener("abort", cancel); }, () => {
      // Retain failed commands until stopAll has joined their cancellation too.
      signal.removeEventListener("abort", cancel);
    });
    return done;
  };
  return { exec, async stopAll() {
    stopped = true;
    const owned = [...children];
    const results = await Promise.allSettled(owned.map(async child => { await child.stop(); await child.done.catch(() => {}); }));
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Bootstrap children did not settle");
  } };
}
