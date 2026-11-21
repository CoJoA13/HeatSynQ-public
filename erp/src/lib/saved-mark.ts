// The one success mark of a blur-save box (owner ruling R7, 2026-10-22; owner answer 2026-10-29:
// every single-line blur-save box). A box reads Saved while it still shows the value its newest
// landed save carried, the order hub Lines rule (LineFieldStatus.tsx). A decimal box compares
// through `sameSentValue`, so its own re-spelling after the save ("0.55" for "0.5500") keeps the
// mark; any other box compares trimmed text. A box's record is set on its save's success path only.
import { sameSentValue } from "./line-field-saves";

export type SavedEntry = { value: string; decimal: boolean };
export type SavedRecord = Readonly<Record<string, SavedEntry>>;

/** The record after a save of `key` landed carrying `value`. */
export function recordSaved(last: SavedRecord, key: string, value: string, decimal = false): SavedRecord {
  return { ...last, [key]: { value, decimal } };
}

/** Whether the box `key`, now showing `shownText`, still shows the value its newest landed save
 *  carried. A box with no landed save in this visit shows nothing. */
export function savedShows(last: SavedRecord, key: string, shownText: string): boolean {
  const entry = Object.hasOwn(last, key) ? last[key] : undefined;
  if (!entry) return false;
  return entry.decimal ? sameSentValue(entry.value, shownText) : entry.value.trim() === shownText.trim();
}
