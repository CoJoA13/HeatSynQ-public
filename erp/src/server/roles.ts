import { prisma } from "./db";
import { HttpError } from "./errors";
import { ALL_PERMISSIONS, canDo } from "./permissions";
import { activeManageUsersHolders, LAST_MANAGER_REFUSAL } from "./last-manager";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { withDbErrors } from "./db-errors";
import { ROLE_DELETE_REASON_REQUIRED } from "@/lib/role-delete-words";

export async function listRoles() {
  const roles = await prisma.role.findMany({
    where: { deletedAt: null },
    include: { permissions: true, _count: { select: { users: { where: { deletedAt: null } } } } },
    orderBy: { name: "asc" },
  });
  return roles.map((r) => ({
    id: r.id,
    name: r.name,
    permissions: r.permissions.map((p) => p.permission).sort(),
    userCount: r._count.users,
  }));
}

export async function createRole(name: string): Promise<{ id: string }> {
  // findFirst, NOT findUnique — Role.name is unique only among live rows, but the client still
  // types it unique, so findUnique compiles and returns the soft-deleted row instead.
  const existing = await prisma.role.findFirst({ where: { name, deletedAt: null }, select: { id: true } });
  if (existing) throw new HttpError(400, "A role with that name already exists");

  const role = await withDbErrors({ entity: "Role", conflictField: "name" }, () =>
    prisma.$transaction((tx) =>
      auditedCreate("role", { name }, () => tx.role.create({ data: { name } }), { tx })));
  return { id: role.id };
}

const MANAGE_USERS = "action.manage_users";

/**
 * The role side of the last-manager guard (#648 part 1; `users.ts`'s `assertLastManagerSurvives`
 * is the user side, and `last-manager.ts` holds what they share). Refuses a permission set that
 * drops `action.manage_users` from a role that holds it now when, judged on the post-write state,
 * no active user would manage users any more: the role's holders lose the role's grant, a GRANT
 * override keeps one, and every holder on another role is untouched. Pre-transaction, like the
 * user side, so a refusal writes nothing. The holders read is skipped when the set keeps the
 * action or the role lacks it now, as the user side skips it for a rename. Only a current holder
 * is protected: an install with no active manager is not refused (the both-grants-stripped case
 * #648 names stays unguarded), the user side's "sole holder" rule.
 */
async function assertLastManagerSurvivesRoleWrite(roleId: string, permissions: string[]) {
  if (permissions.includes(MANAGE_USERS)) return;
  const holdsNow = await prisma.rolePermission.findFirst({
    where: { roleId, permission: MANAGE_USERS }, select: { roleId: true },
  });
  if (!holdsNow) return;
  const holders = await activeManageUsersHolders();
  if (holders.length === 0) return;
  const nextRole = { permissions: permissions.map((permission) => ({ permission })) };
  const survivors = holders.filter((h) =>
    h.roleId !== roleId || canDo({ role: nextRole, overrides: h.overrides }, "manage_users"));
  if (survivors.length === 0) throw new HttpError(400, LAST_MANAGER_REFUSAL);
}

/**
 * ONE transaction, ONE auditedUpdate, applying whichever parts are present (#648 part 1; the
 * `writeUser` shape). The PUT route used to call `renameRole` then `setRolePermissions`, two
 * transactions and two audit entries, so a refused permission set left the rename committed.
 * Every refusal is pre-transaction: unknown keys, the last-manager guard, the duplicate name.
 */
export async function updateRole(
  roleId: string,
  input: { name?: string; permissions?: string[] },
): Promise<void> {
  const { name, permissions } = input;
  if (permissions) {
    const unknown = permissions.filter((p) => !ALL_PERMISSIONS.includes(p));
    if (unknown.length) throw new HttpError(400, `Unknown permissions: ${unknown.join(", ")}`);
    await assertLastManagerSurvivesRoleWrite(roleId, permissions);
  }
  if (name !== undefined) {
    const existing = await prisma.role.findFirst({
      where: { name, deletedAt: null, NOT: { id: roleId } },
      select: { id: true },
    });
    if (existing) throw new HttpError(400, "A role with that name already exists");
  }
  if (name === undefined && !permissions) return;
  await withDbErrors({ entity: "Role", conflictField: "name" }, () =>
    prisma.$transaction((tx) =>
      auditedUpdate("role", roleId, async () => {
        if (name !== undefined) await tx.role.update({ where: { id: roleId }, data: { name } });
        if (permissions) {
          await tx.rolePermission.deleteMany({ where: { roleId } });
          await tx.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId, permission })) });
        }
      }, { tx })));
}

export async function renameRole(roleId: string, name: string): Promise<void> {
  await updateRole(roleId, { name });
}

export async function setRolePermissions(roleId: string, permissions: string[]): Promise<void> {
  await updateRole(roleId, { permissions });
}

/**
 * `reason` is required, not optional — spec §9's "destructive-ish actions require a reason".
 * Role delete qualifies on two counts: it carries the role's permission grants away, and it
 * frees the role name for reuse by an unrelated future role. Enforced in the service rather
 * than only at the route so no future caller can bypass it, matching deleteCustomer.
 *
 * Requiring a reason on EVERY delete was considered and rejected (handoff §5.17): demanding a
 * justification for a carrier typed wrong four seconds earlier trains people to type "x".
 */
export async function deleteRole(roleId: string, reason: string): Promise<void> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, ROLE_DELETE_REASON_REQUIRED);
  const holders = await prisma.user.count({ where: { roleId, deletedAt: null } });
  if (holders > 0) throw new HttpError(400, "Role is assigned to users");
  await withDbErrors({ entity: "Role" }, () =>
    prisma.$transaction((tx) => auditedSoftDelete("role", roleId, why, tx)));
}
