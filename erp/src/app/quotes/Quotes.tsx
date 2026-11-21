"use client";
import { formatDate, formatNumber } from "@/lib/format";
// The /quotes list (spec §5.4, ruling 11; the UX redesign PR 3, 2026-10-31): ONE searchable,
// filterable register with Excel export, under three preset tabs (Follow-up due / Expired / All
// quotes) that set the Follow-up due box and the Status select — the two §5.4 worklists are those
// filters verbatim (`followUpDue=1`, `expired=1`), so the worklist request, its counts and the
// rows' Close button that PR 3 removed showed nothing the register cannot. The follow-up date is
// edited in place on every row (the "bump it a week" action). Deliberately NOT the order board's
// saved-views machinery. Plus the "New quote" creation path (the ReceivablesList "New batch"
// precedent: a small form section that POSTs and lands on the new record's own detail page, where
// the server-side defaults — quote number, dates, default ending statement — are then visible).
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { QUOTE_STATUS_LABELS, QUOTE_EXPIRED_LABEL, type QuoteStatusValue } from "@/lib/quote-constants";
import {
  DEFAULT_FILTERS, QUOTE_PRESETS, applyPreset, buildQuery, presetFor, sortForPreset,
  type QuoteFilters, type QuotePresetKey, type StatusFilter,
} from "@/lib/quote-list";
import { PageHeader } from "@/components/PageHeader";
import { ListTabs } from "@/components/ListTabs";
import type { QuoteDetailData, QuoteMutationData, QuoteRowData } from "./quote-form";
import {
  BADGE_WARNING, BUTTON_PRIMARY, BUTTON_PRIMARY_COMPACT, CARD, CARD_FLUSH, INPUT_COMPACT, LINK, NOTICE,
  TABLE_CELL, TABLE_HEAD,
} from "@/lib/ui-classes";

// The orders board / InvoicingList precedent: only the slice each picker renders.
type CustomerOption = { id: string; code: string; name: string };
type PartOption = { id: string; customerId: string; partNumber: string; name: string; active: boolean };

/** The derived display state, everywhere (ruling 3): an OPEN quote past expiry reads "Expired" —
 *  matching what the server's own Excel export prints for the same row. */
const statusLabel = (r: { status: QuoteStatusValue; expired: boolean }): string =>
  (r.expired ? QUOTE_EXPIRED_LABEL : QUOTE_STATUS_LABELS[r.status]);

export function Quotes() {
  const router = useRouter();
  const { permissions: perms, error: permsError } = usePermissions();
  const editGate = gate(perms, "quotes.edit");
  const createGate = gate(perms, "quotes.create");
  const customersGate = gate(perms, "customers.view");
  const partsGate = gate(perms, "parts.view");

  const [error, setError] = useState<string | null>(null);
  // The two pickers' own line (P6, the customer page's `optionsError` shape): every list read that
  // lands clears `error`, so a picker failure written there vanished while the picker stayed empty.
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const addOptionsError = useCallback((message: string) => {
    setOptionsError((cur) => (cur ? `${cur} ${message}` : message));
  }, []);

  // ---------------------------------------------------------------------------------------
  // The register — search + filters + export, under the presets.
  // ---------------------------------------------------------------------------------------
  const [rows, setRows] = useState<QuoteRowData[]>([]);
  // A `loaded` flag distinct from "the array is empty" (HANDOFF §5.15) — a failed fetch must say
  // so, never render as a genuinely empty, healthy list.
  const [loaded, setLoaded] = useState(false);
  const [filters, setFilters] = useState<QuoteFilters>(DEFAULT_FILTERS);
  // Ruling R3 (#612): the list and its Export link read the term 250 ms after the last keystroke.
  const debouncedSearch = useDebouncedValue(filters.search);
  const query = buildQuery({ ...filters, search: debouncedSearch });

  const listLatest = useLatest();
  // Ticket-gated on BOTH the success and the rejection path (the parts/page.tsx F7 rule): a
  // superseded request's rejection must not overwrite fresh rows with a stale failure.
  const loadList = useCallback(async () => {
    const t = listLatest.next();
    let data: QuoteRowData[];
    try {
      data = await api<QuoteRowData[]>(`/api/quotes${query ? `?${query}` : ""}`);
    } catch (e) {
      if (listLatest.isCurrent(t)) { setError((e as Error).message); setLoaded(true); }
      return;
    }
    if (!listLatest.isCurrent(t)) return;
    setRows(data);
    setError(null);
    setLoaded(true);
  }, [query, listLatest]);
  useEffect(() => { void loadList(); }, [loadList]);
  // The newest `loadList`, for a reload that follows a write: `bumpFollowUp`'s closure holds the
  // render's `query`, and a filter or preset changed while its PATCH was out would otherwise be
  // re-read under the OLD query on a newer ticket, which wins (the whole-branch review's finding 6).
  const loadListRef = useRef(loadList);
  useEffect(() => { loadListRef.current = loadList; }, [loadList]);

  function updateFilters(patch: Partial<QuoteFilters>) {
    setFilters((prev) => ({ ...prev, ...patch }));
  }

  // Customer picker (filter + New quote): fetched only once the caller is known to hold
  // customers.view, never left silently empty for someone who lacks it (§5.16 — the
  // InvoicingList precedent).
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  useEffect(() => {
    if (!customersGate.allowed) return;
    api<CustomerOption[]>("/api/customers").then(setCustomers)
      .catch((e) => addOptionsError(`Could not load customers: ${(e as Error).message}`));
  }, [customersGate.allowed, addOptionsError]);

  // ---------------------------------------------------------------------------------------
  // The in-place follow-up date: a date picker that PATCHes the quote (ruling 11) and reads the
  // list again — a bumped quote leaves the Follow-up due preset on that read.
  // ---------------------------------------------------------------------------------------

  // #145 (one request in flight per row): <input type="date"> fires onChange per segment, so
  // without an in-flight guard two unordered PATCHes for the SAME quote can persist the EARLIER
  // pick. Keyed by quote id — a Set, not a scalar, because different rows' bumps are independent
  // and a scalar would forget row A's in-flight PATCH the moment row B started.
  const [bumpingIds, setBumpingIds] = useState<Set<string>>(new Set());

  async function bumpFollowUp(row: QuoteRowData, value: string) {
    if (bumpingIds.has(row.id)) return; // belt to the disabled input's braces
    setBumpingIds((cur) => new Set(cur).add(row.id));
    // Optimistic in the row; rolled back to server truth FIRST on failure, then reported (§5.13).
    setRows((cur) => cur.map((r) => (r.id === row.id ? { ...r, followUpDate: value || null } : r)));
    try {
      await api<QuoteDetailData>(`/api/quotes/${row.id}`, {
        method: "PATCH", body: JSON.stringify({ followUpDate: value || null }),
      });
      await loadListRef.current();
      setError(null);
    } catch (e) {
      await loadListRef.current();
      setError((e as Error).message);
    } finally {
      setBumpingIds((cur) => { const next = new Set(cur); next.delete(row.id); return next; });
    }
  }

  // ---------------------------------------------------------------------------------------
  // New quote (the ReceivablesList "New batch" precedent). createQuote requires a customer and
  // at least one line (spec §5.1); the first line is either a memorized part or a free-text
  // part number (ruling 1) — everything else (dates, number, ending statement, quotedBy) is
  // server-defaulted and surfaced on the detail page this navigates to.
  // ---------------------------------------------------------------------------------------
  const [parts, setParts] = useState<PartOption[]>([]);
  useEffect(() => {
    if (!partsGate.allowed) return;
    api<PartOption[]>("/api/parts").then(setParts)
      .catch((e) => addOptionsError(`Could not load parts: ${(e as Error).message}`));
  }, [partsGate.allowed, addOptionsError]);

  const [draft, setDraft] = useState({ customerId: "", partId: "", partNumberText: "" });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Set only when the create SUCCEEDS with non-empty ruling-7 overlap warnings — the NewShipment
  // `savedShipment` precedent (§5.7: a warning returned alongside a successful save must be
  // SEEN, never raced past by an immediate navigate). Zero warnings navigates immediately,
  // exactly as before; navigating away (Go to quote) is what dismisses the panel.
  const [createdQuote, setCreatedQuote] =
    useState<{ id: string; quoteNumber: number; warnings: string[] } | null>(null);
  const customerParts = draft.customerId
    ? parts.filter((p) => p.customerId === draft.customerId && p.active) : [];

  async function createQuote() {
    if (!draft.customerId) { setCreateError("Pick a customer first."); return; }
    if (!draft.partId && !draft.partNumberText.trim()) {
      setCreateError("Pick a part or enter a free-text part number for the first line.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const created = await api<QuoteMutationData>("/api/quotes", {
        method: "POST",
        body: JSON.stringify({
          customerId: draft.customerId,
          lines: [draft.partId
            ? { partId: draft.partId, prices: [] }
            : { partNumberText: draft.partNumberText.trim(), prices: [] }],
        }),
      });
      if (created.warnings.length > 0) {
        setCreating(false);
        setCreatedQuote({ id: created.id, quoteNumber: created.quoteNumber, warnings: created.warnings });
        void loadList(); // the quote is real — the register below should show it
      } else {
        router.push(`/quotes/${created.id}`);
      }
    } catch (e) {
      setCreateError((e as Error).message);
      setCreating(false);
    }
  }

  const createTitle = !createGate.allowed ? createGate.title : creating ? "Creating…" : undefined;

  // A worklist view is shown oldest debt first (`sortForPreset`); the register as the server sends it.
  const preset = presetFor(filters);
  const shown = sortForPreset(rows, preset);

  // ---------------------------------------------------------------------------------------
  // Rendering.
  // ---------------------------------------------------------------------------------------

  return (
    <div className="min-w-0 p-3 sm:p-6">
      <PageHeader title="Quotes" subtitle="Standing price agreements, with their follow-ups." />

      {(error ?? permsError) && (
        <p className={`${NOTICE.refusal} mb-3`}>{error ?? permsError}</p>
      )}
      {optionsError && <p className={`${NOTICE.warning} mb-3`}>{optionsError}</p>}

      {/* ------------------------------ New quote ------------------------------ */}
      <section className={`${CARD} mb-6`}>
        <h2 className="mb-2 font-medium">New quote</h2>
        {createError && <p className="mb-2 text-sm text-red-700">{createError}</p>}
        {createdQuote ? (
          // A create that succeeded WITH ruling-7 overlap warnings stops here instead of
          // navigating straight past them (the NewShipment precedent). The form is gone — the
          // quote exists, and a stray second "New quote" from a kept-alive form is exactly what
          // this panel prevents. The warnings warn; they never block.
          <div className="rounded border border-success-700 bg-success-50 p-4">
            <p className="mb-2 font-medium">Quote #{createdQuote.quoteNumber} created.</p>
            <ul className="mb-3 list-disc space-y-0.5 pl-5 text-sm text-accent-600">
              {createdQuote.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => router.push(`/quotes/${createdQuote.id}`)}
                      className={BUTTON_PRIMARY_COMPACT}>
                Go to quote
              </button>
              {/* The dismiss affordance (#100 item 8): stay put, drop the panel, and refresh the
                  register so the created quote shows below. The draft is cleared with it — the
                  panel exists to prevent a stray second "New quote" from a kept-alive form. */}
              <button type="button"
                      onClick={() => {
                        setCreatedQuote(null);
                        setDraft({ customerId: "", partId: "", partNumberText: "" });
                        void loadList();
                      }}
                      className="text-sm text-ink-500 underline">
                Stay on this page
              </button>
            </div>
          </div>
        ) : (
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="block">
            Customer
            <select value={draft.customerId}
                    disabled={createGate.disabled || !customersGate.allowed}
                    title={createGate.disabled ? createGate.title : customersGate.allowed ? undefined : customersGate.title}
                    onChange={(e) => setDraft({ customerId: e.target.value, partId: "", partNumberText: draft.partNumberText })}
                    className={`${INPUT_COMPACT} mt-1 block disabled:cursor-not-allowed disabled:bg-surface-50`}>
              <option value="">Customer…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
            </select>
          </label>
          <label className="block">
            First line: part
            <select value={draft.partId}
                    disabled={createGate.disabled || !partsGate.allowed || !draft.customerId || draft.partNumberText.trim() !== ""}
                    title={createGate.disabled ? createGate.title
                      : !partsGate.allowed ? partsGate.title
                        : !draft.customerId ? "Pick a customer first"
                          : draft.partNumberText.trim() !== "" ? "Clear the free-text part number to pick a memorized part"
                            : undefined}
                    onChange={(e) => setDraft({ ...draft, partId: e.target.value })}
                    className={`${INPUT_COMPACT} mt-1 block disabled:cursor-not-allowed disabled:bg-surface-50`}>
              <option value="">Part…</option>
              {customerParts.map((p) => <option key={p.id} value={p.id}>{p.partNumber} — {p.name}</option>)}
            </select>
          </label>
          <label className="block">
            …or free-text part number
            <input value={draft.partNumberText}
                   disabled={createGate.disabled || draft.partId !== ""}
                   title={createGate.disabled ? createGate.title
                     : draft.partId !== "" ? "Clear the part pick to enter a free-text line" : undefined}
                   onChange={(e) => setDraft({ ...draft, partNumberText: e.target.value })}
                   placeholder="e.g. GEAR-77 REV B"
                   className={`${INPUT_COMPACT} mt-1 block disabled:cursor-not-allowed disabled:bg-surface-50`} />
          </label>
          {/* The screen's one primary action (spec §4.3). */}
          <button onClick={() => void createQuote()} disabled={createTitle !== undefined} title={createTitle}
                  className={BUTTON_PRIMARY}>
            {creating ? "Creating…" : "New quote"}
          </button>
        </div>
        )}
      </section>

      {/* ---------------------------- The register ---------------------------- */}
      {/* The presets are derived from the filters (`presetFor`): a status or follow-up edit by
          hand lights no tab, and a tab click is a filter edit like any other, so the fetch and
          the Export link follow it. */}
      <ListTabs label="Quote views" tabs={QUOTE_PRESETS} active={preset}
                onSelect={(key) => updateFilters(applyPreset(filters, key as QuotePresetKey))} />
      <section aria-label="Quotes list">
        <div className={`${CARD} mb-4 flex flex-wrap items-end gap-4 text-sm`}>
          <div>
            <label htmlFor="quotes-search" className="block text-xs text-ink-500">Search</label>
            <input id="quotes-search" value={filters.search} onChange={(e) => updateFilters({ search: e.target.value })}
                   placeholder="Number, customer, RFQ, part"
                   className={`${INPUT_COMPACT} w-56`} />
          </div>
          <div>
            <label htmlFor="quotes-status" className="block text-xs text-ink-500">Status</label>
            <select id="quotes-status" value={filters.status}
                    onChange={(e) => updateFilters({ status: e.target.value as StatusFilter })}
                    className={INPUT_COMPACT}>
              <option value="">All statuses</option>
              <option value="OPEN">{QUOTE_STATUS_LABELS.OPEN}</option>
              <option value="CLOSED">{QUOTE_STATUS_LABELS.CLOSED}</option>
              <option value="EXPIRED">{QUOTE_EXPIRED_LABEL} (derived)</option>
            </select>
          </div>
          <label className="flex items-center gap-1 pb-1">
            <input type="checkbox" checked={filters.followUpDue}
                   onChange={(e) => updateFilters({ followUpDue: e.target.checked })} />
            Follow-up due
          </label>
          <div>
            <label htmlFor="quotes-customer" className="block text-xs text-ink-500">Customer</label>
            <select id="quotes-customer" value={filters.customerId} onChange={(e) => updateFilters({ customerId: e.target.value })}
                    disabled={!customersGate.allowed} title={customersGate.allowed ? undefined : customersGate.title}
                    className={`${INPUT_COMPACT} disabled:cursor-not-allowed disabled:bg-surface-50`}>
              <option value="">All customers</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-ink-500">Quote date</label>
            <div className="flex items-center gap-1">
              <input type="date" aria-label="Quote date from" value={filters.quoteFrom} onChange={(e) => updateFilters({ quoteFrom: e.target.value })}
                     className={INPUT_COMPACT} />
              <span>&ndash;</span>
              <input type="date" aria-label="Quote date to" value={filters.quoteTo} onChange={(e) => updateFilters({ quoteTo: e.target.value })}
                     className={INPUT_COMPACT} />
            </div>
          </div>
          <div>
            <label className="block text-xs text-ink-500">Effective</label>
            <div className="flex items-center gap-1">
              <input type="date" aria-label="Effective date from" value={filters.effectiveFrom} onChange={(e) => updateFilters({ effectiveFrom: e.target.value })}
                     className={INPUT_COMPACT} />
              <span>&ndash;</span>
              <input type="date" aria-label="Effective date to" value={filters.effectiveTo} onChange={(e) => updateFilters({ effectiveTo: e.target.value })}
                     className={INPUT_COMPACT} />
            </div>
          </div>
          <div>
            <label className="block text-xs text-ink-500">Expires</label>
            <div className="flex items-center gap-1">
              <input type="date" aria-label="Expiry date from" value={filters.expiryFrom} onChange={(e) => updateFilters({ expiryFrom: e.target.value })}
                     className={INPUT_COMPACT} />
              <span>&ndash;</span>
              <input type="date" aria-label="Expiry date to" value={filters.expiryTo} onChange={(e) => updateFilters({ expiryTo: e.target.value })}
                     className={INPUT_COMPACT} />
            </div>
          </div>
          <a href={`/api/quotes/export${query ? `?${query}` : ""}`} className={`${LINK} pb-1`}>
            Export to Excel
          </a>
        </div>

        <div className={`${CARD_FLUSH} overflow-x-auto`}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className={`${TABLE_HEAD} p-2`}>Quote</th>
                <th className={`${TABLE_HEAD} p-2`}>Customer</th>
                <th className={`${TABLE_HEAD} p-2`}>Status</th>
                <th className={`${TABLE_HEAD} p-2`}>Quote date</th>
                <th className={`${TABLE_HEAD} p-2`}>Effective</th>
                <th className={`${TABLE_HEAD} p-2`}>Expires</th>
                <th className={`${TABLE_HEAD} p-2`}>Follow-up</th>
                <th className={`${TABLE_HEAD} p-2`}>RFQ</th>
                <th className={`${TABLE_HEAD} p-2 text-right`}>Lines</th>
                <th className={`${TABLE_HEAD} p-2`}>Quoted by</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className={`${TABLE_CELL} font-mono`}>
                    <Link href={`/quotes/${r.id}`} className={LINK}>{r.quoteNumber}</Link>
                  </td>
                  <td className={TABLE_CELL}>{r.customerCode} · {r.customerName}</td>
                  <td className={TABLE_CELL}>
                    <span className={r.expired ? BADGE_WARNING : undefined}>
                      {statusLabel(r)}
                    </span>
                  </td>
                  <td className={TABLE_CELL}>{formatDate(r.quoteDate)}</td>
                  <td className={TABLE_CELL}>{formatDate(r.effectiveDate)}</td>
                  <td className={TABLE_CELL}>{formatDate(r.expiryDate)}</td>
                  <td className={TABLE_CELL}>
                    {/* Bump follow-up in place (ruling 11), gated quotes.edit with the §5.16
                        tooltip. Clearing the date is legal (null). Disabled while this row's own
                        PATCH is in flight (#145), and on a closed quote, which the server refuses
                        to edit (`updateQuote`; the register shows closed rows where the worklists
                        never did — Codex on #835): the quote page's own reopen-first sentence. */}
                    <input type="date" value={r.followUpDate ?? ""}
                           disabled={editGate.disabled || r.status !== "OPEN" || bumpingIds.has(r.id)}
                           title={bumpingIds.has(r.id) ? "Saving…"
                             : r.status !== "OPEN" ? "This quote is closed — reopen it before editing"
                               : editGate.title}
                           aria-label={`Quote ${r.quoteNumber} follow-up date`}
                           onChange={(e) => void bumpFollowUp(r, e.target.value)}
                           className={`${INPUT_COMPACT} disabled:cursor-not-allowed disabled:bg-surface-50`} />
                  </td>
                  <td className={TABLE_CELL}>{r.rfqNumber}</td>
                  <td className={`${TABLE_CELL} tabular-nums text-right`}>{formatNumber(r.lineCount)}</td>
                  <td className={TABLE_CELL}>{r.quotedByName}</td>
                </tr>
              ))}
              {rows.length === 0 && loaded && !error && (
                <tr><td colSpan={10} className="p-4 text-center text-ink-500">No quotes</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
