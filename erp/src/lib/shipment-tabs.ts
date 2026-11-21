// Both shipment pages' tabs (spec 2026-10-30-ux-redesign-design.md §4.4; the UX redesign PR 4,
// owner 2026-10-31). New shipment: Customer & route (the customer, its hold and notes, the header
// fields), Orders & containers (Add order, the order panels, the totals), Freight & review (the
// freight block); the page registers its whole draft under one label, the page's own, so no tab
// badges a half. A refused Save jumps to its first refused box (R13), which may sit on a tab that
// is not open: `newShipmentTabForBox` names that tab from the box id (`shipment-box-ids.ts`'s
// shapes), and the page asks RecordTabs to open it through `open` before it focuses the box. The
// saved shipment: Orders & quantities (Add order, the order panels with their Lines, Containers and
// Serials grids, whose registry labels badge this tab, and the totals), Header & freight (the
// blur-saved header), Documents, History. Imports one leaf's ids; client-safe, and the E2E helpers
// read it under plain node.
import type { RecordTab } from "./record-tabs";
import { SHIPMENT_BOX } from "./shipment-box-ids";

export const NEW_SHIPMENT_TAB_LABEL = "New shipment sections";
export const SHIPMENT_TAB_LABEL = "Shipment sections";

export type NewShipmentTabKey = "route" | "orders" | "freight";
export type ShipmentTabKey = "orders" | "header" | "documents" | "history";

export function newShipmentTabs(): RecordTab[] {
  return [
    // Each tab's own key is among its ids, so the page can ask it open by key through `open`.
    { key: "route", label: "Customer & route", sections: [], ids: ["route", "customer", "header"] },
    { key: "orders", label: "Orders & containers", sections: [], ids: ["orders"] },
    { key: "freight", label: "Freight & review", sections: [], ids: ["freight"] },
  ];
}

/** The New shipment tab a refusable box sits on: the freight boxes on Freight & review, the Add
 *  order list and every line or container row box (`shipment-<order>-line-…` /
 *  `shipment-<order>-container-…`) on Orders & containers, everything else (the customer, the
 *  credit-hold reason, the ship date) on Customer & route. */
export function newShipmentTabForBox(id: string): NewShipmentTabKey {
  if (id === SHIPMENT_BOX.freightAmount || id === SHIPMENT_BOX.packageCount) return "freight";
  if (id === SHIPMENT_BOX.addOrder || /^shipment-.+-(line|container)-\d+-/.test(id)) return "orders";
  return "route";
}

export function shipmentTabs(): RecordTab[] {
  return [
    { key: "orders", label: "Orders & quantities", sections: ["Lines", "Containers", "Serials"], ids: ["add-order", "orders", "totals"] },
    { key: "header", label: "Header & freight", sections: [], ids: ["header"] },
    { key: "documents", label: "Documents", sections: [], ids: ["documents"] },
    { key: "history", label: "History", sections: [], ids: ["history"] },
  ];
}
