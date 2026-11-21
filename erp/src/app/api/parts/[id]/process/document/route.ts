import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { readProcessDocument, saveProcessDocument } from "@/server/process-document";
import { readProcessDocumentRequest } from "@/server/process-document-request";
// Generic, not `unknown`, so the body type stays readable to `tests/api-answer-body-sweep.test.ts` (#569).
const json = <T>(value: T) => NextResponse.json(value, { headers: { "cache-control": "no-store" } });
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "processes", "view");
  return json(await readProcessDocument((await params).id));
});
export const PUT = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "processes", "view");
  mustCan(user, "processes", "edit");
  const input = await readProcessDocumentRequest(req);
  return json(await saveProcessDocument((await params).id, input));
});
