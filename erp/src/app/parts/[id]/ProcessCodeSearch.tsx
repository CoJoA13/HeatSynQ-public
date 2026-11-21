"use client";
import { useEffect, useId, useMemo, useState } from "react";
import { rankProcessCodes } from "@/lib/process-code-search";
import { normalizeUnit } from "@/lib/process-document";
import type { ProcessEditorCode } from "@/lib/process-editor-catalog";
import { INPUT_COMPACT } from "@/lib/ui-classes";

/** Spec 2026-09-26 §4 "Add": the search under the table shows at most this many ranked codes. */
export const MAX_SEARCH_OPTIONS = 20;

/** The ranked, capped option list: `rankProcessCodes` (active codes only, code prefix first). */
export function searchOptions(catalog: readonly ProcessEditorCode[], query: string): ProcessEditorCode[] {
  return rankProcessCodes(catalog, query).slice(0, MAX_SEARCH_OPTIONS);
}

/** The option's second line: what a new step of this code brings (spec §3.2), or that it brings
 *  nothing. Units read through the one unit rule so a stored " min " shows as "min". */
export function suggestionSummary(code: ProcessEditorCode): string {
  if (!code.fields.length) return "No suggested parameters";
  return "Suggests: " + code.fields.map(f => { const unit = normalizeUnit(f.unit); return unit ? `${f.label} (${unit})` : f.label; }).join(", ");
}

/** The listbox half, rendered on its own so its markup is testable without opening the input. */
export function ProcessCodeListbox({ id, options, activeIndex, onPick }: {
  id: string; options: readonly ProcessEditorCode[]; activeIndex: number; onPick: (code: ProcessEditorCode) => void;
}) {
  return <ul role="listbox" id={id} aria-label="Process codes" className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded border bg-surface-0 text-sm shadow-lg">
    {options.map((code, i) => <li key={code.id} role="presentation">
      {/* onMouseDown + preventDefault (the Combobox precedent): the input never blurs, so there is
          no blur-closes-before-click race to paper over with a timer. */}
      <button type="button" role="option" id={`${id}-${i}`} aria-selected={i === activeIndex} onMouseDown={e => { e.preventDefault(); onPick(code); }}
        className={`block w-full px-3 py-1.5 text-left ${i === activeIndex ? "bg-surface-50" : ""}`}>
        <span className="block font-medium">{code.code} — {code.name}</span>
        <span className="block text-xs text-ink-500">{suggestionSummary(code)}</span>
      </button>
    </li>)}
  </ul>;
}

/**
 * The search box under the Process Steps table (spec 2026-09-26 §4 "Add" and "Insert"). Always
 * rendered; a chip or the ⋮ menu re-targets it by setting `insertAt`, and the section focuses it.
 * Enter picks the active option, ↑/↓ move `aria-activedescendant`, and Esc clears the query and
 * hands the cancel to the section, which resets the position and returns focus to the opener.
 */
export function ProcessCodeSearch({ catalog, disabled, title, insertAt, stepCount, onPick, onCancel }: {
  catalog: readonly ProcessEditorCode[]; disabled: boolean; title?: string;
  insertAt: number | null; stepCount: number;
  onPick: (code: ProcessEditorCode) => void; onCancel: () => void;
}) {
  const [query, setQuery] = useState(""); const [open, setOpen] = useState(false); const [active, setActive] = useState(0);
  const listboxId = useId(); const positionId = useId();
  const options = useMemo(() => searchOptions(catalog, query), [catalog, query]);
  const showList = open && !disabled && options.length > 0;
  // Clamped at render on both ends: ↓ on an empty list would otherwise leave -1 behind until the
  // next keystroke resets it, and a shrunken list must not point past its last option.
  const activeIndex = Math.max(0, Math.min(active, options.length - 1));
  const activeOptionId = showList ? `${listboxId}-${activeIndex}` : undefined;
  // The active option is scrolled into the list's view as the arrow keys move it (#665; the Shell
  // search's and StepWordsBox's precedent): the list scrolls, never the page.
  useEffect(() => {
    if (activeOptionId) document.getElementById(activeOptionId)?.scrollIntoView({ block: "nearest" });
  }, [activeOptionId]);
  // Rows may have been removed while the search stayed open at a later position (the section
  // clamps the pick the same way), so the label never names a step that no longer exists.
  const position = insertAt === null ? null : Math.min(insertAt, stepCount);
  function pick(code: ProcessEditorCode) { onPick(code); setQuery(""); setOpen(false); setActive(0); }
  function cancel() { setQuery(""); setOpen(false); setActive(0); onCancel(); }
  return <div className="relative mt-4">
    <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-xs font-medium text-ink-500">
      <span>Add a step</span>
      {position !== null && <span id={positionId} className="font-normal text-ink-500">{position === stepCount ? "Adding at the end" : `Inserting before step ${position + 1}`}</span>}
    </div>
    <input type="text" role="combobox" aria-label="Add a step — search code or name" aria-autocomplete="list" aria-expanded={showList}
      aria-controls={showList ? listboxId : undefined} aria-activedescendant={activeOptionId}
      aria-describedby={position !== null ? positionId : undefined}
      value={query} placeholder="Search code or name" disabled={disabled} title={title} autoComplete="off"
      onChange={e => { setQuery(e.target.value); setOpen(true); setActive(0); }}
      onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onBlur={() => setOpen(false)}
      onKeyDown={e => {
        if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive(a => Math.min(a + 1, options.length - 1)); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
        else if (e.key === "Enter") { const code = showList ? options[activeIndex] : undefined; if (code) { e.preventDefault(); pick(code); } }
        else if (e.key === "Escape") { e.preventDefault(); cancel(); }
      }}
      className={`${INPUT_COMPACT} w-full disabled:cursor-not-allowed disabled:bg-surface-50`} />
    {showList && <ProcessCodeListbox id={listboxId} options={options} activeIndex={activeIndex} onPick={pick} />}
    {open && !disabled && query.trim() !== "" && !options.length && <p className="mt-1 text-xs text-ink-500">No matching process codes.</p>}
  </div>;
}
