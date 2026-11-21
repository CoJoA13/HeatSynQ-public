import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { truncateAll, prisma } from "./helpers/db";
import { createUser } from "@/server/users";
import { runWithContext } from "@/server/context";
import { readAudit } from "@/server/audit";
import { changedFields } from "@/lib/audit-diff";
import { resolveUpdatesDir, statusFile, holdFile } from "@/server/update-paths";
import {
  markSeen, readUpdateStatus, reconcileHoldFile, setUpdateHold, whatsNewFor, writeHoldFile,
} from "@/server/updates";
import { parseUpdateHold, type UpdateStatus } from "@/lib/release-contracts";

const T = "2026-11-01T12:00:00Z";
const note = (version: string, databaseChanges = false) => ({ version, publishedAt: T, databaseChanges, body: `notes ${version}` });
function status(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    schemaVersion: 1, writtenAt: T, running: { version: "1.3.0", at: T },
    pending: { version: "1.4.0", publishedAt: T, firstSeenAt: T, databaseChanges: true, installAfter: T, state: "scheduled", reason: null },
    notes: [note("1.1.0"), note("1.2.0"), note("1.3.0")], ...over,
  };
}

let dir: string;
beforeEach(async () => {
  await truncateAll();
  dir = mkdtempSync(path.join(tmpdir(), "updates-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const putStatus = (s: unknown) => writeFileSync(statusFile(dir), JSON.stringify(s));
const hold = () => JSON.parse(readFileSync(holdFile(dir), "utf8"));

async function actor() {
  const u = await createUser({ username: "holder", displayName: "Hal Older", password: "Passw0rd!xx" });
  const full = await prisma.user.findFirstOrThrow({ where: { id: u.id } });
  return { u: full, as: <T,>(fn: () => Promise<T>) =>
    runWithContext({ actor: { id: full.id, name: full.username }, user: { id: full.id, username: full.username, displayName: full.displayName } as never }, fn) };
}

describe("update paths", () => {
  it("is null when unset or blank and refuses unsafe values", () => {
    expect(resolveUpdatesDir(undefined)).toBeNull();
    expect(resolveUpdatesDir("  ")).toBeNull();
    expect(resolveUpdatesDir("/updates")).toBe("/updates");
    expect(() => resolveUpdatesDir("/a/../b")).toThrow();
    expect(() => resolveUpdatesDir("/a;b")).toThrow();
  });
});

describe("readUpdateStatus", () => {
  it("is null for no dir, a missing file, garbage and a schema miss", async () => {
    expect(await readUpdateStatus(null)).toBeNull();
    expect(await readUpdateStatus(dir)).toBeNull();
    writeFileSync(statusFile(dir), "{nope");
    expect(await readUpdateStatus(dir)).toBeNull();
    putStatus({ schemaVersion: 1 });
    expect(await readUpdateStatus(dir)).toBeNull();
    rmSync(statusFile(dir));
    mkdirSync(statusFile(dir)); // unreadable: a directory
    expect(await readUpdateStatus(dir)).toBeNull();
  });
  it("reads a valid file", async () => {
    putStatus(status());
    expect((await readUpdateStatus(dir))?.running.version).toBe("1.3.0");
  });
});

describe("holding", () => {
  it("refuses with no folder, and with no pending flagged release", async () => {
    const { as } = await actor();
    await expect(as(() => setUpdateHold(true, null))).rejects.toMatchObject({ status: 409, message: "This install has no update folder." });
    putStatus(status({ pending: null }));
    await expect(as(() => setUpdateHold(true, dir))).rejects.toMatchObject({ status: 409, message: "There is no database update to hold." });
    putStatus(status({ pending: { ...status().pending!, databaseChanges: false } }));
    await expect(as(() => setUpdateHold(true, dir))).rejects.toMatchObject({ status: 409 });
    putStatus(status({ pending: { ...status().pending!, state: "manual", reason: "x" } }));
    await expect(as(() => setUpdateHold(true, dir))).rejects.toMatchObject({ status: 409 });
    expect(existsSync(holdFile(dir))).toBe(false);
  });

  it("holds, writes the file, audits held/heldById/heldAt, and is idempotent", async () => {
    const { as, u } = await actor();
    putStatus(status());
    const view = await as(() => setUpdateHold(true, dir));
    expect(view).toMatchObject({ held: true, fromVersion: "1.4.0", by: "Hal Older" });
    expect(hold()).toMatchObject({ schemaVersion: 1, held: true, fromVersion: "1.4.0", by: "Hal Older", at: view.at });
    expect(statSync(holdFile(dir)).mode & 0o777).toBe(0o644);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const row = await prisma.updateHold.findFirstOrThrow();
    expect(row.heldById).toBe(u.id);
    const rows = await readAudit("updateHold", "singleton");
    expect(rows).toHaveLength(1);
    const diff = changedFields(rows[0].before as never, rows[0].after as never);
    expect(diff).toEqual(expect.arrayContaining(["held", "heldById", "heldAt"]));
    // again: no new audit row, no rewrite
    const before = readFileSync(holdFile(dir), "utf8");
    expect(await as(() => setUpdateHold(true, dir))).toEqual(view);
    expect(await readAudit("updateHold", "singleton")).toHaveLength(1);
    expect(readFileSync(holdFile(dir), "utf8")).toBe(before);
  });

  it("hold set writes the file before commit", async () => {
    const { as } = await actor();
    putStatus(status());
    await expect(as(() => setUpdateHold(true, dir, { beforeCommit: async () => { throw new Error("commit failed"); } }))).rejects.toThrow("commit failed");
    expect((await prisma.updateHold.findFirstOrThrow()).held).toBe(false);
    expect(hold().held).toBe(true); // the file still says held: the agent waits
  });

  it("a hold whose file cannot be written changes nothing and answers 500", async () => {
    const { as } = await actor();
    putStatus(status());
    await expect(as(() => setUpdateHold(true, dir, { writeHold: async () => { throw new Error("disk"); } })))
      .rejects.toMatchObject({ status: 500, message: "The hold could not be written for the update agent; nothing changed." });
    expect((await prisma.updateHold.findFirstOrThrow()).held).toBe(false);
  });

  it("lift commits before the file", async () => {
    const { as } = await actor();
    putStatus(status());
    await as(() => setUpdateHold(true, dir));
    await expect(as(() => setUpdateHold(false, dir, { writeHold: async () => { throw new Error("disk"); } })))
      .rejects.toMatchObject({ status: 500, message: "Release hold was saved, but the update agent's copy could not be written; the update stays held until it is." });
    expect((await prisma.updateHold.findFirstOrThrow()).held).toBe(false);
    expect(hold().held).toBe(true);
    // a lift with nothing held in the database writes nothing (the status read's reconcile repairs the file)
    expect(await as(() => setUpdateHold(false, dir))).toMatchObject({ held: false });
    expect(hold().held).toBe(true);
    const all = await readAudit("updateHold", "singleton"); // newest first
    expect(changedFields(all[0].before as never, all[0].after as never)).toEqual(expect.arrayContaining(["held", "heldById", "heldAt"]));
    const n = all.length;
    await as(() => setUpdateHold(false, dir));
    expect(await readAudit("updateHold", "singleton")).toHaveLength(n);
  });

  it("status read repairs a stale hold file", async () => {
    const { as } = await actor();
    putStatus(status());
    const view = await as(() => setUpdateHold(true, dir));
    writeFileSync(holdFile(dir), "garbage");
    await reconcileHoldFile(dir);
    expect(hold()).toMatchObject({ held: true, fromVersion: "1.4.0", at: view.at });
    await writeHoldFile(dir, { held: false, fromVersion: null, by: null, at: null });
    await reconcileHoldFile(dir);
    expect(hold().held).toBe(true);
    // not held in the database, file says held: cleared; an absent file stays absent
    await as(() => setUpdateHold(false, dir));
    writeFileSync(holdFile(dir), JSON.stringify({ schemaVersion: 1, held: true, fromVersion: "1.4.0", by: "x", at: T }));
    await reconcileHoldFile(dir);
    expect(hold().held).toBe(false);
    rmSync(holdFile(dir));
    await reconcileHoldFile(dir);
    expect(existsSync(holdFile(dir))).toBe(false);
    await reconcileHoldFile(null);
  });

  it("rewrites a present-but-invalid hold.json when the database is not held, and writes nothing when absent", async () => {
    await reconcileHoldFile(dir);
    expect(existsSync(holdFile(dir))).toBe(false);
    writeFileSync(holdFile(dir), "garbage");
    await reconcileHoldFile(dir);
    expect(parseUpdateHold(hold())).toMatchObject({ held: false });
    writeFileSync(holdFile(dir), JSON.stringify({ schemaVersion: 1, held: true }));
    await reconcileHoldFile(dir);
    expect(parseUpdateHold(hold())).toMatchObject({ held: false });
  });

  it("reconcile never throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { as } = await actor();
    putStatus(status());
    await as(() => setUpdateHold(true, dir));
    writeFileSync(holdFile(dir), "garbage");
    await expect(reconcileHoldFile(dir, { writeHold: async () => { throw new Error("no"); } })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});

// "blocked": a statement on THIS database is waiting on a lock for the UpdateHold row while the
// competitor is still unsettled. "settled": the competitor finished without ever waiting (the
// claim is gone). Anything else is a failure.
async function blockedOrSettled(p: Promise<unknown>, like = "%UpdateHold%"): Promise<"blocked" | "settled"> {
  let done = false;
  void p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 600; i++) {
    if (done) return "settled";
    const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE ${like}`;
    if (Number(n) > 0 && !done) return "blocked";
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("the competitor neither settled nor blocked");
}


describe("the claim around every file write", () => {
  const gate = () => { let go!: () => void; const p = new Promise<void>((r) => { go = r; }); return { p, go }; };
  it("a lift's post-commit write parked while a hold commits ends held in the database and the file", async () => {
    const { as } = await actor();
    putStatus(status());
    await as(() => setUpdateHold(true, dir));
    const parked = gate(); const reached = gate();
    const lift = as(() => setUpdateHold(false, dir, { writeHold: async (d, v) => { reached.go(); await parked.p; await writeHoldFile(d, v); } }));
    await reached.p;
    const hold2 = as(() => setUpdateHold(true, dir));
    expect(await blockedOrSettled(hold2)).toBe("blocked");
    parked.go();
    await Promise.all([lift, hold2]);
    expect((await prisma.updateHold.findFirstOrThrow()).held).toBe(true);
    expect(hold().held).toBe(true);
  });

  it("a reconcile started while a hold sits before its commit ends with the file held", async () => {
    const { as } = await actor();
    putStatus(status());
    const parked = gate(); const reached = gate();
    const holding = as(() => setUpdateHold(true, dir, { beforeCommit: async () => { reached.go(); await parked.p; } }));
    await reached.p;
    const rec = reconcileHoldFile(dir);
    expect(await blockedOrSettled(rec)).toBe("blocked");
    parked.go();
    await Promise.all([holding, rec]);
    expect((await prisma.updateHold.findFirstOrThrow()).held).toBe(true);
    expect(hold().held).toBe(true);
  });
});

describe("the hold file", () => {
  it("parses with the contract in both forms, at mode 0644 under a strict umask, and refuses a bad body", async () => {
    const old = process.umask(0o077);
    try {
      await writeHoldFile(dir, { held: true, fromVersion: "1.4.0", by: "Hal", at: T });
      expect(statSync(holdFile(dir)).mode & 0o777).toBe(0o644);
    } finally { process.umask(old); }
    expect(parseUpdateHold(hold())).toMatchObject({ held: true, fromVersion: "1.4.0" });
    await writeHoldFile(dir, { held: false, fromVersion: null, by: null, at: null });
    expect(parseUpdateHold(hold())).toMatchObject({ held: false });
    await expect(writeHoldFile(dir, { held: true, fromVersion: "1.4.0", by: null, at: T })).rejects.toThrow("The hold file body does not match the contract.");
  });
  it("a hold with no actor is refused", async () => {
    putStatus(status());
    await expect(setUpdateHold(true, dir)).rejects.toMatchObject({ status: 401 });
  });
  it("reconcile does nothing on the practice database", async () => {
    vi.resetModules();
    vi.doMock("@/server/practice-mode", () => ({ practiceMode: async () => true }));
    try {
      const mod = await import("@/server/updates");
      const write = vi.fn();
      writeFileSync(holdFile(dir), JSON.stringify({ schemaVersion: 1, held: true, fromVersion: "1.4.0", by: "x", at: T }));
      await mod.reconcileHoldFile(dir, { writeHold: write });
      expect(write).not.toHaveBeenCalled();
    } finally { vi.doUnmock("@/server/practice-mode"); vi.resetModules(); }
  });
});

describe("whatsNewFor", () => {
  it("lastSeen two behind gives the two newer notes, newest first", () => {
    expect(whatsNewFor(status(), "1.1.0").map((n) => n.version)).toEqual(["1.3.0", "1.2.0"]);
  });
  it("equal gives none; null gives the running version's note alone; status null gives none", () => {
    expect(whatsNewFor(status(), "1.3.0")).toEqual([]);
    expect(whatsNewFor(status(), null).map((n) => n.version)).toEqual(["1.3.0"]);
    expect(whatsNewFor(null, "1.1.0")).toEqual([]);
  });
  it("never shows a note newer than the running version, and a newer lastSeen gives none", () => {
    const s = status({ notes: [note("1.4.0"), note("1.3.0")] });
    expect(whatsNewFor(s, "1.2.0").map((n) => n.version)).toEqual(["1.3.0"]);
    expect(whatsNewFor(s, "2.0.0")).toEqual([]);
  });
});

describe("markSeen concurrency", () => {
  it("an older Got it parked after its read cannot overwrite a newer one that commits meanwhile", async () => {
    const { u, as } = await actor();
    const gate = () => { let go!: () => void; const p = new Promise<void>((r) => { go = r; }); return { p, go }; };
    const parked = gate(); const reached = gate();
    const older = as(() => markSeen(u.id, "1.3.0", { afterRead: async () => { reached.go(); await parked.p; } }));
    await reached.p;
    const newer = as(() => markSeen(u.id, "1.4.0"));
    expect(await blockedOrSettled(newer, "%User%")).toBe("blocked");
    parked.go();
    await Promise.all([older, newer]);
    expect((await prisma.user.findFirstOrThrow({ where: { id: u.id } })).lastSeenVersion).toBe("1.4.0");
  });
});

describe("markSeen backwards", () => {
  it("writes nothing when the stored version is newer", async () => {
    const { u, as } = await actor();
    await as(() => markSeen(u.id, "1.4.0"));
    const n = (await readAudit("user", u.id)).length;
    await as(() => markSeen(u.id, "1.3.0"));
    expect((await prisma.user.findFirstOrThrow({ where: { id: u.id } })).lastSeenVersion).toBe("1.4.0");
    expect(await readAudit("user", u.id)).toHaveLength(n);
  });
});

describe("markSeen", () => {
  it("refuses a bad version, stores a good one with an audit row, and writes nothing twice", async () => {
    const { u, as } = await actor();
    await expect(markSeen(u.id, "banana")).rejects.toMatchObject({ status: 400 });
    const n = (await readAudit("user", u.id)).length;
    await as(() => markSeen(u.id, "1.3.0"));
    expect((await prisma.user.findFirstOrThrow({ where: { id: u.id } })).lastSeenVersion).toBe("1.3.0");
    const rows = await readAudit("user", u.id); // newest first
    expect(rows).toHaveLength(n + 1);
    expect(rows[0].action).toBe("update");
    expect(changedFields(rows[0].before as never, rows[0].after as never)).toContain("lastSeenVersion");
    await as(() => markSeen(u.id, "1.3.0"));
    expect(await readAudit("user", u.id)).toHaveLength(n + 1);
  });
});

describe("the practice database", () => {
  it("never consults the status reader and cannot hold", async () => {
    vi.resetModules();
    vi.doMock("@/server/practice-mode", () => ({ practiceMode: async () => true }));
    try {
      const mod = await import("@/server/updates");
      const read = vi.fn(async () => status());
      expect(await mod.currentUpdateStatus(dir, read)).toBeNull();
      expect(read).not.toHaveBeenCalled();
      await expect(mod.setUpdateHold(true, dir)).rejects.toMatchObject({ status: 409, message: "This install has no update folder." });
    } finally {
      vi.doUnmock("@/server/practice-mode");
      vi.resetModules();
    }
  });
});
