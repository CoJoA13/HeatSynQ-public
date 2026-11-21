import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { createOrder, listOrders, listOrdersWindow } from "@/server/orders";
import { parseOrderFilter } from "./query";

// GET /api/orders — the bare array is every matching order in the applied sort (the shipment
// pickers, the hub's quote linking, the template editor). `?window=1` is the board's own mode
// (#612, ruling R3): an envelope `{ rows, cut }` holding the first 200 rows of the applied sort,
// or, with `showAll=1`, every row and `cut: false`. The export route never windows.
export const GET = handle(async (req) => {
  mustCan(requireUser(), "orders", "view");
  const url = new URL(req.url);
  const filter = parseOrderFilter(url);
  if (url.searchParams.get("window") !== "1") return NextResponse.json(await listOrders(filter));
  if (url.searchParams.get("showAll") === "1") return NextResponse.json({ rows: await listOrders(filter), cut: false });
  return NextResponse.json(await listOrdersWindow(filter));
});

export const POST = handle(async (req) => {
  mustCan(requireUser(), "orders", "create");
  return NextResponse.json(await createOrder(await req.json()));
});
