import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, type Order } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors, retryAllocation, isDuplicateClientRequestId, retryOnSerializationConflict } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { assertRefExists } from "./reference-guards";
import { decimalField, decimalBoxField } from "./decimal-field";
import { INVOICE_LINE_NET_WEIGHT, INVOICE_LINE_AMOUNT } from "../lib/money-boxes";
import { claimOrder } from "./order-locks";
import { hasReceivableActivity, applicationVoidHint } from "./invoice-guards";
import { assertPeriodOpen } from "./period-locks";
import { currentActor } from "./context";
import { getBillingConfig, type BillingConfigRow } from "./billing-config";
import { listSurcharges, buildSurcharges, CUSTOMER_SURCHARGE_SELECT, type SurchargeRow } from "./surcharges";
import { listPartPricesByPart, PRICE_ROW_INCLUDE, PRICE_ROW_ORDER } from "./part-prices";
import { listAddresses, type AddressRow } from "./customer-addresses";
import { billToLines, pickDefaultAddress } from "./party-address";
import { getSetting, allocateNumber } from "./settings";
import { shippedTotals, recomputeOrderStatus } from "./ship-ledger";
import {
  priceOrder, taxOnLines, surchargeOnLines, surchargeLine,
  type PricingInput, type OrderLineInput, type PriceRowInput, type ChargeInput,
  type GlRef, type ComputedLine, type SurchargeRule,
} from "./pricing";
import { parseDateOnly, formatDateOnly, todayDateOnly, dateOnly, addDays } from "../lib/business-days";
import {
  INVOICE_LINE_KINDS, PRICE_SOURCES, invoiceDocumentNumber,
  type InvoiceKindValue, type InvoiceStatusValue, type InvoiceLineKindValue, type PriceSourceValue,
  type InvoicePrinted,
} from "../lib/invoice-constants";
import { PRICE_PER, PRICE_PER_LABELS, type PricePerValue } from "../lib/part-constants";
import { ORDER_STATUS_LABELS } from "../lib/order-constants";
import { printedSince, selectedPrintRefusal } from "../lib/invoice-printed";
import { readRemovedLines, removedLineLabel, NOT_REMOVED, type RemovedLine } from "../lib/invoice-removed-lines";
import { shipmentFingerprintSource, type ShipmentFingerprintInput } from "../lib/invoice-shipment-fingerprint";
import { LIST_WINDOW, cutToWindow, type ListWindow } from "../lib/list-window";
import { renderPdf, jpegDataUri, pngDataUri } from "./pdf/render";
import { buildInvoiceDefinition, type InvoicePdfData, type InvoiceAmountRow } from "./pdf/invoice";
import { storeDocument, assertPrintable } from "./documents";
import { nextFilingTicket, type CustomerFiling } from "./customer-folders";
import { resolveTemplateForPrint } from "./template-assignments";
import { templatePlacesLogo } from "../lib/template-contracts/template-logo";

// -------------------------------------------------------------------------------------------
// Task 11 (P5A §5.4/§5.7/§10): where pricing becomes a customer-facing invoice. `listInvoice
// candidates` finds fully-shipped, not-yet-invoiced orders; `createInvoice` snapshots the shipped
// quantities and the resolved prices into a DRAFT invoice a later task finalizes and locks.
//
// The math lives entirely in `priceOrder` (pricing.ts, the pure engine). This file's job is to
// assemble that engine's input from live data — and to close the three seams the engine
// deliberately left open, each of which is money reaching (or not reaching) the right place:
//
//   1. CHARGE lines arrive from the engine with a null GL account (`ChargeInput` carries no
//      `GlRef` — the pure engine cannot reach `BillingConfig`). `BillingConfig.otherChargeGlAccount
//      Id` is assigned to CHARGE lines HERE, or a whole class of charge lines posts to no account
//      and the GL export is silently incomplete. See `mapLine`.
//   2. `SurchargeRow.glAccountName` is `string | null`, but `InvoiceLine.glAccountName` is NOT NULL
//      (`String @default("")`). The `?? ""` normalization is done deliberately at the surcharge
//      seam in `buildSurcharges`.
//   3. A line whose net shipped total is zero is NEVER handed to the engine — the engine bills
//      `max(extended, minimumCharge) + setupCharge`, so a zero-net line would bill the FULL minimum
//      plus setup for no work. Filtered in `buildPricingInput`.
// -------------------------------------------------------------------------------------------

// Either the top-level client or a `tx` — the `readShipperDetail`/`readDetail` precedent: this
// module's read side serves both `getInvoice` and the tail of the create transaction.
type Db = Prisma.TransactionClient;

const num = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());

/** `parseDateOnly` at the service boundary — the `shippers.ts`/`orders.ts` `parseDate` precedent. */
function parseDate(value: string, field: string): Date {
  try {
    return parseDateOnly(value);
  } catch {
    throw new HttpError(400, `"${value}" is not a valid date (yyyy-mm-dd) for ${field}`);
  }
}

export type InvoiceLineDetail = {
  id: string; position: number; kind: InvoiceLineKindValue; parentLineId: string | null;
  orderLineId: string | null; processStepCodeId: string | null;
  surchargeId: string | null; orderChargeId: string | null; glAccountId: string | null;
  partNumber: string; partName: string; partDescription: string;
  description: string; glAccountName: string;
  qty: number | null; weight: number | null; eachWeight: number | null;
  pricePer: PricePerValue | null;
  unitPrice: number | null; setupCharge: number | null; minimumCharge: number | null;
  breakThreshold: number | null; minimumApplied: boolean;
  rate: number | null; priceSource: PriceSourceValue | null;
  /** Frozen at line write when `priceSource = QUOTE`, read UNCONDITIONALLY (the frozen-paper
   *  rule): a later quote delete must never blank sent paper. Never a live join to the quote. */
  sourceQuoteNumber: number | null;
  needsPrice: boolean;
  /** #587: the line's words were typed or picked on it (`InvoiceLine.wordsChosen`). */
  wordsChosen: boolean;
  amount: number;
};

export type InvoiceDetail = {
  id: string; kind: InvoiceKindValue; status: InvoiceStatusValue;
  orderId: string; orderNumber: number; documentNumber: string;
  sourceInvoiceId: string | null; creditNumber: number | null;
  /** A credit's source invoice by its document number (PR 6: the credit page's title); null on an
   *  invoice, and on a credit whose source the read could not name. */
  sourceInvoiceNumber: string | null;
  customerId: string; customerCode: string; customerName: string;
  invoiceDate: string; dueDate: string | null; poNumber: string; termsName: string;
  billTo: string; shipTo: string; materialName: string; processNames: string;
  taxRate: number | null;
  subtotal: number; surchargeTotal: number; chargeTotal: number;
  certTotal: number; freightTotal: number; taxTotal: number; total: number;
  finalizedAt: string | null; deletedAt: string | null;
  lines: InvoiceLineDetail[];
  /** #594: the computed lines removed from this draft, which Recalculate leaves out. */
  removedLines: RemovedLine[];
};

export type InvoiceCandidate = {
  orderId: string; orderNumber: number; customerCode: string; customerName: string;
  poNumber: string; lastShipDate: string | null;
};

export type InvoiceCreateResult = { invoice: InvoiceDetail; warnings: string[]; deduped: boolean };

// -------------------------------------------------------------------------------------------
// Read side — `readShipperDetail`'s shape (shippers.ts:334-348).
// -------------------------------------------------------------------------------------------

const DETAIL_INCLUDE = {
  // `terms` is read here (not a second query) so `finalizeInvoiceInTx` can compute `dueDate` off the
  // SAME row this transaction already claimed via `claimInvoiceRow` — no new lock (Task 3/§4.3).
  // `netDays` drives `dueDate` at finalize; the discount pair is frozen onto the invoice there too
  // (#79), so the claim reads all three from the customer's terms in one go. `invoiceFolder` is the
  // print's (#588): a finalized print files its copy in the claimed row's own customer's folder.
  customer: {
    select: {
      code: true, name: true, invoiceFolder: true,
      terms: { select: { name: true, netDays: true, discountPercent: true, discountDays: true } },
    },
  },
  order: { select: { orderNumber: true } },
  lines: { orderBy: { position: "asc" } },
} satisfies Prisma.InvoiceInclude;

type DetailRow = Prisma.InvoiceGetPayload<{ include: typeof DETAIL_INCLUDE }>;
type LineRow = DetailRow["lines"][number];

/** An invoice line reads its snapshot columns UNCONDITIONALLY (§5.4) — unlike a shipper line's
 *  live-join-first `toDetail`. An invoice is frozen paper: ruling 24's refinement says a frozen
 *  document reads its own snapshot, never a live join that a later part rename could drift. */
function toLineDetail(l: LineRow): InvoiceLineDetail {
  return {
    id: l.id, position: l.position, kind: l.kind, parentLineId: l.parentLineId,
    orderLineId: l.orderLineId, processStepCodeId: l.processStepCodeId,
    surchargeId: l.surchargeId, orderChargeId: l.orderChargeId, glAccountId: l.glAccountId,
    partNumber: l.partNumber, partName: l.partName, partDescription: l.partDescription,
    description: l.description, glAccountName: l.glAccountName,
    qty: l.qty, weight: num(l.weight), eachWeight: num(l.eachWeight),
    pricePer: l.pricePer, unitPrice: num(l.unitPrice),
    setupCharge: num(l.setupCharge), minimumCharge: num(l.minimumCharge),
    breakThreshold: num(l.breakThreshold), minimumApplied: l.minimumApplied,
    rate: num(l.rate), priceSource: l.priceSource, sourceQuoteNumber: l.sourceQuoteNumber,
    needsPrice: l.needsPrice, wordsChosen: l.wordsChosen,
    amount: l.amount.toNumber(),
  };
}

function toInvoiceDetail(row: DetailRow, prefix: string): InvoiceDetail {
  return {
    id: row.id, kind: row.kind, status: row.status,
    orderId: row.orderId, orderNumber: row.order.orderNumber,
    documentNumber: invoiceDocumentNumber(row.kind, row.creditNumber, row.order.orderNumber, prefix),
    sourceInvoiceId: row.sourceInvoiceId, creditNumber: row.creditNumber,
    // PR 6: a credit shares its source invoice's order (`createCredit` copies `orderId`) and a credit
    // is never credited, so the source is the INVOICE of this row's own order: named from the row
    // already read, never a second read of the Invoice table (tests/same-request-reads.test.ts).
    sourceInvoiceNumber: row.kind === "CREDIT" && row.sourceInvoiceId !== null
      ? invoiceDocumentNumber("INVOICE", null, row.order.orderNumber, prefix)
      : null,
    customerId: row.customerId, customerCode: row.customer.code, customerName: row.customer.name,
    invoiceDate: formatDateOnly(row.invoiceDate),
    dueDate: row.dueDate ? formatDateOnly(row.dueDate) : null,
    poNumber: row.poNumber, termsName: row.termsName,
    billTo: row.billTo, shipTo: row.shipTo,
    materialName: row.materialName, processNames: row.processNames,
    taxRate: num(row.taxRate),
    subtotal: row.subtotal.toNumber(), surchargeTotal: row.surchargeTotal.toNumber(),
    chargeTotal: row.chargeTotal.toNumber(), certTotal: row.certTotal.toNumber(),
    freightTotal: row.freightTotal.toNumber(), taxTotal: row.taxTotal.toNumber(),
    total: row.total.toNumber(),
    finalizedAt: row.finalizedAt ? row.finalizedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    lines: row.lines.map(toLineDetail),
    removedLines: readRemovedLines(row.removedLines),
  };
}

/** Exported for callers that need the full detail on a `tx` — the `readShipperDetail` precedent.
 *  Never filters `deletedAt`: a discarded draft stays readable (the voided-order `readDetail`
 *  precedent). */
export async function readInvoiceDetail(db: Db, id: string): Promise<InvoiceDetail> {
  const row = await db.invoice.findFirst({ where: { id }, include: DETAIL_INCLUDE });
  if (!row) throw new HttpError(404, "Invoice not found");
  const prefix = await getSetting("invoice_number_prefix", db);
  return toInvoiceDetail(row, prefix);
}

export async function getInvoice(id: string): Promise<InvoiceDetail> {
  return readInvoiceDetail(prisma, id);
}

// -------------------------------------------------------------------------------------------
// Candidates — orders at SHIPPED with no live INVOICE (§5.4).
// -------------------------------------------------------------------------------------------

export async function listInvoiceCandidates(
  filter: { customerId?: string; from?: string; to?: string },
): Promise<InvoiceCandidate[]> {
  const from = filter.from ? parseDate(filter.from, "From date") : undefined;
  const to = filter.to ? parseDate(filter.to, "To date") : undefined;
  const shipDateWindow = from || to
    ? { shipDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
    : undefined;

  const orders = await prisma.order.findMany({
    where: {
      deletedAt: null,
      status: "SHIPPED",
      // The live partial-unique guard's own predicate: no live invoice (a CREDIT does not count).
      invoices: { none: { kind: "INVOICE", deletedAt: null } },
      ...(filter.customerId ? { customerId: filter.customerId } : {}),
      ...(shipDateWindow ? { shipperOrders: { some: { shipper: { deletedAt: null, ...shipDateWindow } } } } : {}),
    },
    orderBy: { orderNumber: "asc" },
    select: {
      id: true, orderNumber: true, poNumber: true,
      customer: { select: { code: true, name: true } },
      // Every LIVE shipment's ship date — `lastShipDate` is the max across them.
      shipperOrders: {
        where: { shipper: { deletedAt: null } },
        select: { shipper: { select: { shipDate: true } } },
      },
    },
  });

  return orders.map((o) => {
    const times = o.shipperOrders.map((so) => so.shipper.shipDate.getTime());
    const last = times.length ? new Date(Math.max(...times)) : null;
    return {
      orderId: o.id, orderNumber: o.orderNumber,
      customerCode: o.customer.code, customerName: o.customer.name,
      poNumber: o.poNumber, lastShipDate: last ? formatDateOnly(last) : null,
    };
  });
}

// -------------------------------------------------------------------------------------------
// List — every invoice/credit (Task 16, the routes task: the worklist's second section, and the
// order hub's Invoices section, both need the actual documents rather than the candidates above).
// Row shape stays a thin summary — `getInvoice`/`readInvoiceDetail` is still the source of the
// full detail a single page reads — the `listShippers`/`ShipperRow` precedent (shippers.ts).
// -------------------------------------------------------------------------------------------

export type InvoiceListRow = {
  id: string; kind: InvoiceKindValue; status: InvoiceStatusValue;
  orderId: string; orderNumber: number; documentNumber: string;
  customerId: string; customerCode: string; customerName: string;
  invoiceDate: string; total: number; finalizedAt: string | null; deletedAt: string | null;
};

/** The register's filters. `printed` (the UX redesign PR 6, owner 2026-10-31) is not a column: a
 *  row's `printedAt` is derived from its prints after the read (`readRegister`), so the filter is
 *  applied to the derived rows, and a windowed read under it reads the register whole first. */
export type InvoiceFilter = {
  customerId?: string; status?: InvoiceStatusValue; from?: string; to?: string; printed?: InvoicePrinted;
};

const LIST_SELECT = {
  id: true, kind: true, status: true, orderId: true, customerId: true, creditNumber: true,
  order: { select: { orderNumber: true } },
  customer: { select: { code: true, name: true } },
  invoiceDate: true, total: true, finalizedAt: true, deletedAt: true,
} satisfies Prisma.InvoiceSelect;

type ListRowShape = Prisma.InvoiceGetPayload<{ select: typeof LIST_SELECT }>;

function toListRow(row: ListRowShape, prefix: string): InvoiceListRow {
  return {
    id: row.id, kind: row.kind, status: row.status,
    orderId: row.orderId, orderNumber: row.order.orderNumber,
    documentNumber: invoiceDocumentNumber(row.kind, row.creditNumber, row.order.orderNumber, prefix),
    customerId: row.customerId, customerCode: row.customer.code, customerName: row.customer.name,
    invoiceDate: formatDateOnly(row.invoiceDate), total: row.total.toNumber(),
    finalizedAt: row.finalizedAt ? row.finalizedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

function invoiceListWhere(filter: InvoiceFilter): Prisma.InvoiceWhereInput {
  const invoiceDate = filter.from || filter.to ? {
    ...(filter.from ? { gte: parseDate(filter.from, "Invoice date from") } : {}),
    ...(filter.to ? { lte: parseDate(filter.to, "Invoice date to") } : {}),
  } : undefined;
  return {
    deletedAt: null, // a discarded draft never printed and is a candidate again (listInvoiceCandidates)
    ...(filter.customerId ? { customerId: filter.customerId } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(invoiceDate ? { invoiceDate } : {}),
  };
}

/** The Invoicing list's own row (#591): the list row plus when it last printed since it was
 *  finalized (a draft: its newest print; `printedSince`, src/lib/invoice-printed.ts; owner ruling
 *  591-1), the credit number a credit memo's download is named by, and whether its order is voided
 *  (a row on a voided order takes no box, `printTickable`; the owner, 2026-10-21). The order hub
 *  keeps the plain `InvoiceListRow`: Printed is on the Invoicing list and its two exports only, the
 *  Excel and the register PDF (591-9, #592). */
export type InvoiceRegisterRow = InvoiceListRow & {
  printedAt: string | null; creditNumber: number | null; orderVoided: boolean;
};

/** `LIST_SELECT` plus the order's `deletedAt`, for the register alone: the hub's `invoicesForOrder`
 *  shares `LIST_SELECT` and needs none of it. */
const REGISTER_SELECT = {
  ...LIST_SELECT,
  order: { select: { orderNumber: true, deletedAt: true } },
  createdAt: true, // the list's second sort key, which a cut window's prints bound reads (#612)
} satisfies Prisma.InvoiceSelect;

/** The register's sort: newest invoice date first, then the newest created. */
const REGISTER_ORDER_BY = [{ invoiceDate: "desc" }, { createdAt: "desc" }] satisfies Prisma.InvoiceOrderByWithRelationInput[];

/** The invoices at or before `last` in the register's sort: a later invoice date, or the same date
 *  and created at or after it. A tie on both keys past the window names an extra invoice, whose
 *  print is read and matches no listed row, which is harmless (#612 PR D, owner 2026-10-27). */
function windowBound(last: { invoiceDate: Date; createdAt: Date }): Prisma.InvoiceWhereInput {
  return {
    OR: [
      { invoiceDate: { gt: last.invoiceDate } },
      { invoiceDate: last.invoiceDate, createdAt: { gte: last.createdAt } },
    ],
  };
}

/** Every live invoice/credit, newest first — Task 17's worklist "Invoices" section. The rows and
 *  their prints are figures shown together, so they are read together: one read-only RepeatableRead
 *  transaction (the `aging.ts` `readSnapshot` shape), the prefix read outside it. Unbounded: the
 *  bare route, the Excel and (through `readInvoiceRegister`) the register PDF read every row. */
export async function listInvoices(filter: InvoiceFilter): Promise<InvoiceRegisterRow[]> {
  const prefix = await getSetting("invoice_number_prefix");
  return prisma.$transaction(
    (tx) => readInvoiceRegister(tx, filter, prefix),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

/** The Invoicing list's windowed read (#612, ruling R3): the newest `window` invoices and their
 *  prints, in the same one transaction, read one past the window so the answer says whether
 *  anything was cut. The list route serves it under `?window=1`; nothing else reads it. */
export async function listInvoicesWindow(filter: InvoiceFilter, window = LIST_WINDOW): Promise<ListWindow<InvoiceRegisterRow>> {
  const prefix = await getSetting("invoice_number_prefix");
  return prisma.$transaction(
    (tx) => readInvoiceRegisterWindow(tx, filter, prefix, window),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

/** The unbounded register read, on the caller's transaction (exported for its test). */
export async function readInvoiceRegister(
  tx: Db, filter: InvoiceFilter, prefix: string,
): Promise<InvoiceRegisterRow[]> {
  return (await readRegister(tx, filter, prefix)).rows;
}

/** The windowed register read, on the caller's transaction (exported for its test). */
export async function readInvoiceRegisterWindow(
  tx: Db, filter: InvoiceFilter, prefix: string, window = LIST_WINDOW,
): Promise<ListWindow<InvoiceRegisterRow>> {
  return readRegister(tx, filter, prefix, window);
}

/**
 * The register read: every row when `window` is absent, or the first `window` rows of the sort read
 * one past it. The prints are one `groupBy` for the newest `createdAt` per invoice, filtered through
 * the invoice relation by the list's own `where`, never by an `in` list of the listed ids: Prisma
 * binds one parameter per id and refuses above about 32,000, and show all and the exports have no
 * paging. A cut window narrows that `where` by the last kept row's sort key (`windowBound`; the
 * owner, 2026-10-27, #612 PR D), so the prints read follows the window. No `kind` filter: the
 * kind→owner CHECK lets only an INVOICE or CREDIT document carry an `invoiceId`.
 *
 * The Printed filter (PR 6, owner 2026-10-31) names a derived figure, so under it the rows are read
 * whole (no `take`), every row's `printedAt` is derived, the rows it names are kept, and only then
 * is the window cut: the newest `window` rows AMONG the ones it names, and `cut` when one more is
 * past them. Still one invoice read and one prints read, the prints over the plain `where` (no
 * read-time cut to bound them by). The cost: a To print view reads every live invoice.
 */
async function readRegister(
  tx: Db, filter: InvoiceFilter, prefix: string, window?: number,
): Promise<ListWindow<InvoiceRegisterRow>> {
  const where = invoiceListWhere(filter);
  const bounded = window !== undefined && filter.printed === undefined;
  const read = await tx.invoice.findMany({
    where, select: REGISTER_SELECT, orderBy: REGISTER_ORDER_BY,
    ...(bounded ? { take: window + 1 } : {}),
  });
  const { rows, cut } = bounded ? cutToWindow(read, window) : { rows: read, cut: false };
  const last = rows.at(-1);
  const printsWhere = cut && last ? { AND: [where, windowBound(last)] } : where;
  const prints = await tx.storedDocument.groupBy({
    by: ["invoiceId"], where: { invoice: { is: printsWhere } }, _max: { createdAt: true },
  });
  const newestPrint = new Map<string, Date | null>();
  for (const p of prints) if (p.invoiceId !== null) newestPrint.set(p.invoiceId, p._max.createdAt);
  const derived = rows.map((r) => {
    const printedAt = printedSince(r.finalizedAt, newestPrint.get(r.id) ?? null);
    return {
      ...toListRow(r, prefix), printedAt: printedAt ? printedAt.toISOString() : null,
      creditNumber: r.creditNumber, orderVoided: r.order.deletedAt !== null,
    };
  });
  if (filter.printed === undefined) return { cut, rows: derived };
  const wanted = filter.printed === "1";
  const named = derived.filter((r) => (r.printedAt !== null) === wanted);
  return window === undefined ? { cut: false, rows: named } : cutToWindow(named, window);
}

/** The Invoice register PDF's read (#592): the register's rows and, when the filter names a
 *  customer, that customer's code and name for the PDF's filter line. */
export type InvoiceRegisterForPdf = { rows: InvoiceRegisterRow[]; customer: { code: string; name: string } | null };

/**
 * `listInvoiceRegisterForPdf`'s read, on the caller's transaction (exported for its test). The rows
 * are read first, so a malformed date answers `readInvoiceRegister`'s 400 before anything else. The
 * customer is read by id with no `deletedAt` filter: a soft-deleted customer's invoices still list,
 * and the line still names it. An id that names no customer at all is refused (owner ruling,
 * 2026-10-21, plan Amendment 11), on the PDF alone: the list and the Excel answer no rows for it.
 * A blank id names none, as the list's `where` (`invoiceListWhere`) reads it.
 */
export async function readInvoiceRegisterForPdf(
  tx: Db, filter: InvoiceFilter, prefix: string,
): Promise<InvoiceRegisterForPdf> {
  const rows = await readInvoiceRegister(tx, filter, prefix);
  if (!filter.customerId) return { rows, customer: null };
  const customer = await tx.customer.findFirst({ where: { id: filter.customerId }, select: { code: true, name: true } });
  if (customer === null) throw new HttpError(400, `Unknown customer "${filter.customerId}"`);
  return { rows, customer };
}

/** The Invoice register PDF's rows and customer, `listInvoices`' read with the customer added: the
 *  line under the title names the customer the rows were read for, so the two are read together, in
 *  one read-only RepeatableRead transaction, the prefix read outside it. */
export async function listInvoiceRegisterForPdf(filter: InvoiceFilter): Promise<InvoiceRegisterForPdf> {
  const prefix = await getSetting("invoice_number_prefix");
  return prisma.$transaction(
    (tx) => readInvoiceRegisterForPdf(tx, filter, prefix),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

/** Every invoice/credit ever raised against this order, discarded drafts included — the order
 *  hub's own Invoices section, the `shipmentsForOrder` precedent (shippers.ts): full history, not
 *  just the live state. */
export async function invoicesForOrder(orderId: string): Promise<InvoiceListRow[]> {
  const prefix = await getSetting("invoice_number_prefix");
  const rows = await prisma.invoice.findMany({
    where: { orderId }, select: LIST_SELECT,
    orderBy: [{ invoiceDate: "desc" }, { createdAt: "desc" }],
  });
  return rows.map((r) => toListRow(r, prefix));
}

// -------------------------------------------------------------------------------------------
// Create — the bracket is `saveNewShipper` with the shipment parts removed: read deps outside,
// then claim -> refuse -> read state -> build the engine input -> price -> write.
// -------------------------------------------------------------------------------------------

const CREATE = z.object({
  orderId: z.string().min(1),
  clientRequestId: z.string().min(1).max(200).optional(),
  invoiceDate: z.string().optional(),
}).strict();

type CreateInvoiceInput = z.infer<typeof CREATE>;

/** The plant-wide reads that do not depend on which order is being invoiced — read on the top-level
 *  client OUTSIDE the transaction (the `createOrder` settings-read precedent: a second-connection
 *  read inside a Serializable transaction is the shape a deadlock/pool starvation gets introduced
 *  through). The per-customer surcharge overrides are read INSIDE, off the customer row. */
type InvoiceDeps = { config: BillingConfigRow; surcharges: SurchargeRow[]; today: Date };

async function loadInvoiceDeps(): Promise<InvoiceDeps> {
  const [config, surcharges] = await Promise.all([getBillingConfig(), listSurcharges()]);
  return { config, surcharges, today: todayDateOnly() };
}

/** Seam #1's account, resolved id + name, for the paths that do not build a whole pricing input —
 *  today `replaceInvoiceLines` (#62). Read on the top-level client OUTSIDE the transaction, the
 *  `loadInvoiceDeps` discipline. `buildPricingInput` resolves the same pair from the batch of
 *  config accounts it already reads, and the two must agree: an engine-generated charge and a
 *  hand-typed one post to the SAME account or the export splits one charge class in two. */
async function otherChargeGlRef(): Promise<GlRef> {
  const { otherChargeGlAccountId: id } = await getBillingConfig();
  if (id === null) return { glAccountId: null, glAccountName: "" };
  const row = await prisma.glAccount.findFirst({ where: { id }, select: { name: true } });
  return { glAccountId: id, glAccountName: row?.name ?? "" };
}

/** The SHIP-TO block for the invoice snapshot (§10): the row's name, else the customer's own; blank
 *  components are dropped so no empty line prints. The BILL-TO block is `billToLines`
 *  (`party-address.ts`, R14 of #671): the row's name stacked above the customer's. */
function renderAddress(addr: AddressRow | null, fallbackName: string): string {
  const name = addr && addr.name !== "" ? addr.name : fallbackName;
  const cityLine = addr ? [addr.city, [addr.state, addr.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ") : "";
  return [name, addr?.street ?? "", cityLine].filter((s) => s !== "").join("\n");
}

type LeadPart = {
  partNumber: string; name: string; description: string; eachWeight: Prisma.Decimal;
  processName: string;
  billForCert: boolean | null; certCharge: Prisma.Decimal | null; material: { name: string } | null;
};
type OrderLineRow = { id: string; position: number; partId: string; quoteLineId: string | null; part: LeadPart };

/** The `select` both `createInvoiceInTx` and `recalculateInvoice` read order lines with — one
 *  shape, so the two assembly paths can never see different line facts. `quoteLineId` is the
 *  Phase 6 tier-1 switch (§5.3): its presence swaps the line's price-row source below. */
const ORDER_LINE_SELECT = {
  id: true, position: true, partId: true, quoteLineId: true,
  part: {
    select: {
      partNumber: true, name: true, description: true, eachWeight: true, processName: true,
      billForCert: true, certCharge: true, material: { select: { name: true } },
    },
  },
} satisfies Prisma.OrderLineSelect;

/** What the tier-1 refusals read of a linked quote line: its part, and whether it and its quote are
 *  live. */
const QUOTE_LINK_SELECT = {
  id: true, partId: true, deletedAt: true,
  quote: { select: { quoteNumber: true, deletedAt: true } },
} satisfies Prisma.QuoteLineSelect;
type QuoteLinkRow = Prisma.QuoteLineGetPayload<{ select: typeof QUOTE_LINK_SELECT }>;

/**
 * The two INVARIANT asserts a stored quote link has to satisfy — that its target is live, and that
 * it quotes the SAME part the order line does. Neither is an expected failure (plain Error → the
 * handler's 500): §5.14 refuses deleting or re-pointing a quote line any order line references, and
 * every stored link was judged at save time (quote-links.ts), so a dead or wrong-part target here is
 * corrupt state. Falling back to part rows instead would be the silent re-price §7.5 exists to
 * prevent. `quoteLine` is what the read found for the link: `undefined` when it found none.
 *
 * Pure since #622: `priceRowsByLine` reads every linked line's quote line in one statement and asks
 * this of each in position order, so the first corrupt line refuses, as when each was read alone.
 */
function checkQuoteLink(
  ol: { id: string; partId: string; quoteLineId: string }, quoteLine: QuoteLinkRow | undefined,
): QuoteLinkRow {
  if (!quoteLine || quoteLine.deletedAt !== null || quoteLine.quote.deletedAt !== null) {
    throw new Error(
      `Order line ${ol.id} links quote line ${ol.quoteLineId}, which is deleted or missing — ` +
      "§5.14 makes this unreachable; refusing to price the line");
  }
  if (quoteLine.partId !== ol.partId) {
    throw new Error(
      `Order line ${ol.id} links quote line ${ol.quoteLineId}, which quotes a different part ` +
      `(${quoteLine.partId ?? "free-text"} vs ${ol.partId}) — refusing to price the line`);
  }
  return quoteLine;
}

type PricingLine = { id: string; partId: string; quoteLineId: string | null };

/**
 * The `PriceRowInput[]` of each PRICED order line, by order line id, in a fixed number of reads
 * whatever the line count (#622: one read per line before, a part shared by two lines read twice).
 * The row source is the Phase 6 tier fork (§5.3):
 *
 * - Tier 1, a line carrying a quote link: the linked quote line's LIVE `QuotePrice` rows with their
 *   LIVE breaks, WHOLESALE (rulings 4 + 8). The part's rows are not fetched, not merged, not fallen
 *   back to: linked lines never enter the part read, and a linked line with zero live rows gets
 *   `[]`, which the engine prices as tier 3's needs-price — the link declared the agreement, and an
 *   empty agreement is a flag, not permission to bill something else.
 * - Tier 2, every other line: its part's live rows (`listPartPricesByPart`), one read for every part.
 *
 * EVERY linked line in `lines` is checked (`checkQuoteLink`), a line that is not priced included
 * (#96: a zero-net line is never priced, but a corrupt link on it is corrupt state either way,
 * whichever position it holds); only the lines in `priced` get rows. The quote-row read is keyed
 * through the LIVE quote lines just checked, and the breaks through the live rows that include them
 * (`PRICE_ROW_INCLUDE`: live breaks can exist under a soft-deleted row).
 *
 * Every read runs on the invoice transaction's OWN client (the #60 lesson): a concurrent price or
 * quote edit lands inside this Serializable transaction's read set, so SSI sees it. Each line gets
 * arrays and objects of its own, two lines of one part included.
 */
async function priceRowsByLine(
  tx: Db, lines: readonly PricingLine[], priced: ReadonlySet<string>,
): Promise<Map<string, PriceRowInput[]>> {
  const linked = lines.filter((l): l is PricingLine & { quoteLineId: string } => l.quoteLineId !== null);
  const quoteLines = linked.length === 0 ? [] : await tx.quoteLine.findMany({
    where: { id: { in: [...new Set(linked.map((l) => l.quoteLineId))] } }, select: QUOTE_LINK_SELECT,
  });
  const quoteLineById = new Map(quoteLines.map((q) => [q.id, q]));
  const liveQuoteLine = new Map<string, QuoteLinkRow>();
  for (const ol of linked) liveQuoteLine.set(ol.id, checkQuoteLink(ol, quoteLineById.get(ol.quoteLineId)));

  const pricedLinked = linked.filter((l) => priced.has(l.id));
  const quoteRows = pricedLinked.length === 0 ? [] : await tx.quotePrice.findMany({
    where: { quoteLineId: { in: [...new Set(pricedLinked.map((l) => liveQuoteLine.get(l.id)!.id))] }, deletedAt: null },
    include: PRICE_ROW_INCLUDE,
    orderBy: [...PRICE_ROW_ORDER],
  });
  const pricedUnlinked = lines.filter((l) => l.quoteLineId === null && priced.has(l.id));
  const partRows = await listPartPricesByPart(pricedUnlinked.map((l) => l.partId), tx);

  const out = new Map<string, PriceRowInput[]>();
  for (const ol of lines) {
    if (!priced.has(ol.id)) continue;
    const quoteLine = liveQuoteLine.get(ol.id);
    out.set(ol.id, quoteLine
      ? quoteRows.filter((r) => r.quoteLineId === quoteLine.id).map((r) => ({
          processStepCodeId: r.processStepCodeId,
          stepCode: r.processStepCode.code, stepName: r.processStepCode.name,
          glAccountId: r.processStepCode.glAccountId,
          glAccountName: r.processStepCode.glAccount?.name ?? "",
          position: r.position,
          setupCharge: num(r.setupCharge), unitPrice: num(r.unitPrice), minimumCharge: num(r.minimumCharge),
          pricePer: r.pricePer,
          breaks: r.breaks.map((b) => ({ threshold: b.threshold.toNumber(), price: b.price.toNumber() })),
          priceSource: "QUOTE" as const,
          sourceQuoteNumber: quoteLine.quote.quoteNumber,
        }))
      : (partRows.get(ol.partId) ?? []).map((p) => ({
          processStepCodeId: p.processStepCodeId, stepCode: p.stepCode, stepName: p.stepName, position: p.position,
          setupCharge: p.setupCharge, unitPrice: p.unitPrice, minimumCharge: p.minimumCharge,
          pricePer: p.pricePer, breaks: p.breaks.map((b) => ({ threshold: b.threshold, price: b.price })),
          glAccountId: p.glAccountId, glAccountName: p.glAccountName,
        })));
  }
  return out;
}

/**
 * EVERY shipment-side input an invoice's lines are calculated from, in one place (owner ruling
 * 2026-10-06): the live shipped quantity and weight per order line (`shippedTotals`, the §5.1
 * derivation), and the freight billed on each LIVE shipment carrying this order (freight rides the
 * Shipper; a shipment that does not bill freight, or carries no amount, contributes nothing).
 *
 * `buildPricingInput` prices from this function's result and `shipmentFingerprint` hashes it, so
 * what finalize compares is by construction what was priced: there is no second query to drift.
 * On the caller's `tx`, under its order claim.
 */
async function readShipmentInputs(
  tx: Db, orderId: string, orderLineIds: string[],
): Promise<ShipmentFingerprintInput & { shipped: Map<string, { qty: number; weight: number }> }> {
  const shipped = await shippedTotals(tx, orderLineIds);
  const shipperOrders = await tx.shipperOrder.findMany({
    where: { orderId },
    select: { shipper: { select: { id: true, deletedAt: true, billFreight: true, freightAmount: true } } },
  });
  const freight: { shipperId: string; amount: number }[] = [];
  const seenShippers = new Set<string>();
  for (const so of shipperOrders) {
    const s = so.shipper;
    if (s.deletedAt !== null || !s.billFreight || s.freightAmount === null) continue;
    if (seenShippers.has(s.id)) continue;
    seenShippers.add(s.id);
    freight.push({ shipperId: s.id, amount: s.freightAmount.toNumber() });
  }
  return {
    shipped, freight,
    lines: orderLineIds.map((id) => ({ orderLineId: id, ...(shipped.get(id) ?? { qty: 0, weight: 0 }) })),
  };
}

/** The digest stored on `Invoice.shipmentFingerprint`. The canonical text is the client-safe leaf's;
 *  only the hashing lives here, because a `src/lib` leaf may not import `node:crypto`. */
function shipmentFingerprint(inputs: ShipmentFingerprintInput): string {
  return createHash("sha256").update(shipmentFingerprintSource(inputs)).digest("hex");
}

/** The current fingerprint for an order, for finalize: the same read `buildPricingInput` prices
 *  from, over the order's current lines. */
async function currentShipmentFingerprint(tx: Db, orderId: string): Promise<string> {
  const orderLines = await tx.orderLine.findMany({ where: { orderId }, select: { id: true } });
  return shipmentFingerprint(await readShipmentInputs(tx, orderId, orderLines.map((l) => l.id)));
}

/** Assembles the pure engine's whole input from the claimed order's live state. Seam #3 is the
 *  `qty === 0 && weight === 0` filter: a line that shipped nothing (a fully-returned or never-really
 *  -shipped line marked complete) must never reach the engine, which would bill it the full minimum
 *  plus setup for no work. */
async function buildPricingInput(
  tx: Db, config: BillingConfigRow, surcharges: SurchargeRow[],
  order: { id: string; certRequired: boolean },
  customer: { taxable: boolean; salesTaxRate: Prisma.Decimal | null; certChargeSuppressed: boolean; surchargeOptOut: boolean; surchargeRules: { surchargeId: string; optOut: boolean; rate: Prisma.Decimal | null; amount: Prisma.Decimal | null }[] },
  orderLines: OrderLineRow[],
): Promise<{
  input: PricingInput; otherChargeGlName: string; shipmentFingerprint: string;
  /** The price rows read for each PRICED order line, by order line id: what `lines[].prices` was
   *  built from, kept so create's header can take the lead line's rows from this read instead of
   *  reading them again on `tx` (#622). A zero-net line has no entry: it was never priced. */
  pricesByLine: Map<string, PriceRowInput[]>;
}> {
  const shipmentInputs = await readShipmentInputs(tx, order.id, orderLines.map((l) => l.id));
  const shipped = shipmentInputs.shipped;

  // GL account names for the config-driven line kinds (freight, other-charge, sales tax). The cert
  // charge posts to its STEP CODE's GL account, resolved separately below.
  const glIds = [config.freightGlAccountId, config.otherChargeGlAccountId, config.salesTaxGlAccountId]
    .filter((id): id is string => id !== null);
  const glRows = glIds.length === 0 ? [] : await tx.glAccount.findMany({
    where: { id: { in: glIds } }, select: { id: true, name: true },
  });
  const glNameById = new Map(glRows.map((r) => [r.id, r.name]));
  const glRef = (id: string | null): GlRef => ({ glAccountId: id, glAccountName: id === null ? "" : (glNameById.get(id) ?? "") });
  // Seam #1's name half: `otherChargeGlAccountId` is already in `glIds` above, so its name is
  // already resolved here — the caller (createInvoiceInTx) reuses it rather than re-querying.
  const otherChargeGlName = config.otherChargeGlAccountId === null
    ? "" : (glNameById.get(config.otherChargeGlAccountId) ?? "");

  // Operation lines — one per order line with a NON-ZERO net shipped total (seam #3). Their price
  // rows come from `priceRowsByLine`, the Phase 6 tier fork read for every line at once (#622). It
  // checks the quote link of EVERY linked line, a zero-net one included (#96): the lead-line header
  // read in `createInvoiceInTx` used to resolve `orderLines[0]`'s link unconditionally, so a corrupt
  // link threw on a zero-net LEAD and was silently skipped on a zero-net rider. Throwing is the safe
  // direction on corrupt state, so every zero-net line is validated, lead and rider alike, whatever
  // the header goes on to read. Constructionally unreachable while the §5.14 guards hold — which is
  // exactly why it must not depend on which position the line happens to occupy.
  const isPriced = (ol: OrderLineRow) => {
    const totals = shipped.get(ol.id) ?? { qty: 0, weight: 0 };
    return !(totals.qty === 0 && totals.weight === 0);
  };
  const pricesByLine = await priceRowsByLine(tx, orderLines, new Set(orderLines.filter(isPriced).map((ol) => ol.id)));
  const lines: OrderLineInput[] = [];
  for (const ol of orderLines) {
    const prices = pricesByLine.get(ol.id);
    if (prices === undefined) continue; // zero-net: never priced (seam #3)
    const totals = shipped.get(ol.id)!;
    lines.push({
      orderLineId: ol.id, position: ol.position,
      partNumber: ol.part.partNumber, partName: ol.part.name, partDescription: ol.part.description,
      eachWeight: ol.part.eachWeight.toNumber(),
      shippedQty: totals.qty, shippedWeight: totals.weight,
      prices,
    });
  }

  // Extra charges — every live OrderCharge (this table has no deletedAt; §7.5.3 allows a null
  // amount, which the engine flags `needsPrice`).
  const orderCharges = await tx.orderCharge.findMany({
    where: { orderId: order.id }, orderBy: { position: "asc" },
    select: { id: true, position: true, description: true, amount: true },
  });
  const charges: ChargeInput[] = orderCharges.map((c) => ({
    orderChargeId: c.id, position: c.position, description: c.description, amount: num(c.amount),
  }));

  // Freight — the sum of freight billed across this order's LIVE shipments (spec §5, freight rides
  // the Shipper). Accumulated in integer cents (Decimal(12,2)) so summing several shipments is
  // exact. A shipment that does not bill freight, or carries no amount, contributes nothing.
  //   The rows come from `readShipmentInputs`, the read the fingerprint is built from.
  const freightCents = shipmentInputs.freight.reduce((sum, f) => sum + Math.round(f.amount * 100), 0);
  const freight = shipmentInputs.freight.length > 0
    ? { ...glRef(config.freightGlAccountId), amount: freightCents / 100 } : null;

  // Certification charge (§6) — billed only when the order requires a cert, the lead part's
  // bill-for-cert resolves true (part overrides the plant default), the customer is not blanket-
  // suppressed, and an amount actually resolves. It posts to the config cert step code's GL account.
  const lead = orderLines[0]?.part ?? null; // orderLines is position-asc, so [0] is the lead line
  const billForCert = lead?.billForCert ?? config.billForCertDefault;
  const certAmount = lead?.certCharge?.toNumber() ?? config.certChargeDefault;
  let cert: (GlRef & { amount: number; description: string }) | null = null;
  if (order.certRequired && billForCert && !customer.certChargeSuppressed && certAmount !== null) {
    let certStep: { name: string; glAccountId: string | null; glAccountName: string } | null = null;
    if (config.certChargeStepCodeId) {
      const sc = await tx.processStepCode.findFirst({
        where: { id: config.certChargeStepCodeId },
        select: { name: true, glAccountId: true, glAccount: { select: { name: true } } },
      });
      if (sc) certStep = { name: sc.name, glAccountId: sc.glAccountId, glAccountName: sc.glAccount?.name ?? "" };
    }
    cert = {
      glAccountId: certStep?.glAccountId ?? null, glAccountName: certStep?.glAccountName ?? "",
      amount: certAmount, description: certStep?.name ?? "Certification",
    };
  }

  // Sales tax (§4.4/§5) — the customer's own rate wins over the plant rate; the flag decides IF,
  // the rate decides AT WHAT. Freight is excluded from the tax base inside the engine (ruling 8).
  const taxRate = customer.taxable ? (customer.salesTaxRate?.toNumber() ?? config.salesTaxRate) : null;
  const tax = taxRate !== null ? { ...glRef(config.salesTaxGlAccountId), rate: taxRate } : null;

  return {
    input: { lines, surcharges: buildSurcharges(surcharges, customer), charges, freight, cert, tax },
    otherChargeGlName,
    shipmentFingerprint: shipmentFingerprint(shipmentInputs),
    pricesByLine,
  };
}

// -------------------------------------------------------------------------------------------
// Shared line-writing helpers. Create and recalculate MUST turn `priceOrder`'s output into
// InvoiceLine rows the same way — same seam #1 assignment, same FK guards, same parent wiring —
// or the two paths drift and a recalculated invoice stops matching a freshly created one (the
// task's single most important correctness property). So the mapping lives here, once, and both
// callers use it. `replaceInvoiceLines` shares the FK guard, the totals math and the engine's tax
// and surcharge rules (`taxOnLines`, `surchargeOnLines`; #64, #586), which it figures over the lines
// it saves; its lines come from the caller, not the engine, so it wires parents from payload keys
// instead.
// -------------------------------------------------------------------------------------------

/** The columns of one InvoiceLine, minus `invoiceId`/`parentLineId` (both wired after insert). */
type InvoiceLineWrite = {
  position: number; kind: InvoiceLineKindValue;
  orderLineId: string | null; processStepCodeId: string | null;
  surchargeId: string | null; orderChargeId: string | null; glAccountId: string | null;
  partNumber: string; partName: string; partDescription: string;
  description: string; glAccountName: string;
  qty: number | null; weight: number | null; eachWeight: number | null;
  pricePer: PricePerValue | null;
  unitPrice: number | null; setupCharge: number | null; minimumCharge: number | null;
  breakThreshold: number | null; minimumApplied: boolean;
  rate: number | null; priceSource: PriceSourceValue | null; sourceQuoteNumber: number | null;
  needsPrice: boolean; wordsChosen: boolean;
  amount: number;
};

/** `priceOrder`'s computed lines → InvoiceLine write rows at positions 1..n. Seam #1 lands here
 *  (CLAUDE.md / this file's header): a CHARGE line arrives from the pure engine with a null GL
 *  account, so the config's `otherChargeGlAccountId` (and its resolved name) is assigned to CHARGE
 *  lines HERE, exactly as create always did — factored out so recalculate cannot post them to a
 *  different account than create would. */
function mapComputedLines(computedLines: readonly ComputedLine[], otherChargeGl: GlRef): InvoiceLineWrite[] {
  return computedLines.map((l, i) => ({
    position: i + 1, kind: l.kind,
    orderLineId: l.orderLineId, processStepCodeId: l.processStepCodeId,
    surchargeId: l.surchargeId, orderChargeId: l.orderChargeId,
    glAccountId: l.kind === "CHARGE" ? otherChargeGl.glAccountId : l.glAccountId,
    partNumber: l.partNumber, partName: l.partName, partDescription: l.partDescription,
    description: l.description,
    glAccountName: l.kind === "CHARGE" ? otherChargeGl.glAccountName : l.glAccountName,
    qty: l.qty, weight: l.weight, eachWeight: l.eachWeight,
    pricePer: l.pricePer, unitPrice: l.unitPrice, setupCharge: l.setupCharge, minimumCharge: l.minimumCharge,
    breakThreshold: l.breakThreshold, minimumApplied: l.minimumApplied,
    rate: l.rate, priceSource: l.priceSource, sourceQuoteNumber: l.sourceQuoteNumber,
    // The engine writes its own words, so no line it writes has words chosen (#587).
    needsPrice: l.needsPrice, wordsChosen: false, amount: l.amount,
  }));
}

/**
 * The identity a MANUAL line overrides, or null when it carries none.
 *
 * Owner ruling 2026-08-17 (#61): **the manual override wins, silently.** A manual line whose
 * order-side identity matches a regenerated derived line is an OVERRIDE and takes that line's SLOT;
 * one matching nothing is a genuine ADDITION and rides at the end (§5.5). Before this, recalculate
 * regenerated the derived twin AND preserved the override beside it — an outright double bill, and
 * the same shape for every kind, not only the operations the issue was filed about.
 *
 * An OPERATION keys on order line AND step code, so two priced operations on one order line stay
 * distinct — but that identity alone is NOT sufficient, because the derived line can come back under
 * a different step code (the tier-3 "needs price" line carries none at all, `pricing.ts`). The
 * caller therefore falls back to an order-line match, narrower for a picked step (`isPickedStep`);
 * see `recalculateInvoice`. FREIGHT / CERT / TAX are singletons — the engine emits at most one of
 * each — so the kind is the whole identity.
 *
 * The undo path the ruling took INSTEAD of a revert control: remove the row, save, recalculate, and
 * the computed line returns (pinned in `tests/invoices.test.ts`). That is the TYPED row only: a
 * computed row removed is remembered under this same identity and stays out (#594,
 * `marksAfterSave`), until Restore.
 */
function overrideKey(l: {
  kind: InvoiceLineKindValue; orderLineId: string | null; processStepCodeId: string | null;
  surchargeId: string | null; orderChargeId: string | null;
}): string | null {
  switch (l.kind) {
    case "PART": return l.orderLineId === null ? null : `PART:${l.orderLineId}`;
    case "OPERATION":
      return l.orderLineId === null
        ? null : `OPERATION:${l.orderLineId}:${l.processStepCodeId ?? ""}`;
    case "SURCHARGE": return l.surchargeId === null ? null : `SURCHARGE:${l.surchargeId}`;
    case "CHARGE": return l.orderChargeId === null ? null : `CHARGE:${l.orderChargeId}`;
    case "FREIGHT": case "CERT": case "TAX": return l.kind;
  }
}

/** #587 (Amendments 17 and 19): an OPERATION line with a step code and no price row of its own, so a
 *  step picked on a Needs price line. "No price row" is `pricePer` null: the engine writes a priced
 *  operation's `pricePer` from its price row, whose column is never null, and leaves the tier-3 Needs
 *  price line's null. `recalculateInvoice` asks it of MANUAL lines, a picked line with a price typed;
 *  `replaceInvoiceLines` asks it of every line an invoice's Save sends, typed or not. */
function isPickedStep(l: {
  kind: InvoiceLineKindValue; processStepCodeId: string | null; pricePer: PricePerValue | null;
}): boolean {
  return l.kind === "OPERATION" && l.processStepCodeId !== null && l.pricePer === null;
}

/** #587 (Amendment 17): the GL account each picked step's code carries (`isPickedStep`), keyed by
 *  step code id, in one read on the caller's transaction (#60). Operators have no GL picker (ruling
 *  2026-08-17), so a picked line's account is its step's own: Save lines and Recalculate both read it
 *  here, every time, so a re-pick or an Admin change to the code's account lands without trusting
 *  whatever account the line carried. A code with no account maps to none, as the engine's own lines
 *  do, which leaves a line that bills on the export's readiness list. The read does not filter
 *  `deletedAt`: `assertLineRefs`, which both callers run before they write, refuses a soft-deleted
 *  code. */
async function pickedStepGl(
  tx: Db,
  lines: readonly { kind: InvoiceLineKindValue; processStepCodeId: string | null; pricePer: PricePerValue | null }[],
): Promise<Map<string, GlRef>> {
  const ids = [...new Set(lines.filter(isPickedStep).map((l) => l.processStepCodeId!))];
  if (ids.length === 0) return new Map();
  const codes = await tx.processStepCode.findMany({
    where: { id: { in: ids } },
    select: { id: true, glAccountId: true, glAccount: { select: { name: true } } },
  });
  return new Map(codes.map((c) => [c.id, { glAccountId: c.glAccountId, glAccountName: c.glAccount?.name ?? "" }]));
}

/** #587 (ruling 587-13): a typed price on an OPERATION line with no step code, the #61 override that
 *  stands in for every priced operation on its order line. `invoiceWarnings` warns of it on a draft,
 *  and `finalizeInvoiceInTx` refuses it on an INVOICE when it bills (Amendment 21): one test, so the
 *  two never disagree about which line it is. */
function typedPriceStandingIn(l: {
  kind: InvoiceLineKindValue; priceSource: PriceSourceValue | null; processStepCodeId: string | null;
}): boolean {
  return l.kind === "OPERATION" && l.priceSource === "MANUAL" && l.processStepCodeId === null;
}

/** Seam #1's MANUAL half (#62). The grid renders a charge line's GL account read-only and sends it
 *  blank — and there is deliberately no operator picker (ruling 2026-08-17: the pick-list route
 *  excludes `glAccount`, §5.15) — so the SERVER assigns the same plant default `mapComputedLines`
 *  gives an engine-generated charge. Applied on the whole-array save AND on the recalculate that
 *  preserves the row, so a draft written before the default existed does not stay account-less and
 *  drop out of the GL export. A line that already names an account is never re-pointed. */
function withChargeGl<T extends { kind: InvoiceLineKindValue; glAccountId: string | null; glAccountName: string }>(
  line: T, otherChargeGl: GlRef,
): T {
  if (line.kind !== "CHARGE" || line.glAccountId !== null) return line;
  return { ...line, glAccountId: otherChargeGl.glAccountId, glAccountName: otherChargeGl.glAccountName };
}

/** `assertRefExists` on every registered FK the lines carry (CLAUDE.md's FK-writer pattern; the
 *  Serializable isolation is what this pairs WITH, never a substitute for it). `extraStepCodeIds`
 *  covers the cert charge's step code, which never lands on any line's `processStepCodeId` column
 *  (only its GL account rides along) and so is invisible to the scan otherwise. */
async function assertLineRefs(
  tx: Db,
  lines: { glAccountId?: string | null; processStepCodeId?: string | null; surchargeId?: string | null }[],
  extraStepCodeIds: string[] = [],
): Promise<void> {
  const set = (ids: (string | null | undefined)[]) =>
    new Set(ids.filter((id): id is string => typeof id === "string"));
  const glAccountIds = set(lines.map((l) => l.glAccountId));
  const processStepCodeIds = set(lines.map((l) => l.processStepCodeId));
  for (const id of extraStepCodeIds) processStepCodeIds.add(id);
  const surchargeIds = set(lines.map((l) => l.surchargeId));
  for (const id of glAccountIds) await assertRefExists("glAccount", id, tx);
  for (const id of processStepCodeIds) await assertRefExists("processStepCode", id, tx);
  for (const id of surchargeIds) await assertRefExists("surcharge", id, tx);
}

/**
 * The ids a set of lines is written with, and each line's parent (#624): the OPERATION -> PART
 * self-relation, set in the same INSERT as the rows. Each line's id is minted here, so a parent's id
 * is known before its row is written, and `InvoiceLine_parentLineId_fkey` (not deferrable) is
 * checked at the end of the statement, so a parent and its children may go in one `createMany`, a
 * line under itself included. A line's `key` names it to the others (a later line with the same key
 * wins), and a `parentKey` naming no line in the set leaves the child flat rather than dangling.
 * One resolver for the engine's keys, the page's keys and a credit's source-row ids.
 */
function lineIdentities(
  lines: readonly { key?: string | null; parentKey?: string | null }[],
): { id: string; parentLineId: string | null }[] {
  const ids = lines.map(() => randomUUID());
  const idByKey = new Map<string, string>();
  lines.forEach((l, i) => { if (l.key) idByKey.set(l.key, ids[i]); });
  return lines.map((l, i) => ({ id: ids[i], parentLineId: (l.parentKey ? idByKey.get(l.parentKey) : undefined) ?? null }));
}

/** The six buckets + grand total, as sums of already-rounded line amounts in integer cents (the
 *  pricing engine's own rule: totals are never rebuilt out of dollars that were already rounded).
 *  Used by every path that recomputes totals from a final line set — `replaceInvoiceLines` and
 *  `recalculateInvoice`. PART lines carry `amount = 0` and fall into no bucket. */
function totalsFromLines(lines: { kind: InvoiceLineKindValue; amount: number }[]) {
  const centsFor = (kind: InvoiceLineKindValue) =>
    lines.reduce((sum, l) => (l.kind === kind ? sum + Math.round(l.amount * 100) : sum), 0);
  const buckets = {
    subtotal: centsFor("OPERATION"), surchargeTotal: centsFor("SURCHARGE"),
    chargeTotal: centsFor("CHARGE"), certTotal: centsFor("CERT"),
    freightTotal: centsFor("FREIGHT"), taxTotal: centsFor("TAX"),
  };
  const total = Object.values(buckets).reduce((sum, b) => sum + b, 0);
  return {
    subtotal: buckets.subtotal / 100, surchargeTotal: buckets.surchargeTotal / 100,
    chargeTotal: buckets.chargeTotal / 100, certTotal: buckets.certTotal / 100,
    freightTotal: buckets.freightTotal / 100, taxTotal: buckets.taxTotal / 100,
    total: total / 100,
  };
}

async function createInvoiceInTx(
  tx: Db, data: CreateInvoiceInput, deps: InvoiceDeps,
): Promise<{ detail: InvoiceDetail; deduped: boolean }> {
  // Claim the Order row for the rest of this transaction — the ONE cross-transaction guard behind
  // "one live invoice per order" (order-locks.ts): the refusal below and the write it guards must
  // see the same state, and Serializable/SSI is NOT a substitute for the row lock (the certs.ts
  // discriminating-race lesson — see the concurrency test).
  const order = await claimOrder(tx, data.orderId);
  if (!order) throw new HttpError(404, "Order not found");
  if (order.deletedAt !== null) throw new HttpError(400, `Order #${order.orderNumber} has been voided`);
  if (order.status !== "SHIPPED") throw new HttpError(400, "Only a fully shipped order can be invoiced");

  // `findFirst`, NEVER `findUnique`: `@@unique([orderId])` is filtered on
  // `deletedAt IS NULL AND kind = 'INVOICE'`, so the generated client types a plain unique it
  // cannot honour (the partial-unique rule). The same index guarantees at most one live row.
  //
  // Idempotency for THIS shape is caught here, under the claim, for a replay that starts after the
  // first create committed: it carries the same orderId, so this live-invoice guard finds that
  // invoice. A replay that overlaps the commit is not: Serializable fixes its snapshot as the
  // claim's statement starts, before it waits on the lock, so it misses the invoice, inserts, and
  // collides on the clientRequestId key, checked before the order's partial index only because it
  // was created first (20260806221500); the caller's backstop answers it (#568). A live invoice
  // whose nonce matches the request IS that request's own prior result, answered as deduped;
  // a live invoice with any other (or null) nonce is a genuine "already invoiced" refusal.
  const existing = await tx.invoice.findFirst({
    where: { orderId: data.orderId, kind: "INVOICE", deletedAt: null },
    select: { id: true, clientRequestId: true },
  });
  if (existing) {
    if (data.clientRequestId && existing.clientRequestId === data.clientRequestId) {
      return { detail: await readInvoiceDetail(tx, existing.id), deduped: true };
    }
    throw new HttpError(400,
      `Order #${order.orderNumber} already has an invoice — discard its draft or credit the finalized one`);
  }

  const customer = await tx.customer.findFirst({
    where: { id: order.customerId },
    select: {
      code: true, name: true, taxable: true, salesTaxRate: true, certChargeSuppressed: true,
      ...CUSTOMER_SURCHARGE_SELECT,
      terms: { select: { name: true } },
    },
  });
  if (!customer) throw new HttpError(404, "Customer not found");

  const addresses = await listAddresses(order.customerId, undefined, tx);
  // Frozen at create (§10): an invoice raised before R14 keeps the block it printed.
  const billTo = billToLines(customer.name, pickDefaultAddress(addresses, "BILL_TO")).join("\n");
  const shipTo = renderAddress(pickDefaultAddress(addresses, "SHIP_TO"), customer.name);

  const orderLines: OrderLineRow[] = await tx.orderLine.findMany({
    where: { orderId: data.orderId },
    orderBy: { position: "asc" },
    select: ORDER_LINE_SELECT,
  });

  const { input, otherChargeGlName, shipmentFingerprint: fingerprint, pricesByLine } =
    await buildPricingInput(tx, deps.config, deps.surcharges, order, customer, orderLines);
  const computed = priceOrder(input); // the pure engine — all the arithmetic

  // Ruling 4's invoice half (spec §5.7): the header's Process: snapshot is the lead part's
  // `processName` (presentation vocabulary) when it is non-blank, else today's priced-operation
  // comma-join. CREATE-TIME only — this is the ONLY behavioral change to invoice data, and prints
  // keep reading `Invoice.processNames` UNCONDITIONALLY (frozen paper), so a later processName edit
  // never rewrites raised paper. Pre-existing invoices are untouched (their snapshot already holds
  // the join); a credit copies its source invoice's snapshot as today.
  const lead = orderLines[0] ?? null;
  const leadProcessName = lead?.part.processName ?? "";
  // The lead line's priced operations, for the comma-join alone (#622): a priced lead's rows are
  // the pricing read's own, on `tx` (`pricesByLine`), read once; only a ZERO-NET lead, which the
  // pricing loop skipped, is read here, and neither is read under a non-blank processName. The
  // Phase 6 tier fork applies to that read too (§5.3's wholesale rule reaches every read that
  // assembles this order's price rows): a linked lead line names the QUOTE's operations — the
  // steps this invoice actually bills — and its part's rows are not fetched (#60: on `tx`).
  const leadPrices: { stepName: string }[] = lead === null || leadProcessName.trim() !== ""
    ? []
    : pricesByLine.get(lead.id) ?? (await priceRowsByLine(tx, [lead], new Set([lead.id]))).get(lead.id)!;
  const processNames = leadProcessName.trim() !== ""
    ? leadProcessName
    : leadPrices.map((p) => p.stepName).join(", ");
  const materialName = orderLines[0]?.part.material?.name ?? "";

  const invoiceDate = data.invoiceDate ? parseDate(data.invoiceDate, "Invoice date") : deps.today;
  const taxRate = input.tax?.rate ?? null;
  const otherChargeGl: GlRef = {
    glAccountId: deps.config.otherChargeGlAccountId, glAccountName: otherChargeGlName,
  };

  // Engine output -> line rows, with seam #1 assigned inside `mapComputedLines`. Then Fix 1
  // (spec §5.1): this transaction is Serializable specifically to pair with `assertLineRefs`'
  // `assertRefExists` on every registered FK it assigns (CLAUDE.md's FK-writer pattern,
  // `createShipper`'s `carrierId` precedent). Checked fresh on `tx`, after the claim:
  // `deps.config`/`deps.surcharges` were read on the TOP-LEVEL client before this transaction even
  // opened (`loadInvoiceDeps`), so a GL account, step code or surcharge could have been soft-deleted
  // in the gap — a distant delete-blocker (e.g. `BILLING_CONFIG_BLOCKER`) is not a substitute for
  // this local, permanent check. Both the mapping and the guard are shared verbatim with
  // `recalculateInvoice`, so the two write paths cannot drift.
  const lineData = mapComputedLines(computed.lines, otherChargeGl);
  const certStepIds = input.cert && deps.config.certChargeStepCodeId ? [deps.config.certChargeStepCodeId] : [];
  await assertLineRefs(tx, lineData, certStepIds);

  // The `after` snapshot, composed by hand like shippers.ts's `auditPayload` — every FK travels
  // with the live name it points at, and the lines' amounts are included so line changes show in
  // history from the create entry on. Row ids are absent because they do not exist yet.
  const auditData = {
    kind: "INVOICE", status: "DRAFT",
    orderId: data.orderId, orderNumber: order.orderNumber,
    customerId: order.customerId, customerCode: customer.code, customerName: customer.name,
    invoiceDate: formatDateOnly(invoiceDate),
    poNumber: order.poNumber, termsName: customer.terms?.name ?? "",
    materialName, processNames, taxRate,
    subtotal: computed.subtotal, surchargeTotal: computed.surchargeTotal, chargeTotal: computed.chargeTotal,
    certTotal: computed.certTotal, freightTotal: computed.freightTotal, taxTotal: computed.taxTotal,
    total: computed.total,
    lines: lineData.map((l) => ({
      position: l.position, kind: l.kind, description: l.description,
      glAccountName: l.glAccountName, amount: l.amount,
    })),
  };

  const invoice = await auditedCreate("invoice", auditData, async () => {
    const created = await tx.invoice.create({
      data: {
        kind: "INVOICE",
        orderId: data.orderId,
        customerId: order.customerId,
        status: "DRAFT",
        invoiceDate,
        poNumber: order.poNumber,
        termsName: customer.terms?.name ?? "",
        billTo, shipTo, materialName, processNames,
        taxRate,
        subtotal: computed.subtotal, surchargeTotal: computed.surchargeTotal, chargeTotal: computed.chargeTotal,
        certTotal: computed.certTotal, freightTotal: computed.freightTotal, taxTotal: computed.taxTotal,
        total: computed.total,
        clientRequestId: data.clientRequestId ?? null,
        // What these lines were calculated from, shipment-side; finalize compares it (2026-10-06).
        shipmentFingerprint: fingerprint,
      },
      select: { id: true },
    });
    // The lines in one INSERT, each OPERATION already under its PART line (#624).
    const identities = lineIdentities(computed.lines);
    await tx.invoiceLine.createMany({
      data: lineData.map((l, i) => ({ ...l, invoiceId: created.id, ...identities[i] })),
    });
    return created;
  }, { tx });

  return { detail: await readInvoiceDetail(tx, invoice.id), deduped: false };
}

/**
 * `createInvoice` (spec §5.4). Reads the plant-wide deps outside the transaction, then creates the
 * DRAFT invoice under the order's row claim. `clientRequestId` collisions answer with the invoice
 * that request already created (`orders.ts`'s idempotent-replay shape, via the exported
 * `isDuplicateClientRequestId`), recomputing the warnings for the replay (#50 — the lost-response
 * retry is exactly when the operator never saw them).
 *
 * `tx` is optional: internal callers and the discriminating concurrency test pass a manually-opened
 * transaction so the row lock, not SSI, is what serializes competing creates (the `createCert`
 * shape).
 */
export async function createInvoice(input: unknown, tx?: Prisma.TransactionClient): Promise<InvoiceCreateResult> {
  const data = CREATE.parse(input);
  const deps = await loadInvoiceDeps();

  if (tx) {
    const { detail, deduped } = await createInvoiceInTx(tx, data, deps);
    return { invoice: detail, warnings: await invoiceWarnings(detail), deduped };
  }

  return withDbErrors({ entity: "Invoice" }, async () => {
    try {
      const { detail, deduped } = await prisma.$transaction(
        (fresh) => createInvoiceInTx(fresh, data, deps),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return { invoice: detail, warnings: await invoiceWarnings(detail), deduped };
    } catch (err) {
      // The backstop replay: inside withDbErrors' callback and OUTSIDE the transaction — by the
      // time this runs the failed attempt has fully rolled back and the winning invoice is
      // committed. A same-order replay that starts after that commit is answered under the claim;
      // this answers one that overlapped it (`createInvoiceInTx`) and a nonce reused across orders.
      if (!data.clientRequestId || !isDuplicateClientRequestId(err)) throw err;
      const existing = await prisma.invoice.findFirst({
        where: { clientRequestId: data.clientRequestId }, select: { id: true },
      });
      if (!existing) throw err;
      const invoice = await readInvoiceDetail(prisma, existing.id);
      return { invoice, warnings: await invoiceWarnings(invoice), deduped: true };
    }
  });
}

/**
 * The advisory surface every mutating invoice route returns alongside the invoice (§7.5). Pure over
 * the detail — one entry per line that still needs a price, and one per operation line whose step
 * code carries no GL account (advisory in 5A; 5C's QBO export refuses to post without one).
 */
export async function invoiceWarnings(detail: InvoiceDetail): Promise<string[]> {
  const warnings: string[] = [];
  for (const l of detail.lines) {
    if (l.needsPrice) {
      // A CHARGE line (and any other non-part line) carries a blank `partNumber` — fall back to
      // its own description as the label so the message never renders a dangling "·  —".
      const label = l.partNumber === "" ? `${l.description} —` : `${l.partNumber} — ${l.description}`;
      warnings.push(`Line ${l.position} · ${label} needs a price`);
    }
  }
  for (const l of detail.lines) {
    // #62: EVERY account-bearing kind, not only the step-code-carrying ones. A hand-typed CHARGE
    // carries no step code, so the old `processStepCodeId !== null` test let it through silently —
    // and 5C's export then drops it (or, since #89, refuses the whole month). The kinds excluded
    // here are the ones that genuinely post nothing: a PART line is a $0 header, and a TAX line's
    // account comes from the billing config at export time, never from the line.
    if (l.kind === "PART" || l.kind === "TAX") continue;
    // A $0 line posts nothing, so it is not a gap — the same test `resolveReadiness` applies, and
    // the two must agree or this warns about a line the export is perfectly happy with.
    if (l.glAccountId === null && Math.round(l.amount * 100) !== 0) {
      // A CHARGE/FREIGHT/CERT line carries a blank part number — fall back to its own description,
      // the same label rule the needs-price warning above uses.
      const label = l.partNumber === "" ? l.description : `${l.partNumber} — ${l.description}`;
      warnings.push(`Line ${l.position} · ${label} has no GL account`);
    }
  }
  for (const l of detail.lines) {
    // Review round 3, and the honest answer to a limit the ruling itself mandates. A typed price on
    // the tier-3 "needs price" line carries NO step code, so it stands in for the WHOLE order line
    // (§5.5 / the #61 ruling) — and it keeps standing in: a priced operation added to that part
    // AFTERWARDS is covered by the typed figure and never bills on its own. That is the ruled
    // behaviour, not a defect, and the stored state genuinely cannot tell "the work this price was
    // typed for" from "work added since. So it is SURFACED rather than guessed at, which is the one
    // thing the recalculate must not do silently. #587: Finalize now refuses such a line on an
    // invoice when it bills (`typedPriceStandingIn`, which both read); a draft is still warned.
    if (typedPriceStandingIn(l)) {
      const label = l.partNumber === "" ? l.description : `${l.partNumber} — ${l.description}`;
      warnings.push(
        `Line ${l.position} · ${label} is a typed price standing in for every priced operation on ` +
        "this part — re-check it after any pricing change");
    }
  }
  return warnings;
}

// -------------------------------------------------------------------------------------------
// Task 12 (§5.5): draft edits, recalculate, discard. Every mutator here shares one bracket —
// `withDbErrors` → Serializable `$transaction` → `claimLiveInvoice` → `audited*` → writes on
// `tx` — and every one refuses a FINALIZED invoice (immutable until Task 13's unlock) and a
// discarded one, each naming what blocks it. A FINALIZED invoice is customer-facing paper; the
// corrections are unlock or credit, never a silent edit.
// -------------------------------------------------------------------------------------------

/**
 * The lifecycle claim shared by EVERY invoice mutator — Task 12's draft edits (through
 * `claimLiveInvoice` below) and Task 13's finalize/unlock. Factored like `claimLiveShipper`
 * (shippers.ts): an UNLOCKED stub read to learn which order to claim (404 on missing), `claimOrder`
 * on that order, then `FOR UPDATE` on the Invoice row itself — uniformly AFTER the order claim, one
 * fixed order (Order row, then the entity's own row), so no ABBA window opens (order-locks.ts house
 * rule). Only then the liveness re-read, off rows this transaction actually holds.
 *
 * `Invoice.status`/`deletedAt` live on the Invoice row, so a concurrent finalize, unlock, discard or
 * draft edit — every one of which also claims this order first — serializes through these two locks:
 * the caller's refusal and the write it guards see the same state, and a Serializable caller whose
 * Invoice row changed under it raises 40001 (withDbErrors' honest 409) rather than acting on a stale
 * snapshot. Taking the ORDER claim FIRST is the house-rule obligation Task 10's invoice guards rest
 * on (invoice-guards.ts): they read the finalized-invoice state under THEIR order claim, so finalize
 * and unlock must hold the same order claim before they read or write that state.
 *
 * Returns the fresh invoice detail row and the claimed Order row. The FINALIZED check is the
 * caller's, not this helper's — finalize allows a DRAFT, unlock allows a FINALIZED, and the edit
 * mutators refuse a FINALIZED — so each names its own blocker (`claimLiveInvoice` below is the edit
 * mutators' wrapper that adds theirs).
 */
async function claimInvoiceRow(tx: Db, id: string): Promise<{ invoice: DetailRow; order: Order }> {
  const stub = await tx.invoice.findFirst({ where: { id }, select: { orderId: true } });
  if (!stub) throw new HttpError(404, "Invoice not found");
  const order = await claimOrder(tx, stub.orderId);
  if (!order) throw new HttpError(404, "Invoice not found");
  await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${id} FOR UPDATE`;
  const invoice = await tx.invoice.findFirst({ where: { id }, include: DETAIL_INCLUDE });
  if (!invoice || invoice.deletedAt !== null) throw new HttpError(404, "Invoice not found");
  return { invoice, order };
}

/**
 * The DRAFT-edit claim: `claimInvoiceRow` plus the refusal that a FINALIZED invoice is immutable
 * until unlock. A FINALIZED invoice is customer-facing paper; the corrections are unlock or credit,
 * never a silent edit (§5.5).
 */
async function claimLiveInvoice(tx: Db, id: string): Promise<{ invoice: DetailRow; order: Order }> {
  const claimed = await claimInvoiceRow(tx, id);
  if (claimed.invoice.status === "FINALIZED") {
    throw new HttpError(400,
      `Invoice #${claimed.invoice.order.orderNumber} is finalized and locked — unlock it before editing`);
  }
  return claimed;
}

// -------------------------------------------------------------------------------------------
// updateInvoice — header only.
// -------------------------------------------------------------------------------------------

const UPDATE_INVOICE = z.object({
  poNumber: z.string().max(200).optional(),
  invoiceDate: z.string().min(1).optional(),
  termsName: z.string().max(200).optional(),
  billTo: z.string().max(4000).optional(),
  shipTo: z.string().max(4000).optional(),
}).strict();

/**
 * Header-only draft edit (§5.5). Customer/order identity, the line-derived totals and the lifecycle
 * columns are all off-limits here — the correctable header snapshots are PO, invoice date, terms and
 * the two address blocks. A partial patch persists exactly the keys the caller sent: every field is
 * an independent scalar, so there is no interdependent state a partial write could leave stale (the
 * Task 6 defect), and an unspecified field keeps its value rather than being blanked.
 */
export async function updateInvoice(id: string, input: unknown): Promise<InvoiceDetail> {
  const data = UPDATE_INVOICE.parse(input);
  const patch: Prisma.InvoiceUpdateInput = {
    ...(data.poNumber !== undefined ? { poNumber: data.poNumber } : {}),
    ...(data.invoiceDate !== undefined ? { invoiceDate: parseDate(data.invoiceDate, "Invoice date") } : {}),
    ...(data.termsName !== undefined ? { termsName: data.termsName } : {}),
    ...(data.billTo !== undefined ? { billTo: data.billTo } : {}),
    ...(data.shipTo !== undefined ? { shipTo: data.shipTo } : {}),
  };

  return withDbErrors({ entity: "Invoice" }, () => prisma.$transaction(async (tx) => {
    await claimLiveInvoice(tx, id);
    // Header scalars only (`UPDATE_INVOICE` is strict), so the children-free snapshot pair (R5):
    // the lines, which this patch cannot touch, are not read twice more and written twice.
    await auditedUpdate("invoice", id, () => tx.invoice.update({ where: { id }, data: patch }), { tx, snapshot: "header" });
    return readInvoiceDetail(tx, id);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

// -------------------------------------------------------------------------------------------
// replaceInvoiceLines — whole-array replace (the replaceCharges / replaceShipperLines precedent).
// The lines come from the CALLER, not the engine, so snapshots and amounts are written as given,
// but for four: an account-less CHARGE takes the plant default (#62); on an INVOICE, a step picked
// on a Needs price line (`isPickedStep`) takes its step code's GL account, whatever the payload
// sent (#587); on an INVOICE, each computed surcharge is figured again over the operation lines
// saved, a percent one taking the new figure and one with no operation line left in its scope
// removed (#586); then, on an invoice or a credit, a computed TAX line is figured over the lines
// kept (#64). The registered FKs are guarded and the totals recomputed.
// Grouping (OPERATION -> PART) is expressed by caller-supplied `key`/`parentKey`, re-wired in a
// second pass — positions are reassigned 1..n and row ids reminted, so an id-based parent link
// could never survive the replace.
// -------------------------------------------------------------------------------------------

const LINE_INPUT = z.object({
  key: z.string().min(1).optional(),
  parentKey: z.string().min(1).nullable().optional(),
  kind: z.enum(INVOICE_LINE_KINDS),
  orderLineId: z.string().min(1).nullable().optional(),
  processStepCodeId: z.string().min(1).nullable().optional(),
  surchargeId: z.string().min(1).nullable().optional(),
  orderChargeId: z.string().min(1).nullable().optional(),
  glAccountId: z.string().min(1).nullable().optional(),
  partNumber: z.string().max(200).optional(),
  partName: z.string().max(200).optional(),
  partDescription: z.string().max(4000).optional(),
  description: z.string().max(4000).optional(),
  glAccountName: z.string().max(200).optional(),
  qty: z.number().int().nullable().optional(),
  weight: decimalBoxField(INVOICE_LINE_NET_WEIGHT.box),
  eachWeight: decimalField(10, 4),
  pricePer: z.enum(PRICE_PER).nullable().optional(),
  unitPrice: decimalField(12, 4),
  setupCharge: decimalField(12, 2),
  minimumCharge: decimalField(12, 2),
  breakThreshold: decimalField(12, 2),
  minimumApplied: z.boolean().optional(),
  rate: decimalField(9, 6),
  priceSource: z.enum(PRICE_SOURCES).nullable().optional(),
  // The frozen quote number rides the round-trip: the UI grid echoes every column back on a lines
  // save, and a schema that dropped this one would blank "Quote #N" off the paper on any edit.
  sourceQuoteNumber: z.number().int().nullable().optional(),
  needsPrice: z.boolean().optional(),
  // #587: optional, so an older client's payload, which has no such key, is still a valid Save.
  wordsChosen: z.boolean().optional(),
  amount: decimalBoxField(INVOICE_LINE_AMOUNT.box, { required: true }),
}).strict().refine(
  // #98 (whole-branch review F5): the manual-lines save is a trusted, permission-gated, audited
  // surface — but `sourceQuoteNumber` is the frozen tier-1 stamp that prints "Quote #N", and it must
  // not ride a MANUAL (or null-source) line, which would print an agreement number the line never
  // had. This is shape-tightening, not authenticity verification — a live-quote check is a
  // deliberate frozen-paper non-goal (§7.5). The echo-back for genuine QUOTE lines is untouched.
  (l) => l.sourceQuoteNumber === null || l.sourceQuoteNumber === undefined || l.priceSource === "QUOTE",
  { message: "sourceQuoteNumber is only allowed when priceSource is QUOTE", path: ["sourceQuoteNumber"] },
);

type LineInput = z.infer<typeof LINE_INPUT>;
const REPLACE_LINES = z.array(LINE_INPUT);

/** One payload item -> its InvoiceLine columns (minus `invoiceId`/`position`/`parentLineId`, all
 *  assigned by the caller). Every column is persisted, defaulted the same way the schema defaults
 *  it — so a whole row is written, never a subset (the Task 6 normalize-on-write rule). */
function lineColumns(l: LineInput) {
  return {
    kind: l.kind,
    orderLineId: l.orderLineId ?? null, processStepCodeId: l.processStepCodeId ?? null,
    surchargeId: l.surchargeId ?? null, orderChargeId: l.orderChargeId ?? null, glAccountId: l.glAccountId ?? null,
    partNumber: l.partNumber ?? "", partName: l.partName ?? "", partDescription: l.partDescription ?? "",
    description: l.description ?? "", glAccountName: l.glAccountName ?? "",
    qty: l.qty ?? null, weight: l.weight ?? null, eachWeight: l.eachWeight ?? null,
    pricePer: l.pricePer ?? null, unitPrice: l.unitPrice ?? null,
    setupCharge: l.setupCharge ?? null, minimumCharge: l.minimumCharge ?? null,
    breakThreshold: l.breakThreshold ?? null, minimumApplied: l.minimumApplied ?? false,
    rate: l.rate ?? null, priceSource: l.priceSource ?? null,
    sourceQuoteNumber: l.sourceQuoteNumber ?? null,
    // #587: only an operation line's words are chosen (the box that chooses them is on operation
    // rows alone, and Recalculate carries only an operation's), so any other kind is written false.
    needsPrice: l.needsPrice ?? false, wordsChosen: l.kind === "OPERATION" ? (l.wordsChosen ?? false) : false,
    amount: l.amount,
  };
}

/**
 * Save lines' surcharge step (#586; owner rulings 586-1, 586-4, 586-6, Q-A, Q-B): which payload
 * lines are kept, and at what amount, once each COMPUTED surcharge line is judged over the operation
 * lines being saved. A computed surcharge line is a SURCHARGE that was not typed (`priceSource` is
 * not MANUAL) and whose `surchargeId` is in `admin`; every other line, a typed surcharge included,
 * is kept at its own amount.
 *
 * Each is judged by `surchargeOnLines`, the engine's own rule, with its kind, rate and amount from
 * the LINE (`rate !== null` → PERCENT) and its minimum, scope and step codes from Admin. `null` (no
 * operation line in its scope) drops it, percent or flat; otherwise a percent line takes the figure
 * and a flat line keeps its own amount. Nothing is ever added. Pure: the mask and the amounts run
 * parallel to `lines`, so the caller filters its columns and its payload with the one mask.
 */
function computedSurcharges(
  lines: readonly {
    kind: InvoiceLineKindValue; processStepCodeId: string | null; surchargeId: string | null;
    priceSource: PriceSourceValue | null; rate: number | null; amount: number;
  }[],
  admin: ReadonlyMap<string, SurchargeRow>,
): { keep: boolean[]; amounts: number[] } {
  const keep = lines.map(() => true);
  const amounts = lines.map((l) => l.amount);
  for (const [i, l] of lines.entries()) {
    if (l.kind !== "SURCHARGE" || l.surchargeId === null || l.priceSource === "MANUAL") continue;
    const surcharge = admin.get(l.surchargeId);
    if (surcharge === undefined) continue;
    const rule: SurchargeRule = {
      kind: l.rate !== null ? "PERCENT" : "FLAT", rate: l.rate, amount: l.amount,
      minimumAmount: surcharge.minimumAmount, scope: surcharge.scope, stepCodeIds: surcharge.stepCodeIds,
    };
    const figure = surchargeOnLines(rule, lines);
    if (figure === null) keep[i] = false;
    else if (rule.kind === "PERCENT") amounts[i] = figure;
  }
  return { keep, amounts };
}

/**
 * #594 (owner rulings 2026-10-21, 2026-11-02 and 2026-11-03): the computed lines a Save no longer
 * sends, remembered so Recalculate leaves them out. A line is remembered when it was computed (its
 * price source is not MANUAL: only removing a line still computed is remembered, and removing a
 * typed row stays the way to undo an override), its identity can be read (`overrideKey`), and the
 * payload carries it neither by its row (`key`, the row's server id) nor by its identity. Both, so a
 * row the operator kept but changed (a Needs price line with a step picked on it takes a new
 * identity) is not a removal, and neither is a line a grid loaded before an earlier save still
 * carries under the old row's id. Every kind is remembered, a PART line included (2026-11-03). The
 * marks already held are kept, and an identity is held once. Pure; `now` is the removal's stamp.
 */
function marksAfterSave(
  previous: readonly LineRow[], held: readonly RemovedLine[],
  payload: readonly { key?: string }[], payloadIdentities: ReadonlySet<string>, now: Date,
): RemovedLine[] {
  const keys = new Set(payload.flatMap((l) => (l.key === undefined ? [] : [l.key])));
  const marks = [...held];
  const heldIdentities = new Set(held.map((m) => m.identity));
  for (const l of previous) {
    if (l.priceSource === "MANUAL" || keys.has(l.id)) continue;
    const identity = overrideKey(l);
    if (identity === null || payloadIdentities.has(identity) || heldIdentities.has(identity)) continue;
    heldIdentities.add(identity);
    marks.push({
      identity, kind: l.kind, label: removedLineLabel(l), amount: l.amount.toNumber(), removedAt: now.toISOString(),
    });
  }
  return marks;
}

export async function replaceInvoiceLines(id: string, input: unknown): Promise<InvoiceDetail> {
  const data = REPLACE_LINES.parse(input);
  // Seam #1's MANUAL half (#62) — read OUTSIDE the transaction, then applied to every account-less
  // CHARGE the payload carries, so a hand-typed charge can never be persisted posting to nothing.
  const otherChargeGl = await otherChargeGlRef();
  // #586 (ruling 586-6): each surcharge's scope and minimum, read from Admin OUTSIDE the
  // transaction too, a switched-off one included (ruling Q-B). So a scope edit in Admin, and a
  // percent surcharge's minimum, reach a draft at its next Save. The kind, rate and amount are the
  // line's own and a flat line keeps its figure, so a rate or amount change, a flat surcharge's
  // minimum, a customer override or opt-out, or a switched-off surcharge waits for Recalculate
  // (ruling Q-E).
  const admin = new Map((await listSurcharges({ includeInactive: true })).map((s) => [s.id, s]));
  const columns = data.map((l) => withChargeGl(lineColumns(l), otherChargeGl));

  return withDbErrors({ entity: "Invoice" }, () => prisma.$transaction(async (tx) => {
    const { invoice } = await claimLiveInvoice(tx, id);
    // #594: the computed lines this Save no longer sends, judged against the payload AS SENT, before
    // any step below drops a line: a surcharge the #586 step drops for an empty scope was sent, and
    // is not the operator's removal. Only on an INVOICE: a credit never recalculates, so it holds no
    // marks (2026-11-02).
    const removedLines = invoice.kind === "INVOICE"
      ? marksAfterSave(invoice.lines, readRemovedLines(invoice.removedLines), data,
        new Set(columns.map((c) => overrideKey(c)).filter((k): k is string => k !== null)), new Date())
      : readRemovedLines(invoice.removedLines);
    // A picked line's GL account is set first; then two figures are worked out again over the lines
    // being saved, surcharges and then tax, so tax is figured over the surcharges as re-figured.
    // Step 1 reads `columns` and produces `withGl` (a new array on an invoice; on a credit, `columns`
    // itself); step 2 reads `withGl` and produces new arrays, `lines` (and `payload`, from `data`);
    // step 3 works on `lines`: the arrays this closure was handed are never changed. "Save lines"
    // and "Recalculate" are independent actions (nothing makes an operator recalculate after typing
    // a price, and finalize freezes whatever is on the invoice), so Save lines does all three itself.
    //
    // 1. A step picked on a Needs price line (#587, ruling 587-10 b, Amendment 17). On an INVOICE,
    //    every OPERATION line with a step code and no price row (`isPickedStep`, Recalculate's own
    //    test) takes its step code's GL account, whatever the payload sent: there is no operator GL
    //    picker, and a re-pick or an Admin change to the code's account must land without trusting
    //    the client to clear the account the row held. Read in one read on this transaction
    //    (`pickedStepGl`, Recalculate's too), before `assertLineRefs`, which refuses a step code
    //    that does not exist (the "none" below is for that code). A credit's lines keep
    //    the accounts they were copied with: a credit copies paper and offers no pick. This comes
    //    before the surcharges, though either order gives the same figures: a surcharge's scope reads
    //    a line's step code (ruling 586-2) and its amount, never its account, and this step changes
    //    only the account. First, so every array after it carries the account the line is written with.
    const pickedGl = invoice.kind === "INVOICE" ? await pickedStepGl(tx, columns) : null;
    const withGl = pickedGl === null ? columns : columns.map((c) => (isPickedStep(c)
      ? { ...c, ...(pickedGl.get(c.processStepCodeId!) ?? { glAccountId: null, glAccountName: "" }) }
      : c));
    // 2. The computed surcharges (#586), over the operation lines saved, typed prices included.
    //    Only on an INVOICE: a credit's surcharge lines stay as copied or as typed (ruling 586-5),
    //    since the minimum floor would turn a credited surcharge positive. One mask filters the
    //    lines and the payload together, so `lineIdentities` maps each key to its own row.
    const { keep, amounts } = invoice.kind === "INVOICE"
      ? computedSurcharges(withGl, admin)
      : { keep: withGl.map(() => true), amounts: withGl.map((c) => c.amount) };
    const lines = withGl.map((c, i) => ({ ...c, amount: amounts[i] })).filter((_, i) => keep[i]);
    const payload = data.filter((_, i) => keep[i]);
    // 3. Tax (#64's OTHER seam: re-deriving it only in `recalculateInvoice` let a taxable charge
    //    print under-taxed), on a credit too. Same rule as there: the rate is the invoice's own
    //    snapshot, and a MANUALLY overridden TAX line is left exactly as typed (the override wins,
    //    uniformly).
    const taxRate = invoice.taxRate === null ? null : invoice.taxRate.toNumber();
    const taxAt = lines.findIndex((c) => c.kind === "TAX");
    if (taxRate !== null && taxAt !== -1 && lines[taxAt].priceSource !== "MANUAL") {
      lines[taxAt] = { ...lines[taxAt], amount: taxOnLines(lines, taxRate) };
    }
    await assertLineRefs(tx, lines); // every registered FK the payload writes (the create guard)

    await auditedUpdate("invoice", id, async () => {
      await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
      if (lines.length > 0) {
        const identities = lineIdentities(payload);
        await tx.invoiceLine.createMany({
          data: lines.map((c, i) => ({ invoiceId: id, position: i + 1, ...c, ...identities[i] })),
        });
      }
      await tx.invoice.update({ where: { id }, data: { ...totalsFromLines(lines), removedLines } });
    }, { tx });

    return readInvoiceDetail(tx, id);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/**
 * #594's Restore (owner ruling 2026-11-02): forget one removal, so the next Recalculate writes the
 * line back as its own kind, on its own GL account; Restore all forgets every one the list shows. It re-prices nothing and touches no line: the
 * line returns only at Recalculate, which the page says. A draft's only, under the draft-edit claim;
 * a mark not held is refused (`NOT_REMOVED`), a second Restore of one line included.
 */
export async function restoreRemovedLine(id: string, input: unknown): Promise<InvoiceDetail> {
  // Restore all (owner answer 2026-11-04) sends every identity its list shows, and each must still
  // be held: a list read before another Restore landed is refused whole, as one stale Restore is.
  const parsed = z.union([
    z.object({ identity: z.string().min(1) }).strict(),
    z.object({ identities: z.array(z.string().min(1)).min(1) }).strict(),
  ]).parse(input);
  const asked = new Set("identity" in parsed ? [parsed.identity] : parsed.identities);
  return withDbErrors({ entity: "Invoice" }, () => prisma.$transaction(async (tx) => {
    const { invoice } = await claimLiveInvoice(tx, id);
    const held = readRemovedLines(invoice.removedLines);
    const heldIds = new Set(held.map((m) => m.identity));
    if ([...asked].some((identity) => !heldIds.has(identity))) throw new HttpError(400, NOT_REMOVED);
    const removedLines = held.filter((m) => !asked.has(m.identity));
    await auditedUpdate("invoice", id,
      () => tx.invoice.update({ where: { id }, data: { removedLines } }), { tx });
    return readInvoiceDetail(tx, id);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/** One line of `recalculateInvoice`'s final ordered set. `columns` is the whole write row minus the
 *  three the writer assigns (`invoiceId`/`position`/`parentLineId`) — the Prisma input type rather
 *  than `InvoiceLineWrite`, because a preserved manual row's decimals arrive as `Decimal` while the
 *  engine's arrive as `number`, and both are valid here. `kind`/`amount` are lifted out for the two
 *  passes that read them without caring which side produced the row: the tax recompute and the
 *  totals. */
type RecalcColumns =
  Omit<Prisma.InvoiceLineCreateManyInput, "id" | "invoiceId" | "parentLineId" | "position">
  & { position?: number };
type RecalcLine = {
  key: string; parentKey: string | null; isManual: boolean;
  kind: InvoiceLineKindValue; amount: number; columns: RecalcColumns;
};

// -------------------------------------------------------------------------------------------
// recalculateInvoice — re-price from CURRENT data (new part prices, new surcharges, current shipped
// totals) and replace every DERIVED line (priceSource ≠ MANUAL), keeping the manual ones. It re-runs
// Task 11's whole build — `buildPricingInput` + `priceOrder` + the shared
// `mapComputedLines`/`assertLineRefs` — so with no manual line it writes the lines a fresh
// `createInvoice` would for the same order today, but for words chosen on a derived operation
// (#587, below), which it keeps. There is no second pricing path to drift from.
//
// A manual line is kept in ONE of two places (#61, owner ruling 2026-08-17): substituted into the
// slot of the derived line it overrides, or — matching nothing — appended (§5.5). The whole set is
// then renumbered 1..n and parent-wired through `wirePayloadParents`, the same key-based pass
// `replaceInvoiceLines` uses, so a substituted override keeps its place under its PART line, and an
// appended one keeps its tie to the line its old parent became (plan Amendment 4, `addedParentKey`). A
// picked step (a Needs price line with a step picked and a price typed, #587) overrides its step's
// line once that step is priced and the tier-3 line while the part is not; otherwise it is appended,
// never re-homed onto another step's line. Its GL account is read from its step code, not kept.
//
// Words chosen on a derived operation line (`wordsChosen`, #587) are kept too, on the regenerated
// line with the same order line and step code, or, from a line with no step code, on the only
// operation the engine now gives its order line; the amount re-prices, and a line an override takes
// prints the override's words. Words chosen on a manual line are kept with the line.
//
// Two figures follow the manual lines, in the same order as Save lines: the surcharges, then tax
// over the final set (#64). The engine figures its SURCHARGE lines over its own operations, so they
// are set aside before anything is paired, and the surcharge block is rebuilt over the operation
// lines as they will print, each override in its slot and each typed operation riding at the end
// included (#586, owner rulings 586-1 to 586-3). It is built by the engine's own rule and builder
// (`surchargeOnLines`, `surchargeLine`) and keeps the engine's place, above the freight, charges,
// cert and tax: each surcharge the engine is given (active, and not opted out by the customer) is
// there when one of those lines is in its scope and gone when none is. With no manual line those
// lines are the engine's own, so the block is too.
//
// A computed line the operator removed (#594) is not written back: every engine line, and every
// line of the rebuilt surcharge block, whose identity is on the invoice's removed lines is left out
// before anything is paired. Restore takes a line off that list; the next Recalculate bills it.
// -------------------------------------------------------------------------------------------

/**
 * Recalculate's whole line set, worked out and not written (#605): the claimed invoice's previous
 * lines, its removal marks (#594) and the order's current pricing in, `ordered` out, each line with
 * its key, parent key and columns, tax already figured over the final set. `recalculateInvoice`
 * writes it; finalize reads it to refuse an invoice Recalculate would add a priced operation to, so
 * "what Recalculate would add" is answered by Recalculate's own pairing, never a second rule. On the
 * caller's claimed `tx` (#60); writes nothing.
 */
async function recalculationPlan(
  tx: Db, deps: InvoiceDeps, invoice: DetailRow, order: Order,
): Promise<{ ordered: RecalcLine[]; taxRate: number | null; fingerprint: string; certStepIds: string[] }> {
  const customer = await tx.customer.findFirst({
    where: { id: order.customerId },
    select: {
      taxable: true, salesTaxRate: true, certChargeSuppressed: true,
      ...CUSTOMER_SURCHARGE_SELECT,
    },
  });
  if (!customer) throw new HttpError(404, "Customer not found");

  // ORDER_LINE_SELECT carries `quoteLineId`, so this whole re-price resolves tier 1 the same
  // way create does (ruling 8's unlock-and-recalculate: the link honored, CURRENT quote rows).
  const orderLines: OrderLineRow[] = await tx.orderLine.findMany({
    where: { orderId: order.id },
    orderBy: { position: "asc" },
    select: ORDER_LINE_SELECT,
  });

  const { input, otherChargeGlName, shipmentFingerprint: fingerprint } =
    await buildPricingInput(tx, deps.config, deps.surcharges, order, customer, orderLines);
  const computed = priceOrder(input);
  // #586: the engine's SURCHARGE lines are figured over the engine's own operations, so they are
  // set aside before anything is paired or mapped; the block that replaces them is built below,
  // over the operation lines as they will print.
  //
  // #594: and every engine line whose identity the operator removed is left out here, before
  // anything is paired, so a removed operation is never an override's slot, never re-homed onto,
  // and never in a surcharge's scope, and a removed freight, charge, cert or tax line is simply
  // not there. The rebuilt surcharge block below leaves a removed surcharge out the same way.
  const removed = new Set(readRemovedLines(invoice.removedLines).map((m) => m.identity));
  const isRemoved = (l: ComputedLine) => { const k = overrideKey(l); return k !== null && removed.has(k); };
  const engineLines = computed.lines.filter((l) => l.kind !== "SURCHARGE" && !isRemoved(l));
  const otherChargeGl: GlRef = {
    glAccountId: deps.config.otherChargeGlAccountId, glAccountName: otherChargeGlName,
  };
  // The whole previous line set, as the claim read it (#627): `claimLiveInvoice`'s
  // `DETAIL_INCLUDE.lines` is every `InvoiceLine` row, all columns, by position, taken under the
  // same Order and Invoice claim, and only reads run between it and here, so reading the rows
  // again on `tx` would return the same rows. (Narrow that include with a `select` and
  // `overrideKey`, the manual re-create and the chosen-words carry-over below stop compiling.)
  // `manual` is what survives a recalculate (§5.5), re-created below — either in the slot of the
  // derived line it overrides, or at the end if it overrides nothing. The DERIVED identities
  // matter too (review round 2): they are what tells an operation that has newly APPEARED from
  // one that was already being billed in its own right, which is the difference between
  // re-homing an override and stealing a sibling's slot. The derived lines' chosen words matter
  // as well (#587): they carry onto the regenerated lines.
  const previous = invoice.lines;
  const manual = previous.filter((l) => l.priceSource === "MANUAL");
  const alreadyBilled = new Set(
    previous.filter((l) => l.priceSource !== "MANUAL")
      .map((l) => overrideKey(l))
      .filter((k): k is string => k !== null));

  // #61 (owner ruling 2026-08-17): pair each manual line with the derived line it overrides, by
  // order-side identity. An override REPLACES its twin in place; anything left over is an addition
  // and keeps riding at the end. Pairing on the ENGINE's own key means a manual line whose derived
  // twin no longer exists at all (its order line stopped shipping, say) falls through to the
  // additions rather than vanishing.
  //
  // A manual SURCHARGE is not paired in this loop (#586). Its twin is a line of the rebuilt block,
  // which cannot be figured until this loop has placed the operations' overrides, so it pairs after
  // the block is built, by the same exact identity, against the block alone. Paired against the
  // engine's own surcharge lines, it would take a slot the final set no longer holds and be lost.
  const computedKeyByIdentity = new Map<string, string>();
  const identityByComputedKey = new Map<string, string>();
  const operationKeysByOrderLine = new Map<string, string[]>();
  for (const l of engineLines) {
    const identity = overrideKey(l);
    if (identity !== null) identityByComputedKey.set(l.key, identity);
    if (identity !== null && !computedKeyByIdentity.has(identity)) computedKeyByIdentity.set(identity, l.key);
    if (l.kind === "OPERATION" && l.orderLineId !== null) {
      operationKeysByOrderLine.set(l.orderLineId,
        [...(operationKeysByOrderLine.get(l.orderLineId) ?? []), l.key]);
    }
  }
  const overrides = new Map<string, (typeof manual)[number]>(); // derived key -> the manual line taking its slot
  const absorbed = new Set<string>(); // engine keys an override standing elsewhere already covers
  const keyByManualId = new Map<string, string>(); // a manual line -> its slot's key, or `manual:<id>` (below)
  const isClaimed = (key: string) => overrides.has(key) || absorbed.has(key);

  for (const m of manual) {
    if (m.kind === "SURCHARGE") continue; // paired against the rebuilt block, below
    const identity = overrideKey(m);
    const exact = identity === null ? undefined : computedKeyByIdentity.get(identity);
    // `isClaimed` keeps the FIRST claimant of a slot: a second manual line with the same identity
    // rides as an addition rather than being silently dropped.
    let slot = exact !== undefined && !isClaimed(exact) ? exact : undefined;
    let cover: string[] = [];
    if (slot === undefined && exact === undefined && m.kind === "OPERATION" && m.orderLineId !== null) {
      // REVIEW ROUND 1 — a step-exact identity is not enough, and the miss double-billed exactly
      // as the original #61 did. An operation can legitimately regenerate under a step code the
      // override does not name: the operator typed into the tier-3 "needs price" line (which
      // carries NO step code) and the shop has since priced the part, or the operation's part
      // price was retired and re-added under a different step code. So an unmatched OPERATION
      // override falls back to its ORDER LINE.
      //
      // REVIEW ROUND 2 — and only onto an operation that has APPEARED SINCE. Re-homing onto any
      // free operation traded the double bill for its mirror: on a line pricing steps A and B,
      // with A overridden and then A's price retired, the override took B's slot and B's revenue
      // vanished from customer paper. An operation that was ALREADY on the invoice as its own
      // derived line is not the one this override replaced — it is a sibling, and it keeps its
      // line. When nothing qualifies, the override rides as an addition where the operator can
      // see it, which is the honest answer to an ambiguity rather than a guess at money.
      //
      // How much it takes is the remaining care. A manual line with NO step code overrode a line
      // standing for the WHOLE order line, so it covers every operation that line now prices; one
      // whose step code merely no longer prices replaced ONE operation, so it takes one.
      //
      // #587 (Amendment 19) — except a picked step (`isPickedStep`: a step code and no price row,
      // a Needs price line with a step picked on it). It stood in for no priced operation, only
      // for the tier-3 line, and it bills the one step it names (ruling 587-10 b). So it takes
      // only its order line's tier-3 slot, while the part is still unpriced; a step priced since,
      // other than the step picked, bills on its own line, and the picked line rides at
      // the end. Its exact twin, once its own step is priced, it took above.
      const free = (operationKeysByOrderLine.get(m.orderLineId) ?? []).filter((k) => {
        if (isClaimed(k)) return false;
        // Fails CLOSED: an operation whose identity cannot be read is not re-homed onto. Every key
        // here comes from an OPERATION with a non-null `orderLineId`, for which `overrideKey` never
        // returns null, so this is unreachable — but the permissive direction would silently
        // resurrect the sibling-erasure round 2 closed, and that is not a trade worth taking.
        const derivedIdentity = identityByComputedKey.get(k);
        return derivedIdentity !== undefined && !alreadyBilled.has(derivedIdentity);
      });
      const tierThree = overrideKey({ ...m, processStepCodeId: null });
      [slot, ...cover] = isPickedStep(m)
        ? free.filter((k) => identityByComputedKey.get(k) === tierThree).slice(0, 1)
        : m.processStepCodeId === null ? free : free.slice(0, 1);
    }
    if (slot !== undefined) {
      overrides.set(slot, m);
      for (const key of cover) absorbed.add(key);
      keyByManualId.set(m.id, slot);
    }
  }

  // #586: the operation lines as they will print — the engine's in order, each overridden one
  // read as its manual line (that line's own step code and amount, so a typed price, and a typed
  // Needs price line's empty step code, are what the scope is judged on), each absorbed one
  // dropped, then every manual operation that found no slot, which will ride at the end.
  const printedOperation = (m: (typeof manual)[number]) =>
    ({ kind: m.kind, processStepCodeId: m.processStepCodeId, amount: m.amount.toNumber() });
  const operations = [
    ...engineLines.flatMap((l) => {
      if (l.kind !== "OPERATION" || absorbed.has(l.key)) return [];
      const m = overrides.get(l.key);
      return [m === undefined ? l : printedOperation(m)];
    }),
    ...manual.filter((m) => m.kind === "OPERATION" && !keyByManualId.has(m.id)).map(printedOperation),
  ];
  // The surcharge block, in the engine's order: a line for each surcharge with an operation in its
  // scope, figured and built as the engine figures and builds its own (`surchargeOnLines`,
  // `surchargeLine`), keyed by its identity. It takes the engine's place, above the first freight,
  // charge, cert or tax line, so a typed operation riding at the end is billed by a surcharge that
  // prints above it: additions ride at the end (#61).
  const block = input.surcharges.flatMap((s) => {
    if (removed.has(`SURCHARGE:${s.surchargeId}`)) return []; // #594
    const amount = surchargeOnLines(s, operations);
    return amount === null ? [] : [surchargeLine(s, amount, `SURCHARGE:${s.surchargeId}`)];
  });
  // `priceOrder`'s push order after its surcharges (pricing.ts), restated; each names the other.
  const below = engineLines.findIndex((l) => ["FREIGHT", "CHARGE", "CERT", "TAX"].includes(l.kind));
  const blockAt = below === -1 ? engineLines.length : below;
  const derivedLines = [...engineLines.slice(0, blockAt), ...block, ...engineLines.slice(blockAt)];

  // A manual SURCHARGE takes the slot of the block line with its exact identity, the first claimant
  // winning, as every other kind's exact match does above.
  const blockKeyByIdentity = new Map(block.map((l) => [overrideKey(l), l.key]));
  for (const m of manual) {
    if (m.kind !== "SURCHARGE") continue;
    const identity = overrideKey(m);
    const slot = identity === null ? undefined : blockKeyByIdentity.get(identity);
    if (slot !== undefined && !isClaimed(slot)) {
      overrides.set(slot, m);
      keyByManualId.set(m.id, slot);
    }
  }

  // Every manual line with no slot is an addition. One filter over `manual` keeps the previous
  // position order across every kind, a typed surcharge among them, as one pass always did.
  const added = manual.filter((m) => !keyByManualId.has(m.id));
  for (const m of added) keyByManualId.set(m.id, `manual:${m.id}`);

  // An addition keeps its tie (plan Amendment 4, the owner's answer of 2026-10-21). Its saved parent
  // is a line of the previous set, whose row is deleted below, so the tie is carried by key. A
  // manual parent is named by that line's own key (its slot, or `manual:<id>`). A DERIVED parent is
  // named by the key of the first line of the final derived set (`derivedLines`: the engine's lines
  // and the rebuilt surcharge block) holding the old parent's identity (`overrideKey`), which is
  // also the key an override standing in that slot is written under, so a manual PART line in the
  // old PART line's slot becomes the parent. When no line of the final set has that identity (its
  // order line stopped shipping, say), or the old parent has none, the addition is left untied: it
  // is never tied by its own order line. Before this, a derived parent was dropped, so a typed price
  // whose operation stopped pricing printed apart from its part line, which still printed (#589).
  const firstDerivedKeyByIdentity = new Map<string, string>();
  for (const l of derivedLines) {
    const identity = overrideKey(l);
    if (identity !== null && !firstDerivedKeyByIdentity.has(identity)) firstDerivedKeyByIdentity.set(identity, l.key);
  }
  const previousById = new Map(previous.map((l) => [l.id, l]));
  const addedParentKey = (m: (typeof manual)[number]): string | null => {
    if (m.parentLineId === null) return null;
    const manualParentKey = keyByManualId.get(m.parentLineId);
    if (manualParentKey !== undefined) return manualParentKey;
    const parent = previousById.get(m.parentLineId);
    // Defensive: every manual line is in `keyByManualId` by now (a slot or `manual:<id>`), so a
    // MANUAL parent was answered above; this refuses to treat one as derived if that ever changes.
    if (parent === undefined || parent.priceSource === "MANUAL") return null;
    const identity = overrideKey(parent);
    return identity === null ? null : (firstDerivedKeyByIdentity.get(identity) ?? null);
  };

  // #587 (Amendment 17): a picked step's GL account is its step code's, read now, in one read on
  // this transaction before anything is written (`pickedStepGl`, which Save lines reads too), so an
  // Admin change to the code's account reaches the line here.
  const pickedGl = await pickedStepGl(tx, manual);
  /** A manual row's GL account: a picked step's from its step code, any other line's as stored.
   *  A picked step's code is always found: the line's foreign key to it is `onDelete: SetNull`, so
   *  a hard-deleted code leaves the line with no step code and no picked step, and a soft-deleted
   *  one is still read and then refused by `assertLineRefs` below. The fallback is for the type. */
  const manualGl = (m: (typeof manual)[number]): GlRef => (isPickedStep(m)
    ? (pickedGl.get(m.processStepCodeId!) ?? { glAccountId: null, glAccountName: "" })
    : { glAccountId: m.glAccountId, glAccountName: m.glAccountName });

  /** A preserved manual row as a write, with seam #1 backfilled (#62) and a picked step's GL
   *  account read from its step code (#587). */
  const manualWrite = (m: (typeof manual)[number]): RecalcColumns => withChargeGl({
    kind: m.kind,
    orderLineId: m.orderLineId, processStepCodeId: m.processStepCodeId,
    surchargeId: m.surchargeId, orderChargeId: m.orderChargeId,
    partNumber: m.partNumber, partName: m.partName, partDescription: m.partDescription,
    description: m.description, ...manualGl(m),
    qty: m.qty, weight: m.weight, eachWeight: m.eachWeight,
    pricePer: m.pricePer, unitPrice: m.unitPrice, setupCharge: m.setupCharge,
    minimumCharge: m.minimumCharge, breakThreshold: m.breakThreshold, minimumApplied: m.minimumApplied,
    rate: m.rate, priceSource: m.priceSource, sourceQuoteNumber: m.sourceQuoteNumber,
    needsPrice: m.needsPrice, wordsChosen: m.wordsChosen, amount: m.amount,
  }, otherChargeGl);

  // #587 (Amendment 18): the words chosen on a derived operation line, and its mark, carry onto
  // the regenerated line with the same identity (order line and step code), so they survive a
  // re-price on a part with several operations (ruling 587-6). Words chosen on a line with no step
  // code (typed on a Needs price line) also carry onto their order line's regenerated operation
  // when it is the only operation the engine now gives that order line (ruling 587-7). Nothing
  // else carries: words chosen on a line whose step the engine does not price now (a step picked
  // on a Needs price line before its price was typed among them), or on a line with no step code
  // whose order line now has more than one operation, are dropped, and a line an override takes
  // prints the override's own words. Where two lines share an identity the first, by position,
  // carries. Only the words and the mark: every other column of the line is the engine's.
  const chosen = previous.filter((l) =>
    l.priceSource !== "MANUAL" && l.kind === "OPERATION" && l.wordsChosen && l.orderLineId !== null);
  const wordsByIdentity = new Map<string, string>();
  const steplessWordsByOrderLine = new Map<string, string>();
  for (const l of chosen) {
    const identity = overrideKey(l)!; // an OPERATION with an order line always has one
    if (!wordsByIdentity.has(identity)) wordsByIdentity.set(identity, l.description);
    if (l.processStepCodeId === null && !steplessWordsByOrderLine.has(l.orderLineId!)) {
      steplessWordsByOrderLine.set(l.orderLineId!, l.description);
    }
  }
  /** The words a regenerated derived line carries, or undefined where it keeps the engine's. */
  const carriedWords = (l: ComputedLine): string | undefined => {
    if (l.kind !== "OPERATION" || l.orderLineId === null) return undefined;
    return wordsByIdentity.get(overrideKey(l)!)
      ?? ((operationKeysByOrderLine.get(l.orderLineId) ?? []).length === 1
        ? steplessWordsByOrderLine.get(l.orderLineId) : undefined);
  };

  // The final ordered set: derived lines in engine order, the surcharge block in, each swapped for
  // its override where one exists, a derived operation carrying the words chosen for it (#587),
  // then the genuine additions, each under the parent `addedParentKey` names. Positions stay 1..n
  // and contiguous, so a substituted override keeps its place under its PART line instead of
  // becoming a trailing orphan. `derivedWrites[i]` is the write of `derivedLines[i]`: the list
  // mapped is the list walked, never `computed.lines`, whose surcharge lines the block replaces.
  const derivedWrites = mapComputedLines(derivedLines, otherChargeGl);
  const ordered: RecalcLine[] = derivedLines.flatMap((l, i) => {
    // Covered by an override standing in another slot — dropped outright, never billed twice.
    // Nothing is orphaned by this: an engine line only becomes a parent through its own
    // `parentKey`s, which name PART lines, never an absorbed OPERATION; and an addition re-tied
    // through `addedParentKey` names a line whose identity was already billed (`alreadyBilled`),
    // which `free` above never absorbs. `wirePayloadParents` leaves a child flat rather than
    // dangling if a `parentKey` names no line in the set.
    if (absorbed.has(l.key)) return [];
    const m = overrides.get(l.key);
    if (m !== undefined) {
      return [{
        key: l.key, parentKey: l.parentKey, isManual: true,
        kind: m.kind, amount: m.amount.toNumber(), columns: manualWrite(m),
      }];
    }
    const words = carriedWords(l);
    return [{
      key: l.key, parentKey: l.parentKey, isManual: false, kind: l.kind, amount: l.amount,
      columns: words === undefined
        ? derivedWrites[i] : { ...derivedWrites[i], description: words, wordsChosen: true },
    }];
  }).concat(added.map((m) => ({
    key: keyByManualId.get(m.id)!,
    parentKey: addedParentKey(m),
    isManual: true, kind: m.kind, amount: m.amount.toNumber(), columns: manualWrite(m),
  })));

  const certStepIds = input.cert && deps.config.certChargeStepCodeId ? [deps.config.certChargeStepCodeId] : [];

  // The second of the two figures worked out again over the final set; the first, the surcharge
  // block, is above (#586), so tax is figured over the surcharges as they will print.
  // #64: the engine priced its TAX line over ITS OWN lines — before any override was substituted
  // in and before the preserved manual lines existed, so a taxable hand-typed charge went untaxed
  // and an overridden operation was taxed at the figure the operator overrode away. Recompute over
  // the FINAL set. A MANUALLY overridden TAX line is left exactly as typed: the override wins,
  // uniformly, and re-deriving it here would be the very thing #61 forbids.
  const taxRate = input.tax?.rate ?? null;
  const tax = ordered.find((o) => o.kind === "TAX");
  if (taxRate !== null && tax !== undefined && !tax.isManual) {
    tax.amount = taxOnLines(ordered, taxRate);
    tax.columns = { ...tax.columns, amount: tax.amount };
  }

  return { ordered, taxRate, fingerprint, certStepIds };
}

export async function recalculateInvoice(id: string): Promise<InvoiceDetail> {
  const deps = await loadInvoiceDeps(); // plant-wide reads OUTSIDE the tx — the create precedent

  return withDbErrors({ entity: "Invoice" }, () => prisma.$transaction(async (tx) => {
    const { invoice, order } = await claimLiveInvoice(tx, id);
    // A credit's lines are derived from its source invoice with the sign flipped (§5.6), not from
    // the order — the order only ever prices at ordinary POSITIVE amounts. Recalculating a credit
    // would silently overwrite its negated lines/total with a positive re-price of the order (the
    // whole-branch review's money-inverting finding). There is no order pricing that should ever
    // replace a credit's derived lines; the only corrections are line edits (`replaceInvoiceLines`)
    // or discard.
    if (invoice.kind === "CREDIT") {
      throw new HttpError(400, "A credit cannot be recalculated — edit its lines or discard it");
    }
    if (order.deletedAt !== null) throw new HttpError(400, `Order #${order.orderNumber} has been voided`);

    const { ordered, taxRate, fingerprint, certStepIds } = await recalculationPlan(tx, deps, invoice, order);
    await assertLineRefs(tx, ordered.map((o) => o.columns), certStepIds);
    const totals = totalsFromLines(ordered);

    await auditedUpdate("invoice", id, async () => {
      await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
      // The parents are keyed the same way `replaceInvoiceLines` keys its payload: a substituted
      // override inherits the engine parentKey of the line it replaced, so it stays under its PART
      // line, and an added manual line keeps its parent, manual or derived (`addedParentKey`). A
      // parentKey naming no line in the set leaves the child flat rather than dangling.
      const identities = lineIdentities(ordered);
      await tx.invoiceLine.createMany({
        // Spread first, then stamp: the engine's writes carry their own `position`, and the set is
        // renumbered 1..n here so a substituted override and a trailing addition land in one series.
        data: ordered.map((o, i) => ({ ...o.columns, invoiceId: id, position: i + 1, ...identities[i] })),
      });

      // taxRate is inseparable from the regenerated TAX line — leaving the header column stale would
      // make it disagree with the line. The descriptive header snapshots (PO, terms, addresses,
      // material, process names) are NOT touched: recalculate replaces derived lines, not a user's
      // header edits.
      // The fingerprint is refreshed HERE and at create only: these are the two writes that
      // re-read the shipments. `replaceInvoiceLines` (a hand edit) reads no shipment and must not
      // refresh it, or saving the grid would clear finalize's stale-shipment refusal.
      await tx.invoice.update({ where: { id }, data: { taxRate, ...totals, shipmentFingerprint: fingerprint } });
    }, { tx });

    return readInvoiceDetail(tx, id);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

// -------------------------------------------------------------------------------------------
// discardInvoice — soft-delete a DRAFT that has never printed (§5.5/§5.17). It frees the order for
// a new invoice: the live-rows-only unique on `orderId` sees a discarded row as gone.
// -------------------------------------------------------------------------------------------

export async function discardInvoice(id: string, reason: string): Promise<void> {
  // §5.17: the reason is required and trimmed IN THE SERVICE (the `voidOrder` precedent) — a
  // discard frees the order number, exactly the unique-identifier case that rule governs, so no
  // future caller can bypass it.
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to discard an invoice");

  await withDbErrors({ entity: "Invoice" }, () => prisma.$transaction(async (tx) => {
    await claimLiveInvoice(tx, id);
    // Task 9 (§5.3): DEFENSE-IN-DEPTH. A draft can never carry real A/R activity through the
    // services — `applyPayment`/`applyCredit` require FINALIZED invoices/credits — so this guard is
    // unreachable by construction, but the spec mandates it belt-and-suspenders: paper with money
    // applied to it is never silently discarded. Read under the claim `claimLiveInvoice` holds.
    if (await hasReceivableActivity(tx, id)) {
      // #157/#173: the tail is computed, not a constant — it names a reopen only when something in
      // scope sits in a closed month and `voidApplication` would refuse it. INSIDE the `if`: on the
      // success path the hint must cost nothing (invoice-guards.ts).
      throw new HttpError(400,
        "This invoice has payments, credits or write-offs applied and cannot be discarded — "
        + `void them first${await applicationVoidHint(tx, id)}`);
    }
    // A printed invoice is paper the customer may hold — it can never be discarded, only credited
    // (§5.5). Any StoredDocument naming this invoice is proof it printed. Read under the claim.
    const printed = await tx.storedDocument.findFirst({ where: { invoiceId: id }, select: { id: true } });
    if (printed) {
      throw new HttpError(400, "This invoice has already printed and cannot be discarded — credit it instead");
    }
    await auditedSoftDelete("invoice", id, why, tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

// -------------------------------------------------------------------------------------------
// Task 13 (§5.5/§5.2): finalize, unlock, and the INVOICED/REOPENED status ownership. Both take the
// order claim FIRST (through the shared `claimInvoiceRow`) before they read or write invoice state,
// so they serialize against every order/shipment mutator whose Task 10 invoice guard
// (`finalizedInvoiceFor`) reads the finalized-invoice state under ITS own order claim (§5.7). Both
// write `Order.status` through `auditedUpdate`, onto the order's own history.
// -------------------------------------------------------------------------------------------

/**
 * #605 (owner rulings 2026-10-21 and 2026-11-02): the first PRICED operation Recalculate would add to
 * this invoice, with the line the refusal names, or null. "Would add" is Recalculate's own answer
 * (`recalculationPlan`, read here and written nowhere): a line of its final set that it derives (no
 * typed line takes its slot or covers it) and whose identity no line of the invoice holds now. So a
 * removed line (#594) does not count, since the plan leaves it out, and a quote-linked order line is
 * judged by its quote, which the plan prices it from: a step its part is priced for and its quote is
 * not is no line Recalculate adds (the owner's reason, 2026-11-02, for not comparing part price
 * rows), while a step its quote gains since is one. Priced: a step code and a price row (`pricePer`), the
 * "priced steps" of the sentence, so the tier-3 Needs price line and every other kind are left to
 * the refusals that already name them. The line named is the part line of that order line as the
 * invoice stands, else its first line there, else none.
 */
function pricedStepNotOnInvoice(
  current: readonly LineRow[], ordered: readonly RecalcLine[],
): { position: number | null; partNumber: string } | null {
  const held = new Set(current.map((l) => overrideKey(l)).filter((k): k is string => k !== null));
  for (const o of ordered) {
    const c = o.columns;
    // A typed line in the set is a line of this invoice, so its identity is held already.
    if (o.kind !== "OPERATION" || !c.processStepCodeId || !c.pricePer || !c.orderLineId) continue;
    const identity = overrideKey({
      kind: "OPERATION", orderLineId: c.orderLineId, processStepCodeId: c.processStepCodeId,
      surchargeId: null, orderChargeId: null,
    });
    if (identity === null || held.has(identity)) continue;
    const onLine = current.filter((l) => l.orderLineId === c.orderLineId);
    const named = onLine.find((l) => l.kind === "PART") ?? onLine[0];
    return { position: named?.position ?? null, partNumber: c.partNumber ?? "" };
  }
  return null;
}

async function finalizeInvoiceInTx(tx: Db, id: string, deps: InvoiceDeps): Promise<InvoiceDetail> {
  const { invoice, order } = await claimInvoiceRow(tx, id);
  // Read under the claim (the whole point of taking it): the order's live state and the invoice's
  // own status both decide the transition, and must be the state this write commits against.
  if (order.deletedAt !== null) throw new HttpError(400, `Order #${order.orderNumber} has been voided`);
  // Idempotent: a re-finalize is a 400 naming the state, never a second write (§5.5).
  if (invoice.status === "FINALIZED") throw new HttpError(400, "That invoice is already finalized");
  // Owner ruling 2026-10-06: an INVOICE is finalized only while its order is SHIPPED. `createInvoice`
  // checks that once, when the draft is raised; quantity decides completion, so a draft's order can
  // leave SHIPPED afterwards (a line's quantity raised, a rider line added, a shipment voided, or an
  // unlock that settled a reversed order on Partially shipped) and finalize would then write
  // INVOICED over an order with goods still owed. `order` is the row `claimInvoiceRow` read AFTER
  // its `claimOrder`, on this transaction, and the status lives on that claimed row: every writer of
  // `Order.status` holds the same claim, so this read and the INVOICED write below see one state.
  // After the already-finalized refusal, so a re-finalize (order INVOICED) still names its own
  // state. INVOICE-only: a CREDIT is finalized while its order is INVOICED or REOPENED and owns no
  // order status.
  if (invoice.kind === "INVOICE" && order.status !== "SHIPPED") {
    throw new HttpError(400,
      `Order #${order.orderNumber} is ${ORDER_STATUS_LABELS[order.status]} — `
      + "ship the rest or close the line short, then finalize");
  }
  // Owner ruling 2026-10-06: a draft is priced from what had shipped when it was raised or last
  // recalculated, and shipments stay editable under a draft. A line closed short at 8 of 10, a
  // draft raised for 8, the shipment then edited to send the last 2: the order stays SHIPPED, the
  // guard above passes, and finalize (which re-prices nothing) would issue 8 with 10 shipped. So
  // the invoice carries a fingerprint of the shipment-side inputs its lines were calculated from
  // (`readShipmentInputs`, written by create and recalculate), and finalize recomputes it from the
  // same read, on this transaction. A mismatch refuses; so does a stored null (a draft that
  // predates the column): Recalculate fixes both. Unlock leaves the stored value alone, so a
  // reversal or re-ship made while the invoice was finalized is a mismatch on the way back.
  // INVOICE-only: a CREDIT's lines are copied from its source invoice, not calculated from shipments.
  //
  // WHAT PROTECTS THIS READ. Not the order claim. `claimInvoiceRow` reads the invoice (to learn its
  // order) BEFORE `claimOrder`, and under Serializable that first read fixes the snapshot. A
  // shipment change that keeps the order SHIPPED writes no `Order` row (`recomputeOrderStatus`
  // skips an unchanged status), so when it commits while this transaction waits for the claim, the
  // claim is granted with no error and the read below sees the OLD shipments: the comparison
  // MATCHES. The claim gives mutual exclusion; it does not refresh the snapshot. What refuses the
  // stale draft is Postgres SSI, and it needs both halves: this transaction and the shipment
  // mutator are BOTH Serializable, the mutator reads state this transaction writes (the claimed
  // `Order` row, and `refuseIfInvoiced`'s finalized-invoice read), and this read is of rows the
  // mutator wrote. That cycle aborts finalize with 40001, which `withDbErrors` answers as a 409.
  //
  // STANDING INVARIANT: a stale draft can be finalized silently if any shipment mutator that
  // changes shipper lines or billed freight (`createShipper`, `updateShipper`,
  // `addOrderToShipper`, `removeOrderFromShipper`, `replaceShipperLines`, `voidShipper`,
  // `reverseShipper`) is ever downgraded from Serializable, to either level (SSI tracks only
  // all-Serializable transactions); if finalize is downgraded to Repeatable Read, which keeps its
  // snapshot fixed before the claim; or if this read is removed or moved off `tx`, since the read
  // is finalize's half of the cycle. Finalize at Read Committed still refuses here, its reads
  // following the claim, but it stays Serializable for the period lock. The dangerous-direction
  // tests in `tests/invoice-fingerprint-race.test.ts` guard this, and its header records each
  // measurement.
  if (invoice.kind === "INVOICE") {
    // `invoice` was read after the invoice-row lock, so this is the committed stored value.
    if (invoice.shipmentFingerprint === null
      || invoice.shipmentFingerprint !== await currentShipmentFingerprint(tx, order.id)) {
      throw new HttpError(400,
        `The shipments for order #${order.orderNumber} have changed since this invoice was calculated — `
        + "Recalculate, review the lines, then finalize");
    }
  }
  // #63: an invoice with NO LINES has nothing to bill, and the `needsPrice` check below passes
  // VACUOUSLY over an empty set — so an emptied draft used to finalize into a $0 INVOICED order that
  // `listInvoiceCandidates` then excluded, leaving no way to bill the order at all. Owner ruling
  // 2026-08-17: the guard is on the EMPTY LINE SET, not on a zero total — a warranty or no-charge
  // rework legitimately goes out at $0, listing what was done — and it sits at FINALIZE rather than
  // on the save, so a draft may still be emptied while the operator rebuilds it.
  if (invoice.lines.length === 0) {
    throw new HttpError(400,
      "That invoice has no lines — add the work being billed, or discard it");
  }
  // Finalize is refused while any line still needs a price (§5.5). It reads the RESOLVED price
  // already snapshotted on the line (Task 9), so a break-only line does not block. No GL-account
  // check: spec §15 puts that on 5C's export, not here.
  /** A refused line's label: its part number and words, or the words alone on a line with none. */
  const labelOf = (l: { partNumber: string; description: string }) =>
    (l.partNumber === "" ? l.description : `${l.partNumber} — ${l.description}`);
  const offending = invoice.lines.find((l) => l.needsPrice);
  if (offending) {
    throw new HttpError(400,
      `Line ${offending.position} · ${labelOf(offending)} needs a price — price every line before finalizing`);
  }
  // #587 (ruling 587-13, Amendment 21): nor while a typed price stands in for every priced operation
  // on its order line with no step picked (`typedPriceStandingIn`, the line `invoiceWarnings` warns
  // of). The ruling's purpose is the GL gap: such a line has no step code to take an account from,
  // and a pick gives it its step's at Save lines. Only when it bills: a $0 line posts nothing, and a
  // $0 invoice is real paper (#63). Only on an INVOICE: a credit copies its source's paper as it
  // stands, pre-#587 lines included, and its lines offer no pick (ruling 587-12). After the
  // needs-price refusal, which names a line still to be priced before one still to be picked.
  // Recalculate is in the sentence because the operations a typed line stood in for bill on their
  // own lines only there.
  if (invoice.kind === "INVOICE") {
    const unpicked = invoice.lines.find((l) => typedPriceStandingIn(l) && !l.amount.isZero());
    if (unpicked) {
      throw new HttpError(400,
        `Line ${unpicked.position} · ${labelOf(unpicked)} is a typed price with no step picked — pick its step `
        + "in the description box, then Save lines and Recalculate before finalizing");
    }
    // #605: nor while Recalculate would add a priced step to it (`pricedStepNotOnInvoice`): a
    // finalize re-prices nothing, so a step priced since the invoice was last recalculated, or a
    // step a typed price stood in for before its step was picked, would otherwise go unbilled with
    // no word said. Read on this transaction, after the refusals above, each of which names a line
    // that is wrong as it stands. INVOICE-only: a credit cannot be recalculated (2026-11-02).
    const { ordered } = await recalculationPlan(tx, deps, invoice, order);
    const missing = pricedStepNotOnInvoice(invoice.lines, ordered);
    if (missing) {
      throw new HttpError(400,
        `${missing.position === null ? "" : `Line ${missing.position} · `}${missing.partNumber} has priced steps `
        + "not on this invoice — Recalculate before finalizing");
    }
  }
  // §4.1 / ruling 8: an invoice is RECOGNIZED in the month it is FINALIZED (`finalizedAt` ≈ now),
  // not its document `invoiceDate`. So the period lock guards the FINALIZE date (today) — a
  // July-dated invoice finalized today in August lands in August and must be allowed even if July is
  // closed; conversely it is refused when TODAY's month is closed. The clock is sampled EXACTLY ONCE
  // (`now`, below) and reused for both the guard's date-only month (`dateOnly(now)`) and the
  // `finalizedAt: now` stamp on the write — two independent `new Date()` reads could straddle a UTC
  // month boundary (the guard seeing month M open while the stamp lands in M+1), which would
  // reintroduce the closed-month leak this guard exists to close. Read UNDER the invoice-row claim
  // `claimInvoiceRow` holds and BEFORE the status write, so the period read and that write commit
  // against one consistent state; the advisory lock inside serializes this against a concurrent
  // close of the finalize month (period-locks.ts).
  const now = new Date();
  await assertPeriodOpen(tx, dateOnly(now));

  // Finalize FREEZES the current lines (§5.3): it re-prices nothing, so the number cannot move at the
  // moment of locking. It stamps the finalizer from the actor context (null for a system caller).
  const actor = currentActor();
  // Task 3/§4.3: a finalized INVOICE's `dueDate` = its `invoiceDate` + the customer's
  // `terms.netDays` — a calendar-day add (`addDays`, no weekend skip: a due date is a calendar
  // date). `Terms.netDays` is `Int @default(30)` — never null — so the null case here is a
  // customer with NO terms assigned at all (`Customer.termsId` null -> `invoice.customer.terms`
  // null), not a null `netDays`. A CREDIT never gets a due date (Task 6 owner ruling: it ages from
  // its own `invoiceDate` instead), so the write below is INVOICE-only.
  const netDays = invoice.customer.terms?.netDays ?? null;
  const dueDate = netDays === null ? null : addDays(invoice.invoiceDate, netDays);
  // #79: freeze the early-pay pair alongside `dueDate`, and for the same reason. `termsName` has
  // always snapshotted the LABEL, but the discount kept reading the customer's CURRENT terms — so
  // reassigning a customer rewrote what invoices already in their hands were worth, in both
  // directions. An invoice is frozen paper (§5.4), so it carries its own numbers from here.
  // INVOICE-only, exactly like `dueDate`: a CREDIT offers no early-pay discount.
  //
  // The LABEL is re-stamped from those same terms (review round 2). `termsName` is written at CREATE
  // and is editable on a draft, while `dueDate` and the pair are derived at FINALIZE — so the paper
  // could say "2/10 Net 30" over a null pair, promising a discount `applyPayment` would refuse, or
  // say "Net 30" while quietly granting one. Finalize is the moment the paper is issued, so the
  // label and the money are stamped from ONE source there.
  //
  // ALWAYS, including blank when the customer has no terms (reversed in review round 3). Round 2
  // kept the label in the no-terms case to protect operator-typed text, and that exception produced
  // the exact bug it was added to prevent: a draft created under `2/10 Net 30` whose customer's
  // terms are then cleared kept the INHERITED label over a null pair — paper promising a discount
  // `applyPayment` refuses. Nothing in the stored state distinguishes an inherited label from a
  // typed one, so a conditional could only ever guess; the label follows the terms, full stop.
  //
  // The cost, stated rather than hidden: a hand-typed label on an invoice for a customer with no
  // terms record is cleared at finalize. Assigning terms to the customer is the fix that also makes
  // every future invoice right. Restoring the typed label would need real state — an
  // `Invoice.termsId`, or a "was edited" flag set by `updateInvoice` — which is a schema change for
  // a case this shop may never hit; MR !135's thread has it if it ever does.
  const issuedTerms = invoice.customer.terms ?? null;
  const issuedDiscount = {
    termsDiscountPercent: issuedTerms?.discountPercent ?? null,
    termsDiscountDays: issuedTerms?.discountDays ?? null,
    termsName: issuedTerms?.name ?? "",
  };
  await auditedUpdate("invoice", id,
    () => tx.invoice.update({
      where: { id },
      data: {
        status: "FINALIZED", finalizedAt: now, finalizedById: actor.id,
        ...(invoice.kind === "INVOICE" ? { dueDate, ...issuedDiscount } : {}),
      },
    }), { tx });
  // Only an INVOICE owns the order's status (§5.2): finalizing one writes INVOICED. A CREDIT is a
  // correction against an already-invoiced order — it owns no order status, so finalizing it must
  // NOT touch `Order.status` (Task 14). Branch on kind, do not write the order for a CREDIT.
  if (invoice.kind === "INVOICE") {
    // The order's status flip is a header scalar (R5; R26, #711 step 5). The invoice's own
    // finalize write above keeps the full snapshot (ruling 26).
    await auditedUpdate("order", order.id,
      () => tx.order.update({ where: { id: order.id }, data: { status: "INVOICED" } }), { tx, snapshot: "header" });
  }
  return readInvoiceDetail(tx, id);
}

/**
 * Finalize a DRAFT invoice, locking it (§5.5). `tx` is optional: the discriminating concurrency test
 * passes a manually-opened transaction so the row lock, not SSI, is what serializes a competing
 * caller (the `createInvoice` shape). The public no-`tx` path runs Serializable, pairing with the
 * claim exactly as every other invoice mutator does.
 */
export async function finalizeInvoice(id: string, tx?: Prisma.TransactionClient): Promise<InvoiceDetail> {
  // #605: the plant-wide pricing reads, OUTSIDE the transaction, as Recalculate takes them.
  const deps = await loadInvoiceDeps();
  if (tx) return finalizeInvoiceInTx(tx, id, deps);
  return withDbErrors({ entity: "Invoice" }, () => prisma.$transaction(
    (fresh) => finalizeInvoiceInTx(fresh, id, deps),
    // STANDING INVARIANT: stays Serializable. The period lock (`period-locks.ts`) breaks silently
    // without it, and the stale-draft guard (the shipment fingerprint in `finalizeInvoiceInTx`) is
    // proven with this side Serializable and fails with it at Repeatable Read.
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  ));
}

/**
 * Unlock a FINALIZED invoice back to DRAFT (§5.5), re-permitting every draft edit. The reason is
 * required and trimmed IN THE SERVICE (§5.17 — the `voidShipper`/`discardInvoice` precedent) and
 * recorded on the audit entry, never a column and never printed. Stays available after the invoice
 * has printed.
 *
 * Order matters: clear the invoice's finalized state FIRST, then hand the order back to the ledger.
 * The order sits at INVOICED — an invoice-owned state `recomputeOrderStatus` skips — so it is passed
 * in the `released` set, which lifts the skip for THIS order alone (a shipment-side recompute still
 * leaves INVOICED alone) and lets recompute settle it on its ship-derived value. Recomputing before
 * clearing would leave the order INVOICED forever.
 */
async function unlockInvoiceInTx(tx: Db, id: string, why: string): Promise<InvoiceDetail> {
  const { invoice, order } = await claimInvoiceRow(tx, id);
  if (invoice.status !== "FINALIZED") {
    throw new HttpError(400, "That invoice is not finalized — there is nothing to unlock");
  }
  // Task 9 (§5.3): a finalized invoice with live A/R activity — a payment/discount/write-off applied
  // to it, or a credit applied against it — cannot be unlocked. Unlocking would re-open editable
  // paper that money has already been applied to; the correction is to void the application first.
  // Read under the claim `claimInvoiceRow` holds: `applyPayment`/`applyCredit` write these rows under
  // the SAME order claim, so this read and the status write it guards see one consistent state.
  if (await hasReceivableActivity(tx, id)) {
    // Names all three kinds since #77: a standalone bad-debt write-off carries no payment, so
    // "void the payments" sent the operator to the receipt batches after a row that is not there.
    // And since #157 the tail is conditional: THIS is the refusal where the closed-period hazard is
    // reachable — unlock guards the invoice's `finalizedAt` while an application is dated at its own
    // event, so a July-finalized invoice with an August payment or write-off gets past the guard
    // below and is sent to a void that refuses it because August is closed. #173 widened that from
    // write-offs to every kind: cash is the commoner blocker, and it said nothing about cash.
    throw new HttpError(400,
      `Invoice #${order.orderNumber} has payments, credits or write-offs applied — `
      + `void them before unlocking${await applicationVoidHint(tx, id)}`);
  }
  // §4.1 / ruling 8: unlocking reverses the SALES-journal paper that finalize posted, removing the
  // invoice from its FINALIZE month's figures — so the lock must guard `finalizedAt`, NOT
  // `invoiceDate`. Guarding on `invoiceDate` would let unlocking a July-dated / August-finalized
  // invoice silently change August's frozen close while only checking July was open (the Task-5
  // closed-month leak class). A FINALIZED invoice always carries `finalizedAt` (stamped at finalize),
  // so it is non-null here. Under the claim, before the status write (period-locks.ts).
  await assertPeriodOpen(tx, invoice.finalizedAt!);
  await auditedUpdate("invoice", id,
    () => tx.invoice.update({
      where: { id },
      data: { status: "DRAFT", finalizedAt: null, finalizedById: null },
    }), { tx, reason: why });
  // #59: branch on `kind` exactly as `finalizeInvoiceInTx` does. Only an INVOICE owns the order's
  // status (§5.2), so only an INVOICE hands it back. Unlocking a CREDIT used to pass the order in
  // the `released` set too, lifting `recomputeOrderStatus`'s INVOICE_OWNED skip and settling the
  // order on its ship-derived status — while the source invoice was still FINALIZED and still owned
  // INVOICED. An invoiced order silently fell back to SHIPPED via finalize-credit → unlock-credit.
  if (invoice.kind === "INVOICE") {
    await recomputeOrderStatus(tx, [order.id], [order.id]);
  }
  return readInvoiceDetail(tx, id);
}

export async function unlockInvoice(id: string, reason: string, tx?: Prisma.TransactionClient): Promise<InvoiceDetail> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to unlock an invoice");
  // `tx` optional — the discriminating concurrency test passes a manually-opened (Read Committed)
  // transaction so the order+invoice-row claim, not SSI, is what serializes a competing application
  // (the `finalizeInvoice` shape). The public no-`tx` path runs Serializable, pairing with the claim.
  if (tx) return unlockInvoiceInTx(tx, id, why);
  return withDbErrors({ entity: "Invoice" }, () => prisma.$transaction(
    (fresh) => unlockInvoiceInTx(fresh, id, why),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

// -------------------------------------------------------------------------------------------
// Task 14 (§5.5/§5.6): credits. A credit is the correction for an already-FINALIZED invoice — it
// derives from a live FINALIZED INVOICE, copies its header and every line with the MONEY sign
// flipped (quantities and weights stay as billed — the paper says what was billed, the money says
// which way it flows), and carries its own `credit_number_next`, NOT an invoice number. It is a
// DRAFT document with its own draft->finalized lifecycle (Task 12's edits, Task 13's finalize),
// and finalizing it writes no order status (the `kind` branch in `finalizeInvoiceInTx`).
// -------------------------------------------------------------------------------------------

/** Money negates, quantity does not. `-0` reads back from Postgres as `+0`, so normalize a zero
 *  line (a PART line always carries `amount = 0`) to `+0` rather than storing `-0`. A Decimal(12,2)
 *  value round-trips through `toNumber()` exactly (its max, 9999999999.99, is well under 2^53), so
 *  negating the number keeps the column's scale on write. */
const negateMoney = (d: Prisma.Decimal) => {
  const n = d.toNumber();
  return n === 0 ? 0 : -n;
};

/**
 * `createCredit` (§5.6). Derives a DRAFT credit from a live FINALIZED INVOICE under the same claim
 * discipline every mutator here uses: `claimInvoiceRow` claims the order row, then locks the SOURCE
 * invoice row `FOR UPDATE`, then re-reads — so the refusals below read the source's status off a row
 * this transaction holds, not a stale snapshot. A credit and its source invoice coexist live: the
 * one-live-invoice-per-order partial index is scoped to `kind = 'INVOICE'`, and a credit is a
 * different kind, so an invoice may be credited more than once.
 *
 * Serializable, pairing with `assertLineRefs`' `assertRefExists` on every FK the copied lines carry
 * (the file's FK-writer pattern) — a GL account / step code / surcharge the source pointed at could
 * have been soft-deleted since it finalized, and fresh paper must not post to a dead account.
 */
export async function createCredit(invoiceId: string): Promise<InvoiceDetail> {
  // `retryAllocation` (#115): `credit_number_next` is claimed under this Serializable transaction, so
  // a concurrent allocation ANYWHERE (another credit, an order save, a shipment) aborted this with
  // 40001 and nothing retried. Safe to re-run whole — the claim/status refusals below re-read under a
  // fresh claim, and `HttpError` refusals are not retryable so a genuine "already credited" or
  // "not finalized" still answers on the first attempt. The period guard is a transaction-scoped
  // advisory lock, released on abort and re-taken by the retry.
  return withDbErrors({ entity: "Invoice" }, () => retryAllocation(() => prisma.$transaction(async (tx) => {
    // Claim the order, lock and re-read the SOURCE invoice — the guarded state (its status/kind)
    // must be read under the claim. `claimInvoiceRow` 404s a discarded source (deletedAt) already.
    const { invoice: source, order } = await claimInvoiceRow(tx, invoiceId);
    if (order.deletedAt !== null) throw new HttpError(400, `Order #${order.orderNumber} has been voided`);
    // A credit derives ONLY from an INVOICE — a credit cannot itself be credited.
    if (source.kind !== "INVOICE") {
      throw new HttpError(400, "That document is a credit, not an invoice — a credit cannot itself be credited");
    }
    // ...and only from a FINALIZED one: a draft is not customer-facing paper, so there is nothing to
    // correct yet (discard or edit it instead).
    if (source.status !== "FINALIZED") {
      throw new HttpError(400,
        `Invoice #${order.orderNumber} is not finalized — only a finalized invoice can be credited`);
    }

    // A credit's number comes from its own series, allocated INSIDE the claim (never hand-rolled).
    const creditNumber = await allocateNumber("credit_number_next", tx);

    // Task 3/§4.3: a credit takes its OWN raise date — never the source invoice's `invoiceDate` —
    // so it ages from its own date (Task 6 owner ruling), not the invoice it corrects. `createCredit`
    // has no `deps` object (unlike `createInvoiceInTx`'s `deps.today`), so `todayDateOnly()` is
    // called directly at this service boundary — once, and reused below in both the create data and
    // the audit `after` snapshot, so the two can never disagree even across a UTC-midnight boundary
    // mid-transaction.
    const creditDate = todayDateOnly();
    // §4.1 / ruling 8: this creates a DRAFT credit — it posts nothing and touches no A/R until it is
    // FINALIZED through the same `finalizeInvoiceInTx` path, whose own period lock (guarding the
    // finalize date) is the real recognition guard. This create-time guard on `creditDate` (= today)
    // is the consistent current-month guard finalize also uses: it simply refuses raising a credit
    // dated into a CLOSED current month (reopen it first). Under the order claim `claimInvoiceRow`
    // holds, before the audited create; the advisory lock serializes it against a concurrent close of
    // `creditDate`'s month (period-locks.ts).
    await assertPeriodOpen(tx, creditDate);

    // Copy every source line, money sign flipped, everything else (part identity, gl, qty, weight,
    // pricing snapshots) carried as billed. Source lines arrive position-asc (DETAIL_INCLUDE); the
    // copy keeps 1..n so the second-pass parent wiring maps cleanly.
    const lineData = source.lines.map((l, i) => ({
      position: i + 1, kind: l.kind,
      orderLineId: l.orderLineId, processStepCodeId: l.processStepCodeId,
      surchargeId: l.surchargeId, orderChargeId: l.orderChargeId, glAccountId: l.glAccountId,
      partNumber: l.partNumber, partName: l.partName, partDescription: l.partDescription,
      description: l.description, glAccountName: l.glAccountName,
      qty: l.qty, weight: num(l.weight), eachWeight: num(l.eachWeight),
      pricePer: l.pricePer, unitPrice: num(l.unitPrice),
      setupCharge: num(l.setupCharge), minimumCharge: num(l.minimumCharge),
      breakThreshold: num(l.breakThreshold), minimumApplied: l.minimumApplied,
      // The frozen source travels with the copy (§4.2): a credit against quote-priced paper still
      // names "Quote #N" — off its own column, exactly like the invoice it corrects.
      rate: num(l.rate), priceSource: l.priceSource, sourceQuoteNumber: l.sourceQuoteNumber,
      // #587: the mark travels with the rest of the line. It prints nowhere, and the hand-composed
      // audit entry below leaves it out, as it does every column but five.
      needsPrice: l.needsPrice, wordsChosen: l.wordsChosen,
      amount: negateMoney(l.amount),
    }));

    // The FK-writer guard, shared verbatim with create/replace/recalculate — no cert extra step
    // code here: a credit only copies the source's stored CERT line (its gl rides on the line), it
    // does not re-resolve the cert charge from BillingConfig.
    await assertLineRefs(tx, lineData);

    // Totals from the already-negated lines, so the header totals and the lines share one sign
    // (never a hand-negated total that could drift from the line it sums). Integer-cent summation.
    const totals = totalsFromLines(lineData);

    // The `after` snapshot, hand-composed like createInvoiceInTx's — the negated line amounts and
    // total are included so the sign flip shows in history from the create entry on.
    const auditData = {
      kind: "CREDIT", status: "DRAFT",
      orderId: source.orderId, orderNumber: order.orderNumber,
      sourceInvoiceId: source.id, creditNumber,
      customerId: source.customerId, customerCode: source.customer.code, customerName: source.customer.name,
      invoiceDate: formatDateOnly(creditDate),
      poNumber: source.poNumber, termsName: source.termsName,
      materialName: source.materialName, processNames: source.processNames,
      taxRate: num(source.taxRate),
      subtotal: totals.subtotal, surchargeTotal: totals.surchargeTotal, chargeTotal: totals.chargeTotal,
      certTotal: totals.certTotal, freightTotal: totals.freightTotal, taxTotal: totals.taxTotal,
      total: totals.total,
      lines: lineData.map((l) => ({
        position: l.position, kind: l.kind, description: l.description,
        glAccountName: l.glAccountName, amount: l.amount,
      })),
    };

    const credit = await auditedCreate("invoice", auditData, async () => {
      const created = await tx.invoice.create({
        data: {
          kind: "CREDIT",
          orderId: source.orderId,
          customerId: source.customerId,
          sourceInvoiceId: source.id,
          creditNumber,
          status: "DRAFT",
          invoiceDate: creditDate,
          poNumber: source.poNumber, termsName: source.termsName,
          billTo: source.billTo, shipTo: source.shipTo,
          materialName: source.materialName, processNames: source.processNames,
          taxRate: source.taxRate,
          ...totals,
        },
        select: { id: true },
      });
      // The OPERATION -> PART self-relation, keyed off the SOURCE rows' own ids, in the same INSERT
      // as the lines (#624).
      const identities = lineIdentities(source.lines.map((l) => ({ key: l.id, parentKey: l.parentLineId })));
      await tx.invoiceLine.createMany({
        data: lineData.map((l, i) => ({ ...l, invoiceId: created.id, ...identities[i] })),
      });
      return created;
    }, { tx });

    return readInvoiceDetail(tx, credit.id);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })));
}

// -------------------------------------------------------------------------------------------
// Task 19 (P5A §10): the invoice/credit PRINT — the four-print bracket every document in this
// codebase uses (traveler/ticket/BOL/cert), applied to an invoice: settings read OUTSIDE the
// transaction, then one Serializable transaction bracketing claim → re-read → assertPrintable →
// read-on-tx → render → archive. Reprints reissue the STORED bytes (getDocument), never re-render.
//
// The claim is the load-bearing part (task-19-brief.md's binding requirement, folded in from Task
// 12's review): `discardInvoice` refuses to discard a PRINTED invoice by reading `storedDocument`
// under ITS invoice-row claim, and that invariant lives on the StoredDocument rows, not on the
// Invoice row — so print and discard serialize ONLY if print takes the SAME claim first. Print
// claims the order row then the invoice row (`claimInvoiceForPrint`) BEFORE it inserts the
// StoredDocument; without it a discard and a first print interleave into a discarded invoice with
// an archived PDF that reprints forever (the Phase 4 print-vs-void lesson). Serializable alone is
// NOT the guarantee — the row lock is (the concurrency test, RED with the claim removed).
// -------------------------------------------------------------------------------------------

export type InvoicePrintSettings = {
  company: { name: string; address: string; phone: string };
  remitTo: { name: string; lines: string[] };
};

/** The plant-wide company block, read BEFORE the print transaction opens (the cert/ticket
 *  precedent — a settings read on the top-level client inside a Serializable transaction is the
 *  pool-starvation shape fix-wave R4 finding 8 exists to prevent). `remitTo` is the plant's own
 *  remit address (spec §10's Remit To box); the system carries no separate remit-to setting, so it
 *  is the company itself — the name over the company address split into lines. */
export async function invoicePrintSettings(): Promise<InvoicePrintSettings> {
  const [name, address, phone] = await Promise.all([
    getSetting("company_name"), getSetting("company_address"), getSetting("company_phone"),
  ]);
  return {
    company: { name, address, phone },
    remitTo: { name, lines: address.split("\n").map((l) => l.trim()).filter((l) => l !== "") },
  };
}

const splitAddress = (block: string): string[] => block.split("\n").filter((l) => l !== "");

/** The invoice's whole print payload, off its FROZEN detail (spec §10; invoices.ts's snapshot rule):
 *  the parts from the PART lines, the PRICE grid from the OPERATION lines, and one named total per
 *  surcharge/charge/cert/freight/tax line. Each price row carries `partIndex` (#589): the index in
 *  `parts` of the PART line its saved `parentLineId` names, looked up one level in the PART lines
 *  alone, so a parent that is null, off this invoice or not a PART line reads null; never the
 *  nearest part above it by position, nor its order line's part. `billTo`/`shipTo` are the snapshot
 *  strings split into lines — never a live address re-read, because an invoice is frozen paper.
 *  `settings` is optional so the concurrency and credit tests can call this without threading the
 *  company block through. */
export async function readInvoicePdfData(
  db: Db, invoiceId: string, settings?: InvoicePrintSettings,
): Promise<InvoicePdfData> {
  const detail = await readInvoiceDetail(db, invoiceId);
  return invoicePdfDataFromDetail(detail, settings ?? await invoicePrintSettings());
}

/** `readInvoicePdfData`'s assembly half, pure: the builder's input from a detail the caller already
 *  holds. The print calls it with the detail of the row it claimed (#627), so the paper comes from
 *  the claim's own read and no second read of the include runs under the claim. */
export function invoicePdfDataFromDetail(detail: InvoiceDetail, s: InvoicePrintSettings): InvoicePdfData {
  const linesOf = (kind: InvoiceLineKindValue) => detail.lines.filter((l) => l.kind === kind);
  const amountRows = (kind: InvoiceLineKindValue): InvoiceAmountRow[] =>
    linesOf(kind).map((l) => ({ description: l.description, amount: l.amount }));
  // At most one CERT/FREIGHT/TAX line exists (the engine pushes one of each), so take the first —
  // null when absent, so the totals block renders exactly the rows the invoice actually carries.
  const oneRow = (kind: InvoiceLineKindValue): InvoiceAmountRow | null => {
    const [row] = linesOf(kind);
    return row ? { description: row.description, amount: row.amount } : null;
  };
  // One list feeds both `parts` and the lookup, so an index always counts in the PARTS list's order.
  // The map holds PART lines only: a parent that is an operation, a charge or the line itself
  // misses it and reads null, like a parent the invoice does not hold.
  const partLines = linesOf("PART");
  const partIndexById = new Map(partLines.map((l, i) => [l.id, i]));

  return {
    company: s.company,
    remitTo: s.remitTo,
    billTo: splitAddress(detail.billTo),
    shipTo: splitAddress(detail.shipTo),
    title: detail.kind === "CREDIT" ? "Credit" : "Invoice",
    documentNumber: detail.documentNumber,
    invoiceDate: detail.invoiceDate,
    termsName: detail.termsName,
    orderNumber: detail.orderNumber,
    poNumber: detail.poNumber,
    materialName: detail.materialName,
    processNames: detail.processNames,
    parts: partLines.map((l) => ({
      qty: l.qty, partNumber: l.partNumber, partName: l.partName, partDescription: l.partDescription,
      eachWeight: l.eachWeight, totalWeight: l.weight,
    })),
    priceRows: linesOf("OPERATION").map((l) => ({
      description: l.description,
      pricePerLabel: l.pricePer ? PRICE_PER_LABELS[l.pricePer] : "",
      unitPrice: l.unitPrice, minimumCharge: l.minimumCharge, setupCharge: l.setupCharge,
      // §5.3: a quote-priced operation names its source on the paper — off the line's own FROZEN
      // column (never a live join; the quote may be long deleted). Non-QUOTE lines pass null and
      // print exactly as the approved 5A sample.
      sourceQuoteNumber: l.priceSource === "QUOTE" ? l.sourceQuoteNumber : null,
      amount: l.amount,
      // #589: the part this price is tied to, by its saved parent, one level.
      partIndex: l.parentLineId === null ? null : (partIndexById.get(l.parentLineId) ?? null),
    })),
    subtotal: detail.subtotal,
    surchargeRows: amountRows("SURCHARGE"),
    chargeRows: amountRows("CHARGE"),
    certRow: oneRow("CERT"),
    freightRow: oneRow("FREIGHT"),
    taxRow: oneRow("TAX"),
    total: detail.total,
  };
}

/**
 * The PRINT claim: `claimInvoiceRow`'s discipline (Order row, then the Invoice row `FOR UPDATE`, one
 * fixed order — order-locks.ts house rule), but it does NOT 404 a discarded invoice. It returns the
 * row with its `deletedAt` intact so `printInvoice` can refuse a NEW print with the shared
 * VOIDED_PRINT 400 (`assertPrintable`) while every STORED print stays reprintable forever (§5.6).
 * This is the claim print and discard must SHARE for the two to serialize.
 */
async function claimInvoiceForPrint(tx: Db, id: string): Promise<{ invoice: DetailRow; order: Order }> {
  const stub = await tx.invoice.findFirst({ where: { id }, select: { orderId: true } });
  if (!stub) throw new HttpError(404, "Invoice not found");
  const order = await claimOrder(tx, stub.orderId);
  if (!order) throw new HttpError(404, "Invoice not found");
  await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${id} FOR UPDATE`;
  const invoice = await tx.invoice.findFirst({ where: { id }, include: DETAIL_INCLUDE });
  if (!invoice) throw new HttpError(404, "Invoice not found");
  return { invoice, order };
}

async function printInvoiceInTx(
  tx: Db, id: string, settings: InvoicePrintSettings, mode: "single" | "selected" = "single",
): Promise<{ documentId: string; documentNumber: string; pdf: Buffer; filing: CustomerFiling | null }> {
  const { invoice, order } = await claimInvoiceForPrint(tx, id);
  // Read under the claim just taken (its whole point): a voided ORDER produces no new paper of any
  // kind (§5.6), and a discarded invoice refuses a NEW print while its stored prints remain
  // reprintable. Both refuse with the shared VOIDED_PRINT 400.
  assertPrintable(order);
  assertPrintable(invoice);
  // The number prefix, once, on `tx` (`getSetting`'s `db`): the selected refusal below names the
  // row with it, and the paper's own number is built from it further down (#627: it was read a
  // second time there, through `readInvoiceDetail`).
  const prefix = await getSetting("invoice_number_prefix", tx);
  // #591, the selected print only: a row that is not finalized, or has printed since it was
  // finalized, refuses with a 400 in the owner's sentence. The newest print is read on `tx`, under
  // the claim and after the voided refusal. The order claim serializes two prints, but in
  // `printSelectedInvoice`'s own transaction this read's snapshot was fixed at the stub read
  // before the claim, so its Serializable isolation is what keeps two selected prints of one row
  // from both filing.
  if (mode === "selected") {
    const newest = await tx.storedDocument.findFirst({
      where: { invoiceId: id }, orderBy: { createdAt: "desc" }, select: { createdAt: true },
    });
    const refusal = selectedPrintRefusal({
      kind: invoice.kind, status: invoice.status,
      documentNumber: invoiceDocumentNumber(invoice.kind, invoice.creditNumber, invoice.order.orderNumber, prefix),
      printedAt: printedSince(invoice.finalizedAt, newest?.createdAt ?? null),
    });
    if (refusal !== null) throw new HttpError(400, refusal);
  }

  // §5.2 resolution on THIS claimed transaction at its isolation — correct by §5.1 immutability,
  // not by locking (the printCert/printBol precedent); no template row is claimed and none is
  // needed. BOTH an invoice AND a credit resolve the INVOICE docType (spec §4.1: one contract
  // covers credits — the title/signs are data), on the invoice row's OWN frozen customer id.
  const resolved = await resolveTemplateForPrint(tx, "INVOICE", invoice.customerId);
  // Logo bytes → data URI by the STORED mime type (spec §6.3), only when the config places a logo, a
  // flow's header logo or a canvas Logo item (`templatePlacesLogo`, the rule the canvas-capable print
  // paths share: traveler, tickets, bill of lading, certification, invoice, statement, quote), so an
  // unplaced upload converts nothing.
  const logoDataUri = resolved.logoImage !== null && templatePlacesLogo(resolved.config)
    ? (resolved.logoMimeType === "image/jpeg"
        ? jpegDataUri(Buffer.from(resolved.logoImage))
        : pngDataUri(Buffer.from(resolved.logoImage)))
    : undefined;

  // The paper comes from the row the claim read (#627), not a second read of the same include:
  // nothing between `claimInvoiceForPrint` and this render writes the invoice (the template
  // resolution, the StoredDocument read and the setting read are reads), so the claimed row IS
  // the row a re-read would return. A write placed between them (a print counter, say) would
  // make this row stale; put it after the render, or read again.
  const data = invoicePdfDataFromDetail(toInvoiceDetail(invoice, prefix), settings);
  const pdf = await renderPdf(buildInvoiceDefinition(data, resolved.config, logoDataUri));

  // #588: what the print route files in the customer's folder after commit (`fileCustomerCopy`),
  // only for a FINALIZED row, its status read under the claim above; a draft files nothing. An
  // invoice is filed by its order's number, a credit by its own, which is allocated when the credit
  // is raised: a credit without one (unreachable) files nothing. The ticket is taken here, under the
  // claim: every print that can share a file (one order's invoice, or one credit, whose order is its
  // invoice's) claims that same Order row, so prints of one file take their tickets in commit order
  // (the plan's "Print order"). Any point under the claim orders them the same: this one, after the
  // render, is no tighter than another.
  const number = invoice.kind === "CREDIT" ? invoice.creditNumber : invoice.order.orderNumber;
  const filing: CustomerFiling | null = invoice.status === "FINALIZED" && number !== null
    ? { kind: invoice.kind, number, folder: invoice.customer.invoiceFolder, ticket: nextFilingTicket() }
    : null;

  // The kind follows the invoice ROW's own kind — a credit archives as CREDIT, an invoice as
  // INVOICE, both owning `invoiceId` alone (the kind→owner CHECK). This insert is the ONE mutation
  // here, through the sanctioned `storeDocument` path, on `tx`, UNDER the claim above — so the
  // archive cannot commit against a state (a concurrent discard) that changed out from under it.
  // `resolved.versionId` is the §5.2 stamp: exactly which template version produced the paper.
  const doc = await storeDocument(
    tx, { kind: invoice.kind === "CREDIT" ? "CREDIT" : "INVOICE", invoiceId: id }, pdf, resolved.versionId);
  return { documentId: doc.id, documentNumber: data.documentNumber, pdf, filing };
}

/**
 * Render, archive and return the invoice/credit PDF (spec §10, §5.6's print/reprint contract). A
 * voided order or discarded invoice refuses a NEW print; a reprint of a STORED document is the
 * download route's job (`getDocument`), not this function's, and stays available forever.
 *
 * `tx` is optional: the discriminating concurrency test passes a manually-opened transaction so the
 * row lock — not SSI — is what serializes a competing discard (the `createInvoice`/`finalizeInvoice`
 * precedent). The public no-`tx` path runs Serializable, pairing the claim with the archive insert.
 */
export async function printInvoice(
  invoiceId: string, tx?: Prisma.TransactionClient,
): Promise<{ documentId: string; documentNumber: string; pdf: Buffer; filing: CustomerFiling | null }> {
  const settings = await invoicePrintSettings(); // OUTSIDE the transaction (the cert/ticket precedent)
  if (tx) return printInvoiceInTx(tx, invoiceId, settings);
  return withDbErrors({ entity: "Invoice" }, () => prisma.$transaction(
    (fresh) => printInvoiceInTx(fresh, invoiceId, settings),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  ));
}

/**
 * The Invoicing list's Print selected (#591): `printInvoice`, except that it refuses, with a 400 in
 * the owner's sentence (`selectedPrintRefusal`), a row that is not finalized and one that has
 * printed since it was finalized (owner rulings 591-1 and 591-2; "Refuse both", 2026-10-20). The
 * single Print stays `printInvoice`, which prints a draft.
 *
 * The check reads StoredDocument rows, which no lock covers, from a snapshot fixed at
 * `claimInvoiceForPrint`'s stub read, before the claims, and a print writes neither the Order nor
 * the Invoice row. So two selected prints of one invoice serialize on the order claim and the
 * second wakes on its old snapshot, reads no print and prints; SSI aborts it, since each read the
 * invoice's document predicate and inserted into it. `retryOnSerializationConflict` re-runs it on a
 * fresh snapshot, where it answers the already-printed sentence. It re-runs every other
 * serialization abort the same way: a selected print parked behind a finalize, unlock or discard
 * wakes on a row that one changed and aborts with 40001 at the raw `FOR UPDATE` (measured for
 * finalize, after which the retry prints, and discard, after which it answers the voided refusal),
 * and SSI's predicate locks, taken per index page, can set two prints of different invoices
 * against each other. Inside `withDbErrors`, outside `$transaction`, so each attempt gets its own
 * snapshot.
 *
 * STANDING INVARIANT: this rests on Serializable. At Repeatable Read the second print of one
 * invoice reads no print and files a second copy silently (the DANGEROUS-DIRECTION case in
 * tests/invoice-pdf.test.ts). With `tx` it runs on the caller's transaction and never retries: a
 * caller's aborted transaction cannot be re-run from inside it.
 */
export async function printSelectedInvoice(
  invoiceId: string, tx?: Prisma.TransactionClient,
): ReturnType<typeof printInvoice> {
  const settings = await invoicePrintSettings(); // OUTSIDE the transaction (the cert/ticket precedent)
  if (tx) return printInvoiceInTx(tx, invoiceId, settings, "selected");
  return withDbErrors({ entity: "Invoice" }, () => retryOnSerializationConflict(() => prisma.$transaction(
    (fresh) => printInvoiceInTx(fresh, invoiceId, settings, "selected"),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  )));
}
