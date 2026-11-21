import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";

// Task 3.1 covers only the schema: the UpdateHold singleton exists, the CHECK pins it to one row,
// truncateAll restores it (the SetupState precedent), and a user remembers its last-seen version.
describe("UpdateHold singleton (release-updates PR 3)", () => {
  beforeEach(truncateAll);

  it("has the by-construction singleton row after truncateAll, not held", async () => {
    const row = await prisma.updateHold.findFirst({ where: { id: "singleton" } });
    expect(row).not.toBeNull();
    expect(row?.held).toBe(false);
    expect(row?.fromVersion).toBeNull();
    expect(row?.heldById).toBeNull();
    expect(row?.heldAt).toBeNull();
  });

  it("keeps exactly one row across the truncate/re-seed", async () => {
    expect(await prisma.updateHold.count()).toBe(1);
  });

  it("rejects a second row with id !== 'singleton' (the UpdateHold_singleton_check CHECK)", async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "UpdateHold" ("id", "updatedAt") VALUES ('other', now())`,
    ).rejects.toThrow(/UpdateHold_singleton_check/);
    expect(await prisma.updateHold.count()).toBe(1);
  });

  it("stores a user's last-seen version, null by default", async () => {
    const u = await prisma.user.create({ data: { username: "lsv", passwordHash: "x", displayName: "L" } });
    expect(u.lastSeenVersion).toBeNull();
    const v = await prisma.user.update({ where: { id: u.id }, data: { lastSeenVersion: "1.5.0" } });
    expect(v.lastSeenVersion).toBe("1.5.0");
  });
});
