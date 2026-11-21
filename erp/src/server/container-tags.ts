// #743: the container tag's text. One read of the order (`readContainerTagsOrder`, run by the route
// with no transaction and no claim: a pure read, spec §12) becomes one `ContainerTagData` per
// container row, every value the string it prints, and the file's name. The builder
// (`pdf/container-tags.ts`) only lays that text out.
//
// Every tag of an order prints the same text (owner ruling 2, 2026-10-23: one tag per row, a row
// with count 3 prints one tag): the order number and customer, the PO, each line's part number and
// quantity, the order's container total (every row's count added up, `containerTotal`) and the
// received line, the Received date (a civil date) with the time of day the order was created on the
// plant's clock (owner confirmation, 2026-10-23). Not on it: container type, Cust Cont Id, load
// number, barcode (ruling 1).
//
// Value imports are of src/lib/ leaves and the plant clock only, so the file loads with no database
// (tests/container-tags.test.ts loads it in a child process to fix the process's time zone).
import type { Prisma } from "../../prisma/generated/prisma/client";
import type { ContainerTagData } from "./pdf/container-tags";
import { containerTotal } from "../lib/container-total";
import { civil, plantClock } from "./plant-clock";

/** What the tags read of an order, lines and containers in position order. */
export type ContainerTagsOrder = {
  orderNumber: number;
  poNumber: string;
  receivedDate: Date;
  createdAt: Date;
  customer: { name: string };
  lines: { qty: number; part: { partNumber: string } }[];
  containers: { count: number }[];
};

/** The read behind the route: the order's own row, voided or not (the route decides that), its
 *  customer's name, its lines' quantities and part numbers and its container rows' counts. */
export async function readContainerTagsOrder(
  db: Prisma.TransactionClient, orderId: string,
): Promise<(ContainerTagsOrder & { deletedAt: Date | null; customerId: string }) | null> {
  return db.order.findFirst({
    where: { id: orderId },
    select: {
      orderNumber: true, poNumber: true, receivedDate: true, createdAt: true, deletedAt: true, customerId: true,
      customer: { select: { name: true } },
      lines: { orderBy: { position: "asc" }, select: { qty: true, part: { select: { partNumber: true } } } },
      containers: { orderBy: { position: "asc" }, select: { count: true } },
    },
  });
}

/** The tags' three refusals, in the print route's words: an order the id names nowhere (404), a
 *  voided order (400; a voided order prints no new paper, spec §5c) and an order with no container
 *  row to tag (400). The route and the template preview's CONTAINER_TAG arm both read them. */
export const TAG_ORDER_NOT_FOUND = "Order not found";
export const TAG_ORDER_VOIDED = "Order is voided — no tags print for it";
export const TAG_NO_ROWS = "This order has no container rows to tag";

/** A blank PO prints as a dash, the screens' mark for a value that is not there. */
const NO_PO = "—";

/** The tags' text, one per container row (none for an order with no rows), and the file's name. */
export function containerTagsData(order: ContainerTagsOrder): { tags: ContainerTagData[]; fileName: string } {
  const tag: ContainerTagData = {
    orderNumber: String(order.orderNumber),
    customer: order.customer.name,
    poNumber: order.poNumber.trim() === "" ? NO_PO : order.poNumber,
    parts: order.lines.map((line) => `${line.part.partNumber} × ${line.qty.toLocaleString("en-US")}`),
    containersTotal: containerTotal(order.containers).toLocaleString("en-US"),
    received: `${civil(order.receivedDate)}, ${plantClock(order.createdAt).time}`,
  };
  return {
    tags: order.containers.map(() => ({ ...tag, parts: [...tag.parts] })),
    fileName: `container-tags-${order.orderNumber}.pdf`,
  };
}
