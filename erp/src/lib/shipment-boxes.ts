// Client-safe, no imports but the leaves it names: each shipment box's label, as the shipment
// screens show it, and its limits, as its column holds them (the order-boxes.ts shape). The screens
// name a refused box with `label` and check it with `box`; the server's shipment schemas build their
// rule from the same `box` (`decimalBoxField`), so a screen and the server cannot disagree on a limit.
import type { DecimalBox } from "./decimal-entry";
import { TARE_EACH, type OrderBox } from "./order-boxes";

export type ShipmentBox = { label: string; box: DecimalBox };

/** A shipment line's Ship now net weight: zero is allowed, a figure is required. */
export const SHIP_NOW_NET_WEIGHT: ShipmentBox = {
  label: "Ship now net weight (lb)", box: { intDigits: 10, scale: 2, min: "nonnegative" },
};
/** A shipment container row's Tare each: the same box as an order's, so one definition. */
export const SHIPMENT_TARE_EACH: OrderBox = TARE_EACH;
/** A shipment's billed freight. */
export const FREIGHT_AMOUNT: ShipmentBox = {
  label: "Freight amount", box: { intDigits: 10, scale: 2, min: "nonnegative" },
};
