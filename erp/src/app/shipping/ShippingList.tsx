"use client";
import { formatDate, formatMoney, formatNumber } from "@/lib/format";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { showAllClicked, showAllFor, windowNotice, type ListWindow, type ShowAll } from "@/lib/list-window";
import { NET_WEIGHT_LB } from "@/lib/weight-terms";
import { SHIPPING_PRESETS, applyPreset, presetFor, type ShippingPresetKey } from "@/lib/shipping-presets";
import { PageHeader } from "@/components/PageHeader";
import { ListTabs } from "@/components/ListTabs";
import {
  BADGE_WARNING, BUTTON_PRIMARY, CARD, CARD_FLUSH, INPUT_COMPACT, LINK, NOTICE, BADGE_DANGER, TABLE_CELL, TABLE_HEAD,
} from "@/lib/ui-classes";
import { Combobox } from "@/components/Combobox";
import { customerOptions } from "@/lib/menu-options";

// Local mirror of src/server/shippers.ts's ShipperRow — not imported from src/server/** (CLAUDE.md
// "Constraints that will bite you": a client component pulling from there drags node:async_hooks
// and Prisma into the browser bundle). `shipDate` arrives pre-formatted as a "yyyy-mm-dd" string
// (`formatDateOnly` runs server-side before `NextResponse.json`). The display helper arranges
// the civil-date fields without timezone conversion; filters keep their ISO values.
type ShipperRow = {
  id: string; shipperNumber: number; bolNumber: number | null; customerCode: string; customerName: string;
  shipDate: string; orderCount: number; orderLabels: string[]; carrierName: string | null;
  totalQty: number; totalWeight: number; freightAmount: number | null; deletedAt: string | null;
  reversesShipperNumber: number | null; reversedByShipperNumber: number | null;
};

// The orders board / parts page precedent: only the slice the customer filter picker needs.
type CustomerOption = { id: string; code: string; name: string };

type Filters = { customerId: string; from: string; to: string; includeVoided: boolean; search: string };

// includeVoided defaults off (spec §11) — a voided shipment stays off the board until the caller
// deliberately asks for it.
const DEFAULT_FILTERS: Filters = { customerId: "", from: "", to: "", includeVoided: false, search: "" };

/** The list's status cell, kept independently renderable for its document-state coverage. */
export function ShippingStatus({ deletedAt, reversesShipperNumber, reversedByShipperNumber }:
  Pick<ShipperRow, "deletedAt" | "reversesShipperNumber" | "reversedByShipperNumber">) {
  if (!deletedAt && reversesShipperNumber === null && reversedByShipperNumber === null) {
    return <span className="text-ink-500">—</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {deletedAt && <span className={BADGE_DANGER}>voided</span>}
      {reversesShipperNumber !== null && (
        <span className={`${BADGE_WARNING} whitespace-nowrap`}>
          Reversal of {reversesShipperNumber}
        </span>
      )}
      {reversedByShipperNumber !== null && (
        <span className="whitespace-nowrap rounded bg-surface-50 px-1 text-xs text-ink-800">
          Reversed by {reversedByShipperNumber}
        </span>
      )}
    </div>
  );
}

/** Mirrors `src/app/api/shippers/query.ts`'s `parseShipperFilter` in reverse: turns this screen's
 *  filter state into the query string both `/api/shippers` and `/api/shippers/export` expect. */
function buildQuery(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.customerId) params.set("customerId", filters.customerId);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.includeVoided) params.set("includeVoided", "1");
  if (filters.search.trim()) params.set("search", filters.search.trim());
  return params.toString();
}

export function ShippingList() {
  const router = useRouter();
  const { permissions: perms, error: permsError } = usePermissions();
  const [rows, setRows] = useState<ShipperRow[]>([]);
  // #223 item 5: the empty-state row must not render before the first load resolves (the
  // CertList `loaded` convention) — `e2e/manual-capture.mjs` documents and works around this
  // divergence by name. Only ever false→true, so no ticket of its own.
  const [loaded, setLoaded] = useState(false);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  // #144: the picker fetch gets its OWN banner, never the shared `error` that `load()`'s success
  // clears (the NewShipment `loadError` precedent) — a broken customer filter must stay reported
  // while the list itself keeps loading fine. Never auto-cleared: nothing retries the picker, so
  // nothing can honestly clear it. (No accumulator — unlike NewShipment, exactly one fetch
  // reports here.)
  const [customersError, setCustomersError] = useState<string | null>(null);

  const customersGate = gate(perms, "customers.view");
  const createGate = gate(perms, "shipping.create");

  // Customer filter picker: fetched only once the caller is known to hold customers.view, never
  // left silently empty for someone who lacks it (§5.16) — the orders board (src/app/page.tsx)
  // precedent, applied to this screen's own customer filter.
  useEffect(() => {
    if (!customersGate.allowed) return;
    api<CustomerOption[]>("/api/customers").then(setCustomers).catch((e) => setCustomersError((e as Error).message));
  }, [customersGate.allowed]);

  function updateFilters(patch: Partial<Filters>) {
    setFilters((prev) => ({ ...prev, ...patch }));
  }

  // Ruling R3 (#612): the list and its Export link read the term 250 ms after the last keystroke.
  const debouncedSearch = useDebouncedValue(filters.search);
  const query = buildQuery({ ...filters, search: debouncedSearch });
  // Ruling R3 (#612): the list reads the newest 200 shipments (`?window=1`) and says so under the
  // filters; "show all" re-reads unbounded for the query it was clicked under only. The override is
  // the leaf's (`showAllFor`), asked by `load` itself, as on the board: a stored click under another
  // query is dropped before any read and the drop re-runs the load windowed; each click is a new
  // attempt. The Export link's query string is never windowed.
  const [cut, setCut] = useState(false);
  const [showAllState, setShowAllState] = useState<ShowAll>(null);

  const latest = useLatest();
  // Ticket-gated on BOTH the success and the rejection path (issues #5/#15 — a stale search
  // response must never overwrite a newer one, and a stale FAILURE must never overwrite a newer
  // success either). No `.catch(() => {})` anywhere: a failed load sets `error` and renders it,
  // never silently leaves `rows` looking like an empty-but-healthy list.
  const load = useCallback(async () => {
    const override = showAllFor(showAllState, query);
    if (override !== showAllState) { setShowAllState(override); return; } // the drop re-runs this load, windowed
    const t = latest.next();
    let data: ListWindow<ShipperRow>;
    try {
      data = await api<ListWindow<ShipperRow>>(`/api/shippers?${query ? `${query}&` : ""}window=1${override !== null ? "&showAll=1" : ""}`);
    } catch (e) {
      if (latest.isCurrent(t)) { setError((e as Error).message); setLoaded(true); }
      return;
    }
    if (!latest.isCurrent(t)) return;
    setRows(data.rows);
    setCut(data.cut);
    setLoaded(true);
    setError(null);
  }, [query, showAllState, latest]);
  useEffect(() => { void load(); }, [load]);

  // The list's sort is fixed, newest ship date first, so the ruled sentence applies as written.
  const notice = windowNotice(cut, { newestFirst: true });
  return (
    <div className="min-w-0 p-3 sm:p-6">
      {/* The entry point to /shipping/new (Task 14b) — §5.16: disabled with the missing
          permission named, never hidden (the orders board's New Order precedent); the screen's
          one primary action (spec §4.3). */}
      <PageHeader title="Shipping" subtitle="Packing lists for one customer and one or several orders."
        actions={<button onClick={() => router.push("/shipping/new")} disabled={createGate.disabled} title={createGate.title}
                         className={BUTTON_PRIMARY}>
          New Shipment
        </button>} />

      {(error ?? permsError) && (
        <p className={`${NOTICE.refusal} mb-3`}>{error ?? permsError}</p>
      )}
      {customersError && (
        <p className={`${NOTICE.warning} mb-3`}>
          Could not load the customer filter: {customersError}
        </p>
      )}

      {/* The two presets are the Include voided box's two states (`src/lib/shipping-presets.ts`),
          derived from the filters, so the box below and the tabs always agree. */}
      <ListTabs label="Shipping views" tabs={SHIPPING_PRESETS} active={presetFor(filters)}
                onSelect={(key) => updateFilters(applyPreset(filters, key as ShippingPresetKey))} />
      <div className={`${CARD} mb-4 flex flex-wrap items-end gap-4 text-sm`}>
        <div>
          <label htmlFor="shipping-search" className="block text-xs text-ink-500">Search</label>
          <input id="shipping-search" value={filters.search} onChange={(e) => updateFilters({ search: e.target.value })}
                 placeholder="Packing list #, BOL #, order #, customer code"
                 className={`${INPUT_COMPACT} w-72`} />
        </div>

        <div>
          <label htmlFor="shipping-customer" className="block text-xs text-ink-500">Customer</label>
          <Combobox id="shipping-customer" value={filters.customerId} options={customerOptions(customers, { blank: "All customers" })}
                  onSelect={(v) => updateFilters({ customerId: v })}
                  disabled={!customersGate.allowed} title={customersGate.allowed ? undefined : customersGate.title} ariaLabel="Customer" className="w-64" />
        </div>

        <div>
          <label className="block text-xs text-ink-500">Ship date</label>
          <div className="flex items-center gap-1">
            <input type="date" aria-label="Ship date from" value={filters.from} onChange={(e) => updateFilters({ from: e.target.value })}
                   className={INPUT_COMPACT} />
            <span>&ndash;</span>
            <input type="date" aria-label="Ship date to" value={filters.to} onChange={(e) => updateFilters({ to: e.target.value })}
                   className={INPUT_COMPACT} />
          </div>
        </div>

        <label className="flex items-center gap-1">
          <input type="checkbox" checked={filters.includeVoided}
                 onChange={(e) => updateFilters({ includeVoided: e.target.checked })} />
          Include voided
        </label>

        <a href={`/api/shippers/export${query ? `?${query}` : ""}`} className={LINK}>
          Export to Excel
        </a>
      </div>

      {notice && (
        <p className="mb-2 text-sm text-ink-500">
          {notice.lead}{" "}
          <button type="button" className={LINK} onClick={() => setShowAllState((prev) => showAllClicked(prev, query))}>{notice.action}</button>
        </p>
      )}

      <div className={`${CARD_FLUSH} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className={`${TABLE_HEAD} p-2`}>Packing List No</th>
              <th className={`${TABLE_HEAD} p-2`}>Customer</th>
              <th className={`${TABLE_HEAD} p-2`}>Ship Date</th>
              <th className={`${TABLE_HEAD} p-2`}>Orders</th>
              <th className={`${TABLE_HEAD} p-2`}>Carrier</th>
              <th className={`${TABLE_HEAD} text-right p-2`}>Pieces</th>
              <th className={`${TABLE_HEAD} xl:whitespace-nowrap text-right p-2`}>{NET_WEIGHT_LB}</th>
              <th className={`${TABLE_HEAD} text-right p-2`}>Freight</th>
              <th className={`${TABLE_HEAD} p-2`}>BOL No</th>
              <th className={`${TABLE_HEAD} p-2`}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className={`${TABLE_CELL} font-mono`}>
                  {/* The one path to an existing shipment for a shipping.view-only user (#48) —
                      the cert and order-hub shipment lists' own link shape. */}
                  <Link href={`/shipping/${r.id}`} className={LINK}>{r.shipperNumber}</Link>
                </td>
                <td className={TABLE_CELL}>{r.customerCode} · {r.customerName}</td>
                <td className={TABLE_CELL}>{formatDate(r.shipDate)}</td>
                <td className={TABLE_CELL}>{r.orderLabels.join(", ")}</td>
                <td className={TABLE_CELL}>{r.carrierName ?? ""}</td>
                <td className={`${TABLE_CELL} tabular-nums text-right`}>{formatNumber(r.totalQty)}</td>
                <td className={`${TABLE_CELL} tabular-nums text-right`}>{formatNumber(r.totalWeight, 2)}</td>
                <td className={`${TABLE_CELL} tabular-nums text-right`}>{r.freightAmount === null ? "" : formatMoney(r.freightAmount)}</td>
                <td className={`${TABLE_CELL} font-mono`}>{r.bolNumber ?? ""}</td>
                <td className={TABLE_CELL}>
                  <ShippingStatus {...r} />
                </td>
              </tr>
            ))}
            {rows.length === 0 && loaded && !error && (
              <tr><td colSpan={10} className="p-4 text-center text-ink-500">No shipments</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
