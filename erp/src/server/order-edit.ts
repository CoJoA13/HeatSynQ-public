// #33 — the order EDIT + lifecycle services (Task 5, spec §5a/§5c/§5d), extracted VERBATIM from
// orders.ts (byte-parity verified). Every mutator shares the claimOrder + Serializable-transaction
// shape documented in the section header below; the §5.14 pairing note on addLine/updateLine points
// at order-internals.ts's resolveQuoteLinks. Shared schemas/helpers live in order-internals.ts.
import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedUpdate, auditedSoftDelete } from "./audit";
import { assertRefExists } from "./reference-guards";
import { decimalBoxField } from "./decimal-field";
import { LINE_NET_WEIGHT } from "@/lib/order-boxes";
import { getRevisionContentUnchecked, type RevisionDetail } from "./part-process-steps";
import { createCert } from "./certs";
import { seedLineIntoLiveCerts } from "./cert-results";
import { claimOrder, claimOrdersInOrder } from "./order-locks";
import {
  finalizedInvoiceFor, finalizedInvoiceIdFor, invoiceBlockMessage, hasReceivableActivityForOrder,
  applicationVoidHintForOrder,
} from "./invoice-guards";
import { judgeQuoteLine } from "./quote-links";
import { recomputeOrderStatus, shippedTotals } from "./ship-ledger";
// The `order-edit.ts -> shippers.ts` runtime edge (Task 10, spec §5.5): `shipmentBlockers` is a
// hoisted `export async function`, read only inside mutator bodies (updateLine/removeLine/voidOrder),
// never at module-evaluation time. ONE-DIRECTIONAL since #33 (2026-08-19): shippers.ts imports
// `isDuplicateClientRequestId` from db-errors.ts, not from here, so there is no return edge. Keep it
// that way — a shippers.ts -> orders-module import would re-open the cycle order-locks.ts's header
// records the hoisted-function-declarations-only rule for surviving.
import { shipmentBlockers } from "./shippers";
import { CERT_SCOPES } from "../lib/cert-constants";
import { INVOICE_FREEZE } from "../lib/invoice-freeze";
import { LINE_NOT_FOUND } from "../lib/line-removals";
import { trafficSettings } from "./order-board";
import {
  LINE, SERIAL_ITEM, CONTAINER_ITEM, CHARGE_ITEM, LINE_QTY,
  parseDate, lineLabel, shipmentBlockerTail, resolveLineParts, resolveQuoteLinks, createSerials,
  readDetail,
  type OrderDetail, type OrderRead,
} from "./order-internals";
/** The read behind `GET /api/orders/[id]`. `finalizedInvoiceId` lets the order hub grey Lines and
 *  Charges before the click (#472, owner ruling R-Q5 of 2026-10-08). It is read here, after the
 *  detail and outside any transaction, and not in `readDetail`, which runs at the tail of every
 *  mutator's Serializable transaction. So it is a display fact, as old as this read. It guards
 *  nothing: every mutator below still asks `finalizedInvoiceFor` on its own `tx`, under its claim.
 *  It costs one statement, on `Invoice`: `finalizedInvoiceIdFor` selects the id alone, where the
 *  guard's reader also loads the order number, with a second statement this read has no use for. */
export async function getOrder(id: string): Promise<OrderRead> {
  const detail = await readDetail(prisma, id, await trafficSettings());
  return { ...detail, finalizedInvoiceId: await finalizedInvoiceIdFor(prisma, id) };
}

// -------------------------------------------------------------------------------------------
// Edits, void, and linked orders (Task 5, spec §5a/§5c/§5d). Every mutator below shares one
// shape: `withDbErrors` wraps a Serializable `$transaction` (uniform with createOrder's own, even
// where nothing here assigns a registered FK — global-constraints: "the whole order save runs
// Serializable for uniformity"; ⚠️ but for `addLine`/`updateLine` — every writer of
// `OrderLine.quoteLineId` — Serializable is now LOAD-BEARING, not uniformity: the §5.14 quote-
// link pairing needs the isolation level AND the in-transaction eligibility read together, see
// createOrder's own doc comment) that resolves the order with `claimOrder` (fix-wave R3 finding 1)
// — 404 "Order not found" catches both an unknown id and a voided (`deletedAt !== null`) one,
// since a voided order is read-only (spec §5a/§5c) — then writes through `auditedUpdate("order",
// id, ...)` so history carries a real before/after diff on the order's own row. `SNAPSHOT_INCLUDE.
// order` (audit.ts) pulls every child collection, ordered, so no mutator here hand-builds a
// snapshot the way createOrder's `auditPayload` does for the create entry — the automatic one is
// enough; and `updateOrder`, which writes header scalars alone, asks for the children-free
// `SNAPSHOT_HEADER` pair instead (owner ruling R5, 2026-10-22; #617, #616), since a PO number blur
// cannot change a line and recorded every line, container, serial, load and charge twice for
// nothing. The line writers keep the full snapshot: their diff is on `lines`.
// -------------------------------------------------------------------------------------------

const UPDATE_ORDER = z.object({
  poNumber: z.string().max(200).optional(),
  vsOrderNumber: z.string().max(60).optional(),
  customerJobNo: z.string().max(60).optional(),
  receivedDate: z.string().optional(),
  requestDate: z.string().optional(),
  targetDate: z.string().nullable().optional(),
  notes: z.string().max(4000).optional(),
  // Overridable at entry and afterwards (spec §6.1) — resolveCertSettings only ever runs at
  // createOrder's own save. An edit here is a plain scalar patch like every other field in this
  // schema (still audited by auditedUpdate below), never a re-derivation of the part/customer
  // chain.
  certRequired: z.boolean().optional(),
  certScope: z.enum(CERT_SCOPES).optional(),
}).strict();

// qty/weight only — partId and revisionNumber have no key in this shape at all, so `.strict()`
// itself is the immutability guard (spec §5a: "Customer and lead part/revision are immutable").
const UPDATE_LINE = z.object({
  qty: LINE_QTY.optional(),
  weight: decimalBoxField(LINE_NET_WEIGHT.box, { required: true }).optional(),
  // The link's EDIT semantics (spec §5.2) differ from LINE's create semantics in exactly one
  // arm: an ABSENT key KEEPS the stored link — never re-resolves, never re-judges (ruling 6: a
  // qty edit must not silently move a line onto a newer quote). An explicit id is the operator's
  // re-pick, judged against the order's CURRENT received date (§5.2's re-pick rule); an explicit
  // null is the deliberate unlink ruling 6 names. Spec §5.2's "part swap clears + re-resolves"
  // is vacuous here BY CONSTRUCTION: this shape has no partId key (spec §5a), so the only part
  // swap is removeLine + addLine — and addLine auto-resolves the fresh line, which IS the
  // clear-and-re-resolve.
  quoteLineId: z.string().min(1).nullable().optional(),
}).strict();

// A saved order's Containers save names each row it keeps by its id (#493). The key is the replace
// schema's alone: `CONTAINER_ITEM` is shared with order creation, where a row has no id yet, and it
// stays strict there.
const REPLACE_CONTAINERS = z.array(CONTAINER_ITEM.extend({ id: z.string().min(1).optional() }).strict());
const REPLACE_SERIALS = z.array(SERIAL_ITEM).max(10_000);
const REPLACE_CHARGES = z.array(CHARGE_ITEM);

/** PATCH of poNumber/vsOrderNumber/dates/notes — nothing else (spec §5a: customer and the lead
 *  part/revision are immutable; a wrong-part order is voided and re-keyed, not patched). Fields
 *  are all `.optional()` rather than `.default()`, so an omitted key is a true no-op; `targetDate`
 *  is `.nullable()` too, so an explicit `null` clears it, distinct from omitting the key. */
export async function updateOrder(
  id: string, input: unknown,
): Promise<OrderDetail> {
  const data = UPDATE_ORDER.parse(input);
  const traffic = await trafficSettings();

  return withDbErrors({ entity: "Order" }, () => prisma.$transaction(async (tx) => {
    const target = await claimOrder(tx, id);
    if (!target || target.deletedAt !== null) throw new HttpError(404, "Order not found");

    const patch: Prisma.OrderUpdateInput = {
      ...(data.poNumber !== undefined ? { poNumber: data.poNumber } : {}),
      ...(data.vsOrderNumber !== undefined ? { vsOrderNumber: data.vsOrderNumber } : {}),
      ...(data.customerJobNo !== undefined ? { customerJobNo: data.customerJobNo } : {}),
      ...(data.receivedDate !== undefined ? { receivedDate: parseDate(data.receivedDate, "Received date") } : {}),
      ...(data.requestDate !== undefined ? { requestDate: parseDate(data.requestDate, "Request date") } : {}),
      ...(data.targetDate !== undefined
        ? { targetDate: data.targetDate === null ? null : parseDate(data.targetDate, "Target date") }
        : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
      ...(data.certRequired !== undefined ? { certRequired: data.certRequired } : {}),
      ...(data.certScope !== undefined ? { certScope: data.certScope } : {}),
    };

    // Header scalars only (`UPDATE_ORDER` is strict), so the children-free snapshot pair (R5).
    await auditedUpdate("order", id, () => tx.order.update({ where: { id }, data: patch }), { tx, snapshot: "header" });

    // The §6.2 creation-time behavior, following the §6.1 post-save override: an update that
    // lands the order on certRequired + ORDER scope owes the ORDER-scope cert `createOrder`
    // would have made (Phase 4 ruling 26). The hub's picker can raise one by hand at any scope
    // too (#165), and the hub reads its cert list again after this save (#693). Existence-checked
    // first (idempotent repeat updates; a live cert already there wins).
    if (data.certRequired !== undefined || data.certScope !== undefined) {
      const now = await tx.order.findFirstOrThrow({
        where: { id }, select: { certRequired: true, certScope: true },
      });
      if (now.certRequired && now.certScope === "ORDER") {
        const existing = await tx.cert.findFirst({
          where: { orderId: id, scope: "ORDER", deletedAt: null }, select: { id: true },
        });
        if (!existing) await createCert({ orderId: id, scope: "ORDER" }, tx);
      }
    }

    return readDetail(tx, id, traffic);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/** Adds one rider at position max+1 (spec §5a) — never the lead; a fresh order's own lead comes
 *  only from createOrder. Validated exactly like every line createOrder resolves (live, active,
 *  owned by the order's customer) via the same `resolveLineParts` helper. */
export async function addLine(
  orderId: string, input: unknown,
): Promise<OrderDetail> {
  const data = LINE.parse(input);
  const traffic = await trafficSettings();

  return withDbErrors({ entity: "Order" }, () => prisma.$transaction(async (tx) => {
    const order = await claimOrder(tx, orderId);
    if (!order || order.deletedAt !== null) throw new HttpError(404, "Order not found");

    // §5.7, owner ruling 2026-08-16 (#126): once a finalized invoice covers this order its billable
    // content is settled, and corrections go through unlock. Charges froze here from the start
    // (`replaceCharges` below) while LINES did not, so §5.7 meant two different things — and the
    // gap was a usability trap rather than a money bug: the invoice is frozen paper, so editing a
    // line changed nothing on it and the operator could not tell whether the edit had worked. Read
    // on `tx`, UNDER the claim taken immediately above, so the answer cannot go stale before the
    // write (the order-locks house rule; `finalizedInvoiceFor` is a dependency-free leaf).
    const invoiced = await finalizedInvoiceFor(tx, orderId);
    if (invoiced) throw new HttpError(400, invoiceBlockMessage(invoiced, INVOICE_FREEZE.addLine));

    const { _max } = await tx.orderLine.aggregate({ where: { orderId }, _max: { position: true } });
    const position = (_max.position ?? 0) + 1;
    const [part] = await resolveLineParts(tx, order.customerId, [data], position - 1);

    // The same three-way link semantics as createOrder (§5.2), judged against the ORDER's stored
    // received date (ruling 6 — link time is judged at the order's own date, however backdated).
    // On `tx`: the §5.14 SSI read (resolveQuoteLinks' ⚠️ comment).
    const [quoteLink] = await resolveQuoteLinks(
      tx, order.customerId, order.receivedDate, [data], [part], position - 1);

    await auditedUpdate("order", orderId, async () => {
      const line = await tx.orderLine.create({
        data: {
          orderId, position, partId: data.partId, revisionNumber: null, qty: data.qty, weight: data.weight,
          quoteLineId: quoteLink?.quoteLineId ?? null,
        },
      });
      await createSerials(tx, orderId, [line.id], [data], [part], position - 1);
      // Ruling 28 (#56): the rider's inspection requirements join every LIVE cert now, frozen —
      // requirements are otherwise seeded only at cert creation, and a cert listing a part with
      // none of its measurements is paper claiming coverage of something nobody measured.
      await seedLineIntoLiveCerts(tx, orderId, line.id);
    }, { tx });

    // A new rider changes the order's own LINE SET — spec §5.2: "every order line is complete"
    // now has one more line to satisfy, so a fully-shipped order returns to Partial Shipped the
    // moment a rider joins it.
    await recomputeOrderStatus(tx, [orderId]);

    return readDetail(tx, orderId, traffic);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/** qty/weight only (spec §5a) — works on any line, lead included, but `UPDATE_LINE`'s shape has
 *  no `partId`/`revisionNumber` key at all, so those stay immutable by construction. */
export async function updateLine(
  orderId: string, lineId: string, input: unknown,
): Promise<OrderDetail> {
  const data = UPDATE_LINE.parse(input);
  const traffic = await trafficSettings();

  return withDbErrors({ entity: "Order" }, () => prisma.$transaction(async (tx) => {
    const order = await claimOrder(tx, orderId);
    if (!order || order.deletedAt !== null) throw new HttpError(404, "Order not found");

    // §5.7 (#126) — the `addLine` guard's other half; see its comment for why lines freeze at all.
    // Placed BEFORE the line read so an invoiced order refuses identically whether or not the line
    // exists: the freeze is a property of the ORDER, and answering "that line does not exist" first
    // would make the refusal depend on which of two settled facts happened to be checked first.
    const invoiced = await finalizedInvoiceFor(tx, orderId);
    if (invoiced) throw new HttpError(400, invoiceBlockMessage(invoiced, INVOICE_FREEZE.changeLine));

    const line = await tx.orderLine.findFirst({
      where: { id: lineId, orderId },
      select: {
        id: true, position: true, partId: true,
        part: { select: { partNumber: true, customer: { select: { code: true } } } },
      },
    });
    if (!line) throw new HttpError(404, LINE_NOT_FOUND);

    // Spec §5.5: qty/weight may never drop below what is already shipped-to-date (ship-ledger.ts's
    // "used everywhere" derivation) — checked only when this edit actually touches the field in
    // question, so a weight-only edit never pays for a qty comparison it did not ask for.
    if (data.qty !== undefined || data.weight !== undefined) {
      const totals = (await shippedTotals(tx, [lineId])).get(lineId) ?? { qty: 0, weight: 0 };
      if (data.qty !== undefined && data.qty < totals.qty) {
        const blockers = await shipmentBlockers(tx, orderId, lineId);
        throw new HttpError(400,
          `${lineLabel(line.position - 1, line.part)}: cannot reduce qty below ${totals.qty} already shipped — ` +
          shipmentBlockerTail(blockers));
      }
      if (data.weight !== undefined && data.weight < totals.weight) {
        const blockers = await shipmentBlockers(tx, orderId, lineId);
        throw new HttpError(400,
          `${lineLabel(line.position - 1, line.part)}: cannot reduce net weight below ${totals.weight} lb already ` +
          `shipped — ${shipmentBlockerTail(blockers)}`);
      }
    }

    // UPDATE_LINE's own comment holds the semantics: absent = keep, null = unlink, id = re-pick
    // judged against the CURRENT received date. The judge read runs on `tx` (the §5.14 SSI read,
    // resolveQuoteLinks' ⚠️ comment — this is the third writer of `OrderLine.quoteLineId`).
    if (typeof data.quoteLineId === "string") {
      const verdict = await judgeQuoteLine(tx, data.quoteLineId,
        { customerId: order.customerId, partId: line.partId, receivedDate: order.receivedDate });
      if (!verdict.ok) {
        throw new HttpError(400, `${lineLabel(line.position - 1, line.part)}: ${verdict.reason}`);
      }
    }

    // Unchecked variant (scalar FK write) — the link column is set directly, like the create path.
    const patch: Prisma.OrderLineUncheckedUpdateInput = {
      ...(data.qty !== undefined ? { qty: data.qty } : {}),
      ...(data.weight !== undefined ? { weight: data.weight } : {}),
      ...(data.quoteLineId !== undefined ? { quoteLineId: data.quoteLineId } : {}),
    };

    // One line row and nothing else changes here, so the pair is the order and its lines alone
    // (`SNAPSHOT_LINES`, #616; owner ruling 2026-11-02), proved by tests/audit-header-sweep.test.ts.
    await auditedUpdate("order", orderId, () => tx.orderLine.update({ where: { id: lineId }, data: patch }), { tx, snapshot: "lines" });

    // Quantity decides completion (owner ruling 2026-10-06): lowering a line to what has shipped
    // completes it, and raising a complete line reopens it.
    await recomputeOrderStatus(tx, [orderId]);

    return readDetail(tx, orderId, traffic);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/** Position 1 (the lead) refuses outright — spec §5a: a wrong-part order is voided and re-keyed,
 *  never edited down to its lead. Any rider closes the position gap it leaves behind: per-row
 *  updates in ascending position order, each shift vacating the slot the next update needs,
 *  against `@@unique([orderId, position])`.
 *
 *  A removal changes the order's totals and leaves its loads as they were. Nothing here re-splits
 *  them. The answer is the bare order, as every mutator in this file but `voidOrder` answers, and
 *  the order page compares the lines with the loads from it.
 *
 *  Under a finalized invoice every removal is refused, the lead's included, with `updateLine`'s
 *  sentence, "A line cannot be changed" (owner ruling 2026-10-15, #486). It comes before the line
 *  is read, so it says nothing about whether the order holds the line. */
export async function removeLine(
  orderId: string, lineId: string,
): Promise<OrderDetail> {
  const traffic = await trafficSettings();

  return withDbErrors({ entity: "Order" }, () => prisma.$transaction(async (tx) => {
    const order = await claimOrder(tx, orderId);
    if (!order || order.deletedAt !== null) throw new HttpError(404, "Order not found");

    // §5.7 (#126, #486) — `updateLine`'s guard, in its place and with its clause: read on `tx`
    // under the claim and BEFORE the line read, so an invoiced order refuses identically whether or
    // not the line exists. It also comes before the lead and shipment refusals, for `voidOrder`'s
    // reason: the remedy each of those names (void the order, void the shipment) is itself refused
    // under the invoice, so only naming the invoice points at a fix that works. Unlike `voidOrder`,
    // it does not ask about A/R activity first: this sentence is the title the order hub gives a
    // rider's Remove under the invoice, and a different refusal ahead of it would part the two again.
    const invoiced = await finalizedInvoiceFor(tx, orderId);
    if (invoiced) throw new HttpError(400, invoiceBlockMessage(invoiced, INVOICE_FREEZE.changeLine));

    const line = await tx.orderLine.findFirst({
      where: { id: lineId, orderId },
      select: {
        id: true, position: true,
        part: { select: { partNumber: true, customer: { select: { code: true } } } },
      },
    });
    if (!line) throw new HttpError(404, LINE_NOT_FOUND);
    if (line.position === 1) {
      throw new HttpError(400, "The lead part cannot be removed — void the order instead");
    }

    // Spec §5.5: a part line with a live shipper line already describes a shipped fact — removing
    // it from every list would leave that shipment pointing at a line that has vanished.
    const blockers = await shipmentBlockers(tx, orderId, lineId);
    if (blockers.length > 0) {
      throw new HttpError(400,
        `${lineLabel(line.position - 1, line.part)}: cannot remove — shipped on ${shipmentBlockerTail(blockers)}`);
    }

    await auditedUpdate("order", orderId, async () => {
      // OrderSerial -> OrderLine is ON DELETE RESTRICT (migration.sql) — its rows have no meaning
      // once the line is gone, so they go first, in the same transaction.
      await tx.orderSerial.deleteMany({ where: { lineId } });
      await tx.orderLine.delete({ where: { id: lineId } });
      const rest = await tx.orderLine.findMany({
        where: { orderId, position: { gt: line.position } },
        orderBy: { position: "asc" },
      });
      for (const l of rest) {
        await tx.orderLine.update({ where: { id: l.id }, data: { position: l.position - 1 } });
      }
    }, { tx });

    // The line SET just shrank — spec §5.2: removing the one incomplete line among an otherwise
    // fully-shipped order can turn Partial Shipped into Shipped, exactly the mirror of addLine's
    // own comment above.
    await recomputeOrderStatus(tx, [orderId]);

    return readDetail(tx, orderId, traffic);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/** The owner's sentence for a Containers save that names a row the order does not hold (#493). */
const CONTAINERS_CHANGED = "The containers changed since this page loaded. Reload, then save again.";

/** Bulk PUT of the order's containers, saved in place (#493, owner answers 2026-10-15). A row sent
 *  with its `id` is that row: it is updated where it stands and keeps its id, so a shipment row
 *  linked to it stays linked. A row sent without one is new. A current row the body does not name
 *  is deleted, which releases its shipment rows to their snapshots (`ON DELETE SET NULL`). Position
 *  is the array order, 1..n. An id that is not one of this order's rows (another order's, an
 *  unknown one, one an earlier save removed) or that appears twice refuses the whole save with a
 *  409 before any write, in the owner's words (`CONTAINERS_CHANGED`).
 *
 *  When a kept row's Type or Cust Cont Id changes, the same save writes the copy its shipment rows
 *  keep (`ShipperContainer.typeName`, `customerContainerId`), so a row released later shows what it
 *  last was. Nothing else of a shipment row is touched: its count and tare each are the shipment's.
 *  Those rows need no claim of their own: every shipment save claims this same order row first.
 *
 *  One `assertRefExists("containerType", …)` per DISTINCT incoming typeId, on this transaction's own
 *  `tx` — the writer-side half of the reference-delete TOCTOU (reference-guards.ts's doc comment),
 *  the same registered-FK pattern createOrder itself already runs for `containers[].typeId`. */
export async function replaceContainers(orderId: string, input: unknown): Promise<OrderDetail> {
  const data = REPLACE_CONTAINERS.parse(input);
  const traffic = await trafficSettings();

  return withDbErrors({ entity: "Order" }, () => prisma.$transaction(async (tx) => {
    const order = await claimOrder(tx, orderId);
    if (!order || order.deletedAt !== null) throw new HttpError(404, "Order not found");

    // Read under the claim, so no other Containers save can change the set between here and the
    // writes below.
    const current = new Map((await tx.orderContainer.findMany({
      where: { orderId }, select: { id: true, typeId: true, customerContainerId: true },
    })).map((c) => [c.id, c]));
    const named = new Set<string>();
    for (const c of data) {
      if (c.id === undefined) continue;
      if (!current.has(c.id) || named.has(c.id)) throw new HttpError(409, CONTAINERS_CHANGED);
      named.add(c.id);
    }

    const typeIds = [...new Set(data.map((c) => c.typeId))];
    for (const typeId of typeIds) await assertRefExists("containerType", typeId, tx);

    const fields = (c: (typeof data)[number], i: number) => ({
      position: i + 1, typeId: c.typeId, count: c.count, pieces: c.pieces ?? null,
      tareEach: c.tareEach ?? null, scaleGross: c.scaleGross ?? null,
      // Absent is the column default, on an update as on a create.
      customerContainerId: c.customerContainerId ?? "",
    });
    const kept = data.flatMap((c, i) => (c.id === undefined ? [] : [{ id: c.id, row: c, i }]));
    const changed = kept.filter(({ id, row }) => {
      const was = current.get(id)!;
      return was.typeId !== row.typeId || was.customerContainerId !== (row.customerContainerId ?? "");
    });
    // No `deletedAt` filter: the `assertRefExists` loop above has already refused a deleted type, so
    // every name resolves. Keep this read after that loop.
    const typeNames = changed.length === 0 ? new Map<string, string>() : new Map((await tx.containerType.findMany({
      where: { id: { in: [...new Set(changed.map(({ row }) => row.typeId))] } }, select: { id: true, name: true },
    })).map((t) => [t.id, t.name]));

    await auditedUpdate("order", orderId, async () => {
      await tx.orderContainer.deleteMany({ where: { orderId, id: { notIn: [...named] } } });
      // `@@unique([orderId, position])` is checked per statement, so the kept rows are parked at
      // negative positions first and only then given their final ones (the two-phase park of
      // `replaceShipperContainers`): a swap would otherwise collide half way.
      for (const [p, { id }] of kept.entries()) {
        await tx.orderContainer.update({ where: { id, orderId }, data: { position: -(p + 1) } });
      }
      for (const { id, row, i } of kept) {
        await tx.orderContainer.update({ where: { id, orderId }, data: fields(row, i) });
      }
      for (const { id, row } of changed) {
        await tx.shipperContainer.updateMany({
          where: { orderContainerId: id },
          data: { typeName: typeNames.get(row.typeId)!, customerContainerId: row.customerContainerId ?? "" },
        });
      }
      const added = data.flatMap((c, i) => (c.id === undefined ? [{ orderId, ...fields(c, i) }] : []));
      if (added.length > 0) await tx.orderContainer.createMany({ data: added });
    }, { tx });

    return readDetail(tx, orderId, traffic);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/** Bulk PUT of ONE line's serials: delete-then-recreate at positions 1..n (spec §5a). In-payload
 *  duplicates are named and refused before the transaction even opens — the `duplicateSerialError`
 *  shape, scoped to just this line's own replacement set (no part/customer label needed: the
 *  caller already named the line via `lineId`). The `@@unique([lineId, serial])` P2002 mapping
 *  below is the fallback for a value that collides for a reason the in-payload scan cannot see
 *  (e.g. a genuine race with another write to this same line). */
export async function replaceSerials(orderId: string, lineId: string, input: unknown): Promise<OrderDetail> {
  const data = REPLACE_SERIALS.parse(input);

  const seen = new Set<string>();
  for (const { serial } of data) {
    if (seen.has(serial)) throw new HttpError(400, `Serial "${serial}" is entered twice`);
    seen.add(serial);
  }

  const traffic = await trafficSettings();
  return withDbErrors({ entity: "Order" }, () => prisma.$transaction(async (tx) => {
    const order = await claimOrder(tx, orderId);
    if (!order || order.deletedAt !== null) throw new HttpError(404, "Order not found");

    const line = await tx.orderLine.findFirst({ where: { id: lineId, orderId }, select: { id: true } });
    if (!line) throw new HttpError(404, LINE_NOT_FOUND);

    await auditedUpdate("order", orderId, async () => {
      await tx.orderSerial.deleteMany({ where: { lineId } });
      if (data.length > 0) {
        try {
          await tx.orderSerial.createMany({
            data: data.map((s, i) => (
              { orderId, lineId, position: i + 1, serial: s.serial, description: s.description })),
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            throw new HttpError(400, "That serial is already on this line");
          }
          throw err;
        }
      }
    }, { tx });

    return readDetail(tx, orderId, traffic);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/** Bulk PUT of the order's charges: delete-then-recreate at positions 1..n (spec §5a/§7.5.3 — a
 *  null amount is a legitimate "needs price"). No registered FK on this table, so no
 *  `assertRefExists`, but the transaction stays Serializable for uniformity with every mutator
 *  in this file. */
export async function replaceCharges(orderId: string, input: unknown): Promise<OrderDetail> {
  const data = REPLACE_CHARGES.parse(input);
  const traffic = await trafficSettings();

  return withDbErrors({ entity: "Order" }, () => prisma.$transaction(async (tx) => {
    const order = await claimOrder(tx, orderId);
    if (!order || order.deletedAt !== null) throw new HttpError(404, "Order not found");

    // P5A spec §5.7 / §7.1 ("then the invoice owns them"): extra charges freeze the moment a
    // finalized invoice exists on this order — its lines are already on paper the customer holds.
    // Read on `tx`, under the claim taken immediately above, so the answer cannot go stale between
    // here and the write below.
    const inv = await finalizedInvoiceFor(tx, orderId);
    if (inv) throw new HttpError(400, invoiceBlockMessage(inv, INVOICE_FREEZE.changeCharges));

    await auditedUpdate("order", orderId, async () => {
      await tx.orderCharge.deleteMany({ where: { orderId } });
      if (data.length > 0) {
        await tx.orderCharge.createMany({
          data: data.map((c, i) => (
            { orderId, position: i + 1, description: c.description, amount: c.amount ?? null })),
        });
      }
    }, { tx });

    return readDetail(tx, orderId, traffic);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/**
 * `mustDo(user, "void_order")` is the route's job; the reason is required and trimmed HERE so no
 * future caller can bypass it (the `deleteCustomer` precedent, customers.ts) — spec §5c: voiding
 * carries the order's lines/loads/serials/charges away from every list and never frees the order
 * number, so the reason is the only record of why. `auditedSoftDelete` writes the "delete" audit
 * entry with that reason; the pre-check above it is what makes a second void of the same order
 * read "Order not found" rather than the generic "That record has already been deleted" every
 * other mutator in this file would also say for a voided target.
 */
export async function voidOrder(id: string, reason: string): Promise<void> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to void an order");

  await withDbErrors({ entity: "Order" }, () => prisma.$transaction(async (tx) => {
    const order = await claimOrder(tx, id);
    if (!order || order.deletedAt !== null) throw new HttpError(404, "Order not found");

    // Task 9 (§5.3/§5.7): refuse first if ANY invoice-family document on this order — an INVOICE or a
    // CREDIT — carries live A/R activity. This is the ORDER-level check, not `hasReceivableActivity`
    // on the order's finalized INVOICE: a finalized CREDIT lives on the same order and can hold a
    // live (possibly cross-order) application even after that INVOICE is unlocked back to DRAFT, at
    // which point `finalizedInvoiceFor` returns null and a per-invoice guard would never run —
    // orphaning the credit's application on a voided order. It is a stronger refusal than the bare
    // finalized-invoice one below: you cannot unlock or credit paper while money sits on it (unlock's
    // own guard refuses that too), so the only fix that works is to void the application. Read under
    // the order claim `claimOrder` already holds — the same claim `applyPayment`/`applyCredit` take —
    // so the check and the void it guards serialize through it.
    if (await hasReceivableActivityForOrder(tx, id)) {
      // #157/#173: the tail is computed at the ORDER scope, off the SAME predicate as the guard
      // above — it names a reopen only when something the guard just refused on sits in a closed
      // month, so the void it points at would refuse too. Inside the `if`, never before it.
      throw new HttpError(400,
        "This order cannot be voided — an invoice or credit on this order has A/R activity; " +
        `void the payments, credits or write-offs applied to it first${await applicationVoidHintForOrder(tx, id)}`);
    }

    // P5A spec §5.7: an order with a finalized invoice cannot be voided — credit or unlock first.
    // Both guards above and this one are checked BEFORE `shipmentBlockers`, deliberately: an invoiced
    // order has necessarily shipped (you bill what shipped), so the shipment check would fire first
    // for essentially every real case and send the user to void the shipment — which `voidShipper`'s
    // own guard then refuses for this same reason. Only naming the invoice/credit first points at a
    // fix that actually works.
    const inv = await finalizedInvoiceFor(tx, id);
    if (inv) throw new HttpError(400, invoiceBlockMessage(inv, INVOICE_FREEZE.voidOrder));

    // Spec §5.5: void the shipments first, otherwise the shipment is left pointing at an order
    // (and lines) that have vanished from every list.
    const blockers = await shipmentBlockers(tx, id);
    if (blockers.length > 0) {
      throw new HttpError(400,
        `Order #${order.orderNumber} has live shipments — ${shipmentBlockerTail(blockers)}`);
    }

    await auditedSoftDelete("order", id, why, tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/**
 * Links two live orders of the SAME customer (spec §5d, **amended 2026-08-02 by owner ruling
 * during the Task 5 review** — the ruling supersedes §5d's original literal wording, which this
 * function followed before the fix: "adopt the OTHER side's group, else mint one for both" could
 * silently detach `id` from a group it already belonged to). Reference-only in Phase 3, no
 * scheduling/consolidation behaviour hangs off it yet.
 *
 * UNIONS the two sides' groups — no order is ever silently detached by linking (only
 * `unlinkOrder` removes membership):
 *   - neither side grouped -> mint one fresh `crypto.randomUUID()` for both (the column is a
 *     plain `String?` with no default — any opaque unique string works, no new dependency);
 *   - exactly one side already grouped -> the groupless side joins it, whichever side that is;
 *   - both grouped in DIFFERENT groups -> merge whole: every order carrying `other`'s groupId
 *     (itself included) moves onto `order`'s groupId, which survives;
 *   - both already in the SAME group -> 400, there is nothing to do.
 *
 * Only rows whose `linkGroupId` VALUE actually changes are audited — the "identical value: skip —
 * no junk audit rows" rule `setPartFieldValues` already follows, generalized to a
 * per-row loop because a merge can touch more than two rows at once (groups are small per the
 * ruling, so an unbounded loop of individually-audited updates is the honest, not the expensive,
 * choice — and it is what makes either affected order's own history show the link/merge).
 */
export async function linkOrder(id: string, otherId: string): Promise<OrderDetail> {
  if (otherId === id) throw new HttpError(400, "An order cannot be linked to itself");
  const traffic = await trafficSettings();

  return withDbErrors({ entity: "Order" }, () => prisma.$transaction(async (tx) => {
    // #214: an UNCLAIMED stub pass first, so the claim below can be ONE ordered statement over
    // the FULL write set — argument rows AND, for a both-groups merge, every absorbed member.
    // The old shape claimed the two argument rows (sorted) and let each member write acquire
    // its own lock through auditedUpdate's per-row claim in findMany order — and a loop of
    // per-row claims, even a sorted one, reopens the ABBA window between statements
    // (order-locks.ts's own rule): two merges over overlapping groups could each hold members
    // the other wanted. Postgres breaks that cycle with 40P01, which #90 maps to the honest 409
    // — so the cost was a deadlock_timeout stall plus a spurious "try again" for a collision
    // the one-statement claim makes wait-only. (An earlier comment here called 40P01 unmapped;
    // that predates #90.) Validating on the stubs is sound at Serializable: every read in this
    // transaction shares one snapshot, and the claim's FOR UPDATE aborts with 40001 — mapped to
    // the same 409 — the moment any claimed row changed after that snapshot, so a stale
    // validation can never survive to the writes.
    const order = await tx.order.findFirst({ where: { id } });
    const other = await tx.order.findFirst({ where: { id: otherId } });

    if (!order || order.deletedAt !== null) throw new HttpError(404, "Order not found");
    if (!other || other.deletedAt !== null) throw new HttpError(404, "Order not found");

    if (other.customerId !== order.customerId) {
      throw new HttpError(400, "Orders can only be linked within one customer");
    }
    if (order.linkGroupId !== null && order.linkGroupId === other.linkGroupId) {
      throw new HttpError(400, "Those orders are already linked");
    }

    // The survivor groupId, and exactly the rows that need to move onto it — anything NOT
    // listed here already carries the right value and gets no audit entry for this call.
    let groupId: string;
    let toUpdate: string[];
    if (order.linkGroupId && !other.linkGroupId) {
      groupId = order.linkGroupId;
      toUpdate = [otherId];
    } else if (!order.linkGroupId && other.linkGroupId) {
      groupId = other.linkGroupId;
      toUpdate = [id];
    } else if (order.linkGroupId && other.linkGroupId) {
      // Different groups (same-group already 400'd above): id's group survives, and every LIVE
      // member of other's group — other itself included — moves onto it. `deletedAt: null` here
      // (fix-wave finding 10) is not optional: without it a voided groupmate — read-only by spec
      // §5a/§5c, exactly like the order being merged itself — got its linkGroupId reassigned and
      // an audit entry written right alongside its live siblings, merely for sharing a group with
      // the actual merge target. A voided order keeps whatever groupId it had at the moment it
      // was voided; only its live groupmates move.
      groupId = order.linkGroupId;
      const othersGroup = await tx.order.findMany({
        where: { linkGroupId: other.linkGroupId, deletedAt: null }, select: { id: true },
      });
      toUpdate = othersGroup.map((o) => o.id);
    } else {
      groupId = crypto.randomUUID();
      toUpdate = [id, otherId];
    }

    // The ONE claim: both argument rows plus every row the branch above decided to write,
    // deduplicated and ascending in a single statement (claimOrdersInOrder) — the only lock
    // acquisition in this transaction, so no second, differently-ordered claim path exists.
    await claimOrdersInOrder(tx, [id, otherId, ...toUpdate]);

    // `linkGroupId` is a header scalar, so each member's pair is children-free (R5; R26, #711 step 5).
    for (const memberId of toUpdate) {
      await auditedUpdate("order", memberId, () =>
        tx.order.update({ where: { id: memberId }, data: { linkGroupId: groupId } }), { tx, snapshot: "header" });
    }

    return readDetail(tx, id, traffic);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/**
 * Clears this order's own `linkGroupId` (spec §5d) and — fix-wave finding 9 — cascades to the
 * LAST remaining member's own `linkGroupId` too when doing so would drop the group to size one.
 * A group of one is NOT harmless: the board's `linked` flag is bare `linkGroupId !== null`
 * (`listOrders`), so the lone survivor would still read "linked" there while its own detail
 * view's `linkedOrders` panel came back empty (`readDetail` finds no one else sharing that
 * groupId) — a badge with nothing behind it, the exact "guard that doesn't name what's blocking"
 * shape this app is built to avoid. Any group still holding two or more members after this unlink
 * is left untouched, exactly as before.
 */
export async function unlinkOrder(id: string): Promise<OrderDetail> {
  const traffic = await trafficSettings();

  return withDbErrors({ entity: "Order" }, () => prisma.$transaction(async (tx) => {
    // #214: unclaimed stub pass, then ONE ordered claim over the full write set — linkOrder's
    // shape, for the same reason: the cascade's survivor write used to take its lock through
    // auditedUpdate's per-row claim, so `unlinkOrder(A)` racing `unlinkOrder(B)` on group {A,B}
    // was a genuine ABBA cycle (T1 holds A wants B, T2 holds B wants A → 40P01, a
    // deadlock_timeout stall answered as #90's 409). Stub validation is sound at Serializable —
    // one snapshot per transaction, and the claim 40001s on any drift (see linkOrder).
    const order = await tx.order.findFirst({ where: { id } });
    if (!order || order.deletedAt !== null) throw new HttpError(404, "Order not found");

    // Every OTHER member of this order's CURRENT group, read before this order's own row is
    // cleared below — empty when this order was never grouped in the first place, in which case
    // there is nothing to cascade to and the write below is the same no-op it always was. Counted
    // regardless of voided status (membership itself is never deletedAt-filtered anywhere in this
    // file — readDetail's own linkedOrders lookup lists a voided groupmate too), but the actual
    // write just below only ever touches the survivor when it is live: a voided order stays
    // read-only under every mutator (spec §5a/§5c), the same rule finding 10's merge fix applies.
    const groupmates = order.linkGroupId
      ? await tx.order.findMany({
        where: { linkGroupId: order.linkGroupId, id: { not: id } }, select: { id: true, deletedAt: true },
      })
      : [];
    const survivorId =
      groupmates.length === 1 && groupmates[0].deletedAt === null ? groupmates[0].id : null;

    await claimOrdersInOrder(tx, survivorId ? [id, survivorId] : [id]);

    // Both writes clear a header scalar: children-free pairs (R5; R26, #711 step 5).
    await auditedUpdate("order", id, () =>
      tx.order.update({ where: { id }, data: { linkGroupId: null } }), { tx, snapshot: "header" });

    if (survivorId) {
      await auditedUpdate("order", survivorId, () =>
        tx.order.update({ where: { id: survivorId }, data: { linkGroupId: null } }), { tx, snapshot: "header" });
    }

    return readDetail(tx, id, traffic);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/**
 * The order's frozen recipe (spec §5.3/§11), for the hub's Process section — `GET
 * /api/orders/[id]/process`, gated `orders.view` alone (Task 14's `processes.view` gate no longer
 * applies: this is now an order-scoped historical read, not a live parts-process one).
 *
 * Fix-wave R2 finding 7: parts are deletable once every order referencing them is voided
 * (parts.ts's deletePart), but ProcessSection used to read the part directly
 * (`getRevision`/`GET /api/parts/[id]/process/revisions/[n]`), which 404s "Part not found" the
 * moment that happens — exactly backwards for a voided order's own paperwork, which spec §5c
 * requires to stay readable. Resolved two ways from every other mutator in this file:
 *   - no `deletedAt` filter on the order lookup — a voided order is fully readable here, only a
 *     truly missing order id 404s (spec §5c: reads work on a voided order).
 *   - the content read goes through `getRevisionContentUnchecked` (part-process-steps.ts), NOT
 *     `getRevision` — deliberately skipping that function's live-part gate. The order's own
 *     stored (partId, revisionNumber) pair on its lead line is the authority for this read, not
 *     whatever the part's current liveness happens to be; the caller having `orders.view` (this
 *     function's own route gate) is what makes reading the order's history legitimate at all.
 */
export async function getLockedRevision(orderId: string): Promise<RevisionDetail> {
  const order = await prisma.order.findFirst({ where: { id: orderId }, select: { id: true } });
  if (!order) throw new HttpError(404, "Order not found");

  const lead = await prisma.orderLine.findFirst({
    where: { orderId, position: 1 }, select: { partId: true, revisionNumber: true },
  });
  // Defensive, not expected (ProcessSection.tsx's own prior comment on this same invariant):
  // every order's lead line gets a real revisionNumber at create time (createOrder locks it via
  // lockCurrentRevision, which itself refuses a part with zero steps) — this only fires if that
  // invariant were somehow violated.
  if (!lead || lead.revisionNumber === null) {
    throw new HttpError(404, "This order has no locked revision on file");
  }
  return getRevisionContentUnchecked(lead.partId, lead.revisionNumber);
}
