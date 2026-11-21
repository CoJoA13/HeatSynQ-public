// Browser-owned raw creation intent and pure recovery transitions. No server state is persisted here.
import type { Adapter, Access, Draft, EditorBinding, EditorView, Stamp, Submission } from "./draft-store";
import { ApiError } from "./fetcher";
import { shipRemainder } from "./ship-remainder";
import { rowFinishesLine } from "./line-completion";
import { submitWithConflictRetry, V4_UUID } from "./idempotent-save";
import { prefillContainerRow, tareEachForSave } from "./shipment-container-rows";
import { decimalRefusal } from "./decimal-entry";
import { FREIGHT_AMOUNT, SHIPMENT_TARE_EACH, SHIP_NOW_NET_WEIGHT } from "./shipment-boxes";
import { SHIPMENT_BOX, shipmentContainerBoxId, shipmentLineBoxId } from "./shipment-box-ids";
import type { FreightTermsValue } from "./cert-constants";
import type { LineRow, ContainerRow, SerialRow } from "../app/shipping/ShipmentGrids";
export type ShipmentSeed = Readonly<{ clientRequestId: string; defaultShipDate: string; defaultFreightTerms: FreightTermsValue }>;
export type NewShipmentOrderDraft = Readonly<{ orderId: string; lines: readonly Readonly<LineRow>[]; containers: readonly Readonly<ContainerRow>[]; serials: readonly Readonly<SerialRow>[] }>;
export type NewShipmentDraft = ShipmentSeed & Readonly<{
  customerId: string; shipToAddressId: string; shipDate: string; carrierId: string; route: string; comments: string;
  billFreight: boolean; freightAmount: string; freightTerms: FreightTermsValue; freightClass: string; freightDescription: string;
  packageCount: string; proNumber: string; scacCode: string; creditHoldReason: string; selected: readonly NewShipmentOrderDraft[];
}>;
export type ShipmentCreationReceipt = Readonly<{ id: string; shipperNumber: number; warnings: readonly string[] }>;
export type ShipmentCreateResult = Readonly<{ shipper: { id: string; shipperNumber: number }; warnings: readonly string[]; deduped?: boolean }>;
export type ShipmentOrderSource = Readonly<{
  id: string; customerId: string; orderNumber: number; poNumber: string; customerJobNo: string; status: string; voided: boolean;
  lines: readonly { id: string; position: number; qty: number; weight: number; part: { partNumber: string; name: string; eachWeight?: number } }[];
  containers: readonly { id: string; count: number; customerContainerId: string; tareEach?: number | null; type: { name: string } }[];
  serials: readonly { id: string; lineId: string; serial: string; description: string }[];
  orderLineShippedToDate: readonly { orderLineId: string; shippedToDateQty: number; shippedToDateWeight: number }[];
}>;
export type NewShipmentSource = Readonly<{
  permissions: readonly string[];
  customer: { id: string; code: string; name: string; creditHold: boolean; shippingNotes?: string } | null;
  addresses: readonly { id: string; kind: string; name: string; street?: string; city?: string; state?: string; zip?: string }[];
  carriers: readonly { id: string; name: string }[];
  orders: readonly ShipmentOrderSource[];
}>;
export type NewShipmentBaseline =
  | Readonly<{ kind: "form"; source: NewShipmentSource }>
  | Readonly<{ kind: "completed"; permissions: readonly string[]; created: { id: string; shipperNumber: number }; readableCopies: readonly Stamp[] }>;
export type ShipmentDependency = Readonly<{ stamp?: Stamp; customerId: string; shipToAddressId: string; carrierId: string; orderIds: readonly string[] }>;
export type NewShipmentReadRequirements = Readonly<{ seed?: ShipmentSeed; current?: ShipmentDependency; reference?: ShipmentDependency; submitted?: ShipmentDependency; createdId?: string }>;
export type ShipmentBody = Readonly<{
  clientRequestId: string; customerId: string; shipToAddressId: string | null; shipDate: string; carrierId: string | null;
  route: string; comments: string; billFreight: boolean; freightAmount?: string; freightTerms: FreightTermsValue; freightClass: string;
  freightDescription: string; packageCount?: number; proNumber: string; scacCode: string; creditHoldReason?: string;
  orders: readonly { orderId: string; lines: readonly { orderLineId: string; qty: number; weight: string; lineComplete: boolean }[];
    containers: readonly { orderContainerId: string; count: number; tareEach: string | null }[]; serials: readonly { orderSerialId: string; printOnShipper: boolean }[] }[];
}>;
export type NewShipmentBinding = EditorBinding<NewShipmentDraft, NewShipmentBaseline, ShipmentBody, ShipmentCreateResult, ShipmentCreationReceipt, NewShipmentReadRequirements>;
/** `fieldIds`: the box each refusal names, in the banner's order, for the jump to the first and the
 *  `aria-invalid` marks (ruling R13); a refusal that names no box adds none. */
export type PreparedShipment = { kind: "empty" } | { kind: "invalid"; error: string; fieldIds: string[] } | { kind: "ready"; submission: Submission<NewShipmentDraft, NewShipmentBaseline, ShipmentBody> };
export type NewShipmentRead = { kind: "unavailable" } | { kind: "authorized"; baseline: NewShipmentBaseline; editable: boolean; recoveryAllowed?: boolean };
export function newShipmentDraftFrom(seed: ShipmentSeed): NewShipmentDraft {
  return { ...seed, customerId: "", shipToAddressId: "", shipDate: seed.defaultShipDate, carrierId: "", route: "", comments: "", billFreight: false,
    freightAmount: "", freightTerms: seed.defaultFreightTerms, freightClass: "", freightDescription: "", packageCount: "", proNumber: "", scacCode: "", creditHoldReason: "", selected: [] };
}
export function newShipmentBaselineFrom(source: NewShipmentSource): NewShipmentBaseline {
  // Select and copy runtime DTO fields explicitly: a TypeScript annotation does
  // not remove unrelated endpoint data or detach nested response references.
  return { kind: "form", source: {
    permissions: [...source.permissions],
    customer: source.customer && { id: source.customer.id, code: source.customer.code, name: source.customer.name,
      creditHold: source.customer.creditHold, ...(source.customer.shippingNotes === undefined ? {} : { shippingNotes: source.customer.shippingNotes }) },
    addresses: source.addresses.map(a => ({ id: a.id, kind: a.kind, name: a.name,
      ...(a.street === undefined ? {} : { street: a.street }), ...(a.city === undefined ? {} : { city: a.city }),
      ...(a.state === undefined ? {} : { state: a.state }), ...(a.zip === undefined ? {} : { zip: a.zip }) })),
    carriers: source.carriers.map(c => ({ id: c.id, name: c.name })),
    orders: source.orders.map(o => ({ id: o.id, customerId: o.customerId, orderNumber: o.orderNumber, poNumber: o.poNumber,
      customerJobNo: o.customerJobNo, status: o.status, voided: o.voided,
      // Each weight is display data for the offered ship-now weight. `writer()` leaves it out.
      lines: o.lines.map(l => ({ id: l.id, position: l.position, qty: l.qty, weight: l.weight, part: { partNumber: l.part.partNumber, name: l.part.name,
        ...(typeof l.part.eachWeight === "number" ? { eachWeight: l.part.eachWeight } : {}) } })),
      // A container row's tare each is display data: what its row takes when it is added. `writer()` leaves it out.
      containers: o.containers.map(c => ({ id: c.id, count: c.count, customerContainerId: c.customerContainerId, type: { name: c.type.name },
        ...(typeof c.tareEach === "number" ? { tareEach: c.tareEach } : {}) })),
      serials: o.serials.map(s => ({ id: s.id, lineId: s.lineId, serial: s.serial, description: s.description })),
      orderLineShippedToDate: o.orderLineShippedToDate.map(l => ({ orderLineId: l.orderLineId, shippedToDateQty: l.shippedToDateQty, shippedToDateWeight: l.shippedToDateWeight })),
    })),
  } };
}
const strings = ["clientRequestId", "defaultShipDate", "defaultFreightTerms", "customerId", "shipToAddressId", "shipDate", "carrierId", "route", "comments", "freightAmount", "freightTerms", "freightClass", "freightDescription", "packageCount", "proNumber", "scacCode", "creditHoldReason"] as const;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
function validSource(value: unknown): value is NewShipmentSource {
  if (!object(value) || !Array.isArray(value.permissions) || !value.permissions.every(p => typeof p === "string")
    || !Array.isArray(value.addresses) || !Array.isArray(value.carriers) || !Array.isArray(value.orders)) return false;
  if (value.customer !== null && (!object(value.customer) || typeof value.customer.id !== "string" || typeof value.customer.code !== "string" || typeof value.customer.name !== "string"
    || (value.customer.shippingNotes !== undefined && typeof value.customer.shippingNotes !== "string") || typeof value.customer.creditHold !== "boolean")) return false;
  return value.addresses.every(a => object(a) && typeof a.id === "string" && typeof a.kind === "string" && typeof a.name === "string" && ["street", "city", "state", "zip"].every(k => a[k] === undefined || typeof a[k] === "string"))
    && value.carriers.every(c => object(c) && typeof c.id === "string" && typeof c.name === "string")
    && value.orders.every(o => object(o) && typeof o.id === "string" && typeof o.customerId === "string" && typeof o.status === "string" && Number.isFinite(o.orderNumber) && typeof o.poNumber === "string" && typeof o.customerJobNo === "string"
      && typeof o.voided === "boolean" && Array.isArray(o.lines) && Array.isArray(o.containers) && Array.isArray(o.serials)
      && Array.isArray(o.orderLineShippedToDate)
      && o.lines.every(l => object(l) && typeof l.id === "string" && Number.isFinite(l.position) && Number.isFinite(l.qty) && Number.isFinite(l.weight) && object(l.part) && typeof l.part.partNumber === "string" && typeof l.part.name === "string"
        && (l.part.eachWeight === undefined || Number.isFinite(l.part.eachWeight)))
      && o.containers.every(c => object(c) && typeof c.id === "string" && Number.isFinite(c.count) && typeof c.customerContainerId === "string" && object(c.type) && typeof c.type.name === "string"
        && (c.tareEach === undefined || c.tareEach === null || Number.isFinite(c.tareEach)))
      && o.serials.every(s => object(s) && typeof s.id === "string" && typeof s.lineId === "string" && typeof s.serial === "string" && typeof s.description === "string")
      && o.orderLineShippedToDate.every(l => object(l) && typeof l.orderLineId === "string" && Number.isFinite(l.shippedToDateQty) && Number.isFinite(l.shippedToDateWeight)));
}
function valid(data: unknown, baseline: unknown): boolean {
  if (!object(data) || !strings.every(k => typeof data[k] === "string") || !V4_UUID.test(data.clientRequestId as string)
    || typeof data.billFreight !== "boolean" || !Array.isArray(data.selected) || !object(baseline)) return false;
  const rows = (value: unknown, fields: readonly string[]) => Array.isArray(value) && value.every(row => object(row)
    && typeof row.key === "string" && typeof row.isNew === "boolean" && fields.every(k => typeof row[k] === "string"));
  if (!data.selected.every(o => object(o) && typeof o.orderId === "string"
    && rows(o.lines, ["orderLineId", "qty", "weight", "lineComplete"])
    && rows(o.containers, ["orderContainerId", "count", "tareEach"]) && rows(o.serials, ["orderSerialId", "printOnShipper"]))) return false;
  return baseline.kind === "form" ? validSource(baseline.source) : baseline.kind === "completed"
    && object(baseline.created) && typeof baseline.created.id === "string" && typeof baseline.created.shipperNumber === "number"
    && Array.isArray(baseline.permissions) && Array.isArray(baseline.readableCopies);
}
function writer(b: NewShipmentBaseline) {
  if (b.kind !== "form") return b;
  const s = b.source;
  return { permissions: [...s.permissions].sort(), customer: s.customer && { id: s.customer.id, creditHold: s.customer.creditHold },
    addresses: s.addresses.map(a => ({ id: a.id, kind: a.kind })), carriers: s.carriers.map(c => c.id),
    orders: s.orders.map(o => ({ id: o.id, customerId: o.customerId, status: o.status, voided: o.voided,
      lines: o.lines.map(l => ({ id: l.id, position: l.position, qty: l.qty, weight: l.weight })),
      containers: o.containers.map(c => ({ id: c.id, count: c.count, customerContainerId: c.customerContainerId })),
      serials: o.serials.map(s => ({ id: s.id, lineId: s.lineId })), ledger: o.orderLineShippedToDate })) };
}
const dependency = (d: Draft<NewShipmentDraft, NewShipmentBaseline>): ShipmentDependency => ({ stamp: d.stamp,
  customerId: d.data.customerId, shipToAddressId: d.data.shipToAddressId, carrierId: d.data.carrierId, orderIds: d.data.selected.map(o => o.orderId) });
const seedFrom = (d: NewShipmentDraft): ShipmentSeed => ({ clientRequestId: d.clientRequestId, defaultShipDate: d.defaultShipDate, defaultFreightTerms: d.defaultFreightTerms });
export const newShipmentRecoveryAdapter: Adapter<NewShipmentDraft, NewShipmentBaseline, ShipmentBody, ShipmentCreateResult, ShipmentCreationReceipt, NewShipmentReadRequirements> = {
  kind: "new-shipment", schema: "new-shipment-v2", allowUnknownRetry: true, allowEditRead: true, reinitializeAfterDiscard: true, valid,
  dirty: d => d.selected.length > 0 || d.shipToAddressId !== "" || d.carrierId !== "" || d.shipDate !== d.defaultShipDate || d.billFreight
    || d.freightTerms !== d.defaultFreightTerms || [d.route, d.comments, d.freightAmount, d.freightClass, d.freightDescription, d.packageCount, d.proNumber, d.scacCode, d.creditHoldReason].some(v => v.trim() !== ""),
  // The same object after a plain read: equal by definition, without writing out every order (#703).
  baselineEqual: (a, b) => a === b || JSON.stringify(writer(a)) === JSON.stringify(writer(b)),
  preview: (d, b) => {
    const source = b.kind === "form" ? b.source : undefined;
    const fields: readonly [string, string][] = [["Customer", source?.customer ? `${source.customer.code} · ${source.customer.name}` : d.customerId],
      ["Ship-to address", source?.addresses.find(a => a.id === d.shipToAddressId)?.name ?? d.shipToAddressId], ["Ship date", d.shipDate],
      ["Carrier", source?.carriers.find(c => c.id === d.carrierId)?.name ?? d.carrierId], ["Route", d.route], ["Comments", d.comments],
      ["Bill freight", d.billFreight ? "Yes" : "No"], ["Freight amount", d.freightAmount], ["Freight terms", d.freightTerms],
      ["Freight class", d.freightClass], ["Freight description", d.freightDescription], ["Package count", d.packageCount],
      ["Pro no", d.proNumber], ["SCAC", d.scacCode], ["Credit hold override reason", d.creditHoldReason]];
    return [...fields.map(([label, value]) => ({ label, value })), ...d.selected.flatMap(o => {
      const order = source?.orders.find(s => s.id === o.orderId); const label = `Order #${order?.orderNumber ?? o.orderId}`;
      return [...o.lines.flatMap((r, i) => [
        { label: `${label} line ${i + 1} quantity`, value: r.qty }, { label: `${label} line ${i + 1} weight`, value: r.weight },
        { label: `${label} line ${i + 1} close short`, value: r.lineComplete }]),
        ...o.containers.flatMap((r, i) => [
          { label: `${label} container ${i + 1} count`, value: r.count }, { label: `${label} container ${i + 1} tare each`, value: r.tareEach }]),
        ...o.serials.map((r, i) => ({ label: `${label} serial ${order?.serials.find(s => s.id === r.orderSerialId)?.serial ?? i + 1}: print on shipper`, value: r.printOnShipper }))];
    })];
  },
  readRequirements: copies => {
    const d = copies.current?.data ?? copies.reference?.data ?? copies.submitted?.data ?? copies.clean;
    return { ...(d ? { seed: seedFrom(d) } : {}), ...(copies.current ? { current: dependency(copies.current) } : {}),
      ...(copies.reference ? { reference: dependency(copies.reference) } : {}), ...(copies.submitted ? { submitted: dependency(copies.submitted) } : {}),
      ...(copies.completed ? { createdId: copies.completed.id } : {}) };
  },
  reconcileRead: ({ current, fresh }) => ({ data: current.data, baseline: fresh }),
  settle: ({ current, submission, outcome }) => outcome.kind === "persisted"
    ? { kind: "retire", completed: { id: outcome.response.shipper.id, shipperNumber: outcome.response.shipper.shipperNumber, warnings: [...outcome.response.warnings] },
      ...(JSON.stringify(current.data) !== JSON.stringify(submission.submitted.data) ? { reference: { data: current.data, baseline: current.baseline } } : {}) }
    : { kind: "keep", data: current.data, baseline: current.baseline, needsRefresh: outcome.kind === "unknown" },
};
export function resetNewShipmentCustomer(data: NewShipmentDraft, customerId: string): NewShipmentDraft {
  return { ...data, customerId, shipToAddressId: "", creditHoldReason: "", selected: [] };
}
export function removeNewShipmentOrder(data: NewShipmentDraft, orderId: string): NewShipmentDraft { return { ...data, selected: data.selected.filter(o => o.orderId !== orderId) }; }
/** Every problem the form has, in the order the screen is read (customer, orders, ship date, then per
 *  order each line's quantity and Ship now net weight and each container's count and Tare each, the
 *  lines check, package count, Freight amount, credit hold), or an empty list. A check that rests on
 *  an earlier one is skipped when that one failed: no customer, no "add an order"; the "at least one
 *  line" check reads the quantities, so it waits for them all to be whole numbers. A decimal box is
 *  read through the one rule (`decimalRefusal`) and named with its order first, as the banner is the
 *  only place it shows; the other rows keep their words, so one list holds both forms. Each problem
 *  names the box it is about (`shipment-box-ids.ts`), or none: the credit-hold permission refusal
 *  names no box, and "at least one line" names the first line's quantity box. */
function validate(d: NewShipmentDraft, s: NewShipmentSource): { message: string; fieldId: string | null }[] {
  const problems: { message: string; fieldId: string | null }[] = [];
  const problem = (message: string, fieldId: string | null) => { problems.push({ message, fieldId }); };
  if (!d.customerId) problem("Pick a customer.", SHIPMENT_BOX.customer);
  else if (!d.selected.length) problem("Add at least one order.", SHIPMENT_BOX.addOrder);
  if (!d.shipDate) problem("Enter a ship date.", SHIPMENT_BOX.shipDate);
  let quantitiesRead = true;
  for (const o of d.selected) {
    const number = s.orders.find(x => x.id === o.orderId)?.orderNumber ?? o.orderId;
    for (const [i, row] of o.lines.entries()) {
      if (!Number.isInteger(Number(row.qty)) || Number(row.qty) < 0) {
        quantitiesRead = false;
        problem(`Order #${number} line ${i + 1}: ship-now quantity must be a whole number of at least 0.`, shipmentLineBoxId(o.orderId, i, "qty"));
      }
      const weight = decimalRefusal(`Order #${number}, Line ${i + 1}, ${SHIP_NOW_NET_WEIGHT.label}`, row.weight, SHIP_NOW_NET_WEIGHT.box, { required: true });
      if (weight !== null) problem(weight, shipmentLineBoxId(o.orderId, i, "weight"));
    }
    for (const [i, row] of o.containers.entries()) {
      if (!Number.isInteger(Number(row.count)) || Number(row.count) < 1) problem(`Order #${number} container ${i + 1}: containers must be a whole number of at least 1.`, shipmentContainerBoxId(o.orderId, i, "count"));
      const tare = decimalRefusal(`Order #${number}, Container ${i + 1}, ${SHIPMENT_TARE_EACH.label}`, row.tareEach, SHIPMENT_TARE_EACH.box);
      if (tare !== null) problem(tare, shipmentContainerBoxId(o.orderId, i, "tareEach"));
    }
  }
  if (d.selected.length > 0 && quantitiesRead && !d.selected.some(o => o.lines.some(r => Number(r.qty) > 0))) {
    const first = d.selected.find(o => o.lines.length > 0);
    problem("A shipment needs at least one line with a positive quantity.", first ? shipmentLineBoxId(first.orderId, 0, "qty") : null);
  }
  if (d.packageCount.trim() !== "" && (!Number.isInteger(Number(d.packageCount)) || Number(d.packageCount) < 0)) problem("Package count must be a whole number of at least 0.", SHIPMENT_BOX.packageCount);
  const freight = decimalRefusal(FREIGHT_AMOUNT.label, d.freightAmount, FREIGHT_AMOUNT.box);
  if (freight !== null) problem(freight, SHIPMENT_BOX.freightAmount);
  if (s.customer?.creditHold && !s.permissions.includes("action.override_credit_hold")) problem("Saving requires the override_credit_hold action.", null);
  else if (s.customer?.creditHold && !d.creditHoldReason.trim()) problem("A reason is required to override the credit hold.", SHIPMENT_BOX.creditHoldReason);
  return problems;
}
/** A row that finishes its line by quantity is sent unticked: the close-short flag only means
 *  something on a line that ships short. A new shipment has no saved quantity of its own. */
function completesLine(order: ShipmentOrderSource | undefined, r: Readonly<LineRow>): boolean {
  return rowFinishesLine(r, order?.lines.find(l => l.id === r.orderLineId)?.qty,
    order?.orderLineShippedToDate.find(s => s.orderLineId === r.orderLineId)?.shippedToDateQty, 0);
}
export function prepareNewShipmentSave(binding: NewShipmentBinding, requestId: string): PreparedShipment {
  const v = binding.getSnapshot(); const d = v.current?.data; const b = v.current?.baseline;
  if (v.mode !== "editing" || !d || b?.kind !== "form" || !b.source.permissions.includes("shipping.create")) return { kind: "empty" };
  const problems = validate(d, b.source);
  if (problems.length > 0) return { kind: "invalid", error: problems.map(p => p.message).join("\n"),
    fieldIds: problems.flatMap(p => p.fieldId === null ? [] : [p.fieldId]) };
  const payload: ShipmentBody = { clientRequestId: d.clientRequestId, customerId: d.customerId, shipToAddressId: d.shipToAddressId || null,
    shipDate: d.shipDate, carrierId: d.carrierId || null, route: d.route, comments: d.comments, billFreight: d.billFreight,
    freightAmount: d.freightAmount.trim() === "" ? undefined : d.freightAmount.trim(), freightTerms: d.freightTerms, freightClass: d.freightClass,
    freightDescription: d.freightDescription, packageCount: d.packageCount.trim() === "" ? undefined : Number(d.packageCount), proNumber: d.proNumber, scacCode: d.scacCode,
    ...(b.source.customer?.creditHold && d.creditHoldReason.trim() ? { creditHoldReason: d.creditHoldReason.trim() } : {}),
    orders: d.selected.map(o => ({ orderId: o.orderId, lines: o.lines.map(r => ({ orderLineId: r.orderLineId, qty: Number(r.qty), weight: r.weight.trim(),
        lineComplete: r.lineComplete === "true" && !completesLine(b.source.orders.find(s => s.id === o.orderId), r) })),
      containers: o.containers.map(r => ({ orderContainerId: r.orderContainerId, count: Number(r.count), tareEach: tareEachForSave(r.tareEach) })), serials: o.serials.map(r => ({ orderSerialId: r.orderSerialId, printOnShipper: r.printOnShipper === "true" })) })) };
  return { kind: "ready", submission: binding.capture(payload, requestId) };
}
type SaveArgs = { binding: NewShipmentBinding; requestId: string; write: (body: ShipmentBody) => Promise<ShipmentCreateResult>; persisted: (response: ShipmentCreateResult) => void | Promise<void> };
async function submit(args: SaveArgs, submission: Submission<NewShipmentDraft, NewShipmentBaseline, ShipmentBody>) {
  if (!args.binding.dispatched(submission)) return { kind: "stale" };
  let acknowledged = false;
  try {
    const response = await submitWithConflictRetry(submission.payload, async body => {
      const response = await args.write(body); acknowledged = true;
      args.binding.settle(submission, { kind: "persisted", response }); return response;
    });
    await args.persisted(response); return { kind: "persisted" };
  } catch (error) {
    if (!acknowledged) args.binding.settle(submission, { kind: error instanceof ApiError && error.status < 500 ? "rejected" : "unknown" });
    return { kind: acknowledged ? "persisted" : "error", error };
  }
}
export async function runNewShipmentSave(args: SaveArgs) {
  const prepared = prepareNewShipmentSave(args.binding, args.requestId);
  return prepared.kind === "ready" ? submit(args, prepared.submission) : prepared;
}
export async function runNewShipmentRetry(args: SaveArgs & { stamp: Stamp; readId: number }) {
  const submission = args.binding.prepareUnknownRetry(args.stamp, args.readId, args.requestId);
  return submission ? submit(args, submission) : { kind: "stale" };
}
export async function runNewShipmentRead(args: { binding: NewShipmentBinding; authorized: () => boolean;
  read: (requirements: NewShipmentReadRequirements) => Promise<NewShipmentRead>; initialize: (seed: ShipmentSeed | undefined) => NewShipmentDraft;
}): Promise<{ kind: string; readId?: number }> {
  let id = args.binding.beginRead();
  for (let attempt = 0; attempt < 2; attempt++) {
    const q = args.binding.readRequirements(id); if (!q || !args.authorized()) return { kind: "stale" };
    let result: NewShipmentRead;
    try { result = await args.read(q); } catch { result = { kind: "unavailable" }; }
    if (!args.authorized()) return { kind: "stale" };
    if (args.binding.acceptRead({ ...result, readId: id }, () => args.initialize(q.seed))) return { kind: result.kind, readId: id };
    if (attempt) break;
    const replacement = args.binding.restartReadAfterChange(id); if (replacement === null) break; id = replacement;
  }
  return { kind: "stale" };
}
async function readSource(q: ShipmentDependency | undefined, permissions: readonly string[], read: (path: string) => Promise<unknown>): Promise<NewShipmentSource> {
  if (!permissions.includes("shipping.create") || !permissions.includes("customers.view") || !permissions.includes("orders.view")) throw new Error("Shipment creation access is unavailable.");
  const customerId = q?.customerId ?? "";
  const [customer, addresses, carriers, orders] = await Promise.all([
    customerId ? read(`/api/customers/${encodeURIComponent(customerId)}`) : null,
    customerId ? read(`/api/customers/${encodeURIComponent(customerId)}/addresses`) : [],
    read("/api/picklists/carrier"), Promise.all((q?.orderIds ?? []).map(id => read(`/api/orders/${encodeURIComponent(id)}`))),
  ]);
  const source: unknown = { permissions, customer, addresses: Array.isArray(addresses) ? addresses.filter(a => object(a) && a.kind === "SHIP_TO") : addresses, carriers, orders };
  if (!validSource(source) || source.customer?.id !== (customerId || undefined)
    || (q?.shipToAddressId && !source.addresses.some(a => a.id === q.shipToAddressId))
    || (q?.carrierId && !source.carriers.some(c => c.id === q.carrierId))
    || source.orders.some((o, i) => o.id !== q?.orderIds[i] || o.customerId !== customerId || o.voided)) throw new Error("Shipment context is unavailable.");
  return source;
}
export async function readNewShipmentAccess(q: NewShipmentReadRequirements, permissions: readonly string[], read: (path: string) => Promise<unknown>): Promise<NewShipmentRead> {
  try {
    if (q.createdId) {
      if (!permissions.includes("shipping.view")) return { kind: "unavailable" };
      const response = await read(`/api/shippers/${encodeURIComponent(q.createdId)}`);
      if (!object(response) || !object(response.shipper) || response.shipper.id !== q.createdId || typeof response.shipper.shipperNumber !== "number" || response.shipper.deletedAt) return { kind: "unavailable" };
      const readableCopies: Stamp[] = [];
      for (const copy of [q.current, q.reference, q.submitted]) if (copy?.stamp) {
        try { await readSource(copy, permissions, read); readableCopies.push(copy.stamp); } catch { /* Receipt permission does not grant old input access. */ }
      }
      return { kind: "authorized", editable: false, baseline: { kind: "completed", permissions, created: { id: q.createdId, shipperNumber: response.shipper.shipperNumber }, readableCopies } };
    }
    const source = await readSource(q.current ?? q.reference ?? q.submitted, permissions, read);
    // Reference and submitted dependencies must also be readable before generic previews appear.
    for (const copy of [q.reference, q.submitted]) if (copy) await readSource(copy, permissions, read);
    return { kind: "authorized", editable: true, baseline: newShipmentBaselineFrom(source) };
  } catch { return { kind: "unavailable" }; }
}
export function newShipmentRecoveryPreviews(view: EditorView<NewShipmentDraft, NewShipmentBaseline, ShipmentCreationReceipt>) {
  const b = ["loading", "unavailable", "error"].includes(view.mode) ? undefined : view.savedBaseline;
  const preview = (d: Draft<NewShipmentDraft, NewShipmentBaseline> | undefined) => d && b
    && (b.kind === "form" || b.readableCopies.some(s => s.generation === d.stamp.generation && s.version === d.stamp.version && JSON.stringify(s.key) === JSON.stringify(d.stamp.key)))
    ? newShipmentRecoveryAdapter.preview(d.data, d.baseline) : undefined;
  return { currentPreview: preview(view.current), referencePreview: preview(view.reference), submittedPreview: preview(view.submitted) };
}
export type ShipmentReadAccess = Access<NewShipmentBaseline>;
export type ShipmentDraftCopy = Draft<NewShipmentDraft, NewShipmentBaseline>;
export type ShipmentCommandArgs = { binding: NewShipmentBinding; accepted?: (readId: number) => void; authorized: () => boolean; read: (requirements: NewShipmentReadRequirements) => Promise<NewShipmentRead> };
export async function runNewShipmentCustomer(args: ShipmentCommandArgs & { customerId: string }): Promise<boolean> {
  const before = args.binding.getSnapshot().current;
  if (!before || before.data.customerId === args.customerId) return false;
  const id = args.binding.beginEditRead(); if (id === null || !args.authorized()) return false;
  const previousCustomerId = before.data.customerId;
  if (args.customerId === "" && before.baseline.kind === "form") {
    const baseline = newShipmentBaselineFrom({ ...before.baseline.source, customer: null, addresses: [], orders: [] });
    const applied = args.binding.acceptEditRead({ kind: "authorized", readId: id, baseline, editable: true }, current => resetNewShipmentCustomer(current.data, ""));
    if (applied) args.accepted?.(id); return applied;
  }
  const q: NewShipmentReadRequirements = { seed: seedFrom(before.data), current: { customerId: args.customerId, shipToAddressId: "", carrierId: before.data.carrierId, orderIds: [] } };
  let result: NewShipmentRead;
  try { result = await args.read(q); } catch { result = { kind: "unavailable" }; }
  if (!args.authorized()) return false;
  const applied = args.binding.acceptEditRead({ ...result, readId: id }, (current, fresh) => fresh.kind === "form" && validSource(fresh.source)
    && (fresh.source.customer?.id ?? "") === args.customerId && fresh.source.orders.length === 0 && fresh.source.permissions.includes("shipping.create")
    && (!current.data.carrierId || fresh.source.carriers.some(c => c.id === current.data.carrierId))
    && current.data.customerId === previousCustomerId ? resetNewShipmentCustomer(current.data, args.customerId) : null);
  if (applied) args.accepted?.(id); return applied;
}
/** What Add order did (#695): it added the order, or why it did not. `shipped`: the order is no longer
 *  open or partly shipped. `changed`: the customer, the ship-to address, the carrier or the orders on
 *  the form changed while the read was out, or the read no longer allows the add. `unavailable`: the
 *  read failed, and the editor says so in its own words. `stale`: nothing was asked, or the answer
 *  belongs to a page or session that has moved on. */
export type AddOrderOutcome = "added" | "shipped" | "changed" | "unavailable" | "stale";
export async function runNewShipmentAddOrder(args: ShipmentCommandArgs & { orderId: string; newKey: () => string }): Promise<AddOrderOutcome> {
  const before = args.binding.getSnapshot().current;
  if (!before || before.baseline.kind !== "form" || !before.data.customerId || before.data.selected.some(o => o.orderId === args.orderId)) return "stale";
  const customerId = before.data.customerId; const orderIds = before.data.selected.map(o => o.orderId); const held = before.baseline.source.orders;
  const id = args.binding.beginEditRead(); if (id === null) return "stale";
  // Owner ruling R22 (#696): the read covers the header context and the new order alone. The orders
  // already on the form are not read again, so their staleness is left to the next full read and to
  // Save, whose validation is unchanged.
  let result: NewShipmentRead;
  try { result = await args.read({ seed: seedFrom(before.data), current: { ...dependency(before), orderIds: [args.orderId] } }); }
  catch { result = { kind: "unavailable" }; }
  if (!args.authorized()) return "stale";
  let refusal: "shipped" | "changed" = "changed";
  const fresh = result.kind === "authorized" && result.baseline.kind === "form" && validSource(result.baseline.source) ? result.baseline.source : null;
  const order = fresh?.orders.find(o => o.id === args.orderId);
  // The adopted baseline keeps the orders already on the form as they were last read, and adds the
  // new order as it reads now: nothing already selected is rebased.
  const access: ShipmentReadAccess = result.kind === "authorized" && fresh && order
    ? { ...result, readId: id, baseline: newShipmentBaselineFrom({ ...fresh, orders: [...held.filter(o => orderIds.includes(o.id) && o.id !== args.orderId), order] }) }
    : { ...result, readId: id };
  const applied = args.binding.acceptEditRead(access, (current, adopted) => {
    if (adopted.kind !== "form" || !fresh || fresh.customer?.id !== customerId || !fresh.permissions.includes("shipping.create")
      || current.data.customerId !== customerId || JSON.stringify(current.data.selected.map(o => o.orderId)) !== JSON.stringify(orderIds)) return null;
    if (current.baseline.kind !== "form" || (!current.data.shipToAddressId ? false : !fresh.addresses.some(a => a.id === current.data.shipToAddressId))
      || (!current.data.carrierId ? false : !fresh.carriers.some(c => c.id === current.data.carrierId))) return null;
    if (!order || order.customerId !== customerId || order.voided || current.data.selected.some(o => o.orderId === args.orderId)) return null;
    if (!["OPEN", "PARTIAL_SHIPPED"].includes(order.status)) { refusal = "shipped"; return null; }
    const entry: NewShipmentOrderDraft = { orderId: order.id,
      lines: order.lines.map(l => { const shipped = order.orderLineShippedToDate.find(s => s.orderLineId === l.id); return { key: args.newKey(), isNew: true, orderLineId: l.id,
        qty: String(shipRemainder(l.qty, shipped?.shippedToDateQty ?? 0)), weight: String(shipRemainder(l.weight, shipped?.shippedToDateWeight ?? 0)), lineComplete: "false" }; }),
      containers: order.containers.map(c => ({ key: args.newKey(), isNew: true, ...prefillContainerRow(c) })),
      serials: order.serials.map(s => ({ key: args.newKey(), isNew: true, orderSerialId: s.id, printOnShipper: "true" })) };
    return { ...current.data, selected: [...current.data.selected, entry] };
  });
  if (applied) { args.accepted?.(id); return "added"; }
  return result.kind === "unavailable" ? "unavailable" : refusal;
}
export function runNewShipmentRemoveOrder(binding: NewShipmentBinding, orderId: string, accepted?: (readId: number) => void): boolean {
  const current = binding.getSnapshot().current;
  if (!current || current.baseline.kind !== "form" || !current.data.selected.some(o => o.orderId === orderId)) return false;
  const id = binding.beginEditRead(); if (id === null) return false;
  // Synchronous strict subset of the exact accepted source; no fetched fact or new ID.
  const baseline = newShipmentBaselineFrom({ ...current.baseline.source, orders: current.baseline.source.orders.filter(o => o.id !== orderId) });
  const applied = binding.acceptEditRead({ kind: "authorized", readId: id, baseline, editable: true }, latest => removeNewShipmentOrder(latest.data, orderId));
  if (applied) accepted?.(id); return applied;
}
