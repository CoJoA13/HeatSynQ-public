// Reading the update folder and holding (release-updates PR 3). The host's update agent writes
// status.json; the app reads it, and writes hold.json when an administrator holds a
// database-changing release. The database row (UpdateHold) is the authority; hold.json is its copy
// for the agent.
//
// ORDER IS THE SAFETY PROPERTY. A hold writes the file INSIDE the transaction, after the update and
// before commit, so a commit failure leaves the file saying held (the agent then waits, the safe
// side). A lift commits FIRST and then writes the file in a second short transaction that claims
// the UpdateHold row (FOR UPDATE), re-reads the view on it and writes what the database now says,
// so a hold that commits in between is never overwritten. reconcileHoldFile does the same: its
// whole read-compare-write runs under that claim. File writes are therefore made while holding
// the row, within the transaction's time budget (a write stalled past it lands after the claim is
// gone). reconcileHoldFile runs only on an administrator's status read, so a hold.json lost outside
// the app stays missing until then.
import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "./db";
import { withDbErrors } from "./db-errors";
import { auditedUpdate } from "./audit";
import { currentUser } from "./context";
import { HttpError } from "./errors";
import { practiceMode } from "./practice-mode";
import { holdFile, statusFile } from "./update-paths";
import {
  parseUpdateHold, parseUpdateStatus, type UpdateStatus,
} from "@/lib/release-contracts";
import { compareVersions, parseVersion } from "@/lib/release-version";

type Db = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
export type Note = UpdateStatus["notes"][number];
export type UpdateHoldView = { held: boolean; fromVersion: string | null; by: string | null; at: string | null };

const NO_FOLDER = "This install has no update folder.";
const NO_UPDATE = "There is no database update to hold.";
const HOLD_WRITE_FAILED = "The hold could not be written for the update agent; nothing changed.";
const LIFT_WRITE_FAILED = "Release hold was saved, but the update agent's copy could not be written; the update stays held until it is.";

/** The status file, or null for no folder, or a file that is missing, unreadable or unparsable. */
export async function readUpdateStatus(dir: string | null): Promise<UpdateStatus | null> {
  if (!dir) return null;
  try {
    return parseUpdateStatus(JSON.parse(await readFile(/*turbopackIgnore: true*/ statusFile(dir), "utf8")));
  } catch {
    return null;
  }
}

/** The status the screens show: the practice database never reads the folder. */
export async function currentUpdateStatus(
  dir: string | null, read: (dir: string | null) => Promise<UpdateStatus | null> = readUpdateStatus,
): Promise<UpdateStatus | null> {
  if (await practiceMode()) return null;
  return read(dir);
}

const NOT_HELD: UpdateHoldView = { held: false, fromVersion: null, by: null, at: null };

type HoldRow = {
  held: boolean; fromVersion: string | null; heldAt: Date | null;
  heldBy: { displayName: string | null; username: string } | null;
};

const viewOf = (row: HoldRow | null): UpdateHoldView =>
  row && row.held
    ? {
        held: true, fromVersion: row.fromVersion,
        by: row.heldBy ? row.heldBy.displayName || row.heldBy.username : null,
        at: row.heldAt ? row.heldAt.toISOString() : null,
      }
    : NOT_HELD;

const HOLD_SELECT = { held: true, fromVersion: true, heldAt: true, heldBy: { select: { displayName: true, username: true } } } as const;

export async function getUpdateHold(db: Db | typeof prisma = prisma): Promise<UpdateHoldView> {
  return viewOf(await db.updateHold.findFirst({ where: { id: "singleton" }, select: HOLD_SELECT }));
}

// The /*turbopackIgnore: true*/ comments on the fs calls below are load-bearing (#334). The update
// folder is a runtime value, so Next's file tracer cannot tell what these calls might touch and, without
// the opt-out, globs a matching file (the checkout's backups/backup-status.json) into
// `.next/standalone`. `scripts/check-standalone-trace.mjs` fails the `ci` check if that comes back.

/** hold.json: a temp file in the same folder, then a rename, so the agent never reads half a file. */
export async function writeHoldFile(dir: string, view: UpdateHoldView): Promise<void> {
  const body = view.held
    ? { schemaVersion: 1, held: true, fromVersion: view.fromVersion, by: view.by, at: view.at }
    : { schemaVersion: 1, held: false, fromVersion: null, by: null, at: null };
  if (!parseUpdateHold(body)) throw new Error("The hold file body does not match the contract.");
  const target = holdFile(dir);
  const temp = path.join(dir, `.hold.json.${randomUUID()}.tmp`);
  try {
    await writeFile(/*turbopackIgnore: true*/ temp, JSON.stringify(body, null, 2) + "\n", { mode: 0o644 });
    await chmod(/*turbopackIgnore: true*/ temp, 0o644); // the umask masks writeFile's mode
    await rename(/*turbopackIgnore: true*/ temp, /*turbopackIgnore: true*/ target);
  } catch (err) {
    await rm(/*turbopackIgnore: true*/ temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Injection points for the ordering tests; production passes none. */
export type HoldDeps = {
  writeHold?: (dir: string, view: UpdateHoldView) => Promise<void>;
  /** Runs inside the transaction after a hold's file write, before commit. */
  beforeCommit?: () => Promise<void>;
};

export async function setUpdateHold(held: boolean, dir: string | null, deps: HoldDeps = {}): Promise<UpdateHoldView> {
  if (!dir || (await practiceMode())) throw new HttpError(409, NO_FOLDER);
  const write = deps.writeHold ?? writeHoldFile;
  const status = held ? await readUpdateStatus(dir) : null;
  const pending = status?.pending ?? null;
  const user = currentUser();
  if (held && !user) throw new HttpError(401, "Sign in to hold an update.");

  const outcome = await withDbErrors({ entity: "UpdateHold" }, () =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "UpdateHold" WHERE "id" = 'singleton' FOR UPDATE`;
      const current = await getUpdateHold(tx);
      if (current.held === held) return { view: current, changed: false };
      if (held && !(pending && pending.databaseChanges && pending.state !== "manual")) {
        throw new HttpError(409, NO_UPDATE);
      }
      const now = new Date();
      await auditedUpdate("updateHold", "singleton", () =>
        tx.updateHold.update({
          where: { id: "singleton" },
          data: held
            ? { held: true, fromVersion: pending!.version, heldById: user!.id, heldAt: now }
            : { held: false, fromVersion: null, heldById: null, heldAt: null },
          select: { id: true },
        }),
      { tx });
      const view: UpdateHoldView = held
        ? { held: true, fromVersion: pending!.version, by: user!.displayName || user!.username, at: now.toISOString() }
        : NOT_HELD;
      if (held) {
        try {
          await write(dir, view);
        } catch {
          throw new HttpError(500, HOLD_WRITE_FAILED);
        }
        await deps.beforeCommit?.();
      }
      return { view, changed: true };
    }));

  if (outcome.changed && !held) {
    // A second short transaction: claim, re-read on tx, write what the database now says.
    try {
      return await prisma.$transaction(async (tx) => {
        await claimHold(tx);
        const now = await getUpdateHold(tx);
        await write(dir, now);
        return now;
      });
    } catch {
      throw new HttpError(500, LIFT_WRITE_FAILED);
    }
  }
  return outcome.view;
}

const claimHold = (tx: Db) => tx.$queryRaw`SELECT "id" FROM "UpdateHold" WHERE "id" = 'singleton' FOR UPDATE`;

/** Rewrites hold.json when it disagrees with the database, under the UpdateHold claim. Runs on a
 *  read, so it never throws. */
export async function reconcileHoldFile(dir: string | null, deps: HoldDeps = {}): Promise<void> {
  if (!dir) return;
  try {
    if (await practiceMode()) return;
    await prisma.$transaction(async (tx) => {
      await claimHold(tx);
      const view = await getUpdateHold(tx);
      // Three file states. Absent: written only when the database is held. Present but invalid (not
      // JSON, or fails the contract): always rewritten, since the agent treats it as held. Valid:
      // written only on disagreement.
      let state: "absent" | "invalid" | "agrees" | "disagrees" = "absent";
      try {
        const raw = await readFile(/*turbopackIgnore: true*/ holdFile(dir), "utf8");
        let parsed: ReturnType<typeof parseUpdateHold> = null;
        try { parsed = parseUpdateHold(JSON.parse(raw)); } catch { /* not JSON */ }
        if (!parsed) state = "invalid";
        else {
          const matches = parsed.held
            ? view.held && parsed.fromVersion === view.fromVersion && parsed.by === view.by && parsed.at === view.at
            : !view.held;
          state = matches ? "agrees" : "disagrees";
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") state = "invalid";
      }
      const write = state === "invalid" || state === "disagrees" || (state === "absent" && view.held);
      if (write) await (deps.writeHold ?? writeHoldFile)(dir, view);
    });
  } catch (err) {
    console.error(`[updates] hold file not reconciled: ${err instanceof Error ? err.message : "unknown error"}`);
  }
}

/** The notes a person has not seen: newer than lastSeen, no newer than the running version. */
export function whatsNewFor(status: UpdateStatus | null, lastSeen: string | null): Note[] {
  if (!status) return [];
  const running = status.running.version;
  if (lastSeen !== null && parseVersion(lastSeen) && compareVersions(lastSeen, running) > 0) return [];
  const notes = status.notes
    .filter((n) => parseVersion(n.version) && compareVersions(n.version, running) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  if (lastSeen === null || !parseVersion(lastSeen)) return notes.filter((n) => n.version === running);
  return notes.filter((n) => compareVersions(n.version, lastSeen) > 0);
}

export async function markSeen(userId: string, version: string, deps: { afterRead?: () => Promise<void> } = {}): Promise<void> {
  if (!parseVersion(version)) throw new HttpError(400, "That is not a release version.");
  await withDbErrors({ entity: "User" }, () =>
    prisma.$transaction(async (tx) => {
      // Claim the row first: two Got it requests (an older tab and a newer one) must compare against
      // the committed value, not the one both read before either wrote.
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      const row = await tx.user.findFirst({ where: { id: userId }, select: { lastSeenVersion: true } });
      await deps.afterRead?.();
      if (!row) throw new HttpError(404, "User not found");
      if (row.lastSeenVersion === version) return;
      // Never move backwards: a stale tab's older Got it must not lower the stored version.
      if (row.lastSeenVersion && parseVersion(row.lastSeenVersion) && compareVersions(row.lastSeenVersion, version) > 0) return;
      await auditedUpdate("user", userId, () =>
        tx.user.update({ where: { id: userId }, data: { lastSeenVersion: version }, select: { id: true } }),
      { tx });
    }));
}

