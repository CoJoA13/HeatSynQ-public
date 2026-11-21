import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { HttpError } from "@/server/errors";
import { Prisma } from "../../../../../../prisma/generated/prisma/client";
import { prisma } from "@/server/db";
import { resolveTemplateForPrint } from "@/server/template-assignments";
import {
  TAG_NO_ROWS, TAG_ORDER_NOT_FOUND, TAG_ORDER_VOIDED, containerTagsData, readContainerTagsOrder,
} from "@/server/container-tags";
import { buildContainerTags } from "@/server/pdf/container-tags";
import { jpegDataUri, pngDataUri, renderPdf } from "@/server/pdf/render";
import { templatePlacesLogo } from "@/lib/template-contracts/template-logo";

// GET /api/orders/[id]/container-tags: the order hub's Print tags (#743), one 4 in × 3 in tag per
// container row for shop-floor identification. The text is `containerTagsData`'s, the layout
// `buildContainerTags`'s. Gated on `orders.view`, the traveler's gate (spec §9): a tag shows the
// order and changes nothing about it.
//
// A pure read (spec §12, reports never mutate): no claim, no audit, no stored document. The tags
// are internal paper, a download only (owner ruling 4, 2026-10-23: informational, nothing recorded),
// so spec §8's "every outgoing document stored" does not reach them, as it does not reach the
// Invoice register (#592). A voided order prints no new paper (spec §5c, as the traveler), and an
// order with no container rows has no tag to print: both are refused before any render.
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "orders", "view");
  const { id } = await params;
  // One RepeatableRead snapshot for the order and the template it prints under (a read taken from
  // inside a transaction runs ON it). The three refusals come before the resolve: a refused order
  // resolves nothing. The flow places no logo (the contract withholds it); a canvas Logo item prints
  // the version's bytes, converted by the STORED mime type only when the config places a logo
  // (`templatePlacesLogo`, the quote's rule), so an unplaced upload converts nothing.
  const { tags, fileName, config, logoDataUri } = await prisma.$transaction(async (tx) => {
    const order = await readContainerTagsOrder(tx, id);
    if (!order) throw new HttpError(404, TAG_ORDER_NOT_FOUND);
    if (order.deletedAt !== null) throw new HttpError(400, TAG_ORDER_VOIDED);
    const data = containerTagsData(order);
    if (data.tags.length === 0) throw new HttpError(400, TAG_NO_ROWS);
    const resolved = await resolveTemplateForPrint(tx, "CONTAINER_TAG", order.customerId);
    const logoDataUri = resolved.logoImage !== null && templatePlacesLogo(resolved.config)
      ? (resolved.logoMimeType === "image/jpeg"
          ? jpegDataUri(Buffer.from(resolved.logoImage))
          : pngDataUri(Buffer.from(resolved.logoImage)))
      : undefined;
    return { ...data, config: resolved.config, logoDataUri };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  const pdf = await renderPdf(buildContainerTags(tags, config, logoDataUri));
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${fileName}"`,
    },
  });
});
