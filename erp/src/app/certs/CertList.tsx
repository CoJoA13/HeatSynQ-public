"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { CERT_SCOPES, CERT_SCOPE_LABELS, type CertScopeValue } from "@/lib/cert-constants";
import { CERT_PRESETS, applyPreset, presetFor, scopeCell, type CertPresetKey, type CertPrinted } from "@/lib/cert-list";
import { PageHeader } from "@/components/PageHeader";
import { ListTabs } from "@/components/ListTabs";
import { BUTTON_NEUTRAL, CARD, CARD_FLUSH, INPUT_COMPACT, LINK, NOTICE, TABLE_CELL, TABLE_HEAD } from "@/lib/ui-classes";
import { Combobox } from "@/components/Combobox";
import { customerOptions } from "@/lib/menu-options";

// Local mirror of src/server/certs.ts's CertRow — not imported from src/server/** (CLAUDE.md
// "Constraints that will bite you": a client component pulling from there drags node:async_hooks
// and Prisma into the browser bundle). Dates cross the wire as ISO strings once run through
// NextResponse.json, not the `Date` the service type carries. Only the columns this list actually
// renders (the parts/page.tsx PartRow precedent) — `orderId`/`shipperId` are on the server row but
// nothing here needs them, since the detail link is keyed on the cert's own `id`.
type CertRow = {
  id: string; orderNumber: number; sequence: number | null;
  customerCode: string; customerName: string; scope: CertScopeValue;
  loadNumber: number | null; shipperNumber: number | null;
  printedAt: string | null; deletedAt: string | null;
  readingCount: number; passedCount: number; failCount: number;
};

// The parts/page.tsx precedent: only the slice the customer filter picker needs.
type CustomerOption = { id: string; code: string; name: string };

/** Spec §3.19: a cert has no number of its own. Its label is the order number plus, for a
 *  SHIPMENT-scope cert, that order's own shipment sequence — `#92036-3` — and just the bare
 *  order number for ORDER/LOAD scope. */
function orderLabel(row: CertRow): string {
  return row.scope === "SHIPMENT" && row.sequence !== null
    ? `#${row.orderNumber}-${row.sequence}`
    : `#${row.orderNumber}`;
}

/** The list's filters: the presets (`src/lib/cert-list.ts`) are states of `printed`, so one
 *  object holds them all and a preset is one `setFilters`. */
type Filters = { search: string; customerId: string; scope: CertScopeValue | ""; printed: CertPrinted; includeVoided: boolean };
const DEFAULT_FILTERS: Filters = { search: "", customerId: "", scope: "", printed: "", includeVoided: false };

/**
 * The §11 pass/fail summary — three states, never two. A reading with no value yet has
 * `passed === null`, not `false`, so it is neither a pass nor a fail; `readingCount -
 * failCount` (this file's original, wrong, shape) silently counted it as "passed", which
 * overstates completeness for exactly the mid-entry cert this page exists to surface (a few
 * requirements filled in and passing, the rest still blank, zero failures so far — the normal
 * state of every cert before data entry finishes, not an edge case). `passedCount` is computed
 * server-side the same explicit-equality way `failCount` always was (`passed === true`, not "not
 * false"), so the three counts here are read directly off the row rather than inferred from a
 * subtraction that hides the null case.
 */
type ResultSegment = { text: string; className: string };
function resultSegments(row: CertRow): ResultSegment[] {
  const pending = row.readingCount - row.passedCount - row.failCount;
  const segments: ResultSegment[] = [];
  if (row.failCount > 0) {
    segments.push({ text: `${row.failCount} of ${row.readingCount} failed`, className: "text-red-700" });
  } else if (row.passedCount > 0) {
    segments.push({ text: `${row.passedCount} passed`, className: "text-ink-500" });
  }
  if (pending > 0) segments.push({ text: `${pending} pending`, className: "text-accent-600" });
  return segments;
}

export function CertList() {
  const [rows, setRows] = useState<CertRow[]>([]);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const updateFilters = (patch: Partial<Filters>) => setFilters((cur) => ({ ...cur, ...patch }));
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  // #144: the picker fetch gets its OWN banner, never the shared `error` that `load()`'s success
  // clears (the NewShipment `loadError` precedent) — never auto-cleared, since nothing retries
  // the picker.
  const [customersError, setCustomersError] = useState<string | null>(null);
  // A `loaded` flag distinct from "the array is empty" (the InvoicingList `candidatesLoaded`
  // precedent): the empty-state row must not render before the first load resolves — an
  // in-flight first fetch is not "No certifications match these filters."
  const [loaded, setLoaded] = useState(false);
  const { permissions: perms, error: permsError } = usePermissions();

  const customersGate = gate(perms, "customers.view");

  const params = new URLSearchParams();
  if (filters.search.trim()) params.set("search", filters.search.trim());
  if (filters.customerId) params.set("customerId", filters.customerId);
  if (filters.scope) params.set("scope", filters.scope);
  if (filters.printed) params.set("printed", filters.printed);
  if (filters.includeVoided) params.set("includeVoided", "1");
  const query = params.toString();

  // Named `latest`, not `gate` — this file also imports `gate` from permission-ui for the
  // held-permission checks above, and shadowing that binding with the stale-response gate would
  // break every `gate(perms, ...)` call in this component.
  const latest = useLatest();
  // The catch is ticket-gated too, not just the success path (the customers/parts precedent,
  // issues #5/#15): a superseded request's rejection landing after a newer request already
  // succeeded must not overwrite fresh rows with a stale failure message.
  const load = useCallback(async () => {
    const t = latest.next();
    let data: CertRow[];
    try {
      data = await api<CertRow[]>(`/api/certs${query ? `?${query}` : ""}`);
    } catch (e) {
      if (latest.isCurrent(t)) {
        setError((e as Error).message);
        setLoaded(true);
      }
      return;
    }
    if (!latest.isCurrent(t)) return;
    setError(null);
    setRows(data);
    setLoaded(true);
  }, [query, latest]);
  useEffect(() => { void load(); }, [load]);

  // Customer filter picker: fetched only once the caller is known to hold customers.view (§5.16
  // — a blocked control must say why, not silently sit empty), the parts/page.tsx precedent. A
  // failed fetch reports into `customersError`, NOT the shared `error` (#144): that channel is
  // cleared by every successful list load, so a picker failure would vanish on the next filter
  // change while the picker stayed broken. No `.catch(() => {})` silencing either way.
  useEffect(() => {
    if (!customersGate.allowed) return;
    api<CustomerOption[]>("/api/customers").then(setCustomers).catch((e) => setCustomersError((e as Error).message));
  }, [customersGate.allowed]);

  return (
    <div className="min-w-0 p-3 sm:p-6">
      {/* The list's one action is the export (spec §4.3); a cert is raised from its order, never
          here, so there is no New control. */}
      <PageHeader title="Certifications" subtitle="Results and printed state, identified by order."
        actions={<a href={`/api/certs/export${query ? `?${query}` : ""}`} className={BUTTON_NEUTRAL}>Export to Excel</a>} />

      {(error ?? permsError) && (
        <p className={`${NOTICE.refusal} mb-3`}>{error ?? permsError}</p>
      )}
      {customersError && (
        <p className={`${NOTICE.warning} mb-3`}>
          Could not load the customer filter: {customersError}
        </p>
      )}

      {/* The two presets are states of the Printed select (`src/lib/cert-list.ts`), derived from
          the filters, so the select below and the tabs always agree, and "Printed" lights neither. */}
      <ListTabs label="Certification views" tabs={CERT_PRESETS} active={presetFor(filters)}
                onSelect={(key) => setFilters(applyPreset(filters, key as CertPresetKey))} />
      {/* #643: each box is named by a label above it, in the board's words and the shipping list's
          form (the owner's answer of 2026-11-06); the placeholder options stay. */}
      <div className={`${CARD} mb-4 flex flex-wrap items-end gap-4 text-sm`}>
        <div>
          <label htmlFor="certs-search" className="block text-xs text-ink-500">Search</label>
          <input id="certs-search" value={filters.search} onChange={(e) => updateFilters({ search: e.target.value })}
                 placeholder="Search order # or customer" className={`${INPUT_COMPACT} w-64`} />
        </div>
        <div>
          <label htmlFor="certs-customer" className="block text-xs text-ink-500">Customer</label>
          <Combobox id="certs-customer" value={filters.customerId} options={customerOptions(customers, { blank: "All customers" })}
                  onSelect={(v) => updateFilters({ customerId: v })}
                  disabled={!customersGate.allowed} title={customersGate.allowed ? undefined : customersGate.title} ariaLabel="Customer" className="w-64" />
        </div>
        <div>
          <label htmlFor="certs-scope" className="block text-xs text-ink-500">Scope</label>
          <select id="certs-scope" value={filters.scope} onChange={(e) => updateFilters({ scope: e.target.value as CertScopeValue | "" })}
                  className={INPUT_COMPACT}>
            <option value="">All scopes</option>
            {CERT_SCOPES.map((s) => (
              <option key={s} value={s}>{CERT_SCOPE_LABELS[s]}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="certs-printed" className="block text-xs text-ink-500">Printed</label>
          <select id="certs-printed" value={filters.printed} onChange={(e) => updateFilters({ printed: e.target.value as CertPrinted })}
                  className={INPUT_COMPACT}>
            <option value="">Printed or not</option>
            <option value="1">Printed</option>
            <option value="0">Not printed</option>
          </select>
        </div>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={filters.includeVoided} onChange={(e) => updateFilters({ includeVoided: e.target.checked })} />
          Show voided
        </label>
      </div>

      <div className={`${CARD_FLUSH} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className={`${TABLE_HEAD} p-2`}>Order</th>
              <th className={`${TABLE_HEAD} p-2`}>Customer</th>
              <th className={`${TABLE_HEAD} p-2`}>Scope</th>
              <th className={`${TABLE_HEAD} p-2`}>Printed</th>
              <th className={`${TABLE_HEAD} p-2`}>Results</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={`border-t ${row.deletedAt ? "text-ink-500" : ""}`}>
                <td className={`${TABLE_CELL} font-mono`}>
                  <Link href={`/certs/${row.id}`} className={LINK}>{orderLabel(row)}</Link>
                  {row.deletedAt && (
                    <span className="ml-2 rounded bg-line px-1 text-xs text-ink-800">voided</span>
                  )}
                </td>
                <td className={TABLE_CELL}>{row.customerName}</td>
                <td className={TABLE_CELL}>{scopeCell(row)}</td>
                <td className={TABLE_CELL}>{row.printedAt ? "Yes" : "No"}</td>
                <td className={TABLE_CELL}>
                  {row.readingCount === 0 ? (
                    <span className="text-ink-500">—</span>
                  ) : (
                    resultSegments(row).map((seg, i) => (
                      <span key={seg.text} className={seg.className}>
                        {i > 0 && ", "}{seg.text}
                      </span>
                    ))
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && loaded && !error && (
              <tr><td className={`${TABLE_CELL} text-ink-500`} colSpan={5}>No certifications match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
