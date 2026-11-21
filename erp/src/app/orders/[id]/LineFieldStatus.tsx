"use client";
// The mark beside an order hub Qty or Weight box (the quantity corrections design §4). Presentation
// only: no state, no hook, and no request of its own. What a box shows and whether it reads Saved
// or Not saved is decided in src/lib/line-field-saves.ts (`fieldView`); LinesSection holds the
// state, hands the view here, and is what acts when Restore is clicked.
import type { ReactNode } from "react";
import type { FieldView } from "@/lib/line-field-saves";
import { SavedMark } from "@/components/SavedMark";
import { LINK } from "@/lib/ui-classes";

/**
 * `fieldLabel` is the input's own accessible name ("Lead quantity", "Line 2 weight"); `server` is
 * the stored value as the box would show it.
 *
 * - Saved: a status, shown while the box still shows the value that was saved.
 * - Not saved: an alert, with a Restore control that puts the stored value back in the box.
 *
 * What Restore does is the section's (`restore` in LinesSection, asking `restoreIntent`). Where no
 * save of the box went unanswered it clears the box and sends nothing. While the box records a
 * save the server did not answer it SAVES the stored value, as one PATCH (owner ruling
 * 2026-10-07), so Restore is not always local.
 *
 * It still takes no permission or void gate (the DiscardButton rule,
 * src/components/DiscardButton.tsx): a refused value on an order that has since been voided must
 * still be clearable, or the page keeps asking about unsaved work nothing on it can clear. That
 * holds for the Restore that clears. Where it sends, the server refuses a voided order or a
 * caller without orders.edit, and that refusal does not take the box's record away: the box reads
 * Not saved over the stored value and the next Restore is sent and refused again, until the page
 * is reloaded. No order payload ends it, whatever value it shows. That is a known cost,
 * taken so that neither a refusal of a later request nor a payload that may be older than the
 * lost write can ever clear a box whose earlier save may have been committed. Gating the control
 * would not remove that cost (the box would stay Not saved all the same), and it would take away
 * the Restore that clears.
 *
 * It is disabled only while that field's newest save is in flight (an older one that a newer save
 * replaced is not waited for: the box waits on one attempt): clearing the box cannot unsend a
 * request that is about to change the stored value, and a Restore that saves is itself such a
 * request. Should the older one end with no answer after a Restore that cleared, the box reads
 * Not saved again, over the stored value, and this control then saves it.
 */
export function FieldMark({ fieldLabel, view, server, onRestore }: {
  fieldLabel: string;
  view: FieldView;
  server: string;
  onRestore: () => void;
}): ReactNode {
  if (view.mark === "saved") return <SavedMark label={fieldLabel} show />;
  if (view.mark !== "not-saved") return null;
  return (
    <>
      <span role="alert" aria-label={`${fieldLabel} not saved`} className="ml-2 text-xs font-medium text-red-700">Not saved</span>
      <button type="button" disabled={view.saving}
              title={view.saving ? "Wait for this save to finish before restoring" : undefined}
              aria-label={`Restore ${fieldLabel} to ${server}`}
              // Keep focus in the input until the click, as DiscardButton does. Without this the
              // pointer-down blurs the input, the blur saves a value retyped over the refused one,
              // that save disables this button, and the click never lands: the operator pressed
              // Restore and the order took the retyped value instead. This handler does not affect
              // keyboard activation: Enter or Space on the button still restores, with focus on
              // the button. After a Restore that only clears, the box no longer reads Not saved,
              // so this button unmounts with focus on it. After a Restore that saves, the button
              // stays mounted and disabled, and the box stays Not saved, until that save lands;
              // then it unmounts. If the save fails it is enabled again. Nothing returns focus to
              // the box in any of these.
              onPointerDown={(event) => event.preventDefault()} onClick={onRestore}
              className={`${LINK} ml-2 text-xs`}>
        {`Restore ${server}`}
      </button>
    </>
  );
}
