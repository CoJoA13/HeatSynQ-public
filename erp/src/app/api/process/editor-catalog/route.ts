import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { readProcessEditorCatalog } from "@/server/process-document";

export const GET = handle(async () => {
  mustCan(requireUser(), "processes", "view");
  return NextResponse.json(await readProcessEditorCatalog(), { headers: { "cache-control": "no-store" } });
});
