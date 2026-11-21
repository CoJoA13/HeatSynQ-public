import { NextResponse } from "next/server";
import { handle, requireUser, parseUploadFile, bodyView } from "@/server/http";
import { HttpError } from "@/server/errors";
import { mustCan } from "@/server/permissions";
import { uploadLogo, clearLogo, readDraftLogo } from "@/server/templates";

// The signature-route shape (#49): parseUploadFile bounds and parses the multipart body; the
// service owns the MIME allowlist, the 512KB cap, and the magic-byte sniff.
export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "templates", "edit");
  const { id } = await params;
  const file = await parseUploadFile(req);
  await uploadLogo(id, file.data, file.mimeType);
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req, { params }) => {
  mustCan(requireUser(), "templates", "edit");
  const { id } = await params;
  await clearLogo(id);
  return NextResponse.json({ ok: true });
});

// The canvas designer's <img>. The typed body is for tests/api-answer-body-sweep.test.ts (#569): a
// logo answer always has bytes. no-store because the draft's logo changes (the stage adds ?v=).
export const GET = handle(async (_req, { params }): Promise<NextResponse<Uint8Array<ArrayBuffer>>> => {
  mustCan(requireUser(), "templates", "view");
  const { id } = await params;
  const logo = await readDraftLogo(id);
  if (!logo) throw new HttpError(404, "No logo image");
  return new NextResponse(bodyView(Buffer.from(logo.bytes)), {
    headers: { "content-type": logo.mime, "cache-control": "no-store" },
  });
});
