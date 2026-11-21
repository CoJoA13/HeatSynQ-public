"use client";
// The Design tab's palette (PR C of #926, Task 4): `paletteEntries` drawn as buttons under their
// group headings. A click hands the entry to the panel, which places it (`placeNew`). A field may
// be placed again, so a placed field stays live and is only marked; a placed table or logo, and the
// two items every traveler prints (the barcode and the Process steps table), are marked and closed.
import type { PaletteEntry } from "@/lib/canvas-designer";
import { DESIGNER_WORDS } from "@/lib/canvas-designer";
import { BADGE_WARNING, CHIP, LABEL } from "@/lib/ui-classes";

/** Whether an entry can be added again: a field always, anything else only while it is not on the page. */
function addable(entry: PaletteEntry): boolean {
  return entry.state === "available" || (entry.state === "placed" && entry.kind === "field");
}

export function CanvasPalette({ entries, onAdd, disabled, editTitle }: {
  entries: PaletteEntry[];
  onAdd: (entry: PaletteEntry) => void;
  disabled: boolean;
  editTitle: string | undefined;
}) {
  const groups: { name: string; entries: PaletteEntry[] }[] = [];
  for (const entry of entries) {
    const group = groups.at(-1);
    if (group?.name === entry.group) group.entries.push(entry);
    else groups.push({ name: entry.group, entries: [entry] });
  }
  return (
    <div role="group" aria-label={DESIGNER_WORDS.palette} className="space-y-3">
      {groups.map((group) => (
        <div key={group.name}>
          <h3 className={LABEL}>{group.name}</h3>
          <ul className="mt-1 space-y-1">
            {group.entries.map((entry) => {
              const open = !disabled && addable(entry);
              const title = disabled ? editTitle : open ? undefined : DESIGNER_WORDS.onPage;
              return (
                <li key={`${entry.kind}:${entry.key ?? ""}`}>
                  <button type="button" onClick={() => onAdd(entry)} disabled={!open} title={title}
                          className="flex w-full items-center justify-between gap-2 rounded-md border border-line bg-surface-0 px-2 py-1 text-left text-xs text-ink-800 hover:bg-surface-50">
                    <span className="truncate">{entry.label}</span>
                    {entry.state === "placed" && <span className={CHIP}>{DESIGNER_WORDS.placed}</span>}
                    {entry.state === "required" && <span className={BADGE_WARNING}>{DESIGNER_WORDS.required}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
