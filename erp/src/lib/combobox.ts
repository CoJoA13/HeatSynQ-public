// The typeahead picker's decisions (#1056; the component is src/components/Combobox.tsx). A pure,
// client-safe leaf, so each rule is provable without a renderer.

/** One choice. A disabled option still shows and is still found by typing (§5.16: say why, never
 * hide); it just cannot be committed. A blank choice ("All customers", "— none —") is an option
 * whose value is "". */
export type ComboboxOption = { value: string; label: string; disabled?: boolean; disabledReason?: string };

/** The options whose label holds the typed text anywhere, ignoring case, in the order given: a
 * customer is found by its code or its name, since the label carries both. */
export function filterOptions(options: readonly ComboboxOption[], query: string): readonly ComboboxOption[] {
  const typed = query.trim().toLowerCase();
  return typed ? options.filter((o) => o.label.toLowerCase().includes(typed)) : options;
}

/** Where the highlight sits while the list is open with nothing typed: on the value the picker
 * holds, so Enter on a freshly opened list re-picks it, which sends nothing (`pickAction`). A value
 * no option holds (the list not read yet, or a required pick not made) highlights no row (-1), so
 * Enter does nothing until a row is chosen with the arrows or by typing. Starting on the top row
 * would make a tab-in and Enter on a save-on-change menu (billing's GL accounts, a shipment's
 * Ship-to) save its blank. The picker asks again whenever its options change while it is open and
 * nothing is typed, as a list that lands after the focus does. */
export function openHighlight(options: readonly ComboboxOption[], value: string | null): number {
  return options.findIndex((o) => o.value === value);
}

/** The highlight after an arrow key: down from no row is the first row, up from no row stays on
 * the first, and neither passes either end. */
export function stepHighlight(highlight: number, by: 1 | -1, count: number): number {
  if (count === 0) return -1;
  return Math.max(0, Math.min(highlight + by, count - 1));
}

/** The option Enter picks: the highlighted row of the list on screen, and nothing while the list is
 * closed. A pick closes the list with the highlight left where it was, on a row of the now-unfiltered
 * options (the blank, on a save-on-change menu), so a second Enter must not reach it. */
export function enterPick(shown: boolean, filtered: readonly ComboboxOption[], highlight: number): ComboboxOption | null {
  return shown ? filtered[highlight] ?? null : null;
}

/** What a pick does: a disabled option does nothing, the value already held only closes the list
 * (a native select fires no change for it, and a save-on-change menu must send nothing), and any
 * other commits. */
export function pickAction(option: ComboboxOption, value: string | null): "commit" | "close" | "ignore" {
  if (option.disabled) return "ignore";
  return option.value === value ? "close" : "commit";
}

const GAP = 4;
const MAX_HEIGHT = 224;
const MIN_HEIGHT = 96;

export type ListPlacement = { left: number; width: number; maxHeight: number } & ({ top: number } | { bottom: number });

/** Where the open list sits, in viewport pixels, for a box at `box`: below it at its width, or above
 * it when the room below is short of a full list and the room above is larger. The list is placed
 * `fixed`, so a table or card that scrolls sideways (`overflow-x-auto`) cannot clip it. */
export function listPlacement(box: { top: number; bottom: number; left: number; width: number }, viewportHeight: number): ListPlacement {
  const below = viewportHeight - box.bottom - GAP;
  const above = box.top - GAP;
  const height = (room: number) => Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, room));
  if (below >= MAX_HEIGHT || below >= above) {
    return { left: box.left, width: box.width, top: box.bottom + GAP, maxHeight: height(below) };
  }
  return { left: box.left, width: box.width, bottom: viewportHeight - box.top + GAP, maxHeight: height(above) };
}
