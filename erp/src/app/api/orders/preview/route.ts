import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { can, mustCan } from "@/server/permissions";
import { previewOrderEntry } from "@/server/order-entry-preview";

export const POST = handle(async (req) => {
  const user = requireUser();
  mustCan(user, "orders", "create");
  mustCan(user, "customers", "view");
  mustCan(user, "parts", "view");
  return NextResponse.json(await previewOrderEntry(await req.json(), {
    includeProcess: can(user, "processes", "view"),
  }));
});
