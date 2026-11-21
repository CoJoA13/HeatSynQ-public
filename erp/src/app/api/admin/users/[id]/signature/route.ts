import { NextResponse } from "next/server";
import { handle, requireUser, parseUploadFile, HttpError, bodyView } from "@/server/http";
import { mustDo } from "@/server/permissions";
import { setSignature, clearSignature, getSignature } from "@/server/users";

export const GET = handle(async (req, { params }) => {
  mustDo(requireUser(), "manage_users");
  const { id } = await params;
  const signature = await getSignature(id);
  if (!signature) throw new HttpError(404, "No signature on file");
  // #689 (owner ruling 2026-10-22): the browser may keep the image but revalidates it on every
  // load, so a cleared signature or a revoked permission is seen on the next load and nothing is
  // served stale; the tag is the signature revision the preview URL cache-busts on (#171), so a
  // repeat load of /admin/users costs a 304 per signed user, not the bytes. Attachments are never
  // cached. The body is a view over the stored bytes, not a second copy.
  const etag = `"${signature.revision}"`;
  const headers = { "cache-control": "private, no-cache", etag };
  if (req.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers });
  return new NextResponse(bodyView(signature.data), {
    status: 200,
    headers: { ...headers, "content-type": signature.mimeType },
  });
});

export const PUT = handle(async (req, { params }) => {
  mustDo(requireUser(), "manage_users");
  const { id } = await params;
  const file = await parseUploadFile(req);
  await setSignature(id, file.data, file.mimeType);
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req, { params }) => {
  mustDo(requireUser(), "manage_users");
  const { id } = await params;
  await clearSignature(id);
  return NextResponse.json({ ok: true });
});
