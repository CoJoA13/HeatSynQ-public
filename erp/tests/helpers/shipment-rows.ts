// A reader of stored shipment rows, and the one fixture of a kept container row, that the shipment
// suites share: shippers.test.ts, shipper-children.test.ts, order-ship-invariants.test.ts,
// invoice-guards.test.ts, shipping-ticket.test.ts and bol.test.ts.
//
// Not named `*.test.ts`, so it is type-checked and linted but vitest never runs it as a suite.
import { prisma } from "./db";
import { runWithContext } from "@/server/context";
import { replaceContainers } from "@/server/orders";
import { replaceShipperContainers } from "@/server/shippers";

/** Each container row's stored tare each on one shipment order, in position order: text with two
 *  decimals, or null. Read by raw prisma, so a case about what is STORED does not lean on the
 *  service's own read. */
export const storedTareEach = async (shipperOrderId: string) =>
  (await prisma.shipperContainer.findMany({
    where: { shipperOrderId }, select: { tareEach: true }, orderBy: { position: "asc" },
  })).map((c) => (c.tareEach === null ? null : c.tareEach.toFixed(2)));

/** Gives one order's part of a saved shipment a kept container row and a linked one, through the
 *  services, as a kept row comes about: the shipment picks the order's row, the order's Containers
 *  are saved without that row and with a new one (the body names no row by id, so the first row is
 *  removed, which releases the shipment's row: #493), and the shipment picks the row that save
 *  made. Stored afterwards, in position order: the kept row (BIN-1, 3 containers, tare each 42.50,
 *  no order row) and a row linked to the order's row as it is now (BIN-2, 2 containers, tare each
 *  55.00). The order's part must hold no container row when this is called. The two bodies sent to
 *  the shipment's Containers save are bare lists with no `tareEach` key. The order's own Containers
 *  save between them carries the 55.00. */
export async function keptAndLinkedRows(at: {
  shipperId: string; shipperOrderId: string; orderId: string; typeId: string;
}): Promise<{ keptId: string; linkedId: string; orderRowId: string }> {
  const first = await prisma.orderContainer.create({
    data: { orderId: at.orderId, position: 1, typeId: at.typeId, count: 3, tareEach: "42.50", customerContainerId: "BIN-1" },
  });
  await replaceShipperContainers(at.shipperId, at.shipperOrderId, [{ orderContainerId: first.id, count: 3 }]);
  const resaved = await runWithContext({ actor: { id: null, name: "test" }, user: null }, () =>
    replaceContainers(at.orderId, [{ typeId: at.typeId, count: 2, tareEach: "55.00", customerContainerId: "BIN-2" }]));
  const orderRowId = resaved.containers[0].id;
  await replaceShipperContainers(at.shipperId, at.shipperOrderId, [{ orderContainerId: orderRowId, count: 2 }]);
  const [kept, linked] = await prisma.shipperContainer.findMany({
    where: { shipperOrderId: at.shipperOrderId }, orderBy: { position: "asc" }, select: { id: true },
  });
  return { keptId: kept.id, linkedId: linked.id, orderRowId };
}
