"use client";
// A record page's tabs (spec 2026-10-30-ux-redesign-design.md §4.4; owner ruling 7 of 2026-10-30).
// Every panel stays mounted and the inactive ones carry `hidden`, so blur-saves, grids, drafts,
// registries, panel messages and the archival gates are untouched: a tab switch is never a
// departure. The decisions are src/lib/record-tabs.ts's: the tab a location opens (a hash into a
// panel wins, so the traveler scan's `?load=N#load-N` lands on Loads & travelers), the `tab`
// query the selection rides in (replaced, never pushed, so Back leaves the record), which tabs
// badge unsaved work, and where the arrow keys go. A hash activation scrolls to its target after
// the panel is shown.
//
// The tab query is written with `window.history.replaceState`, never `router.replace`: the app
// router keys a page segment by its search params, so a `router.replace` to `?tab=…` refetches the
// segment and REMOUNTS the page (every read runs again, the print controller's message and every
// in-memory state go), which is exactly what spec §4.4 forbids a tab switch to be. The call passes
// `window.history.state` as its data DELIBERATELY: that object carries Next's own `__NA` mark, under
// which Next's patched replaceState takes the call for one of its own and skips the sync into
// `useSearchParams`, so after a tab click `useSearchParams` is stale (it still reads the query the
// page was reached with) and the tab is in Next's canonical URL only as the address bar shows it.
// That staleness is the point. With `null` the query syncs, Next's canonical URL carries `?tab=…`,
// and a later `router.push` to the record's bare path (the global search's same-page result) is a
// query change the effect below follows, which flips the hub back to Overview over an editor with
// unsaved work (the `global-search` flow, PR 2's fix pass). Nothing reads the tab from
// `useSearchParams`: the writes read the live `window.location`, and a page's own query (the hub's
// `?load=N`) reaches this component through `open`.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { nextTabKey, openDecision, tabForLocation, tabsWithUnsaved, withTab, type RecordTab } from "@/lib/record-tabs";
import { subscribeUnsaved, unsavedLabels } from "@/lib/unsaved-guard";
import { PILL_ACTIVE, PILL_IDLE } from "@/lib/ui-classes";
import { UnsavedBadge } from "./UnsavedBadge";

// The registry's labels as ONE string: `unsavedLabels()` builds a fresh array each call, which
// `useSyncExternalStore` would read as a new snapshot on every render and loop (the registry's own
// warning at `unsavedCount`); equal strings compare equal. The server has an empty registry.
const labelsSnapshot = (): string => unsavedLabels().join("\u0000");

export function RecordTabs({ label, tabs, panels, open = null }: {
  label: string;
  tabs: RecordTab[];
  /** Each tab's content by key; every one renders, the inactive ones hidden. */
  panels: Record<string, ReactNode>;
  /** An element id the page wants opened, with a key that changes per request (the traveler scan's
   *  `?load=N` and its scan token): the tab holding that id is selected when the key changes. A
   *  soft navigation can run this component's effects before the address bar holds the new hash,
   *  so a page that knows the target from its search params says so here. */
  open?: { id: string; key: string } | null;
}) {
  const params = useSearchParams();
  const search = params.toString() === "" ? "" : `?${params.toString()}`;
  // The server render and the first client render agree on the query alone; the hash is read in
  // an effect, since it never reaches the server.
  const [selected, setSelected] = useState(() => tabForLocation(tabs, search, ""));
  // Keyed on the tabs' keys, not the array (a page may pass a literal each render), and re-run on
  // every hash change, so a page's own `href="#id"` jumps into a hidden panel open that panel too.
  const tabKeys = tabs.map((t) => t.key).join("\u0000");
  const tabsRef = useRef(tabs);
  useEffect(() => { tabsRef.current = tabs; });
  useEffect(() => {
    const follow = () => {
      const hash = window.location.hash;
      const key = tabForLocation(tabsRef.current, search, hash);
      setSelected(key);
      if (hash !== "" && tabsRef.current.find((t) => t.key === key)?.ids?.includes(hash.slice(1))) {
        requestAnimationFrame(() => document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" }));
      }
    };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, [tabKeys, search]);
  // The page's `open` request, decided by the leaf (`openDecision`): once per key, as soon as a
  // tab holds the id, so the effect follows the tabs' ids as well as the request.
  const openKey = open?.key ?? null;
  const openId = open?.id ?? null;
  const tabIds = tabs.flatMap((t) => t.ids ?? []).join("\u0000");
  const honoured = useRef<string | null>(null);
  useEffect(() => {
    const decided = openDecision(honoured.current, openId === null || openKey === null ? null : { id: openId, key: openKey }, tabsRef.current);
    honoured.current = decided.honoured;
    if (decided.select !== null) setSelected(decided.select);
  }, [openKey, openId, tabIds]);
  const joined = useSyncExternalStore(subscribeUnsaved, labelsSnapshot, labelsSnapshot);
  const unsaved = tabsWithUnsaved(tabs, joined === "" ? [] : joined.split("\u0000"));
  const select = (key: string) => {
    setSelected(key);
    // A hash-free URL, so a hash that opened one tab cannot re-open it on the next render.
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${withTab(window.location.search, key, tabs[0].key)}`);
  };
  return (
    <>
      <div role="tablist" aria-label={label} className="mb-4 flex flex-wrap gap-2"
           onKeyDown={(e) => {
             if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
             e.preventDefault();
             const key = nextTabKey(tabs, selected, e.key);
             select(key);
             document.getElementById(`tab-${key}`)?.focus();
           }}>
        {tabs.map((t) => {
          const on = t.key === selected;
          return (
            <button key={t.key} type="button" role="tab" id={`tab-${t.key}`} aria-selected={on}
                    aria-controls={`panel-${t.key}`} tabIndex={on ? 0 : -1} onClick={() => select(t.key)}
                    className={on ? PILL_ACTIVE : PILL_IDLE}>
              {t.label}
              <UnsavedBadge dirty={unsaved.has(t.key)} />
            </button>
          );
        })}
      </div>
      {tabs.map((t) => (
        <div key={t.key} role="tabpanel" id={`panel-${t.key}`} aria-labelledby={`tab-${t.key}`} hidden={t.key !== selected}>
          {panels[t.key]}
        </div>
      ))}
    </>
  );
}
