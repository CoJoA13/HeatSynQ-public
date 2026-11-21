import { z } from "zod";
import { Prisma, type Order, type Shipper } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors, retryAllocation, isDuplicateClientRequestId, isExpiredTransaction } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { assertRefExists } from "./reference-guards";
import { decimalBoxField } from "./decimal-field";
import { allocateNumber, getSetting } from "./settings";
import { claimOrdersInOrder, sortedClaimIds } from "./order-locks";
import { finalizedInvoicesFor, invoiceBlockMessage } from "./invoice-guards";
import { listAddresses } from "./customer-addresses";
import { billToAttn, pickDefaultAddress } from "./party-address";
import { renderPdf, renderSheetGroups, jpegDataUri, pngDataUri } from "./pdf/render";
import { buildShippingTicketDefinitions, type TicketData, type TicketParty } from "./pdf/shipping-ticket";
import { resolveTemplateForPrint } from "./template-assignments";
import { SHIPPER_DEFAULT_CONFIG } from "../lib/template-contracts/index";
import { templatePlacesLogo } from "../lib/template-contracts/template-logo";
import { buildBolDefinition, type BolData, type BolParty } from "./pdf/bol";
import { storeDocument, assertPrintable } from "./documents";
import { shippedTotals, recomputeOrderStatus, nextShipmentSequence, nextShipmentSequences, completionOfTargets, type CompletionTarget, type ShippedTotal } from "./ship-ledger";
import { createCert } from "./certs";
import { toXlsx } from "./excel";
import type { Blocker } from "./reference-blockers";
import { LIST_WINDOW, cutToWindow, type ListWindow } from "../lib/list-window";
import { parseDateOnly, formatDateOnly } from "../lib/business-days";
import { FREIGHT_TERMS, type FreightTermsValue, type CertScopeValue } from "../lib/cert-constants";
import { formatNumber } from "../lib/format";
import { INT4_MAX } from "../lib/order-constants";
import { lineIsComplete } from "../lib/line-completion";
import { INVOICE_FREEZE, type InvoicedOrder } from "../lib/invoice-freeze";
import {
  printedOrdersFrom, removeOrderRefusal, type PinningDocument, type PrintedOrders,
} from "../lib/shipment-remove-order";
import type { ShipToAddress } from "../lib/shipment-ship-to";
import { NET_WEIGHT_LB } from "../lib/weight-terms";
import { FREIGHT_AMOUNT, SHIPMENT_TARE_EACH, SHIP_NOW_NET_WEIGHT } from "../lib/shipment-boxes";

// -------------------------------------------------------------------------------------------
// Task 8: the shipment save — `Shipper -> ShipperOrder -> lines/containers/serials` (spec §4.2,
// §5.3, §5.4, §5.7, §6.2). The densest task in the phase: this is where sorted claims, credit
// hold, and idempotency all meet for the first time.
// -------------------------------------------------------------------------------------------

export type ShipperLineDetail = {
  /** Null once the order line was removed (post-void, snapshot + release) — the row renders from
   *  its snapshot columns from then on. */
  id: string; orderLineId: string | null; linePosition: number; partNumber: string; partName: string;
  partDescription: string;
  orderedQty: number; orderedWeight: number; shippedToDateQty: number; shippedToDateWeight: number;
  qty: number; weight: number; lineComplete: boolean;
};
/**
 * Shipped-to-date for ONE line of the order, whether or not that line is on this shipment (Task 14
 * review, Important #1). `ShipperLineDetail` above already carries the same two figures for the
 * lines that ARE on this shipment; this is the same derivation extended to the rest of the order's
 * lines — the ones the shipment page's "Add line" picker offers — so the ship-now prefill can be
 * `ordered − shipped` (design §5.1) for a candidate that was partly shipped on some OTHER
 * shipment, instead of defaulting to the full ordered figure and over-shipping by construction.
 */
export type OrderLineShippedToDate = {
  orderLineId: string; shippedToDateQty: number; shippedToDateWeight: number;
};
export type ShipperOrderDetail = {
  id: string; orderId: string; orderNumber: number; sequence: number; position: number;
  poNumber: string; customerJobNo: string; label: string;
  /** Every LIVE line of this order, in order position — a superset of `lines[].orderLineId`, and
   *  the only place a not-yet-added candidate's shipped-to-date is knowable client-side. */
  orderLineShippedToDate: OrderLineShippedToDate[];
  lines: ShipperLineDetail[];
  /** `tareEach` is the shipment row's OWN figure (weights design §9.4 and §12.2, owner ruling W2
   *  of 2026-10-09). Both saves store the figure a row of the request carries, and the answer
   *  reads this row's column, never the live order row. Null when the row has none: it was sent
   *  as none, it came from an order row that had none, or the row was created before the column
   *  existed (existing shipments were given no tare each). */
  containers: { id: string; orderContainerId: string | null; typeName: string; customerContainerId: string; count: number; tareEach: number | null; position: number }[];
  serials: { id: string; orderSerialId: string | null; serial: string; description: string; printOnShipper: boolean }[];
};
export type ShipperDetail = {
  id: string; shipperNumber: number; bolNumber: number | null;
  customerId: string; customerCode: string; customerName: string;
  /** The §5.4 gate's UI signal — extension mutators refuse without the override when set. */
  customerCreditHold: boolean;
  shipToAddressId: string | null; shipDate: string;
  carrierId: string | null; carrierName: string | null; route: string; comments: string;
  billFreight: boolean; freightAmount: number | null; freightTerms: FreightTermsValue;
  freightClass: string; freightDescription: string; packageCount: number | null;
  proNumber: string; scacCode: string;
  /** Set when this shipment is a reversing shipment (§5.6): the id of the shipment it reverses.
   *  Its lines carry negative qty/weight, and a credit is built from it. */
  reversesShipperId: string | null;
  /** The reversed original's packing-list number when this document IS a reversal (#139) — the
   *  shipment page's freeze banner/titles name the pair from the reversal side too (§5.16);
   *  `claimLiveShipper`'s refusal stays the enforcement. */
  reversesShipperNumber: number | null;
  /** The LIVE reversing shipment pointing AT this one, if any (#65): its packing-list number, so
   *  the shipment page can render Void disabled naming the blocker (§5.16) — `voidShipper`'s own
   *  refusal stays the enforcement. Always null on a reversal document itself (a reversal cannot
   *  be reversed), so its Void stays enabled: voiding a reversal is the blessed undo. */
  reversedByShipperNumber: number | null;
  /** The §5.7 invoice freeze, pre-worded (Codex MR !141 review): when any order on this shipment
   *  carries a finalized invoice, this is `voidShipper`'s OWN refusal sentence
   *  (`invoiceBlockMessage`, built server-side so UI title and server refusal cannot drift), else
   *  null. The Void gate must show THIS before the reversal blocker — the same precedence
   *  `voidShipper` enforces (`refuseIfInvoiced` first) — or an invoiced pair's disabled button
   *  would send the operator at "void the reversal first", an action the server also refuses. */
  invoiceVoidBlock: string | null;
  /** Every finalized invoice on this shipment's orders, ascending by order number, `[]` when none
   *  (#472). These are the rows `invoiceVoidBlock` is built from, returned whole and at no extra
   *  query, so the page can word its other freezes (lines, added orders, billed freight, remove
   *  order) with the server's own sentences and link the invoice. `invoiceVoidBlock` is the Void
   *  sentence for `invoicedOrders[0]`. A snapshot, like every field here: each mutator still
   *  decides under its own claims. */
  invoicedOrders: InvoicedOrder[];
  deletedAt: string | null;
  orders: ShipperOrderDetail[];
};
export type ShipperCreateResult = { shipper: ShipperDetail; warnings: string[]; deduped: boolean };

// Either the top-level client or a `tx` — the `readDetail` precedent (orders.ts): `readShipperDetail`
// serves both `getShipper` and the tail of the save transaction.
type Db = Prisma.TransactionClient;

const num = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());

/** `parseDateOnly` at the service boundary — the `orders.ts` `parseDate` precedent, one field. */
function parseDate(value: string, field: string): Date {
  try {
    return parseDateOnly(value);
  } catch {
    throw new HttpError(400, `"${value}" is not a valid date (yyyy-mm-dd) for ${field}`);
  }
}

// -------------------------------------------------------------------------------------------
// Input shape (task-8-brief.md's exact fields). `clientRequestId` is a plain string, NOT `.uuid()`
// — unlike `Order.clientRequestId` (a browser-minted UUID nonce), nothing in this phase's spec or
// task brief requires this shape to be a UUID specifically, and the brief's own idempotency test
// exercises a plain string ("nonce-1"). `freightClass`/`proNumber`/`scacCode` are `.max(30)` per
// the brief; other display-text fields follow the 2C-2 §4 "max(n) text defaulting """ convention
// with reasonable bounds, since the brief does not pin them individually.
// -------------------------------------------------------------------------------------------

const SHIP_LINE = z.object({
  orderLineId: z.string().min(1),
  qty: z.number().int().min(0).max(INT4_MAX),
  weight: decimalBoxField(SHIP_NOW_NET_WEIGHT.box, { required: true }),
  lineComplete: z.boolean(),
}).strict();

// One strict shape for a container row at both doors. `tareEach` takes the order row's own rule
// (`CONTAINER_ITEM`, order-internals.ts): a number or a decimal string of 0 or more, at most ten
// digits before the point and two after, or null, or no key. No key is not a null: each save says,
// where it stores the row, what a row with no key gets.
const SHIP_CONTAINER = z.object({
  orderContainerId: z.string().min(1),
  count: z.number().int().min(1).max(INT4_MAX),
  tareEach: decimalBoxField(SHIPMENT_TARE_EACH.box),
}).strict();

// Save containers' body, beside the bare list it has always taken. `containers` is every row that
// is not kept. `kept` names kept rows (rows whose order-side row was since corrected away) by the
// shipment row's own id. `replaceShipperContainers` chooses the shape before it parses.
const KEPT_CONTAINER = z.object({ id: z.string().min(1), tareEach: decimalBoxField(SHIPMENT_TARE_EACH.box) }).strict();
const REPLACE_CONTAINERS = z.object({ containers: z.array(SHIP_CONTAINER), kept: z.array(KEPT_CONTAINER).default([]) }).strict();

const SHIP_SERIAL = z.object({
  orderSerialId: z.string().min(1),
  printOnShipper: z.boolean().default(true),
}).strict();

const SHIP_ORDER = z.object({
  orderId: z.string().min(1),
  lines: z.array(SHIP_LINE).default([]),
  containers: z.array(SHIP_CONTAINER).default([]),
  serials: z.array(SHIP_SERIAL).default([]),
}).strict();

const CREATE_SHIPPER = z.object({
  clientRequestId: z.string().min(1).max(200).optional(),
  customerId: z.string().min(1),
  shipToAddressId: z.string().min(1).nullable().optional(),
  shipDate: z.string().min(1),
  carrierId: z.string().min(1).nullable().optional(),
  route: z.string().max(200).default(""),
  comments: z.string().max(4000).default(""),
  billFreight: z.boolean().default(false),
  freightAmount: decimalBoxField(FREIGHT_AMOUNT.box),
  freightTerms: z.enum(FREIGHT_TERMS).default("PREPAID"),
  freightClass: z.string().max(30).default(""),
  freightDescription: z.string().max(200).default(""),
  packageCount: z.number().int().min(0).max(INT4_MAX).nullable().optional(),
  proNumber: z.string().max(30).default(""),
  scacCode: z.string().max(30).default(""),
  // Required and trimmed IN THE SERVICE below (spec §5.4's shape), not enforced by zod here — a
  // non-blank string is not, by itself, "a real reason", and the same field is legal (and
  // ignored) when the customer is not actually on hold.
  creditHoldReason: z.string().max(1000).optional(),
  orders: z.array(SHIP_ORDER).min(1),
}).strict();

type CreateShipperInput = z.infer<typeof CREATE_SHIPPER>;

type ResolvedLine = {
  id: string; orderId: string; position: number; qty: number; weight: Prisma.Decimal;
  part: { partNumber: string; name: string; description: string; serializationRequired: boolean };
};
type ResolvedContainer = {
  id: string; orderId: string; customerContainerId: string; type: { name: string };
  /** The order row's tare each. A shipment row takes it only when the row is new to the shipment
   *  and its row of the request carries no `tareEach` key. */
  tareEach: Prisma.Decimal | null;
};
type ResolvedSerial = { id: string; orderId: string; lineId: string; serial: string; description: string };

/** "Order #1042 line 2 (DEMO-RG-1001)" — one label shape for every line-anchored refusal and every
 *  warning in this file, naming both the order and the line (spec §5.7's "each naming the order
 *  and line") — the `orders.ts` `lineLabel` precedent, widened to name the order too since one
 *  shipment can span several of a customer's orders. */
function shipLineLabel(orderNumber: number, line: ResolvedLine): string {
  return `Order #${orderNumber} line ${line.position} (${line.part.partNumber})`;
}

/** The create entry's `after` snapshot, composed by hand exactly like `orders.ts`'s own
 *  `auditPayload` — every foreign key travels with the live name it points at (spec §7's
 *  unreadable-history lesson applied at the create path too, not just `SNAPSHOT_INCLUDE`), and
 *  the credit-hold override reason (when present) rides in THIS payload only — never in a column
 *  on `Shipper` itself, so it lands in the audit entry and prints on no piece of paper (spec
 *  §5.4). Row ids are absent because they do not exist yet, the `orders.ts` precedent. */
function auditPayload(args: {
  shipperNumber: number;
  customer: { id: string; code: string; name: string };
  data: CreateShipperInput;
  shipDate: Date;
  carrierName: string | null;
  shipToAddressName: string | null;
  sequenceByOrderId: Map<string, number>;
  ordersById: Map<string, Order>;
  lineById: Map<string, ResolvedLine>;
  containerById: Map<string, ResolvedContainer>;
  serialById: Map<string, ResolvedSerial>;
  creditHoldOverrideReason?: string;
}) {
  const {
    shipperNumber, customer, data, shipDate, carrierName, shipToAddressName, sequenceByOrderId,
    ordersById, lineById, containerById, serialById, creditHoldOverrideReason,
  } = args;
  return {
    shipperNumber,
    customerId: customer.id, customerCode: customer.code, customerName: customer.name,
    shipToAddressId: data.shipToAddressId ?? null, shipToAddressName,
    shipDate: formatDateOnly(shipDate),
    carrierId: data.carrierId ?? null, carrierName,
    route: data.route, comments: data.comments,
    billFreight: data.billFreight, freightAmount: data.freightAmount ?? null,
    freightTerms: data.freightTerms, freightClass: data.freightClass,
    freightDescription: data.freightDescription, packageCount: data.packageCount ?? null,
    proNumber: data.proNumber, scacCode: data.scacCode,
    // `?? undefined` would silently vanish under redact()'s JSON.stringify round-trip
    // (CLAUDE.md's own lesson) — omitted with a conditional spread instead, so the key exists
    // only when an override genuinely happened.
    ...(creditHoldOverrideReason ? { creditHoldOverrideReason } : {}),
    orders: data.orders.map((o) => {
      const order = ordersById.get(o.orderId)!;
      return {
        orderId: o.orderId, orderNumber: order.orderNumber, sequence: sequenceByOrderId.get(o.orderId)!,
        lines: o.lines.map((l) => {
          const line = lineById.get(l.orderLineId)!;
          return {
            orderLineId: l.orderLineId, linePosition: line.position, partNumber: line.part.partNumber,
            qty: l.qty, weight: l.weight, lineComplete: l.lineComplete,
          };
        }),
        containers: o.containers.map((c) => {
          const container = containerById.get(c.orderContainerId)!;
          return {
            orderContainerId: c.orderContainerId, typeName: container.type.name,
            customerContainerId: container.customerContainerId, count: c.count,
            // The figure stored. `saveNewShipper` works it out where it builds `storedOrders`, so
            // it is a number or null here: a number, as a line's `weight` above is.
            tareEach: c.tareEach ?? null,
          };
        }),
        serials: o.serials.map((s) => {
          const serial = serialById.get(s.orderSerialId)!;
          return { orderSerialId: s.orderSerialId, serial: serial.serial, printOnShipper: s.printOnShipper };
        }),
      };
    }),
  };
}

const DETAIL_INCLUDE = {
  customer: { select: { code: true, name: true, creditHold: true } },
  carrier: { select: { name: true } },
  // #65: the live reversal pointing at this shipment, for `reversedByShipperNumber`. At most one
  // can exist in honest data (a second full reversal fails the below-zero guard), but the query
  // stays deterministic anyway: lowest packing-list number first, matching `voidShipper`'s refusal.
  reversedBy: {
    where: { deletedAt: null },
    orderBy: { shipperNumber: "asc" },
    take: 1,
    select: { shipperNumber: true },
  },
  // #139: the original this document reverses, for `reversesShipperNumber` — deliberately NOT
  // live-filtered (unlike `reversedBy` above): a reversal is frozen regardless of its original's
  // liveness, so the pair must stay named even over corrupt pre-#65 data.
  reverses: { select: { shipperNumber: true } },
  orders: {
    orderBy: { position: "asc" },
    include: {
      order: {
        select: {
          orderNumber: true, poNumber: true, customerJobNo: true,
          // The order's OWN full line set, not just the lines on this shipment — `toDetail` turns
          // it into `orderLineShippedToDate` below. A nested select on a relation this query
          // already joins, so it costs no extra round trip; order lines carry no `deletedAt` of
          // their own (P3 §4), so every row here is live by construction.
          lines: { orderBy: { position: "asc" }, select: { id: true } },
        },
      },
      // Live joins preferred, snapshot columns as the fallback (snapshot + release, owner ruling
      // 2026-08-06): each `orderLine`/`orderContainer`/`orderSerial` is null once the order-side
      // row was corrected away, and `toDetail` falls back to the columns captured at save time.
      lines: {
        orderBy: { position: "asc" },
        include: {
          orderLine: {
            select: {
              position: true, qty: true, weight: true,
              part: { select: { partNumber: true, name: true, description: true } },
            },
          },
        },
      },
      containers: {
        orderBy: { position: "asc" },
        include: { orderContainer: { select: { customerContainerId: true, type: { select: { name: true } } } } },
      },
      serials: {
        // The snapshot column, not `orderSerialId` — released rows carry a null id, which would
        // make the sort unstable exactly when the fallback matters. `id` breaks a
        // duplicate-serial tie (same serial string on two lines is legal) deterministically.
        orderBy: [{ serial: "asc" }, { id: "asc" }],
        include: { orderSerial: { select: { serial: true, description: true } } },
      },
    },
  },
} satisfies Prisma.ShipperInclude;

type DetailRow = Prisma.ShipperGetPayload<{ include: typeof DETAIL_INCLUDE }>;

function toDetail(
  row: DetailRow, shipped: Map<string, ShippedTotal>, invoiceVoidBlock: string | null,
  invoicedOrders: InvoicedOrder[],
): ShipperDetail {
  return {
    id: row.id, shipperNumber: row.shipperNumber, bolNumber: row.bolNumber,
    customerId: row.customerId, customerCode: row.customer.code, customerName: row.customer.name,
    customerCreditHold: row.customer.creditHold,
    shipToAddressId: row.shipToAddressId, shipDate: formatDateOnly(row.shipDate),
    carrierId: row.carrierId, carrierName: row.carrier?.name ?? null,
    route: row.route, comments: row.comments,
    billFreight: row.billFreight, freightAmount: num(row.freightAmount),
    freightTerms: row.freightTerms as FreightTermsValue,
    freightClass: row.freightClass, freightDescription: row.freightDescription,
    packageCount: row.packageCount, proNumber: row.proNumber, scacCode: row.scacCode,
    reversesShipperId: row.reversesShipperId,
    reversesShipperNumber: row.reverses?.shipperNumber ?? null,
    reversedByShipperNumber: row.reversedBy[0]?.shipperNumber ?? null,
    invoiceVoidBlock,
    invoicedOrders,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    orders: row.orders.map((so) => ({
      id: so.id, orderId: so.orderId, orderNumber: so.order.orderNumber, sequence: so.sequence,
      position: so.position, poNumber: so.order.poNumber, customerJobNo: so.order.customerJobNo,
      label: `${so.order.orderNumber}-${so.sequence}`,
      // A DENSE list: a line with no live shipper line at all has no entry in `shipped` (the
      // sparse-map shape `shippedTotals` documents), and the grid must render a real "0 / 0.00 lb"
      // for it rather than the "—" that used to stand in for "unknown".
      orderLineShippedToDate: so.order.lines.map((ol) => {
        const totals = shipped.get(ol.id) ?? { qty: 0, weight: 0 };
        return { orderLineId: ol.id, shippedToDateQty: totals.qty, shippedToDateWeight: totals.weight };
      }),
      lines: so.lines.map((l) => {
        const totals = (l.orderLineId === null ? undefined : shipped.get(l.orderLineId)) ?? { qty: 0, weight: 0 };
        return {
          id: l.id, orderLineId: l.orderLineId,
          linePosition: l.orderLine?.position ?? l.position,
          partNumber: l.orderLine?.part.partNumber ?? l.partNumber,
          partName: l.orderLine?.part.name ?? l.partName,
          partDescription: l.orderLine?.part.description ?? l.partDescription,
          orderedQty: l.orderLine?.qty ?? l.orderedQty,
          orderedWeight: (l.orderLine?.weight ?? l.orderedWeight).toNumber(),
          shippedToDateQty: totals.qty, shippedToDateWeight: totals.weight,
          qty: l.qty, weight: l.weight.toNumber(), lineComplete: l.lineComplete,
        };
      }),
      containers: so.containers.map((c) => ({
        id: c.id, orderContainerId: c.orderContainerId,
        typeName: c.orderContainer?.type.name ?? c.typeName,
        customerContainerId: c.orderContainer?.customerContainerId ?? c.customerContainerId,
        count: c.count, position: c.position,
        // The shipment row's own column. Deliberately NOT read from the joined order row first, as
        // `typeName` and `customerContainerId` above are (owner ruling W2, 2026-10-09): the
        // shipment owns its tare each.
        tareEach: num(c.tareEach),
      })),
      serials: so.serials.map((s) => ({
        id: s.id, orderSerialId: s.orderSerialId,
        serial: s.orderSerial?.serial ?? s.serial,
        description: s.orderSerial?.description ?? s.description,
        printOnShipper: s.printOnShipper,
      })),
    })),
  };
}

/** Exported for `certs.ts`/future callers that need the full detail on a `tx` — the `readDetail`
 *  precedent (orders.ts). */
export async function readShipperDetail(db: Db, id: string): Promise<ShipperDetail> {
  const row = await db.shipper.findFirst({ where: { id }, include: DETAIL_INCLUDE });
  if (!row) throw new HttpError(404, "Shipment not found");
  // Every line of every order on this shipment — a superset of the lines actually ON the shipment
  // (`o.lines[].orderLineId`), which is what lets `toDetail` answer shipped-to-date for an add-line
  // CANDIDATE too (Task 14 review, Important #1). Still ONE `shippedTotals` call, and still the
  // single §5.1 derivation: the ids widened, the arithmetic untouched.
  const orderLineIds = row.orders.flatMap((o) => o.order.lines.map((l) => l.id));
  const shipped = await shippedTotals(db, orderLineIds);
  // The §5.7 freeze, pre-worded with `voidShipper`'s own sentence (see the type's doc comment) —
  // `finalizedInvoicesFor` sorts by order number, so this names the same invoice the server's
  // refusal would. `invoicedOrders` is the same rows, all of them (#472): no second query.
  const frozen = await finalizedInvoicesFor(db, row.orders.map((o) => o.orderId));
  return toDetail(row, shipped,
    frozen.length > 0 ? invoiceBlockMessage(frozen[0], INVOICE_FREEZE.voidShipment) : null,
    frozen.map((inv) => ({ orderId: inv.orderId, orderNumber: inv.orderNumber, invoiceId: inv.id })));
}

export async function getShipper(id: string): Promise<ShipperDetail> {
  return readShipperDetail(prisma, id);
}

/**
 * The save transaction (spec §5.3/§5.4/§5.7, task-8-brief.md Step 4): validate -> claim -> credit
 * hold -> allocate -> write -> shipment-scope certs -> recompute status -> warnings.
 *
 * Serializable — the registered-FK writer pattern applies to `carrierId` via `assertRefExists`
 * (CLAUDE.md); it is NOT what protects the sorted claim below, which is the row-lock guarantee at
 * any isolation level.
 */
async function saveNewShipper(
  data: CreateShipperInput, shipDate: Date, opts: { canOverrideCreditHold: boolean },
): Promise<ShipperCreateResult> {
  return prisma.$transaction(async (tx) => {
    if (new Set(data.orders.map((o) => o.orderId)).size !== data.orders.length) {
      throw new HttpError(400, "An order cannot appear twice on the same shipment");
    }

    // Claims are taken in SORTED order, always (spec §5.3) — `claimOrdersInOrder`, never a loop of
    // per-id `claimOrder` calls in caller order, which is exactly the ABBA deadlock hazard two
    // multi-order shipments over {A,B} and {B,A} would otherwise hit.
    const orderIds = data.orders.map((o) => o.orderId);
    const claimed = await claimOrdersInOrder(tx, orderIds);
    const ordersById = new Map(claimed.map((o) => [o.id, o]));

    const customer = await tx.customer.findFirst({ where: { id: data.customerId, deletedAt: null } });
    if (!customer) throw new HttpError(400, "That customer does not exist");

    for (const o of data.orders) {
      const order = ordersById.get(o.orderId);
      if (!order) throw new HttpError(404, "Order not found");
      if (order.deletedAt !== null) throw new HttpError(400, `Order #${order.orderNumber} has been voided`);
      if (order.customerId !== data.customerId) {
        throw new HttpError(400, `Order #${order.orderNumber} belongs to another customer`);
      }
    }

    let shipToAddressName: string | null = null;
    if (data.shipToAddressId) {
      const addr = await tx.customerAddress.findFirst({
        where: { id: data.shipToAddressId, customerId: data.customerId, kind: "SHIP_TO", deletedAt: null },
        select: { name: true },
      });
      if (!addr) throw new HttpError(400, "That ship-to address does not exist");
      shipToAddressName = addr.name;
    }

    // Every orderLineId/orderContainerId/orderSerialId must belong to the order it was named
    // under — one batched read per collection, not one per row (the `resolveLineParts` precedent,
    // orders.ts), then a membership check keyed by id.
    const orderLineIds = [...new Set(data.orders.flatMap((o) => o.lines.map((l) => l.orderLineId)))];
    const orderLines: ResolvedLine[] = orderLineIds.length === 0 ? [] : await tx.orderLine.findMany({
      where: { id: { in: orderLineIds } },
      select: {
        id: true, orderId: true, position: true, qty: true, weight: true,
        part: { select: { partNumber: true, name: true, description: true, serializationRequired: true } },
      },
    });
    const lineById = new Map(orderLines.map((l) => [l.id, l]));

    const containerIds = [...new Set(data.orders.flatMap((o) => o.containers.map((c) => c.orderContainerId)))];
    const orderContainers: ResolvedContainer[] = containerIds.length === 0 ? [] : await tx.orderContainer.findMany({
      where: { id: { in: containerIds } },
      select: { id: true, orderId: true, customerContainerId: true, tareEach: true, type: { select: { name: true } } },
    });
    const containerById = new Map(orderContainers.map((c) => [c.id, c]));

    const serialIds = [...new Set(data.orders.flatMap((o) => o.serials.map((s) => s.orderSerialId)))];
    const orderSerials: ResolvedSerial[] = serialIds.length === 0 ? [] : await tx.orderSerial.findMany({
      where: { id: { in: serialIds } },
      select: { id: true, orderId: true, lineId: true, serial: true, description: true },
    });
    const serialById = new Map(orderSerials.map((s) => [s.id, s]));

    // Membership AND uniqueness, in the same pass — a repeated orderLineId/orderContainerId/
    // orderSerialId within one order is refused HERE, naming the duplicated line/container/serial
    // by the same live name the membership check already resolved, rather than falling through to
    // the `@@unique` constraint and being mislabeled by `withDbErrors`' generic
    // `conflictField: "shipper number"` (Task 8 review, 2026-08-04) — the `orders.ts`
    // `duplicateSerialError` precedent, made proactive since the resolved rows are already here.
    for (const o of data.orders) {
      const order = ordersById.get(o.orderId)!;

      const seenLines = new Set<string>();
      for (const l of o.lines) {
        const line = lineById.get(l.orderLineId);
        if (!line || line.orderId !== o.orderId) {
          throw new HttpError(400, `Order #${order.orderNumber}: that line does not belong to this order`);
        }
        if (seenLines.has(l.orderLineId)) {
          throw new HttpError(400, `${shipLineLabel(order.orderNumber, line)}: listed twice on this shipment`);
        }
        seenLines.add(l.orderLineId);
      }

      const seenContainers = new Set<string>();
      for (const c of o.containers) {
        const container = containerById.get(c.orderContainerId);
        if (!container || container.orderId !== o.orderId) {
          throw new HttpError(400, `Order #${order.orderNumber}: that container does not belong to this order`);
        }
        if (seenContainers.has(c.orderContainerId)) {
          throw new HttpError(400,
            `Order #${order.orderNumber}: container "${container.type.name}" is listed twice on this shipment`);
        }
        seenContainers.add(c.orderContainerId);
      }

      const seenSerials = new Set<string>();
      for (const s of o.serials) {
        const serial = serialById.get(s.orderSerialId);
        if (!serial || serial.orderId !== o.orderId) {
          throw new HttpError(400, `Order #${order.orderNumber}: that serial does not belong to this order`);
        }
        if (seenSerials.has(s.orderSerialId)) {
          throw new HttpError(400,
            `Order #${order.orderNumber}: serial "${serial.serial}" is listed twice on this shipment`);
        }
        seenSerials.add(s.orderSerialId);
      }
    }

    // Credit hold (spec §5.4, owner ruling §3.7) — the first real gate in this system. Named and
    // linked (the §5.14 blocked-delete discoverability rule applied to a permission-shaped
    // block), never merely "refused". Through the SAME claiming gate the extension mutators use
    // (round-6 finding): the earlier customer read above was unlocked, so a concurrently
    // committed hold was invisible here too.
    const creditHoldOverrideReason = await creditHoldGate(tx, data.customerId, opts, data.creditHoldReason);

    // Numbering (spec §3.19/§5.3), inside the same claim: the shipment's own packing-list number,
    // then every order's own never-reused shipment sequence.
    const shipperNumber = await allocateNumber("shipper_number_next", tx);
    const sequenceByOrderId = await nextShipmentSequences(tx, orderIds);

    let carrierName: string | null = null;
    if (data.carrierId) {
      await assertRefExists("carrier", data.carrierId, tx);
      const carrier = await tx.carrier.findFirst({ where: { id: data.carrierId }, select: { name: true } });
      carrierName = carrier?.name ?? null;
    }

    // Shipped-to-date BEFORE this shipment's own lines exist — the over-ship warning below
    // compares against what was already live, not what this save is about to add.
    const priorShipped = await shippedTotals(tx, orderLineIds);

    // What is stored, worked out once, here, so the audit entry and the rows carry the same values.
    // The close-short flag (`storedCloseShort`): no row of this shipment exists yet, so
    // `priorShipped` is exactly the quantity on other live shipments. A container row's tare each:
    // the figure the row carries, a null as none. With no `tareEach` key it is the order row's,
    // because every row of a new shipment is new to it.
    const storedOrders = data.orders.map((o) => ({
      ...o,
      lines: o.lines.map((l) => ({
        ...l,
        lineComplete: storedCloseShort(
          l, lineById.get(l.orderLineId)!.qty, priorShipped.get(l.orderLineId)?.qty ?? 0),
      })),
      containers: o.containers.map((c) => ({
        ...c,
        tareEach: c.tareEach !== undefined ? c.tareEach : num(containerById.get(c.orderContainerId)!.tareEach),
      })),
    }));

    const shipper = await auditedCreate(
      "shipper",
      auditPayload({
        shipperNumber, customer, data: { ...data, orders: storedOrders }, shipDate, carrierName,
        shipToAddressName, sequenceByOrderId,
        ordersById, lineById, containerById, serialById, creditHoldOverrideReason,
      }),
      () => tx.shipper.create({
        data: {
          shipperNumber,
          clientRequestId: data.clientRequestId ?? null,
          customerId: data.customerId,
          shipToAddressId: data.shipToAddressId ?? null,
          shipDate,
          carrierId: data.carrierId ?? null,
          route: data.route,
          comments: data.comments,
          billFreight: data.billFreight,
          freightAmount: data.freightAmount ?? null,
          freightTerms: data.freightTerms,
          freightClass: data.freightClass,
          freightDescription: data.freightDescription,
          packageCount: data.packageCount ?? null,
          proNumber: data.proNumber,
          scacCode: data.scacCode,
          orders: {
            create: storedOrders.map((o, oi) => ({
              orderId: o.orderId,
              sequence: sequenceByOrderId.get(o.orderId)!,
              position: oi + 1,
              // Snapshot columns ride every child create (owner ruling 2026-08-06): the identity
              // the paper prints, captured at save time off the same resolved rows the
              // membership checks above already validated.
              lines: {
                create: o.lines.map((l, li) => {
                  const line = lineById.get(l.orderLineId)!;
                  return {
                    orderLineId: l.orderLineId, position: li + 1,
                    qty: l.qty, weight: l.weight, lineComplete: l.lineComplete,
                    partNumber: line.part.partNumber, partName: line.part.name,
                    partDescription: line.part.description,
                    orderedQty: line.qty, orderedWeight: line.weight,
                  };
                }),
              },
              containers: {
                create: o.containers.map((c, ci) => {
                  const container = containerById.get(c.orderContainerId)!;
                  return {
                    orderContainerId: c.orderContainerId, position: ci + 1, count: c.count,
                    typeName: container.type.name, customerContainerId: container.customerContainerId,
                    tareEach: c.tareEach,
                  };
                }),
              },
              serials: {
                create: o.serials.map((s) => {
                  const serial = serialById.get(s.orderSerialId)!;
                  return {
                    orderSerialId: s.orderSerialId, printOnShipper: s.printOnShipper,
                    serial: serial.serial, description: serial.description,
                    orderLineIdAtSave: serial.lineId,
                  };
                }),
              },
            })),
          },
        },
        select: { id: true },
      }),
      { tx },
    );

    // SHIPMENT-scope certs, one per order whose resolved cert scope is SHIPMENT (spec §6.2).
    // `shipper.id` is the row THIS transaction inserted a moment ago: no other transaction can
    // see it yet (it is uncommitted), so it can never have been voided before this transaction
    // commits — this call path can never hand `createCert` a voided `shipperId` (task brief,
    // carried-forward item 1; see the task report for the full argument).
    for (const o of data.orders) {
      const order = ordersById.get(o.orderId)!;
      if (order.certRequired && order.certScope === "SHIPMENT") {
        await createCert({ orderId: o.orderId, scope: "SHIPMENT", shipperId: shipper.id }, tx);
      }
    }

    await recomputeOrderStatus(tx, orderIds);

    // Warnings (spec §5.7) — collected AFTER the cert/status writes above, so a SHIPMENT-scope
    // cert this very save just created is never reported as "missing". Matched to the order's
    // CURRENT scope (#53): a stale live cert of another scope (deliberately kept live when the
    // frozen scope was overridden) must not satisfy a requirement nothing has created yet. For
    // SHIPMENT scope only THIS shipment's cert counts — the print resolution's own rule.
    const liveCerts = await tx.cert.findMany({
      where: { orderId: { in: orderIds }, deletedAt: null },
      select: { orderId: true, scope: true, shipperId: true },
    });
    const scopeSatisfiedOrderIds = new Set(
      liveCerts.filter((c) => {
        const order = ordersById.get(c.orderId);
        if (!order || c.scope !== order.certScope) return false;
        return c.scope !== "SHIPMENT" || c.shipperId === shipper.id;
      }).map((c) => c.orderId),
    );

    const warnings: string[] = [];
    for (const o of data.orders) {
      const order = ordersById.get(o.orderId)!;
      if (order.certRequired && !scopeSatisfiedOrderIds.has(o.orderId)) {
        warnings.push(
          `Order #${order.orderNumber} requires a certification and none exists yet — see /orders/${order.id}`);
      }

      const serialLineIds = new Set(
        o.serials.map((s) => serialById.get(s.orderSerialId)?.lineId).filter((id): id is string => !!id));

      for (const l of o.lines) {
        const line = lineById.get(l.orderLineId)!;
        const label = shipLineLabel(order.orderNumber, line);

        if (line.part.serializationRequired && !serialLineIds.has(l.orderLineId)) {
          warnings.push(`${label}: requires serialization but no serial numbers were selected for this shipment`);
        }

        const prior = priorShipped.get(l.orderLineId) ?? { qty: 0, weight: 0 };
        const remainingQty = line.qty - prior.qty;
        // #508: whole cents, never a float subtraction (25 - 12.1 is 12.899999999999999, which made
        // shipping exactly the remaining 12.90 a false warning).
        const remainingWeightCents = Math.round(line.weight.toNumber() * 100) - Math.round(prior.weight * 100);
        if (l.qty > remainingQty || Math.round(l.weight * 100) > remainingWeightCents) {
          warnings.push(
            `${label}: shipping ${formatNumber(l.qty)} / ${formatNumber(l.weight, 2)} lb exceeds the remaining ` +
            `${formatNumber(remainingQty)} / ${formatNumber(remainingWeightCents / 100, 2)} lb on this line`);
        }
      }
    }

    // #125: the re-shipped-serial advisory, computed through the SAME two helpers
    // `shipmentWarnings` uses rather than re-derived here. Creation builds its warning list inline
    // (its messages name the input the operator just sent, e.g. "shipping … lb exceeds the
    // remaining …", where a later read can only speak of shipped-to-date), so the two lists are
    // deliberately not one function — but the RULE behind any single warning must live in exactly
    // one place, which is the #50/#54 lesson. Every selection here is fresh, so `serialById` resolves
    // each one to its (line, serial) identity — the same key a later read rebuilds from the live join
    // or the snapshot.
    warnings.push(...reshippedSerialWarnings(await otherShipmentsWith(
      tx, shipper.id,
      data.orders.flatMap((o) => o.serials.flatMap((sr) => {
        const resolved = serialById.get(sr.orderSerialId);
        return resolved ? [{ lineId: resolved.lineId, serial: resolved.serial }] : [];
      })))));

    return { shipper: await readShipperDetail(tx, shipper.id), warnings, deduped: false };
    // STANDING INVARIANT (the stale-draft guard, stated above `claimShipperRow`): this stays
    // Serializable, or a draft invoice calculated before this change can be finalized silently.
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

/**
 * `createShipper` (spec §5, task-8-brief.md). `clientRequestId` collisions answer with the
 * shipment that request already created — `orders.ts`'s `createOrder` idempotent-replay shape,
 * reused via the shared `isDuplicateClientRequestId` (db-errors.ts since #33; it never hardcodes
 * a model name) rather than rediscovered here.
 */
export async function createShipper(
  input: unknown, opts: { canOverrideCreditHold: boolean },
): Promise<ShipperCreateResult> {
  const data = CREATE_SHIPPER.parse(input);

  // Both checked ahead of the transaction — pure input validation with no DB dependency (Task 8
  // review, 2026-08-04: `parseDate` moved up beside the pre-existing `qty > 0` check for the same
  // reason). A shipment about nothing is not a shipment (spec §4.2).
  const anyPositiveQty = data.orders.some((o) => o.lines.some((l) => l.qty > 0));
  if (!anyPositiveQty) throw new HttpError(400, "A shipment needs at least one line with a positive quantity");
  const shipDate = parseDate(data.shipDate, "Ship date");

  // `retryAllocation` (#115) wraps the try/catch — the `createOrder` nesting and for the same
  // reason: a 40001 from `allocateNumber`'s Serializable claim is rethrown by the catch and absorbed
  // by the retry, while a `clientRequestId` collision is answered by the replay on the FIRST attempt
  // and never retried. A shipment racing another on `shipper_number_next` no longer costs one of
  // them a 409.
  return withDbErrors({ entity: "Shipper", conflictField: "shipper number" }, () => retryAllocation(async () => {
    try {
      return await saveNewShipper(data, shipDate, opts);
    } catch (err) {
      // The replay: deliberately inside withDbErrors' callback and outside the transaction — by
      // the time this runs the failed attempt has fully rolled back (no number, no sequence
      // consumed), and the winning shipment is committed and readable.
      if (!data.clientRequestId || !isDuplicateClientRequestId(err)) throw err;
      const existing = await prisma.shipper.findFirst({
        where: { clientRequestId: data.clientRequestId }, select: { id: true },
      });
      if (!existing) throw err;
      // The replay carries the SAME advisory surface the original response did (#50) — the
      // lost-response retry is exactly when the operator never saw it.
      const detail = await readShipperDetail(prisma, existing.id);
      return { shipper: detail, warnings: await shipmentWarnings(prisma, detail), deduped: true };
    }
  }));
}

// -------------------------------------------------------------------------------------------
// Task 9: shipment children — a shipment edited as a document (spec §4.2, §5.3, §5.5, §7.3):
// change its header, add and remove orders, and replace the three per-order grids. Every mutator
// below follows the same shape: `withDbErrors` -> Serializable `$transaction` -> resolve the
// shipper (404 on missing OR voided — a voided shipment is read-only, the P3 voided-order shape)
// -> `claimOrdersInOrder(tx, everyAffectedOrderId)` -> `auditedUpdate("shipper", id, …)` -> writes
// -> `recomputeOrderStatus`. "Every affected order" is always the FULL set of orders currently on
// the shipment (plus the incoming order for `addOrderToShipper`) — even a header-only edit claims
// the whole set, the same uniform discipline `updateLine`'s own comment describes for
// `recomputeOrderStatus` itself (orders.ts): calling it where it cannot possibly matter is cheap,
// and it means no mutator silently relies on an invariant ("this write can never touch another
// order") that a later change could quietly break.
// -------------------------------------------------------------------------------------------

// STANDING INVARIANT (the stale-draft guard, owner ruling 2026-10-06). Invoice finalize refuses a
// draft whose shipments changed since it was calculated, by re-reading the shipment-side pricing
// inputs and comparing a fingerprint (`finalizeInvoiceInTx`, invoices.ts). The order claim does NOT
// make that read fresh: finalize is Serializable and its snapshot is fixed before it holds the
// claim, and a change here that leaves the order SHIPPED writes no `Order` row for the waiting
// finalize to collide with. What aborts finalize is Postgres SSI: the mutator reads state finalize
// writes (the claimed `Order` row; `refuseIfInvoiced`'s finalized-invoice read) and finalize reads
// rows the mutator wrote. So every mutator that changes shipper lines or billed freight runs
// Serializable: `saveNewShipper` (`createShipper`), `updateShipper`, `addOrderToShipper`,
// `removeOrderFromShipper`, `replaceShipperLines`, `voidShipper`, `reverseShipper`. If any of
// them is ever downgraded, to Read Committed or Repeatable Read, a stale draft can be finalized
// silently (SSI tracks only all-Serializable transactions).
// `tests/invoice-fingerprint-race.test.ts` measures it for all seven, one dangerous-direction case
// each, and each case fails with its own mutator at either level.

/** FOR UPDATE on the Shipper row itself — always taken AFTER `claimOrdersInOrder`'s order claims
 *  (order-locks.ts's house rule: the guarded state must live on, or be locked with, the claimed
 *  row; one fixed order — Order rows, then the entity's own row — so no ABBA window). This is what
 *  makes a post-claim re-read of `Shipper.deletedAt` genuinely fresh at Read Committed, and what
 *  raises the honest 40001 → 409 at Serializable when a voidShipper committed while the caller was
 *  blocked on the order locks (whole-branch review 2026-08-06, Important #1 — the discriminating
 *  race test lives in shipping-ticket.test.ts). */
async function claimShipperRow(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Shipper" WHERE "id" = ${id} FOR UPDATE`;
}

/** The `claimOrdersInOrder` shape applied to Shipper rows (#65): deduplicated, ascending, ONE
 *  `SELECT … WHERE id = ANY(…) ORDER BY "id" FOR UPDATE` statement — two voids racing a reversal
 *  pair from opposite ends therefore cannot ABBA, because neither ever holds one pair row while
 *  waiting on the other (a loop of `claimShipperRow` calls, even a sorted loop, reopens that
 *  window between statements; `EXPLAIN` places `LockRows` above `Sort`, so the single statement
 *  locks in the sorted sequence). Used by `voidShipper` for the target + its discovered pair,
 *  uniformly AFTER `claimOrdersInOrder` — the same fixed order (Order rows first, then the
 *  entity's own rows) every mutator in this file shares, so no new ABBA window opens against
 *  them either. Single-row mutators keep `claimShipperRow` above; only the pair-touching void
 *  needs the set form. */
async function claimShipperRows(tx: Prisma.TransactionClient, ids: string[]): Promise<void> {
  const sorted = sortedClaimIds(ids);
  if (sorted.length === 0) return;
  await tx.$queryRaw`SELECT "id" FROM "Shipper" WHERE "id" = ANY(${sorted}) ORDER BY "id" FOR UPDATE`;
}

/** Claims the shipment and everything it spans, in the ONE fixed order every mutator shares, then
 *  404s on missing OR voided — a voided shipment is read-only (the P3 voided-order shape):
 *
 *  1. an UNLOCKED stub read (404 on missing) — it exists only to learn which orders to claim (the
 *     `printShippingTickets` shape: some unlocked read is unavoidable when the first lock lives on
 *     the orders); nothing acted on below is trusted from it;
 *  2. `claimOrdersInOrder` over the shipment's current orders plus `extraOrderIds`
 *     (addOrderToShipper's incoming order — same single ordered statement, so two adds racing
 *     different incoming orders still cannot ABBA);
 *  3. `claimShipperRow` — the Shipper's own row, AFTER the order claims (see its comment);
 *  4. only then the liveness re-read, off a row this transaction actually holds;
 *  5. the #139 pair freeze — see the inline comment.
 *
 *  Returns the fresh shipper row, the shipment's own order ids (the `recomputeOrderStatus` set),
 *  and every claimed Order row so callers can read scalars without a second round trip. */
async function claimLiveShipper(
  tx: Prisma.TransactionClient, id: string, extraOrderIds: string[] = [],
): Promise<{ shipper: Shipper; orderIds: string[]; claimed: Order[] }> {
  const stub = await tx.shipper.findFirst({ where: { id }, select: { id: true } });
  if (!stub) throw new HttpError(404, "Shipment not found");
  const orderIds = await shipperOrderIds(tx, id);
  const claimed = await claimOrdersInOrder(tx, [...orderIds, ...extraOrderIds]);
  await claimShipperRow(tx, id);
  const shipper = await tx.shipper.findFirst({ where: { id } });
  if (!shipper || shipper.deletedAt !== null) throw new HttpError(404, "Shipment not found");

  // #139 freeze-the-pair (owner ruling 2026-08-18, spec §15): while a reversal pair is live, ANY
  // edit to EITHER document is refused naming the pair. This chokepoint is exactly the six edit
  // doors, so the guard here exempts `reverseShipperInTx` (step 6b writes the original's
  // `lineComplete` flags), `voidShipper`'s restore, and both print paths — including `printBol`'s
  // lazy first-print `bolNumber` write — by construction. A reversal is refused ALWAYS, live
  // original or not: it is machine-generated mirror paper, an operator edit of one is never
  // honest, and the unconditional refusal covers corrupt pre-#65 data in the safe direction.
  // LOCK ARGUMENT, per direction — the doors run Serializable with their snapshot fixed at the
  // stub read above, so the claim gives mutual exclusion but does NOT refresh what the reads
  // below can see (the Phase 4 print-vs-void lesson). Three cases:
  //   1. Target IS a reversal: the state is `reversesShipperId` on the claimed row itself —
  //      sound at any isolation.
  //   2. vs `voidShipper` of the counterpart (pair going DEAD): a stale read still sees the
  //      reversal live and refuses an edit that could have proceeded — conservative, safe.
  //   3. vs `reverseShipperInTx` (pair going LIVE): the `liveReversal` read below can miss a
  //      just-committed reversal. The header/membership/line doors are closed by SSI — they
  //      write rows the creation READ (the original's Shipper header, its ShipperOrder set, its
  //      ShipperLine rows), completing the rw-cycle with the predicate read below, so the door
  //      aborts 40001→409. `replaceShipperContainers`/`replaceShipperSerials` write rows the
  //      creation never reads, so one may commit after the reversal — ACCEPTED BY DESIGN: the
  //      outcome is serial-equivalent to editing BEFORE the reversal existed (legal), and the
  //      reversal clones lines only, so its paper and the pair's mirror/ledger invariants are
  //      identical either way. "Frozen from that moment" means commit order — the
  //      publish-by-immutability precedent (§5.1). Do NOT widen this into a pair claim.
  if (shipper.reversesShipperId !== null) {
    const original = await tx.shipper.findFirst({
      where: { id: shipper.reversesShipperId }, select: { shipperNumber: true },
    });
    throw new HttpError(400,
      `This is a reversal of Packing List ${original?.shipperNumber ?? "?"} — a reversal is ` +
      "machine-generated mirror paper; void it and re-reverse instead of editing it");
  }
  // The `voidShipper` blocker's exact read shape, ordered so two live reversals (pre-guard data)
  // would name the same one on every attempt.
  const liveReversal = await tx.shipper.findFirst({
    where: { reversesShipperId: id, deletedAt: null },
    select: { shipperNumber: true }, orderBy: { shipperNumber: "asc" },
  });
  if (liveReversal) {
    throw new HttpError(400,
      `This shipment has been reversed by Packing List ${liveReversal.shipperNumber} — ` +
      "void the reversal first, then edit, then re-reverse");
  }

  return { shipper, orderIds, claimed };
}

/** Resolves one `ShipperOrder` row scoped to this shipment — a `shipperOrderId` from a DIFFERENT
 *  shipment is "not found" here, never silently accepted. */
async function findShipperOrder(tx: Prisma.TransactionClient, shipperId: string, shipperOrderId: string) {
  const so = await tx.shipperOrder.findFirst({
    where: { id: shipperOrderId, shipperId }, select: { id: true, orderId: true },
  });
  if (!so) throw new HttpError(404, "That order is not on this shipment");
  return so;
}

/** Every order currently on the shipment, as a plain id array — the "everyAffectedOrderId" set
 *  every mutator below claims through `claimOrdersInOrder` before it reads or writes anything.
 *  Position-ordered (#52 review round 1, minor 2): claims re-sort and recomputes dedup, so the
 *  ordering costs nothing there, and it makes stored `coveredOrderIds` uniformly the order the
 *  paper itself prints in — matching the backfill's stated contract. */
async function shipperOrderIds(tx: Prisma.TransactionClient, shipperId: string): Promise<string[]> {
  const rows = await tx.shipperOrder.findMany({
    where: { shipperId }, select: { orderId: true }, orderBy: { position: "asc" },
  });
  return rows.map((r) => r.orderId);
}

/**
 * P5A spec §5.7: "voiding or editing a shipment on an order with a finalized invoice is refused —
 * it would change what was billed; the corrections are unlock, or a reversing shipment."
 *
 * Batched over the WHOLE claimed set, not just the one `ShipperOrder` a mutator happens to be
 * touching. A shipment is one document: freight rides the Shipper, and the ticket/BOL a customer
 * already holds describes every order on it — so an edit anywhere on a shipment that carries an
 * invoiced order is refused. Deliberately conservative; over-blocking is undone by unlocking the
 * invoice, whereas under-blocking silently changes paper that has already been billed.
 *
 * Always called on `tx` AFTER `claimLiveShipper` (which claims the orders, then the Shipper row)
 * and before any write — same rule as every other guard in this file: the claim is what makes the
 * answer still true by the time the write lands.
 */
async function refuseIfInvoiced(
  tx: Prisma.TransactionClient, orderIds: string[], action: string,
): Promise<void> {
  // `finalizedInvoicesFor` sorts by order number, so a shipment carrying two invoiced orders names
  // the same one on every attempt.
  const [inv] = await finalizedInvoicesFor(tx, orderIds);
  if (inv) throw new HttpError(400, invoiceBlockMessage(inv, action));
}

// -------------------------------------------------------------------------------------------
// updateShipper: header only (customerId, clientRequestId, shipperNumber and bolNumber are all
// immutable — the first because every order on the shipment is validated against it at add-time
// (spec: "refuses an order belonging to a different customer"), letting it change would silently
// invalidate that check for every order already attached).
// -------------------------------------------------------------------------------------------

const UPDATE_SHIPPER = z.object({
  shipToAddressId: z.string().min(1).nullable().optional(),
  shipDate: z.string().min(1).optional(),
  carrierId: z.string().min(1).nullable().optional(),
  route: z.string().max(200).optional(),
  comments: z.string().max(4000).optional(),
  billFreight: z.boolean().optional(),
  freightAmount: decimalBoxField(FREIGHT_AMOUNT.box),
  freightTerms: z.enum(FREIGHT_TERMS).optional(),
  freightClass: z.string().max(30).optional(),
  freightDescription: z.string().max(200).optional(),
  packageCount: z.number().int().min(0).max(INT4_MAX).nullable().optional(),
  proNumber: z.string().max(30).optional(),
  scacCode: z.string().max(30).optional(),
}).strict();

export async function updateShipper(id: string, input: unknown): Promise<ShipperDetail> {
  const data = UPDATE_SHIPPER.parse(input);

  return withDbErrors({ entity: "Shipper" }, () => prisma.$transaction(async (tx) => {
    const { shipper, orderIds } = await claimLiveShipper(tx, id);

    // Guard ONLY when the patch touches a BILLED field (fix wave 1, controller-approved scope
    // extension of Task 10). `freightAmount`/`billFreight` are the only two fields of this patch
    // the pricing engine reads (`PricingInput.freight`, pricing.ts) — `freightTerms`/
    // `freightClass`/`freightDescription`/`proNumber`/`scacCode`/`route`/`comments`/etc. are
    // descriptive shipping-doc fields the engine never touches. A header-only edit (route,
    // comments, ship-to, …) on an invoiced shipment must stay allowed — over-blocking a comment
    // edit would be a real usability regression the brief specifically calls out.
    if (data.billFreight !== undefined || data.freightAmount !== undefined) {
      await refuseIfInvoiced(tx, orderIds, INVOICE_FREEZE.changeFreight);
    }

    if (data.shipToAddressId) {
      const addr = await tx.customerAddress.findFirst({
        where: { id: data.shipToAddressId, customerId: shipper.customerId, kind: "SHIP_TO", deletedAt: null },
        select: { id: true },
      });
      if (!addr) throw new HttpError(400, "That ship-to address does not exist");
    }
    if (data.carrierId) await assertRefExists("carrier", data.carrierId, tx);

    const patch: Prisma.ShipperUncheckedUpdateInput = {
      ...(data.shipToAddressId !== undefined ? { shipToAddressId: data.shipToAddressId } : {}),
      ...(data.shipDate !== undefined ? { shipDate: parseDate(data.shipDate, "Ship date") } : {}),
      ...(data.carrierId !== undefined ? { carrierId: data.carrierId } : {}),
      ...(data.route !== undefined ? { route: data.route } : {}),
      ...(data.comments !== undefined ? { comments: data.comments } : {}),
      ...(data.billFreight !== undefined ? { billFreight: data.billFreight } : {}),
      ...(data.freightAmount !== undefined ? { freightAmount: data.freightAmount } : {}),
      ...(data.freightTerms !== undefined ? { freightTerms: data.freightTerms } : {}),
      ...(data.freightClass !== undefined ? { freightClass: data.freightClass } : {}),
      ...(data.freightDescription !== undefined ? { freightDescription: data.freightDescription } : {}),
      ...(data.packageCount !== undefined ? { packageCount: data.packageCount } : {}),
      ...(data.proNumber !== undefined ? { proNumber: data.proNumber } : {}),
      ...(data.scacCode !== undefined ? { scacCode: data.scacCode } : {}),
    };

    await auditedUpdate("shipper", id, () => tx.shipper.update({ where: { id }, data: patch }), { tx });
    await recomputeOrderStatus(tx, orderIds);
    return readShipperDetail(tx, id);
    // STANDING INVARIANT (the stale-draft guard, stated above `claimShipperRow`): this stays
    // Serializable, or a draft invoice calculated before this change can be finalized silently.
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/**
 * The §5.4 credit-hold gate, extended to shipment EXTENSION (owner ruling 2026-08-06, MR !47
 * round 3): `addOrderToShipper` and `replaceShipperLines` are the two paths that add shipped
 * work, so a hold set AFTER a shipment exists gates them exactly as creation is gated — named +
 * linked refusal; `override_credit_hold` plus a reason (returned for the mutator's audit entry,
 * printed nowhere) proceeds. Read on `tx` AFTER the claims, so the hold state is fresh.
 */
async function creditHoldGate(
  tx: Prisma.TransactionClient, customerId: string,
  opts: { canOverrideCreditHold: boolean }, reason: string | undefined,
): Promise<string | undefined> {
  // The order-locks.ts house rule (round-6 finding): `creditHold` lives on the Customer row, so
  // the row is CLAIMED before the read — a hold committed concurrently touches no order/shipper
  // row and was otherwise invisible to this gate. Always the LAST claim (Orders → Shipper →
  // Customer; setCustomer-side writers lock only their own row, so no ABBA window).
  await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${customerId} FOR UPDATE`;
  const customer = await tx.customer.findFirst({
    where: { id: customerId }, select: { id: true, code: true, name: true, creditHold: true },
  });
  if (!customer || !customer.creditHold) return undefined;
  if (!opts.canOverrideCreditHold) {
    throw new HttpError(400,
      `${customer.code} · ${customer.name} is on credit hold — see /customers/${customer.id} to lift it`);
  }
  const trimmed = (reason ?? "").trim();
  if (!trimmed) throw new HttpError(400, "A reason is required to override a credit hold");
  return trimmed;
}

/**
 * Attaches one more order of the SAME customer to the shipment (spec §4.2's emergent multi-order
 * shipment) — its own `sequence` (this order's Nth shipment ever, `nextShipmentSequence`) and the
 * next `position` (print order of the tickets, `MAX(position) + 1`; positions stay contiguous
 * 1..N by construction — appends never collide with an existing position, so unlike
 * `removeOrderFromShipper` this needs no two-phase renumber). No lines/containers/serials are
 * populated here — those come from the three replace calls below, once the order shell exists.
 *
 * Task 9 review (2026-08-04): the duplicate-order check and the `position` number are read AFTER
 * the claims, never from `claimLiveShipper`'s bare pre-claim stub reads — those exist ONLY to know
 * which orders to claim (some unlocked read is unavoidable to learn that; the incoming order rides
 * the same single ordered claim statement via `extraOrderIds`). Computing
 * `position` fresh at the point of use, the `nextShipmentSequence` idiom (ship-ledger.ts), rather
 * than trusting a value captured before the claim. A residual collision (two adds racing on the
 * same shipment, serialized through the row lock but still landing on `@@unique([shipperId,
 * position])` or `@@unique([shipperId, orderId])`) is mapped to the SAME honest "try again" 409
 * `withDbErrors` already gives a genuine Serializable conflict (P2034) elsewhere in this codebase
 * — not the generic, mislabelled `withDbErrors` P2002 fallback the Task 8 review's own lesson
 * warns against ("a refusal naming a problem that did not exist").
 */
export async function addOrderToShipper(
  id: string, orderId: string,
  opts: { canOverrideCreditHold: boolean } = { canOverrideCreditHold: false },
  creditHoldReason?: string,
): Promise<ShipperDetail> {
  return withDbErrors({ entity: "Shipper" }, () => prisma.$transaction(async (tx) => {
    const { shipper, claimed } = await claimLiveShipper(tx, id, [orderId]);
    const overrideReason = await creditHoldGate(tx, shipper.customerId, opts, creditHoldReason);
    const allOrderIds = claimed.map((o) => o.id); // current orders + the incoming one, deduplicated
    const order = claimed.find((o) => o.id === orderId);
    if (!order) throw new HttpError(404, "Order not found");
    if (order.deletedAt !== null) throw new HttpError(400, `Order #${order.orderNumber} has been voided`);
    if (order.customerId !== shipper.customerId) {
      throw new HttpError(400, `Order #${order.orderNumber} does not belong to the same customer as this shipment`);
    }

    // Over `allOrderIds` — the shipment's current orders AND the incoming one. Both directions are
    // real: adding any order changes a shipment whose other orders are already billed, and adding
    // an ALREADY-invoiced order bolts new shipped quantity onto an order whose paper is closed.
    // After the resolution checks above so a bogus/foreign/voided orderId still gets its own,
    // truer message; before the duplicate check and every write.
    await refuseIfInvoiced(tx, allOrderIds, INVOICE_FREEZE.changeShipment);

    const dup = await tx.shipperOrder.findFirst({ where: { shipperId: id, orderId }, select: { id: true } });
    if (dup) throw new HttpError(400, "That order is already on this shipment");

    const { _max } = await tx.shipperOrder.aggregate({ where: { shipperId: id }, _max: { position: true } });
    const position = (_max.position ?? 0) + 1;
    const sequence = await nextShipmentSequence(tx, orderId);

    try {
      await auditedUpdate("shipper", id, () => tx.shipperOrder.create({
        data: { shipperId: id, orderId, sequence, position },
        select: { id: true },
      }), { tx, ...(overrideReason ? { reason: overrideReason } : {}) });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new HttpError(409, "Another change to this shipment was saved at the same time — please try again");
      }
      throw err;
    }

    // The saveNewShipper rule (spec §6.2), symmetric with `removeOrderFromShipper`'s void: an
    // order whose frozen scope is SHIPMENT gets its shipment-scope cert the moment it joins the
    // shipment, eagerly rather than on demand. (Until #165 this comment also said nothing else
    // COULD create one later, because every HTTP cert route refused a client-supplied
    // `shipperId`. That still holds — `shipperId` is still never read off a body — but
    // `POST /api/shippers/[id]/certs` now resolves one from its PATH, so a cert voided in error
    // or missed by a scope change can be raised by hand. This eager create is unchanged: it is
    // what keeps the normal case from needing that.) The order is already claimed
    // (`extraOrderIds` above) and the shipper row is claim-held live, so `createCert` can never
    // see a voided shipperId.
    if (order.certRequired && order.certScope === "SHIPMENT") {
      await createCert({ orderId, scope: "SHIPMENT", shipperId: id }, tx);
    }

    await recomputeOrderStatus(tx, allOrderIds);
    return readShipperDetail(tx, id);
    // STANDING INVARIANT (the stale-draft guard, stated above `claimShipperRow`): this stays
    // Serializable, or a draft invoice calculated before this change can be finalized silently.
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/**
 * Two-phase negative-park rewrite of `ShipperOrder.position` for one shipment's SURVIVING rows,
 * against `@@unique([shipperId, position])` — the `applyLoads` precedent (order-loads.ts): every
 * remaining row is first parked at a unique NEGATIVE position (index-derived, distinct by
 * construction), and only then rewritten to its real 1..N target, in the same relative order it
 * already had. A direct decrement-in-place would also happen to be safe for this specific "close
 * the gap left by one removed row" shape (each row's target is vacated by the row ahead of it
 * moving first) — the two-phase park is used anyway, uniformly, so this function's correctness
 * never depends on which particular renumber shape called it.
 */
async function renumberShipperOrderPositions(tx: Prisma.TransactionClient, shipperId: string): Promise<void> {
  const rows = await tx.shipperOrder.findMany({
    where: { shipperId }, orderBy: { position: "asc" }, select: { id: true },
  });
  for (const [index, row] of rows.entries()) {
    await tx.shipperOrder.update({ where: { id: row.id }, data: { position: -(index + 1) } });
  }
  for (const [index, row] of rows.entries()) {
    await tx.shipperOrder.update({ where: { id: row.id }, data: { position: index + 1 } });
  }
}

/**
 * Which of `orderIds` printed paper pins to this shipment (#472, owner ruling R-Q2 of 2026-10-08).
 *
 * `paperOrderIds`: a ticket or bill of lading of THIS shipment names the order, either by its own
 * ticket (`orderId` = that order) or by a whole-set document — ticket or BOL, `orderId: null` —
 * whose RECORDED coverage names it (`coveredOrderIds`, the same branch `listDocumentsForOrder`
 * reads; #140, owner ruling 2026-08-18). An order added after a whole-set print is not on that
 * paper; pre-#52 backfilled rows over-cover (current-at-migration membership), the safe direction.
 *
 * `certOrderIds`: a print exists of the order's certification for this shipment. CERT documents
 * never carry `shipperId` (the DB CHECK), so that half goes through the certification's own row.
 * Deliberately unfiltered on the certification's `deletedAt` — a voided cert's stored print still
 * exists forever (spec §5.6), and it carries the order's `orderNumber-sequence` all the same.
 *
 * Two reads, each with an index to use, and none for an empty list. The first is this shipment's
 * tickets and bills of lading, found by `StoredDocument.shipperId`
 * (`StoredDocument_shipperId_idx`). The second is this shipment's certifications, found by
 * `Cert.shipperId` (`Cert_shipperId_idx`), each kept only when a stored print of it exists
 * (`StoredDocument.certId`, `StoredDocument_certId_idx`). They ask what
 * `removeOrderFromShipper`'s own two reads asked before #472. In each, `shipperId` decides, and
 * so does the stored-print test in the second; the `orderId` and coverage filters only narrow
 * what is fetched to the orders asked about, and `printedOrdersFrom` (the leaf) decides which
 * order each row pins.
 *
 * Keep them two. One `storedDocument.findMany` with an OR across both halves was built first and
 * measured on 2026-10-08 (EXPLAIN on the test database): its plan has no index condition on
 * `StoredDocument`, with sequential scans disabled as well, so that statement visits every row
 * of this permanent, append-only table. It would run with every shipment response, and inside the
 * removal's Serializable transaction, where a whole-table read widens what a print committing
 * beside it can conflict with.
 *
 * What was measured of the two reads, and what was not (EXPLAIN of the statements Prisma logs,
 * 2026-10-08). An index path exists for both: with sequential scans disabled the first plans as
 * an index scan of `StoredDocument_shipperId_idx`, and the second as `Cert_shipperId_idx` with
 * an index-only scan of `StoredDocument_certId_idx`. The one-query form has none. Which plan
 * the planner picks on a table of production size was not measured, because the test database's
 * two tables were empty. On those empty tables, with default planner settings, the second read
 * scanned `StoredDocument` sequentially in every reading, and the first did as well once the
 * table had been analysed as empty. So on an empty or small table these reads scan
 * `StoredDocument`, inside the removal's Serializable transaction too.
 *
 * It has two callers and asks both the same question. `removeOrderFromShipper` calls it on its
 * `tx`, under its claims, for the one order it is about to remove. `shipperResponse`
 * (src/app/api/shippers/response.ts) calls it on the top-level client after the mutation has
 * committed, for every order, so the page can grey Remove order out before the click. It is NOT
 * called from `readShipperDetail`: that function runs at the tail of every mutator's Serializable
 * transaction and inside both print transactions, and the ruling adds no read there.
 * `removeOrderFromShipper` is the one transaction that runs it, in place of the two reads it made
 * before.
 */
export async function readPrintedOrders(
  db: Prisma.TransactionClient, shipperId: string, orderIds: string[],
): Promise<PrintedOrders> {
  if (orderIds.length === 0) return printedOrdersFrom([], orderIds);
  const paper = await db.storedDocument.findMany({
    where: {
      shipperId,
      OR: [{ orderId: { in: orderIds } }, { orderId: null, coveredOrderIds: { hasSome: orderIds } }],
    },
    select: { orderId: true, coveredOrderIds: true },
  });
  // Driven from the certification, not from its documents. A document that carries a `certId` is
  // a CERT document (the DB CHECK), so "has any document" is "has a stored print".
  const printedCerts = await db.cert.findMany({
    where: { shipperId, orderId: { in: orderIds }, documents: { some: {} } },
    select: { orderId: true },
  });
  const docs: PinningDocument[] = [
    ...paper.map((d) => ({ orderId: d.orderId, coveredOrderIds: d.coveredOrderIds, certOrderId: null })),
    ...printedCerts.map((c) => ({ orderId: null, coveredOrderIds: [], certOrderId: c.orderId })),
  ];
  return printedOrdersFrom(docs, orderIds);
}

/**
 * The shipment's ship-to address as each shipment answer carries it (#484, owner ruling
 * 2026-10-15): its name, street, city, state and zip, and nothing else. Read by id alone, with no
 * filter on `deletedAt` or `active`, as `readShippingTicketData` and `readBolData` read it for the
 * paper: the shipment references the row, so an address since made inactive or deleted is still
 * the shipment's own. The name is sent as stored; the paper's fallback to the customer's name for
 * a blank one is the paper's. No address set asks nothing.
 *
 * It has one caller, `shipperResponse` (src/app/api/shippers/response.ts), which calls it on the
 * top-level client after the mutation has committed, beside `readPrintedOrders`. It is NOT called
 * from `readShipperDetail`, and the address is not in `DETAIL_INCLUDE`: those run at the tail of
 * every shipment mutator's Serializable transaction (`createShipper`'s save, `updateShipper`,
 * `addOrderToShipper`, `removeOrderFromShipper`, the three replaces, `reverseShipperInTx`) and
 * inside both print transactions (`printShippingTickets`, `printBol`), and the ruling adds no read
 * there. relationJoins is not among the schema's preview features, so an include there would be
 * one more query inside each of them. The ticket and the bill of lading keep their own read.
 */
export async function readShipToAddress(db: Db, shipToAddressId: string | null): Promise<ShipToAddress | null> {
  if (shipToAddressId === null) return null;
  return db.customerAddress.findFirst({
    where: { id: shipToAddressId },
    select: { name: true, street: true, city: true, state: true, zip: true },
  });
}

/**
 * Removes one order from the shipment (spec §4.2/§5.5). `ShipperOrder` carries no `deletedAt` of
 * its own (spec §4.2), so removal HARD-deletes the row — and frees its `sequence`, which is
 * exactly the hazard spec §5.5 was tightened for (2026-08-04, Task 2 review): a later shipment of
 * that same order would then be handed a number already printed on a customer's paperwork. Refused
 * outright once a shipping ticket exists NAMING this order — either its own (`orderId` = this
 * order) or a whole-set print whose recorded `coveredOrderIds` include it (#140) — naming the
 * document and pointing at the correct fix: void the shipment instead, which keeps every sequence
 * claimed forever (spec §5.6) rather than freeing one back into circulation.
 *
 * **Also voids that order's own SHIPMENT-scope cert, if it has one (spec §5.6, 2026-08-04
 * amendment — recorded after a review caught the gap this closes).** Once the order leaves the
 * shipment, nothing on it still names that order's parts — the cert is orphaned regardless of
 * locking. Doing it HERE, under the claim this function already holds for `target.orderId`
 * (`orderIds` above includes it, via `claimOrdersInOrder`), rather than leaving it for
 * `voidShipper`'s own cascade to find later, is what keeps `voidShipper` provably correct: its own
 * claim only ever covers the orders STILL on the shipment when IT runs, and would otherwise have
 * to write a `deletedAt` onto a cert belonging to an order it never claimed — see `voidShipper`'s
 * own doc comment for the full argument this closes.
 *
 * Children are deleted explicitly before the parent row — `ShipperLine`/`Container`/`Serial` are
 * all `ON DELETE RESTRICT` from `ShipperOrder` (migration.sql), so a bare `shipperOrder.delete`
 * would fail with a foreign-key violation while any child row survives it (the `removeLine`
 * precedent, orders.ts, for the identical `OrderSerial -> OrderLine` RESTRICT shape).
 */
export async function removeOrderFromShipper(id: string, shipperOrderId: string): Promise<ShipperDetail> {
  return withDbErrors({ entity: "Shipper" }, () => prisma.$transaction(async (tx) => {
    const { shipper, orderIds } = await claimLiveShipper(tx, id);
    const target = await findShipperOrder(tx, id, shipperOrderId);

    // The refusals are decided in one place since #472: `removeOrderRefusal`
    // (src/lib/shipment-remove-order.ts) holds their order and their words, and the shipment page
    // calls it over what it last read to grey Remove order out with the same sentence. This
    // function reads the facts, all on `tx`. The claims above give mutual exclusion, and they do
    // not make these reads fresh: this transaction's snapshot was fixed at `claimLiveShipper`'s
    // stub read, before it held a claim (the LOCK ARGUMENT in that function). What holds the
    // printed-paper facts against a print that commits beside this removal is two-sided SSI: this
    // door runs Serializable, and so do `printShippingTickets`, `printBol` and `printCert`
    // (certs.ts).

    // Any shipment-owned paper NAMING this order, and a print of its shipment-scope certification:
    // two reads, each with an index to use, the two questions this function asked on its own
    // before #472, now behind
    // the one function `shipperResponse` also calls. `readPrintedOrders` states both queries and
    // why each is shaped as it is.
    const printed = await readPrintedOrders(tx, id, [target.orderId]);

    // The exact mirror of `addOrderToShipper`'s guard (fix wave 1, controller-approved scope
    // extension of Task 10): removing an order from the shipment removes THAT order's shipped
    // quantity — exactly what a finalized invoice already billed. Scoped to `target.orderId`
    // alone, not the whole claimed set, because this is the one order whose billed facts this
    // write actually changes; the other survivors' shipped quantity is untouched by this call.
    // These are the rows the stale-draft STANDING INVARIANT (above `claimShipperRow`) calls
    // `refuseIfInvoiced`'s finalized-invoice read, read here directly. The read stays on `tx`.
    const [invoice] = await finalizedInvoicesFor(tx, [target.orderId]);

    // The other half of §4.2's invariant, the replaceShipperLines shape: the SURVIVING orders
    // must still carry a positive-qty line — an order that joined with no lines yet must not be
    // what "another order remains" hangs on.
    const survivorPositive = await tx.shipperLine.findFirst({
      where: { qty: { gt: 0 }, shipperOrder: { shipperId: id, id: { not: shipperOrderId } } },
      select: { id: true },
    });

    const refusal = removeOrderRefusal({
      shipperNumber: shipper.shipperNumber,
      // Spec §4.2: removing the LAST order leaves `orders: []`, a document about nothing in the
      // strongest sense. Void the shipment is the correct correction (§5.6): it keeps every
      // sequence claimed forever, exactly like the printed-paper refusal.
      orderCount: orderIds.length,
      paperPrinted: printed.paperOrderIds.includes(target.orderId),
      invoice: invoice ? { invoiceId: invoice.id, orderNumber: invoice.orderNumber } : null,
      survivorHasPositiveLine: survivorPositive !== null,
      certPrinted: printed.certOrderIds.includes(target.orderId),
    });
    if (refusal !== null) throw new HttpError(400, refusal);

    // Void this order's own SHIPMENT-scope cert, if it has one — see this function's own doc
    // comment for why HERE, not deferred to `voidShipper`'s cascade. A DIFFERENT audit entity
    // ("cert", not "shipper"), so a separate `auditedSoftDelete` call, not folded into the
    // `auditedUpdate("shipper", …)` below. At most one live row can match (createCert's own
    // scope-instance uniqueness, certs.ts), so this is a find-and-void of at most one row.
    const orphanedCert = await tx.cert.findFirst({
      where: { orderId: target.orderId, shipperId: id, deletedAt: null }, select: { id: true },
    });
    if (orphanedCert) {
      await auditedSoftDelete("cert", orphanedCert.id,
        `Order removed from shipment (Packing List ${shipper.shipperNumber})`, tx);
    }

    await auditedUpdate("shipper", id, async () => {
      await tx.shipperLine.deleteMany({ where: { shipperOrderId } });
      await tx.shipperContainer.deleteMany({ where: { shipperOrderId } });
      await tx.shipperSerial.deleteMany({ where: { shipperOrderId } });
      await tx.shipperOrder.delete({ where: { id: shipperOrderId } });
      await renumberShipperOrderPositions(tx, id);
    }, { tx });

    await recomputeOrderStatus(tx, orderIds);
    return readShipperDetail(tx, id);
    // STANDING INVARIANT (the stale-draft guard, stated above `claimShipperRow`): this stays
    // Serializable, or a draft invoice calculated before this change can be finalized silently.
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/**
 * The over-ship half of spec §5.7's warnings, computed straight off an already-built
 * `ShipperDetail` rather than re-deriving `shippedTotals` a second time: a line's own
 * `shippedToDateQty`/`shippedToDateWeight` already sum every LIVE shipment for that order line,
 * INCLUDING this one (`readShipperDetail`'s own `shippedTotals` call), so "the running total now
 * exceeds what was ordered" is algebraically the identical fact `saveNewShipper`'s own warning
 * checks against the qty/weight remaining BEFORE that save (shipped-to-date = prior + this
 * shipment's own qty; `thisQty > ordered - prior` rearranges to exactly `prior + thisQty >
 * ordered`, i.e. `shippedToDateQty > orderedQty`). Exported so any mutator that hands back a fresh
 * `ShipperDetail` can report the warning without a second round trip — `replaceShipperLines` is
 * the one that can newly trigger it, since it is the one call that changes a shipped qty/weight.
 */
export function overshipWarnings(detail: ShipperDetail): string[] {
  const warnings: string[] = [];
  for (const so of detail.orders) {
    for (const line of so.lines) {
      // #508: compared in whole cents, printed in the screens' form.
      if (line.shippedToDateQty > line.orderedQty ||
          Math.round(line.shippedToDateWeight * 100) > Math.round(line.orderedWeight * 100)) {
        warnings.push(
          `Order #${so.orderNumber} line ${line.linePosition} (${line.partNumber}): shipped-to-date ` +
          `${formatNumber(line.shippedToDateQty)} / ${formatNumber(line.shippedToDateWeight, 2)} lb exceeds the ` +
          `${formatNumber(line.orderedQty)} / ${formatNumber(line.orderedWeight, 2)} lb ordered`);
      }
    }
  }
  return warnings;
}

/**
 * EVERY §5.7 warning derivable from a fresh `ShipperDetail` (#50/#54): the scope-matched
 * missing-cert warning (#53's rule), unserialized serialization-required lines, and over-ship —
 * the same advisory surface creation computes, recomputable at any later moment. Consumed by the
 * idempotent-replay path (a lost-response retry must not silently drop the warnings the original
 * response carried) and by `shipperResponse`, so every edit response carries the full surface
 * rather than over-ship alone. Released rows (null order-side ids) contribute nothing — their
 * order-side rows are gone, so there is nothing left to warn about.
 */
export async function shipmentWarnings(db: Db, detail: ShipperDetail): Promise<string[]> {
  const orderIds = detail.orders.map((o) => o.orderId);
  const orders = await db.order.findMany({
    where: { id: { in: orderIds } },
    select: { id: true, certRequired: true, certScope: true },
  });
  const orderById = new Map(orders.map((o) => [o.id, o]));

  const liveCerts = await db.cert.findMany({
    where: { orderId: { in: orderIds }, deletedAt: null },
    select: { orderId: true, scope: true, shipperId: true },
  });
  const certSatisfied = new Set(
    liveCerts.filter((c) => {
      const order = orderById.get(c.orderId);
      if (!order || c.scope !== order.certScope) return false;
      return c.scope !== "SHIPMENT" || c.shipperId === detail.id;
    }).map((c) => c.orderId),
  );

  const lineIds = detail.orders.flatMap((so) => so.lines.map((l) => l.orderLineId))
    .filter((id): id is string => id !== null);
  const lines = lineIds.length === 0 ? [] : await db.orderLine.findMany({
    where: { id: { in: lineIds } },
    select: { id: true, position: true, part: { select: { partNumber: true, serializationRequired: true } } },
  });
  const lineById = new Map(lines.map((l) => [l.id, l]));
  // A RELEASED selection (orderSerialId nulled by snapshot + release) still satisfies its line
  // (!57 review): the shipment displays and prints that serial, so the line linkage rides the
  // `orderLineIdAtSave` snapshot — live rows prefer the live join, same convention as reads.
  const shipSerials = await db.shipperSerial.findMany({
    where: { shipperOrder: { shipperId: detail.id } },
    select: {
      orderLineIdAtSave: true, orderSerialId: true, serial: true,
      orderSerial: { select: { lineId: true } },
    },
  });
  const serialLineIds = new Set(
    shipSerials.map((sr) => sr.orderSerial?.lineId ?? sr.orderLineIdAtSave).filter((id) => id !== ""),
  );

  const warnings: string[] = [];
  const isReversal = detail.reversesShipperId !== null;
  for (const so of detail.orders) {
    const order = orderById.get(so.orderId);
    // #183: on a REVERSAL, a SHIPMENT-scope order can never carry a cert (createCert refuses it, the
    // picker omits it), so "requires a certification ... see /orders/N" would be a permanently
    // unactionable warning on every reversal page load — suppress it there (the resolveShipmentCerts
    // print-path exemption's page-view twin). ORDER/LOAD scope still warn (creatable regardless).
    const certUnreachable = isReversal && order?.certScope === "SHIPMENT";
    if (order?.certRequired && !certSatisfied.has(so.orderId) && !certUnreachable) {
      warnings.push(
        `Order #${so.orderNumber} requires a certification and none exists yet — see /orders/${so.orderId}`);
    }
    for (const l of so.lines) {
      if (l.orderLineId === null) continue;
      const line = lineById.get(l.orderLineId);
      if (line?.part.serializationRequired && !serialLineIds.has(l.orderLineId)) {
        warnings.push(
          `Order #${so.orderNumber} line ${line.position} (${line.part.partNumber}): ` +
          "requires serialization but no serial numbers were selected for this shipment");
      }
    }
  }
  // A VOIDED shipment derives none of this (Codex, MR !130). "Voided shipments do not count" was
  // applied to the MATCHED side only — the other shipment is filtered on `deletedAt` inside
  // `otherShipmentsWith` — but the CURRENT one never was, so opening a withdrawn packing list whose
  // serial also sits on a live one still produced the advisory: telling read-only history to fix
  // something it cannot, and implicating a document that has already been withdrawn.
  if (detail.deletedAt === null) {
    warnings.push(...reshippedSerialWarnings(await otherShipmentsWith(db, detail.id,
      shipSerials
        .map((sr) => ({ lineId: sr.orderSerial?.lineId ?? sr.orderLineIdAtSave, serial: sr.serial }))
        // A row released BEFORE migration 20260806164109 carries neither a live join nor a line
        // snapshot (`""` — the migration says so), so it has no identity to match on. There are no
        // such rows in this deployment (the app has never been in production) and none can be
        // created now, since every write since that migration populates the snapshot.
        .filter((k) => k.lineId !== ""))));
  }
  warnings.push(...overshipWarnings(detail));
  return warnings;
}

/** One serial that appears on ANOTHER live shipment as well as this one. */
type ReshippedSerial = { serial: string; shipperId: string; shipperNumber: number; shipDate: Date };

/** The stable identity of a selected serial: which ORDER LINE it belongs to, and its number.
 *  `orderSerialId` cannot serve — see `otherShipmentsWith`. */
type SerialKey = { lineId: string; serial: string };

const serialKeyOf = (k: SerialKey): string => `${k.lineId}\u0000${k.serial}`;

/**
 * Where else do THIS shipment's serials appear? (Issue #125, owner ruling 2026-08-16: warn, never
 * block — refined 2026-08-16 after three findings on MR !130.)
 *
 * **Derived, not stored.** A selection IS the record that the serial went out, so the join below is
 * the whole mechanism and the schema is untouched.
 *
 * **Keyed on (order line, serial text), NOT on `orderSerialId`.** `replaceSerials` DELETES and
 * recreates every `OrderSerial`, nulling the earlier `ShipperSerial.orderSerialId` by snapshot +
 * release — so an id-keyed match lost the prior shipment entirely and the recreated serial could go
 * out again unwarned. The line plus the number survives that, and scoping to the LINE is what makes
 * the serial TEXT safe to match on (a line belongs to one order, one customer, one part), which was
 * the original reason for avoiding it. Released rows still carry both halves: `orderLineIdAtSave` is
 * the plain line snapshot kept for exactly this class of problem, and `serial` is the frozen number.
 *
 * **Every other live shipment, not just earlier ones — and the sentence says "also appears on".**
 * The first draft said "has ALREADY shipped on …" and excluded only the current shipment, which made
 * the relation SYMMETRIC and reversed history: re-reading the ORIGINAL ticket accused it of
 * duplicating its own successor. Bounding on an earlier `shipperNumber` fixed that and broke
 * something else, because packing-list order records DOCUMENT creation, not when a serial was
 * selected during an EDIT — `replaceShipperSerials` on an older ticket can newly add a serial a
 * higher-numbered ticket already holds, and a `lt` filter ignores it. Distinguishing those would
 * need a `ShipperSerial.createdAt` column; the owner ruled for the symmetric wording instead, so
 * both documents carry an advisory that is true from either side. That is the right reading anyway:
 * a duplicate involves BOTH tickets.
 *
 * A VOIDED shipment does not count — `deletedAt` on the Shipper, the same "voided blocks nothing"
 * rule as every other guard here. Ascending by ship date, then packing list, so the sentence is
 * stable across repeat reads.
 */
async function otherShipmentsWith(
  db: Db, shipperId: string, keys: SerialKey[],
): Promise<ReshippedSerial[]> {
  if (keys.length === 0) return [];
  const wanted = new Set(keys.map(serialKeyOf));
  const lineIds = [...new Set(keys.map((k) => k.lineId))];
  const serials = [...new Set(keys.map((k) => k.serial))];
  // BOTH halves filtered in SQL (Codex, MR !130): `lineId IN (…) AND serial IN (…)`. Filtering on
  // the line alone fetched and materialised every ShipperSerial ever recorded for that line and
  // rejected the rest in JS — and, the sharper point, it left the new
  // `(orderLineIdAtSave, serial)` index unable to use its second column, since the predicate never
  // mentioned `serial`.
  //
  // The JS membership check below still has to run and is NOT redundant: two `IN` lists are a
  // CROSS PRODUCT, so SQL can return a (line A, serial from line B) row that was never actually
  // asked for. SQL narrows to a small candidate set; `wanted` enforces the exact PAIRING.
  const rows = await db.shipperSerial.findMany({
    where: {
      serial: { in: serials },
      OR: [{ orderLineIdAtSave: { in: lineIds } }, { orderSerial: { lineId: { in: lineIds } } }],
      shipperOrder: { shipperId: { not: shipperId }, shipper: { deletedAt: null } },
    },
    select: {
      serial: true,
      orderLineIdAtSave: true,
      orderSerial: { select: { lineId: true } },
      shipperOrder: {
        select: { shipper: { select: { id: true, shipperNumber: true, shipDate: true } } },
      },
    },
    orderBy: [
      { shipperOrder: { shipper: { shipDate: "asc" } } },
      { shipperOrder: { shipper: { shipperNumber: "asc" } } },
      { serial: "asc" },
    ],
  });
  // ONE entry per (serial, shipment), not per matched ROW (Codex, MR !130).
  // `replaceShipperSerials` deliberately PRESERVES a released row while adding the new live one
  // (snapshot + release — the shipment still prints that serial), so one packing list can legitimately
  // hold several rows for the same (line, serial), and each further replacement adds another. A
  // one-for-one map then repeated the identical sentence once per row. First occurrence wins, which
  // keeps the query's ship-date ordering.
  const seen = new Set<string>();
  const out: ReshippedSerial[] = [];
  for (const r of rows) {
    const lineId = r.orderSerial?.lineId ?? r.orderLineIdAtSave;
    if (!wanted.has(serialKeyOf({ lineId, serial: r.serial }))) continue;
    const shipper = r.shipperOrder.shipper;
    const dedupeKey = `${shipper.id}\u0000${r.serial}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      serial: r.serial,
      shipperId: shipper.id,
      shipperNumber: shipper.shipperNumber,
      shipDate: shipper.shipDate,
    });
  }
  return out;
}

/** §5.14 — the warning names its cause: which serial, which packing list, when, and a link to it.
 *  "also appears on", not "cannot ship" and not "has already shipped": the ruling refused to block
 *  (a returned part legitimately goes back out, and there is no return/RMA concept to unblock a
 *  refusal with), and the neutral wording is what makes the same sentence honest on BOTH documents.
 *  Pure over the rows, so the sentence is testable on its own. */
function reshippedSerialWarnings(prior: ReshippedSerial[]): string[] {
  return prior.map((p) =>
    `Serial ${p.serial} also appears on Packing List ${p.shipperNumber} ` +
    `(${formatDateOnly(p.shipDate)}) — see /shipping/${p.shipperId}`);
}

/**
 * The close-short flag as it is stored (final review 2026-10-06). `ShipperLine.lineComplete` means a
 * person closed a line that shipped under its ordered quantity, so a tick on a row that finishes its
 * line by quantity is stored unticked: left in place it would keep the line complete after the
 * ordered quantity is later raised. The screens already strip that tick (`shipment-line-save.ts`,
 * `new-shipment-recovery.ts`); this covers an API caller and a screen holding a stale ordered
 * quantity. `otherShippedQty` is the live quantity on every OTHER shipment's lines for the order
 * line, read on the caller's transaction under its order claim. The comparison is `lineIsComplete`,
 * so the rule is not restated here.
 */
function storedCloseShort(
  row: { qty: number; lineComplete: boolean }, orderedQty: number, otherShippedQty: number,
): boolean {
  return row.lineComplete
    && !lineIsComplete({ orderedQty, shippedQty: otherShippedQty + row.qty, closedShort: false });
}

/**
 * Bulk PUT of one `ShipperOrder`'s lines — delete-then-recreate at positions 1..n (the
 * `replaceSerials` precedent, order-edit.ts). Over-shipping still warns and never
 * blocks (spec §5.7): `overshipWarnings` above is what a caller uses to see it in the fresh detail
 * this function returns.
 */
export async function replaceShipperLines(
  id: string, shipperOrderId: string, input: unknown,
  opts: { canOverrideCreditHold: boolean } = { canOverrideCreditHold: false },
): Promise<ShipperDetail> {
  // A bare array (the original shape, every non-held caller) or the wrapped form carrying the
  // §5.4 override reason — the reason has to ride the payload because a PUT of lines is the
  // mutation being overridden, not a separate action. The shape is chosen before parsing, as
  // `replaceShipperContainers` does: parsed as a union, a refused line surfaced as one issue at
  // the top of the body, "body: Invalid input", with no field named (#511).
  const parsed = Array.isArray(input)
    ? { lines: z.array(SHIP_LINE).parse(input), creditHoldReason: undefined }
    : z.object({ lines: z.array(SHIP_LINE), creditHoldReason: z.string().max(1000).optional() }).strict().parse(input);
  const data = parsed.lines;
  const creditHoldReason = parsed.creditHoldReason;

  return withDbErrors({ entity: "Shipper" }, () => prisma.$transaction(async (tx) => {
    const { shipper, orderIds, claimed } = await claimLiveShipper(tx, id);
    const overrideReason = await creditHoldGate(tx, shipper.customerId, opts, creditHoldReason);
    const so = await findShipperOrder(tx, id, shipperOrderId);
    const order = claimed.find((o) => o.id === so.orderId)!;
    await refuseIfInvoiced(tx, orderIds, INVOICE_FREEZE.changeShipment);

    const lineIds = [...new Set(data.map((l) => l.orderLineId))];
    const orderLines: ResolvedLine[] = lineIds.length === 0 ? [] : await tx.orderLine.findMany({
      where: { id: { in: lineIds } },
      select: {
        id: true, orderId: true, position: true, qty: true, weight: true,
        part: { select: { partNumber: true, name: true, description: true, serializationRequired: true } },
      },
    });
    const lineById = new Map(orderLines.map((l) => [l.id, l]));

    const seen = new Set<string>();
    for (const l of data) {
      const line = lineById.get(l.orderLineId);
      if (!line || line.orderId !== so.orderId) {
        throw new HttpError(400, `Order #${order.orderNumber}: that line does not belong to this order`);
      }
      if (seen.has(l.orderLineId)) {
        throw new HttpError(400, `${shipLineLabel(order.orderNumber, line)}: listed twice on this shipment`);
      }
      seen.add(l.orderLineId);
    }

    // Spec §4.2: "a shipment must carry at least one line with qty > 0 across all its orders" —
    // a DOCUMENT-level invariant, not a per-line one (a single zeroed line, `lineComplete: true`,
    // stays legal on its own — "we are not sending the last three, close the line"). Checked only
    // when THIS order's own new lines carry none, against every OTHER `ShipperOrder` on the same
    // shipment — the common case (this order still has a positive line, or this isn't the only
    // order) never pays for the extra read.
    if (!data.some((l) => l.qty > 0)) {
      const otherPositive = await tx.shipperLine.findFirst({
        where: { qty: { gt: 0 }, shipperOrder: { shipperId: id, id: { not: shipperOrderId } } },
        select: { id: true },
      });
      if (!otherPositive) throw new HttpError(400, "A shipment needs at least one line with a positive quantity");
    }

    await auditedUpdate("shipper", id, async () => {
      await tx.shipperLine.deleteMany({ where: { shipperOrderId } });
      if (data.length > 0) {
        // Read AFTER the delete, so this shipment's own old rows are not counted twice: what is
        // left is the quantity on every other live shipment (`storedCloseShort`).
        const otherShipped = await shippedTotals(tx, lineIds);
        await tx.shipperLine.createMany({
          data: data.map((l, i) => {
            const line = lineById.get(l.orderLineId)!;
            return {
              shipperOrderId, orderLineId: l.orderLineId, position: i + 1,
              qty: l.qty, weight: l.weight,
              lineComplete: storedCloseShort(l, line.qty, otherShipped.get(l.orderLineId)?.qty ?? 0),
              partNumber: line.part.partNumber, partName: line.part.name,
              partDescription: line.part.description,
              orderedQty: line.qty, orderedWeight: line.weight,
            };
          }),
        });
      }
    }, { tx, ...(overrideReason ? { reason: overrideReason } : {}) });

    await recomputeOrderStatus(tx, orderIds);
    return readShipperDetail(tx, id);
    // STANDING INVARIANT (the stale-draft guard, stated above `claimShipperRow`): this stays
    // Serializable, or a draft invoice calculated before this change can be finalized silently.
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/** Save containers for one `ShipperOrder` (weights design §12.2). The rows still linked to an
 *  order row are deleted and created again, each `orderContainerId` validated to belong to this
 *  SAME order (the create-path's own per-order membership check, `saveNewShipper`, scoped down to
 *  one order here). The kept rows (their order-side row was since corrected away) are never
 *  deleted: they are renumbered 1..k, the request's rows land at k+1..k+n, and a kept row the
 *  request names in `kept` has its `tareEach` written by the row's id. Nothing else of a kept row
 *  is written.
 *
 *  The body is the bare list this save has always taken, or `{ containers, kept }`. Which one is
 *  decided by `Array.isArray`, and each is parsed by its own schema, never by a union of the two.
 *
 *  What a row of `containers` stores as its tare each: the figure it carries, a null as none. With
 *  no `tareEach` key it keeps what the shipment holds for that order row, a held row with no
 *  figure included, and takes the order row's figure only when the row is new to the shipment.
 *
 *  **Deliberately NOT invoice-guarded** (fix wave 1, controller-approved scope extension of
 *  Task 10 — the other candidate flagged in the same review, ruled lower-risk and left alone).
 *  A container is customer packaging (a box/skid the parts ride in); neither its count nor its
 *  tare each is an input to `priceOrder` (pricing.ts's `PricingInput` has no container field at
 *  all — only `OrderLineInput.shippedQty`/`shippedWeight` feed the engine). Replacing the container
 *  list after finalize cannot change what a finalized invoice billed. */
export async function replaceShipperContainers(id: string, shipperOrderId: string, input: unknown): Promise<ShipperDetail> {
  const data: z.infer<typeof REPLACE_CONTAINERS> = Array.isArray(input)
    ? { containers: z.array(SHIP_CONTAINER).parse(input), kept: [] }
    : REPLACE_CONTAINERS.parse(input);

  return withDbErrors({ entity: "Shipper" }, () => prisma.$transaction(async (tx) => {
    const { orderIds, claimed } = await claimLiveShipper(tx, id);
    const so = await findShipperOrder(tx, id, shipperOrderId);
    const order = claimed.find((o) => o.id === so.orderId)!;

    // The rows the shipment holds for this order, read before anything is deleted: the figures to
    // keep, by order row, and the kept rows that `kept` may name.
    const heldRows = await tx.shipperContainer.findMany({
      where: { shipperOrderId },
      select: { id: true, orderContainerId: true, typeName: true, tareEach: true },
    });
    const heldByOrderRow = new Map<string, (typeof heldRows)[number]>();
    const keptById = new Map<string, (typeof heldRows)[number]>();
    for (const row of heldRows) {
      if (row.orderContainerId === null) keptById.set(row.id, row);
      else heldByOrderRow.set(row.orderContainerId, row);
    }

    const containerIds = [...new Set(data.containers.map((c) => c.orderContainerId))];
    const containers: ResolvedContainer[] = containerIds.length === 0 ? [] : await tx.orderContainer.findMany({
      where: { id: { in: containerIds } },
      select: { id: true, orderId: true, customerContainerId: true, tareEach: true, type: { select: { name: true } } },
    });
    const containerById = new Map(containers.map((c) => [c.id, c]));

    const seen = new Set<string>();
    for (const c of data.containers) {
      const container = containerById.get(c.orderContainerId);
      if (!container || container.orderId !== so.orderId) {
        throw new HttpError(400, `Order #${order.orderNumber}: that container does not belong to this order`);
      }
      if (seen.has(c.orderContainerId)) {
        throw new HttpError(400,
          `Order #${order.orderNumber}: container "${container.type.name}" is listed twice on this shipment`);
      }
      seen.add(c.orderContainerId);
    }

    // An entry of `kept` names a kept row of this order on this shipment, once. Anything else is
    // refused here, before any write: an unknown id, a row still linked to an order row, and a row
    // of another order's part all read the same.
    const seenKept = new Set<string>();
    for (const k of data.kept) {
      const row = keptById.get(k.id);
      if (!row) {
        throw new HttpError(400, `Order #${order.orderNumber}: that kept container is not on this shipment`);
      }
      if (seenKept.has(k.id)) {
        throw new HttpError(400,
          `Order #${order.orderNumber}: kept container "${row.typeName}" is listed twice on this shipment`);
      }
      seenKept.add(k.id);
    }

    await auditedUpdate("shipper", id, async () => {
      // Kept rows (orderContainerId null — snapshot + release) SURVIVE a replace: only rows still
      // tied to a live order container are deleted and made again. The survivors are renumbered
      // 1..k first (two-phase negative park, the renumberShipperOrderPositions shape) so the
      // payload's rows can land at k+1..k+n without colliding.
      await tx.shipperContainer.deleteMany({ where: { shipperOrderId, orderContainerId: { not: null } } });
      const released = await tx.shipperContainer.findMany({
        where: { shipperOrderId }, orderBy: { position: "asc" }, select: { id: true },
      });
      for (const [i, row] of released.entries()) {
        await tx.shipperContainer.update({ where: { id: row.id }, data: { position: -(i + 1) } });
      }
      for (const [i, row] of released.entries()) {
        await tx.shipperContainer.update({ where: { id: row.id }, data: { position: i + 1 } });
      }
      // A kept row named with a figure or a null has it written. One named with no `tareEach` key
      // is left as it is, as a kept row the request does not name is.
      for (const k of data.kept) {
        if (k.tareEach === undefined) continue;
        await tx.shipperContainer.update({ where: { id: k.id }, data: { tareEach: k.tareEach } });
      }
      if (data.containers.length > 0) {
        await tx.shipperContainer.createMany({
          data: data.containers.map((c, i) => {
            const container = containerById.get(c.orderContainerId)!;
            const held = heldByOrderRow.get(c.orderContainerId);
            return {
              shipperOrderId, orderContainerId: c.orderContainerId,
              position: released.length + i + 1, count: c.count,
              typeName: container.type.name, customerContainerId: container.customerContainerId,
              // The figure the row carries, a null as none. With no key: what the shipment held for
              // this order row, or the order row's when it held no such row. That turns on whether
              // a row was held, never on whether its figure is there, so it is never written with
              // `??`: a held row with no figure stays with none. No default is applied here.
              tareEach: c.tareEach !== undefined ? c.tareEach : held ? held.tareEach : container.tareEach,
            };
          }),
        });
      }
    }, { tx });

    await recomputeOrderStatus(tx, orderIds);
    return readShipperDetail(tx, id);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/** Bulk PUT of one `ShipperOrder`'s serials — delete-then-recreate, each `orderSerialId` validated
 *  to belong to this SAME order. No position write of its own (`ShipperSerial` has none — a serial
 *  is either on the ticket or it isn't, schema.prisma's own comment on its `orderBy`).
 *
 *  **Deliberately NOT invoice-guarded** (fix wave 1, controller-approved scope extension of
 *  Task 10 — the other candidate flagged in the same review, ruled lower-risk and left alone).
 *  A serial is per-piece identity, not quantity or weight: selecting a different subset of an
 *  order line's existing serials changes which units are individually named on the ticket, not
 *  how many shipped or how much they weighed — `priceOrder` prices off `shippedQty`/
 *  `shippedWeight` alone (pricing.ts), never off which serials were attached. Replacing the
 *  serial list after finalize cannot change what a finalized invoice billed. */
export async function replaceShipperSerials(id: string, shipperOrderId: string, input: unknown): Promise<ShipperDetail> {
  const data = z.array(SHIP_SERIAL).parse(input);

  return withDbErrors({ entity: "Shipper" }, () => prisma.$transaction(async (tx) => {
    const { orderIds, claimed } = await claimLiveShipper(tx, id);
    const so = await findShipperOrder(tx, id, shipperOrderId);
    const order = claimed.find((o) => o.id === so.orderId)!;

    const serialIds = [...new Set(data.map((s) => s.orderSerialId))];
    const serials: ResolvedSerial[] = serialIds.length === 0 ? [] : await tx.orderSerial.findMany({
      where: { id: { in: serialIds } },
      select: { id: true, orderId: true, lineId: true, serial: true, description: true },
    });
    const serialById = new Map(serials.map((s) => [s.id, s]));

    const seen = new Set<string>();
    for (const s of data) {
      const serial = serialById.get(s.orderSerialId);
      if (!serial || serial.orderId !== so.orderId) {
        throw new HttpError(400, `Order #${order.orderNumber}: that serial does not belong to this order`);
      }
      if (seen.has(s.orderSerialId)) {
        throw new HttpError(400, `Order #${order.orderNumber}: serial "${serial.serial}" is listed twice on this shipment`);
      }
      seen.add(s.orderSerialId);
    }

    await auditedUpdate("shipper", id, async () => {
      // Released rows (orderSerialId null) survive the replace: only rows still tied to a live
      // order serial are deleted and made again.
      await tx.shipperSerial.deleteMany({ where: { shipperOrderId, orderSerialId: { not: null } } });
      if (data.length > 0) {
        await tx.shipperSerial.createMany({
          data: data.map((s) => {
            const serial = serialById.get(s.orderSerialId)!;
            return {
              shipperOrderId, orderSerialId: s.orderSerialId, printOnShipper: s.printOnShipper,
              serial: serial.serial, description: serial.description,
              orderLineIdAtSave: serial.lineId,
            };
          }),
        });
      }
    }, { tx });

    await recomputeOrderStatus(tx, orderIds);
    return readShipperDetail(tx, id);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

// -------------------------------------------------------------------------------------------
// Task 10: void, and the order edit invariants (spec §5.5/§5.6). `shipmentBlockers` is the
// `orders.ts -> shippers.ts` import edge this task adds — `orders.ts`'s `removeLine`/`updateLine`/
// `voidOrder` call it to refuse a contradiction of shipped fact, naming the blocking shipment
// through the SAME `Blocker` shape every other "still in use" refusal in this codebase already
// renders through `BlockerPanel` (reference-blockers.ts), rather than a bespoke shape. This
// edge made orders.ts <-> shippers.ts a runtime CYCLE while this file imported
// `isDuplicateClientRequestId` back from orders.ts — survivable only because both crossing
// exports were hoisted `function` declarations, never a top-level `const` evaluated at
// module-load time, so neither side could land in the other's temporal dead zone regardless of
// import order (order-locks.ts's own header comment anticipated it; verified then by a
// module-load-order smoke test). Since #33 (2026-08-19) that helper lives in db-errors.ts and
// the cycle is GONE — the edge is one-directional, orders.ts -> shippers.ts only. A new
// shippers.ts import from orders.ts would re-open it and inherit the hoisted-function rule.
// -------------------------------------------------------------------------------------------

/**
 * Every LIVE shipment currently attached to `orderId` — or, scoped to `orderLineId`, only those
 * carrying a live `ShipperLine` for that exact order line — as the shared `Blocker` shape (spec
 * §5.5). Deduplicated by shipper (a shipment can only appear on one `ShipperOrder` row per order,
 * `@@unique([shipperId, orderId])`, so dedup only matters when `orderLineId` is omitted and more
 * than one shipment touches the order), ordered by `shipperNumber` ascending so the refusal names
 * shipments in a deterministic, human-meaningful order rather than whatever order Postgres
 * happened to scan them in.
 */
export async function shipmentBlockers(db: Db, orderId: string, orderLineId?: string): Promise<Blocker[]> {
  const rows = await db.shipperOrder.findMany({
    where: {
      orderId,
      shipper: { deletedAt: null },
      ...(orderLineId ? { lines: { some: { orderLineId } } } : {}),
    },
    select: { shipperId: true, shipper: { select: { shipperNumber: true } } },
    orderBy: { shipper: { shipperNumber: "asc" } },
  });

  const seen = new Set<string>();
  const out: Blocker[] = [];
  for (const row of rows) {
    if (seen.has(row.shipperId)) continue;
    seen.add(row.shipperId);
    out.push({
      entityLabel: "Shipment",
      name: `Packing List ${row.shipper.shipperNumber}`,
      id: row.shipperId,
      href: `/shipping/${row.shipperId}`,
    });
  }
  return out;
}

/**
 * `mustDo(user, "void_shipper")` is the route's job; the reason is required and trimmed HERE so
 * no future caller can bypass it (the `voidOrder`/`voidCert` precedent, orders.ts/certs.ts).
 * Claims every order the shipment touches — sorted, via `claimOrdersInOrder` — before writing
 * anything, `auditedSoftDelete`s the shipper, then every LIVE shipment-scope cert hanging off it
 * WITH THE SAME REASON (spec §5.6: "voids any shipment-scoped certs hanging off it with the same
 * reason"), and finally recomputes every affected order's status. `shipperNumber`, `bolNumber` and
 * every `ShipperOrder.sequence` are never touched by this function — that permanence is the
 * absence of any write to them, not a check this function performs.
 *
 * A shipment-scope cert's `orderId` is always one of the orders THIS claim just covered — NOT
 * because every order that ever touched the shipment still does (an order CAN be removed,
 * `removeOrderFromShipper` above), but because `removeOrderFromShipper` itself voids that order's
 * own shipment-scope cert, under the claim it already holds for that order, at the moment the
 * order leaves the shipment (spec §5.6, 2026-08-04 amendment). A review of the first version of
 * this function caught the gap that amendment closes: `orderIds` here comes from the shipment's
 * CURRENT `ShipperOrder` rows, so an order removed earlier is not in it and its row is not
 * claimed — if its cert could still be live, THIS loop would be writing `deletedAt` onto a row
 * belonging to an unclaimed order. With the removal-time void in place, that case cannot arise: by
 * the time a shipment-scope cert can still be found live here, its order is necessarily still ON
 * the shipment, i.e. inside `orderIds` — so the claim already taken over `orderIds` genuinely
 * covers every cert this loop can touch, and no separate claim is needed for the cert side.
 */
export async function voidShipper(id: string, reason: string): Promise<void> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to void a shipment");

  await withDbErrors({ entity: "Shipper" }, () => prisma.$transaction(async (tx) => {
    // The `claimLiveShipper` sequence, widened to the PAIR (#65): a void is the one mutator whose
    // guards and writes span BOTH shipper rows of a reversal pair (the blocker reads the
    // reversal's liveness; the restore writes the original's lines), so both rows are claimed in
    // ONE sorted statement — two voids racing the pair from opposite ends serialize instead of
    // ABBA-deadlocking. Steps: pre-claim stub reads (target + discovered pair ids — the
    // `claimLiveShipper` shape, nothing acted on below is trusted from them), the order claims,
    // `claimShipperRows` over the pair, then the liveness re-read off rows this transaction holds.
    // A reversal committing between the stub read and the claim is invisible to this Serializable
    // snapshot, but not to SSI: both paths run Serializable and rw-conflict through the Order rows
    // and the reversal predicate read, so the loser aborts with 40001 → `withDbErrors`' honest 409.
    const stub = await tx.shipper.findFirst({
      where: { id }, select: { id: true, reversesShipperId: true, reversalClearedLineIds: true },
    });
    if (!stub) throw new HttpError(404, "Shipment not found");
    const pairIds = stub.reversesShipperId !== null
      ? [stub.reversesShipperId]
      : (await tx.shipper.findMany({
          where: { reversesShipperId: id, deletedAt: null }, select: { id: true },
        })).map((r) => r.id);
    // #65 review round 1 (Important): the restore below writes the ORIGINAL's `lineComplete` flags
    // by `reversalClearedLineIds`, so the orders those cleared lines belong to are DISCOVERED here
    // and unioned into the claim set, never assumed to still sit on the reversal's own
    // `ShipperOrder` rows. Since #139, `claimLiveShipper`'s pair freeze refuses every edit door on
    // a reversal EXPLICITLY (no longer just incidentally via the at-least-one-positive-line
    // survivor invariant), so no product path shrinks a reversal's membership — but data written
    // before that guard could already hold the shrunk shape, so the void stays correct by
    // construction instead of leaning on the freeze. Cleared ids are immutable and a
    // `ShipperLine` never re-parents, so this stub read can only match rows that die before the
    // claim — harmless (`claimOrdersInOrder` dedups; the restore re-reads under the claim). The
    // union flows through `refuseIfInvoiced` (a flag restore is a shipment-side write on that
    // order, so §5.7's conservatism applies to it too) and the final recompute alike.
    const clearedOrderIds = stub.reversesShipperId === null || stub.reversalClearedLineIds.length === 0
      ? []
      : (await tx.shipperLine.findMany({
          where: { id: { in: stub.reversalClearedLineIds } },
          select: { shipperOrder: { select: { orderId: true } } },
        })).map((l) => l.shipperOrder.orderId);
    const orderIds = [...new Set([...await shipperOrderIds(tx, id), ...clearedOrderIds])];
    await claimOrdersInOrder(tx, orderIds);
    await claimShipperRows(tx, [id, ...pairIds]);
    const shipper = await tx.shipper.findFirst({ where: { id } });
    if (!shipper || shipper.deletedAt !== null) throw new HttpError(404, "Shipment not found");

    // §5.7 stays FIRST: an invoiced pair is refused with the invoice-naming message on BOTH sides
    // — unlock is its correction route, and the reversal blocker below must never shadow that.
    await refuseIfInvoiced(tx, orderIds, INVOICE_FREEZE.voidShipment);

    // #65 blocker: the original of a LIVE reversal cannot void. INVARIANT: with every live
    // reversal fully covered by its live original, Σ(live originals) − Σ(live reversals) ≥ 0 per
    // line by construction — reversal CREATION checks below-zero once, and this blocker is what
    // makes the net ledger non-negative GLOBALLY (voiding the original would drop its positives
    // from `shippedTotals` while the reversal's negatives stayed live). Re-read under the claim;
    // §5.14's name-the-blocker shape, ordered so two live reversals would name the same one.
    const liveReversal = await tx.shipper.findFirst({
      where: { reversesShipperId: id, deletedAt: null },
      select: { shipperNumber: true }, orderBy: { shipperNumber: "asc" },
    });
    if (liveReversal) {
      throw new HttpError(400,
        `This shipment has been reversed by Packing List ${liveReversal.shipperNumber} — void the reversal first`);
    }

    await auditedSoftDelete("shipper", id, why, tx);

    const certs = await tx.cert.findMany({ where: { shipperId: id, deletedAt: null }, select: { id: true } });
    for (const cert of certs) {
      await auditedSoftDelete("cert", cert.id, why, tx);
    }

    // #65 restore — voiding a reversal is the blessed undo, and this is the MIRROR of
    // `reverseShipperInTx` step 6b's clear: restore `lineComplete: true` on exactly the original's
    // lines THIS reversal cleared (`reversalClearedLineIds`, its immutable at-creation snapshot),
    // through the audited path onto the original's own history with the void reason. The original's
    // row is already claimed (pair claim above); skipped when the original is itself voided
    // (pre-fix corrupt data only — its lines total nothing, so restoring flags on them would be
    // noise on a dead document). Lines replaced since the reversal simply don't match (their ids
    // died — the human re-decided) and legacy pre-#65 reversals carry [], so both restore nothing;
    // filtering to `lineComplete: false` keeps the no-op-audit-entry discipline (step 6b's own).
    if (shipper.reversesShipperId !== null && shipper.reversalClearedLineIds.length > 0) {
      const original = await tx.shipper.findFirst({
        where: { id: shipper.reversesShipperId }, select: { id: true, deletedAt: true },
      });
      // Corrupt-data belt (Codex MR !141 round 2): if ANOTHER live reversal of the same original
      // still stands, restoring would re-mark flags that reversal semantically owns — so skip, and
      // let the recompute below derive from the still-cleared flags (honest PARTIAL_SHIPPED while
      // a live reversal stands). Unreachable through the product since reverseShipperInTx's 3b
      // refusal (at most one live reversal per original, enforced); this branch exists for data
      // that predates it. The target is already soft-deleted above, so this live query never
      // matches the reversal being voided.
      const siblingReversal = original === null ? null : await tx.shipper.findFirst({
        where: { reversesShipperId: original.id, deletedAt: null }, select: { id: true },
      });
      if (original !== null && original.deletedAt === null && siblingReversal === null) {
        // A line that is complete by quantity now (the reversal is already voided above, so its
        // negatives are out of `shippedTotals`) is NOT restored: the recompute below would clear
        // the tick again at once (`clearSupersededCloseShorts`), leaving a restore and a clear on
        // the original's history for a flag that never stood. A released line (no order line) has
        // no quantity to judge and is restored as before.
        const candidates = await tx.shipperLine.findMany({
          where: { id: { in: shipper.reversalClearedLineIds }, lineComplete: false },
          select: { id: true, orderLineId: true, orderLine: { select: { qty: true } } },
        });
        const shippedNow = await shippedTotals(tx,
          candidates.map((l) => l.orderLineId).filter((x): x is string => x !== null));
        const toRestore = candidates.filter((l) => l.orderLineId === null || l.orderLine === null
          || !lineIsComplete({
            orderedQty: l.orderLine.qty, shippedQty: shippedNow.get(l.orderLineId)?.qty ?? 0, closedShort: false,
          })).map((l) => l.id);
        if (toRestore.length > 0) {
          await auditedUpdate("shipper", original.id, () => tx.shipperLine.updateMany({
            where: { id: { in: toRestore } }, data: { lineComplete: true },
          }), { tx, reason: why });
        }
      }
    }

    // The claim set is the target's own orders UNIONED with the cleared lines' orders (discovered
    // pre-claim above), so the restore's writes and this recompute stay covered even when the
    // reversal's membership was edited after creation (#139) — an order added to the ORIGINAL
    // after the reversal was neither cleared nor restored, and stays out. Invoiced orders never
    // reach here (`refuseIfInvoiced` above, over the same union), so the two-arg recompute
    // settles every affected order on the status derived by quantity and close short.
    await recomputeOrderStatus(tx, orderIds);
    // STANDING INVARIANT (the stale-draft guard, stated above `claimShipperRow`): this stays
    // Serializable, or a draft invoice calculated before this change can be finalized silently.
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

// -------------------------------------------------------------------------------------------
// Task 15: the reversing shipment (spec §5.2, §5.6). A reversing shipment un-ships goods that were
// shipped and (usually) invoiced: a `Shipper` with `reversesShipperId` set, whose lines carry the
// NEGATION of the original's qty/weight. `shippedTotals` already sums `qty`, so the negatives net
// the shipped ledger down by construction — no ledger change is needed. It REUSES the shared
// machinery every shipment mutator uses — `claimOrdersInOrder` (one sorted FOR UPDATE statement,
// never a per-row loop) and `recomputeOrderStatus` — rather than forking a second dangerous action
// or a second locking path.
//
// STATUS (spec §5.2, and the binding requirement carried from Task 13's review): for an order with
// a finalized invoice, this writes `Order.status = REOPENED` **directly**, through
// `auditedUpdate("order", …)`. It does NOT pass `released` to `recomputeOrderStatus` — that third
// arg forces a recompute PAST the invoice-owned skip and exists SOLELY for unlock (invoices.ts);
// passing it from a shipment path is exactly the hole the skip closes (a shipment-side recompute
// would drop an invoice-owned status back to SHIPPED). Every non-invoiced order is left to
// `recomputeOrderStatus`'s two-arg form, which derives OPEN/PARTIAL_SHIPPED/SHIPPED from shipped
// quantity: a line is complete when shipped-to-date quantity reaches its ordered quantity or a live
// shipper line closed it short, so a fully reversed, never-invoiced order nets to zero and derives
// PARTIAL_SHIPPED (it has live shipments, so it does not fall to OPEN).
// -------------------------------------------------------------------------------------------

const REVERSE_SHIPPER = z.object({
  // Non-blank-checked and trimmed IN THE SERVICE below (the voidShipper/discardInvoice precedent) —
  // zod only pins the shape; a string of spaces is not a reason.
  reason: z.string().max(1000),
  // Defaults to the original shipment's ship date when omitted (spec §5.6).
  shipDate: z.string().min(1).optional(),
}).strict();

type ReverseShipperInput = z.infer<typeof REVERSE_SHIPPER>;

/** The reversal's create-entry `after` snapshot, composed by hand (the `auditPayload`/
 *  `creditHoldOverrideReason` precedent): `auditedCreate` takes no `reason` arg, so the reason rides
 *  IN this payload — it lands in the audit entry and prints on no piece of paper. Every negated line
 *  travels with the live part identity captured off the original's snapshot columns. */
function reverseAuditPayload(args: {
  shipperNumber: number; reason: string; reversalClearedLineIds: string[];
  original: { id: string; shipperNumber: number };
  customer: { id: string; code: string; name: string };
  shipDate: Date;
  orders: {
    orderId: string; orderNumber: number; sequence: number;
    lines: { orderLineId: string | null; partNumber: string; qty: number; weight: Prisma.Decimal }[];
  }[];
}) {
  return {
    shipperNumber: args.shipperNumber,
    reversesShipperId: args.original.id,
    reversesShipperNumber: args.original.shipperNumber,
    reason: args.reason,
    reversalClearedLineIds: args.reversalClearedLineIds,
    customerId: args.customer.id, customerCode: args.customer.code, customerName: args.customer.name,
    shipDate: formatDateOnly(args.shipDate),
    orders: args.orders.map((o) => ({
      orderId: o.orderId, orderNumber: o.orderNumber, sequence: o.sequence,
      lines: o.lines.map((l) => ({
        orderLineId: l.orderLineId, partNumber: l.partNumber, qty: l.qty, weight: l.weight,
      })),
    })),
  };
}

/**
 * The reversing-shipment transaction (spec §5.2/§5.6). `tx` is optional: the discriminating
 * concurrency test passes a manually-opened (Read Committed) transaction so the row lock, not SSI,
 * is what serializes a competing caller — the `finalizeInvoice` precedent. The public no-`tx` path
 * runs Serializable, pairing `assertRefExists`-style FK safety with the claim exactly as
 * `saveNewShipper` does.
 */
async function reverseShipperInTx(
  tx: Prisma.TransactionClient, id: string, data: ReverseShipperInput, why: string,
): Promise<ShipperCreateResult> {
  // 1. Pre-claim stub — the ONLY unlocked read, and only to learn which orders to claim (the
  //    `printShippingTickets`/`addOrderToShipper` shape); nothing acted on below is trusted from it.
  const stub = await tx.shipper.findFirst({ where: { id }, select: { id: true } });
  if (!stub) throw new HttpError(404, "Shipment not found");
  const orderIds = await shipperOrderIds(tx, id);

  // 2. Claim — the SAME single sorted FOR UPDATE statement every shipment mutator shares, never a
  //    per-row loop (the ABBA-deadlock shape). Then the original Shipper's own row, AFTER the order
  //    claims (order-locks.ts house rule: `Shipper.deletedAt`/`reversesShipperId` are guarded state
  //    that lives on the Shipper row, so the post-claim re-read is only fresh under this lock).
  const claimed = await claimOrdersInOrder(tx, orderIds);
  const ordersById = new Map(claimed.map((o) => [o.id, o]));
  await claimShipperRow(tx, id);

  // 3. Re-read the original UNDER the claim. A voided original is read-only (404, the P3 shape) — and
  //    reversing one would be a data-integrity hazard: a voided shipment already contributes 0 to the
  //    ledger, so its negatives would net a DIFFERENT live shipment's quantity down. A reversal of a
  //    reversal is refused too (its negatives negated would drive the ledger UP, spec §5.6 gives no
  //    such path).
  const original = await tx.shipper.findFirst({
    where: { id },
    include: {
      customer: { select: { code: true, name: true } },
      orders: { orderBy: { position: "asc" }, include: { lines: { orderBy: { position: "asc" } } } },
    },
  });
  if (!original || original.deletedAt !== null) throw new HttpError(404, "Shipment not found");
  if (original.reversesShipperId !== null) {
    throw new HttpError(400, "That shipment is itself a reversal — reverse the original shipment instead");
  }
  // 3b. AT MOST ONE live reversal per original — enforced, not incidental (Codex MR !141 round 2;
  //     the first slice of the 2026-08-18 freeze-the-pair ruling, #139). A second full reversal of
  //     the same original is never honest paper (it un-ships the same goods twice), and the
  //     below-zero guard below only catches it INCIDENTALLY — another live shipment's quantity on
  //     the same lines lets it through, whereupon the second reversal snapshots [] (the flags were
  //     already cleared) and the void-restore's semantics break: voiding the FIRST reversal would
  //     restore flags the still-live second reversal semantically owns. This refusal is what makes
  //     `reversalClearedLineIds` exact. Read under the claim (original's row is locked above).
  const priorReversal = await tx.shipper.findFirst({
    where: { reversesShipperId: id, deletedAt: null },
    select: { shipperNumber: true }, orderBy: { shipperNumber: "asc" },
  });
  if (priorReversal) {
    throw new HttpError(400,
      `This shipment has already been reversed by Packing List ${priorReversal.shipperNumber} — ` +
      "void that reversal first");
  }
  for (const so of original.orders) {
    const order = ordersById.get(so.orderId);
    if (!order || order.deletedAt !== null) {
      throw new HttpError(400, `Order #${order?.orderNumber ?? "?"} has been voided`);
    }
  }

  // 4. Below-zero guard (spec §5.6): the net shipped-to-date after this reversal must stay >= 0 on
  //    every line. Read the ledger UNDER the claim — this is the state the write acts on. Weight is
  //    compared in integer cents (the `shippedTotals` idiom) so 0.1/0.2 float shapes cannot make a
  //    genuine zero read as a hair below it.
  const orderLineIds = [...new Set(original.orders.flatMap((so) =>
    so.lines.map((l) => l.orderLineId).filter((x): x is string => x !== null)))];
  const netBefore = await shippedTotals(tx, orderLineIds);
  for (const so of original.orders) {
    const order = ordersById.get(so.orderId)!;
    for (const l of so.lines) {
      if (l.orderLineId === null) continue; // released rows net nothing (no live order line)
      const cur = netBefore.get(l.orderLineId) ?? { qty: 0, weight: 0 };
      const newQty = cur.qty - l.qty;
      const newWeightCents = Math.round(cur.weight * 100) - Math.round(l.weight.toNumber() * 100);
      if (newQty < 0 || newWeightCents < 0) {
        throw new HttpError(400,
          `Order #${order.orderNumber} (${l.partNumber}): reversing ${formatNumber(l.qty)} / ${formatNumber(l.weight.toNumber(), 2)} lb would drive ` +
          "its shipped-to-date below zero");
      }
    }
  }

  // 5. Ship date defaults to the original's (spec §5.6). Numbering: its OWN packing-list number and,
  //    per order, its own never-reused shipment sequence — a reversal is a real shipment of that
  //    order (`nextShipmentSequences`, the `saveNewShipper` shape).
  const shipDate = data.shipDate ? parseDate(data.shipDate, "Ship date") : original.shipDate;
  const shipperNumber = await allocateNumber("shipper_number_next", tx);
  const sequenceByOrderId = await nextShipmentSequences(tx, original.orders.map((so) => so.orderId));

  // 6. Create the reversal — negated lines, `reversesShipperId` set, `lineComplete: false`. Snapshot
  //    columns are copied from the original's own snapshots (the paper's part identity), so the
  //    reversal never has to re-read an order-side line that a correction may since have released.
  //    `completeLineIds` — the original's lines step 6b is about to un-mark — is computed HERE so it
  //    can also be STORED on the reversal row at creation (#65, `reversalClearedLineIds`): an
  //    immutable snapshot of exactly which flags THIS reversal cleared, which is what lets
  //    `voidShipper`'s restore (the blessed undo) put back precisely those flags and no others. No
  //    edit-path bookkeeping — a line replaced since simply stops matching and restores nothing.
  const completeLineIds = original.orders.flatMap((so) =>
    so.lines.filter((l) => l.lineComplete).map((l) => l.id));
  const reversal = await auditedCreate(
    "shipper",
    reverseAuditPayload({
      shipperNumber, reason: why, reversalClearedLineIds: completeLineIds,
      original: { id: original.id, shipperNumber: original.shipperNumber },
      customer: { id: original.customerId, code: original.customer.code, name: original.customer.name },
      shipDate,
      orders: original.orders.map((so) => ({
        orderId: so.orderId, orderNumber: ordersById.get(so.orderId)!.orderNumber,
        sequence: sequenceByOrderId.get(so.orderId)!,
        lines: so.lines.map((l) => ({
          orderLineId: l.orderLineId, partNumber: l.partNumber, qty: -l.qty, weight: l.weight.negated(),
        })),
      })),
    }),
    () => tx.shipper.create({
      data: {
        shipperNumber,
        customerId: original.customerId,
        shipToAddressId: original.shipToAddressId,
        shipDate,
        carrierId: original.carrierId,
        route: original.route,
        comments: original.comments,
        reversesShipperId: original.id,
        reversalClearedLineIds: completeLineIds,
        orders: {
          create: original.orders.map((so, oi) => ({
            orderId: so.orderId,
            sequence: sequenceByOrderId.get(so.orderId)!,
            position: oi + 1,
            lines: {
              create: so.lines.map((l, li) => ({
                orderLineId: l.orderLineId, position: li + 1,
                qty: -l.qty, weight: l.weight.negated(), lineComplete: false,
                partNumber: l.partNumber, partName: l.partName, partDescription: l.partDescription,
                orderedQty: l.orderedQty, orderedWeight: l.orderedWeight,
              })),
            },
          })),
        },
      },
      select: { id: true },
    }),
    { tx },
  );

  // 6b. Undo a close short the shipment being reversed set (owner ruling 2026-08-07, restated for
  //     the 2026-10-06 quantity rule). The reversal's negative quantity is what reopens the order:
  //     it takes the line's shipped-to-date back under its ordered quantity. A close short is the
  //     other way a line stands complete, and it does not net out, so `lineComplete` is cleared on
  //     the ORIGINAL shipment's own lines; left set, a line closed short would stay complete with
  //     nothing shipped against it. With both undone the derive path recomputes PARTIAL_SHIPPED
  //     (the reversal doc is still a live shipment, so never OPEN), and the direct-REOPENED path
  //     leaves no flag behind, so a LATER unlock derives PARTIAL_SHIPPED, not SHIPPED. Written
  //     under the claim already held on the original Shipper row (step 2), through the audited path
  //     onto the original's own history. Only when a line is actually complete, so a reversal of a
  //     never-completed partial shipment writes no no-op audit entry (recompute's own discipline).
  //     `completeLineIds` is computed at step 6, where it is also stored on the reversal row (#65).
  if (completeLineIds.length > 0) {
    await auditedUpdate("shipper", original.id, () => tx.shipperLine.updateMany({
      where: { id: { in: completeLineIds } }, data: { lineComplete: false },
    }), { tx, reason: why });
  }

  // 7. Status (spec §5.2). REOPENED is written DIRECTLY for every order that carries a finalized
  //    invoice; the rest are left to `recomputeOrderStatus`'s TWO-arg form. `released` is NEVER
  //    passed from here — see this section's header for why. The finalized-invoice state is read
  //    under the claim (Task 10's guard pattern, `finalizedInvoicesFor`).
  const reopenedIds = new Set((await finalizedInvoicesFor(tx, orderIds)).map((inv) => inv.orderId));
  const deriveIds = orderIds.filter((oid) => !reopenedIds.has(oid));
  await recomputeOrderStatus(tx, deriveIds);
  for (const orderId of reopenedIds) {
    // Skip a no-op write (recompute's own discipline) — an order already REOPENED from a prior
    // reversal keeps its one status entry rather than gaining an empty-diff one.
    if (ordersById.get(orderId)!.status === "REOPENED") continue;
    await auditedUpdate("order", orderId,
      () => tx.order.update({ where: { id: orderId }, data: { status: "REOPENED" } }),
      { tx, reason: why, snapshot: "header" }); // a status flip: R5's pair (R26, #711 step 5)
  }

  const detail = await readShipperDetail(tx, reversal.id);
  return { shipper: detail, warnings: await shipmentWarnings(tx, detail), deduped: false };
}

/**
 * `reverseShipper` (spec §5.2/§5.6). `mustDo(user, "void_shipper")` is the route's job; the reason
 * is required and trimmed HERE so no future caller can bypass it (the `voidShipper` precedent).
 */
export async function reverseShipper(
  id: string, input: unknown, tx?: Prisma.TransactionClient,
): Promise<ShipperCreateResult> {
  const data = REVERSE_SHIPPER.parse(input);
  const why = data.reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to reverse a shipment");

  // The injected-`tx` path takes NO retry, deliberately: a caller's transaction that has already
  // aborted cannot be re-run from in here, and re-running the body on the same `tx` would just fail
  // again on a dead transaction. Retrying is the entry point's job, and this path has no entry point
  // of its own — only the self-opening branch below does. (#115)
  if (tx) return reverseShipperInTx(tx, id, data, why);
  return withDbErrors({ entity: "Shipper", conflictField: "shipper number" }, () =>
    retryAllocation(() => prisma.$transaction((fresh) => reverseShipperInTx(fresh, id, data, why),
      // STANDING INVARIANT (the stale-draft guard, stated above `claimShipperRow`): this stays
      // Serializable, or a draft invoice calculated before this change can be finalized silently.
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })));
}

// -------------------------------------------------------------------------------------------
// Task 18: the shipping ticket's print entry point (spec §10.1, §3.20). The traveler's three-layer
// shape, applied to shipments: `readShippingTicketData` (the reads, all on the caller's `db`),
// `buildShippingTicketDefinition` (pdf/shipping-ticket.ts — PURE), `renderPdf` (bytes). One sheet
// per order of the shipment in ONE PDF; a named order prints alone.
// -------------------------------------------------------------------------------------------

/** Every SETTING the ticket needs, read in one place BEFORE the print transaction opens — the
 *  `travelerSettings` precedent (traveler.ts, fix-wave R4 finding 8): settings are read-only and
 *  not shipment state, so the transaction below never waits on their round trips. */
export type TicketSettings = {
  company: { name: string; address: string; phone: string };
  liabilityText: string;
};

export async function ticketSettings(): Promise<TicketSettings> {
  const [name, address, phone] = await Promise.all([
    getSetting("company_name"),
    getSetting("company_address"),
    getSetting("company_phone"),
  ]);
  // `liabilityText` defaults to the SHIPPER contract's own text block; `printShippingTickets`
  // REPLACES it at the data seam with the resolved template's `shipper_liability_text` (spec §8).
  // The `shipper_liability_text` Setting was retired in Task 14 — a direct `readShippingTicketData`
  // call (a preview/test) gets the contract default (SHIPPER and MOS_SHIPPER share this text block).
  return { company: { name, address, phone }, liabilityText: SHIPPER_DEFAULT_CONFIG.textBlocks.shipper_liability_text };
}

/**
 * Assembles the print payload — one `TicketData` per order of the shipment, in ticket print order
 * (`ShipperOrder.position`, which `readShipperDetail` already sorts by), or just the named
 * order's. Reads EVERYTHING through `db` (the `readTravelerData` rule): inside `printShippingTickets`
 * that is the claim-holding `tx`, so every read sees the snapshot the claim covers and no second
 * pooled connection is borrowed mid-transaction.
 *
 * Address semantics (spec §10.1):
 *  - **Sold To** is the CUSTOMER (code in the corner, name on the first line) at their default
 *    `BILL_TO` address — default flag first, else the first live one, the traveler's
 *    RECEIVED_FROM idiom. Live-and-active only (`listAddresses`' own filter): "the customer's
 *    default BILL_TO" is a current fact, not a historical one.
 *  - **Ship To** is the shipment's own `shipToAddressId` row, read UNFILTERED on
 *    deletedAt/active — the shipment references it and the paper has to name where the truck
 *    went, whatever has happened to the address book since (the traveler's deliberately-unfiltered
 *    parts read, same reasoning). Its `name` is the destination's name (spec §3's closing note:
 *    a third-party consignee IS a named SHIP_TO address); blank name falls back to the customer.
 *    Its corner code prints empty — a `CustomerAddress` has no short code in this system, and a
 *    cuid is not paper (the sample's "93753" is Visual Shop's internal row id).
 */
export async function readShippingTicketData(
  db: Db, shipperId: string, settings: TicketSettings, orderId?: string,
): Promise<TicketData[]> {
  const detail = await readShipperDetail(db, shipperId); // 404s a missing shipment

  const orders = orderId === undefined ? detail.orders : detail.orders.filter((o) => o.orderId === orderId);
  if (orderId !== undefined && orders.length === 0) {
    throw new HttpError(404, "That order is not on this shipment");
  }

  const addresses = await listAddresses(detail.customerId, undefined, db);
  const billTo = pickDefaultAddress(addresses, "BILL_TO");
  // R14 (#671): the row's name stacks above the customer's in the Sold To box; the tear-off strip's
  // one-line Sold To keeps the customer's name alone (`tearOff`), so #522's measurement inputs are
  // unchanged.
  const soldTo: TicketParty = {
    code: detail.customerCode, attn: billToAttn(detail.customerName, billTo), name: detail.customerName,
    street: billTo?.street ?? "", city: billTo?.city ?? "", state: billTo?.state ?? "", zip: billTo?.zip ?? "",
  };

  const shipToRow = detail.shipToAddressId === null ? null
    : await db.customerAddress.findFirst({ where: { id: detail.shipToAddressId } });
  const shipTo: TicketParty = {
    code: "", attn: "",
    name: shipToRow !== null && shipToRow.name !== "" ? shipToRow.name : detail.customerName,
    street: shipToRow?.street ?? "", city: shipToRow?.city ?? "",
    state: shipToRow?.state ?? "", zip: shipToRow?.zip ?? "",
  };

  // Completion from the detail the claim read, not a second read of the same `ShipperOrder` rows
  // (#628): `ShipperLineDetail.orderedQty` is live-first (the current order line's quantity, the
  // snapshot once released), which is the figure the rule compares against in each case. The part
  // descriptions below come from the same detail, live-first too (`readShipperDetail`), so the
  // ticket's stacked part cell (spec §10.1) needs no read of its own.
  const complete = await completionOfTargets(db, orders.map(completionTargetOf));

  return orders.map((o): TicketData => {
    // The quantity is added up here. No weight is: the ticket's builder works net, tare and gross
    // out from the lines and container rows below, through src/lib/net-weight.ts.
    let totalQty = 0;
    for (const l of o.lines) totalQty += l.qty;
    return {
      company: { ...settings.company, liabilityText: settings.liabilityText },
      soldTo, shipTo,
      orderLabel: o.label, orderNumber: o.orderNumber,
      shipDate: detail.shipDate, poNumber: o.poNumber,
      packingListNo: detail.shipperNumber, customerJobNo: o.customerJobNo,
      route: detail.route, carrierName: detail.carrierName ?? "",
      lines: o.lines.map((l) => ({
        qty: l.qty, partNumber: l.partNumber, partName: l.partName,
        partDescription: l.partDescription, pounds: l.weight,
      })),
      // `tareEach` is the shipment row's own figure, as `readShipperDetail` answers it, a kept
      // row's included. Never the live order row's.
      containers: o.containers.map((c) => ({
        typeName: c.typeName, count: c.count, customerContainerId: c.customerContainerId,
        tareEach: c.tareEach,
      })),
      serials: o.serials.filter((s) => s.printOnShipper).map((s) => ({ serial: s.serial, description: s.description })),
      // Every line on this ticket stood complete once this shipment had gone (design §3.5).
      shippedComplete: complete.get(o.id) ?? false,
      totalQty,
    };
  });
}

// #556: a whole-shipment ticket print costs its PAGES, not its orders. Measured 2026-10-18 at
// e0049156 on the laptop (Core Ultra X7 358H), power profile Performance, on mains: with no logo,
// three runs of each, about 29 ms a printed page; 160 one-page tickets stored in 4.66-4.73 s, and
// 120 and 160 two-page tickets passed Prisma's 5 s default and failed (a raw P2028, a 500) at
// 6.5 s and 8.7-9.1 s. At those sizes the render did not turn the event loop until its merged
// save, so Prisma's timer, and the ROLLBACK that releases every claim, waited for it: a print that
// ran past its 5 s budget held its claims until its merged save began, 148-198 ms before its render
// ended. With a placed logo (one run each at 80 and 160 orders) a page cost about 57 ms and the
// render turned, so the claims went when the timer ran. .182 is unmeasured.
// The owner gave it the traveler's 15 s (2026-10-18); a print whose claim expires is refused below
// and stores nothing. Keep this budget local: printBol, printCert and every other transaction but
// the traveler's print (TRAVELER_PRINT_TIMEOUT_MS, traveler.ts) keep their default.
const SHIPPING_TICKET_PRINT_TIMEOUT_MS = 15_000;

/**
 * Renders and archives the shipping ticket(s), returning the exact bytes stored — `printTraveler`'s
 * mechanic applied to a shipment (task-18-brief.md Step 4): settings OUTSIDE the transaction, then
 * one Serializable transaction bracketing claim → read → render → archive, so the stored PDF always
 * describes a fully-committed state no concurrent shipment edit can tear (traveler.ts's fix-wave R3
 * finding 1 reasoning, inherited wholesale).
 *
 * The claim is `claimOrdersInOrder` over every order on the shipment, then `claimShipperRow` on
 * the Shipper row itself — same fixed order as `claimLiveShipper` (order-locks.ts's house rule:
 * the guarded state, `Shipper.deletedAt`, lives on the Shipper row, so it must be locked with the
 * claim; without it a voidShipper committing while this print blocked on the order locks was
 * invisible to the print's fixed snapshot, and a NEW document could archive against a voided
 * shipment — whole-branch review Important #1's genuinely unprotected interleaving). The shipper
 * row is re-read AFTER the claims and checked with `assertPrintable` (documents.ts): a voided
 * shipment refuses a NEW print with the shared 400 while every stored print stays reprintable
 * forever (spec §5.6) — deliberately NOT `claimLiveShipper`, whose 404 would misname a void as
 * "not found".
 *
 * A print whose claims expire, its 15-second budget spent before its last statement or its commit,
 * is refused with a 400 and stores and audits nothing (#556, owner ruling 2026-10-18;
 * `SHIPPING_TICKET_PRINT_TIMEOUT_MS`; the catch below states the one case that stays a 500).
 *
 * `orderNumber` rides along (null for the whole set) purely so the route can name the download —
 * the `printTraveler` precedent.
 */
export async function printShippingTickets(
  shipperId: string, orderId?: string, opts: { withCerts?: boolean } = {},
): Promise<{
  documentId: string; shipperNumber: number; orderNumber: number | null; pdf: Buffer;
  /** cert=1 only (round-3 finding, 2026-08-06): resolved INSIDE this same claimed transaction,
   *  so the permanent bundle describes exactly the shipment state the tickets printed. */
  certs: { id: string; orderNumber: number }[]; warnings: string[];
}> {
  const settings = await ticketSettings();

  // What the refusal's log line names (#556, the catch below), set as the print reads it.
  const started = performance.now();
  let shipmentNumber: number | undefined;
  let ordersInPrint = orderId === undefined ? undefined : 1;

  return withDbErrors({ entity: "Shipper" }, () => prisma.$transaction(async (tx) => {
    // The pre-claim read exists ONLY to learn which orders to claim (the addOrderToShipper
    // shape — some unlocked read is unavoidable when the lock lives on the orders); everything
    // acted on below is re-read under the claim.
    const stub = await tx.shipper.findFirst({ where: { id: shipperId }, select: { id: true } });
    if (!stub) throw new HttpError(404, "Shipment not found");
    const shipmentOrderIds = await shipperOrderIds(tx, shipperId);
    ordersInPrint ??= shipmentOrderIds.length;
    await claimOrdersInOrder(tx, shipmentOrderIds);
    await claimShipperRow(tx, shipperId);

    const shipper = await tx.shipper.findFirst({ where: { id: shipperId } });
    if (!shipper) throw new HttpError(404, "Shipment not found");
    shipmentNumber = shipper.shipperNumber;
    assertPrintable(shipper);

    // Resolution by the SHIPMENT'S order count (P7 spec §5.2): a multi-order shipment's tickets
    // — INCLUDING the per-order print of one of its orders — resolve MOS_SHIPPER; a single-order
    // shipment's resolve SHIPPER. All paper from one shipment styles alike, so the count is the
    // shipment's, never the count of tickets being printed. `shipmentOrderIds` was read BEFORE
    // the lock statements — what keeps the count honest is this transaction's Serializable
    // snapshot, fixed at the stub read: the count and every read the render uses come from that
    // one snapshot, so a concurrent add/remove can never make the type disagree with the paper
    // (it either misses the snapshot entirely or SSI aborts one side). Resolution runs on THIS
    // claimed transaction at its isolation — correct by §5.1 immutability, not by locking (the
    // printTraveler comment); no template row is claimed and none is needed.
    const docType = shipmentOrderIds.length > 1 ? ("MOS_SHIPPER" as const) : ("SHIPPER" as const);
    const resolved = await resolveTemplateForPrint(tx, docType, shipper.customerId);
    // Logo bytes → data URI by the STORED mime type (spec §6.3); the builder renders it only
    // when the config also places it (the header knob, or a canvas Logo item with `config.logo`
    // null: `templatePlacesLogo`, the traveler's test), so an unplaced upload converts nothing.
    const logoDataUri = resolved.logoImage !== null && templatePlacesLogo(resolved.config)
      ? (resolved.logoMimeType === "image/jpeg"
          ? jpegDataUri(Buffer.from(resolved.logoImage))
          : pngDataUri(Buffer.from(resolved.logoImage)))
      : undefined;

    const { certs, warnings } = opts.withCerts
      ? await resolveShipmentCerts(tx, shipperId, orderId)
      : { certs: [], warnings: [] };

    // The liability text is the resolved CONFIG'S text block now (P7 spec §8: the template owns
    // the standing text; the `Setting` keeps its other readers until Task 14) — injected at the
    // data seam so the builder keeps one source per fact (its own doc comment tells the why).
    const data = await readShippingTicketData(tx, shipperId,
      { ...settings, liabilityText: resolved.config.textBlocks.shipper_liability_text }, orderId);
    // One definition per ticket, merged (P7 spec §6.1): each order's continuation band and — when
    // the template turns the knob on — page numbering scope to ITS OWN sheet group. The render
    // this claim spans is bounded by the shipment's own order count (the very claims above lock
    // one row per order, so the group count can never exceed what this transaction already
    // holds), each group page-bounded by its ticket's content — the #43-comment discipline.
    // That bounds the render's size, not its time, and nothing here bounds its time (#556): the
    // budget bounds how long a print can take and still store, a print past it is refused below,
    // and the render runs to its end either way. A render of one- or two-page tickets without a
    // logo was measured not to turn the event loop until its merged save.
    const pdf = await renderSheetGroups(
      buildShippingTicketDefinitions(data, docType, resolved.config, logoDataUri));

    // `resolved.versionId` is the §5.2 stamp: exactly which template version produced the paper.
    // A whole-set print records `shipmentOrderIds` as its coverage (#52): the same Serializable-
    // snapshot read the render itself consumed (see the docType comment above), so the recorded
    // set is exactly the orders the stored paper describes — no re-read, no new claim.
    const doc = await storeDocument(tx,
      orderId === undefined
        ? { kind: "SHIPPER", shipperId, orderId: null, coveredOrderIds: shipmentOrderIds }
        : { kind: "SHIPPER", shipperId, orderId },
      pdf, resolved.versionId);
    return {
      documentId: doc.id, shipperNumber: shipper.shipperNumber,
      orderNumber: orderId === undefined ? null : data[0].orderNumber, pdf,
      certs, warnings,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: SHIPPING_TICKET_PRINT_TIMEOUT_MS }))
    .catch((err: unknown): never => {
      // #556, owner ruling 2026-10-18: a print whose claims expire is refused. The expiry surfaces
      // at the next statement on `tx`, inside the callback, or at the commit, which `$transaction`
      // runs after the callback has returned. This catch is outside the transaction, so it sees
      // both, and outside `withDbErrors`, which passes a P2028 through unchanged. Nothing was
      // stored or audited: the rollback undid the archive's row and its audit entry if
      // `storeDocument` had run.
      //
      // When the claims go: Prisma's timer sends ROLLBACK at the first event-loop turn after the
      // budget, and it takes effect once no statement is in flight on the transaction. A render of
      // one- or two-page tickets without a logo was measured not to turn the loop until its merged
      // save, and a print blocked in a claim keeps what it has locked until the blocker ends.
      //
      // The sentence follows whether an order is named, never the shipment's order count: a
      // one-order shipment's Print all tickets is a whole-set print and takes the whole-set
      // sentence (owner, 2026-10-18). A 400, as #521's and #43's refusals are: the shipment page
      // shows a non-OK answer's `error` as written.
      //
      // Only two prints map the expiry, this one and `printSelectedTraveler` (traveler.ts, #521);
      // every other transaction keeps its default, and nothing retries it. The known miss is
      // `isExpiredTransaction`'s (db-errors.ts): an expired transaction that Prisma has already
      // forgotten, after 100 later closes, reads "Transaction not found" and stays a 500. The route's certification loop is never reached, since this
      // throw leaves the handler first, so no certification prints whether or not one was asked.
      //
      // One server log line per refusal (owner, 2026-10-18): the shipment number, the orders in the
      // print and the seconds taken, and nothing of the error, the PDF or the customer. A print
      // that expired while blocked in a claim, before its read of the shipment, names the shipment
      // by id; a whole-set print that expired before it read the shipment's orders names its
      // orders as unknown.
      if (!isExpiredTransaction(err)) throw err;
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      console.error(`[shipping-ticket] print refused, took too long: shipment ${shipmentNumber ?? `id ${shipperId}`}, `
        + `orders ${ordersInPrint ?? "unknown"}, ${seconds} s`);
      throw new HttpError(400, orderId === undefined
        ? "These shipping tickets took too long to print, so nothing was stored and no certifications were printed. Print each order's ticket from its own panel."
        : "This shipping ticket took too long to print, so nothing was stored and no certifications were printed.");
    });
}

// -------------------------------------------------------------------------------------------
// Task 19: the bill of lading (spec §10.2, §3.19/§3.20) — one per shipment, and it does not
// exist until someone prints one (the owner's Task 3 ruling, restated in §10.2): `bolNumber` is
// allocated lazily HERE, at first print, inside the claim-holding transaction, and never again.
// -------------------------------------------------------------------------------------------

/** Every SETTING the BOL needs, read BEFORE the print transaction opens (the ticketSettings
 *  precedent): the ship-from block is the company settings (spec §10.2). */
export type BolSettings = { company: { name: string; address: string } };

export async function bolSettings(): Promise<BolSettings> {
  const [name, address] = await Promise.all([
    getSetting("company_name"),
    getSetting("company_address"),
  ]);
  return { company: { name, address } };
}

/** Every container count across the shipment — the same sum the detail page displays for a
 *  blank package-count field. */
function containerSum(detail: ShipperDetail): number {
  return detail.orders.reduce((sum, so) => sum + so.containers.reduce((s, c) => s + c.count, 0), 0);
}

/**
 * Assembles the BOL payload off the same claim-held `db` the print transaction passes (the
 * `readShippingTicketData` rule). `bolNumber` is the CALLER's — inside `printBol` it may have
 * been allocated a statement earlier in this same transaction, so it travels as an argument
 * rather than being re-derived from a read that could not be wrong but would be one more thing
 * to reason about.
 *
 * Consignee semantics (spec §10.2, §3's closing note): the shipment's own ship-to address, read
 * UNFILTERED on deletedAt/active — the paper has to name where the truck went, whatever has
 * happened to the address book since (the ticket's own rule). A blank name falls back to the
 * customer's, exactly as the ticket's Ship To does.
 */
export async function readBolData(
  db: Db, shipperId: string, bolNumber: number, settings: BolSettings,
): Promise<BolData> {
  const detail = await readShipperDetail(db, shipperId); // 404s a missing shipment

  const shipToRow = detail.shipToAddressId === null ? null
    : await db.customerAddress.findFirst({ where: { id: detail.shipToAddressId } });
  const consignee: BolParty = {
    name: shipToRow !== null && shipToRow.name !== "" ? shipToRow.name : detail.customerName,
    street: shipToRow?.street ?? "", city: shipToRow?.city ?? "",
    state: shipToRow?.state ?? "", zip: shipToRow?.zip ?? "",
  };

  return {
    company: settings.company,
    bolNumber,
    proNumber: detail.proNumber, scacCode: detail.scacCode,
    carrierName: detail.carrierName ?? "",
    shipDate: detail.shipDate,
    consignee,
    // Ticket print order (`ShipperOrder.position`, already how readShipperDetail sorts) — the
    // sample's own "TRV NO. 91955,91957,91959,91960,91961" list (§3.20).
    orderNumbers: detail.orders.map((o) => o.orderNumber),
    poNumbers: detail.orders.map((o) => o.poNumber),
    // A stored null means "track the containers" (both shipment forms promise "Blank uses the
    // current container count"), so the default path derives the sum at print time rather than
    // printing an empty No. Packages cell. A container-less shipment stays blank — a printed "0"
    // would assert a count nobody entered.
    packageCount: detail.packageCount ?? (containerSum(detail) || null),
    freightDescription: detail.freightDescription,
    // What the builder works the weight cell out from (weights design §13.2): each order's line
    // weights and its container rows on this shipment, a kept row included, each row with the
    // shipment row's own tare each. Ticket print order. No weight is added up here.
    orders: detail.orders.map((o) => ({
      lineWeights: o.lines.map((l) => l.weight),
      containers: o.containers.map((c) => ({ count: c.count, tareEach: c.tareEach })),
    })),
    freightClass: detail.freightClass,
    freightTerms: detail.freightTerms,
  };
}

/**
 * Renders and archives the bill of lading, returning the exact bytes stored — the
 * `printShippingTickets` mechanic (settings outside, then ONE Serializable transaction bracketing
 * claim → re-read → assertPrintable → allocate → read-on-tx → render → archive), plus the one
 * thing only this print does: **`bolNumber` is allocated from `bol_number_next` on the first BOL
 * print only** (spec §3.19 — not every shipment gets a BOL, so allocating at shipment creation
 * would burn numbers), written through `auditedUpdate` so history records which print claimed
 * which number, and reused verbatim by every reprint. A voided shipment refuses a NEW print and
 * keeps its number forever (spec §5.6) — permanence is the absence of any write, the `voidShipper`
 * rule.
 */
export async function printBol(
  shipperId: string,
): Promise<{ documentId: string; bolNumber: number; shipperNumber: number; pdf: Buffer }> {
  const settings = await bolSettings();

  // `retryAllocation` (#115): only the FIRST print of a shipment allocates, but that is exactly the
  // print that can lose the counter race, and a 409 on a BOL print reads as "the printer is broken".
  // A losing attempt aborts AT the claim — before `renderPdf` — so a retry re-renders nothing it did
  // not already have to. A reprint (bolNumber already set) never enters the allocation branch and so
  // never has anything to retry.
  return withDbErrors({ entity: "Shipper" }, () => retryAllocation(() => prisma.$transaction(async (tx) => {
    // Pre-claim stub read only to learn which orders to claim (the printShippingTickets shape),
    // then the Shipper row's own claim AFTER the order claims (claimShipperRow's comment) — the
    // voided-state re-read below is only trustworthy under that lock.
    const stub = await tx.shipper.findFirst({ where: { id: shipperId }, select: { id: true } });
    if (!stub) throw new HttpError(404, "Shipment not found");
    const memberOrderIds = await shipperOrderIds(tx, shipperId);
    await claimOrdersInOrder(tx, memberOrderIds);
    await claimShipperRow(tx, shipperId);

    const shipper = await tx.shipper.findFirst({ where: { id: shipperId } });
    if (!shipper) throw new HttpError(404, "Shipment not found");
    assertPrintable(shipper);

    let bolNumber = shipper.bolNumber;
    if (bolNumber === null) {
      bolNumber = await allocateNumber("bol_number_next", tx);
      const allocated = bolNumber;
      await auditedUpdate("shipper", shipperId,
        () => tx.shipper.update({ where: { id: shipperId }, data: { bolNumber: allocated } }), { tx });
    }

    // Resolution is docType "BOL" REGARDLESS of the shipment's order count (P7 spec §5.2's other
    // half: the ticket splits SHIPPER/MOS_SHIPPER by count; the BOL is one per shipment and the
    // registry has no MOS_BOL — count-independence pinned in tests/bol-templates.test.ts).
    // Resolution runs on THIS claimed transaction at its isolation — correct by §5.1
    // immutability, not by locking (the printShippingTickets comment); no template row is
    // claimed and none is needed.
    const resolved = await resolveTemplateForPrint(tx, "BOL", shipper.customerId);
    // Logo bytes → data URI by the STORED mime type (spec §6.3), converted only when the config
    // places a logo (the header knob, or a canvas Logo item with `config.logo` null:
    // `templatePlacesLogo`, bill of lading canvas design §4.6), so an unplaced upload converts nothing.
    const logoDataUri = resolved.logoImage !== null && templatePlacesLogo(resolved.config)
      ? (resolved.logoMimeType === "image/jpeg"
          ? jpegDataUri(Buffer.from(resolved.logoImage))
          : pngDataUri(Buffer.from(resolved.logoImage)))
      : undefined;

    const data = await readBolData(tx, shipperId, bolNumber, settings);
    // ONE definition — the BOL is single-document paper, so `renderPdf` consumes it directly
    // (no sheet groups); its continuation band and the config's pageFooter knob ride on the
    // RenderableDefinition itself (buildBolDefinition's doc comment).
    const pdf = await renderPdf(buildBolDefinition(data, resolved.config, logoDataUri));

    // `resolved.versionId` is the §5.2 stamp: exactly which template version produced the paper.
    // `memberOrderIds` is the recorded coverage (#52): the same Serializable-snapshot read whose
    // orders `readBolData` printed (the printShippingTickets reasoning) — no re-read, no new claim.
    const doc = await storeDocument(tx,
      { kind: "BOL", shipperId, coveredOrderIds: memberOrderIds }, pdf, resolved.versionId);
    return { documentId: doc.id, bolNumber, shipperNumber: shipper.shipperNumber, pdf };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })));
}

/**
 * The cert=1 half of the shipment print action (spec §3.14, §9; task-19-brief.md Step 6):
 * resolves which certification prints alongside each covered order's ticket, WITHOUT printing
 * anything — the route prints the tickets and then each cert through `printCert` (certs.ts), so
 * each PDF is produced and stored as its own document exactly as §3.14 rules.
 *
 * "Each covered order's cert" resolves through the order's own frozen `certScope` (§6.1's
 * freeze is what makes this well-defined):
 *  - SHIPMENT — that order's live cert pinned to THIS shipment;
 *  - ORDER    — that order's live order-scope cert;
 *  - LOAD     — every live load-scope cert the order has (a shipment cannot know which loads went,
 *    and load certs exist only on demand, §3.17).
 *
 * An order that REQUIRES a cert (its frozen `certRequired`) with nothing to print gets a named
 * WARNING, never a refusal (§9 amendment 2026-08-05, owner-ratified — §3.13's "a missing cert
 * warns and never blocks", honored in the default pre-ticked flow): the tickets print and archive
 * exactly as a cert-less print would, no cert is archived for that order, and the warning names
 * it so the shipment page can surface the gap to the operator — never a silent drop (the Task 18
 * rule the original refusal over-served). Orders that DO have certs on the same request still
 * print theirs. An order that doesn't require one and has none simply contributes nothing. A
 * voided shipment refuses here with the shared refusal, BEFORE any ticket could print — its
 * ORDER-scope certs are still live (only shipment-scope certs are voided with the shipment, spec
 * §5.6), so without a voided-shipment check a voided shipment's print could still archive cert
 * paper. Round-3 finding (2026-08-06): this runs ONLY on `printShippingTickets`' own claimed
 * `tx` — a separate, unlocked resolution let shipment membership change between it and the
 * ticket transaction, so the archived bundle could describe two different shipment states. The
 * voided check is the caller's `assertPrintable` under that same claim.
 */
async function resolveShipmentCerts(
  db: Db, shipperId: string, orderId?: string,
): Promise<{ certs: { id: string; orderNumber: number }[]; warnings: string[] }> {
  const shipper = await db.shipper.findUnique({
    where: { id: shipperId }, select: { reversesShipperId: true },
  });
  // #183: a REVERSAL cannot carry a SHIPMENT-scope cert — the picker omits it and `createCert`
  // refuses one. So the SHIPMENT-scope "create it from /orders/N" warning below would name an action
  // that can never succeed on a reversal; suppress it there. (ORDER/LOAD scope stay warned — those
  // certs are creatable regardless, and a reversal's order-scope cert exists from order save.)
  const isReversal = shipper?.reversesShipperId != null;

  const shipperOrders = await db.shipperOrder.findMany({
    where: { shipperId, ...(orderId ? { orderId } : {}) },
    orderBy: { position: "asc" },
    select: {
      orderId: true,
      order: { select: { id: true, orderNumber: true, certRequired: true, certScope: true } },
    },
  });
  if (orderId !== undefined && shipperOrders.length === 0) {
    throw new HttpError(404, "That order is not on this shipment");
  }

  // #183: a reversal cannot be certified — skip its SHIPMENT scope entirely. There is no cert to
  // print, the "create it from /orders/N" warning would be unactionable (createCert refuses it and
  // the picker omits it), and any PRE-EXISTING invalid reversal cert (hand-raised before the guard)
  // is thereby never printed — the standing, mutation-free refusal that replaced a data migration
  // (Codex round 3: voiding legacy certs in SQL would strip their audit History).
  const certified = shipperOrders.filter((so) => !(isReversal && so.order.certScope === "SHIPMENT"));
  // Every order's certs in one read (#626), on the print's own `db`: each order's live certs of any
  // scope but SHIPMENT, and SHIPMENT ones of this shipment only. Each order then keeps the scope it
  // certifies at, in the read's own load-then-age order.
  const read = certified.length === 0 ? [] : await db.cert.findMany({
    where: {
      orderId: { in: certified.map((so) => so.orderId) }, deletedAt: null,
      OR: [{ scope: { not: "SHIPMENT" } }, { shipperId }],
    },
    orderBy: [{ loadNumber: "asc" }, { createdAt: "asc" }],
    select: { id: true, orderId: true, scope: true, shipperId: true },
  });

  const printable: { id: string; orderNumber: number }[] = [];
  const warnings: string[] = [];
  for (const so of certified) {
    const scope = so.order.certScope as CertScopeValue;
    const certs = read.filter((c) => c.orderId === so.orderId && c.scope === scope
      && (scope !== "SHIPMENT" || c.shipperId === shipperId));
    if (certs.length === 0 && so.order.certRequired) {
      // The saveNewShipper §5.7 warning's own shape, adapted to the print moment.
      warnings.push(
        `Order #${so.order.orderNumber} requires a certification and none exists to print — ` +
        `its ticket printed without one; create it from /orders/${so.order.id}`);
    }
    printable.push(...certs.map((c) => ({ id: c.id, orderNumber: so.order.orderNumber })));
  }
  return { certs: printable, warnings };
}

// -------------------------------------------------------------------------------------------
// Listing, export and the order-hub view (task-9-brief.md Step 4) — `use-latest`-friendly (pure
// data, no `tx`), `includeVoided` defaulting off (spec §5c's precedent), search over the
// packing-list number, BOL number, order number and customer code.
// -------------------------------------------------------------------------------------------

export type ShipperFilter = { customerId?: string; from?: string; to?: string; includeVoided?: boolean; search?: string };
/** One `ShipperOrder`'s slice of a row (Task 17, additive): the order hub's Shipments section
 *  shows THIS order's own label (`92036-3`), its own quantities, and whether its lines shipped
 *  complete — none of which the shipment-wide totals can answer once a shipment carries several
 *  orders. `complete` is the ledger's completion rule's answer (`completionOfTargets`, over the
 *  rows the hub's own select read, #628): every line on this order-on-shipment stood complete once
 *  the shipment had gone. It is on the hub's rows (`shipmentsForOrder`) alone:
 *  the shipping list and its Excel export show no Complete/Partial tag, so `listShippers` does not
 *  compute one and its rows carry no `complete` key (#631, owner ruling R4, 2026-10-22). */
export type ShipperRowOrder = {
  orderId: string; orderNumber: number; sequence: number;
  qty: number; weight: number; complete?: boolean;
};
export type ShipperRow = {
  id: string; shipperNumber: number; bolNumber: number | null; customerCode: string; customerName: string;
  shipDate: string; orderCount: number; orderLabels: string[]; orders: ShipperRowOrder[];
  carrierName: string | null;
  totalQty: number; totalWeight: number; freightAmount: number | null; deletedAt: string | null;
  /** Set when this shipment IS a reversal (§5.6) — its lines carry negative quantities. Carried on
   *  the row so `shipmentsForOrder` consumers can tell a reversal apart: #183 keeps it out of the
   *  cert scope picker, where a reversal-scope cert would print negative quantities and is refused. */
  reversesShipperNumber: number | null;
  /** The current live reversal, independent of list filters. Voiding it clears this label. */
  reversedByShipperNumber: number | null;
};

const ROW_SELECT = {
  id: true, shipperNumber: true, bolNumber: true, shipDate: true, freightAmount: true, deletedAt: true,
  customer: { select: { code: true, name: true } },
  carrier: { select: { name: true } },
  // #183: the original this document reverses, for `reversesShipperNumber` — the DETAIL_INCLUDE
  // `reverses` select, mirrored onto the row path so the list/`shipmentsForOrder` shape carries it too.
  reverses: { select: { shipperNumber: true } },
  // #232: use the detail page's live-only, deterministic counterpart selection. Historical
  // voided reversals must never replace the active one, even when Include voided is enabled.
  reversedBy: DETAIL_INCLUDE.reversedBy,
  orders: {
    // Deterministic order for `orderLabels` (and `orders`) — the issue #24 lesson applied here
    // too: an unordered collection makes a multi-order shipment's label list depend on Postgres's
    // own scan order rather than the print order the operator actually sees (DETAIL_INCLUDE's own
    // `orderBy: { position: "asc" }`, reused).
    orderBy: { position: "asc" },
    select: {
      id: true,
      orderId: true,
      sequence: true,
      order: { select: { orderNumber: true } },
      lines: { select: { qty: true, weight: true } },
    },
  },
} satisfies Prisma.ShipperSelect;

type ShipperRowShape = Prisma.ShipperGetPayload<{ select: typeof ROW_SELECT }>;

/** The order hub's row select: `ROW_SELECT` with each shipper line widened by what the completion
 *  rule needs (`orderLineId`, `lineComplete`, the snapshot `orderedQty` and the live line's current
 *  `qty`), so `shipmentsForOrder` hands `completionOfTargets` the rows it read instead of having the
 *  `ShipperOrder` rows read a second time (#628). Derived from `ROW_SELECT`, never a copy of it: the
 *  list's own select stays as narrow as the list, which reads over the whole history. */
const HUB_ROW_SELECT = {
  ...ROW_SELECT,
  orders: {
    ...ROW_SELECT.orders,
    select: {
      ...ROW_SELECT.orders.select,
      lines: {
        select: {
          qty: true, weight: true, orderLineId: true, lineComplete: true, orderedQty: true,
          orderLine: { select: { qty: true } },
        },
      },
    },
  },
} satisfies Prisma.ShipperSelect;

type HubRowShape = Prisma.ShipperGetPayload<{ select: typeof HUB_ROW_SELECT }>;

/** One `ShipperOrder` of a ticket's detail as the completion rule takes it: the detail's
 *  `orderedQty` is already live-first (`readShipperDetail`: `orderLine?.qty ?? orderedQty`). */
function completionTargetOf(so: ShipperOrderDetail): CompletionTarget {
  return {
    id: so.id, sequence: so.sequence,
    lines: so.lines.map((l) => ({
      orderLineId: l.orderLineId, qty: l.qty, lineComplete: l.lineComplete, orderedQty: l.orderedQty,
    })),
  };
}

/** One `ShipperOrder` of a hub row as the completion rule takes it. The row carries the snapshot
 *  `orderedQty` AND the live line's current `qty`, and the rule wants the live one while the line
 *  is live (a quantity corrected down to what shipped completes the line, #473), the snapshot once
 *  it is released: `orderLine?.qty ?? orderedQty`, the detail's own convention. The snapshot alone
 *  would hold a corrected-down order Partial for good (pinned in same-request-reads.test.ts). */
function hubCompletionTargetOf(so: HubRowShape["orders"][number]): CompletionTarget {
  return {
    id: so.id, sequence: so.sequence,
    lines: so.lines.map((l) => ({
      orderLineId: l.orderLineId, qty: l.qty, lineComplete: l.lineComplete,
      orderedQty: l.orderLine?.qty ?? l.orderedQty,
    })),
  };
}

/** `complete` is the ledger's answer per `ShipperOrder` id, or null where the caller computed none:
 *  then the order slice carries no `complete` key at all (not `undefined`, which a JSON consumer
 *  and `toHaveProperty` would both see as a value). */
function toShipperRow(row: ShipperRowShape, complete: Map<string, boolean> | null): ShipperRow {
  const orderLabels = row.orders.map((o) => `${o.order.orderNumber}-${o.sequence}`);
  // Per-order sums in integer cents, exactly like the shipment-wide totals below — the same
  // IEEE754-sidestep `lineTotals` (order-internals.ts) documents.
  const orders = row.orders.map((so): ShipperRowOrder => {
    let qty = 0;
    let cents = 0;
    for (const l of so.lines) {
      qty += l.qty;
      cents += Math.round(l.weight.toNumber() * 100);
    }
    return {
      orderId: so.orderId, orderNumber: so.order.orderNumber, sequence: so.sequence,
      qty, weight: cents / 100,
      ...(complete ? { complete: complete.get(so.id) ?? false } : {}),
    };
  });
  let totalQty = 0;
  let weightCents = 0;
  for (const so of row.orders) {
    for (const l of so.lines) {
      totalQty += l.qty;
      weightCents += Math.round(l.weight.toNumber() * 100);
    }
  }
  return {
    id: row.id, shipperNumber: row.shipperNumber, bolNumber: row.bolNumber,
    customerCode: row.customer.code, customerName: row.customer.name,
    shipDate: formatDateOnly(row.shipDate), orderCount: row.orders.length, orderLabels, orders,
    carrierName: row.carrier?.name ?? null,
    totalQty, totalWeight: weightCents / 100,
    freightAmount: num(row.freightAmount), deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    reversesShipperNumber: row.reverses?.shipperNumber ?? null,
    reversedByShipperNumber: row.reversedBy[0]?.shipperNumber ?? null,
  };
}

function shipperSearchWhere(term: string): Prisma.ShipperWhereInput[] {
  const clauses: Prisma.ShipperWhereInput[] = [
    { customer: { code: { contains: term, mode: "insensitive" } } },
  ];
  // shipperNumber/bolNumber/orderNumber are Int4 columns (the orders.ts `searchWhere` precedent):
  // a longer digit string is not a value they can hold, and handing it to Prisma is a validation
  // error, not "no match".
  const asNumber = Number(term);
  if (/^\d+$/.test(term) && Number.isSafeInteger(asNumber) && asNumber <= 2_147_483_647) {
    clauses.push({ shipperNumber: asNumber });
    clauses.push({ bolNumber: asNumber });
    clauses.push({ orders: { some: { order: { orderNumber: asNumber } } } });
  }
  return clauses;
}

function shipperListWhere(filter: ShipperFilter): Prisma.ShipperWhereInput {
  const term = filter.search?.trim();
  const shipDate = filter.from || filter.to ? {
    ...(filter.from ? { gte: parseDate(filter.from, "Ship date from") } : {}),
    ...(filter.to ? { lte: parseDate(filter.to, "Ship date to") } : {}),
  } : undefined;
  return {
    // Voided shipments leave the list unless the toggle is on (spec §5c's precedent).
    ...(filter.includeVoided ? {} : { deletedAt: null }),
    ...(filter.customerId ? { customerId: filter.customerId } : {}),
    ...(shipDate ? { shipDate } : {}),
    ...(term ? { OR: shipperSearchWhere(term) } : {}),
  };
}

/** One builder for the list, its export and the hub. `completion` decides whether the ledger is
 *  asked (`completionOfTargets`: one read over every live shipper line of every order line on the
 *  listed shipments, nearly the whole table for an unfiltered list). The hub's Shipments section
 *  renders the Complete/Partial tag, so `shipmentsForOrder` asks, from the rows its own wider
 *  select read (`HUB_ROW_SELECT`, #628); the shipping list and its Excel export render none, so
 *  `listShippers` does not, and a row of theirs carries no `complete` key (#631, owner ruling R4).
 *  `tests/shipping-list-statements.test.ts` and `tests/same-request-reads.test.ts` count both. */
async function toShipperRows(rows: ShipperRowShape[], options: { completion: false }): Promise<ShipperRow[]>;
async function toShipperRows(rows: HubRowShape[], options: { completion: true }): Promise<ShipperRow[]>;
async function toShipperRows(
  rows: ShipperRowShape[] | HubRowShape[], { completion }: { completion: boolean },
): Promise<ShipperRow[]> {
  const complete = completion
    ? await completionOfTargets(prisma, (rows as HubRowShape[]).flatMap((r) => r.orders.map(hubCompletionTargetOf)))
    : null;
  return rows.map((r) => toShipperRow(r, complete));
}

/** Newest ship date first, `shipperNumber` (unique) tie-broken — two shipments sharing a ship date
 *  still sort deterministically (the `readAudit` precedent, audit.ts). Unbounded when `take` is
 *  absent (`listShippers`, the export), or the first `take` rows (`listShippersWindow`, #612). */
async function readShipperRows(filter: ShipperFilter, take?: number): Promise<ShipperRow[]> {
  const rows = await prisma.shipper.findMany({
    where: shipperListWhere(filter), select: ROW_SELECT, orderBy: [{ shipDate: "desc" }, { shipperNumber: "desc" }],
    ...(take === undefined ? {} : { take }),
  });
  // No Complete/Partial tag on the list or its export (#631): `exportShippers` reads through here.
  return toShipperRows(rows, { completion: false });
}

/** Every matching shipment: the export and the bare route's readers read this, and it stays
 *  unbounded (ruling R3 keeps exports unlimited). */
export async function listShippers(filter: ShipperFilter): Promise<ShipperRow[]> {
  return readShipperRows(filter);
}

/** The shipping list's windowed read (#612, ruling R3): the newest `window` shipments, read one
 *  past the window so the answer says whether anything was cut. The list route serves it under
 *  `?window=1`; nothing else reads it. */
export async function listShippersWindow(filter: ShipperFilter, window = LIST_WINDOW): Promise<ListWindow<ShipperRow>> {
  return cutToWindow(await readShipperRows(filter, window + 1), window);
}

const SHIPPER_COLUMNS = [
  { key: "shipperNumber", header: "Packing List No" },
  { key: "bolNumber", header: "BOL No" },
  { key: "customerCode", header: "Customer code" },
  { key: "customerName", header: "Customer name" },
  { key: "shipDate", header: "Ship date" },
  { key: "orderLabels", header: "Orders" },
  { key: "carrierName", header: "Carrier" },
  { key: "totalQty", header: "Qty" },
  { key: "totalWeight", header: NET_WEIGHT_LB },
  { key: "freightAmount", header: "Freight amount" },
  { key: "voided", header: "Voided" },
];

/** Exactly what `listShippers` returned for the same filter — same query, same rows, humanized
 *  cells (the `exportCerts`/`exportOrders` precedent). */
export async function exportShippers(filter: ShipperFilter): Promise<Buffer> {
  const rows = await listShippers(filter);
  const xlsxRows = rows.map((r) => ({ ...r, orderLabels: r.orderLabels.join(", "), voided: r.deletedAt ? "yes" : "no" }));
  return toXlsx("Shipments", SHIPPER_COLUMNS, xlsxRows as unknown as Record<string, unknown>[]);
}

/** Every shipment that has ever carried this order, voided included — the order hub's own
 *  "Shipments" section needs to see a voided shipment too, not have it silently vanish (the
 *  `certsForOrder` precedent, certs.ts). */
export async function shipmentsForOrder(orderId: string): Promise<ShipperRow[]> {
  const rows = await prisma.shipper.findMany({
    where: { orders: { some: { orderId } } },
    select: HUB_ROW_SELECT, orderBy: [{ shipDate: "desc" }, { shipperNumber: "desc" }],
  });
  // The hub's Shipments section shows each shipment's Complete/Partial tag, so this read pays for
  // it, from the rows it just read (#628).
  return toShipperRows(rows, { completion: true });
}
