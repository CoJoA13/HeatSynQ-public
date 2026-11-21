// New shipment's box ids, for the jump to the first refused box and the `aria-invalid` marks of a
// refused Save (owner ruling R13; G8-3). The grids' aria-labels repeat in every order panel
// ("Line 1 ship-now weight"), so a row's box is named by its order and its place in that grid. The
// labels stay as they are: flows find boxes by them. Import-free; the page, the grids and
// `new-shipment-recovery.ts` all read it.

export const SHIPMENT_BOX = {
  customer: "shipment-customer",
  shipDate: "shipment-ship-date",
  addOrder: "shipment-add-order",
  packageCount: "shipment-package-count",
  freightAmount: "shipment-freight-amount",
  creditHoldReason: "shipment-credit-hold-reason",
} as const;

/** A line row's Ship now quantity or Ship now net weight box; `index` counts from 0. */
export function shipmentLineBoxId(orderId: string, index: number, box: "qty" | "weight"): string {
  return `shipment-${orderId}-line-${index}-${box}`;
}

/** A container row's count or Tare each box; `index` counts from 0. */
export function shipmentContainerBoxId(orderId: string, index: number, box: "count" | "tareEach"): string {
  return `shipment-${orderId}-container-${index}-${box}`;
}

/** The box a refusal of `POST /api/shippers` names, or null (owner answer 2026-10-29): only a
 *  sentence that names a box exactly is routed, which is a field path at its start (the shape
 *  `readableMessage` gives a refused field: `orders.0.lines.1.weight: …`) or the credit-hold
 *  reason's own sentence. A path's order index is the body's, which is the form's order list
 *  (`orderIds`, in the order the form sends them). Every other sentence stays in the banner. */
export function shipmentServerRefusalBox(message: string, orderIds: readonly string[]): string | null {
  if (message.startsWith("A reason is required to override a credit hold")) return SHIPMENT_BOX.creditHoldReason;
  const row = /^orders\.(\d+)\.(lines|containers)\.(\d+)\.(qty|weight|count|tareEach): /.exec(message);
  if (row) {
    const orderId = orderIds[Number(row[1])];
    if (orderId === undefined) return null;
    const index = Number(row[3]);
    if (row[2] === "lines") return row[4] === "qty" || row[4] === "weight" ? shipmentLineBoxId(orderId, index, row[4]) : null;
    return row[4] === "count" || row[4] === "tareEach" ? shipmentContainerBoxId(orderId, index, row[4]) : null;
  }
  const field = /^(shipDate|packageCount|freightAmount|creditHoldReason): /.exec(message);
  return field ? SHIPMENT_BOX[field[1] as "shipDate" | "packageCount" | "freightAmount" | "creditHoldReason"] : null;
}
