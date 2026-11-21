"use client";
// A worklist's tabs (spec 2026-10-30-ux-redesign-design.md §4.5): presets of the page's existing
// filter controls, drawn as the pill pair. The page owns `active` (null once a filter was edited
// by hand) and applies the preset in `onSelect`; the URL carries only the existing filter
// parameters, never a tab of its own.
import { PILL_ACTIVE, PILL_IDLE } from "@/lib/ui-classes";

export function ListTabs({ label, tabs, active, onSelect }: {
  label: string;
  tabs: { key: string; label: string }[];
  active: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <div role="group" aria-label={label} className="mb-4 flex flex-wrap gap-2">
      {tabs.map((t) => (
        <button key={t.key} type="button" onClick={() => onSelect(t.key)} aria-pressed={active === t.key}
                className={active === t.key ? PILL_ACTIVE : PILL_IDLE}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
