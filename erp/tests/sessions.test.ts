import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { setSetting } from "@/server/settings";
import { createSession, getSessionUser, destroySession } from "@/server/sessions";

async function makeUser(username = "jane") {
  return prisma.user.create({
    data: { username, passwordHash: "x", displayName: username },
  });
}

describe("sessions", () => {
  beforeEach(async () => await truncateAll());

  it("round-trips a session token to its user", async () => {
    const user = await makeUser();
    const { token } = (await createSession(user.id, "x"))!;
    const found = await getSessionUser(token);
    expect(found?.id).toBe(user.id);
  });

  it("stores only a hash of the token", async () => {
    const user = await makeUser();
    const { token } = (await createSession(user.id, "x"))!;
    const rows = await prisma.session.findMany();
    expect(rows[0].tokenHash).not.toBe(token);
  });

  it("rejects expired sessions", async () => {
    const user = await makeUser();
    const { token } = (await createSession(user.id, "x"))!;
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await getSessionUser(token)).toBeNull();
  });

  it("rejects disabled users", async () => {
    const user = await makeUser();
    const { token } = (await createSession(user.id, "x"))!;
    await prisma.user.update({ where: { id: user.id }, data: { active: false } });
    expect(await getSessionUser(token)).toBeNull();
  });

  it("destroySession invalidates the token", async () => {
    const user = await makeUser();
    const { token } = (await createSession(user.id, "x"))!;
    await destroySession(token);
    expect(await getSessionUser(token)).toBeNull();
  });

  // Ruling R6 (owner 2026-10-22, #609): the sliding expiry was an autocommit UPDATE on every
  // authenticated request, GETs included. It now slides only when the stored expiry has fallen
  // more than a tenth of the timeout (at most 60 s) behind a full slide, so a session can expire
  // up to that much early and no more. Mutation: delete the shortfall check and the first case reds.
  it("does not slide inside the window: a lookup a second after login writes nothing", async () => {
    const user = await makeUser();
    const { token, expiresAt: initialExpiresAt } = (await createSession(user.id, "x"))!;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await getSessionUser(token)).not.toBeNull();
    const row = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.expiresAt.getTime()).toBe(initialExpiresAt.getTime());
  });

  it("slides once past the window: an expiry more than the window behind is brought forward", async () => {
    const user = await makeUser();
    const { token, expiresAt: initialExpiresAt } = (await createSession(user.id, "x"))!;
    // The default timeout is 480 minutes, so the window is the 60 s cap: set the expiry 61 s short.
    const behind = new Date(initialExpiresAt.getTime() - 61_000);
    await prisma.session.updateMany({ where: { userId: user.id }, data: { expiresAt: behind } });
    expect(await getSessionUser(token)).not.toBeNull();
    const row = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(initialExpiresAt.getTime());
  });

  // Codex on #735: a stored expiry beyond the new deadline is a shortened timeout, written at once.
  // Mutation: drop the `shortfall >= 0` clause and this case reds (a negative shortfall is under
  // the window).
  it("a shortened timeout reaches a session signed in under the longer one on its next lookup", async () => {
    const user = await makeUser();
    const { token, expiresAt: longExpiry } = (await createSession(user.id, "x"))!;
    await setSetting("session_timeout_minutes", 5);
    const before = Date.now();
    expect(await getSessionUser(token)).not.toBeNull();
    const row = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.expiresAt.getTime()).toBeLessThan(longExpiry.getTime());
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 5 * 60_000 - 1000);
  });

  it("the window is a tenth of a short timeout: 5 minutes slides past 30 s behind, not before", async () => {
    await setSetting("session_timeout_minutes", 5);
    const user = await makeUser();
    const { token, expiresAt: initialExpiresAt } = (await createSession(user.id, "x"))!;
    await prisma.session.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(initialExpiresAt.getTime() - 20_000) } });
    expect(await getSessionUser(token)).not.toBeNull();
    expect((await prisma.session.findFirstOrThrow({ where: { userId: user.id } })).expiresAt.getTime()).toBe(initialExpiresAt.getTime() - 20_000);
    await prisma.session.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(initialExpiresAt.getTime() - 31_000) } });
    expect(await getSessionUser(token)).not.toBeNull();
    expect((await prisma.session.findFirstOrThrow({ where: { userId: user.id } })).expiresAt.getTime()).toBeGreaterThanOrEqual(initialExpiresAt.getTime());
  });

  // Ruling R27 (#718): expired sessions were deleted only at logout or by a password reset's
  // sweep, so an install kept every abandoned one for good. Sign-in now deletes the signing-in
  // user's sessions that expired more than 24 hours ago, inside the user-row fence, after the
  // eligibility read passes. Mutation: delete the sweep and the first case reds; move it ahead of
  // the eligibility check and the second does.
  it("sign-in deletes that user's sessions expired over a day ago, and nothing else", async () => {
    const user = await makeUser();
    const other = await makeUser("other");
    const day = 24 * 60 * 60_000;
    const at = (ms: number) => new Date(Date.now() + ms);
    await prisma.session.createMany({ data: [
      { tokenHash: "stale-1", userId: user.id, expiresAt: at(-day - 60_000) },
      { tokenHash: "stale-2", userId: user.id, expiresAt: at(-30 * day) },
      { tokenHash: "recent", userId: user.id, expiresAt: at(-day + 60_000) },
      { tokenHash: "live", userId: user.id, expiresAt: at(day) },
      { tokenHash: "other-stale", userId: other.id, expiresAt: at(-30 * day) },
    ] });

    expect(await createSession(user.id, "x")).not.toBeNull();

    const left = await prisma.session.findMany({ select: { tokenHash: true, userId: true } });
    const hashes = left.map((s) => s.tokenHash).sort();
    expect(hashes).toEqual(expect.arrayContaining(["live", "other-stale", "recent"]));
    expect(hashes).not.toContain("stale-1");
    expect(hashes).not.toContain("stale-2");
    expect(left.filter((s) => s.userId === user.id)).toHaveLength(3); // recent, live, the new one
  });

  it("a refused sign-in deletes nothing", async () => {
    const user = await makeUser();
    await prisma.session.create({
      data: { tokenHash: "stale", userId: user.id, expiresAt: new Date(Date.now() - 30 * 24 * 60 * 60_000) },
    });
    expect(await createSession(user.id, "not-the-stored-hash")).toBeNull();
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
  });

  it("rejects soft-deleted users", async () => {
    const user = await makeUser();
    const { token } = (await createSession(user.id, "x"))!;
    await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });
    expect(await getSessionUser(token)).toBeNull();
  });

  // #218 review P1 (MR !242): a login verifies the password, THEN inserts its session — so a
  // login racing the password reset could mint a session under the old credential after the
  // reset's session sweep already ran, and the sweep would never see it. createSession therefore
  // takes the hash the caller verified and re-reads the User row FOR SHARE in the same
  // transaction as the insert: FOR SHARE conflicts with the FOR NO KEY UPDATE claim every
  // auditedUpdate takes on its row, so the two serialize — either the login commits first and
  // the sweep deletes its session, or the reset commits first and the re-read sees the new hash.
  it("refuses to mint a session when the verified hash is no longer the stored one", async () => {
    const user = await makeUser();
    expect(await createSession(user.id, "not-the-stored-hash")).toBeNull();
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it("refuses to mint a session for an inactive or soft-deleted user, even under the current hash", async () => {
    // The fence's eligibility half (MR !242 round 2): deactivation leaves passwordHash
    // untouched, so a hash-only fence would mint a session for an account the admin just shut
    // off — inert while inactive (getSessionUser refuses), but RESURRECTED the moment the
    // active checkbox is re-ticked, without a new login.
    const inactive = await makeUser("switched-off");
    await prisma.user.update({ where: { id: inactive.id }, data: { active: false } });
    expect(await createSession(inactive.id, "x")).toBeNull();

    const deleted = await makeUser("soft-deleted");
    await prisma.user.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
    expect(await createSession(deleted.id, "x")).toBeNull();

    expect(await prisma.session.count()).toBe(0);
  });

  /**
   * updateUser's exact shape at the worst interleaving: the row claimed FOR NO KEY UPDATE
   * (auditedUpdate's before-snapshot claim), the credential-relevant column rewritten, the
   * session sweep ALREADY EXECUTED — and the transaction held open while a login that verified
   * the pre-change state tries to insert. An unfenced insert succeeds here (an FK insert takes
   * only KEY SHARE, which NO KEY UPDATE does not block) and the stale session survives the
   * sweep. The `swept` signal resolves only after deleteMany has EXECUTED with the lock held,
   * and the attempt starts only after awaiting it (round-2 review finding): a wall-clock sleep
   * cannot establish that ordering, and without it a slow transaction start lets the attempt
   * legitimately win the race and the test fail against a correct fence. After `swept`, the
   * outcome is deterministic wherever the attempt lands — blocked on the lock until commit, or
   * arriving after it — because both paths read the post-change row.
   */
  async function raceLoginAgainst(
    userId: string,
    change: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<unknown>,
  ) {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let sweptDone!: () => void;
    const swept = new Promise<void>((r) => { sweptDone = r; });
    const reset = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR NO KEY UPDATE`;
      await change(tx);
      await tx.session.deleteMany({ where: { userId } });
      sweptDone();
      await held;
    });
    await swept;
    const attempt = createSession(userId, "x");
    await new Promise((r) => setTimeout(r, 200)); // let the attempt genuinely block on the lock
    release();
    await reset;
    return attempt;
  }

  it("a login racing a password reset can never keep a session minted under the old hash", async () => {
    const user = await makeUser(); // stored hash "x"
    const attempt = await raceLoginAgainst(user.id, (tx) =>
      tx.user.update({ where: { id: user.id }, data: { passwordHash: "new-hash" } }));
    expect(attempt).toBeNull();
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it("a login racing a deactivation can never keep a session the reactivation would resurrect", async () => {
    const user = await makeUser("raced-off"); // stored hash "x", active
    const attempt = await raceLoginAgainst(user.id, (tx) =>
      tx.user.update({ where: { id: user.id }, data: { active: false } }));
    expect(attempt).toBeNull();
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });

  // #218 review P2 (MR !242): the session row can vanish between getSessionUser's lookup and
  // its sliding-expiry write (the password-reset sweep, a concurrent logout). A `update` there
  // throws P2025 out of handle() as a 500 for what is simply a logged-out session; the slide
  // must be updateMany with a zero-count answer of null. The gone-between-statements state is
  // simulated deterministically by stubbing the lookup to answer with a row that no longer
  // exists — plain property save/restore, never vi.spyOn on a Prisma delegate (CLAUDE.md).
  it("returns null, never a thrown 500, when the session row vanishes before the expiry slide", async () => {
    const user = await makeUser();
    const delegate = prisma.session as { findUnique: typeof prisma.session.findUnique };
    const original = delegate.findUnique;
    delegate.findUnique = (async () => ({
      id: "ghost-row-deleted-mid-request",
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: user.id, username: user.username, displayName: user.displayName,
        active: true, deletedAt: null, role: null, overrides: [],
      },
    })) as unknown as typeof prisma.session.findUnique;
    try {
      await expect(getSessionUser("any-token")).resolves.toBeNull();
    } finally {
      delegate.findUnique = original;
    }
  });

  // getSessionUser runs on every authenticated request (handle(), http.ts) — the hottest path
  // in the app for a User row read. Its `select` (sessions.ts) must never pull signatureImage:
  // unlike the audit snapshot's SNAPSHOT_SELECT (whose absence is provable straight from the
  // database), a session lookup has no equivalent redaction layer at all — an included bytes
  // column here would ride along on literally every route. Pins the property's absence on the
  // resolved user, not just the query shape, against a user that genuinely has a signature set.
  it("never pulls signatureImage into the resolved session user", async () => {
    const user = await makeUser("has-a-signature");
    await prisma.user.update({
      where: { id: user.id },
      data: { signatureImage: Buffer.from("fake-signature-bytes"), signatureMimeType: "image/png" },
    });
    const { token } = (await createSession(user.id, "x"))!;
    const found = await getSessionUser(token);
    expect(found).not.toBeNull();
    expect(found).not.toHaveProperty("signatureImage");
    expect(JSON.stringify(found)).not.toContain("fake-signature-bytes");
  });
});
