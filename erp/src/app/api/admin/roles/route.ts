import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { listRoles, createRole } from "@/server/roles";

export const GET = handle(async () => {
  mustCan(requireUser(), "admin", "view");
  return NextResponse.json(await listRoles());
});

// Ruling R8 (#648 part 2, #718): creating, editing and deleting a role is managing users, so the
// three role mutations take action.manage_users alone, as the users routes do. Reading stays on
// admin.view.
export const POST = handle(async (req) => {
  mustDo(requireUser(), "manage_users");
  const { name } = z.object({ name: z.string().min(1) }).parse(await req.json());
  return NextResponse.json(await createRole(name));
});
