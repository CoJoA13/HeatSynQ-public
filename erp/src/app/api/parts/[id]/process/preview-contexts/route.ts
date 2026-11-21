import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listProcessPreviewContexts } from "@/server/process-traveler-preview";
export const GET = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "parts", "view");
  mustCan(user, "processes", "view");
  mustCan(user, "orders", "view");
  const url = new URL(req.url);
  return NextResponse.json(await listProcessPreviewContexts((await params).id, url.searchParams.get("q") ?? "", url.searchParams.get("cursor") ?? undefined), { headers: { "cache-control": "no-store" } });
});
