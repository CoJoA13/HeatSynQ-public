import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { can, mustCan } from "@/server/permissions";
import { readProcessDocumentRequest } from "@/server/process-document-request";
import { renderProcessTravelerPreview } from "@/server/process-traveler-preview";
export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "parts", "view");
  mustCan(user, "processes", "view");
  // A SAMPLE preview needs only the two gates above (spec 2026-09-26 §5). The service refuses an
  // order context without orders.view before it reads anything, and customers.view decides
  // whether the SAMPLE header prints the received-from address and phone.
  const access = { orders: can(user, "orders", "view"), customers: can(user, "customers", "view") };
  const input = await readProcessDocumentRequest(req);
  const result = await renderProcessTravelerPreview((await params).id, input, access);
  return new NextResponse(new Uint8Array(result.pdf), { headers: {
    "content-type": "application/pdf", "cache-control": "no-store",
    "X-Preview-Template-Id": result.templateId, "X-Preview-Template-Name": encodeURIComponent(result.templateName),
    "X-Preview-Page-Count": String(result.pageCount), "X-Preview-Generation": String(result.generation),
    "X-Preview-Sample": result.sample ? "1" : "0",
  } });
});
