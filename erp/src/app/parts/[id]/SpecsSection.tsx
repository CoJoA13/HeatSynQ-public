"use client";
import { useCallback, useEffect, useState } from "react";
import { PanelMessage } from "@/components/PanelMessage";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { optionsSelectTitle, type OptionsRead } from "@/lib/options-read";
import { useLatest } from "@/lib/use-latest";
import { invalidateHistory } from "@/components/HistoryPanel";
import { BUTTON_PRIMARY_COMPACT, CARD, INPUT_COMPACT } from "@/lib/ui-classes";
import { oneShotHold } from "@/lib/single-flight";
import { inMenuOrder } from "@/lib/menu-order";

type SpecLink = { id: string; specificationId: string; specificationName: string };
type SpecOption = { id: string; name: string; active: boolean };

export function SpecsSection({
  partId, perms, onOptionsError,
}: {
  partId: string;
  perms: string[] | undefined;
  onOptionsError: (message: string) => void;
}) {
  // This section's own message (owner ruling R1, P6 step 5c): its reads, saves and row actions
  // report here, through the shared PanelMessage, where they used to write the page banner. The
  // setter keeps the name `onError` that the handlers and the tests that lift them read.
  const [sectionMessage, onError] = useState<string | null>(null);
  const [links, setLinks] = useState<SpecLink[]>([]);
  // Set once a links read has landed (#684, the SurchargeOverridesSection `rowsReady` form): `links`
  // starts `[]` the same as "loaded, none", so "None." waits for it, neither showing while the first
  // read is out nor after it failed (that failure is this section's own message).
  const [linksReady, setLinksReady] = useState(false);
  const [options, setOptions] = useState<SpecOption[]>([]);
  const [draft, setDraft] = useState("");
  const canEdit = gate(perms, "parts.edit");

  // §5.13 stale-gate, the parts/page.tsx shape, both paths (F7) — the plain ticket, not the
  // sibling PricingSection's saveScope: this section has no optimistic saves, only
  // report-and-reload, so there is no rollback ordering to defer for. `load` never clears the
  // shared error itself — add/remove do that before reloading — so a rollback reload stays §5.13-safe.
  const latest = useLatest();
  const load = useCallback(async () => {
    const t = latest.next();
    let rows: SpecLink[];
    try {
      rows = await api<SpecLink[]>(`/api/parts/${partId}/specifications`);
    } catch (e) {
      if (latest.isCurrent(t)) onError((e as Error).message);
      return;
    }
    if (!latest.isCurrent(t)) return;
    setLinks(rows);
    setLinksReady(true);
  }, [partId, latest, onError]);
  useEffect(() => { void load(); }, [load]);

  // F9: a failed specification-options fetch used to report through the shared `onError`, which
  // a later successful save elsewhere on the page resets to null — see IdentitySection's comment
  // on the same fix. `onOptionsError` writes into the page's persistent `loadError` instead, and
  // `optionsRead` disables the picker until the fetch actually succeeds.
  const [optionsRead, setOptionsRead] = useState<OptionsRead>("loading");
  // #720: Add's hold and one hold for the removes, the Inspections section's shape (#681): a
  // second Add while the POST is out would be refused as already on this part, and a second remove
  // answers 404.
  const [adding, setAdding] = useState(false);
  const [addHold] = useState(() => oneShotHold(setAdding));
  const [removing, setRemoving] = useState(false);
  const [removeHold] = useState(() => oneShotHold(setRemoving));
  useEffect(() => {
    api<SpecOption[]>("/api/picklists/specification").then((data) => {
      setOptions(data);
      setOptionsRead("ready");
    }).catch((e) => { setOptionsRead("failed"); onOptionsError((e as Error).message); });
  }, [onOptionsError]);

  async function add() {
    if (!draft) return;
    await addHold.run(async () => {
      try {
        await api(`/api/parts/${partId}/specifications`, {
          method: "POST", body: JSON.stringify({ specificationId: draft }),
        });
        setDraft("");
        onError(null);
        invalidateHistory(); // #14 item 1 — success path, before the follow-up load
        await load();
      } catch (e) { onError((e as Error).message); }
    });
  }
  async function remove(linkId: string) {
    await removeHold.run(async () => {
      try {
        await api(`/api/parts/${partId}/specifications/${linkId}`, { method: "DELETE" });
        onError(null);
        invalidateHistory(); // #14 item 1
        await load();
      } catch (e) { onError((e as Error).message); }
    });
  }

  return (
    <section className={`${CARD} mb-6`}>
      <h2 className="mb-2 font-medium">Specifications</h2>
      <div className="mb-3 flex flex-wrap gap-2">
        {links.map((l) => (
          <span key={l.id} className="flex items-center gap-1 rounded-full bg-surface-50 px-3 py-1 text-sm">
            {l.specificationName}
            <button onClick={() => remove(l.id)} disabled={canEdit.disabled || removing} title={canEdit.title}
                    aria-label={`Remove ${l.specificationName}`}
                    className="text-ink-500 hover:text-red-600">
              ×
            </button>
          </span>
        ))}
        {linksReady && links.length === 0 && <span className="text-sm text-ink-500">None.</span>}
      </div>
      <div className="flex gap-2">
        {/* Already-linked specifications are excluded from the picker — a UX nicety on top of
            the service's own "already on this part" 400, not a replacement for it. */}
        <select value={draft} onChange={(e) => setDraft(e.target.value)}
                disabled={!canEdit.allowed || optionsRead !== "ready"}
                title={optionsSelectTitle(canEdit, optionsRead)}
                className={`${INPUT_COMPACT} disabled:bg-surface-50`}>
          <option value="">Add a specification…</option>
          {inMenuOrder(options, (r) => r.name)
            .filter((o) => !links.some((l) => l.specificationId === o.id))
            .map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <button onClick={add} disabled={canEdit.disabled || !draft || adding} title={canEdit.title}
                className={BUTTON_PRIMARY_COMPACT}>
          Add
        </button>
      </div>
      <PanelMessage message={sectionMessage} />
    </section>
  );
}
