"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { showAllClicked, showAllFor, windowNotice, type ListWindow, type ShowAll } from "@/lib/list-window";
import { askConfirm } from "@/lib/modal";
import { swapAt } from "@/lib/reorder";
import { type OrderStatusValue } from "@/lib/order-constants";
import {
  BOARD_COLUMNS, defaultViewConfig, normalizeViewConfig, buildOrderQuery,
  type ColumnDef, type ColumnKey, type ColumnState, type BoardFilters, type SortState, type ViewConfig,
  sameViewConfig,
} from "@/lib/board-columns";
// The presentational split (#33's bounded slice): the four components render what this page's
// state says and report every interaction back up through props — all state, fetching, and the
// use-latest/viewsReady discipline stay HERE. The row/option types each component displays are
// declared beside the component that renders them and imported back for this page's state.
import { SavedViewsBar, type SavedViewRow } from "./board-parts/SavedViewsBar";
import { FilterBar, type CustomerOption } from "./board-parts/FilterBar";
import { ColumnPicker } from "./board-parts/ColumnPicker";
import { BoardTable, type BoardRow } from "./board-parts/BoardTable";
import { BUTTON_PRIMARY, CARD, CARD_FLUSH, LINK, NOTICE } from "@/lib/ui-classes";
import { PageHeader } from "@/components/PageHeader";
import { ListTabs } from "@/components/ListTabs";
import { BOARD_PRESETS, applyPreset, presetFor, type BoardPresetKey } from "@/lib/board-presets";
import { oneShotHold } from "@/lib/single-flight";

export default function OrdersPage() {
  const router = useRouter();
  const { permissions: perms, error: permsError } = usePermissions();

  const [rows, setRows] = useState<BoardRow[]>([]);
  // #223 item 4: distinct from "the array is empty" (the CertList/InvoicingList convention). The
  // board makes TWO sequential round trips on every visit (saved views, then this load), and
  // "No orders match these filters." rendered through both — an in-flight first fetch is not a
  // filter result. Only ever false→true, so it needs no ticket of its own.
  const [loaded, setLoaded] = useState(false);
  // Lazy initializers (the use-latest.ts precedent): `defaultViewConfig()` only ever needs to run
  // once, on mount. A plain `defaultViewConfig()` call in the render body would recompute it on
  // every render just to throw the result away — `useState` only reads its argument on the FIRST
  // render, so passing a function defers the call to exactly that render instead.
  const [columns, setColumns] = useState<ColumnState[]>(() => defaultViewConfig().columns);
  const [filters, setFilters] = useState<BoardFilters>(() => defaultViewConfig().filters);
  const [sort, setSort] = useState<SortState>(() => {
    const d = defaultViewConfig();
    return { sort: d.sort, dir: d.dir };
  });
  const [error, setError] = useState<string | null>(null);
  // The two supplementary reads' own lines (P6, the CertList #144 shape): every board read that
  // lands clears `error`, so a failure written there vanished while the control stayed empty.
  const [viewsLoadError, setViewsLoadError] = useState<string | null>(null);
  const [customersError, setCustomersError] = useState<string | null>(null);

  const [customers, setCustomers] = useState<CustomerOption[]>([]);

  const [savedViews, setSavedViews] = useState<SavedViewRow[]>([]);
  const [selectedViewId, setSelectedViewId] = useState<string>("");
  // Gates the board's own fetch until the mount-time saved-views lookup has decided whether a
  // default view's config should replace the built-in default — without this, the board would
  // fetch once with the built-in default filters and then immediately refetch again the instant
  // that lookup resolves, for every user who has a default view configured at all.
  const [viewsReady, setViewsReady] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveDefault, setSaveDefault] = useState(false);
  // #145 (one request in flight per toggle): the Set-as-default checkbox stays enabled through its
  // PATCH otherwise, and two clicks faster than a round trip issue two
  // unordered updates — if the first lands second, the database keeps the first click's value
  // while the local mirror below shows the second's, and nothing ever reveals the divergence.
  const [settingDefault, setSettingDefault] = useState(false);
  // R20 (#683): Update view writes the on-screen arrangement into the selected saved view; one
  // PATCH at a time (#145), its refusal shown in the bar beside the control (ruling R1).
  const [updatingView, setUpdatingView] = useState(false);
  // #720: Save view's hold, so a second click while the POST is out sends nothing (a second view
  // of the same name would be refused once the first landed). The bar reads it as `savingView`.
  const [savingView, setSavingView] = useState(false);
  const [saveViewHold] = useState(() => oneShotHold(setSavingView));
  const [viewError, setViewError] = useState<string | null>(null);

  const canCreateOrder = gate(perms, "orders.create");
  const customersGate = gate(perms, "customers.view");

  // Loads the caller's saved views once on mount and applies whichever one (if any) is marked
  // default — "applied on load", spec §11. Runs regardless of outcome (success or failure) so a
  // saved-views hiccup can never permanently block the board itself from loading with the
  // built-in default.
  useEffect(() => {
    api<SavedViewRow[]>("/api/saved-views")
      .then((views) => {
        setSavedViews(views);
        const def = views.find((v) => v.isDefault);
        if (def) {
          const cfg = normalizeViewConfig(def.config);
          setColumns(cfg.columns);
          setFilters(cfg.filters);
          setSort({ sort: cfg.sort, dir: cfg.dir });
          setSelectedViewId(def.id);
        }
      })
      .catch((e) => setViewsLoadError((e as Error).message))
      .finally(() => setViewsReady(true));
  }, []);

  // Customer filter picker: fetched only once the caller is known to hold customers.view, never
  // left silently empty for someone who lacks it (§5.16 — a blocked control must say why). The
  // parts/page.tsx precedent, applied to a filter picker rather than an add-row.
  // includeInactive=1 (#45, the rider-part picker precedent at orders/[id]/page.tsx): a saved
  // view can filter on a customer made inactive SINCE it was saved — the orders query still
  // applies that customerId, so without the inactive rows the select showed no matching option
  // and the board (and its Excel export) stayed silently scoped to one customer. An inactive
  // customer must remain a visible, NAMED filter choice.
  useEffect(() => {
    if (!customersGate.allowed) return;
    api<CustomerOption[]>("/api/customers?includeInactive=1")
      .then(setCustomers).catch((e) => setCustomersError((e as Error).message));
  }, [customersGate.allowed]);

  // Ruling R3 (#612): the list, and the Export link built from the same query string, read the
  // search term 250 ms after the last keystroke; the box keeps the raw text.
  const debouncedSearch = useDebouncedValue(filters.search);
  const queryString = buildOrderQuery({ ...filters, search: debouncedSearch }, sort);
  const query = viewsReady ? queryString : null;
  // Ruling R3 (#612): the board reads the first 200 rows of the applied sort (`?window=1`) and says
  // so under the filters; "show all" re-reads unbounded for the query it was clicked under only.
  // The override is the leaf's (`showAllFor`), asked by `load` itself: a stored click under another
  // query is dropped there, before any read, and the drop re-runs the load windowed, so a return to
  // that query is windowed again; each click is a new attempt, so a click after a failed read sends
  // again. The Export link's query string is never windowed.
  const [cut, setCut] = useState(false);
  const [showAllState, setShowAllState] = useState<ShowAll>(null);

  const latest = useLatest();
  // F7 (parts/page.tsx precedent): the catch must be ticket-gated too, not just the success path
  // — otherwise a superseded request's rejection can land after a newer request already
  // succeeded and overwrite fresh rows with a stale failure message.
  const load = useCallback(async () => {
    if (query === null) return; // viewsReady not yet settled — nothing to fetch yet
    const override = showAllFor(showAllState, query);
    if (override !== showAllState) { setShowAllState(override); return; } // the drop re-runs this load, windowed
    const t = latest.next();
    let data: ListWindow<BoardRow>;
    try {
      data = await api<ListWindow<BoardRow>>(`/api/orders?${query ? `${query}&` : ""}window=1${override !== null ? "&showAll=1" : ""}`);
    } catch (e) {
      if (latest.isCurrent(t)) { setError((e as Error).message); setLoaded(true); }
      return;
    }
    if (!latest.isCurrent(t)) return;
    setRows(data.rows);
    setCut(data.cut);
    setLoaded(true);
    // Clear on success, ticket-gated like the failure path above (Codex, MR !22): without this,
    // a banner from an earlier failed load stays on screen next to freshly loaded rows, with no way
    // to dismiss it.
    setError(null);
  }, [query, showAllState, latest]);
  useEffect(() => { void load(); }, [load]);

  function updateFilters(patch: Partial<BoardFilters>) {
    setFilters((prev) => ({ ...prev, ...patch }));
  }

  function toggleStatus(s: OrderStatusValue) {
    updateFilters({
      status: filters.status.includes(s) ? filters.status.filter((x) => x !== s) : [...filters.status, s],
    });
  }

  function toggleSort(col: ColumnDef) {
    if (!col.sortKey) return;
    const key = col.sortKey;
    setSort((prev) => (prev.sort === key ? { sort: key, dir: prev.dir === "asc" ? "desc" : "asc" } : { sort: key, dir: "asc" }));
  }

  function toggleColumnVisible(key: ColumnKey) {
    setColumns((prev) => prev.map((c) => (c.key === key ? { ...c, visible: !c.visible } : c)));
  }
  function moveColumn(index: number, direction: -1 | 1) {
    setColumns((prev) => swapAt(prev, index, direction) ?? prev);
  }

  function applyView(id: string) {
    setSelectedViewId(id);
    const cfg = id === "" ? defaultViewConfig() : normalizeViewConfig(savedViews.find((v) => v.id === id)?.config);
    setColumns(cfg.columns);
    setFilters(cfg.filters);
    setSort({ sort: cfg.sort, dir: cfg.dir });
  }

  async function saveView() {
    const name = saveName.trim();
    if (!name) { setError("A name is required to save a view"); return; }
    await saveViewHold.run(async () => {
      try {
        const config: ViewConfig = { columns, filters, sort: sort.sort, dir: sort.dir };
        const created = await api<SavedViewRow>("/api/saved-views", {
          method: "POST", body: JSON.stringify({ name, config, isDefault: saveDefault }),
        });
        setSavedViews((prev) => [...(saveDefault ? prev.map((v) => ({ ...v, isDefault: false })) : prev), created]);
        setSelectedViewId(created.id);
        setSaveOpen(false);
        setSaveName("");
        setSaveDefault(false);
        setError(null);
      } catch (e) { setError((e as Error).message); }
    });
  }

  // Toggles isDefault on the CURRENTLY SELECTED view without touching its stored columns/filters
  // (the PATCH body carries only `isDefault` — updateView's `config` is `.optional()`, so omitting
  // it leaves the saved arrangement untouched even if the board's on-screen state has since
  // drifted from it). Mirrors the server's own demote-other-defaults behaviour locally so the
  // dropdown/checkbox stay correct without a full refetch.
  async function setSelectedDefault(isDefault: boolean) {
    if (!selectedViewId || settingDefault) return; // one at a time (#145)
    setSettingDefault(true);
    try {
      const updated = await api<SavedViewRow>(`/api/saved-views/${selectedViewId}`, {
        method: "PATCH", body: JSON.stringify({ isDefault }),
      });
      // Only the field this PATCH wrote lands (Codex on #733): Update view's PATCH can be out at
      // the same time, and each answer carries the whole row as the server held it at ITS commit,
      // so adopting the row whole could overwrite the other write's newer field with an older one.
      setSavedViews((prev) => prev.map((v) => {
        if (v.id === updated.id) return { ...v, isDefault: updated.isDefault };
        return isDefault ? { ...v, isDefault: false } : v;
      }));
      setError(null);
    } catch (e) { setError((e as Error).message); }
    finally { setSettingDefault(false); }
  }

  // R20 (#683): the selected view's stored arrangement against the live one, normalised, so the
  // select can say "(changed)" and Update view can write the live config back.
  const selectedView = savedViews.find((v) => v.id === selectedViewId);
  const viewChanged = selectedView !== undefined && !sameViewConfig({ columns, filters, sort: sort.sort, dir: sort.dir }, selectedView.config);

  async function updateSelectedView() {
    if (!selectedViewId || updatingView) return; // one at a time (#145)
    setUpdatingView(true);
    try {
      const config: ViewConfig = { columns, filters, sort: sort.sort, dir: sort.dir };
      const updated = await api<SavedViewRow>(`/api/saved-views/${selectedViewId}`, {
        method: "PATCH", body: JSON.stringify({ config }),
      });
      // Only `config` lands, as setSelectedDefault lands only `isDefault` (see there).
      setSavedViews((prev) => prev.map((v) => (v.id === updated.id ? { ...v, config: updated.config } : v)));
      setViewError(null);
    } catch (e) { setViewError((e as Error).message); }
    finally { setUpdatingView(false); }
  }

  async function deleteSelectedView() {
    const view = savedViews.find((v) => v.id === selectedViewId);
    if (!view) return;
    if (!await askConfirm({ title: `Delete saved view "${view.name}"?`, body: "", confirm: "Delete saved view", danger: true })) return;
    try {
      await api(`/api/saved-views/${selectedViewId}`, { method: "DELETE" });
      setSavedViews((prev) => prev.filter((v) => v.id !== selectedViewId));
      applyView("");
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }

  const visibleDefs: ColumnDef[] = columns
    .filter((c) => c.visible)
    .map((c) => BOARD_COLUMNS.find((d) => d.key === c.key))
    .filter((d): d is ColumnDef => d !== undefined);

  const notice = windowNotice(cut, { newestFirst: sort.sort === "orderNumber" && sort.dir === "desc" });
  return (
    <div className="p-6">
      <PageHeader title="Orders" subtitle="A compact worklist for the work in the shop."
                  actions={<button type="button" onClick={() => router.push("/orders/new")} disabled={canCreateOrder.disabled}
                                   title={canCreateOrder.title} className={BUTTON_PRIMARY}>New Order</button>} />

      {(error ?? permsError) && (
        <p className={`${NOTICE.refusal} mb-3`}>{error ?? permsError}</p>
      )}
      {viewsLoadError && (
        <p className={`${NOTICE.warning} mb-3`}>
          Could not load saved views: {viewsLoadError}
        </p>
      )}
      {customersError && (
        <p className={`${NOTICE.warning} mb-3`}>
          Could not load the customer filter: {customersError}
        </p>
      )}

      {/* The presets are a setting of the controls below, derived from the filters (board-presets.ts):
          a status or voided edit leaves no tab lit, and a saved view shows the preset it equals. */}
      <ListTabs label="Order views" tabs={BOARD_PRESETS} active={presetFor(filters)}
                onSelect={(key) => updateFilters(applyPreset(filters, key as BoardPresetKey))} />

      <div className={`${CARD} mb-4`}>
      <SavedViewsBar
        savedViews={savedViews}
        selectedViewId={selectedViewId}
        saveOpen={saveOpen}
        saveName={saveName}
        saveDefault={saveDefault}
        settingDefault={settingDefault}
        viewChanged={viewChanged}
        updatingView={updatingView}
        viewError={viewError}
        onUpdateView={() => void updateSelectedView()}
        onApplyView={applyView}
        onSetSelectedDefault={setSelectedDefault}
        onOpenSave={() => setSaveOpen(true)}
        onDeleteView={deleteSelectedView}
        onSaveNameChange={setSaveName}
        onSaveDefaultChange={setSaveDefault}
        onSaveView={saveView}
        savingView={savingView}
        onCancelSave={() => { setSaveOpen(false); setSaveName(""); setSaveDefault(false); }}
      />

      <FilterBar
        filters={filters}
        customers={customers}
        customersGate={customersGate}
        queryString={queryString}
        columnsOpen={columnsOpen}
        onUpdateFilters={updateFilters}
        onToggleStatus={toggleStatus}
        onToggleColumnsOpen={() => setColumnsOpen((o) => !o)}
      />

      {columnsOpen && (
        <ColumnPicker columns={columns} onToggleVisible={toggleColumnVisible} onMove={moveColumn} />
      )}
      </div>

      {notice && (
        <p className="mb-2 text-sm text-ink-500">
          {notice.lead}{" "}
          <button type="button" className={LINK} onClick={() => setShowAllState((prev) => showAllClicked(prev, queryString))}>{notice.action}</button>
        </p>
      )}

      <div className={CARD_FLUSH}>
      <BoardTable
        rows={rows}
        loaded={loaded}
        visibleDefs={visibleDefs}
        sort={sort}
        onToggleSort={toggleSort}
        onOpenOrder={(id) => router.push(`/orders/${id}`)}
      />
      </div>
    </div>
  );
}
