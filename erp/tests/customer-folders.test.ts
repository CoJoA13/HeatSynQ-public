// #588: the office share's slot (src/server/customer-folders.ts), the save's folder check and the
// print's copy. A real temp directory stands in for the share, holding the marker and the customer
// folders. A recording fs wraps node:fs/promises: it lists every call, counts the calls in flight
// (afterEach holds every test to at most one at a time) and can hold a call, after its real work
// and before it answers, or fail one with a chosen errno. Timers are faked (setTimeout, clearTimeout,
// Date and performance only: the slot's deadlines read performance.now()), so a deadline passes only
// when a test moves the clock and no run of real fs calls can overrun one; setImmediate stays real,
// so `now()` can tell "answered at once" from "waiting".
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkCustomerFolder, fileCustomerCopy, makeOfficeShare, makeSlot, nextFilingTicket,
  type CustomerFiling, type OfficeShareDeps, type ShareFs,
} from "@/server/customer-folders";
import { CUSTOMER_FOLDERS_MARKER } from "@/lib/invoice-folder-entry";
import {
  BAD_PATH_NAME, FOLDER_NOT_FOUND, PRINT_FOLDER_NOT_FOUND, PRINT_NO_FOLDER, PRINT_NOT_CONNECTED, PRINT_REFUSED,
  PRINT_SKIPPED, PRINT_TIMED_OUT, SAVE_BUSY, SAVE_NOT_CONNECTED, SAVE_TIMED_OUT, SHARE_ITSELF, SHARE_NOT_SET_UP,
} from "@/lib/customer-folder-words";

const WAIT = 1_000;
const ROOT = "Z:\\";
const PDF = Buffer.from("%PDF-1.7 the first print\n");
const PDF_2 = Buffer.from("%PDF-1.7 the second print\n");

// The share's layout, made fresh for each test.
let base: string;
let share: string;
let outside: string;
const marker = () => path.join(share, CUSTOMER_FOLDERS_MARKER);
const folderOf = (name: string) => path.join(share, "Customers", name);
const tempOf = (file: string, suffix = "00000000") => path.join(folderOf("Acme"), `.${file}.${suffix}.tmp`);

type FsName = "access" | "realpath" | "stat" | "writeFile" | "rename" | "unlink";
type Call = { name: FsName; path: string };
type Rule = { name: FsName; on?: string; fail?: string; afterReal?: boolean; hold?: { arrive: () => void; gate: Promise<void> } };

function errnoError(code: string, name: FsName, at: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: a simulated failure, ${name} '${at}'`), { code, syscall: name, path: at });
}

/** `real` stands in for what a call does before the recording answers it (node:fs/promises by
 *  default), so a call a test makes up is still listed and counted in flight. */
function recordingFs(real: Partial<ShareFs> = {}) {
  const base: ShareFs = {
    access: (at) => fsp.access(at),
    realpath: (at) => fsp.realpath(at),
    stat: (at) => fsp.stat(at),
    // The options pass through as the module sends them: the "wx" test reads what the real call did.
    writeFile: (at, data, options) => fsp.writeFile(at, data, options),
    rename: (from, to) => fsp.rename(from, to),
    unlink: (at) => fsp.unlink(at),
    ...real,
  };
  const calls: Call[] = [];
  const rules: Rule[] = [];
  const releases: (() => void)[] = [];
  const state = { inFlight: 0, maxInFlight: 0 };
  // A rule applies once, to the first call of its name (and path, when it names one).
  const ruleFor = (name: FsName, at: string) => {
    const index = rules.findIndex((rule) => rule.name === name && (rule.on === undefined || rule.on === at));
    return index < 0 ? undefined : rules.splice(index, 1)[0];
  };
  function wrap<A extends [string, ...unknown[]], R>(name: FsName, real: (...args: A) => Promise<R>) {
    return async (...args: A): Promise<R> => {
      const at = args[0];
      calls.push({ name, path: at });
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        const rule = ruleFor(name, at);
        if (rule?.fail !== undefined && !rule.afterReal) throw errnoError(rule.fail, name, at);
        const result = await real(...args);
        if (rule?.hold) {
          rule.hold.arrive();
          await rule.hold.gate;
        }
        if (rule?.fail !== undefined) throw errnoError(rule.fail, name, at);
        return result;
      } finally {
        state.inFlight -= 1;
      }
    };
  }
  const fs = {
    access: wrap("access", base.access),
    realpath: wrap("realpath", base.realpath),
    stat: wrap("stat", base.stat),
    writeFile: wrap("writeFile", base.writeFile),
    rename: wrap("rename", base.rename),
    unlink: wrap("unlink", base.unlink),
  };
  return {
    fs,
    calls,
    state,
    names: () => calls.map((call) => call.name),
    /** The next matching call fails with `code`: before its real work, or after it (`afterReal`). */
    fail(name: FsName, code: string, options: { on?: string; afterReal?: boolean } = {}) {
      rules.push({ name, fail: code, ...options });
    },
    /** The next matching call does its real work, then waits for `release()` before it answers. */
    hold(name: FsName, on?: string) {
      let arrive!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => { arrive = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      rules.push({ name, on, hold: { arrive, gate } });
      releases.push(release);
      return { reached, release };
    },
    releaseAll: () => releases.forEach((release) => release()),
  };
}

const recordings: ReturnType<typeof recordingFs>[] = [];

/** The share under test, with its own recording fs (over `real`, see recordingFs). `isPractice`,
 *  `env` and `log` are mocks, so a test can ask whether and how often each was called. */
function setUp(overrides: Partial<Omit<OfficeShareDeps, "waitMs" | "log">> = {}, real: Partial<ShareFs> = {}) {
  const recording = recordingFs(real);
  recordings.push(recording);
  let suffixes = 0;
  const deps = {
    fs: overrides.fs ?? recording.fs,
    isPractice: vi.fn(overrides.isPractice ?? (async () => false)),
    waitMs: WAIT,
    env: vi.fn(overrides.env ?? (() => ({ OFFICE_SHARE_DIR: share, OFFICE_SHARE_ROOT: ROOT }))),
    log: vi.fn<(line: string) => void>(),
    suffix: overrides.suffix ?? (() => (suffixes++).toString(16).padStart(8, "0")),
    now: overrides.now,
  };
  return { ...recording, deps, office: makeOfficeShare(deps) };
}

function filing(overrides: Partial<CustomerFiling> = {}): CustomerFiling {
  return { kind: "INVOICE", number: 1001, folder: "Z:\\Customers\\Acme", ticket: nextFilingTicket(), ...overrides };
}

const PENDING = Symbol("pending");
/** The promise's value once every queued microtask has run, or PENDING. */
function now<T>(promise: Promise<T>): Promise<T | typeof PENDING> {
  return Promise.race([promise, new Promise<typeof PENDING>((resolve) => setImmediate(() => resolve(PENDING)))]);
}

/** Lets a chain still running after its caller was answered finish: real event-loop turns until no
 *  fs call is in flight (a held call counts, so release it first), then one more. Bounded on
 *  process.hrtime, which the fake timers leave real. */
async function idle(recording: ReturnType<typeof recordingFs>): Promise<void> {
  const started = process.hrtime.bigint();
  for (;;) {
    await new Promise((resolve) => setImmediate(resolve));
    if (recording.state.inFlight === 0) break;
    if (process.hrtime.bigint() - started > BigInt(5_000_000_000)) throw new Error("an fs call never settled");
  }
  await new Promise((resolve) => setImmediate(resolve));
}

function expectOneLog(log: Mock<(line: string) => void>, ...parts: string[]) {
  expect(log).toHaveBeenCalledTimes(1);
  const line = log.mock.calls[0][0];
  expect(line.startsWith("[customer-folders] ")).toBe(true);
  for (const part of parts) expect(line).toContain(part);
  expect(line).not.toContain("%PDF");
}

const ls = (dir: string) => fsp.readdir(dir).then((names) => names.sort());

/** Thrown values that refuse to be read: String() cannot convert an object with no prototype, and a
 *  Proxy can refuse both its prototype, which `instanceof` asks for, and every property. */
const UNREADABLE: [string, () => unknown][] = [
  ["an object with no prototype", () => Object.create(null)],
  ["a Proxy that refuses its prototype and its properties", () => new Proxy({}, {
    getPrototypeOf() { throw new Error("no prototype"); },
    get() { throw new Error("no property"); },
  })],
];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  // realpath: a symlinked tmpdir would otherwise put the share's real path outside its configured one.
  base = await fsp.realpath(await fsp.mkdtemp(path.join(tmpdir(), "hsq-customer-folders-")));
  share = path.join(base, "share");
  outside = path.join(base, "outside");
  await fsp.mkdir(folderOf("Acme"), { recursive: true });
  await fsp.mkdir(folderOf("Beta"), { recursive: true });
  await fsp.mkdir(outside);
  await fsp.writeFile(marker(), "");
});

afterEach(async () => {
  // Every chain a test left held or waiting finishes on the test's own clock before the share goes.
  const done = recordings.splice(0);
  for (const recording of done) {
    recording.releaseAll();
    await idle(recording);
  }
  vi.useRealTimers();
  for (const recording of done) expect(recording.state.maxInFlight).toBeLessThanOrEqual(1);
  await fsp.rm(base, { recursive: true, force: true });
});

describe("checkCustomerFolder", () => {
  it("answers a blank paste with the blank value and asks nothing else", async () => {
    const { office, deps, calls } = setUp();
    for (const pasted of ["", "   ", '""', ' "" ', '"  "']) {
      expect(await office.checkCustomerFolder(pasted)).toEqual({ ok: true, value: "" });
    }
    expect(deps.env).not.toHaveBeenCalled();
    expect(deps.isPractice).not.toHaveBeenCalled();
    expect(deps.log).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("refuses a path when no share is set up, without asking whether this is the practice copy", async () => {
    for (const env of [{}, { OFFICE_SHARE_DIR: "", OFFICE_SHARE_ROOT: " " }]) {
      const { office, deps, calls } = setUp({ env: () => env });
      expect(await office.checkCustomerFolder("Z:\\Customers\\Acme")).toEqual({ ok: false, message: SHARE_NOT_SET_UP });
      expect(deps.isPractice).not.toHaveBeenCalled();
      expect(deps.log).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    }
  });

  it("reads the share's settings at each call", async () => {
    let env: { OFFICE_SHARE_DIR?: string; OFFICE_SHARE_ROOT?: string } = {};
    const { office } = setUp({ env: () => env });
    expect(await office.checkCustomerFolder("Z:\\Customers\\Acme")).toEqual({ ok: false, message: SHARE_NOT_SET_UP });
    env = { OFFICE_SHARE_DIR: share, OFFICE_SHARE_ROOT: ROOT };
    expect(await office.checkCustomerFolder("Z:\\Customers\\Acme")).toEqual({ ok: true, value: "Z:\\Customers\\Acme" });
  });

  it("refuses on the practice copy with no fs call and no log", async () => {
    const { office, deps, calls } = setUp({ isPractice: vi.fn(async () => true) });
    expect(await office.checkCustomerFolder("Z:\\Customers\\Acme")).toEqual({ ok: false, message: SHARE_NOT_SET_UP });
    expect(deps.isPractice).toHaveBeenCalledTimes(1);
    expect(deps.log).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("refuses on the practice copy with no log even when the share's settings are misconfigured", async () => {
    const { office, deps, calls } = setUp({
      isPractice: vi.fn(async () => true),
      env: () => ({ OFFICE_SHARE_DIR: share }),
    });
    expect(await office.checkCustomerFolder("Z:\\Customers\\Acme")).toEqual({ ok: false, message: SHARE_NOT_SET_UP });
    expect(deps.log).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("refuses as not connected, logged, when the practice check fails", async () => {
    const { office, deps, calls } = setUp({
      isPractice: vi.fn(async () => { throw new Error("the database is unreachable"); }),
    });
    expect(await office.checkCustomerFolder("Z:/Customers/Acme")).toEqual({ ok: false, message: SAVE_NOT_CONNECTED });
    expectOneLog(deps.log, JSON.stringify("Z:\\Customers\\Acme"), "the database is unreachable");
    expect(calls).toEqual([]);
  });

  it("refuses a misconfigured share as not set up, logged", async () => {
    const { office, deps, calls } = setUp({ env: () => ({ OFFICE_SHARE_ROOT: ROOT }) });
    expect(await office.checkCustomerFolder("Z:\\Customers\\Acme")).toEqual({ ok: false, message: SHARE_NOT_SET_UP });
    expectOneLog(deps.log, JSON.stringify("Z:\\Customers\\Acme"), "misconfigured", "must be set together");
    expect(calls).toEqual([]);
  });

  it("quotes the pasted folder in its log line, so a line break in a paste cannot split it", async () => {
    const { office, deps } = setUp({ env: () => ({ OFFICE_SHARE_ROOT: ROOT }) });
    await office.checkCustomerFolder("Z:\\Customers\\Acme\n[customer-folders] forged");
    expect(deps.log).toHaveBeenCalledTimes(1);
    expect(deps.log.mock.calls[0][0]).not.toContain("\n");
  });

  it("refuses each path the share cannot hold with its own sentence, touching nothing", async () => {
    const { office, deps, calls } = setUp();
    for (const pasted of ["C:\\Customers\\Acme", "\\\\server\\share\\Acme", "Customers\\Acme", "Z:Customers"]) {
      expect(await office.checkCustomerFolder(pasted)).toEqual({
        ok: false,
        message: "That path is not inside the invoice share, Z:\\. Paste a folder's path from Windows Explorer's address bar.",
      });
    }
    for (const pasted of ["Z:\\", "z:", '"Z:/"']) {
      expect(await office.checkCustomerFolder(pasted)).toEqual({ ok: false, message: SHARE_ITSELF });
    }
    for (const pasted of ["Z:\\Customers\\A*B", "Z:\\Customers\\CON", "Z:\\Customers\\Acme.", "Z:\\Customers\\\\Acme"]) {
      expect(await office.checkCustomerFolder(pasted)).toEqual({ ok: false, message: BAD_PATH_NAME });
    }
    expect(deps.log).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("shows a UNC root as stored in the not-inside sentence", async () => {
    const { office } = setUp({ env: () => ({ OFFICE_SHARE_DIR: share, OFFICE_SHARE_ROOT: "\\\\files\\office\\" }) });
    expect(await office.checkCustomerFolder("Z:\\Customers\\Acme")).toEqual({
      ok: false,
      message: "That path is not inside the invoice share, \\\\files\\office. Paste a folder's path from Windows Explorer's address bar.",
    });
  });

  it("refuses as not connected when the marker file is missing, logged with its errno", async () => {
    await fsp.rm(marker());
    const { office, deps, calls } = setUp();
    expect(await office.checkCustomerFolder("Z:\\Customers\\Acme")).toEqual({ ok: false, message: SAVE_NOT_CONNECTED });
    expectOneLog(deps.log, JSON.stringify("Z:\\Customers\\Acme"), "ENOENT");
    expect(calls).toEqual([{ name: "access", path: marker() }]);
  });

  it("refuses as not connected when the share's own folder cannot be resolved", async () => {
    const { office, deps, calls, fail } = setUp();
    fail("realpath", "EACCES", { on: share });
    expect(await office.checkCustomerFolder("Z:\\Customers\\Acme")).toEqual({ ok: false, message: SAVE_NOT_CONNECTED });
    expectOneLog(deps.log, "EACCES");
    expect(calls).toEqual([{ name: "access", path: marker() }, { name: "realpath", path: share }]);
  });

  it("refuses a folder that does not exist, logged", async () => {
    const { office, deps, calls } = setUp();
    expect(await office.checkCustomerFolder("Z:\\Customers\\Gamma")).toEqual({ ok: false, message: FOLDER_NOT_FOUND });
    expectOneLog(deps.log, JSON.stringify("Z:\\Customers\\Gamma"), "ENOENT");
    expect(calls.at(-1)).toEqual({ name: "realpath", path: folderOf("Gamma") });
  });

  it("refuses a path that runs through a file as not found (ENOTDIR)", async () => {
    await fsp.writeFile(folderOf("notes.txt"), "a file");
    const { office, deps } = setUp();
    expect(await office.checkCustomerFolder("Z:\\Customers\\notes.txt\\Acme")).toEqual({ ok: false, message: FOLDER_NOT_FOUND });
    expectOneLog(deps.log, "ENOTDIR");
  });

  it("refuses a file where the folder should be as not found", async () => {
    await fsp.writeFile(folderOf("notes.txt"), "a file");
    const { office, deps, calls } = setUp();
    expect(await office.checkCustomerFolder("Z:\\Customers\\notes.txt")).toEqual({ ok: false, message: FOLDER_NOT_FOUND });
    expectOneLog(deps.log, "not a directory");
    expect(calls.at(-1)).toEqual({ name: "stat", path: folderOf("notes.txt") });
  });

  it("refuses any other error resolving the folder as not connected", async () => {
    const { office, deps, fail } = setUp();
    fail("realpath", "EACCES", { on: folderOf("Acme") });
    expect(await office.checkCustomerFolder("Z:\\Customers\\Acme")).toEqual({ ok: false, message: SAVE_NOT_CONNECTED });
    expectOneLog(deps.log, "EACCES");
  });

  it("refuses a folder that a link takes out of the share as not found", async () => {
    await fsp.symlink(outside, folderOf("Link"));
    const { office, deps, names } = setUp();
    expect(await office.checkCustomerFolder("Z:\\Customers\\Link")).toEqual({ ok: false, message: FOLDER_NOT_FOUND });
    expectOneLog(deps.log, "outside the share");
    expect(names()).toEqual(["access", "realpath", "realpath"]);
  });

  it("refuses a link to the share itself as not found", async () => {
    await fsp.symlink(share, folderOf("Top"));
    const { office } = setUp();
    expect(await office.checkCustomerFolder("Z:\\Customers\\Top")).toEqual({ ok: false, message: FOLDER_NOT_FOUND });
  });

  it("answers a found folder with the normalised value, unlogged", async () => {
    const { office, deps, calls } = setUp();
    expect(await office.checkCustomerFolder('"Z:/Customers/Acme/"')).toEqual({ ok: true, value: "Z:\\Customers\\Acme" });
    expect(calls).toEqual([
      { name: "access", path: marker() },
      { name: "realpath", path: share },
      { name: "realpath", path: folderOf("Acme") },
      { name: "stat", path: folderOf("Acme") },
    ]);
    // The root is compared without regard to case, and the value keeps the case it was pasted in.
    expect(await office.checkCustomerFolder("z:\\Customers\\Acme")).toEqual({ ok: true, value: "z:\\Customers\\Acme" });
    // A link that stays inside the share is followed.
    await fsp.symlink(folderOf("Beta"), folderOf("Alias"));
    expect(await office.checkCustomerFolder("Z:\\Customers\\Alias")).toEqual({ ok: true, value: "Z:\\Customers\\Alias" });
    expect(deps.log).not.toHaveBeenCalled();
  });

  it("never rejects: a failure no step expected refuses as not connected, logged", async () => {
    const recording = setUp({}, {
      stat: async () => ({ isDirectory: () => { throw new TypeError("an unreadable stat"); } }),
    });
    const { office, deps } = recording;
    const answer = office.checkCustomerFolder("Z:\\Customers\\Acme");
    await idle(recording);
    expect(await now(answer)).toEqual({ ok: false, message: SAVE_NOT_CONNECTED });
    expectOneLog(deps.log, "an unreadable stat");
  });

  // Answered at once, not at the deadline: a chain that rejected would leave its caller waiting for
  // its timer (the slot's belts, below).
  it.each(UNREADABLE)("never rejects: %s, thrown where no step expected it, refuses as not connected at once, logged", async (_label, thrown) => {
    const recording = setUp({}, { stat: async () => ({ isDirectory: () => { throw thrown(); } }) });
    const { office, deps } = recording;
    const answer = office.checkCustomerFolder("Z:\\Customers\\Acme");
    await idle(recording);
    expect(await now(answer)).toEqual({ ok: false, message: SAVE_NOT_CONNECTED });
    expectOneLog(deps.log, JSON.stringify("Z:\\Customers\\Acme"), "a thrown value that cannot be read");
  });
});

describe("fileCustomerCopy", () => {
  it("files the exact bytes as Invoice-<n>.pdf in the customer's folder, leaving no temp", async () => {
    const { office, deps, calls } = setUp();
    expect(await office.fileCustomerCopy(filing(), PDF)).toEqual({ warning: null });
    expect(await ls(folderOf("Acme"))).toEqual(["Invoice-1001.pdf"]);
    expect(await fsp.readFile(path.join(folderOf("Acme"), "Invoice-1001.pdf"))).toEqual(PDF);
    expect(deps.log).not.toHaveBeenCalled();
    expect(calls).toEqual([
      { name: "access", path: marker() },
      { name: "realpath", path: share },
      { name: "realpath", path: folderOf("Acme") },
      { name: "stat", path: folderOf("Acme") },
      { name: "writeFile", path: tempOf("Invoice-1001.pdf") },
      { name: "rename", path: tempOf("Invoice-1001.pdf") },
    ]);
    expect(await ls(share)).toEqual(["Customers", CUSTOMER_FOLDERS_MARKER].sort());
    expect(await ls(outside)).toEqual([]);
  });

  it("files a credit as Credit-<n>.pdf", async () => {
    const { office } = setUp();
    expect(await office.fileCustomerCopy(filing({ kind: "CREDIT", number: 77 }), PDF)).toEqual({ warning: null });
    expect(await ls(folderOf("Acme"))).toEqual(["Credit-77.pdf"]);
  });

  it("replaces the file at a reprint", async () => {
    const { office } = setUp();
    await office.fileCustomerCopy(filing(), PDF);
    expect(await office.fileCustomerCopy(filing(), PDF_2)).toEqual({ warning: null });
    expect(await ls(folderOf("Acme"))).toEqual(["Invoice-1001.pdf"]);
    expect(await fsp.readFile(path.join(folderOf("Acme"), "Invoice-1001.pdf"))).toEqual(PDF_2);
  });

  it("does nothing for a draft", async () => {
    const { office, deps, calls } = setUp();
    expect(await office.fileCustomerCopy(null, PDF)).toEqual({ warning: null });
    expect(deps.env).not.toHaveBeenCalled();
    expect(deps.isPractice).not.toHaveBeenCalled();
    expect(deps.log).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("does nothing, silently, when no share is set up, without asking whether this is the practice copy", async () => {
    const { office, deps, calls } = setUp({ env: () => ({}) });
    expect(await office.fileCustomerCopy(filing(), PDF)).toEqual({ warning: null });
    expect(deps.isPractice).not.toHaveBeenCalled();
    expect(deps.log).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("does nothing, silently, on the practice copy, with no fs call", async () => {
    const { office, deps, calls } = setUp({ isPractice: vi.fn(async () => true) });
    expect(await office.fileCustomerCopy(filing(), PDF)).toEqual({ warning: null });
    expect(deps.log).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("is silent on the practice copy even when the share's settings are misconfigured", async () => {
    const { office, deps, calls } = setUp({
      isPractice: vi.fn(async () => true),
      env: () => ({ OFFICE_SHARE_DIR: share }),
    });
    expect(await office.fileCustomerCopy(filing(), PDF)).toEqual({ warning: null });
    expect(deps.log).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("says the copy was refused, logged, when the practice check fails", async () => {
    const { office, deps, calls } = setUp({
      isPractice: vi.fn(async () => { throw new Error("the database is unreachable"); }),
    });
    expect(await office.fileCustomerCopy(filing(), PDF)).toEqual({ warning: PRINT_REFUSED });
    expectOneLog(deps.log, "Invoice-1001.pdf", "the database is unreachable");
    expect(calls).toEqual([]);
  });

  it("says the share is not connected, logged, when its settings are misconfigured", async () => {
    const { office, deps, calls } = setUp({ env: () => ({ OFFICE_SHARE_DIR: share, OFFICE_SHARE_ROOT: "Z:\\Customers" }) });
    expect(await office.fileCustomerCopy(filing(), PDF)).toEqual({ warning: PRINT_NOT_CONNECTED });
    expectOneLog(deps.log, "Invoice-1001.pdf", "misconfigured", "drive root");
    expect(calls).toEqual([]);
  });

  it("says no folder is set, unlogged and touching nothing, when the customer has none", async () => {
    const { office, deps, calls } = setUp();
    for (const folder of ["", "  ", '""']) {
      expect(await office.fileCustomerCopy(filing({ folder }), PDF)).toEqual({ warning: PRINT_NO_FOLDER });
    }
    expect(deps.log).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("says the folder was not found, logged and touching nothing, when the stored folder no longer parses", async () => {
    for (const [folder, reason] of [["Y:\\Customers\\Acme", "outside"], ["Z:\\", "share-itself"], ["Z:\\A|B", "bad-name"]]) {
      const { office, deps, calls } = setUp();
      expect(await office.fileCustomerCopy(filing({ folder }), PDF)).toEqual({ warning: PRINT_FOLDER_NOT_FOUND });
      expectOneLog(deps.log, "Invoice-1001.pdf", reason);
      expect(calls).toEqual([]);
    }
  });

  it("says the share is not connected, logged, when the marker file is missing", async () => {
    await fsp.rm(marker());
    const { office, deps, calls } = setUp();
    expect(await office.fileCustomerCopy(filing(), PDF)).toEqual({ warning: PRINT_NOT_CONNECTED });
    expectOneLog(deps.log, "Invoice-1001.pdf", "ENOENT");
    expect(calls).toEqual([{ name: "access", path: marker() }]);
  });

  it("says the share is not connected when the share's own folder cannot be resolved", async () => {
    const { office, deps, fail } = setUp();
    fail("realpath", "EIO", { on: share });
    expect(await office.fileCustomerCopy(filing(), PDF)).toEqual({ warning: PRINT_NOT_CONNECTED });
    expectOneLog(deps.log, "Invoice-1001.pdf", "EIO");
  });

  it("says the folder was not found, logged, and creates none, when it is missing", async () => {
    const { office, deps, names } = setUp();
    expect(await office.fileCustomerCopy(filing({ folder: "Z:\\Customers\\Gamma" }), PDF)).toEqual({ warning: PRINT_FOLDER_NOT_FOUND });
    expectOneLog(deps.log, "Invoice-1001.pdf", "ENOENT");
    expect(names()).toEqual(["access", "realpath", "realpath"]);
    await expect(fsp.stat(folderOf("Gamma"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("says the folder was not found for a path through a file and for a file where the folder should be", async () => {
    await fsp.writeFile(folderOf("notes.txt"), "a file");
    for (const folder of ["Z:\\Customers\\notes.txt\\Acme", "Z:\\Customers\\notes.txt"]) {
      const { office, deps } = setUp();
      expect(await office.fileCustomerCopy(filing({ folder }), PDF)).toEqual({ warning: PRINT_FOLDER_NOT_FOUND });
      expect(deps.log).toHaveBeenCalledTimes(1);
    }
    expect(await fsp.readFile(folderOf("notes.txt"), "utf8")).toBe("a file");
  });

  it("says the folder was not found for a link out of the share, writing nothing outside it", async () => {
    await fsp.symlink(outside, folderOf("Link"));
    const { office, deps, names } = setUp();
    expect(await office.fileCustomerCopy(filing({ folder: "Z:\\Customers\\Link" }), PDF)).toEqual({ warning: PRINT_FOLDER_NOT_FOUND });
    expectOneLog(deps.log, "Invoice-1001.pdf", "outside the share");
    expect(names()).toEqual(["access", "realpath", "realpath"]);
    expect(await ls(outside)).toEqual([]);
  });

  it("says the copy was refused for any other error resolving or reading the folder", async () => {
    for (const name of ["realpath", "stat"] as const) {
      const { office, deps, fail } = setUp();
      fail(name, "EACCES", { on: folderOf("Acme") });
      expect(await office.fileCustomerCopy(filing(), PDF)).toEqual({ warning: PRINT_REFUSED });
      expectOneLog(deps.log, "Invoice-1001.pdf", "EACCES");
    }
  });

  it("refuses a failed write, logged, and leaves no temp", async () => {
    const { office, deps, names, fail } = setUp();
    // The write lands, then fails: the temp is on disk when the failure is seen.
    fail("writeFile", "ENOSPC", { afterReal: true });
    expect(await office.fileCustomerCopy(filing(), PDF)).toEqual({ warning: PRINT_REFUSED });
    expectOneLog(deps.log, "Invoice-1001.pdf", "ENOSPC");
    expect(names()).toEqual(["access", "realpath", "realpath", "stat", "writeFile", "unlink"]);
    expect(await ls(folderOf("Acme"))).toEqual([]);
  });

  it("refuses a failed rename, logged, leaves no temp and keeps the file already filed", async () => {
    const { office, deps, fail } = setUp();
    await office.fileCustomerCopy(filing(), PDF);
    fail("rename", "EBUSY");
    expect(await office.fileCustomerCopy(filing(), PDF_2)).toEqual({ warning: PRINT_REFUSED });
    expectOneLog(deps.log, "Invoice-1001.pdf", "EBUSY");
    expect(await ls(folderOf("Acme"))).toEqual(["Invoice-1001.pdf"]);
    expect(await fsp.readFile(path.join(folderOf("Acme"), "Invoice-1001.pdf"))).toEqual(PDF);
  });

  it("never writes through something already at the temp path, and removes nothing it did not create", async () => {
    const target = path.join(outside, "target.txt");
    await fsp.writeFile(target, "outside bytes");
    await fsp.symlink(target, tempOf("Invoice-1001.pdf"));
    const { office, deps, names } = setUp();
    expect(await office.fileCustomerCopy(filing(), PDF)).toEqual({ warning: PRINT_REFUSED });
    expectOneLog(deps.log, "Invoice-1001.pdf", "EEXIST");
    expect(await fsp.readFile(target, "utf8")).toBe("outside bytes");
    // "wx" refused the write, so the chain created nothing at the temp path: the link stays.
    expect(names()).toEqual(["access", "realpath", "realpath", "stat", "writeFile"]);
    expect((await fsp.lstat(tempOf("Invoice-1001.pdf"))).isSymbolicLink()).toBe(true);
  });

  it("never rejects: a path builder's refusal is the refused line, logged, and writes nothing", async () => {
    const recording = setUp({ suffix: () => "not-hex" });
    const { office, deps, names } = recording;
    const copy = office.fileCustomerCopy(filing(), PDF);
    await idle(recording);
    expect(await now(copy)).toEqual({ warning: PRINT_REFUSED });
    expectOneLog(deps.log, "Invoice-1001.pdf", "suffix");
    expect(names()).toEqual(["access", "realpath", "realpath", "stat"]);
    expect(await ls(folderOf("Acme"))).toEqual([]);
  });

  it.each(UNREADABLE)("never rejects: %s, thrown in the copy's chain, is the refused line at once, logged", async (_label, thrown) => {
    const recording = setUp({ suffix: () => { throw thrown(); } });
    const { office, deps, names } = recording;
    const copy = office.fileCustomerCopy(filing(), PDF);
    await idle(recording);
    expect(await now(copy)).toEqual({ warning: PRINT_REFUSED });
    expectOneLog(deps.log, "Invoice-1001.pdf", "a thrown value that cannot be read");
    expect(names()).toEqual(["access", "realpath", "realpath", "stat"]);
  });

  it("files prints of one invoice in print order: an older print after a newer one is not filed", async () => {
    const { office, deps } = setUp();
    expect(await office.fileCustomerCopy(filing({ ticket: 2 }), PDF_2)).toEqual({ warning: null });
    expect(await office.fileCustomerCopy(filing({ ticket: 1 }), PDF)).toEqual({ warning: null });
    expectOneLog(deps.log, "Invoice-1001.pdf", "a newer print");
    expect(await fsp.readFile(path.join(folderOf("Acme"), "Invoice-1001.pdf"))).toEqual(PDF_2);
    expect(await ls(folderOf("Acme"))).toEqual(["Invoice-1001.pdf"]);
    // A newer one still lands.
    expect(await office.fileCustomerCopy(filing({ ticket: 3 }), PDF)).toEqual({ warning: null });
    expect(await fsp.readFile(path.join(folderOf("Acme"), "Invoice-1001.pdf"))).toEqual(PDF);
  });

  it("orders prints by kind and number, not by the folder they were filed in", async () => {
    const { office } = setUp();
    expect(await office.fileCustomerCopy(filing({ ticket: 2, folder: "Z:\\Customers\\Beta" }), PDF_2)).toEqual({ warning: null });
    expect(await office.fileCustomerCopy(filing({ ticket: 1, folder: "Z:\\Customers\\Acme" }), PDF)).toEqual({ warning: null });
    expect(await ls(folderOf("Acme"))).toEqual([]);
    expect(await ls(folderOf("Beta"))).toEqual(["Invoice-1001.pdf"]);
  });

  it("keeps an invoice's and a credit's print order apart when they share a number", async () => {
    const { office, deps } = setUp();
    await office.fileCustomerCopy(filing({ kind: "INVOICE", number: 5, ticket: 2 }), PDF_2);
    expect(await office.fileCustomerCopy(filing({ kind: "CREDIT", number: 5, ticket: 1 }), PDF)).toEqual({ warning: null });
    expect(await ls(folderOf("Acme"))).toEqual(["Credit-5.pdf", "Invoice-5.pdf"]);
    expect(deps.log).not.toHaveBeenCalled();
  });

  it("takes increasing tickets", () => {
    const first = nextFilingTicket();
    expect(nextFilingTicket()).toBe(first + 1);
  });
});

describe("the slot", () => {
  it("answers a held copy timed out at its deadline while the call is still held, logged", async () => {
    const { office, deps, hold, state } = setUp();
    const held = hold("writeFile");
    const copy = office.fileCustomerCopy(filing(), PDF);
    await held.reached;
    await vi.advanceTimersByTimeAsync(WAIT - 1);
    expect(await now(copy)).toBe(PENDING);
    await vi.advanceTimersByTimeAsync(1);
    expect(await now(copy)).toEqual({ warning: PRINT_TIMED_OUT });
    expectOneLog(deps.log, "Invoice-1001.pdf", `${WAIT} ms`);
    expect(state.inFlight).toBe(1);
    held.release();
  });

  it("answers a held check timed out at its deadline, logged", async () => {
    const { office, deps, hold } = setUp();
    const held = hold("access");
    const check = office.checkCustomerFolder("Z:\\Customers\\Acme");
    await held.reached;
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(await now(check)).toEqual({ ok: false, message: SAVE_TIMED_OUT });
    expectOneLog(deps.log, JSON.stringify("Z:\\Customers\\Acme"), `${WAIT} ms`);
    held.release();
  });

  it("answers a request that arrives while the holder is stuck busy at once, touching nothing", async () => {
    const { office, deps, hold, calls } = setUp();
    const held = hold("access");
    void office.fileCustomerCopy(filing(), PDF);
    await held.reached;
    await vi.advanceTimersByTimeAsync(WAIT);
    deps.log.mockClear();
    expect(await now(office.checkCustomerFolder("Z:\\Customers\\Beta"))).toEqual({ ok: false, message: SAVE_BUSY });
    expectOneLog(deps.log, JSON.stringify("Z:\\Customers\\Beta"), "busy");
    deps.log.mockClear();
    expect(await now(office.fileCustomerCopy(filing({ number: 1002 }), PDF))).toEqual({ warning: PRINT_SKIPPED });
    expectOneLog(deps.log, "Invoice-1002.pdf", "busy");
    expect(calls).toEqual([{ name: "access", path: marker() }]);
    held.release();
  });

  it("gives up every request queued before the holder stuck, and never runs one, even after the slot frees", async () => {
    const recording = setUp();
    const { office, deps, hold, calls } = recording;
    const held = hold("access");
    const first = office.fileCustomerCopy(filing(), PDF);
    await held.reached;
    // The waiters arrive half way through the holder's wait, so their own deadlines are still ahead
    // when the slot frees below: a waiter wrongly started then would get as far as the share.
    await vi.advanceTimersByTimeAsync(WAIT / 2);
    const check = office.checkCustomerFolder("Z:\\Customers\\Beta");
    const copy = office.fileCustomerCopy(filing({ number: 1002, folder: "Z:\\Customers\\Beta" }), PDF);
    expect(await now(check)).toBe(PENDING);
    expect(await now(copy)).toBe(PENDING);
    await vi.advanceTimersByTimeAsync(WAIT / 2);
    expect(await now(first)).toEqual({ warning: PRINT_TIMED_OUT });
    expect(await now(check)).toEqual({ ok: false, message: SAVE_BUSY });
    expect(await now(copy)).toEqual({ warning: PRINT_SKIPPED });
    expect(deps.log).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(WAIT / 10);
    held.release();
    await idle(recording);
    // The holder stopped at its deadline check; neither waiter ever reached the share.
    expect(calls).toEqual([{ name: "access", path: marker() }]);
    expect(deps.log).toHaveBeenCalledTimes(3);
    // The slot is free: the next copy lands.
    expect(await office.fileCustomerCopy(filing({ number: 1003 }), PDF)).toEqual({ warning: null });
    expect(await ls(folderOf("Acme"))).toEqual(["Invoice-1003.pdf"]);
    expect(await ls(folderOf("Beta"))).toEqual([]);
  });

  it("lets a stuck copy that settles late remove its temp and free the slot; the next copy lands", async () => {
    const recording = setUp();
    const { office, hold, names } = recording;
    const held = hold("writeFile");
    const first = office.fileCustomerCopy(filing(), PDF);
    await held.reached;
    expect(await ls(folderOf("Acme"))).toEqual([".Invoice-1001.pdf.00000000.tmp"]);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(await now(first)).toEqual({ warning: PRINT_TIMED_OUT });
    held.release();
    await idle(recording);
    // It stopped before the rename, at its deadline check, and removed the temp it wrote.
    expect(names()).toEqual(["access", "realpath", "realpath", "stat", "writeFile", "unlink"]);
    expect(await ls(folderOf("Acme"))).toEqual([]);
    expect(await office.fileCustomerCopy(filing(), PDF_2)).toEqual({ warning: null });
    expect(await ls(folderOf("Acme"))).toEqual(["Invoice-1001.pdf"]);
    expect(await fsp.readFile(path.join(folderOf("Acme"), "Invoice-1001.pdf"))).toEqual(PDF_2);
  });

  it("checks the deadline before each fs call: a call answered late is the chain's last", async () => {
    const steps: [string, () => [FsName, string], FsName[]][] = [
      ["the marker", () => ["access", marker()], []],
      ["the share", () => ["realpath", share], []],
      ["the folder", () => ["realpath", folderOf("Acme")], []],
      ["the folder's stat", () => ["stat", folderOf("Acme")], []],
      // A late write is followed only by the removal of its temp.
      ["the write", () => ["writeFile", tempOf("Invoice-1001.pdf")], ["unlink"]],
    ];
    for (const [, step, after] of steps) {
      const recording = setUp();
      const [name, on] = step();
      const held = recording.hold(name, on);
      const copy = recording.office.fileCustomerCopy(filing(), PDF);
      await held.reached;
      const before = recording.calls.length;
      await vi.advanceTimersByTimeAsync(WAIT);
      expect(await now(copy)).toEqual({ warning: PRINT_TIMED_OUT });
      held.release();
      await idle(recording);
      expect(recording.calls.slice(before).map((call) => call.name)).toEqual(after);
      expect(await ls(folderOf("Acme"))).toEqual([]);
    }
  });

  it("runs waiting requests in the order they arrived", async () => {
    const recording = setUp();
    const { office, hold, calls } = recording;
    const held = hold("access");
    const first = office.checkCustomerFolder("Z:\\Customers\\Acme");
    await held.reached;
    const second = office.checkCustomerFolder("Z:\\Customers\\Beta");
    const third = office.fileCustomerCopy(filing(), PDF);
    held.release();
    expect(await first).toEqual({ ok: true, value: "Z:\\Customers\\Acme" });
    expect(await second).toEqual({ ok: true, value: "Z:\\Customers\\Beta" });
    expect(await third).toEqual({ warning: null });
    expect(calls.filter((call) => call.name === "stat").map((call) => call.path))
      .toEqual([folderOf("Acme"), folderOf("Beta"), folderOf("Acme")]);
  });

  it("times a waiter out at its own arrival's deadline, however late it starts", async () => {
    const { office, hold } = setUp();
    const holder = hold("stat");
    const first = office.checkCustomerFolder("Z:\\Customers\\Acme");
    await holder.reached;
    await vi.advanceTimersByTimeAsync(1);
    const waiter = hold("access");
    const second = office.fileCustomerCopy(filing(), PDF);
    await vi.advanceTimersByTimeAsync(WAIT / 2);
    holder.release();
    expect(await first).toEqual({ ok: true, value: "Z:\\Customers\\Acme" });
    await waiter.reached;
    // It started half a wait after it arrived, so half a wait is all it has.
    await vi.advanceTimersByTimeAsync(WAIT / 2);
    expect(await now(second)).toEqual({ warning: PRINT_TIMED_OUT });
  });

  it("holds no process open: its deadline timer is unreferenced, and cleared when the chain settles", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      const { office, hold } = setUp();
      const held = hold("access");
      const check = office.checkCustomerFolder("Z:\\Customers\\Acme");
      await held.reached;
      expect(timers).toHaveBeenCalledTimes(1);
      expect(timers.mock.results[0].value.hasRef()).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
      held.release();
      expect(await check).toEqual({ ok: true, value: "Z:\\Customers\\Acme" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      timers.mockRestore();
    }
  });

  it("shares one slot between the check and the copy: a copy waits for a held check, then lands", async () => {
    const { office, hold, names } = setUp();
    const held = hold("access");
    const check = office.checkCustomerFolder("Z:\\Customers\\Acme");
    await held.reached;
    const copy = office.fileCustomerCopy(filing(), PDF);
    expect(await now(copy)).toBe(PENDING);
    expect(names()).toEqual(["access"]);
    held.release();
    expect(await check).toEqual({ ok: true, value: "Z:\\Customers\\Acme" });
    expect(await copy).toEqual({ warning: null });
    expect(names()).toEqual([
      "access", "realpath", "realpath", "stat",
      "access", "realpath", "realpath", "stat", "writeFile", "rename",
    ]);
  });

  it("shares one slot between the check and the copy: a stuck check makes a copy skip, and a stuck copy a check", async () => {
    {
      const { office, hold } = setUp();
      const held = hold("access");
      void office.checkCustomerFolder("Z:\\Customers\\Acme");
      await held.reached;
      await vi.advanceTimersByTimeAsync(WAIT);
      expect(await now(office.fileCustomerCopy(filing(), PDF))).toEqual({ warning: PRINT_SKIPPED });
      held.release();
    }
    {
      const { office, hold } = setUp();
      const held = hold("access");
      void office.fileCustomerCopy(filing(), PDF);
      await held.reached;
      await vi.advanceTimersByTimeAsync(WAIT);
      expect(await now(office.checkCustomerFolder("Z:\\Customers\\Acme"))).toEqual({ ok: false, message: SAVE_BUSY });
      held.release();
    }
  });

  it("answers a newcomer busy at once when the holder's deadline has passed by the clock, though its timer has not fired", async () => {
    let clock = 0;
    const { office, deps, hold, calls } = setUp({ now: () => clock });
    const held = hold("access");
    const first = office.checkCustomerFolder("Z:\\Customers\\Acme");
    await held.reached;
    // The clock reaches the holder's deadline and no timer runs, as on an event loop held up by a
    // render: the deadline's timer has not fired.
    clock = WAIT;
    expect(await now(office.fileCustomerCopy(filing(), PDF))).toEqual({ warning: PRINT_SKIPPED });
    expectOneLog(deps.log, "Invoice-1001.pdf", "busy");
    expect(await now(first)).toBe(PENDING);
    expect(calls).toEqual([{ name: "access", path: marker() }]);
    held.release();
  });

  it("keeps its deadlines on a monotonic clock: the wall clock moved on neither times a request out nor makes a newcomer busy", async () => {
    const { office, deps, hold } = setUp();
    const held = hold("access");
    const first = office.checkCustomerFolder("Z:\\Customers\\Acme");
    await held.reached;
    // A time sync moves the wall clock two waits on; performance.now() does not move.
    vi.setSystemTime(Date.now() + 2 * WAIT);
    const second = office.checkCustomerFolder("Z:\\Customers\\Beta");
    expect(await now(second)).toBe(PENDING);
    held.release();
    expect(await first).toEqual({ ok: true, value: "Z:\\Customers\\Acme" });
    expect(await second).toEqual({ ok: true, value: "Z:\\Customers\\Beta" });
    expect(deps.log).not.toHaveBeenCalled();
  });

  it("keeps the queue whole when the holder's deadline and its last call's answer land on one tick, deadline first", async () => {
    const recording = setUp();
    const { office, hold, calls } = recording;
    const held = hold("stat");
    const first = office.checkCustomerFolder("Z:\\Customers\\Acme");
    await held.reached;
    await vi.advanceTimersByTimeAsync(1);
    const waiter = office.checkCustomerFolder("Z:\\Customers\\Beta");
    // Registered after the holder's deadline timer, for the same instant: it runs second.
    setTimeout(held.release, WAIT - 1);
    await vi.advanceTimersByTimeAsync(WAIT - 1);
    expect(await now(first)).toEqual({ ok: false, message: SAVE_TIMED_OUT });
    expect(await now(waiter)).toEqual({ ok: false, message: SAVE_BUSY });
    await idle(recording);
    expect(calls.some((call) => call.path === folderOf("Beta"))).toBe(false);
    // The holder's late answer freed the slot.
    expect(await office.checkCustomerFolder("Z:\\Customers\\Beta")).toEqual({ ok: true, value: "Z:\\Customers\\Beta" });
  });

  it("keeps the queue whole when the holder settles exactly at its deadline, before the deadline fires", async () => {
    const { office, hold, deps } = setUp();
    const held = hold("stat");
    // Registered before the holder's deadline timer, for the same instant: it runs first.
    setTimeout(held.release, WAIT);
    const first = office.checkCustomerFolder("Z:\\Customers\\Acme");
    await held.reached;
    await vi.advanceTimersByTimeAsync(1);
    const waiter = office.checkCustomerFolder("Z:\\Customers\\Beta");
    await vi.advanceTimersByTimeAsync(WAIT - 1);
    expect(await now(first)).toEqual({ ok: true, value: "Z:\\Customers\\Acme" });
    // The waiter started when the holder let go, inside its own deadline, and finds its folder.
    expect(await waiter).toEqual({ ok: true, value: "Z:\\Customers\\Beta" });
    expect(deps.log).not.toHaveBeenCalled();
  });
});

// makeOfficeShare's chains never reject (the cases above), so the slot's two belts for a chain
// that does are reached only by handing the slot one.
describe("the slot's belts, for a chain that rejects", () => {
  const WORDS = { busy: "busy", timedOut: "timed out" };
  const ENDED = { sentence: null, cause: null };
  const TIMED_OUT = { sentence: "timed out", cause: `the share did not answer within ${WAIT} ms` };
  function deferred() {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  it("frees the slot at once when a chain rejects, and answers its caller timed out at its deadline", async () => {
    const take = makeSlot(WAIT, () => performance.now());
    const rejecting = deferred();
    const first = take(async () => { await rejecting.promise; return ENDED; }, WORDS);
    const started = vi.fn();
    const second = take(async () => { started(); return ENDED; }, WORDS);
    expect(await now(second)).toBe(PENDING);
    rejecting.reject(new Error("a chain that rejects"));
    expect(await now(second)).toEqual(ENDED);
    expect(started).toHaveBeenCalledTimes(1);
    expect(await now(first)).toBe(PENDING);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(await now(first)).toEqual(TIMED_OUT);
  });

  it("lets a rejected chain's deadline give up no request waiting on the one that took the slot after it", async () => {
    const take = makeSlot(WAIT, () => performance.now());
    const rejecting = deferred();
    const first = take(async () => { await rejecting.promise; return ENDED; }, WORDS);
    await vi.advanceTimersByTimeAsync(WAIT / 2);
    const holding = deferred();
    const second = take(async () => { await holding.promise; return ENDED; }, WORDS);
    rejecting.reject(new Error("a chain that rejects"));
    expect(await now(second)).toBe(PENDING);
    // Queued behind the second, which holds the slot inside its own deadline.
    const third = take(async () => ENDED, WORDS);
    expect(await now(third)).toBe(PENDING);
    // The first's deadline: its timer fires, its caller is answered, and the second's queue is not its to flush.
    await vi.advanceTimersByTimeAsync(WAIT / 2);
    expect(await now(first)).toEqual(TIMED_OUT);
    expect(await now(third)).toBe(PENDING);
    holding.resolve();
    expect(await second).toEqual(ENDED);
    expect(await third).toEqual(ENDED);
  });
});

describe("the public pair's belt", () => {
  it("answers a check not connected, logged, when something it calls throws where nothing was meant to", async () => {
    const { office, deps, calls } = setUp({ env: () => { throw new Error("the settings could not be read"); } });
    expect(await office.checkCustomerFolder("Z:\\Customers\\Acme")).toEqual({ ok: false, message: SAVE_NOT_CONNECTED });
    expectOneLog(deps.log, JSON.stringify("Z:\\Customers\\Acme"), "the settings could not be read");
    expect(calls).toEqual([]);
  });

  it("answers a copy refused, logged, when something it calls throws where nothing was meant to", async () => {
    const { office, deps, calls } = setUp({ env: () => { throw new Error("the settings could not be read"); } });
    expect(await office.fileCustomerCopy(filing(), PDF)).toEqual({ warning: PRINT_REFUSED });
    expectOneLog(deps.log, "Invoice-1001.pdf", "the settings could not be read");
    expect(calls).toEqual([]);
  });

  it("answers, and never rejects, when its log line throws: the check and the copy each give their side's sentence", async () => {
    const { office, deps } = setUp();
    deps.log.mockImplementation(() => { throw new Error("the log is closed"); });
    // Each would otherwise give its not-found sentence, which is logged.
    expect(await office.checkCustomerFolder("Z:\\Customers\\Gamma")).toEqual({ ok: false, message: SAVE_NOT_CONNECTED });
    expect(await office.fileCustomerCopy(filing({ folder: "Z:\\Customers\\Gamma" }), PDF)).toEqual({ warning: PRINT_REFUSED });
    expect(deps.log).toHaveBeenCalledTimes(4);
  });
});

describe("the module's own share", () => {
  it("is off in a test: the setup file clears both share variables, which a developer's .env may set", () => {
    expect(process.env.OFFICE_SHARE_DIR).toBeUndefined();
    expect(process.env.OFFICE_SHARE_ROOT).toBeUndefined();
  });

  it("clears both variables in the setup file even when they are set before it runs", async () => {
    process.env.OFFICE_SHARE_DIR = share;
    process.env.OFFICE_SHARE_ROOT = ROOT;
    try {
      vi.resetModules();
      // Evaluating the setup file again also wraps process.emitWarning a second time, around its
      // first wrapper: harmless, as each drops only the one pg deprecation and passes the rest on.
      await import("./helpers/setup");
      expect(process.env.OFFICE_SHARE_DIR).toBeUndefined();
      expect(process.env.OFFICE_SHARE_ROOT).toBeUndefined();
    } finally {
      delete process.env.OFFICE_SHARE_DIR;
      delete process.env.OFFICE_SHARE_ROOT;
    }
  });

  // The case above sets both before the setup file runs; this one has its `.env` load set them, so
  // the deletes are proven to follow `config()`.
  it("clears both variables in the setup file even when its .env load sets them", async () => {
    const config = vi.fn(() => {
      process.env.OFFICE_SHARE_DIR = "/x";
      process.env.OFFICE_SHARE_ROOT = "Z:\\";
    });
    vi.doMock("dotenv", () => ({ config }));
    try {
      vi.resetModules();
      await import("./helpers/setup");
      expect(config).toHaveBeenCalledTimes(1);
      expect(process.env.OFFICE_SHARE_DIR).toBeUndefined();
      expect(process.env.OFFICE_SHARE_ROOT).toBeUndefined();
    } finally {
      vi.doUnmock("dotenv");
      vi.resetModules();
      delete process.env.OFFICE_SHARE_DIR;
      delete process.env.OFFICE_SHARE_ROOT;
    }
  });

  // Two routes, the customer save and the invoice print, import the module, and a bundler may
  // evaluate it once for each. The share this file imported is set aside for the test and put back:
  // the first evaluation below is made over a recording fs, so a chain started through it can be
  // held, and over a practice answer that asks no database.
  it("is one share for the process: a second evaluation shares the first's slot and its ticket counter", async () => {
    const key = Symbol.for("heatsynq.officeShare");
    const registry = globalThis as unknown as Record<symbol, unknown>;
    const imported = registry[key];
    const recording = recordingFs();
    recordings.push(recording);
    process.env.OFFICE_SHARE_DIR = share;
    process.env.OFFICE_SHARE_ROOT = ROOT;
    delete registry[key];
    vi.doMock("node:fs/promises", () => recording.fs);
    vi.doMock("@/server/practice-mode", () => ({ practiceMode: async () => false }));
    try {
      vi.resetModules();
      const first = await import("@/server/customer-folders");
      vi.resetModules();
      const second = await import("@/server/customer-folders");
      // One counter: the tickets keep rising across the two.
      const ticket = first.nextFilingTicket();
      expect(second.nextFilingTicket()).toBe(ticket + 1);
      expect(first.nextFilingTicket()).toBe(ticket + 2);
      // One slot: a check through the second waits for a copy held through the first.
      const held = recording.hold("access");
      const copy = first.fileCustomerCopy(filing(), PDF);
      await held.reached;
      const check = second.checkCustomerFolder("Z:\\Customers\\Beta");
      expect(await now(check)).toBe(PENDING);
      expect(recording.names()).toEqual(["access"]);
      held.release();
      expect(await copy).toEqual({ warning: null });
      expect(await check).toEqual({ ok: true, value: "Z:\\Customers\\Beta" });
      expect(await ls(folderOf("Acme"))).toEqual(["Invoice-1001.pdf"]);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.doUnmock("@/server/practice-mode");
      vi.resetModules();
      if (imported === undefined) delete registry[key];
      else registry[key] = imported;
      delete process.env.OFFICE_SHARE_DIR;
      delete process.env.OFFICE_SHARE_ROOT;
    }
  });

  // The module's own share asks `practiceMode` whether this is the practice copy. erp_test is not
  // erp_practice, so the case below cannot see that wiring: here the first evaluation is made over
  // a practice answer of yes, with both settings set and a recording fs, as above.
  it("asks practiceMode: on the practice copy, with the share set up, the check refuses and the copy files nothing, with no fs call and no log line", async () => {
    const key = Symbol.for("heatsynq.officeShare");
    const registry = globalThis as unknown as Record<symbol, unknown>;
    const imported = registry[key];
    const recording = recordingFs();
    recordings.push(recording);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.OFFICE_SHARE_DIR = share;
    process.env.OFFICE_SHARE_ROOT = ROOT;
    delete registry[key];
    vi.doMock("node:fs/promises", () => recording.fs);
    vi.doMock("@/server/practice-mode", () => ({ practiceMode: async () => true }));
    try {
      vi.resetModules();
      const practice = await import("@/server/customer-folders");
      expect(await practice.checkCustomerFolder("Z:\\Customers\\Acme")).toEqual({ ok: false, message: SHARE_NOT_SET_UP });
      expect(await practice.fileCustomerCopy(filing(), PDF)).toEqual({ warning: null });
      expect(recording.calls).toEqual([]);
      expect(await ls(folderOf("Acme"))).toEqual([]);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.doUnmock("@/server/practice-mode");
      vi.resetModules();
      if (imported === undefined) delete registry[key];
      else registry[key] = imported;
      delete process.env.OFFICE_SHARE_DIR;
      delete process.env.OFFICE_SHARE_ROOT;
      errors.mockRestore();
    }
  });

  it("reads the process's settings at each call and files through node:fs", async () => {
    vi.useRealTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await checkCustomerFolder("Z:\\Customers\\Acme")).toEqual({ ok: false, message: SHARE_NOT_SET_UP });
      expect(await fileCustomerCopy(filing(), PDF)).toEqual({ warning: null });
      expect(await ls(folderOf("Acme"))).toEqual([]);
      process.env.OFFICE_SHARE_DIR = share;
      process.env.OFFICE_SHARE_ROOT = ROOT;
      expect(await checkCustomerFolder("Z:\\Customers\\Acme")).toEqual({ ok: true, value: "Z:\\Customers\\Acme" });
      expect(await fileCustomerCopy(filing(), PDF)).toEqual({ warning: null });
      expect(await ls(folderOf("Acme"))).toEqual(["Invoice-1001.pdf"]);
      expect(errors).not.toHaveBeenCalled();
      await fsp.rm(marker());
      expect(await fileCustomerCopy(filing({ number: 1002 }), PDF)).toEqual({ warning: PRINT_NOT_CONNECTED });
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls[0][0]).toMatch(/^\[customer-folders\] Invoice-1002\.pdf .*ENOENT/);
    } finally {
      delete process.env.OFFICE_SHARE_DIR;
      delete process.env.OFFICE_SHARE_ROOT;
      errors.mockRestore();
    }
  });
});
