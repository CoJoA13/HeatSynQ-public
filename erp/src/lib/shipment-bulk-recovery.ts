import type { ShipperDetail, ShipperOrder, OrderCatalog } from "../app/shipping/[id]/ShipmentDetail";
import type { LineFields, ContainerFields, SerialFields } from "../app/shipping/ShipmentGrids";
import { api } from "./fetcher";
import { gate, gateDo } from "./permission-ui";
import { composeRows, type BulkRecoveryOptions } from "./bulk-grid";
import type { BulkBaseline, BulkContext, BulkDraft, BulkRecoveryCustomization } from "./bulk-grid-recovery";
import type { BulkRecoverySource, BulkSourceSnapshot } from "./bulk-recovery-source";
import { shipmentOrderScope } from "./unsaved-guard";
import { isKeptContainer, keptFirst, shipmentContainerFields } from "./shipment-container-rows";

export type ShipmentRecord = Pick<ShipperDetail, "id" | "customerId" | "customerCreditHold" | "deletedAt" | "reversesShipperId" | "reversedByShipperNumber" | "orders">;
export type ShipmentBulkSnapshot = { shipper: ShipmentRecord; catalogs: Map<string, OrderCatalog>; permissions: string[] };
export type ShipmentBulkSource = BulkRecoverySource<ShipmentRecord, string[]>;
export type ShipmentGridKind = "lines" | "containers" | "serials";
type ShipmentFields = LineFields | ContainerFields | SerialFields;
export type ShipmentOrderRead = {
  lines: { id: string; position: number; qty: number; weight: number; part: { partNumber: string; name: string; eachWeight?: number } }[];
  containers: { id: string; count: number; customerContainerId: string; tareEach?: number | null; type: { name: string } }[];
  serials: { id: string; lineId: string; serial: string; description: string }[];
};
export function toShipmentCatalog(o: ShipmentOrderRead): OrderCatalog {
  return {
    // `?? null`, never undefined, for a line's each weight and a container's tare each: these rows
    // are spread into a baseline context, which refuses undefined.
    lines: o.lines.map(l => ({ id: l.id, position: l.position, partNumber: l.part.partNumber, partName: l.part.name, qty: l.qty, weight: l.weight, eachWeight: l.part.eachWeight ?? null })),
    containers: o.containers.map(c => ({ id: c.id, typeName: c.type.name, customerContainerId: c.customerContainerId, count: c.count, tareEach: c.tareEach ?? null })),
    serials: o.serials.map(s => ({ id: s.id, lineId: s.lineId, serial: s.serial, description: s.description })),
  };
}
export async function readShipmentCatalogs(snapshot: BulkSourceSnapshot<ShipmentRecord, string[]>,
  readOrder: (id: string) => Promise<ShipmentOrderRead> = id => api(`/api/orders/${id}`),
  childId?: string,
): Promise<ShipmentBulkSnapshot> {
  if (!gate(snapshot.access, "shipping.view").allowed) {
    throw new Error("Shipment access is required to read these selections.");
  }
  // A binding needs its own parent catalog. Standalone callers may still request
  // all catalogs; neither path treats unchanged IDs as evidence of freshness, and this function
  // shares nothing: the grids of one order share one call of it per SNAPSHOT OBJECT, in
  // `shipmentBulkOptions` (#608), never here.
  const orders = childId === undefined ? snapshot.record.orders : snapshot.record.orders.filter(order => order.id === childId);
  if (childId !== undefined && orders.length !== 1) throw new Error("Shipment order is no longer available.");
  // Shipping supplies saved rows and readable snapshots. Order access only
  // authorizes fresh catalogs for additions and restoration of retained work.
  if (!gate(snapshot.access, "orders.view").allowed) {
    return { shipper: snapshot.record, permissions: snapshot.access, catalogs: new Map() };
  }
  const ids = [...new Set(orders.map(order => order.orderId))];
  const entries = await Promise.all(ids.map(async id => [id, toShipmentCatalog(await readOrder(id))] as const));
  return { shipper: snapshot.record, permissions: snapshot.access, catalogs: new Map(entries) };
}
export const shipmentLineFields = (l: ShipperOrder["lines"][number]): LineFields => ({ orderLineId: l.orderLineId ?? "", qty: String(l.qty), weight: String(l.weight), lineComplete: String(l.lineComplete) });
// Stated in ./shipment-container-rows with the other row rules both shipment screens share.
export { shipmentContainerFields };
export const shipmentSerialFields = (s: ShipperOrder["serials"][number]): SerialFields => ({ orderSerialId: s.orderSerialId ?? "", printOnShipper: String(s.printOnShipper) });
/** The ordered figures and the shipped-to-date ledger of one shipment order, both read from the same
 *  server answer. A baseline's rows and its ledger must come from one answer: see `settledLinesBaseline`. */
export function lineLedgerContext(order: Pick<ShipperOrder, "lines" | "orderLineShippedToDate"> | undefined) {
  return {
    ordered: (order?.lines ?? []).map(l => ({ id: l.id, orderedQty: l.orderedQty, orderedWeight: l.orderedWeight, shippedToDateQty: l.shippedToDateQty, shippedToDateWeight: l.shippedToDateWeight })),
    shipped: (order?.orderLineShippedToDate ?? []).map(l => ({ ...l })),
  };
}
function context(s: ShipmentBulkSnapshot, childId: string, kind: ShipmentGridKind): { [key: string]: BulkContext } {
  const order = s.shipper.orders.find(o => o.id === childId);
  const catalog = order && gate(s.permissions, "orders.view").allowed ? s.catalogs.get(order.orderId) : undefined;
  const canEdit = gate(s.permissions, "shipping.edit").allowed && !s.shipper.deletedAt
    && s.shipper.reversesShipperId === null && s.shipper.reversedByShipperNumber === null;
  const override = gateDo(s.permissions, "override_credit_hold").allowed;
  return {
    shipperId: s.shipper.id, customerId: s.shipper.customerId, deletedAt: s.shipper.deletedAt,
    reversesShipperId: s.shipper.reversesShipperId, reversedByShipperNumber: s.shipper.reversedByShipperNumber,
    order: order ? { id: order.id, orderId: order.orderId } : null,
    catalogAuthorized: !!catalog,
    editable: canEdit && !!order && (kind !== "lines" || !s.shipper.customerCreditHold || override),
    membership: (order?.[kind] ?? []).map(r => ({ id: r.id, parentId: "orderLineId" in r ? r.orderLineId : "orderContainerId" in r ? r.orderContainerId : r.orderSerialId })),
    ...(kind === "lines" ? {
      customerCreditHold: s.shipper.customerCreditHold, overrideCreditHold: override,
      catalog: (catalog?.lines ?? []).map(l => ({ id: l.id, qty: l.qty, weight: l.weight })),
      ...lineLedgerContext(order),
      // Each weight is display data. The comparison drops `display`, and `catalog` above leaves each
      // weight out, so no comparison reads it. Only the catalog branch (orders.view) has one; the
      // fallback rows, built from the shipment's own lines, write null, never undefined (a baseline
      // context refuses undefined).
      display: { lines: catalog ? catalog.lines.map(l => ({ ...l })) : (order?.lines ?? []).filter(l => l.orderLineId !== null)
        .map(l => ({ id: l.orderLineId!, partNumber: l.partNumber, partName: l.partName, qty: l.orderedQty, weight: l.orderedWeight, eachWeight: null })) },
    } : kind === "containers" ? {
      // An order row's tare each is display data: what a row takes when it is added. The comparison
      // drops `display`, and `catalog` leaves the figure out, so no comparison reads it. The
      // fallback rows are built from the shipment's own containers and have no order figure: null.
      catalog: (catalog?.containers ?? []).map(c => ({ id: c.id, count: c.count })),
      display: { containers: catalog ? catalog.containers.map(c => ({ ...c })) : (order?.containers ?? []).filter(c => c.orderContainerId !== null)
        .map(c => ({ id: c.orderContainerId!, typeName: c.typeName, customerContainerId: c.customerContainerId, count: c.count, tareEach: null })),
        // A kept row has no order container, so the catalog cannot describe it: its own row does, by its own id.
        kept: (order?.containers ?? []).filter(c => c.orderContainerId === null).map(c => ({ id: c.id, typeName: c.typeName, customerContainerId: c.customerContainerId, count: c.count })) },
    } : {
      catalog: (catalog?.serials ?? []).map(sr => ({ id: sr.id, lineId: sr.lineId })),
      display: { serials: catalog ? catalog.serials.map(sr => ({ ...sr })) : (order?.serials ?? []).filter(sr => sr.orderSerialId !== null)
        .map(sr => ({ id: sr.orderSerialId!, serial: sr.serial, description: sr.description })) },
    }),
  };
}
export function shipmentLinesBaseline(s: ShipmentBulkSnapshot, childId: string): BulkBaseline<LineFields> {
  const order = s.shipper.orders.find(o => o.id === childId);
  return { rows: (order?.lines ?? []).filter(l => l.orderLineId !== null).map(l => ({ id: l.id, fields: shipmentLineFields(l) })), context: context(s, childId, "lines") };
}
export function shipmentContainersBaseline(s: ShipmentBulkSnapshot, childId: string): BulkBaseline<ContainerFields> {
  const order = s.shipper.orders.find(o => o.id === childId);
  return { rows: keptFirst(order?.containers ?? []).map(c => ({ id: c.id, fields: shipmentContainerFields(c) })), context: context(s, childId, "containers") };
}
export function shipmentSerialsBaseline(s: ShipmentBulkSnapshot, childId: string): BulkBaseline<SerialFields> {
  const order = s.shipper.orders.find(o => o.id === childId);
  return { rows: (order?.serials ?? []).filter(sr => sr.orderSerialId !== null).map(sr => ({ id: sr.id, fields: shipmentSerialFields(sr) })), context: context(s, childId, "serials") };
}
type ShipmentDisplay = {
  lines: Pick<OrderCatalog["lines"][number], "id" | "partNumber" | "partName" | "qty" | "weight" | "eachWeight">[];
  containers: OrderCatalog["containers"];
  serials: Pick<OrderCatalog["serials"][number], "id" | "serial" | "description">[];
  kept: { id: string; typeName: string; customerContainerId: string; count: number }[];
};
/** Validated readable metadata from this accepted baseline. Saved shipping
 * snapshots are display-only; catalogAuthorized separately controls Add choices. */
export function shipmentDisplayFromBaseline<F>(baseline: BulkBaseline<F> | undefined): ShipmentDisplay {
  const display = baseline?.context.display as Partial<ShipmentDisplay> | undefined;
  return { lines: display?.lines ?? [], containers: display?.containers ?? [], serials: display?.serials ?? [], kept: display?.kept ?? [] };
}
function comparison<F extends Record<string, string>>(baseline: BulkBaseline<F>): BulkContext {
  const { display: _display, ...context } = baseline.context; void _display;
  return { rows: baseline.rows.map(row => ({ id: row.id, fields: { ...row.fields } })), context };
}
function preview<F extends Record<string, string>>(data: BulkDraft<F>, baseline: BulkBaseline<F>) {
  const catalog = shipmentDisplayFromBaseline(baseline);
  const rows = composeRows({ serverRows: baseline.rows, toFields: r => r.fields, ...data });
  return rows.flatMap((row, i) => Object.entries(row).filter(([key]) => !["key", "isNew", "clientId"].includes(key)).map(([key, value]) => {
    let readable = String(value);
    if (key === "orderLineId") {
      const line = catalog.lines.find(l => l.id === value); readable = line ? `${line.partNumber} · ${line.partName}` : "Unavailable order line";
    }
    if (key === "orderContainerId") {
      // A kept row names no order container. It is found by the row's key, the shipment row's own id.
      const kept = isKeptContainer({ orderContainerId: String(value) }) ? catalog.kept.find(k => k.id === row.key) : undefined;
      const container = kept ?? catalog.containers.find(c => c.id === value);
      readable = container ? `${container.typeName}${container.customerContainerId ? ` · ${container.customerContainerId}` : ""}${kept ? " (kept)" : ""}` : "Unavailable container";
    }
    if (key === "orderSerialId") {
      const serial = catalog.serials.find(sr => sr.id === value); readable = serial ? `${serial.serial}${serial.description ? ` · ${serial.description}` : ""}` : "Unavailable serial";
    }
    // The stored flag is `lineComplete`; since 2026-10-06 it means a person closed the line short.
    const label = key === "lineComplete" ? "close short" : key.replace(/Id$/, "").replace(/([A-Z])/g, " $1").toLowerCase();
    return { label: `Row ${i + 1} ${label}`, value: readable };
  }));
}
type ValueCheck = (value: unknown) => boolean;
const textValue: ValueCheck = value => typeof value === "string";
const numberValue: ValueCheck = value => typeof value === "number" && Number.isFinite(value);
const booleanValue: ValueCheck = value => typeof value === "boolean";
const nullable = (check: ValueCheck): ValueCheck => value => value === null || check(value);
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function shape(value: unknown, fields: Record<string, ValueCheck>): value is Record<string, unknown> {
  return object(value) && Object.entries(fields).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]));
}
function rowsShape(value: unknown, fields: Record<string, ValueCheck>, id = "id"): boolean {
  return Array.isArray(value) && value.every(row => shape(row, fields))
    && new Set(value.map(row => row[id])).size === value.length;
}
const fieldNames = {
  lines: ["orderLineId", "qty", "weight", "lineComplete"],
  containers: ["orderContainerId", "count", "tareEach"],
  serials: ["orderSerialId", "printOnShipper"],
};
/** Generic BulkContext validity is not enough for domain consumers. This runs
 * only when the store accepts or transitions a draft, never while rendering it. */
function validShipment<F extends Record<string, string>>(kind: ShipmentGridKind, data: BulkDraft<F>, baseline: BulkBaseline<F>): boolean {
  const keys = fieldNames[kind];
  const writerFields = (value: unknown, partial: boolean) => object(value)
    && Object.keys(value).every(key => keys.includes(key) && typeof value[key] === "string")
    && (partial || keys.every(key => Object.hasOwn(value, key)));
  if (!baseline.rows.every(row => writerFields(row.fields, false))
    || ![...data.edits.values()].every(fields => writerFields(fields, true))
    || !data.added.every(row => { const { clientId: _clientId, ...fields } = row; void _clientId; return writerFields(fields, false); })) return false;
  const c = baseline.context;
  if (!shape(c, { shipperId: textValue, customerId: textValue, deletedAt: nullable(textValue),
    reversesShipperId: nullable(textValue), reversedByShipperNumber: nullable(numberValue),
    editable: booleanValue, catalogAuthorized: booleanValue })
    || !(c.order === null || shape(c.order, { id: textValue, orderId: textValue }))
    || !rowsShape(c.membership, { id: textValue, parentId: nullable(textValue) })
    || !object(c.display) || Object.keys(c.display).some(key => key !== kind && !(kind === "containers" && key === "kept"))) return false;
  if (kind === "lines") {
    return shape(c, { customerCreditHold: booleanValue, overrideCreditHold: booleanValue })
      && rowsShape(c.catalog, { id: textValue, qty: numberValue, weight: numberValue })
      && rowsShape(c.ordered, { id: textValue, orderedQty: numberValue, orderedWeight: numberValue, shippedToDateQty: numberValue, shippedToDateWeight: numberValue })
      && rowsShape(c.shipped, { orderLineId: textValue, shippedToDateQty: numberValue, shippedToDateWeight: numberValue }, "orderLineId")
      && rowsShape(c.display.lines, { id: textValue, partNumber: textValue, partName: textValue, qty: numberValue, weight: numberValue });
  }
  if (kind === "containers") return rowsShape(c.catalog, { id: textValue, count: numberValue })
    && rowsShape(c.display.containers, { id: textValue, typeName: textValue, customerContainerId: textValue, count: numberValue, tareEach: nullable(numberValue) })
    && rowsShape(c.display.kept, { id: textValue, typeName: textValue, customerContainerId: textValue, count: numberValue });
  return rowsShape(c.catalog, { id: textValue, lineId: textValue })
    && rowsShape(c.display.serials, { id: textValue, serial: textValue, description: textValue });
}
const customizations = {
  lines: { comparison, preview, valid: <F extends Record<string, string>>(data: BulkDraft<F>, baseline: BulkBaseline<F>) => validShipment("lines", data, baseline) },
  containers: { comparison, preview, valid: <F extends Record<string, string>>(data: BulkDraft<F>, baseline: BulkBaseline<F>) => validShipment("containers", data, baseline) },
  serials: { comparison, preview, valid: <F extends Record<string, string>>(data: BulkDraft<F>, baseline: BulkBaseline<F>) => validShipment("serials", data, baseline) },
};
export function shipmentBulkCustomization(kind: ShipmentGridKind): BulkRecoveryCustomization<ShipmentFields> { return customizations[kind]; }
type ShipmentFieldsByKind = { lines: LineFields; containers: ContainerFields; serials: SerialFields };
/** One `readShipmentCatalogs` per (snapshot object, order) for the grids that ask for it (#608): a
 *  shipment's three grids per order each read that order after every accept and on every mount.
 *  Keyed on the snapshot OBJECT, which the source makes once per dispatch and once per shared
 *  `read()` flight, so the acceptors of one dispatch, or the grids mounting at once, read an order
 *  once, and the next dispatch or a later read, a new object, reads it again. A WeakMap keeps no
 *  snapshot alive; nothing is cached past the snapshot that owns it. */
const catalogFlights = new WeakMap<object, Map<string, Promise<ShipmentBulkSnapshot>>>();
function sharedCatalogs(snapshot: BulkSourceSnapshot<ShipmentRecord, string[]>, childId: string): Promise<ShipmentBulkSnapshot> {
  let flights = catalogFlights.get(snapshot);
  if (!flights) { flights = new Map(); catalogFlights.set(snapshot, flights); }
  const held = flights.get(childId);
  if (held) return held;
  const flight = readShipmentCatalogs(snapshot, undefined, childId);
  flights.set(childId, flight);
  return flight;
}
export function shipmentBulkOptions<K extends ShipmentGridKind>(source: ShipmentBulkSource, shipperId: string, childId: string, kind: K): BulkRecoveryOptions<ShipmentFieldsByKind[K]> {
  type Fields = ShipmentFieldsByKind[K];
  const project = (s: ShipmentBulkSnapshot) => {
    // Each literal kind selects exactly its own field projection; TypeScript does
    // not narrow an indexed generic through this runtime discriminant.
    const baseline = (kind === "lines" ? shipmentLinesBaseline(s, childId) : kind === "containers" ? shipmentContainersBaseline(s, childId) : shipmentSerialsBaseline(s, childId)) as BulkBaseline<Fields>;
    return { baseline, editable: baseline.context.editable === true, recoveryAllowed: baseline.context.catalogAuthorized === true };
  };
  return {
    // The Containers grid's rows gained a field (tareEach), so its schema is v2.
    record: { kind: "shipment", id: shipperId }, kind: `shipment-${kind}`, schema: kind === "containers" ? "shipment-containers-v2" : `shipment-${kind}-v1`,
    label: kind[0].toUpperCase() + kind.slice(1), href: `/shipping/${shipperId}`, childId, scope: shipmentOrderScope(childId), source,
    customization: customizations[kind], read: async () => project(await sharedCatalogs(await source.read(), childId)),
    register: listener => source.register(() => {
      const accept = listener(); if (!accept) return null;
      return (snapshot, current) => {
        if (!snapshot) { accept(null); return; }
        void sharedCatalogs(snapshot, childId).then(fresh => { if (current()) accept(project(fresh)); }, () => { if (current()) accept(null); });
      };
    }),
  };
}
