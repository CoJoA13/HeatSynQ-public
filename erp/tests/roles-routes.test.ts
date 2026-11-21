import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { DELETE as del, PUT as put } from "@/app/api/admin/roles/[id]/route";
import { POST as post } from "@/app/api/admin/roles/route";
import { createRole, listRoles } from "@/server/roles";
import { readAudit } from "@/server/audit";

// #8 — the route half of "destructive-ish actions require a reason" (spec §9). The SERVICE half has
// required a reason since 2026-08-01 (`roles.ts:54-70`, commit 47d6d0a) and is pinned by
// `tests/roles.test.ts`; what was never pinned is the ROUTE's body read, which hand-rolled
// `(await req.json().catch(() => ({}))) as { reason?: unknown }` and therefore threw a raw
// TypeError off `body.reason` for a JSON body of literal `null` — escaping handle()'s error mapping
// as a 500 instead of the service's own field-anchored 400. Identical shape and identical fix to
// /api/customers/[id] (customer-routes.test.ts:58-77) and /api/parts/[id]: `reasonFromBody`.

const withId = (id: string) => ({ params: Promise.resolve({ id }) });

describe("admin role routes", () => {
  beforeEach(truncateAll);

  it("DELETE with a JSON null body is 400, not 500; a valid reason still deletes", async () => {
    const cookie = await signInWith(["admin.view", "action.manage_users"], "role-del-null");
    const { id } = await createRole("Doomed");

    const nullBody = await del(new Request(`http://t/api/admin/roles/${id}`, {
      method: "DELETE", headers: { cookie, "content-type": "application/json" }, body: "null",
    }), withId(id));
    expect(nullBody.status).toBe(400);
    expect((await nullBody.json()).error).toMatch(/reason/i);

    const ok = await del(new Request(`http://t/api/admin/roles/${id}`, {
      method: "DELETE", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ reason: "merged into Shop Floor" }),
    }), withId(id));
    expect(ok.status).toBe(200);

    expect((await listRoles()).map((r) => r.name)).not.toContain("Doomed");
    // The reason reaches the audit entry — the whole point of collecting it (§9's "who, when, why").
    const entry = await prisma.auditLog.findFirst({ where: { entity: "role", entityId: id, action: "delete" } });
    expect(entry!.reason).toBe("merged into Shop Floor");
  });

  // The `catch(() => null)` in `reasonFromBody`'s caller must keep answering the service's 400 for a
  // body-less DELETE rather than failing on the JSON parse — pinned so the swap to `reasonFromBody`
  // (which takes `null`, not `{}`, as its no-body sentinel) cannot silently regress it.
  it("DELETE with no body at all is the service's missing-reason 400", async () => {
    const cookie = await signInWith(["admin.view", "action.manage_users"], "role-del-nobody");
    const { id } = await createRole("Doomed");

    const res = await del(new Request(`http://t/api/admin/roles/${id}`, {
      method: "DELETE", headers: { cookie },
    }), withId(id));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/reason/i);
    expect((await listRoles()).map((r) => r.name)).toContain("Doomed");
  });

  it("DELETE with a whitespace-only reason is refused — the service trims", async () => {
    const cookie = await signInWith(["admin.view", "action.manage_users"], "role-del-blank");
    const { id } = await createRole("Doomed");

    const res = await del(new Request(`http://t/api/admin/roles/${id}`, {
      method: "DELETE", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ reason: "   " }),
    }), withId(id));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/reason/i);
    expect((await listRoles()).map((r) => r.name)).toContain("Doomed");
  });

  it("401s without a session and 403s a caller without manage_users", async () => {
    const { id } = await createRole("Doomed");
    expect((await del(new Request(`http://t/api/admin/roles/${id}`, { method: "DELETE" }), withId(id))).status).toBe(401);

    const viewOnly = await signInWith(["admin.view"], "role-del-403");
    const res = await del(new Request(`http://t/api/admin/roles/${id}`, {
      method: "DELETE", headers: { cookie: viewOnly, "content-type": "application/json" },
      body: JSON.stringify({ reason: "not allowed" }),
    }), withId(id));
    expect(res.status).toBe(403);
    expect((await listRoles()).map((r) => r.name)).toContain("Doomed");
  });

  // #648 part 1: the PUT carried its rename and its permission replace to two service calls, two
  // transactions; a refused second half left the rename committed. Now one call, one write.
  it("PUT with a name and permissions is one audited write, and a refused half writes nothing", async () => {
    const cookie = await signInWith(["admin.view", "action.manage_users"], "role-put-1");
    const { id } = await createRole("Billing");

    const refused = await put(new Request(`http://t/api/admin/roles/${id}`, {
      method: "PUT", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Accounts", permissions: ["nope.bogus"] }),
    }), withId(id));
    expect(refused.status).toBe(400);
    expect((await listRoles())[0]).toMatchObject({ name: "Billing", permissions: [] });

    const ok = await put(new Request(`http://t/api/admin/roles/${id}`, {
      method: "PUT", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Accounts", permissions: ["invoicing.view"] }),
    }), withId(id));
    expect(ok.status).toBe(200);
    expect((await listRoles())[0]).toMatchObject({ name: "Accounts", permissions: ["invoicing.view"] });
    expect((await readAudit("role", id)).filter((e) => e.action === "update")).toHaveLength(1);
  });

  // Ruling R8 (#648 part 2, #718): creating, editing and deleting a role is managing users, so the
  // three role mutations take action.manage_users ALONE, as the users routes do, in place of
  // admin.edit and admin.delete (owner, 2026-11-03). Reading the list stays on admin.view.
  // Mutation: put any route back on its admin gate and its half of the first case reds.
  it("POST, PUT and DELETE 403 an admin.edit and admin.delete holder without manage_users", async () => {
    const cookie = await signInWith(["admin.view", "admin.edit", "admin.delete"], "role-r8-403");
    const { id } = await createRole("Billing");
    const json = { cookie, "content-type": "application/json" };

    const created = await post(new Request("http://t/api/admin/roles", {
      method: "POST", headers: json, body: JSON.stringify({ name: "Shop" }),
    }), { params: Promise.resolve({}) });
    expect(created.status).toBe(403);
    const edited = await put(new Request(`http://t/api/admin/roles/${id}`, {
      method: "PUT", headers: json, body: JSON.stringify({ permissions: ["action.manage_users"] }),
    }), withId(id));
    expect(edited.status).toBe(403);
    const deleted = await del(new Request(`http://t/api/admin/roles/${id}`, {
      method: "DELETE", headers: json, body: JSON.stringify({ reason: "typed by mistake" }),
    }), withId(id));
    expect(deleted.status).toBe(403);

    const names = (await listRoles()).map((r) => r.name);
    expect(names).toContain("Billing");
    expect(names).not.toContain("Shop");
    expect((await listRoles()).find((r) => r.name === "Billing")!.permissions).toEqual([]);
  });

  it("manage_users alone creates, edits and deletes a role", async () => {
    const cookie = await signInWith(["action.manage_users"], "role-r8-ok");
    const json = { cookie, "content-type": "application/json" };

    const created = await post(new Request("http://t/api/admin/roles", {
      method: "POST", headers: json, body: JSON.stringify({ name: "Shop" }),
    }), { params: Promise.resolve({}) });
    expect(created.status).toBe(200);
    const { id } = await created.json();
    const edited = await put(new Request(`http://t/api/admin/roles/${id}`, {
      method: "PUT", headers: json, body: JSON.stringify({ permissions: ["orders.view"] }),
    }), withId(id));
    expect(edited.status).toBe(200);
    expect((await listRoles()).find((r) => r.id === id)!.permissions).toEqual(["orders.view"]);
    const deleted = await del(new Request(`http://t/api/admin/roles/${id}`, {
      method: "DELETE", headers: json, body: JSON.stringify({ reason: "typed by mistake" }),
    }), withId(id));
    expect(deleted.status).toBe(200);
    expect((await listRoles()).map((r) => r.id)).not.toContain(id);
  });
});
