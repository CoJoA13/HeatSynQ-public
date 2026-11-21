import { prisma } from "./db";
import { canDo } from "./permissions";

/**
 * The last-manager guard's two shared pieces, in a leaf `users.ts` and `roles.ts` both import
 * (neither imports the other; the `invoice-guards.ts` precedent). `users.ts` judges one user's
 * `active`/`roleId`/overrides against the holders; `roles.ts` judges a role's new permission set
 * against them (#648 part 1: dropping `action.manage_users` from the sole manager's role was the
 * one write path #250 left open). Both refuse pre-transaction with the one sentence below.
 */
export const LAST_MANAGER_REFUSAL = "At least one active user must retain the ability to manage users.";

/**
 * Active, non-deleted users whose effective permissions currently include action.manage_users.
 *
 * Explicit `select` (never the old `include: { role: {...}, overrides: true }`, which pulls
 * every scalar on User) — this runs on every `updateUser` call that changes `active` or `roleId`,
 * a routine admin action, and the old blanket include pulled up to SIGNATURE_MAX_BYTES of
 * signature bytes (plus passwordHash) per active user just to compute a permission check that
 * only ever reads id/active/roleId/role.permissions/overrides. Same fix as `listUsers`, for the
 * same reason — this is the sibling that fix was supposed to catch too.
 */
export async function activeManageUsersHolders() {
  const users = await prisma.user.findMany({
    where: { active: true, deletedAt: null },
    select: {
      id: true, active: true, roleId: true,
      role: { select: { permissions: { select: { permission: true } } } },
      overrides: { select: { permission: true, mode: true } },
    },
  });
  return users.filter((u) => canDo(u, "manage_users"));
}
