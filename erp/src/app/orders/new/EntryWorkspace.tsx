"use client";
import { useState, type ReactNode } from "react";
import { TAB_ACTIVE, TAB_IDLE } from "@/components/TabNav";
import { PageHeader } from "@/components/PageHeader";
import type { DraftSaveState, EntryTab } from "./entry-state";
import { NOTICE } from "@/lib/ui-classes";

const TABS: { id: EntryTab; label: string }[] = [
  { id: "details", label: "Order details" },
  { id: "parts", label: "Parts & containers" },
  { id: "process", label: "Process & loads" },
];

export function DraftSaveStatus({ state }: { state: DraftSaveState }) {
  const label = { idle: "No draft changes", dirty: "Unsaved changes", saving: "Saving draft…",
    saved: "Draft saved", error: "Draft autosave failed" }[state.status];
  return <span role="status" className={state.status === "error" ? "text-accent-600" : "text-ink-500"}>{label}</span>;
}

/** A forced-open section cannot conceal populated, required or invalid fields. */
export function EntryOptionalSection({ title, forceOpen = false, optional = true, children }: {
  title: string; forceOpen?: boolean; optional?: boolean; children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return <details open={forceOpen || expanded} className="rounded border border-line bg-surface-0 p-3">
    <summary className="cursor-pointer text-sm font-medium" onClick={event => {
      event.preventDefault();
      setExpanded(forceOpen || !expanded);
    }}>{title} <span className="font-normal text-ink-500">({optional ? "optional" : "required"})</span></summary>
    <div className="mt-3">{children}</div>
  </details>;
}

export function StandingOrderNotes({ notes }: { notes: string }) {
  if (!notes) return null;
  return <div role="note" aria-label="Standing order notes" className={`${NOTICE.info} mt-2`}>
    <span className="font-medium">Standing order notes (read-only): </span>
    <span className="whitespace-pre-wrap">{notes}</span>
  </div>;
}

export function EntryWorkspace({ activeTab, onTabChange, headerActions, headerContext, saveState, alert,
  summary, detailsPanel, partsPanel, processPanel }: {
  activeTab: EntryTab; onTabChange: (tab: EntryTab) => void;
  headerActions: ReactNode; headerContext?: ReactNode; saveState?: DraftSaveState;
  /** Save's refusal banner (owner ruling R13): under the header's row, inside the sticky header,
   *  so it stays on screen while the cursor's box is centred. */
  alert?: ReactNode;
  summary: ReactNode; detailsPanel: ReactNode; partsPanel: ReactNode; processPanel: ReactNode;
}) {
  const panels = { details: detailsPanel, parts: partsPanel, process: processPanel };
  return <div className="min-w-0">
    <header className="sticky top-0 z-20 -mx-1 mb-3 border-b border-line bg-surface-50 px-1 py-3 [&>div:first-child]:mb-0">
      <PageHeader title="New order"
        subtitle={<span className="flex flex-wrap gap-x-3 gap-y-1 [overflow-wrap:anywhere]">{saveState && <DraftSaveStatus state={saveState} />}{headerContext}</span>}
        actions={headerActions} />
      {alert && <div className="mt-3">{alert}</div>}
    </header>
    <div role="tablist" aria-label="Order entry sections" className="mb-4 flex flex-wrap gap-2">
      {TABS.map(({ id, label }, index) => <button key={id} type="button" role="tab"
        id={`entry-tab-${id}`} aria-controls={`entry-panel-${id}`} aria-selected={activeTab === id}
        tabIndex={activeTab === id ? 0 : -1} onClick={() => onTabChange(id)}
        onKeyDown={event => {
          const next = event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1
            : event.key === "ArrowRight" ? (index + 1) % TABS.length
              : event.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length : null;
          if (next === null) return;
          event.preventDefault();
          onTabChange(TABS[next].id);
          document.getElementById(`entry-tab-${TABS[next].id}`)?.focus();
        }}
        className={`${activeTab === id ? TAB_ACTIVE : TAB_IDLE} focus-visible:outline-2 focus-visible:outline-accent-600`}>
        {label}
      </button>)}
    </div>
    <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(17rem,1fr)]">
      <div className="min-w-0">
        {TABS.map(({ id }) => <section key={id} role="tabpanel" id={`entry-panel-${id}`}
          aria-labelledby={`entry-tab-${id}`} hidden={activeTab !== id} className="min-w-0">
          {panels[id]}
        </section>)}
        <p className="mt-5 text-xs text-ink-500">Your entries stay here when you switch tabs.</p>
      </div>
      <aside aria-label="Order & traveler plan" className="min-w-0 border-t border-line pt-4 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0">
        <div className="xl:sticky xl:top-28">{summary}
          {activeTab !== "process" && <button type="button"
            onClick={() => onTabChange(activeTab === "details" ? "parts" : "process")}
            className="mt-4 w-full rounded border border-link-700 px-3 py-2 text-sm text-link-700">
            Next: {activeTab === "details" ? "Parts & containers" : "Process & loads"} →
          </button>}
        </div>
      </aside>
    </div>
  </div>;
}
