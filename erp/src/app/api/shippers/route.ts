import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan, canDo } from "@/server/permissions";
import { createShipper, listShippers, listShippersWindow } from "@/server/shippers";
import { parseShipperFilter } from "./query";

// GET /api/shippers — the bare array is every matching shipment, newest first (the template
// editor's shipment picker, E2E helpers). `?window=1` is the shipping list's own mode (#612, ruling
// R3): an envelope `{ rows, cut }` holding the newest 200, or, with `showAll=1`, every row and
// `cut: false`. The export route never windows.
export const GET = handle(async (req) => {
  mustCan(requireUser(), "shipping", "view");
  const url = new URL(req.url);
  const filter = parseShipperFilter(url);
  if (url.searchParams.get("window") !== "1") return NextResponse.json(await listShippers(filter));
  if (url.searchParams.get("showAll") === "1") return NextResponse.json({ rows: await listShippers(filter), cut: false });
  return NextResponse.json(await listShippersWindow(filter));
});

export const POST = handle(async (req) => {
  const user = requireUser();
  mustCan(user, "shipping", "create");
  // `canOverrideCreditHold` is passed EVERY TIME, true or false — the service (spec §5.4) is what
  // decides whether the customer is even on hold, and only then whether this flag matters. A
  // session lacking `override_credit_hold` still gets refused on a held customer even when its
  // request body supplies a reason (task-11-brief.md's own gate callout).
  const result = await createShipper(await req.json(), { canOverrideCreditHold: canDo(user, "override_credit_hold") });
  return NextResponse.json(result);
});
