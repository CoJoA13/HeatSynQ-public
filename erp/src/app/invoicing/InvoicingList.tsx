"use client";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, trackedFetch } from "@/lib/fetcher";
import { newId } from "@/lib/client-id";
import { pruneCreateKeys, runInvoiceCreates, type CreateKeys } from "@/lib/invoice-create-keys";
import { invoiceFileName } from "@/lib/invoice-file-names";
import { printTickable } from "@/lib/invoice-printed";
import {
  confirmParts, printTicksAfterRun, pruneToTickable, resultText, runSelectedPrints, zipFileName, zipPrints,
} from "@/lib/print-selected";
import { askConfirm } from "@/lib/modal";
import { PageHeader } from "@/components/PageHeader";
import { ListTabs } from "@/components/ListTabs";
import { INVOICING_PRESETS, applyPreset, presetFor, type InvoicingPresetKey, type InvoicingView } from "@/lib/invoicing-list";
import { gate } from "@/lib/permission-ui";
import { ExportLink } from "@/lib/report-ui";
import { showAllClicked, showAllFor, windowNotice, type ListWindow, type ShowAll } from "@/lib/list-window";
import { exportState } from "@/lib/report-export-state";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { applySelectAll, selectAllState } from "@/lib/select-all";
import {
  INVOICE_STATUSES, INVOICE_STATUS_LABELS, INVOICE_KIND_LABELS,
  type InvoiceStatusValue, type InvoiceKindValue, type InvoicePrinted,
} from "@/lib/invoice-constants";
import {
  BUTTON_PRIMARY, BUTTON_PRIMARY_COMPACT, CARD, CARD_FLUSH, INPUT_COMPACT, LINK, NOTICE, TABLE_CELL, TABLE_HEAD,
} from "@/lib/ui-classes";

// Local mirrors of src/server/invoices.ts's InvoiceCandidate/InvoiceRegisterRow — not imported from
// src/server/** (CLAUDE.md "Constraints that will bite you": a client component pulling from
// there drags node:async_hooks and Prisma into the browser bundle). Both dates arrive
// pre-formatted "yyyy-mm-dd" strings (`formatDateOnly` runs server-side); `finalizedAt` and
// `printedAt` are the exceptions — the server hands each back as a full ISO datetime
// (`toISOString()`), so they are the fields displayed as browser-local timestamps rather than civil
// dates (the audit log / documents list precedent).
type InvoiceCandidate = {
  orderId: string; orderNumber: number; customerCode: string; customerName: string;
  poNumber: string; lastShipDate: string | null;
};
type InvoiceRegisterRow = {
  id: string; kind: InvoiceKindValue; status: InvoiceStatusValue;
  orderId: string; orderNumber: number; documentNumber: string;
  customerId: string; customerCode: string; customerName: string;
  invoiceDate: string; total: number; finalizedAt: string | null; deletedAt: string | null;
  // #591: the newest print since `finalizedAt` (src/lib/invoice-printed.ts), the credit number a
  // credit memo's zip entry is named by, and whether its order is voided (such a row takes no box).
  printedAt: string | null; creditNumber: number | null; orderVoided: boolean;
};

// The orders board / shipping list precedent: only the slice the customer filter picker needs.
type CustomerOption = { id: string; code: string; name: string };

/** The page's view and the register's filters (PR 6): the four views are `src/lib/invoicing-list.ts`'s
 *  presets over `view`, `status` and `printed`, so one is one `applyPreset`; `view` is never sent. */
type Filters = {
  view: InvoicingView; customerId: string; status: InvoiceStatusValue | ""; printed: InvoicePrinted | ""; from: string; to: string;
};
const DEFAULT_FILTERS: Filters = { view: "ready", customerId: "", status: "", printed: "", from: "", to: "" };

/** Mirrors `src/app/api/invoices/query.ts`'s `parseInvoiceFilter` in reverse — the
 *  `ShippingList.tsx` `buildQuery` precedent — so the list and its exports can never disagree
 *  about what a query string means. Candidates has no filters of its own (task-17-brief.md: only
 *  the "Invoices" section is filterable), so this is only ever built from `Filters`. */
function buildQuery(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.customerId) params.set("customerId", filters.customerId);
  if (filters.status) params.set("status", filters.status);
  if (filters.printed) params.set("printed", filters.printed);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  return params.toString();
}

/** Hands Print selected's zip to the browser as a download. The anchor is put in the document for
 *  its click and taken away after it, since an older browser downloads only from an anchor in the
 *  document. Its click reaches the Shell's capture-phase guard, which lets a link carrying `download`
 *  through without asking (`shouldGuardNavigation`'s `download` test, src/lib/unsaved-guard.ts). The
 *  bytes go to the Blob as they are: `zipPrints` answers `zipSync`'s `Uint8Array<ArrayBuffer>`,
 *  which a `BlobPart` takes. */
function downloadFile(bytes: Uint8Array<ArrayBuffer>, name: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function InvoicingList() {
  const { permissions: perms, error: permsError } = usePermissions();
  const customersGate = gate(perms, "customers.view");
  const createGate = gate(perms, "invoicing.create");

  // ---------------------------------------------------------------------------------------
  // Ready to invoice — candidates (order at SHIPPED, no live invoice), each row a checkbox.
  // ---------------------------------------------------------------------------------------
  const [candidates, setCandidates] = useState<InvoiceCandidate[]>([]);
  // A `loaded` flag distinct from "the array is empty" (HANDOFF §5.15 / Task 8's headline
  // defect): a failed fetch must say so, never render as a genuinely empty, healthy list.
  const [candidatesLoaded, setCandidatesLoaded] = useState(false);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [createErrors, setCreateErrors] = useState<Map<string, string>>(new Map());

  const candidatesLatest = useLatest();
  // Ticket-gated on BOTH the success and the rejection path (issues #5/#15 — a stale response
  // must never overwrite a newer one, in either direction). No `.catch(() => {})` anywhere.
  // Returns the candidate order ids it just APPLIED (null when it failed or was superseded, so
  // nothing was applied): createInvoices prunes `ticked` against exactly the list this load put
  // on screen, and cannot read it from `candidates` state — its updater closure is stale.
  const loadCandidates = useCallback(async (): Promise<Set<string> | null> => {
    const t = candidatesLatest.next();
    let data: InvoiceCandidate[];
    try {
      data = await api<InvoiceCandidate[]>("/api/invoices?candidates=1");
    } catch (e) {
      if (candidatesLatest.isCurrent(t)) {
        setCandidatesError((e as Error).message);
        setCandidatesLoaded(true);
      }
      return null;
    }
    if (!candidatesLatest.isCurrent(t)) return null;
    setCandidates(data);
    setCandidatesError(null);
    setCandidatesLoaded(true);
    return new Set(data.map((c) => c.orderId));
  }, [candidatesLatest]);
  useEffect(() => { void loadCandidates(); }, [loadCandidates]);

  function toggleTicked(orderId: string, checked: boolean) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (checked) next.add(orderId); else next.delete(orderId);
      return next;
    });
  }

  // C9a (#239): the header checkbox over the ready-to-invoice rows. The SELECTABLE set is the
  // rows whose own checkbox is not disabled — today that is every candidate row or none of them,
  // since all of them share `createGate`, but the header is written against the set rather than
  // against the gate so a per-row rule could never make it lie. Both the state it shows and the
  // set it writes come from `src/lib/select-all.ts`, where they can be mutation-proven.
  const selectableIds = createGate.allowed ? candidates.map((c) => c.orderId) : [];
  const selectAll = selectAllState(selectableIds, ticked);
  // `indeterminate` is a DOM PROPERTY with no HTML attribute, so React cannot render it — it is
  // written to the node after commit. The ref write lives in an effect, never in render (the
  // `react-hooks/refs` rule, and `loadInvoicesRef` below is the same shape).
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selectAll === "some";
  }, [selectAll]);

  // ---------------------------------------------------------------------------------------
  // Invoices — the filtered list + its two exports.
  // ---------------------------------------------------------------------------------------
  const [invoices, setInvoices] = useState<InvoiceRegisterRow[]>([]);
  const [invoicesLoaded, setInvoicesLoaded] = useState(false);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  // #592: the query of the list on screen, which both exports follow; null until a load has landed
  // (src/lib/report-export-state.ts's header says why never "").
  const [appliedQuery, setAppliedQuery] = useState<string | null>(null);
  // #591 Print selected: its own ticks (invoice ids), beside Ready to invoice's `ticked`.
  const [printTicked, setPrintTicked] = useState<Set<string>>(new Set());
  const [printing, setPrinting] = useState(false);
  const [printErrors, setPrintErrors] = useState<Map<string, string>>(new Map());
  // A printed row's folder sentence (`runSelectedPrints`' `warnings`), shown and cleared with the
  // failures.
  const [printWarnings, setPrintWarnings] = useState<Map<string, string>>(new Map());
  const [printResult, setPrintResult] = useState<string | null>(null);
  // The tickable ids of the list the last applied load put on screen, written by that load. A ref,
  // never state: `printSelected` reads it after its own reload has landed, where a state value in
  // its closure would still be the click's.
  const tickableRef = useRef<Set<string>>(new Set());
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  // #144: the picker fetch gets its OWN banner, never `invoicesError` — that channel is cleared
  // by every successful list load (so a picker failure vanished on the next filter change) and
  // its banner labels whatever lands in it "Could not load invoices", misnaming a picker failure.
  // The NewShipment `loadError` precedent: never auto-cleared — nothing retries the picker, so
  // nothing can honestly clear it.
  const [customersError, setCustomersError] = useState<string | null>(null);

  // Customer filter picker: fetched only once the caller is known to hold customers.view, never
  // left silently empty for someone who lacks it (§5.16) — the ShippingList precedent.
  useEffect(() => {
    if (!customersGate.allowed) return;
    api<CustomerOption[]>("/api/customers").then(setCustomers).catch((e) => setCustomersError((e as Error).message));
  }, [customersGate.allowed]);

  function updateFilters(patch: Partial<Filters>) {
    setFilters((prev) => ({ ...prev, ...patch }));
  }

  const query = buildQuery(filters);
  // Ruling R3 (#612): the list reads the newest 200 invoices (`?window=1`) and says so under the
  // filters; "show all" re-reads unbounded for the query it was clicked under only. The override is
  // the leaf's (`showAllFor`), asked by `loadInvoices` itself, as on the board: a stored click under
  // another query is dropped before any read and the drop re-runs the load windowed; each click is a
  // new attempt. The applied query both exports follow is never windowed.
  const [cut, setCut] = useState(false);
  const [showAllState, setShowAllState] = useState<ShowAll>(null);
  const invoicesLatest = useLatest();
  const loadInvoices = useCallback(async () => {
    const override = showAllFor(showAllState, query);
    if (override !== showAllState) { setShowAllState(override); return; } // the drop re-runs this load, windowed
    const t = invoicesLatest.next();
    let data: ListWindow<InvoiceRegisterRow>;
    try {
      data = await api<ListWindow<InvoiceRegisterRow>>(`/api/invoices?${query ? `${query}&` : ""}window=1${override !== null ? "&showAll=1" : ""}`);
    } catch (e) {
      if (invoicesLatest.isCurrent(t)) {
        setInvoicesError((e as Error).message);
        setInvoicesLoaded(true);
      }
      return;
    }
    if (!invoicesLatest.isCurrent(t)) return;
    setInvoices(data.rows);
    setCut(data.cut);
    setInvoicesError(null);
    setInvoicesLoaded(true);
    // #591 (591-7/8): a tick whose row this list draws no box for goes, so a filter that hides a
    // row drops its tick, and so does a row that has printed since. Only here, where the list on
    // screen is the one just applied: a failed or superseded load put nothing new on screen.
    const tickable = new Set(data.rows.filter((r) => printTickable(r)).map((r) => r.id));
    tickableRef.current = tickable;
    setPrintTicked((prev) => pruneToTickable(prev, tickable));
    // #592: the query this load was sent with, recorded only here for the same reason: a failed or
    // superseded load leaves both exports on the list still on screen.
    setAppliedQuery(query);
  }, [query, showAllState, invoicesLatest]);
  useEffect(() => { void loadInvoices(); }, [loadInvoices]);
  // Both links are live once a load has landed and export the list the last one put on screen,
  // never the filters as typed (src/lib/report-ui.tsx's ExportLink).
  const { exportable } = exportState(appliedQuery, query);
  // The list's sort is fixed, newest invoice date first, so the ruled sentence applies as written.
  const notice = windowNotice(cut, { newestFirst: true });

  // Stale-closure guard (Task 7): `createInvoices` can run a while (one sequential POST per
  // ticked order), and its captured `loadInvoices` closes over the filter query as of the click —
  // the post-run reload would re-ask that OLD query with the NEWEST ticket, defeating the gate
  // and leaving the table disagreeing with the filter controls. The reload goes through this
  // ref, updated every render (in an effect — the `react-hooks/refs` rule forbids a render-time
  // write), so it always closes over the CURRENT query. `loadCandidates` has no query axis, so
  // its captured closure cannot go stale — left as-is.
  const loadInvoicesRef = useRef(loadInvoices);
  useEffect(() => { loadInvoicesRef.current = loadInvoices; });

  // #568: the request key of each order whose Create got no answer, kept between runs and sent
  // again by the next one (src/lib/invoice-create-keys.ts, whose header says when a key is made,
  // kept and dropped). A ref, never state: nothing renders it, and a remount starts with none.
  const createKeys = useRef<CreateKeys>(new Map());

  // The run itself, one order in turn, is `runInvoiceCreates`, whose comment says why.
  async function createInvoices() {
    const orderIds = [...ticked];
    if (orderIds.length === 0 || creating) return;
    setCreating(true);
    const post = (orderId: string, clientRequestId: string) =>
      api("/api/invoices", { method: "POST", body: JSON.stringify({ orderId, clientRequestId }) });
    const failures = await runInvoiceCreates(orderIds, createKeys.current, post, newId);
    // §5.13: roll back to server truth FIRST, then report why. Reloading both lists before
    // setting the per-order failures means a succeeded order's row is never left stranded in
    // "Ready to invoice" for even a moment after the server has already moved it into "Invoices".
    const [applied] = await Promise.all([loadCandidates(), loadInvoicesRef.current()]);
    // A kept key whose order the reload no longer lists goes with it. Here in the handler, never
    // inside the `setTicked` updater below: an updater stays pure (React may defer, rebase or repeat
    // one), and the prune writes a ref.
    pruneCreateKeys(createKeys.current, applied);
    // #145: the checkboxes deliberately stay enabled during the run, so a tick added WHILE it
    // was in flight must survive it — the functional update keeps every failure ticked (the
    // failed rows stay selected beside their per-row errors, as before) plus any current tick
    // that was not part of this run's click-time `orderIds` snapshot; ticks for orders the run
    // processed successfully clear exactly as before. The whole post-run set — failures
    // included — is then intersected with the candidate ids the reload just applied (Codex
    // round 1, MR !154): a tick whose order left the list mid-run (invoiced by another
    // session) would otherwise be a phantom — no row renders its checkbox or its per-row
    // error, yet ticked.size keeps Create enabled and re-POSTs an order the operator cannot
    // see. When the reload failed or was superseded there is no freshly applied list to prune
    // against, and the rows still on screen (checkboxes included) are the stale ones — keeping
    // the un-pruned set stays consistent with what renders. The prune lives HERE, not at every
    // candidates load: only the post-run update owns reconciling ticks against a list it knows
    // just changed.
    const ran = new Set(orderIds);
    setTicked((prev) => {
      const next = new Set(failures.keys());
      for (const id of prev) if (!ran.has(id)) next.add(id);
      return applied === null ? next : new Set([...next].filter((id) => applied.has(id)));
    });
    setCreateErrors(failures);
    setCreating(false);
  }

  const createTitle = !createGate.allowed
    ? createGate.title
    : creating
      ? "Creating invoices…"
      : ticked.size === 0
        ? "Tick at least one order first"
        : undefined;

  // ---------------------------------------------------------------------------------------
  // Print selected (#591) — the Invoices table's boxes and its run.
  // ---------------------------------------------------------------------------------------
  function togglePrintTicked(invoiceId: string, checked: boolean) {
    setPrintTicked((prev) => {
      const next = new Set(prev);
      if (checked) next.add(invoiceId); else next.delete(invoiceId);
      return next;
    });
  }

  // The header box over the rows that draw a box (591-7), in the table's order, or none when the
  // caller may not create: the C9a shape above, over its own ticks.
  const printSelectable = createGate.allowed ? invoices.filter((r) => printTickable(r)).map((r) => r.id) : [];
  const printSelectAll = selectAllState(printSelectable, printTicked);
  const printSelectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (printSelectAllRef.current) printSelectAllRef.current.indeterminate = printSelectAll === "some";
  }, [printSelectAll]);

  // The ticked rows the table draws a box for, in its order: the rows a run sends and its confirm
  // counts, and the rows the button's title needs one of. Derived from the rows on screen rather
  // than from `printTicked.size`, so the title and the run read the same rows.
  const printRows = invoices.filter((r) => printTickable(r) && printTicked.has(r.id));

  // Whether the page is still mounted, for 591-6: leaving mid-run stops the run after the request
  // in flight. StrictMode's remount runs the effect again and sets it true again. A page kept alive
  // off screen (an Activity-style preservation) would break the check: hiding it would run the
  // cleanup and Back the effect again, on a page whose state was kept, so a run could stop with
  // `printing` left set, or carry on after the operator came back.
  const open = useRef(false);
  useEffect(() => {
    open.current = true;
    return () => { open.current = false; };
  }, []);

  // One selected print per ticked row, in the table's order; the run itself, what each answer
  // means and the ticks after it are src/lib/print-selected.ts's, whose comments say why.
  async function printSelected() {
    if (printing) return;
    const ids = printRows.map((r) => r.id);
    // A belt: the button is disabled while `printRows` is empty, so a click does not get here.
    if (ids.length === 0) return;
    // Ruling 5: the modal, the ruled sentence as its title and body (`confirmParts`).
    if (!(await askConfirm({ ...confirmParts(ids.length), confirm: "Print selected" }))) return;
    setPrinting(true);
    setPrintErrors(new Map());
    setPrintWarnings(new Map());
    setPrintResult(null);
    // The `finally` frees the button whatever throws below, but only while the page is open: once
    // it has gone nothing is set (591-6).
    try {
      const post = (id: string) => trackedFetch(`/api/invoices/${id}/print?selected=1`, { method: "POST" });
      const result = await runSelectedPrints(ids, post, () => open.current);
      // The page has gone: no zip, no reload and no state (591-6).
      if (!open.current) return;
      // Every print is filed before its zip is built, so a zip that cannot be built or handed over
      // (a run too large for the browser's memory) loses no print, and the run goes on: the reload,
      // the ticks, the failures and the closing line, which says so (the owner, 2026-10-21).
      let zipFailed = false;
      if (result.printed.length > 0) {
        try {
          const bytesById = new Map(result.printed.map((p) => [p.id, p.bytes]));
          const entries = printRows.flatMap((row) => {
            const bytes = bytesById.get(row.id);
            if (!bytes) return [];
            // A credit memo always carries its number: `createCredit` allocates it inside its
            // claim, and nothing else creates a credit.
            const number = row.kind === "CREDIT" ? row.creditNumber! : row.orderNumber;
            return [{ name: invoiceFileName(row.kind, number), bytes }];
          });
          downloadFile(zipPrints(entries), zipFileName(new Date()));
        } catch {
          zipFailed = true;
        }
      }
      // §5.13: server truth first, then the ticks and the messages. The tickable ids are read here,
      // after the reload, and handed to the updater, which stays pure: when the reload failed or
      // was superseded they are the last applied list's.
      await loadInvoicesRef.current();
      const tickable = tickableRef.current;
      const ran = new Set(ids);
      setPrintTicked((prev) => printTicksAfterRun(prev, ran, result.failures, tickable));
      setPrintErrors(result.failures);
      setPrintWarnings(result.warnings);
      setPrintResult(resultText(result.printed.length, ids.length, zipFailed));
    } finally {
      if (open.current) setPrinting(false);
    }
  }

  const printTitle = !createGate.allowed
    ? createGate.title
    : printing
      ? "Printing…"
      : printRows.length === 0
        ? "Tick at least one invoice first"
        : undefined;

  return (
    <div className="min-w-0 p-3 sm:p-6">
      {/* The title row (spec §4.3; PR 6): Create invoices is the Ready view's one action, so it is
          the header's while that view shows; the register's actions stay in its own bar. */}
      <PageHeader title="Invoicing" subtitle="Create drafts, resolve pricing, then finalize and print."
        actions={filters.view === "ready" ? (
          <button onClick={() => void createInvoices()} disabled={createTitle !== undefined} title={createTitle}
                  className={BUTTON_PRIMARY}>
            {creating ? "Creating…" : "Create invoices"}
          </button>
        ) : undefined} />

      {permsError && <p className={`${NOTICE.refusal} mb-3`}>{permsError}</p>}

      {/* The four views (src/lib/invoicing-list.ts): Ready to invoice is the candidates table alone;
          Drafts, To print and Register are settings of the register's Status and Printed selects,
          derived back from them, so the selects and the tabs always agree. */}
      <ListTabs label="Invoicing views" tabs={INVOICING_PRESETS} active={presetFor(filters)}
                onSelect={(key) => setFilters((prev) => applyPreset(prev, key as InvoicingPresetKey))} />

      {filters.view === "ready" ? (
      /* ----------------------------- Ready to invoice ----------------------------- */
      <section>
        <h2 className="mb-2 text-lg font-medium">Ready to invoice</h2>

        {candidatesError && (
          <p className={`${NOTICE.refusal} mb-3`}>
            Could not load candidates: {candidatesError}
          </p>
        )}

        <div className={`${CARD_FLUSH} overflow-x-auto`}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className={`${TABLE_HEAD} p-2`}>
                  {/* This one is named; the ROW boxes keep exactly the accessible name they
                      already have, which is none of their own (only the gate `title` when the
                      caller may not create). Naming them would be a change to the surface
                      `invoice-shipped-order`, `close-month-end` and `quotes` drive — and is a
                      different #239 item, not this one. */}
                  <input type="checkbox" ref={selectAllRef}
                         checked={selectAll === "all"}
                         disabled={selectableIds.length === 0}
                         title={!createGate.allowed ? createGate.title : candidates.length === 0 ? "No orders ready to invoice" : undefined}
                         aria-label="Select all orders ready to invoice"
                         onChange={(e) => setTicked((prev) => applySelectAll(prev, selectableIds, e.target.checked))} />
                </th>
                <th className={`${TABLE_HEAD} p-2`}>Order No</th>
                <th className={`${TABLE_HEAD} p-2`}>Customer</th>
                <th className={`${TABLE_HEAD} p-2`}>PO</th>
                <th className={`${TABLE_HEAD} p-2`}>Last Ship Date</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr key={c.orderId} className="border-t align-top">
                  <td className={TABLE_CELL}>
                    <input type="checkbox" checked={ticked.has(c.orderId)}
                           disabled={!createGate.allowed} title={createGate.allowed ? undefined : createGate.title}
                           onChange={(e) => toggleTicked(c.orderId, e.target.checked)} />
                  </td>
                  <td className={`${TABLE_CELL} font-mono`}>
                    <Link href={`/orders/${c.orderId}`} className={LINK}>{c.orderNumber}</Link>
                    {createErrors.has(c.orderId) && (
                      <p className="mt-1 max-w-xs text-xs text-red-700">{createErrors.get(c.orderId)}</p>
                    )}
                  </td>
                  <td className={TABLE_CELL}>{c.customerCode} · {c.customerName}</td>
                  <td className={TABLE_CELL}>{c.poNumber}</td>
                  <td className={TABLE_CELL}>{c.lastShipDate ? formatDate(c.lastShipDate) : ""}</td>
                </tr>
              ))}
              {candidates.length === 0 && candidatesLoaded && !candidatesError && (
                <tr><td colSpan={5} className={`${TABLE_CELL} text-center text-ink-500`}>No orders ready to invoice</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      ) : (
      /* ------------------------------- Invoices & credits ------------------------------- */
      <section>
        <h2 className="mb-2 text-lg font-medium">Invoices & credits</h2>

        {invoicesError && (
          <p className={`${NOTICE.refusal} mb-3`}>
            Could not load invoices: {invoicesError}
          </p>
        )}
        {customersError && (
          <p className={`${NOTICE.warning} mb-3`}>
            Could not load the customer filter: {customersError}
          </p>
        )}

        <div className={`${CARD} mb-3 flex flex-wrap items-end gap-4 text-sm`}>
          <div>
            <label htmlFor="invoicing-customer" className="block text-xs text-ink-500">Customer</label>
            <select id="invoicing-customer" value={filters.customerId} onChange={(e) => updateFilters({ customerId: e.target.value })}
                    disabled={!customersGate.allowed} title={customersGate.allowed ? undefined : customersGate.title}
                    className={`${INPUT_COMPACT} disabled:cursor-not-allowed disabled:bg-surface-50`}>
              <option value="">All customers</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
            </select>
          </div>

          <div>
            <label htmlFor="invoicing-status" className="block text-xs text-ink-500">Status</label>
            <select id="invoicing-status" value={filters.status}
                    onChange={(e) => updateFilters({ status: e.target.value as InvoiceStatusValue | "" })}
                    className={INPUT_COMPACT}>
              <option value="">All statuses</option>
              {INVOICE_STATUSES.map((s) => <option key={s} value={s}>{INVOICE_STATUS_LABELS[s]}</option>)}
            </select>
          </div>

          {/* PR 6: the server's Printed filter (`InvoiceFilter.printed`), the To print preset's own
              state with Status; the exports follow it as they follow the rest. */}
          <div>
            <label htmlFor="invoicing-printed" className="block text-xs text-ink-500">Printed</label>
            <select id="invoicing-printed" value={filters.printed}
                    onChange={(e) => updateFilters({ printed: e.target.value as InvoicePrinted | "" })}
                    className={INPUT_COMPACT}>
              <option value="">Printed or not</option>
              <option value="1">Printed</option>
              <option value="0">Not printed</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-ink-500">Invoice date</label>
            <div className="flex items-center gap-1">
              <input type="date" aria-label="Invoice date from" value={filters.from} onChange={(e) => updateFilters({ from: e.target.value })}
                     className={INPUT_COMPACT} />
              <span>&ndash;</span>
              <input type="date" aria-label="Invoice date to" value={filters.to} onChange={(e) => updateFilters({ to: e.target.value })}
                     className={INPUT_COMPACT} />
            </div>
          </div>

          <ExportLink base="/api/invoices/export" query={appliedQuery} ready={exportable} />
          <ExportLink base="/api/invoices/register" query={appliedQuery} ready={exportable} label="Export to PDF" />

          <div className="ml-auto flex items-center gap-2">
            {printResult && <span className="text-xs text-ink-500">{printResult}</span>}
            <button onClick={() => void printSelected()} disabled={printTitle !== undefined} title={printTitle}
                    className={BUTTON_PRIMARY_COMPACT}>
              {printing ? "Printing…" : "Print selected"}
            </button>
          </div>
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
                <th className={`${TABLE_HEAD} p-2`}>
                  {/* Named, as Ready to invoice's header box is; the row boxes have no name of
                      their own, as Ready's rows have none. */}
                  <input type="checkbox" ref={printSelectAllRef}
                         checked={printSelectAll === "all"}
                         disabled={printSelectable.length === 0}
                         title={!createGate.allowed ? createGate.title : undefined}
                         aria-label="Select all finalized invoices not yet printed"
                         onChange={(e) => {
                           // Read in the handler, never inside the updater, which React may run later.
                           const checked = e.target.checked;
                           setPrintTicked((prev) => applySelectAll(prev, printSelectable, checked));
                         }} />
                </th>
                <th className={`${TABLE_HEAD} p-2`}>Document No</th>
                <th className={`${TABLE_HEAD} p-2`}>Order No</th>
                <th className={`${TABLE_HEAD} p-2`}>Customer</th>
                <th className={`${TABLE_HEAD} p-2`}>Kind</th>
                <th className={`${TABLE_HEAD} p-2`}>Invoice Date</th>
                <th className={`${TABLE_HEAD} p-2`}>Status</th>
                <th className={`${TABLE_HEAD} text-right p-2`}>Total</th>
                <th className={`${TABLE_HEAD} p-2`}>Finalized</th>
                <th className={`${TABLE_HEAD} p-2`}>Printed</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-t">
                  <td className={TABLE_CELL}>
                    {printTickable(inv) && (
                      <input type="checkbox" checked={printTicked.has(inv.id)}
                             disabled={!createGate.allowed} title={createGate.allowed ? undefined : createGate.title}
                             onChange={(e) => togglePrintTicked(inv.id, e.target.checked)} />
                    )}
                  </td>
                  <td className={`${TABLE_CELL} font-mono`}>
                    <Link href={`/invoicing/${inv.id}`} className={LINK}>{inv.documentNumber}</Link>
                    {printErrors.has(inv.id) && (
                      <p className="mt-1 max-w-xs text-xs text-red-700">{printErrors.get(inv.id)}</p>
                    )}
                    {/* A row that printed but was not filed in its customer folder says why here, as
                        a refusal does (the owner's ruling of 2026-10-21, relayed): the single
                        Print's sentence, in its amber. A row has one or the other, never both. */}
                    {printWarnings.has(inv.id) && (
                      <p className="mt-1 max-w-xs text-xs text-accent-600">{printWarnings.get(inv.id)}</p>
                    )}
                  </td>
                  <td className={`${TABLE_CELL} font-mono`}>{inv.orderNumber}</td>
                  <td className={TABLE_CELL}>{inv.customerCode} · {inv.customerName}</td>
                  <td className={TABLE_CELL}>{INVOICE_KIND_LABELS[inv.kind]}</td>
                  <td className={TABLE_CELL}>{formatDate(inv.invoiceDate)}</td>
                  <td className={TABLE_CELL}>{INVOICE_STATUS_LABELS[inv.status]}</td>
                  <td className={`${TABLE_CELL} tabular-nums text-right`}>{formatMoney(inv.total)}</td>
                  <td className={TABLE_CELL}>{inv.finalizedAt ? formatDateTime(inv.finalizedAt) : ""}</td>
                  <td className={TABLE_CELL}>{inv.printedAt ? formatDateTime(inv.printedAt) : ""}</td>
                </tr>
              ))}
              {invoices.length === 0 && invoicesLoaded && !invoicesError && (
                <tr><td colSpan={10} className={`${TABLE_CELL} text-center text-ink-500`}>No invoices</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      )}
    </div>
  );
}
