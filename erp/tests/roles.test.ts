import { describe, it, expect, beforeEach } from "vitest";
import { LAST_MANAGER_REFUSAL } from "@/server/last-manager";
import { prisma, truncateAll } from "./helpers/db";
import { createRole, listRoles, setRolePermissions, deleteRole, renameRole, updateRole } from "@/server/roles";
import { createUser, setUserOverrides } from "@/server/users";
import { HttpError } from "@/server/http";
import { readAudit } from "@/server/audit";

describe("roles service", () => {
  beforeEach(async () => await truncateAll());

  it("creates, lists, and renames roles", async () => {
    const { id } = await createRole("Office");
    await renameRole(id, "Front Office");
    const roles = await listRoles();
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ name: "Front Office", permissions: [], userCount: 0 });
  });

  it("rejects duplicate names", async () => {
    await createRole("Office");
    await expect(createRole("Office")).rejects.toThrow(HttpError);
  });

  it("replaces the permission set and rejects unknown keys", async () => {
    const { id } = await createRole("Billing");
    await setRolePermissions(id, ["invoicing.view", "invoicing.edit"]);
    await setRolePermissions(id, ["invoicing.view"]);
    expect((await listRoles())[0].permissions).toEqual(["invoicing.view"]);
    await expect(setRolePermissions(id, ["nope.bogus"])).rejects.toThrow(HttpError);
  });

  it("refuses to delete a role users still hold, allows otherwise", async () => {
    const { id } = await createRole("Office");
    await prisma.user.create({ data: { username: "j", passwordHash: "x", displayName: "J", roleId: id } });
    await expect(deleteRole(id, "cleaning up unused roles")).rejects.toThrow("Role is assigned to users");
    await prisma.user.updateMany({ data: { roleId: null } });
    await deleteRole(id, "cleaning up unused roles");
    expect(await listRoles()).toHaveLength(0);
  });

  it("renameRole rejects a name already used by another non-deleted role", async () => {
    await createRole("Office");
    const { id: warehouseId } = await createRole("Warehouse");
    await expect(renameRole(warehouseId, "Office")).rejects.toThrow(HttpError);
    await expect(renameRole(warehouseId, "Office")).rejects.toThrow("A role with that name already exists");
    // renaming to its own current name is not a conflict
    await renameRole(warehouseId, "Warehouse");
    expect((await listRoles()).find((r) => r.id === warehouseId)?.name).toBe("Warehouse");
  });

  it("setRolePermissions produces an audit entry whose before/after permissions differ", async () => {
    const { id } = await createRole("Billing");
    await setRolePermissions(id, ["invoicing.view"]);
    const [entry] = await readAudit("role", id);
    const before = (entry.before as { permissions: { permission: string }[] }).permissions.map((p) => p.permission);
    const after = (entry.after as { permissions: { permission: string }[] }).permissions.map((p) => p.permission);
    expect(before).toEqual([]);
    expect(after).toEqual(["invoicing.view"]);
    expect(before).not.toEqual(after);
  });

  it("renameRole onto a soft-deleted role's name is allowed, not a 500", async () => {
    const { id: deadId } = await createRole("Old");
    await deleteRole(deadId, "merged into Live");
    const { id: liveId } = await createRole("Live");
    await expect(renameRole(liveId, "Old")).resolves.not.toThrow();
    expect((await listRoles()).find((r) => r.id === liveId)?.name).toBe("Old");
  });

  it("re-creating a deleted role name makes a NEW role with no inherited grants", async () => {
    const first = await createRole("Shipping");
    await setRolePermissions(first.id, ["customers.view"]);
    await deleteRole(first.id, "consolidating into Warehouse");

    const second = await createRole("Shipping");
    expect(second.id).not.toBe(first.id);

    const roles = await listRoles();
    const fresh = roles.find((r) => r.id === second.id);
    expect(fresh?.permissions).toEqual([]);

    expect((await readAudit("role", second.id)).map((e) => e.action)).toEqual(["create"]);
  });

  it("requires a reason to delete a role", async () => {
    const { id } = await createRole("Shipping");
    await expect(deleteRole(id, "")).rejects.toThrow(/reason is required/i);
    await expect(deleteRole(id, "   ")).rejects.toThrow(/reason is required/i);
  });

  it("stores the trimmed reason on the audit entry", async () => {
    const { id } = await createRole("Shipping");
    await deleteRole(id, "  duplicate of Office  ");
    const [entry] = await readAudit("role", id);
    expect(entry.action).toBe("delete");
    expect(entry.reason).toBe("duplicate of Office");
  });

  // #648 part 1: the last-manager guard reached only user writes (`writeUser`, #250); dropping
  // `action.manage_users` from the sole manager's ROLE committed unguarded, and every
  // /api/admin/users* route answered 403 afterwards. The refusal is pre-transaction, so the
  // role's grants are untouched. Mutation: delete `assertLastManagerSurvivesRoleWrite`'s call.
  describe("last-manager guard on role writes (#648)", () => {
    async function soleManagerRole() {
      const role = await createRole("Admin");
      await setRolePermissions(role.id, ["action.manage_users", "admin.edit"]);
      const mgr = await createUser({ username: "mgr", displayName: "Manager", password: "pw123456", roleId: role.id });
      return { role, mgr };
    }

    it("refuses to drop action.manage_users from the last active manager's role, writing nothing", async () => {
      const { role } = await soleManagerRole();
      await expect(setRolePermissions(role.id, ["admin.edit"])).rejects.toThrow(LAST_MANAGER_REFUSAL);
      expect((await listRoles())[0].permissions).toEqual(["action.manage_users", "admin.edit"]);
    });

    it("allows the drop while another active holder remains, through another role or a GRANT override", async () => {
      const { role } = await soleManagerRole();
      const other = await createRole("Owner");
      await setRolePermissions(other.id, ["action.manage_users"]);
      const second = await createUser({ username: "own", displayName: "Owner", password: "pw123456", roleId: other.id });
      await setRolePermissions(role.id, ["admin.edit"]);
      expect((await listRoles()).find((r) => r.id === role.id)?.permissions).toEqual(["admin.edit"]);

      // Put it back; take the second role's grant away; a GRANT override on the second user keeps
      // the door open and the drop lands again.
      await setRolePermissions(role.id, ["action.manage_users", "admin.edit"]);
      await setUserOverrides(second.id, [{ permission: "action.manage_users", mode: "GRANT" }]);
      await setRolePermissions(other.id, []);
      await setRolePermissions(role.id, ["admin.edit"]);
      expect((await listRoles()).find((r) => r.id === role.id)?.permissions).toEqual(["admin.edit"]);
    });

    it("a DENY override on the sole holder's own user is judged too: the role's grant is not what keeps the door open", async () => {
      // No active user manages after the write either way, but none does before it: the guard
      // protects a holder from being removed, as users.ts's does, and does not refuse an install
      // already locked out (the both-grants-stripped case stays unguarded, noted at the code).
      const { role, mgr } = await soleManagerRole();
      const second = await createRole("Spare");
      await setRolePermissions(second.id, ["action.manage_users"]);
      const spare = await createUser({ username: "sp", displayName: "Spare", password: "pw123456", roleId: second.id });
      await setUserOverrides(mgr.id, [{ permission: "action.manage_users", mode: "DENY" }]);
      // mgr no longer holds it; spare is the sole holder. Dropping it from mgr's role is harmless.
      await setRolePermissions(role.id, ["admin.edit"]);
      // Dropping it from spare's role is the lockout.
      await expect(setRolePermissions(second.id, [])).rejects.toThrow(LAST_MANAGER_REFUSAL);
      expect((await listRoles()).find((r) => r.id === second.id)?.permissions).toEqual(["action.manage_users"]);
      void spare;
    });

    it("a role that keeps the action, or never held it, is not judged", async () => {
      const { role } = await soleManagerRole();
      await setRolePermissions(role.id, ["action.manage_users"]);
      const other = await createRole("Office");
      await setRolePermissions(other.id, ["orders.view"]);
      await setRolePermissions(other.id, []);
      expect((await listRoles()).map((r) => r.permissions)).toEqual([["action.manage_users"], []]);
    });
  });

  // #648 part 1, the other half: the PUT's rename and permission replace were two transactions
  // and two audit entries, so a refused half left the other committed. `updateRole` applies both
  // under ONE auditedUpdate. Mutation: split the two writes into separate transactions and the
  // audit count reads 2.
  describe("updateRole (#648)", () => {
    it("applies a rename and a permission replace as one audited write", async () => {
      const { id } = await createRole("Billing");
      await updateRole(id, { name: "Accounts", permissions: ["invoicing.view"] });
      const entries = await readAudit("role", id);
      const updates = entries.filter((e) => e.action === "update");
      expect(updates).toHaveLength(1);
      const [entry] = updates;
      expect((entry.before as { name: string }).name).toBe("Billing");
      expect((entry.after as { name: string }).name).toBe("Accounts");
      expect((entry.after as { permissions: { permission: string }[] }).permissions.map((p) => p.permission)).toEqual(["invoicing.view"]);
    });

    it("writes neither half when the permissions are refused", async () => {
      const { id } = await createRole("Billing");
      await expect(updateRole(id, { name: "Accounts", permissions: ["nope.bogus"] })).rejects.toThrow(HttpError);
      expect((await listRoles())[0]).toMatchObject({ name: "Billing", permissions: [] });
    });

    it("writes neither half when the name is refused", async () => {
      await createRole("Office");
      const { id } = await createRole("Billing");
      await expect(updateRole(id, { name: "Office", permissions: ["invoicing.view"] })).rejects.toThrow("A role with that name already exists");
      expect((await listRoles()).find((r) => r.id === id)).toMatchObject({ name: "Billing", permissions: [] });
    });
  });
});
