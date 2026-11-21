import assert from "node:assert/strict";

/** The role's current permissions, as the admin roles list reports them (sorted). */
export async function rolePermissions(page, ctx, roleId) {
  // Recover one expired keep-alive socket on a read; Playwright retries only ECONNRESET.
  const response = await page.request.get(`${ctx.baseURL}/api/admin/roles`, { maxRetries: 1 });
  assert.equal(response.status(), 200, "Read roles");
  const role = (await response.json()).find(item => item.id === roleId);
  assert.ok(role, `Role ${roleId} is listed`);
  return role.permissions;
}

/**
 * Sets a shared fixture role's permissions and proves it by reading the role back (#321). The PUT
 * replaces the whole set, so it is idempotent and may retry a reset socket. A restore that still
 * fails, or reads back different, fails the flow that changed the role rather than every later flow
 * that signs in as its user. Needs an admin session.
 */
export async function setRolePermissions(page, ctx, roleId, permissions) {
  const response = await ctx.apiMutate(page, `${ctx.baseURL}/api/admin/roles/${roleId}`, {
    method: "PUT", data: { permissions }, idempotent: true });
  assert.equal(response.status(), 200, `Set role ${roleId} permissions: ${await response.text()}`);
  assert.deepEqual(await rolePermissions(page, ctx, roleId), [...permissions].sort(), `Role ${roleId} reads back as set`);
}
