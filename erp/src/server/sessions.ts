import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./db";
import { sessionTimeoutMinutes } from "./settings";

/** The timeout, memoed for 30 s in settings.ts (ruling R6, #609). */
async function timeoutMinutes(): Promise<number> {
  return sessionTimeoutMinutes();
}

/** The slide window (ruling R6, #609): a tenth of the timeout, at most 60 s. A lookup writes the
 *  slide only when the stored expiry has fallen more than this behind a full slide, so a session
 *  can expire up to this much early and no more; every other lookup is read-only. */
export function slideWindowMs(timeoutMs: number): number {
  return Math.min(timeoutMs / 10, 60_000);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Mints a session — but only after proving, under a row lock, that `verifiedPasswordHash` is
 * STILL the stored credential (#218 review P1, MR !242). Login verifies the password and then
 * inserts; unfenced, a login racing a password reset could insert AFTER the reset's session
 * sweep ran and commit a session minted under the old credential that the sweep never saw (an
 * FK insert takes only KEY SHARE, which the reset's row claim does not block — reproduced by
 * the held-lock test in sessions.test.ts). The fence: re-read the User row `FOR SHARE` in the
 * same transaction as the insert. FOR SHARE conflicts with the FOR NO KEY UPDATE claim every
 * auditedUpdate takes on its row before the before-snapshot, so login and reset serialize —
 * whichever commits first, either the sweep sees this session and deletes it, or this re-read
 * sees the new hash and refuses. The locked read checks ELIGIBILITY too, not just the hash
 * (round-2 review finding): a deactivation leaves passwordHash untouched, so a hash-only fence
 * would mint a session for the account the admin just shut off — inert while inactive
 * (getSessionUser refuses), but resurrected the moment the active checkbox is re-ticked,
 * without a new login. Returns null on any of it (caller answers the generic 401): the
 * credential or account the login checked is already gone.
 */
/** R27: how long past its expiry a session is kept before a sign-in of its user deletes it. */
const EXPIRED_SESSION_GRACE_MS = 24 * 60 * 60_000;

export async function createSession(userId: string, verifiedPasswordHash: string) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + (await timeoutMinutes()) * 60_000);
  const inserted = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ passwordHash: string; active: boolean; deletedAt: Date | null }[]>`
      SELECT "passwordHash", "active", "deletedAt" FROM "User" WHERE "id" = ${userId} FOR SHARE`;
    const row = rows[0];
    if (!row || row.passwordHash !== verifiedPasswordHash || !row.active || row.deletedAt) return false;
    // Ruling R27 (#718): the one reaper of abandoned sessions. Only this user's, only those that
    // expired more than a day ago, and only once the fence has passed, so a refused sign-in
    // deletes nothing. Unaudited, as logout's delete is. Served by `Session_userId_idx`;
    // `expiresAt` stays unindexed because the slide rewrites it (R6).
    await tx.session.deleteMany({ where: { userId, expiresAt: { lt: new Date(Date.now() - EXPIRED_SESSION_GRACE_MS) } } });
    await tx.session.create({ data: { tokenHash: hashToken(token), userId, expiresAt } });
    return true;
  });
  return inserted ? { token, expiresAt } : null;
}

/**
 * Runs on every authenticated request (`handle`, http.ts, calls this for every request carrying
 * a session cookie) — the hottest path in the application for a User row read. Explicit `select`
 * on the nested `user`, not `include`: `include` pulls every scalar on User, including
 * `signatureImage` (up to SIGNATURE_MAX_BYTES, users.ts) now that it has a real writer, on every
 * single request. Lists exactly what a `SessionUser` is actually used for downstream:
 * id/username/displayName (http.ts's actor, /api/auth/me), lastSeenVersion (GET /api/updates
 * reads it for the What's new notice), active/deletedAt (the eligibility
 * check just below), and role.permissions/overrides (can()/canDo(), permissions.ts) — nothing
 * else reads a `SessionUser` field anywhere in the codebase (swept via grep before this change).
 */
export async function getSessionUser(token: string) {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      expiresAt: true,
      user: {
        select: {
          id: true, username: true, displayName: true, active: true, deletedAt: true, lastSeenVersion: true,
          role: { select: { permissions: { select: { permission: true } } } },
          overrides: { select: { permission: true, mode: true } },
        },
      },
    },
  });
  if (!session) return null;
  if (session.expiresAt < new Date()) return null;
  if (!session.user.active || session.user.deletedAt) return null;
  // Sliding expiry, throttled (ruling R6, #609): the slide was an autocommit UPDATE, a WAL record
  // and a dead tuple on every authenticated request, GETs included, and a tab's parallel reads
  // queued on the row's lock. It is written only when the stored expiry has fallen more than
  // `slideWindowMs` (a tenth of the timeout, at most 60 s) behind a full slide; inside the window
  // the lookup answers unwritten, so the stored expiry is at most that much short of a full slide.
  // The write stays `updateMany`, never `update` (#218 review P2, MR !242): this row can be deleted
  // between the lookup above and this write (the password-reset session sweep, a concurrent
  // logout), and `update` throws P2025 out of handle() as a 500 for what is simply a session
  // that no longer exists. Zero rows slid means logged out: answer null like every other
  // not-a-session path above.
  // A stored expiry BEYOND the new deadline is written at once, window or not (Codex on #735): an
  // administrator who shortens the timeout means it for the sessions already signed in, and the
  // throttle must not keep them authenticated for the old timeout's hours.
  const timeoutMs = (await timeoutMinutes()) * 60_000;
  const expiresAt = new Date(Date.now() + timeoutMs);
  const shortfall = expiresAt.getTime() - session.expiresAt.getTime();
  if (shortfall >= 0 && shortfall <= slideWindowMs(timeoutMs)) return session.user;
  const slid = await prisma.session.updateMany({ where: { id: session.id }, data: { expiresAt } });
  if (slid.count === 0) return null;
  return session.user;
}

export async function destroySession(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export type SessionUser = NonNullable<Awaited<ReturnType<typeof getSessionUser>>>;
