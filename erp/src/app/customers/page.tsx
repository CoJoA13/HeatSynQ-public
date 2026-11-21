"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import { PasteGrid } from "@/components/PasteGrid";
import { invalidateSetupBanner } from "@/components/SetupBanner";
import { PageHeader } from "@/components/PageHeader";
import { ListTabs } from "@/components/ListTabs";
import { ActionMenu } from "@/components/ActionMenu";
import { CUSTOMER_PASTE_COLUMNS } from "@/lib/customer-constants";
import { CUSTOMER_PRESETS, CUSTOMER_VIEWS_LABEL, applyPreset, presetFor, type CustomerPresetKey } from "@/lib/customer-list";
import { yesNo } from "@/lib/format";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { BUTTON_NEUTRAL, BUTTON_PRIMARY, BUTTON_PRIMARY_COMPACT, CARD, CARD_FLUSH, INPUT_COMPACT, LINK, NOTICE, TABLE_CELL, TABLE_HEAD } from "@/lib/ui-classes";
import { oneShotHold } from "@/lib/single-flight";

type Customer = {
  id: string; code: string; name: string; parentCode: string | null;
  creditHold: boolean; active: boolean;
};

// The customers list (the UX redesign PR 8, spec §4.3, §4.5; owner 2026-11-01 on #823): the
// header's Add customer takes the cursor to the inline Code / Name row (the batch list's New batch
// precedent), Paste from spreadsheet toggles the inline panel, Export to Excel is the More actions
// item; Active customers / Include inactive are the two states of the Show inactive box the list
// always sent (src/lib/customer-list.ts), so one is always lit and the search narrows within it.
export default function CustomersPage() {
  const [rows, setRows] = useState<Customer[]>([]);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [draft, setDraft] = useState({ code: "", name: "" });
  // #720: Add's hold, so a second click while the POST is out sends nothing (it would be refused
  // as a duplicate code after the first landed).
  const [adding, setAdding] = useState(false);
  const [addHold] = useState(() => oneShotHold(setAdding));
  // #144: load and add() each get their OWN channel. One shared `error` forced a choice between
  // two bugs: a ticket-gated success that never cleared it left a superseded search failure's
  // banner sitting over fresh rows, while clearing it on load success would wipe an add()
  // failure the moment the next keystroke's search landed. Split, both rules hold: `loadError`
  // is cleared by the ticket-gated success below, `actionError` is written and cleared only by
  // add() itself.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { permissions: perms, error: permsError } = usePermissions();

  // Ruling R3 (#612): the list and its Export link read the term 250 ms after the last keystroke.
  const debouncedSearch = useDebouncedValue(search);
  const query = `${showInactive ? "includeInactive=1&" : ""}${debouncedSearch ? `search=${encodeURIComponent(debouncedSearch)}` : ""}`;
  // The export follows the applied search and the view, as the link did; the menu item is a
  // document link (an `<a>`), so it loads exactly as the link did.
  const exportHref = `/api/customers/export${query ? `?${query}` : ""}`;

  // Named `latest`, not `gate` — this file also imports `gate` from permission-ui for the
  // held-permission checks below, and shadowing that binding with the stale-response gate would
  // break every `gate(perms, ...)` call in this component.
  const latest = useLatest();
  // F7: the catch must be ticket-gated too, not just the success path. Without this, a
  // superseded request's REJECTION (a dropped connection on the OLD search term, say) can land
  // after a newer request already succeeded, and setLoadError() would overwrite the fresh rows
  // with a stale failure message — the mirror image of the stale-success bug isCurrent() already
  // guarded against below. The success path clears `loadError` (ticket-gated the same way): a
  // load failure's banner must not outlive its cause once a newer load has landed fresh rows.
  const load = useCallback(async () => {
    const t = latest.next();
    let data: Customer[];
    try {
      data = await api<Customer[]>(`/api/customers${query ? `?${query}` : ""}`);
    } catch (e) {
      if (latest.isCurrent(t)) setLoadError((e as Error).message);
      return;
    }
    if (!latest.isCurrent(t)) return;
    setRows(data);
    setLoadError(null);
  }, [query, latest]);
  useEffect(() => { void load(); }, [load]);

  const canCreate = gate(perms, "customers.create");

  // The header's Add customer button is the way to the inline row: it scrolls the row into view
  // and puts the cursor in Code, and submits nothing; the row's own Add creates the customer.
  const codeRef = useRef<HTMLInputElement>(null);
  function focusNewCustomer() {
    codeRef.current?.scrollIntoView({ block: "center" });
    codeRef.current?.focus();
  }

  async function add() {
    await addHold.run(async () => {
      try {
        await api("/api/customers", { method: "POST", body: JSON.stringify(draft) });
        // #110: the first customer completes a banner readiness step (#124/!131 ordering: before load()).
        invalidateSetupBanner();
        setDraft({ code: "", name: "" }); setActionError(null); await load();
      } catch (e) { setActionError((e as Error).message); }
    });
  }

  return (
    <div className="min-w-0 p-3 sm:p-6">
      <PageHeader title="Customers" subtitle="Accounts, divisions and standing instructions."
        actions={<>
          <button type="button" onClick={focusNewCustomer} disabled={canCreate.disabled} title={canCreate.title}
                  className={BUTTON_PRIMARY}>
            Add customer
          </button>
          <button type="button" onClick={() => setPasting((p) => !p)} disabled={canCreate.disabled} title={canCreate.title}
                  className={BUTTON_NEUTRAL}>
            {pasting ? "Hide paste entry" : "Paste from spreadsheet"}
          </button>
          <ActionMenu items={[
            { label: "Export to Excel", href: exportHref },
          ]} />
        </>} />
      {(loadError ?? permsError) && (
        <p className={`${NOTICE.refusal} mb-3`}>{loadError ?? permsError}</p>
      )}
      {actionError && (
        <p className={`${NOTICE.refusal} mb-3`}>{actionError}</p>
      )}

      <ListTabs label={CUSTOMER_VIEWS_LABEL} tabs={CUSTOMER_PRESETS} active={presetFor({ showInactive })}
                onSelect={(key) => setShowInactive(applyPreset({ showInactive }, key as CustomerPresetKey).showInactive)} />

      <section className={`${CARD} mb-3`}>
        <input value={search} onChange={(e) => setSearch(e.target.value)}
               placeholder="Search code or name" className={`${INPUT_COMPACT} w-64`} />
      </section>

      <div className={`${CARD_FLUSH} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className={`${TABLE_HEAD} p-2`}>Code</th><th className={`${TABLE_HEAD} p-2`}>Name</th>
              <th className={`${TABLE_HEAD} p-2`}>Parent</th><th className={`${TABLE_HEAD} p-2`}>Credit hold</th>
              <th className={`${TABLE_HEAD} p-2`}>Active</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-t">
                <td className={`${TABLE_CELL} font-mono`}>
                  <Link href={`/customers/${c.id}`} className={LINK}>{c.code}</Link>
                </td>
                <td className={TABLE_CELL}>{c.name}</td>
                <td className={`${TABLE_CELL} font-mono text-ink-500`}>{c.parentCode ?? ""}</td>
                <td className={TABLE_CELL}>{yesNo(c.creditHold)}</td>
                <td className={TABLE_CELL}>{yesNo(c.active)}</td>
              </tr>
            ))}
            <tr className="border-t bg-surface-50">
              <td className="p-2">
                <input ref={codeRef} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                       placeholder="Code" className={`${INPUT_COMPACT} w-full`} />
              </td>
              <td className="p-2" colSpan={3}>
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                       placeholder="Name" className={`${INPUT_COMPACT} w-full`} />
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
          <PasteGrid endpoint="/api/customers/paste" columns={[...CUSTOMER_PASTE_COLUMNS]}
                     onDone={() => { invalidateSetupBanner(); void load(); }} />
        </div>
      )}
    </div>
  );
}
