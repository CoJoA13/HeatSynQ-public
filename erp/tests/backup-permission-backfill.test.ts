import { beforeEach, describe, expect, it } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { ALL_PERMISSIONS, canDo } from "@/server/permissions";

beforeEach(truncateAll);
describe("public backup permission initialization", () => {
  it("starts without roles or retired permission rows", async () => {
    expect(await prisma.role.count()).toBe(0);
    expect(await prisma.rolePermission.count()).toBe(0);
    expect(await prisma.userPermissionOverride.count()).toBe(0);
    expect(ALL_PERMISSIONS.filter(permission => permission.startsWith("ar."))).toEqual([]);
  });
  it("requires an explicit backup action instead of inferring it from administration access", async () => {
    const role = await prisma.role.create({ data: { name: "User manager", permissions: { create: [{ permission: "admin.view" }, { permission: "action.manage_users" }] } }, include: { permissions: true } });
    expect(canDo({ role, overrides: [] }, "manage_backups")).toBe(false);
    expect(await prisma.rolePermission.count({ where: { permission: "action.manage_backups" } })).toBe(0);
  });
  it("preserves explicit backup grants and user denial semantics", async () => {
    const role = await prisma.role.create({ data: { name: "Backup operator", permissions: { create: [{ permission: "action.manage_backups" }] } }, include: { permissions: true } });
    const user = await prisma.user.create({ data: { username: "backup-denied", displayName: "Backup denied", passwordHash: "fixture", roleId: role.id, overrides: { create: [{ permission: "action.manage_backups", mode: "DENY" }] } }, include: { overrides: true } });
    expect(canDo({ role, overrides: [] }, "manage_backups")).toBe(true);
    expect(canDo({ role, overrides: user.overrides }, "manage_backups")).toBe(false);
    expect(await prisma.rolePermission.count({ where: { roleId: role.id, permission: "action.manage_backups" } })).toBe(1);
  });
});
