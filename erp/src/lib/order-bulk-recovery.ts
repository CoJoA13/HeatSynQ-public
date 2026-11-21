import type { ContainerTypeOption, OrderDetail, OrderMutationResult } from "../app/orders/[id]/page";
import type { BulkBaseline, BulkContext } from "./bulk-grid-recovery";
import type { BulkRecoveryOptions } from "./bulk-grid";
import { tareEachText } from "./container-tare-prefill";
import { sessionReadAuthorization, shareInFlight, type ReadAuthorization } from "./inflight-share";

/** A container row as the grid's boxes hold it. `count` is how many containers, `pieces` the row's
 *  total, `tareEach` one empty container's weight, `scaleGross` the row on a scale. */
export type ContainerFields = { typeId: string; count: string; pieces: string; tareEach: string; scaleGross: string; customerContainerId: string };
export type ChargeFields = { description: string; amount: string };
export type LoadFields = { loadNumber: string; qty: string; weight: string };
export type SerialFields = { serial: string; description: string };
/** The catalog is typed as each container type's id and name, which is all a snapshot must carry.
 *  The type narrows nothing at run time: the page hands its pick-list rows whole. */
export type OrderBulkSnapshot = Readonly<{ order: OrderDetail; editable: boolean; containerTypes: readonly Pick<ContainerTypeOption, "id" | "name">[] }>;
export type OrderBulkProjection<F> = Readonly<{ baseline: BulkBaseline<F>; editable: boolean }>;
export const containerFields = (c: OrderDetail["containers"][number]): ContainerFields => ({
  typeId: c.typeId, count: String(c.count), pieces: c.pieces === null ? "" : String(c.pieces),
  // Written as the prefill rule writes a type's default ("42.5", never "42.50"). A type changed
  // and changed back must land on this exact text, or the row reads unsaved.
  tareEach: tareEachText(c.tareEach), scaleGross: c.scaleGross === null ? "" : String(c.scaleGross),
  customerContainerId: c.customerContainerId,
});
export const chargeFields = (c: OrderDetail["charges"][number]): ChargeFields => ({ description: c.description, amount: c.amount === null ? "" : String(c.amount) });
export const loadFields = (l: OrderDetail["loads"][number]): LoadFields => ({ loadNumber: String(l.loadNumber), qty: l.qty === null ? "" : String(l.qty), weight: l.weight === null ? "" : String(l.weight) });
export const serialFields = (s: OrderDetail["serials"][number]): SerialFields => ({ serial: s.serial, description: s.description });
function context(s: OrderBulkSnapshot): { readonly [key: string]: BulkContext } {
  return { orderId: s.order.id, status: s.order.status, voided: s.order.voided, editable: s.editable && !s.order.voided };
}
function project<F>(s: OrderBulkSnapshot, rows: readonly { id: string; fields: F }[], extra: { readonly [key: string]: BulkContext } = {}): OrderBulkProjection<F> {
  return { baseline: { rows, context: { ...context(s), ...extra } }, editable: s.editable && !s.order.voided };
}
export function projectContainers(s: OrderBulkSnapshot): OrderBulkProjection<ContainerFields> {
  return project(s, s.order.containers.map(r => ({ id: r.id, fields: containerFields(r) })), {
    // A type goes into the recovery context as its id and name and nothing else. Its default tare
    // each is left out on purpose: an edited default must not read as a changed record and set a
    // Containers draft aside.
    containerTypes: s.containerTypes.map(t => ({ id: t.id, name: t.name })).sort((a, b) => a.id.localeCompare(b.id)),
  });
}
export function projectCharges(s: OrderBulkSnapshot): OrderBulkProjection<ChargeFields> {
  return project(s, s.order.charges.map(r => ({ id: r.id, fields: chargeFields(r) })));
}
export function projectLoads(s: OrderBulkSnapshot): OrderBulkProjection<LoadFields> {
  return project(s, s.order.loads.map(r => ({ id: r.id, fields: loadFields(r) })), {
    travelerPrinted: s.order.travelerPrinted,
    lines: s.order.lines.map(l => ({ id: l.id, position: l.position, partId: l.partId, qty: l.qty, weight: l.weight })),
  });
}
export function projectSerials(s: OrderBulkSnapshot, lineId: string): OrderBulkProjection<SerialFields> {
  const line = s.order.lines.find(l => l.id === lineId);
  const result = project(s, s.order.serials.filter(r => r.lineId === lineId).map(r => ({ id: r.id, fields: serialFields(r) })), {
    line: line ? { id: line.id, partId: line.partId, partIdentity: line.part.id, revisionNumber: line.revisionNumber,
      serializationRequired: line.part.serializationRequired } : null,
  });
  return { ...result, editable: result.editable && !!line };
}
export function orderBulkOptions<F>(source: OrderBulkSource, orderId: string, kind: string, label: string,
  projection: (snapshot: OrderBulkSnapshot) => OrderBulkProjection<F>, childId?: string, scope?: string,
): BulkRecoveryOptions<F> {
  return {
    record: { kind: "order", id: orderId }, kind, schema: kind === "order-containers" ? "order-containers-v2" : kind + "-v1", label, childId, scope, source,
    ...(kind === "order-serials" ? { rangeInput: "" } : {}),
    read: async () => projection(await source.read()),
    register: listener => source.register(() => {
      const accept = listener(); return accept ? snapshot => accept(snapshot ? projection(snapshot) : null) : null;
    }),
  };
}
/** Acknowledgement supplies returned rows and writer context, while the follow-up
 * GET separately reauthorizes access and catalogs. It is not a recovery read. */
export function orderAckSnapshot<F>(response: OrderMutationResult, baseline: BulkBaseline<F>): OrderBulkSnapshot {
  const ids = baseline.context.containerTypes;
  return { order: response, editable: baseline.context.editable === true,
    containerTypes: Array.isArray(ids) ? ids.flatMap(value => {
      if (value && typeof value === "object" && !Array.isArray(value) && "id" in value && "name" in value
        && typeof value.id === "string" && typeof value.name === "string") return [{ id: value.id, name: value.name }];
      return [];
    }) : [] };
}

export type OrderBulkSource = ReturnType<typeof createOrderBulkSource>;
/** Local coordinator holds callbacks only while their committed view is attached.
 * All callbacks and auxiliary reads are captured BEFORE the parent dispatch.
 * The transport is injected by the page, keeping lifecycle tests independent.
 * `read()` is one flight for every grid that asks while it is out under one read authorization
 * (#608; `shareInFlight`): nothing is kept past the flight, and a grid reading later reads again. */
export function createOrderBulkSource(
  readOrder: () => Promise<OrderDetail>,
  readAccess: () => Promise<{ editable: boolean; containerTypes: OrderBulkSnapshot["containerTypes"] }>,
  auth: ReadAuthorization = sessionReadAuthorization(),
) {
  const listeners = new Set<() => ((snapshot: OrderBulkSnapshot | null) => void) | null>();
  let sequence = 0;
  let acceptedSequence = 0;
  const shared = shareInFlight(auth, async (): Promise<OrderBulkSnapshot> => {
    const [order, access] = await Promise.all([readOrder(), readAccess()]);
    return { order, ...access };
  });
  return {
    register(listener: () => ((snapshot: OrderBulkSnapshot | null) => void) | null) {
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
    read: shared.read,
    begin() {
      // A mutation boundary: a read asked for from here on must not join a pre-save flight, and
      // a flight begun while the save was out is retired again at settlement (`accept`,
      // `unavailable`), so the post-save refresh never joins a during-save read either.
      shared.retire();
      const ticket = ++sequence;
      const acceptors = [...listeners].flatMap(listener => { const accept = listener(); return accept ? [accept] : []; });
      // Handle failure immediately; an early rejected auxiliary read must not
      // become an unhandled rejection while the parent mutation is pending.
      const access = acceptors.length ? readAccess().catch(() => null) : Promise.resolve(null);
      return {
        async accept(order: OrderDetail) {
          shared.retire(); // settlement: no refresh from here on joins a during-save flight
          // Called only after the parent newest-applied gate accepts. Record
          // that frontier before awaiting access so an older auxiliary result
          // cannot overwrite a newer payload already displayed by the page.
          if (ticket <= acceptedSequence) return;
          acceptedSequence = ticket;
          const freshAccess = await access;
          if (ticket !== acceptedSequence) return;
          const snapshot = freshAccess ? { order, ...freshAccess } : null; // one object per dispatch
          for (const accept of acceptors) accept(snapshot);
        },
        unavailable() {
          shared.retire();
          if (ticket <= acceptedSequence) return;
          acceptedSequence = ticket;
          for (const accept of acceptors) accept(null);
        },
      };
    },
  };
}
