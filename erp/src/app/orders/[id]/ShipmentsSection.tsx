"use client";
import { formatDate, formatNumber } from "@/lib/format";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import type { Gate } from "@/lib/permission-ui";
import { NET_WEIGHT_LB } from "@/lib/weight-terms";
import { listStatus } from "@/lib/list-status";
import { ListStatus } from "@/components/PageStatus";
import { CARD, LINK, NOTICE } from "@/lib/ui-classes";

/** Local mirror of src/server/shippers.ts's `ShipperRow`, narrowed to what this section renders
 *  — not imported from src/server/** (CLAUDE.md). `orders` is Task 17's per-order breakdown:
 *  this order's own sequence, quantities and complete flag, which the shipment-wide totals
 *  cannot answer once a shipment carries several orders. */
type ShipperRowOrder = {
  orderId: string; orderNumber: number; sequence: number;
  qty: number; weight: number; complete: boolean;
};
type ShipperRow = {
  id: string; shipperNumber: number; bolNumber: number | null;
  shipDate: string; orders: ShipperRowOrder[];
  carrierName: string | null; deletedAt: string | null;
};

/**
 * The order hub ↔ this section: the invalidateHistory mechanism (HistoryPanel.tsx), cloned for
 * #473. A module-level Set rather than a prop: the mutations that move this list's tags live in
 * the hub's other sections and report through the page's one `applyMutation`, which already tells
 * the History panel the same way. One signal comes from outside it: the page's read after a line
 * Remove answered 404 "Order line not found" (`readAfterRemoval`, #475), a removal whose answer
 * this page never applied. Per-tab, like that precedent.
 */
const invalidationListeners = new Set<() => void>();

/** Subscribe a listener; returns the unsubscribe. Exported so
 *  tests/order-shipments-invalidation.test.ts can pin the contract without a DOM test env; the
 *  section's own effect subscribes through this too, so the tested path is the wired path. */
export function subscribeOrderShipmentsInvalidations(listener: () => void): () => void {
  invalidationListeners.add(listener);
  return () => { invalidationListeners.delete(listener); };
}

/**
 * Tell the mounted Shipments section that its list may be out of date, and to read it again now
 * (#473). A row's Complete or Partial tag is the ledger's completion rule's answer
 * (`completionOfTargets`, ship-ledger.ts) over the order's CURRENT line quantities, so a line save
 * on the hub can change it: a quantity corrected down to
 * what has shipped moved the order to Shipped while the row still read Partial until a reload.
 * Called once the server state has certainly changed: on `applyMutation`'s success path, once the
 * mutation has answered, and before the page's read after a line Remove answered 404 "Order line
 * not found" (`readAfterRemoval`, #475), whose removal ran no success path on this page. A
 * mutation that cannot change a tag costs one read that finds nothing new.
 */
export function invalidateOrderShipments(): void {
  for (const listen of invalidationListeners) listen();
}

/**
 * The hub's Shipments section (design spec §11, Task 17): every shipment that has ever carried
 * this order — voided included, dimmed rather than hidden (the shipmentsForOrder contract). Pure
 * read; shipments are created and edited on their own page, so a voided order needs no special
 * lock here beyond what the read already is. It reads once per order and view gate, and again on
 * each `invalidateOrderShipments()`.
 *
 * Each row links to /shipping/[id]. That page is lane A's Task 14 — on this lane's dev server
 * the link 404s, which is the established cross-lane nav precedent (task-15/16 briefs): the HREF
 * is the contract, the page arrives at merge.
 */
export function ShipmentsSection({
  orderId, orderNumber, viewGate,
}: {
  orderId: string;
  orderNumber: number;
  viewGate: Gate;
}) {
  const [rows, setRows] = useState<ShipperRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Which order's shipments a read has landed for (P6 step 3, #632): "Nothing shipped yet." only
  // after one has, never during the first read nor under a failed one (the #223 false empty).
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  // Bumped by an invalidation to run the read below again (the HistoryPanel refreshNonce shape).
  const [refreshNonce, setRefreshNonce] = useState(0);
  useEffect(() => subscribeOrderShipmentsInvalidations(() => setRefreshNonce((n) => n + 1)), []);

  const allowed = viewGate.allowed;
  useEffect(() => {
    if (!allowed) return;
    // Effect-scoped stale flag (the HistoryPanel shape: the read is keyed entirely by this
    // effect's deps, refreshNonce included), gating BOTH landings. Two saves in a row start two
    // reads, and the older one answering last must not put back the tags the newer one replaced,
    // nor report a failure over a list that has since loaded. The rows on screen stay there while
    // a re-read is out, and when one fails.
    let stale = false;
    api<ShipperRow[]>(`/api/orders/${orderId}/shipments`)
      .then((fresh) => {
        if (stale) return;
        setRows(fresh);
        setError(null);
        setLoadedFor(orderId);
      })
      .catch((e) => { if (!stale) setError((e as Error).message); });
    return () => { stale = true; };
  }, [orderId, allowed, refreshNonce]);

  // §5.16: a caller without shipping.view sees the section saying why, never a silently empty one.
  if (!viewGate.allowed) {
    return (
      <section className={`${CARD} mb-6`}>
        <h2 className="mb-2 font-medium">Shipments</h2>
        <p className="text-sm text-ink-500">{viewGate.title ?? "You do not have permission to view shipments."}</p>
      </section>
    );
  }

  // The error has its own line above; after a read has landed, a later failure leaves its rows.
  const status = listStatus({ allowed: true, error: loadedFor === orderId ? null : error, loadedFor, key: orderId, count: rows.length });

  return (
    <section className={`${CARD} mb-6`}>
      <h2 className="mb-2 font-medium">Shipments</h2>

      {error && <p className={`${NOTICE.refusal} mb-3`}>{error}</p>}

      {status !== "rows" ? (
        <ListStatus status={status} empty="Nothing shipped yet." />
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-ink-500">
              <th className="py-1 font-medium">Shipment</th>
              <th className="font-medium">Packing List No</th>
              <th className="font-medium">Ship date</th>
              <th className="text-right font-medium">Qty</th>
              {/* The net weight column carries `pr-3`, on its heading and on its figure below, as
                  the gap before Complete: it is right-aligned, Complete is left-aligned, and no
                  other class pads either side of where the two meet. */}
              <th className="pr-3 text-right font-medium">{NET_WEIGHT_LB}</th>
              <th className="font-medium">Complete</th>
              <th className="font-medium">Carrier</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              // THIS order's own slice of the shipment — the `92036-3` label and per-order
              // quantities come from it, never from the shipment-wide totals.
              const mine = row.orders.find((o) => o.orderId === orderId);
              return (
                <tr key={row.id} className={`border-t ${row.deletedAt ? "text-ink-500" : ""}`}>
                  <td className="py-1 font-mono">
                    <Link href={`/shipping/${row.id}`} className={LINK}>
                      {mine ? `${orderNumber}-${mine.sequence}` : `#${row.shipperNumber}`}
                    </Link>
                    {row.deletedAt && (
                      <span className="ml-2 rounded bg-line px-1 text-xs text-ink-800">voided</span>
                    )}
                    {row.orders.length > 1 && (
                      <span className="ml-2 text-xs text-ink-500">
                        (+{row.orders.length - 1} other order{row.orders.length === 2 ? "" : "s"})
                      </span>
                    )}
                  </td>
                  <td>{row.shipperNumber}</td>
                  <td>{formatDate(row.shipDate)}</td>
                  <td className="tabular-nums text-right">{mine ? formatNumber(mine.qty) : "—"}</td>
                  <td className="pr-3 tabular-nums text-right">{mine ? formatNumber(mine.weight, 2) : "—"}</td>
                  <td>{mine ? (mine.complete ? "Complete" : "Partial") : "—"}</td>
                  <td className="text-ink-500">{row.carrierName ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
