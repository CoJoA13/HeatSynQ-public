import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { HttpError } from "@/server/errors";
import { printSelectedTraveler, travelerFilename } from "@/server/traveler";
import { travelerSelectionSchema, type TravelerSelection } from "@/lib/traveler-selection";

const printBody = z.object({
  selection: travelerSelectionSchema,
  expectedPrintFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

/**
 * Renders, archives and streams one traveler. Empty-body requests retain all-load/`?load=N`
 * behavior; a strict JSON selection prints the requested saved loads into one PDF.
 *
 * Gated on `orders.view`, deliberately (spec §9): printing changes nothing about the ORDER — it
 * archives its own output as an audited `StoredDocument` create, recording who printed and when.
 * It is an explicit POST rather than a read side-effect, so §12's "reads never mutate" holds.
 */
export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "orders", "view");
  const { id } = await params;

  const query = new URL(req.url).searchParams;
  if ([...query.keys()].some(key => key !== "load") || query.getAll("load").length > 1)
    throw new HttpError(400, "Unknown or repeated traveler query parameter");
  const raw = query.get("load");
  let selection: TravelerSelection = { mode: "all" };
  let expectedPrintFingerprint: string | undefined;
  const bodyText = await req.text();
  if (bodyText.trim() !== "") {
    if (raw !== null) throw new HttpError(400, "Do not combine traveler selection with ?load");
    let json: unknown;
    try { json = JSON.parse(bodyText); } catch { throw new HttpError(400, "Invalid traveler JSON body"); }
    ({ selection, expectedPrintFingerprint } = printBody.parse(json));
  }
  if (raw !== null) {
    // Anchored, not parseInt: "3abc" must be a 400, not silently load 3.
    if (!/^\d+$/.test(raw)) throw new HttpError(400, "load must be a whole load number");
    selection = { mode: "loads", loadNumbers: [Number(raw)] };
  }

  const printed = await printSelectedTraveler(id, selection, expectedPrintFingerprint);
  return new NextResponse(new Uint8Array(printed.pdf), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${travelerFilename(printed.orderNumber, printed.loadNumber, printed.travelerLoadNumbers)}"`,
      // The stored row this response came from, so a caller that wants to link to the archived
      // copy does not have to re-list the order's documents to find it.
      "x-document-id": printed.documentId,
    },
  });
});
