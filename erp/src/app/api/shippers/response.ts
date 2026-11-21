// Not a route — see orders/query.ts's own header comment for why a plain module can sit next to
// route.ts files under this same tree without Next mistaking it for a fourth handler.
//
// Task 11 Step 0b (carried from Task 9's review): `updateShipper`, `addOrderToShipper`,
// `removeOrderFromShipper`, `replaceShipperLines`, `replaceShipperContainers` and
// `replaceShipperSerials` (shippers.ts) each return a bare `ShipperDetail`, with the spec §5.7
// over-ship warning exposed only through the separate pure `overshipWarnings` export — nothing
// obliges a caller to invoke it, so `return NextResponse.json(await replaceShipperLines(...))`
// would silently drop the warning a screen is supposed to show. Every mutating shipment route
// wraps its response through this ONE function instead of five (six, with `updateShipper`)
// hand-copied call sites that could drift apart, so `shipper` and `warnings` match
// `createShipper`'s own contract.
//
// #472 (owner ruling R-Q2, 2026-10-08): the envelope also carries `printed`, the orders that
// printed paper pins to this shipment, so the page can grey Remove order out before the click. It
// is read HERE, on the top-level client after the mutation has committed, and not in
// `readShipperDetail`, which runs inside the mutators' Serializable transactions and both print
// transactions. `createShipper`'s own response does not come through this function and carries no
// `printed`; the saved page's first GET does.
//
// #484 (owner ruling 2026-10-15, "Payload address after commit, select open"): the envelope also
// carries `shipToAddress`, the shipment's ship-to address, so the page can show it to a viewer
// whose address list lacks it. It is read beside `printed`, on the top-level client after the
// mutation has committed, by id and unfiltered (`readShipToAddress`), and it is the address's
// name, street, city, state and zip, or null when the shipment has none. `createShipper`'s own
// response carries no `shipToAddress` either; the saved page's first GET does.
import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { readPrintedOrders, readShipToAddress, shipmentWarnings, type ShipperDetail } from "@/server/shippers";

// No `Promise<NextResponse>` annotation: it would erase the body type that
// `tests/api-answer-body-sweep.test.ts` reads to prove every api() answer carries a body (#569).
export async function shipperResponse(detail: ShipperDetail) {
  // The FULL §5.7 surface — missing-cert, serialization, over-ship — on every edit response
  // (#54): the detail page swaps its whole warning banner for this array, so an edit that
  // computed less than creation does silently un-warned the operator.
  const warnings = await shipmentWarnings(prisma, detail);
  const printed = await readPrintedOrders(prisma, detail.id, detail.orders.map((o) => o.orderId));
  const shipToAddress = await readShipToAddress(prisma, detail.shipToAddressId);
  return NextResponse.json({ shipper: detail, warnings, printed, shipToAddress });
}
