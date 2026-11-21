import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser, reasonFromBody } from "@/server/http";
import { mustDo } from "@/server/permissions";
import { updateRole, deleteRole } from "@/server/roles";

const Body = z.object({ name: z.string().min(1).optional(), permissions: z.array(z.string()).optional() });

// Ruling R8 (#648 part 2, #718): both role writes here take action.manage_users alone, in place of
// admin.edit and admin.delete; the roles list (GET /api/admin/roles) stays on admin.view.
export const PUT = handle(async (req, ctx) => {
  mustDo(requireUser(), "manage_users");
  const { id } = await ctx.params;
  const body = Body.parse(await req.json());
  // One service call, one transaction (#648 part 1): a refused permission set no longer leaves
  // the rename committed.
  await updateRole(id, body);
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (req, ctx) => {
  mustDo(requireUser(), "manage_users");
  const { id } = await ctx.params;
  // A DELETE carrying a body — the reason a role delete requires (spec §9; `deleteRole` enforces
  // it in the service). A request with no body at all, or a body that isn't a JSON object (e.g.
  // `null`), is deliberately not a parse error: the service reports the missing reason as a
  // field-anchored 400 rather than this route failing on malformed JSON. `reasonFromBody`'s own
  // docblock (http.ts) is the record of why the hand-rolled read this replaced was wrong — a JSON
  // body of literal `null` threw a raw TypeError out of the handler as a 500.
  const body: unknown = await req.json().catch(() => null);
  await deleteRole(id, reasonFromBody(body));
  return NextResponse.json({ ok: true });
});
