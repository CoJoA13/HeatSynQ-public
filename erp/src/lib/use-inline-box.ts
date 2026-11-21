"use client";
import { useRef, useState } from "react";
import { recordSaved, savedShows } from "./saved-mark";
import type { InlineSave } from "./reference-inline-edit";

/**
 * One value of an existing pick-list row, edited in place. It issues no request: `onSave` does, and
 * answers true when the value was stored. After true the caller hands the value sent back as `stored`
 * (the table writes it into its row), until a read brings another, so the blur after Enter, with the
 * text unchanged, sends nothing. It answers false when the value is not known to be stored: the
 * table's own check refused it before any request, the server refused it, or the save got no answer,
 * in which case the caller has read the row again before it answers. `onSave` must not reject: the
 * box waits on it, and sends nothing more until it answers.
 *
 * Three rules, each held by tests/reference-table-inline-edit.test.tsx:
 * - One save at a time. Enter and then the blur that follows it are two events and one save. A box
 *   left with other text while a save is out is committed once that save was stored, over the value
 *   it stored (Codex P2 on #864). After false that text goes too, under the row's message.
 * - While the cursor is in the box its text is the operator's. A new `stored` from the table does
 *   not change what was typed. Once the cursor has left, the box shows `stored`.
 * - After false the box shows `stored` again, wherever the cursor is.
 *
 * `saved` says whether the box shows the value its newest landed save carried, for the one Saved
 * mark (owner ruling R7): set on a stored save alone.
 */
export function useInlineBox<V extends string | null>(args: {
  stored: unknown;
  decide: (stored: unknown, typed: string) => InlineSave<V>;
  onSave: (value: V) => Promise<boolean>;
  decimal?: boolean;
}) {
  const { stored, decide, onSave, decimal = false } = args;
  // What was typed, or null while the box shows the stored value.
  const [text, setText] = useState<string | null>(null);
  // What the newest landed save carried, or null with none in this visit.
  const [landed, setLanded] = useState<string | null>(null);
  // A save of this box is out. A ref, because Enter and the blur after it must both see it.
  const pending = useRef(false);
  const hasCursor = useRef(false);
  // The text the box was last left with while a save was out.
  const later = useRef<string | null>(null);
  const storedText = stored === null || stored === undefined ? "" : String(stored);
  const shown = text ?? storedText;

  async function commit(typed: string, over: unknown = stored) {
    if (pending.current) { later.current = typed; return; }
    const save = decide(over, typed);
    if (!save.send) {
      if (!hasCursor.current) setText(null);
      return;
    }
    pending.current = true;
    const saved = await onSave(save.value);
    pending.current = false;
    if (saved) setLanded(save.value ?? "");
    const next = later.current;
    later.current = null;
    if (saved && next !== null) { await commit(next, save.value); return; }
    if (!saved || !hasCursor.current) setText(null);
  }

  return {
    shown,
    saved: landed !== null && savedShows(recordSaved({}, "box", landed, decimal), "box", shown),
    onFocus: () => { hasCursor.current = true; },
    onType: (value: string) => setText(value),
    onLeave: (value: string) => { hasCursor.current = false; void commit(value); },
    onEnter: (value: string) => { void commit(value); },
  };
}
