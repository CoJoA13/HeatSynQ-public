import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { can, mustCan } from "@/server/permissions";
import { saveRecipeNumber } from "@/server/part-process-steps";

import { readProcessDocumentProjection } from "@/server/process-document";

export const PATCH = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "processes", "edit");
  const input = await req.json();
  const partId = (await params).id;
  const result = await saveRecipeNumber(partId, input, can(user, "processes", "view")
    ? async tx => (await readProcessDocumentProjection(tx, partId)).baseline
    : undefined);
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
});
