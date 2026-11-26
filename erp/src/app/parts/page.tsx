"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import { PasteGrid } from "@/components/PasteGrid";
import { invalidateSetupBanner } from "@/components/SetupBanner";
import { PageHeader } from "@/components/PageHeader";
import { ListTabs } from "@/components/ListTabs";
import { ActionMenu } from "@/components/ActionMenu";
import { PART_PASTE_COLUMNS } from "@/lib/part-constants";
import { PART_PRESETS, PART_VIEWS_LABEL, applyPreset, presetFor, type PartPresetKey } from "@/lib/part-list";
import { yesNo } from "@/lib/format";
import { decimalRefusal } from "@/lib/decimal-entry";
import { EACH_WEIGHT } from "@/lib/part-boxes";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { EACH_WEIGHT_LB } from "@/lib/weight-terms";
import { BUTTON_NEUTRAL, BUTTON_PRIMARY, BUTTON_PRIMARY_COMPACT, CARD, CARD_FLUSH, INPUT_COMPACT, LINK, NOTICE, TABLE_CELL, TABLE_HEAD } from "@/lib/ui-classes";
import { oneShotHold } from "@/lib/single-flight";
import { Combobox } from "@/components/Combobox";
import { customerOptions } from "@/lib/menu-options";

// Local row type mirrors only the columns this list renders — id, partNumber, name,
// customerCode, customerName, materialName, eachWeight, active. Not imported from
// src/server/parts.ts's PartRow: a client component must not import from src/server/**
// (CLAUDE.md "Constraints that will bite you" — it drags node:async_hooks and Prisma into the
// browser bundle), and PartRow itself carries pricing/description/etc. fields this list has no
// use for.
type PartRow = {
  id: string; partNumber: string; name: string;
  customerCode: string; customerName: string;
  materialName: string | null; eachWeight: number; active: boolean;
};

// Slice of CustomerRow needed to populate the add-row's customer picker.
type CustomerOption = { id: string; code: string; name: string };

// The parts list (the UX redesign PR 9, spec §4.3, §4.5; owner 2026-11-01 on #824), the customers
// list's shape: the header's Add part takes the cursor to the inline row, Paste from spreadsheet
// toggles the inline panel, Export to Excel is the More actions item; Active parts / Include
// inactive are the two states of the Show inactive box the list always sent (src/lib/part-list.ts),
// so one is always lit and the search narrows within it.
export default function PartsPage() {
  const [rows, setRows] = useState<PartRow[]>([]);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [draft, setDraft] = useState({ customerId: "", partNumber: "", eachWeight: "" });
  // #720: Add's hold, so a second click while the POST is out sends nothing (it would be refused
  // as a duplicate part number after the first landed).
  const [adding, setAdding] = useState(false);
  const [addHold] = useState(() => oneShotHold(setAdding));
  const [error, setError] = useState<string | null>(null);
  // P6: the list read and the customer picker each own a line. `error` is the Add row's: its
  // success cleared a list-read failure while the table still showed the older rows, and a list
  // read that landed never cleared the failure it had written.
  const [listError, setListError] = useState<string | null>(null);
  const [customersError, setCustomersError] = useState<string | null>(null);
  const { permissions: perms, error: permsError } = usePermissions();

  // Ruling R3 (#612): the list and its Export link read the term 250 ms after the last keystroke.
  const debouncedSearch = useDebouncedValue(search);
  const query = `${showInactive ? "includeInactive=1&" : ""}${debouncedSearch ? `search=${encodeURIComponent(debouncedSearch)}` : ""}`;

  // Named `latest`, not `gate` — this file also imports `gate` from permission-ui for the
  // held-permission checks below, and shadowing that binding with the stale-response gate would
  // break every `gate(perms, ...)` call in this component.
  const latest = useLatest();
  // F7: the catch must be ticket-gated too, not just the success path. Without this, a
  // superseded request's REJECTION (a dropped connection on the OLD search term, say) can land
  // after a newer request already succeeded, and setError() would overwrite the fresh rows with
  // a stale failure message — the mirror image of the stale-success bug isCurrent() already
  // guarded against below.
  const load = useCallback(async () => {
    const t = latest.next();
    let data: PartRow[];
    try {
      data = await api<PartRow[]>(`/api/parts${query ? `?${query}` : ""}`);
    } catch (e) {
      if (latest.isCurrent(t)) setListError((e as Error).message);
      return;
    }
    if (!latest.isCurrent(t)) return;
    setRows(data);
    setListError(null);
  }, [query, latest]);
  useEffect(() => { void load(); }, [load]);

  // Stale-closure guard (Task 7): `load` closes over `query`, so a handler continuation captured
  // before a search/show-inactive change would re-ask the OLD query with the NEWEST ticket —
  // defeating the gate, and leaving the table disagreeing with the controls above it. The
  // post-mutation refetches below go through this ref, updated every render (in an effect — the
  // `react-hooks/refs` rule forbids a render-time write), so they always call the CURRENT loader.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; });

  const exportHref = `/api/parts/export${query ? `?${query}` : ""}`;
  const canCreate = gate(perms, "parts.create");
  const customersGate = gate(perms, "customers.view");

  // Customer picker for the add row: fetched only once the caller is known to hold
  // customers.view, never left silently empty for someone who lacks it (§5.16 — a blocked
  // control must say why, not just refuse). A failed fetch reports into `customersError` (#144):
  // no `.catch(() => {})` silencing, and no shared slot another success clears.
  useEffect(() => {
    if (!customersGate.allowed) return;
    api<CustomerOption[]>("/api/customers").then(setCustomers).catch((e) => setCustomersError((e as Error).message));
  }, [customersGate.allowed]);

  // The header's Add part: the row's first open box takes the cursor and nothing is sent. The
  // Customer select is closed without customers.view, and a closed box takes no focus.
  const customerRef = useRef<HTMLInputElement>(null);
  const partNumberRef = useRef<HTMLInputElement>(null);
  function focusNewPart() {
    const box = customerRef.current?.disabled ? partNumberRef.current : customerRef.current;
    box?.scrollIntoView({ block: "center" });
    box?.focus();
  }

  async function add() {
    // Each weight is read by its own rule (`part-boxes.ts`) before a request: a refused figure is
    // named, nothing is posted and the draft keeps what was typed.
    const refused = decimalRefusal(EACH_WEIGHT.label, draft.eachWeight, EACH_WEIGHT.box, { required: true });
    if (refused) { setError(refused); return; }
    await addHold.run(async () => {
      try {
        // eachWeight is sent as the string the user typed — the service's decimalField zod
        // schema accepts a decimal string directly, no client-side parseFloat needed.
        await api("/api/parts", { method: "POST", body: JSON.stringify(draft) });
        // #110: the first part completes a banner readiness step (#124/!131 ordering: before load()).
        invalidateSetupBanner();
        setDraft({ customerId: "", partNumber: "", eachWeight: "" });
        setError(null);
        await loadRef.current();
      } catch (e) { setError((e as Error).message); }
    });
  }

  return (
    <div className="min-w-0 p-3 sm:p-6">
      <PageHeader title="Parts" subtitle="Memorized jobs, scoped to each customer."
        actions={<>
          <button type="button" onClick={focusNewPart} disabled={canCreate.disabled} title={canCreate.title}
                  className={BUTTON_PRIMARY}>
            Add part
          </button>
          <button type="button" onClick={() => setPasting((p) => !p)} disabled={canCreate.disabled} title={canCreate.title}
                  className={BUTTON_NEUTRAL}>
            {pasting ? "Hide paste entry" : "Paste from spreadsheet"}
          </button>
          <ActionMenu items={[
            { label: "Export to Excel", href: exportHref },
          ]} />
        </>} />
      {(error ?? permsError) && (
        <p className={`${NOTICE.refusal} mb-3`}>{error ?? permsError}</p>
      )}
      {listError && <p className={`${NOTICE.refusal} mb-3`}>{listError}</p>}
      {customersError && (
        <p className={`${NOTICE.warning} mb-3`}>
          Could not load customers: {customersError}
        </p>
      )}

      <ListTabs label={PART_VIEWS_LABEL} tabs={PART_PRESETS} active={presetFor({ showInactive })}
                onSelect={(key) => setShowInactive(applyPreset({ showInactive }, key as PartPresetKey).showInactive)} />

      <section className={`${CARD} mb-3`}>
        <input value={search} onChange={(e) => setSearch(e.target.value)}
               placeholder="Search part number or customer" className={`${INPUT_COMPACT} w-64`} />
      </section>

      <div className={`${CARD_FLUSH} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className={`${TABLE_HEAD} p-2`}>Customer</th><th className={`${TABLE_HEAD} p-2`}>Part number</th>
              <th className={`${TABLE_HEAD} p-2`}>Name</th><th className={`${TABLE_HEAD} p-2`}>Material</th>
              <th className={`${TABLE_HEAD} p-2`}>{EACH_WEIGHT_LB}</th><th className={`${TABLE_HEAD} p-2`}>Active</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className="border-t">
                <td className={TABLE_CELL}>{p.customerCode} · {p.customerName}</td>
                <td className={`${TABLE_CELL} font-mono`}>
                  <Link href={`/parts/${p.id}`} className={LINK}>{p.partNumber}</Link>
                </td>
                <td className={TABLE_CELL}>{p.name}</td>
                <td className={`${TABLE_CELL} text-ink-500`}>{p.materialName ?? ""}</td>
                <td className={TABLE_CELL}>{p.eachWeight}</td>
                <td className={TABLE_CELL}>{yesNo(p.active)}</td>
              </tr>
            ))}
            <tr className="border-t bg-surface-50">
              <td className="p-2">
                <Combobox ref={customerRef} value={draft.customerId} options={customerOptions(customers, { blank: "Customer…" })}
                          onSelect={(v) => setDraft({ ...draft, customerId: v })}
                          disabled={!customersGate.allowed} title={customersGate.allowed ? undefined : customersGate.title}
                          ariaLabel="Customer" className="w-full" />
              </td>
              <td className="p-2">
                <input ref={partNumberRef} value={draft.partNumber} onChange={(e) => setDraft({ ...draft, partNumber: e.target.value })}
                       placeholder="Part number" className={`${INPUT_COMPACT} w-full`} />
              </td>
              <td className="p-2" colSpan={2} />
              <td className="p-2">
                <input value={draft.eachWeight} onChange={(e) => setDraft({ ...draft, eachWeight: e.target.value })}
                       placeholder={EACH_WEIGHT_LB} inputMode="decimal" className={`${INPUT_COMPACT} w-full`} />
              </td>
              <td className="p-2 text-right">
                <button onClick={add} disabled={canCreate.disabled || adding} title={canCreate.title}
                        className={BUTTON_PRIMARY_COMPACT}>
                  Add
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {pasting && (
        // #110: PasteGrid fires onDone only after a successful POST.
        <div className="mt-6">
          <PasteGrid endpoint="/api/parts/paste" columns={[...PART_PASTE_COLUMNS]}
                     onDone={() => { invalidateSetupBanner(); void loadRef.current(); }} />
        </div>
      )}
    </div>
  );
}
