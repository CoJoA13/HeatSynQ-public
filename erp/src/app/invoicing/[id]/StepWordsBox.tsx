"use client";
import { useEffect, useId, useMemo, useState } from "react";
import { matchingSuggestions, suggestionLabel } from "@/lib/invoice-step-pick";
import type { StepSuggestion } from "@/lib/invoice-step-suggestions";
import { INPUT_COMPACT } from "@/lib/ui-classes";

/** The listbox half, rendered on its own so its markup is testable without opening the box (the
 *  `ProcessCodeListbox` precedent). `activeIndex` -1 is no option active. */
export function StepSuggestionList({ id, options, activeIndex, onPick }: {
  id: string; options: readonly StepSuggestion[]; activeIndex: number; onPick: (suggestion: StepSuggestion) => void;
}) {
  // The list's own mouse-down keeps the focus in the box too: a press on its scrollbar, or between
  // options, would otherwise blur the box, which closes the list under the pointer.
  return <ul role="listbox" id={id} aria-label="Step suggestions" onMouseDown={(e) => e.preventDefault()}
    className="absolute z-20 mt-1 max-h-72 w-full min-w-64 overflow-auto rounded border bg-surface-0 text-sm shadow-lg">
    {options.map((suggestion, i) => <li key={suggestion.id} role="presentation">
      {/* onMouseDown + preventDefault (the Combobox and ProcessCodeSearch precedent): the box never
          blurs, so there is no blur-closes-before-click race to paper over with a timer. Out of the
          tab order: the arrow keys reach an option through `aria-activedescendant`, and Tab leaves
          the box for the next cell rather than for an option its blur is about to take away. */}
      <button type="button" role="option" id={`${id}-${i}`} aria-selected={i === activeIndex} tabIndex={-1}
        onMouseDown={(e) => { e.preventDefault(); onPick(suggestion); }}
        className={`block w-full px-3 py-1.5 text-left ${i === activeIndex ? "bg-surface-50" : ""}`}>{suggestionLabel(suggestion)}</button>
    </li>)}
  </ul>;
}

/**
 * An invoice operation line's description box (#587, Amendments 15, 16, 23): a free-text box (the
 * row's words, typed as before) with a list of the part's steps, then every other step code. A
 * controlled input over the row's `description`; the grid applies what a keystroke or a pick writes
 * (`typedPatch`, `pickPatch` in invoice-step-pick.ts), so this holds only the list's own state.
 *
 * Two choices differ from `ProcessCodeSearch`, because the box's text is the line's words rather
 * than a search query:
 * - The list opens on focus (or a click) with every suggestion: a Needs price line reads "Needs
 *   price", and filtering by the words already in the box would offer nothing. After a keystroke the
 *   list is filtered by the box's whole text as it then stands (`typed`), the way a native list
 *   filters: text added to "Needs price" matches nothing, so the operator picks from the opened list
 *   or replaces the words. A pick, Escape or leaving the box clears the filter, and ↓, or a click on
 *   the box, when nothing matches brings the whole list back.
 * - No option is active until ↓ makes one so (manual selection): typed words are a finished answer
 *   (587-8), so Enter picks only an option the arrow keys made active and otherwise does nothing.
 *   ↑ from the first option goes back to none. Escape closes the list and leaves the words alone.
 */
export function StepWordsBox({ value, suggestions, disabled, title, ariaLabel, onType, onPick }: {
  value: string; suggestions: readonly StepSuggestion[]; disabled: boolean; title?: string; ariaLabel: string;
  onType: (value: string) => void; onPick: (suggestion: StepSuggestion) => void;
}) {
  const [open, setOpen] = useState(false);
  /** The box's whole text as it stood after a keystroke made since the list opened; null (no
   *  keystroke yet) shows the whole list. */
  const [typed, setTyped] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const listboxId = useId();
  const options = useMemo(() => matchingSuggestions(suggestions, typed), [suggestions, typed]);
  const showList = open && !disabled && options.length > 0;
  // Clamped at render: the list can shrink under an active option (the read landing, a re-render
  // with fewer suggestions), and must never point past its last option. -1 stays -1.
  const activeIndex = Math.min(active, options.length - 1);
  const activeOptionId = showList && activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined;
  // The active option is scrolled into the list's view as the arrow keys move it (the Shell search's
  // precedent): a long list scrolls within its own height while the focus stays in the box.
  useEffect(() => {
    if (activeOptionId) document.getElementById(activeOptionId)?.scrollIntoView({ block: "nearest" });
  }, [activeOptionId]);
  /** On focus or a click: the whole list, nothing active. A list already showing is left as it is;
   *  an open list that typed text has emptied is reset to the whole list. */
  function openFresh() {
    if (open && options.length > 0) return;
    setOpen(true); setTyped(null); setActive(-1);
  }
  function close() { setOpen(false); setTyped(null); setActive(-1); }
  function pick(suggestion: StepSuggestion) { onPick(suggestion); close(); }
  return <div className="relative">
    <input type="text" role="combobox" aria-label={ariaLabel} aria-autocomplete="list" aria-expanded={showList}
      aria-controls={showList ? listboxId : undefined}
      aria-activedescendant={activeOptionId}
      value={value} disabled={disabled} title={title} autoComplete="off"
      onChange={(e) => { onType(e.target.value); setTyped(e.target.value); setOpen(true); setActive(-1); }}
      onFocus={openFresh} onClick={openFresh} onBlur={close}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          // Closed, or open with typed text that matches nothing: the whole list, the first active.
          if (!open || options.length === 0) { setOpen(true); setTyped(null); setActive(0); }
          else setActive(Math.min(activeIndex + 1, options.length - 1));
        } else if (e.key === "ArrowUp") {
          if (showList) { e.preventDefault(); setActive(Math.max(activeIndex - 1, -1)); }
        } else if (e.key === "Enter") {
          const suggestion = showList && activeIndex >= 0 ? options[activeIndex] : undefined;
          if (suggestion) { e.preventDefault(); pick(suggestion); }
        } else if (e.key === "Escape") {
          if (open) { e.preventDefault(); close(); }
        }
      }}
      className={`${INPUT_COMPACT} w-full disabled:bg-surface-50`} />
    {showList && <StepSuggestionList id={listboxId} options={options} activeIndex={activeIndex} onPick={pick} />}
  </div>;
}
