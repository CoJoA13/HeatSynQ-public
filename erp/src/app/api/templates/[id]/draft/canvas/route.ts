import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { readPreviewContext, RECORD_AREA } from "@/server/template-preview";
import { seedCanvasLayout } from "@/server/template-canvas-seed";

/**
 * POST /api/templates/[id]/draft/canvas — a draft's canvas, seeded from today's paper (the traveler's
 * design 2026-11-07 §5.4, ruling 5; the shipping ticket's design 2026-11-08 §5.3): the editor's
 * working config is laid out once for the picked record (a traveler's order, a SHIPPER or
 * MOS_SHIPPER ticket's shipment, its first order's ticket, a bill of lading's shipment, design
 * 2026-11-09 §5.3, its number never allocated, a certification, design 2026-11-10 §5.3, laid out from
 * a stand-in at its least and signed by the acting user; an invoice or credit memo, the invoice canvas
 * design 2026-11-10 §5.3, laid out from a stand-in at its least; a statement's customer, the statement
 * canvas design 2026-11-11 §5.3, laid out from a stand-in at its least; a quote, the quote canvas
 * design 2026-11-12 §5.3, laid out from a stand-in at its least, since quote canvas PR 2; a container
 * tag's order, the container tag design 2026-11-13 §7.4, worked from the flow's line heights, since
 * container tag PR 3) and answered
 * as a `CanvasLayout` that prints the same lines in the same places. A type whose contract offers no
 * canvas is refused with a 400 naming it, and one whose canvas does not print, in the later-release
 * sentence; every docType's canvas prints, so only the tests' stubbed docType reaches either. It writes
 * NOTHING: no draft edit, no `StoredDocument`, no audit. The editor applies the answer as an ordinary
 * config edit through its draft store, unsaved until the editor's Save.
 *
 * Gated on `templates.edit`, since the answer is a design edit, PLUS the record's own permission
 * (`RECORD_AREA[docType]`: `orders.view` for a traveler, `shipping.view` for a ticket or a bill of
 * lading, `certs.view` for a certification, `invoicing.view` for an invoice, `receivables.view` for a
 * statement, `quotes.view` for a quotation, `orders.view` for a container tag), since it lays out a real record's data (§10). The template is read for its docType
 * between the two gates, as the preview reads it. The record is required: the owner's ruling at PR B's
 * hand-over dropped the design's SAMPLE fallback.
 */
const BODY = z.object({
  recordId: z.string().min(1),
  // A loose object here: the service validates it against the template type's own contract.
  config: z.looseObject({}),
}).strict();

export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "templates", "edit");
  const { id } = await params;
  const ctx = await readPreviewContext(id);
  mustCan(user, RECORD_AREA[ctx.docType], "view");

  const body = BODY.parse(await req.json());
  return NextResponse.json(await seedCanvasLayout(ctx, body, user.id));
});
