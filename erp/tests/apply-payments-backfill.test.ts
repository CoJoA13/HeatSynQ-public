import { beforeEach, describe, expect, it } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { canDo } from "@/server/permissions";

// Public installs have no historical receivables grant to backfill. New roles must
// explicitly grant the payment action; a user DENY remains authoritative.
beforeEach(truncateAll);
describe("public payment permission initialization", () => {
  it("does not implicitly grant payment application to a receivables creator", async () => {
    const role = await prisma.role.create({ data: { name: "Receivables", permissions: { create: [{ permission: "receivables.create" }] } }, include: { permissions: true } });
    expect(canDo({ role, overrides: [] }, "apply_payments")).toBe(false);
    expect(await prisma.rolePermission.count({ where: { permission: "action.apply_payments" } })).toBe(0);
  });
  it("honors an explicit role grant and gives a user DENY precedence", async () => {
    const role = await prisma.role.create({ data: { name: "Payments", permissions: { create: [{ permission: "action.apply_payments" }] } }, include: { permissions: true } });
    const user = await prisma.user.create({ data: { username: "payment-denied", displayName: "Payment denied", passwordHash: "fixture", roleId: role.id, overrides: { create: [{ permission: "action.apply_payments", mode: "DENY" }] } }, include: { overrides: true } });
    expect(canDo({ role, overrides: [] }, "apply_payments")).toBe(true);
    expect(canDo({ role, overrides: user.overrides }, "apply_payments")).toBe(false);
  });
  it("accepts a direct action override without widening the role", async () => {
    const role = await prisma.role.create({ data: { name: "Viewer" }, include: { permissions: true } });
    const user = await prisma.user.create({ data: { username: "payment-granted", displayName: "Payment granted", passwordHash: "fixture", roleId: role.id, overrides: { create: [{ permission: "action.apply_payments", mode: "GRANT" }] } }, include: { overrides: true } });
    expect(canDo({ role, overrides: user.overrides }, "apply_payments")).toBe(true);
    expect(await prisma.rolePermission.count({ where: { roleId: role.id } })).toBe(0);
  });
});
