"use client";
import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { enterPick, filterOptions, listPlacement, openHighlight, pickAction, stepHighlight, type ComboboxOption, type ListPlacement } from "@/lib/combobox";
import { INPUT_COMPACT } from "@/lib/ui-classes";

export type { ComboboxOption } from "@/lib/combobox";

// Generic keyboard-first typeahead: a plain <select> can't satisfy the design spec's "autocomplete
// pickers (customer by code/name; part by number)" requirement (no substring filter as you type),
// so this is a small self-built combobox rather than a native control. New order's customer and
// part pickers and the hub's Add rider were its first users; since #1056 (owner ruling 2026-11-25)
// it is every growing record list's picker: customers, parts, ship-to addresses, Add order, Apply
// to, GL accounts, step codes and the template Preview record. Its decisions are the leaf
// src/lib/combobox.ts; a caller hands it options already in their order (src/lib/menu-order.ts
// where the list is sorted), a blank choice ("All customers", "— none —") as an option whose value
// is "", and a current value the list does not hold as an option of its own.
//
// `disabled`/`disabledReason` per option (not the same as the whole-combobox `disabled` prop
// below): a disabled OPTION is still visible and findable by search — §5.16's "say why, never
// hide" rule applied to a single choice rather than the whole control — it just can't be
// committed. Used by OrderLineCard to show "No process steps" on a part in the LEAD slot (spec
// §11) while leaving it perfectly selectable as a rider.
export function Combobox({
  value, options, onSelect, placeholder, disabled, title, ariaLabel, id, className, ref,
}: {
  value: string | null;
  options: ComboboxOption[];
  onSelect: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  /** The input's id: a `<label htmlFor>` and a refusal's box routing find it by this. */
  id?: string;
  /** Classes for the picker's wrapper, its width above all (the input fills it). */
  className?: string;
  /** The input element, for a caller that focuses the picker (the parts list's Add part). */
  ref?: Ref<HTMLInputElement>;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [placement, setPlacement] = useState<ListPlacement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement, []);

  const selected = options.find((o) => o.value === value);
  const filtered = filterOptions(options, query);

  // WAI-ARIA editable-combobox semantics (#37) — attributes only, the keyboard/commit machinery
  // above and below is untouched. One useId per instance keys the listbox and its options'
  // stable ids; the expanded/activedescendant pair tracks exactly the condition the dropdown
  // actually renders under, so a screen reader is never told about a popup that isn't there.
  const listboxId = useId();
  const showList = open && filtered.length > 0;
  const activeId = showList && filtered[highlight] ? `${listboxId}-${highlight}` : undefined;
  // The highlighted option is scrolled into the list's view as the arrow keys move it (#665; the
  // Shell search's and StepWordsBox's precedent): the list scrolls within its own height, never the
  // page, and the focus stays in the box.
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);
  // While the list is open and nothing is typed, the highlight follows the held value as the list's
  // values change, so a list that lands after the focus highlights the value then (`openHighlight`).
  // Keyed on the values, not the array: a caller builds a new array each render, and an arrow key's
  // render must not put the highlight back.
  const optionValues = options.map((o) => o.value).join("\u0000");
  useEffect(() => {
    if (open && query === "") setHighlight(openHighlight(options, value));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `optionValues` stands for `options`
  }, [open, query, optionValues, value]);
  // The list is placed `fixed` under (or over) the input, so a container that scrolls sideways
  // cannot clip it, and it follows the input while anything scrolls or the window resizes.
  useLayoutEffect(() => {
    if (!showList) return;
    const place = () => {
      const box = inputRef.current?.getBoundingClientRect();
      if (box) setPlacement(listPlacement(box, window.innerHeight));
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [showList]);

  function commit(opt: ComboboxOption) {
    // A disabled option is a belt to the native `disabled` attribute below, which already blocks
    // the mouse path — this closes the keyboard path (Enter on a highlighted-but-disabled option
    // calls commit() directly, with no per-element disabled check of its own). The value already
    // held only closes the list, as a native select fires no change for it.
    const action = pickAction(opt, value);
    if (action === "ignore") return;
    if (action === "commit") onSelect(opt.value);
    setQuery("");
    setOpen(false);
  }

  // Selecting an option keeps the input focused on purpose (the dropdown option commits via
  // onMouseDown + preventDefault below, precisely so focus never leaves) — but that means a
  // second click on the SAME already-focused input, to change a decision, fires no new "focus"
  // event at all (the DOM only fires focus on an actual transition). Without this, the very next
  // keystroke lands inside the still-displayed old label instead of starting a fresh search
  // (caught live in this task's dev-server smoke test, re-picking a lead part after an initial
  // wrong pick). onClick fires on every click, focused-already or not, so wiring the same reset
  // there closes it; it is a harmless no-op duplicate on a genuine fresh-focus click.
  function openFresh() {
    setOpen(true);
    setQuery("");
    setHighlight(openHighlight(options, value));
  }

  return (
    <div className={`relative ${className ?? ""}`}>
      <input
        ref={inputRef}
        id={id}
        // The value the picker holds, where the input's own value is the label it shows: what a
        // native select's value was, for a reader that needs the id (the E2E flows).
        data-value={value ?? ""}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        value={open ? query : (selected?.label ?? "")}
        placeholder={placeholder}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        onFocus={openFresh}
        onClick={openFresh}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setHighlight(0); }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => stepHighlight(h, 1, filtered.length)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => stepHighlight(h, -1, filtered.length)); }
          else if (e.key === "Enter") { const opt = enterPick(showList, filtered, highlight); if (opt) { e.preventDefault(); commit(opt); } }
          else if (e.key === "Escape") { setOpen(false); setQuery(""); }
        }}
        className={`${INPUT_COMPACT} w-full disabled:cursor-not-allowed disabled:bg-surface-50`}
      />
      {showList && (
        <ul role="listbox" id={listboxId} style={placement ?? { visibility: "hidden" }}
            className="fixed z-50 overflow-auto rounded border bg-surface-0 text-sm shadow-lg">
          {/* role="presentation" on the li: the option role lives on the button (the element that
              carries the native `disabled` this pattern keeps), and a bare listitem is not a
              valid child of a listbox. */}
          {filtered.map((opt, i) => (
            <li key={opt.value} role="presentation">
              {/* onMouseDown + preventDefault, not onClick: preventing the mousedown's default
                  stops the input from ever blurring, so there is no blur-closes-before-click race
                  to work around with a timer. A native `disabled` button fires neither mousedown
                  nor click in the first place — commit()'s own `if (opt.disabled) return` above
                  is what closes the keyboard (Enter) path, which never touches this element. */}
              {/* tabIndex -1: the options are reached by the arrows from the input, never by Tab,
                  so Tab out of an open picker lands on the next field rather than on an option the
                  blur then unmounts (Codex on #1062). */}
              <button type="button" role="option" id={`${listboxId}-${i}`} data-value={opt.value} tabIndex={-1}
                      aria-selected={opt.value === value}
                      aria-disabled={opt.disabled || undefined}
                      disabled={opt.disabled} title={opt.disabled ? opt.disabledReason : undefined}
                      onMouseDown={(e) => { e.preventDefault(); commit(opt); }}
                      className={`block w-full px-2 py-1 text-left ${i === highlight ? "bg-surface-50" : ""} ${opt.disabled ? "cursor-not-allowed text-ink-500" : ""}`}>
                {opt.label}{opt.disabled && opt.disabledReason ? ` — ${opt.disabledReason}` : ""}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
