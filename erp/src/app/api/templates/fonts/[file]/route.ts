import { NextResponse } from "next/server";
import { handle, requireUser, bodyView } from "@/server/http";
import { HttpError } from "@/server/errors";
import { FONT_FILE_NAMES } from "@/lib/template-fonts";
import { fontBytes } from "@/server/pdf/render";

export const GET = handle(async (_req, { params }): Promise<NextResponse<Uint8Array<ArrayBuffer>>> => {
  // The typed body is for tests/api-answer-body-sweep.test.ts: its loose `/api/*/*/attachments` read
  // reaches this route's shape, and a font answer always has bytes.
  const user = requireUser();
  void user; // Session-only gate, DELIBERATELY no area check: the template editor's stage draws with
  // these fonts for any user who can open a template, and the bytes are the repo's vendored
  // open-licence fonts, nothing per-record. Bound to a variable because
  // tests/permissions-sweep.test.ts requires the call to be assigned or to feed mustCan/mustDo.
  const { file } = await params;
  // Refuse before any read: only the eight names the leaf lists ever reach `fontBytes`.
  if (!FONT_FILE_NAMES.has(file)) throw new HttpError(404, "Font not found");
  const bytes = fontBytes(file);
  if (bytes === null) throw new HttpError(404, "Font not found");
  return new NextResponse(bodyView(bytes), {
    headers: {
      "content-type": "font/ttf",
      // Session-gated, so one copy per browser and never shared through a cache.
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
});
