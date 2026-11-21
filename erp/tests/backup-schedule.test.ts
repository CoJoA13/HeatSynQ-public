import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { NIGHTLY_ARCHIVE_RE } from "@/lib/backup-constants";

/**
 * #354: the nightly backup runs at a fixed local time (BACKUP_TIME in BACKUP_TZ), whatever the
 * container's restart history. Design: docs/superpowers/specs/2026-09-29-fixed-backup-time-design.md.
 *
 * Each case runs the REAL scripts/backup.sh through the Compose entrypoint, with the Compose values,
 * against a fake clock. Only pg_dump, `date`'s idea of "now" and `sleep` are faked: gzip, the status
 * writes, retention and the catch-up `find` stay real (find and mv are replaced only in the cases
 * that make them fail). Rules that keep the cases honest (the design critique found each one):
 * - `sleep` never waits; it advances the fake clock by its argument. A case ends when the clock
 *   reaches `stopAt`: the stub then signals the scheduler, whose trap must exit 0.
 * - a dump is instant unless the case sets `dumpSeconds`. With an instant dump, "24 hours after the
 *   run" and "the next 23:10" are the same instant, so a case about that difference needs one.
 * - archive mtimes and the one-shot's 30-day prune use REAL time, so seeded archives get mtimes from
 *   the fake clock, and assertions cover only scheduler outputs (the fake time of each pg_dump, the
 *   sleep requests, the log, names of created archives), never seeded files surviving a run.
 * - the scheduler is spawned directly with an absolute /bin/sh: under a shell `&` it would inherit
 *   an ignored SIGINT, and a PATH `sh` stub (the launcher case) must not start the scheduler itself.
 * - TZ=UTC is pinned: the container's clock is UTC, the laptop's is America/Chicago.
 * - the real `date` is GNU's when the host has both (the laptop's default is uutils, which differs
 *   from GNU in the DST gap; CI and the postgres:18 image are GNU).
 */

const REAL_DATE = existsSync("/usr/bin/gnudate") ? "/usr/bin/gnudate" : "/bin/date";

const compose = readFileSync("docker-compose.yml", "utf8");

function composeValue(key: string): string {
  const matches = [...compose.matchAll(new RegExp(`^\\s+${key}: "?([^"\\n]+?)"?$`, "gm"))];
  expect(matches).toHaveLength(1);
  return matches[0][1];
}

function composeEntrypoint(): string[] {
  const entries = [...compose.matchAll(/^\s+entrypoint: (\[.+\])$/gm)];
  expect(entries).toHaveLength(1);
  return JSON.parse(entries[0][1]) as string[];
}

const at = (iso: string) => Date.parse(iso) / 1000;
// 2026-09-29 is on CDT (UTC-5), so its 23:10 slot is 04:10Z the next day.
const SLOT = at("2026-09-30T04:10:00Z"); //       2026-09-29 23:10 CDT
const PREVIOUS = SLOT - 86400; //                 2026-09-28 23:10 CDT
const NEXT = SLOT + 86400; //                     2026-09-30 23:10 CDT
const NOON = at("2026-09-29T17:00:00Z"); //       2026-09-29 12:00 CDT
/** Last night's nightly archive, completed 90 s after its slot. */
const GOOD_NIGHT = [{ name: "erp_2026-09-29_041030.sql.gz", completed: PREVIOUS + 90 }];

interface Archive { name: string; completed: number; truncated?: boolean }
interface Run {
  start: number; // the fake clock's first reading
  stopAt: number; // the sleep that brings the clock here stops the scheduler
  archives?: Archive[];
  failedDumps?: number;
  dumpSeconds?: number; // seconds each pg_dump moves the clock, as a real dump takes time
  env?: Record<string, string | undefined>; // undefined deletes the variable
  failure?: "retention" | "main-status" | "retention-status" | "launcher" | "probe";
  jump?: { onSleep: number; seconds: number }; // a suspend or wall-clock step during that sleep
  killSleepOn?: number; // that sleep is killed by a foreign SIGTERM instead of finishing
  tick?: number; // seconds the clock moves on each reading of "now"
  stopSignal?: "INT" | "TERM";
  linger?: boolean; // the stopping sleep keeps running, as a real one would
  signalDuringDump?: "INT" | "TERM";
  args?: string[]; // replaces the entrypoint's arguments
  mutateScript?: (text: string) => string;
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const STUBS: Record<string, string> = {
  date: `#!/bin/sh
# A call that names its own date (-d) is the real date; "now" comes from the fake clock.
for arg in "$@"; do
  case "$arg" in -d | -d* | --date | --date=*) exec "$REAL_DATE" "$@" ;; esac
done
now=$(cat "$TEST_DIR/clock")
[ -z "\${TICK:-}" ] || echo "$((now + TICK))" > "$TEST_DIR/clock"
exec "$REAL_DATE" -d "@$now" "$@"
`,
  sleep: `#!/bin/sh
n=$(($(wc -l < "$TEST_DIR/sleeps") + 1))
echo "$1" >> "$TEST_DIR/sleeps"
clock=$(($(cat "$TEST_DIR/clock") + $1))
[ "\${JUMP_ON:-0}" != "$n" ] || clock=$((clock + JUMP))
echo "$clock" > "$TEST_DIR/clock"
# Something other than the scheduler kills this sleep; the scheduler must keep going.
[ "\${KILL_SELF_ON:-0}" != "$n" ] || kill -TERM $$
if [ "$clock" -ge "$STOP_AT" ] || [ "$n" -ge 200 ]; then
  kill -"\${STOP_SIGNAL:-TERM}" "$PPID"
  [ -z "\${LINGER:-}" ] || exec /bin/sleep 5
fi
`,
  pg_dump: `#!/bin/sh
n=$(($(cat "$TEST_DIR/dump-count" 2>/dev/null || echo 0) + 1))
echo "$n" > "$TEST_DIR/dump-count"
cat "$TEST_DIR/clock" >> "$TEST_DIR/dumps"
[ -z "\${DUMP_SECONDS:-}" ] || echo "$(($(cat "$TEST_DIR/clock") + DUMP_SECONDS))" > "$TEST_DIR/clock"
if [ "$n" -le "\${FAILED_DUMPS:-0}" ]; then
  echo 'pg_dump: connection refused' >&2
  exit 1
fi
if [ -n "\${SIGNAL_DURING_DUMP:-}" ]; then
  # pg_dump's parent is the one-shot; the scheduler is ITS parent.
  kill -"$SIGNAL_DURING_DUMP" "$(awk '/^PPid:/ { print $2 }' "/proc/$PPID/status")"
fi
printf '%s\\n' '-- synthetic database' 'CREATE TABLE example (id int);'
`,
};

const FAILURE_STUBS: Record<string, Record<string, string>> = {
  retention: { find: findStub() },
  probe: { find: findStub() },
  "main-status": { mv: mvStub("backup-status.json") },
  "retention-status": { mv: mvStub("retention-status.json") },
  launcher: {
    sh: `#!/bin/sh
# The first launch of the one-shot fails the way a launcher does (exit 2); \`sh -n\` stays real.
if [ "$1" != -n ] && [ ! -f "$TEST_DIR/launcher-failed" ]; then
  : > "$TEST_DIR/launcher-failed"
  exit 2
fi
exec /bin/sh "$@"
`,
  },
};

function findStub(): string {
  return `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    -delete) [ "$FIND_FAIL" != retention ] || { echo 'find: cannot delete: Read-only file system' >&2; exit 1; } ;;
    -newermt) [ "$FIND_FAIL" != probe ] || { echo 'find: probe: Permission denied' >&2; exit 1; } ;;
  esac
done
exec /usr/bin/find "$@"
`;
}

function mvStub(filename: string): string {
  return `#!/bin/sh
case "$2" in
  */${filename}) echo 'status write failed' >&2; exit 1 ;;
esac
exec /bin/mv "$@"
`;
}

function writeExecutable(file: string, content: string) {
  writeFileSync(file, content);
  chmodSync(file, 0o755);
}

function lines(file: string): number[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number);
}

function schedule(run: Run) {
  const root = mkdtempSync(path.join(tmpdir(), "backup-schedule-"));
  temporaryDirectories.push(root);
  const bin = path.join(root, "bin");
  const backups = path.join(root, "backups");
  mkdirSync(bin);
  mkdirSync(backups);
  const script = path.join(root, "backup.sh");
  copyFileSync("scripts/backup.sh", script);
  if (run.mutateScript) writeFileSync(script, run.mutateScript(readFileSync(script, "utf8")));
  for (const [name, content] of Object.entries({ ...STUBS, ...(run.failure ? FAILURE_STUBS[run.failure] : {}) })) {
    writeExecutable(path.join(bin, name), content);
  }
  for (const archive of run.archives ?? []) {
    const file = path.join(backups, archive.name);
    const bytes = gzipSync(Buffer.from(`-- seeded ${archive.name}\n`.repeat(200)));
    writeFileSync(file, archive.truncated ? bytes.subarray(0, 40) : bytes);
    utimesSync(file, archive.completed, archive.completed);
  }
  writeFileSync(path.join(root, "clock"), `${run.start}\n`);
  writeFileSync(path.join(root, "sleeps"), "");

  const [shell, mounted, ...args] = composeEntrypoint();
  expect([shell, mounted]).toEqual(["sh", "/backup.sh"]);
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TZ: "UTC",
    TEST_DIR: root,
    REAL_DATE,
    BACKUP_DIR: backups,
    DATABASE_URL: "postgresql://synthetic@invalid/example",
    BACKUP_TIME: composeValue("BACKUP_TIME"),
    BACKUP_TZ: composeValue("BACKUP_TZ"),
    STOP_AT: String(run.stopAt),
    STOP_SIGNAL: run.stopSignal,
    LINGER: run.linger ? "1" : undefined,
    FAILED_DUMPS: String(run.failedDumps ?? 0),
    DUMP_SECONDS: run.dumpSeconds ? String(run.dumpSeconds) : undefined,
    SIGNAL_DURING_DUMP: run.signalDuringDump,
    FIND_FAIL: run.failure,
    JUMP_ON: run.jump ? String(run.jump.onSleep) : undefined,
    JUMP: run.jump ? String(run.jump.seconds) : undefined,
    KILL_SELF_ON: run.killSleepOn ? String(run.killSleepOn) : undefined,
    TICK: run.tick ? String(run.tick) : undefined,
    ...run.env,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];

  const began = Date.now();
  const result = spawnSync("/bin/sh", [script, ...(run.args ?? args)], {
    env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 10_000,
  });
  return {
    ...result,
    elapsedMs: Date.now() - began,
    dumps: lines(path.join(root, "dumps")),
    sleeps: lines(path.join(root, "sleeps")),
    created: readdirSync(backups).filter((name) => !(run.archives ?? []).some((a) => a.name === name)),
    backups,
    status: result.status,
    statusFile: () => JSON.parse(readFileSync(path.join(backups, "backup-status.json"), "utf8")) as { ok: boolean; error: string | null },
  };
}

/** The scheduler was stopped by the sleep stub and exited through its trap: no timeout, no signal. */
function expectStoppedCleanly(result: ReturnType<typeof schedule>) {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
}

describe("the Compose definition (#354)", () => {
  it("runs the mounted backup.sh in scheduled mode at 23:10 America/Chicago", () => {
    expect(composeEntrypoint()).toEqual(["sh", "/backup.sh", "--scheduled"]);
    expect(compose).toContain("- ./scripts/backup.sh:/backup.sh:ro");
    // Every expected instant below is computed for this time and zone; changing either is a
    // decision that updates these cases, the README and the manual together.
    expect(composeValue("BACKUP_TIME")).toBe("23:10");
    expect(composeValue("BACKUP_TZ")).toBe("America/Chicago");
  });
});

describe("when the nightly runs (#354)", () => {
  it("waits from noon until exactly 23:10 CDT, in chunks of at most an hour, and logs the plan", () => {
    const result = schedule({ start: NOON, stopAt: SLOT + 60, archives: GOOD_NIGHT });
    expectStoppedCleanly(result);
    expect(result.dumps).toEqual([SLOT]);
    expect(result.sleeps.every((seconds) => seconds > 0 && seconds <= 3600)).toBe(true);
    expect(result.stdout).toContain("nightly backup scheduled daily at 23:10 America/Chicago");
    expect(result.stdout).toContain("next nightly backup: 2026-09-29 23:10 CDT (2026-09-30T04:10:00Z)");
  });

  it("names the archive in UTC, like the app's manual archives", () => {
    const result = schedule({ start: NOON, stopAt: SLOT + 60, archives: GOOD_NIGHT });
    expectStoppedCleanly(result);
    expect(result.created).toContain("erp_2026-09-30_041000.sql.gz");
  });

  it("runs again at the next 23:10, not 24 hours after the run finished", () => {
    // The dump takes 90 s: with an instant one, 24 hours after the run IS the next 23:10.
    const result = schedule({ start: SLOT - 60, stopAt: NEXT + 60, archives: GOOD_NIGHT, dumpSeconds: 90 });
    expectStoppedCleanly(result);
    expect(result.dumps).toEqual([SLOT, NEXT]);
  });

  it("runs at once when started exactly at 23:10:00, then waits a full day", () => {
    const result = schedule({ start: SLOT, stopAt: NEXT + 60, archives: GOOD_NIGHT });
    expectStoppedCleanly(result);
    expect(result.dumps).toEqual([SLOT, NEXT]);
  });

  it("sleeps one second from 23:09:59", () => {
    const result = schedule({ start: SLOT - 1, stopAt: SLOT + 60, archives: GOOD_NIGHT });
    expectStoppedCleanly(result);
    expect(result.sleeps[0]).toBe(1);
    expect(result.dumps).toEqual([SLOT]);
  });

  it.each([
    // [what, start, the served slot's archive, the next slot, its distance]
    ["spring-forward (22 h 40 m)", "2026-03-08T05:30:00Z", "erp_2026-03-08_051030.sql.gz", "2026-03-08T05:10:00Z", "2026-03-09T04:10:00Z", 81600],
    ["fall-back (24 h 40 m)", "2026-11-01T04:30:00Z", "erp_2026-11-01_041030.sql.gz", "2026-11-01T04:10:00Z", "2026-11-02T05:10:00Z", 88800],
    ["the year boundary", "2027-01-01T05:30:00Z", "erp_2027-01-01_051030.sql.gz", "2027-01-01T05:10:00Z", "2027-01-02T05:10:00Z", 85200],
  ])("keeps 23:10 local across %s", (_what, start, name, served, next, distance) => {
    const result = schedule({
      start: at(start), stopAt: at(next) + 60, archives: [{ name, completed: at(served) + 90 }],
    });
    expectStoppedCleanly(result);
    expect(result.dumps).toEqual([at(next)]);
    expect(at(next) - at(start)).toBe(distance);
  });

  it("keeps waiting when something else kills its sleep", () => {
    const result = schedule({ start: NOON, stopAt: SLOT + 60, archives: GOOD_NIGHT, killSleepOn: 1 });
    expectStoppedCleanly(result);
    expect(result.sleeps[0]).toBe(3600);
    expect(result.dumps).toEqual([SLOT]);
  });

  it.each([
    ["a forward step (suspend or NTP)", 7200, SLOT],
    ["a backward step", -7200, SLOT],
    ["a step past the slot", 38000, NOON + 3600 + 38000],
  ])("re-reads the clock each chunk, so %s still runs on time", (_what, seconds, expected) => {
    const result = schedule({ start: NOON, stopAt: SLOT + 3600, archives: GOOD_NIGHT, jump: { onSleep: 1, seconds } });
    expectStoppedCleanly(result);
    expect(result.dumps).toEqual([expected]);
  });
});

describe("catch-up at start (#354)", () => {
  it("backs up at once on a first start, then waits for 23:10", () => {
    const result = schedule({ start: NOON, stopAt: SLOT });
    expectStoppedCleanly(result);
    expect(result.dumps).toEqual([NOON]);
    expect(result.sleeps.reduce((sum, seconds) => sum + seconds, 0)).toBe(SLOT - NOON);
    expect(result.stdout).toContain(
      "no intact nightly archive since 2026-09-28 23:10 CDT (2026-09-29T04:10:00Z); backing up now");
  });

  it("does nothing at the 04:05 deploy recreate after a good 23:10", () => {
    const result = schedule({
      start: at("2026-09-30T09:05:00Z"), stopAt: NEXT + 60,
      archives: [{ name: "erp_2026-09-30_041200.sql.gz", completed: SLOT + 120 }],
    });
    expectStoppedCleanly(result);
    expect(result.dumps).toEqual([NEXT]);
  });

  it("backs up at once when the host was off at 23:10", () => {
    const start = at("2026-09-30T12:00:00Z");
    const result = schedule({ start, stopAt: NEXT + 60, archives: GOOD_NIGHT });
    expectStoppedCleanly(result);
    expect(result.dumps).toEqual([start, NEXT]);
  });

  it.each([
    ["a manual archive", { name: "erp_manual_2026-09-30_041200_0a1b2c3d.sql.gz", completed: SLOT + 120 }],
    ["a truncated nightly archive", { name: "erp_2026-09-30_041200.sql.gz", completed: SLOT + 120, truncated: true }],
    ["a nightly archive completed exactly at the slot", { name: "erp_2026-09-30_041000.sql.gz", completed: SLOT }],
  ])("does not count %s as serving the slot", (_what, archive) => {
    const result = schedule({ start: SLOT + 600, stopAt: SLOT + 660, archives: [archive] });
    expectStoppedCleanly(result);
    expect(result.dumps).toEqual([SLOT + 600]);
  });

  it("counts an intact nightly archive completed a second after the slot", () => {
    const result = schedule({
      start: SLOT + 600, stopAt: SLOT + 660, archives: [{ name: "erp_2026-09-30_041001.sql.gz", completed: SLOT + 1 }],
    });
    expectStoppedCleanly(result);
    expect(result.dumps).toEqual([]);
  });

  it("backs up at once when the check itself fails, and the log says why", () => {
    const result = schedule({
      start: SLOT + 600, stopAt: SLOT + 660, failure: "probe",
      archives: [{ name: "erp_2026-09-30_041200.sql.gz", completed: SLOT + 120 }],
    });
    expectStoppedCleanly(result);
    expect(result.dumps).toEqual([SLOT + 600]);
    expect(result.stderr).toContain("find: probe: Permission denied");
  });

  it("at 23:05 after a missed night, backs up now and again at 23:10", () => {
    const result = schedule({
      start: SLOT - 300, stopAt: SLOT + 60, archives: [{ name: "erp_2026-09-28_041030.sql.gz", completed: PREVIOUS - 86400 + 90 }],
    });
    expectStoppedCleanly(result);
    expect(result.dumps).toEqual([SLOT - 300, SLOT]);
  });

  it("after a catch-up that runs past 23:10, waits for the next 23:10 instead of dumping again", () => {
    // Started at 23:09:30 with last night missing, the 90 s catch-up ends at 23:11:00 and serves 23:10.
    const result = schedule({ start: SLOT - 30, stopAt: NEXT + 60, dumpSeconds: 90 });
    expectStoppedCleanly(result);
    expect(result.dumps).toEqual([SLOT - 30, NEXT]);
  });

  it("decides the missed slot and the next one from ONE clock reading, so a start at 23:09:59 cannot skip the night", () => {
    // Every reading of "now" moves the clock a second, so a second reading would cross 23:10.
    const result = schedule({ start: SLOT - 1, stopAt: SLOT + 60, archives: GOOD_NIGHT, tick: 1 });
    expectStoppedCleanly(result);
    expect(result.dumps).toHaveLength(1);
    expect(result.dumps[0] - SLOT).toBeGreaterThanOrEqual(0);
    expect(result.dumps[0] - SLOT).toBeLessThan(60);
  });
});

describe("retries (GitLab issue 313, MR !325, kept by #354)", () => {
  it("retries a failed run every five minutes, then keeps the fixed 23:10", () => {
    const result = schedule({ start: SLOT - 60, stopAt: NEXT + 60, archives: GOOD_NIGHT, failedDumps: 2 });
    expectStoppedCleanly(result);
    expect(result.dumps).toEqual([SLOT, SLOT + 300, SLOT + 600, NEXT]);
    expect(result.stderr).toContain("backup failed (exit 1); retrying in 5 minutes");
  });

  it("retries a launcher failure (sh exit 2)", () => {
    const result = schedule({ start: NOON, stopAt: NOON + 360, failure: "launcher" });
    expectStoppedCleanly(result);
    expect(result.sleeps[0]).toBe(300);
    expect(result.dumps).toEqual([NOON + 300]);
    expect(result.stderr).toContain("backup failed (exit 2)");
  });

  it.each(["retention", "main-status", "retention-status"] as const)(
    "does not repeat a verified dump after a %s failure (exit 10 keeps the schedule)", (failure) => {
      const result = schedule({ start: NOON, stopAt: NOON + 60, failure });
      expectStoppedCleanly(result);
      expect(result.dumps).toEqual([NOON]);
      expect(result.sleeps[0]).toBe(3600);
      expect(result.stderr).toContain(failure === "retention" ? "retention FAILED" : "status write failed");
    });
});

describe("configuration (#354)", () => {
  it.each([
    ["BACKUP_TIME", undefined],
    ["BACKUP_TIME", "7:5"],
    ["BACKUP_TIME", "24:00"],
    ["BACKUP_TIME", "01:00"],
    ["BACKUP_TIME", "02:59"],
    ["BACKUP_TIME", "23:10\njunk"],
    ["BACKUP_TZ", undefined],
    ["BACKUP_TZ", "America/Chicgo"],
    ["BACKUP_TZ", "zone.tab"],
    ["BACKUP_TZ", "/America/Chicago"],
    ["BACKUP_TZ", "../zoneinfo/America/Chicago"],
  ])("refuses %s=%j: exits 1, says why, records it and never dumps", (key, value) => {
    const result = schedule({ start: NOON, stopAt: NOON + 60, env: { [key]: value } });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`backup scheduler: ${key}`);
    expect(result.statusFile()).toMatchObject({ ok: false });
    expect(result.statusFile().error).toContain(key);
    expect(result.dumps).toEqual([]);
    expect(result.sleeps).toEqual([]);
  });

  it("logs the reason first, so a status write that fails cannot lose it", () => {
    const result = schedule({ start: NOON, stopAt: NOON + 60, env: { BACKUP_TIME: "7:5" }, failure: "main-status" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("backup scheduler: BACKUP_TIME must be HH:MM");
    expect(result.stderr).toContain("status write failed");
    expect(result.dumps).toEqual([]);
    expect(result.sleeps).toEqual([]);
  });

  it.each([
    ["00:59", "next nightly backup: 2026-09-30 00:59 CDT (2026-09-30T05:59:00Z)"],
    ["03:00", "next nightly backup: 2026-09-30 03:00 CDT (2026-09-30T08:00:00Z)"],
  ])("accepts %s, just outside the daylight-saving hours", (time, line) => {
    const result = schedule({ start: NOON, stopAt: NOON + 60, env: { BACKUP_TIME: time } });
    expectStoppedCleanly(result);
    expect(result.stdout).toContain(line);
  });

  it("refuses a backup.sh whose one-shot does not parse, before it waits", () => {
    // Last night is served, so only a check made at start (not at the first run) can refuse it.
    const result = schedule({
      start: NOON, stopAt: NOON + 60, archives: GOOD_NIGHT, mutateScript: (text) => `${text}\nif then\n`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("backup scheduler: backup.sh does not parse");
    expect(result.dumps).toEqual([]);
    expect(result.sleeps).toEqual([]);
  });

  it("refuses an unknown argument without dumping", () => {
    const result = schedule({ start: NOON, stopAt: NOON + 60, args: ["--sheduled"] });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: backup.sh [--scheduled]");
    expect(result.dumps).toEqual([]);
  });
});

describe("stopping (#354)", () => {
  // `docker compose stop` sends SIGINT, the postgres image's stop signal; TERM is the fallback.
  // The stopping sleep lingers like a real one: a scheduler that waited in the foreground, or
  // whose trap left the sleep running, would hold the run for its full five seconds.
  it.each(["INT", "TERM"] as const)("exits 0 at once on SIG%s while it waits for 23:10", (stopSignal) => {
    const result = schedule({ start: NOON, stopAt: NOON + 1, archives: GOOD_NIGHT, stopSignal, linger: true });
    expectStoppedCleanly(result);
    expect(result.elapsedMs).toBeLessThan(2500);
    expect(result.sleeps).toEqual([3600]);
    expect(result.dumps).toEqual([]);
  });

  it.each(["INT", "TERM"] as const)("exits 0 at once on SIG%s during a retry wait", (stopSignal) => {
    const result = schedule({ start: NOON, stopAt: NOON + 1, failedDumps: 1, stopSignal, linger: true });
    expectStoppedCleanly(result);
    expect(result.elapsedMs).toBeLessThan(2500);
    expect(result.sleeps).toEqual([300]);
  });

  it("lets a dump in progress finish, then exits 0", () => {
    const result = schedule({ start: NOON, stopAt: NEXT, signalDuringDump: "INT" });
    expectStoppedCleanly(result);
    expect(result.dumps).toEqual([NOON]);
    expect(result.sleeps).toEqual([]);
    expect(result.statusFile()).toMatchObject({ ok: true, error: null });
    const archive = path.join(result.backups, "erp_2026-09-29_170000.sql.gz");
    expect(spawnSync("gzip", ["-t", archive]).status).toBe(0);
  });
});

describe("the nightly glob matches NIGHTLY_ARCHIVE_RE (#354 drift guard)", () => {
  it("accepts exactly the names the app calls nightly", () => {
    const glob = /^NIGHTLY_GLOB='(.+)'$/m.exec(readFileSync("scripts/backup.sh", "utf8"))?.[1];
    expect(glob).toBeDefined();
    const names = [
      "erp_2026-09-30_041000.sql.gz",
      "erp_manual_2026-09-30_041000_0a1b2c3d.sql.gz",
      ".erp_2026-09-30_041000.sql.tmp",
      "erp_2026-09-30_041000.sql.gz.partial",
      "before-restore-1790741400.sql.gz",
      "erp_2026-9-30_041000.sql.gz",
      "erp_2026-09-30_04100a.sql.gz",
      "erp_2026-09-30_041000.sql.gzip",
    ];
    for (const name of names) {
      const shell = spawnSync("/bin/sh", ["-c", `case "$1" in ${glob}) echo match ;; esac`, "sh", name], { encoding: "utf8" });
      expect({ name, match: shell.stdout.trim() === "match" }).toEqual({ name, match: NIGHTLY_ARCHIVE_RE.test(name) });
    }
  });
});

describe("the documented schedule matches Compose (#354 drift guard)", () => {
  // The README's Backups section is the canonical statement and the manual repeats it for
  // operators; a gated change of the time must update both, which this makes impossible to forget.
  it.each(["README.md", "../docs/manual/12-administration.md"])("%s names BACKUP_TIME and BACKUP_TZ", (file) => {
    expect(readFileSync(file, "utf8")).toContain(`${composeValue("BACKUP_TIME")} ${composeValue("BACKUP_TZ")}`);
  });
});
