// The ship ledger (spec §5.1/§5.2/§5.3): shipped-to-date, order-status derivation, and the
// per-order shipment sequence. Deliberately independent of `shippers.ts` (Task 8) — that service
// will call every export here, but nothing here knows it exists (the task-7-brief.md fixtures
// note applies to this file's own design, not just its tests): the arithmetic and the locking
// discipline are the foundation, not a detail of whichever route ends up calling them.
import { Prisma, type OrderStatus } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { auditedUpdate } from "./audit";
import { sortedClaimIds } from "./order-locks";
import {
  deriveShipStatus, lineIsComplete, buildShipPrefix, shipStateBelow, type ShipPrefixEntry,
} from "@/lib/line-completion";

type Db = typeof prisma | Prisma.TransactionClient;

export type ShippedTotal = { qty: number; weight: number };

// INVOICED and REOPENED are INVOICE-OWNED states (5A §5.2): finalize writes INVOICED, a reversing
// shipment writes REOPENED, unlock hands the order back to this function. Any shipment-side recompute
// that ran while an order sat in one of them would silently drop it back to SHIPPED — the same reason
// voided orders are skipped: this function derives one thing, and does not own the states another
// subsystem set.
const INVOICE_OWNED: OrderStatus[] = ["INVOICED", "REOPENED"];

/**
 * Sum of `qty`/`weight` across every LIVE shipper line for each of `orderLineIds` (spec §5.1) — a
 * voided shipment (`Shipper.deletedAt` set) contributes nothing. `ShipperOrder`/`ShipperLine`
 * themselves carry no `deletedAt` of their own (spec §4.2: "shipment children have no deletedAt,
 * same reasoning as the cert's") — voidedness lives on the `Shipper` alone, so the live filter
 * reaches it through the one relation that connects a line back to its shipment.
 *
 * This is the ONE derivation spec §5.1 calls out as "used everywhere": the ship-now prefill
 * (`ordered - shipped`, editable), the over-ship warning, and the edit invariants Task 10
 * enforces (removing a line, or shrinking its qty/weight below shipped-to-date). Every one of
 * those callers reads through this function rather than re-deriving the sum, so "a voided
 * shipment contributes nothing" only has to be true in one place.
 *
 * A line with no live shipment at all has NO entry in the returned map (there is nothing to sum) —
 * callers that need a default treat a missing key as `{ qty: 0, weight: 0 }`, the same sparse-map
 * shape `certs.ts`'s own `sequenceMap` uses for the identical reason.
 */
export async function shippedTotals(db: Db, orderLineIds: string[]): Promise<Map<string, ShippedTotal>> {
  const totals = new Map<string, ShippedTotal>();
  if (orderLineIds.length === 0) return totals;

  const rows = await db.shipperLine.findMany({
    where: { orderLineId: { in: orderLineIds }, shipperOrder: { shipper: { deletedAt: null } } },
    select: { orderLineId: true, qty: true, weight: true },
  });

  // Weight accumulates in INTEGER CENTS and divides once at the end (the `toShipperRow` idiom,
  // shippers.ts — weights are Decimal(12,2), so cents are exact): summing `toNumber()` floats made
  // 0.10 + 0.20 come back as 0.30000000000000004, and since this is the ONE §5.1 derivation every
  // caller reads, that artifact turned `updateLine`'s §5.5 guard into a hard false REFUSAL of a
  // legal edit-to-exactly-shipped, made `overshipWarnings` flag exactly-complete lines, and printed
  // the raw float in refusal text (fix-wave 2026-08-06, whole-branch review Important #2). `qty` is
  // an int and needs nothing.
  const cents = new Map<string, { qty: number; weightCents: number }>();
  for (const row of rows) {
    if (row.orderLineId === null) continue; // released snapshot rows total nothing (no live line)
    const prev = cents.get(row.orderLineId) ?? { qty: 0, weightCents: 0 };
    cents.set(row.orderLineId, {
      qty: prev.qty + row.qty,
      weightCents: prev.weightCents + Math.round(row.weight.toNumber() * 100),
    });
  }
  for (const [orderLineId, t] of cents) {
    totals.set(orderLineId, { qty: t.qty, weight: t.weightCents / 100 });
  }
  return totals;
}

/**
 * Clears every close short that quantity has made unnecessary (owner ruling 2026-10-06). A line
 * closed short at 9 of 10 keeps `lineComplete: true` on that shipper line; once a later shipment
 * sends the last piece, or the ordered quantity is corrected down to what shipped, the line is
 * complete by quantity and the tick says nothing. Left set, it would go on holding the line
 * complete after the ordered quantity is later RAISED, so it is cleared here: for each of
 * `orderIds` that is not voided, for each order line whose LIVE shipped quantity has reached its
 * current ordered quantity, `lineComplete` goes false on every LIVE shipper line of that order line
 * where it is true. A line that is still short keeps its tick. A released shipper line (null
 * `orderLineId`) and a voided shipment's line are never read here, so never written.
 *
 * The rows written usually belong to OTHER shipments than the one the caller is saving. The caller
 * holds each order's row claim (this function claims no order, like `recomputeOrderStatus`), and
 * that claim is what serializes the write: a shipper line's `orderLineId` only ever names a line of
 * its own `ShipperOrder`'s order, and every mutator of a shipment's lines or liveness claims ALL of
 * that shipment's orders first (`claimOrdersInOrder`, shippers.ts). `auditedUpdate` then takes its
 * own lock on each shipment row it writes through; the ids are walked ascending, so two callers
 * holding different orders that both clear on the same pair of shipments lock them in one order.
 *
 * Audited onto the shipment that owns the row (the `reverseShipperInTx` step 6b shape) with a fixed
 * reason, one update per affected shipment, and none at all when nothing is superseded. The public
 * entry makes two reads however many orders and lines are named: the order lines, then the live
 * shipper lines. `recomputeOrderStatus` already holds the order lines, so its path makes one, through
 * `clearSupersededCloseShortsOn`, and derives the status from the rows that read returned (#628).
 */
/** The reason on every audit entry `clearSupersededCloseShorts` writes: nobody clicked anything, so
 *  the shipment's history has to say why its line changed. */
export const SUPERSEDED_CLOSE_SHORT_REASON = "Close short cleared: the line reached its ordered quantity";

export async function clearSupersededCloseShorts(
  tx: Prisma.TransactionClient, orderIds: string[],
): Promise<void> {
  const ids = [...new Set(orderIds)];
  if (ids.length === 0) return;

  const orderLines = await tx.orderLine.findMany({
    where: { orderId: { in: ids }, order: { deletedAt: null } },
    select: { id: true, qty: true },
  });
  await clearSupersededCloseShortsOn(tx, orderLines);
}

/** A live shipper line as `clearSupersededCloseShortsOn` read it, with the clear's own write
 *  applied: `lineComplete` is false on every row the call cleared. */
type LiveShipperLine = { orderLineId: string | null; qty: number; lineComplete: boolean };

/** `clearSupersededCloseShorts` for a caller that already holds the LIVE order lines (id and current
 *  quantity) of the orders it names, so they are not read again. Returns every live shipper line it
 *  read on those order lines, as they stand AFTER the clear, so the caller can derive from the same
 *  rows instead of reading them a second time (`recomputeOrderStatus`, #628). */
async function clearSupersededCloseShortsOn(
  tx: Prisma.TransactionClient, orderLines: { id: string; qty: number }[],
): Promise<LiveShipperLine[]> {
  if (orderLines.length === 0) return [];

  const rows = await tx.shipperLine.findMany({
    where: {
      orderLineId: { in: orderLines.map((l) => l.id) },
      shipperOrder: { shipper: { deletedAt: null } },
    },
    select: {
      id: true, orderLineId: true, qty: true, lineComplete: true,
      shipperOrder: { select: { shipperId: true } },
    },
  });

  const shippedQty = new Map<string, number>();
  for (const row of rows) {
    if (row.orderLineId === null) continue; // filtered by `in` above; narrows the type
    shippedQty.set(row.orderLineId, (shippedQty.get(row.orderLineId) ?? 0) + row.qty);
  }
  // The rule is `lineIsComplete` with the close short taken out of it: complete by quantity alone.
  const completeByQty = new Set(orderLines
    .filter((l) => lineIsComplete({ orderedQty: l.qty, shippedQty: shippedQty.get(l.id) ?? 0, closedShort: false }))
    .map((l) => l.id));

  const superseded = new Map<string, string[]>(); // shipperId -> its shipper line ids to clear
  for (const row of rows) {
    if (row.orderLineId === null || !row.lineComplete || !completeByQty.has(row.orderLineId)) continue;
    const group = superseded.get(row.shipperOrder.shipperId);
    if (group === undefined) superseded.set(row.shipperOrder.shipperId, [row.id]); else group.push(row.id);
  }

  const cleared = new Set<string>();
  for (const shipperId of sortedClaimIds([...superseded.keys()])) {
    const lineIds = superseded.get(shipperId)!;
    await auditedUpdate("shipper", shipperId, () => tx.shipperLine.updateMany({
      where: { id: { in: lineIds } }, data: { lineComplete: false },
    }), { tx, reason: SUPERSEDED_CLOSE_SHORT_REASON });
    for (const id of lineIds) cleared.add(id);
  }
  // The rows as the clear left them: the same answer a second read after the writes would give.
  return rows.map((r) => ({
    orderLineId: r.orderLineId, qty: r.qty, lineComplete: cleared.has(r.id) ? false : r.lineComplete,
  }));
}

/**
 * OPEN | PARTIAL_SHIPPED | SHIPPED (owner ruling 2026-10-06, the quantity corrections design §3.1):
 *
 * - no live shipper lines for the order -> OPEN
 * - EVERY order line is complete -> SHIPPED. A line is complete when its shipped-to-date quantity
 *   reaches its CURRENT ordered quantity, or a live shipper line closed it short
 *   (`ShipperLine.lineComplete`). Weight never enters. The rule itself is `line-completion.ts`.
 * - otherwise -> PARTIAL_SHIPPED
 *
 * Before it derives anything it clears every close short that quantity has superseded on the
 * orders it is about to derive (`clearSupersededCloseShorts`, owner ruling 2026-10-06). This is the
 * one place every shipment and order-line mutation already passes through with the order claim
 * held, so a tick never outlives the shortfall it recorded: a line that has reached its ordered
 * quantity is complete by quantity alone, and a later RAISE of that quantity reopens it instead of
 * finding a stale tick still holding it complete. The clear runs for exactly the orders derived
 * below (not voided, and not invoice-owned unless `released` names them), so an invoice-owned
 * ORDER's lines are never touched from here. A shipment it shares with another order can still have
 * that other order's own line cleared, and gains the history entry for it.
 *
 * Recomputed inside the SAME transaction as every shipment mutation, for every affected order,
 * and also whenever an order's own line set changes (orders.ts's `addLine`/`updateLine`/
 * `removeLine`, Task 8's shipment create/void) — the caller is expected to already hold each
 * order's row claim (`claimOrder`/`claimOrdersInOrder`, order-locks.ts) before calling this; it
 * does no claiming of its own.
 *
 * Voided orders (`deletedAt !== null`) are skipped outright — voidedness stays orthogonal to
 * status (P3 §4). Phase 5A makes `INVOICED`/`REOPENED` reachable and INVOICE-OWNED: an order sitting
 * in one of those is skipped too (`INVOICE_OWNED`), so no shipment-side recompute silently drops it
 * back to SHIPPED. `released` is unlock's escape hatch (§5.2): the one order it is explicitly handing
 * back to the ledger IS recomputed despite its invoice-owned status, so unlock's post-clear recompute
 * settles it on its ship-derived value instead of leaving it INVOICED forever — a shipment-side
 * recompute, which passes no `released`, still leaves every invoice-owned order alone. Written through
 * `auditedUpdate` like every other mutation in this codebase (CLAUDE.md: "this phase adds no new
 * audit exceptions") and ONLY when the derived status actually differs from the stored one, so an
 * edit that leaves the derived status where it was writes no entry.
 */
export async function recomputeOrderStatus(
  tx: Prisma.TransactionClient, orderIds: string[], released: string[] = [],
): Promise<void> {
  const ids = [...new Set(orderIds)];
  if (ids.length === 0) return;
  const releasedSet = new Set(released);

  const orders = await tx.order.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true, status: true, lines: { select: { id: true, qty: true } } },
  });
  // Invoice-owned states belong to another subsystem — leave them alone unless unlock has
  // explicitly released this order back to the ledger (see the doc comment).
  const derived = orders.filter((o) => !INVOICE_OWNED.includes(o.status) || releasedSet.has(o.id));
  if (derived.length === 0) return;

  // Before the derivation, as the brief of this function states it. The clear takes the order
  // lines read above (every derived order is live, which is the public entry's own filter) and
  // hands back the live shipper lines it read, with its writes applied, so the derivation below
  // runs on the state after the clear without reading either set a second time (#628): one query
  // for every affected order's lines, not one per order (the `resolveCertSettings` precedent,
  // certs.ts). A line the clear touches is complete by quantity with or without its tick, so the
  // clear changes no status derived in THIS call; it changes the next one, after the ordered
  // quantity is raised.
  const shipperLines = await clearSupersededCloseShortsOn(tx, derived.flatMap((o) => o.lines));

  const shipState = new Map<string, { shippedQty: number; closedShort: boolean }>();
  for (const row of shipperLines) {
    if (row.orderLineId === null) continue; // filtered by `in` above; narrows the type
    const prev = shipState.get(row.orderLineId) ?? { shippedQty: 0, closedShort: false };
    shipState.set(row.orderLineId, {
      shippedQty: prev.shippedQty + row.qty,
      closedShort: prev.closedShort || row.lineComplete,
    });
  }

  for (const order of derived) {
    const status: OrderStatus = deriveShipStatus(order.lines.map((l) => {
      const s = shipState.get(l.id);
      return {
        orderedQty: l.qty, shippedQty: s?.shippedQty ?? 0,
        closedShort: s?.closedShort ?? false, hasLiveShipment: s !== undefined,
      };
    }));

    if (status === order.status) continue;
    // A status flip is a header scalar, so the children-free pair (R5; R26, #711 step 5).
    await auditedUpdate(
      "order", order.id,
      () => tx.order.update({ where: { id: order.id }, data: { status } }),
      { tx, snapshot: "header" },
    );
  }
}

/**
 * `max(sequence) + 1` over EVERY `ShipperOrder` row for this order (spec §3.19/§5.3) — deliberately
 * NO live filter. `ShipperOrder.sequence` is the "-3" in "92036-3", allocated once and never
 * reused: `Shipper` carries `deletedAt` but `ShipperOrder` does not (spec §4.2), so a voided
 * shipment's rows are still counted here, exactly as the brief requires — a number already
 * printed on a customer's paperwork must never be handed out twice. The caller is expected to
 * already hold the order's row claim (`claimOrder`/`claimOrdersInOrder`) before calling this, the
 * same discipline `allocateNumber` leans on for every other counter in this codebase.
 */
export async function nextShipmentSequence(tx: Prisma.TransactionClient, orderId: string): Promise<number> {
  const { _max } = await tx.shipperOrder.aggregate({ where: { orderId }, _max: { sequence: true } });
  return (_max.sequence ?? 0) + 1;
}

/**
 * `nextShipmentSequence` for several orders in one statement (#626): one `groupBy` on `tx`, with
 * the same deliberately absent live filter, so a voided shipment's rows still count. An order with
 * no rows is in the map at 1. The caller holds every order's claim first, as there.
 */
export async function nextShipmentSequences(
  tx: Prisma.TransactionClient, orderIds: readonly string[],
): Promise<Map<string, number>> {
  const distinct = [...new Set(orderIds)];
  const next = new Map(distinct.map((id) => [id, 1]));
  if (distinct.length === 0) return next;
  const groups = await tx.shipperOrder.groupBy({
    by: ["orderId"], where: { orderId: { in: distinct } }, _max: { sequence: true },
  });
  for (const g of groups) next.set(g.orderId, (g._max.sequence ?? 0) + 1);
  return next;
}

// PostgreSQL's wire protocol caps one statement at 32,767 bind parameters, and an `in` list spends one
// per id; 5,000 stays well under it while keeping the round trips few.
const ID_CHUNK_SIZE = 5000;

/** Runs `read` over `ids` in slices of at most `size`, one slice after another, and concatenates the
 *  rows in order. Sequential on purpose (see `shipperOrderCompletion`). No ids means no read. */
export async function inChunks<T>(
  ids: string[], size: number, read: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += size) rows.push(...await read(ids.slice(i, i + size)));
  return rows;
}

/** One `ShipperOrder` as the completion rule judges it: its sequence and its own lines. A line's
 *  `orderedQty` is LIVE-FIRST: the order line's CURRENT ordered quantity while the line is live,
 *  the snapshot captured at save once the line was released (`orderLineId` null), which is the
 *  figure the rule compares against in each case. `readShipperDetail` and the hub's row select both
 *  answer it that way (`orderLine?.qty ?? orderedQty`); the snapshot alone is never passed for a
 *  live line. */
export type CompletionTarget = {
  id: string; sequence: number;
  lines: { orderLineId: string | null; qty: number; lineComplete: boolean; orderedQty: number }[];
};

/**
 * For each `ShipperOrder`: did every line on it stand complete once that shipment had gone (the
 * quantity corrections design §3.4/§3.5)? Per order line, the live rows are sorted once into a
 * running prefix; a target line is its own row plus the prefix strictly below the target's
 * `sequence`, judged by `lineIsComplete` against the line's CURRENT ordered quantity. A voided
 * target's own rows are not among the live ones, so they enter only as its own row. A released row
 * (order line since removed) is judged on its own snapshot alone, with no other shipment counted.
 *
 * Two entry points, one rule (#628). `completionOfTargets` takes the targets a caller already holds
 * (the shipping ticket's claimed detail, the order hub's own row select) and reads only the live-row
 * group. `shipperOrderCompletion` takes ids, reads the targets with each line's current quantity,
 * and delegates. Each read takes its id list in bounded chunks (`inChunks`), so an unfiltered
 * history never nears the driver's bind-parameter limit. Reads: no claim.
 */
export async function completionOfTargets(
  db: Db, targets: CompletionTarget[], chunkSize: number = ID_CHUNK_SIZE,
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (targets.length === 0) return result;

  const lineIds = [...new Set(targets.flatMap((t) =>
    t.lines.map((l) => l.orderLineId).filter((id): id is string => id !== null)))];
  // Sequential, never `Promise.all`: `db` may be a transaction client, which runs one query at a time.
  const liveRows = await inChunks(lineIds, chunkSize, (ids) => db.shipperLine.findMany({
    where: { orderLineId: { in: ids }, shipperOrder: { shipper: { deletedAt: null } } },
    select: { orderLineId: true, qty: true, lineComplete: true, shipperOrder: { select: { sequence: true } } },
  }));
  const byLine = new Map<string, { sequence: number; qty: number; closedShort: boolean }[]>();
  for (const r of liveRows) {
    if (r.orderLineId === null) continue;
    const row = { sequence: r.shipperOrder.sequence, qty: r.qty, closedShort: r.lineComplete };
    const group = byLine.get(r.orderLineId);
    if (group === undefined) byLine.set(r.orderLineId, [row]); else group.push(row);
  }
  const prefixByLine = new Map<string, ShipPrefixEntry[]>();
  for (const [lineId, rows] of byLine) prefixByLine.set(lineId, buildShipPrefix(rows));

  for (const t of targets) {
    if (t.lines.length === 0) { result.set(t.id, false); continue; }
    result.set(t.id, t.lines.every((own) => {
      if (own.orderLineId === null) {
        return lineIsComplete({ orderedQty: own.orderedQty, shippedQty: own.qty, closedShort: own.lineComplete });
      }
      // `ShipperOrder.sequence` is unique per order (`@@unique([orderId, sequence])`) and a
      // ShipperOrder has at most one row per line (`@@unique([shipperOrderId, orderLineId])`), so
      // "strictly below" leaves out exactly this target's own stored row, added back just below.
      const below = shipStateBelow(prefixByLine.get(own.orderLineId) ?? [], t.sequence);
      return lineIsComplete({
        orderedQty: own.orderedQty,
        shippedQty: below.shippedQty + own.qty,
        closedShort: below.closedShort || own.lineComplete,
      });
    }));
  }
  return result;
}

/** `completionOfTargets` for a caller holding ids alone: reads each target with its lines and the
 *  live line's current quantity, in bounded chunks, then delegates. */
export async function shipperOrderCompletion(
  db: Db, shipperOrderIds: string[], chunkSize: number = ID_CHUNK_SIZE,
): Promise<Map<string, boolean>> {
  if (shipperOrderIds.length === 0) return new Map();
  const targets = await inChunks(shipperOrderIds, chunkSize, (ids) => db.shipperOrder.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, sequence: true,
      lines: {
        select: {
          orderLineId: true, qty: true, lineComplete: true, orderedQty: true,
          orderLine: { select: { qty: true } },
        },
      },
    },
  }));
  return completionOfTargets(db, targets.map((t) => ({
    id: t.id, sequence: t.sequence,
    lines: t.lines.map((l) => ({
      orderLineId: l.orderLineId, qty: l.qty, lineComplete: l.lineComplete,
      orderedQty: l.orderLine?.qty ?? l.orderedQty,
    })),
  })), chunkSize);
}
