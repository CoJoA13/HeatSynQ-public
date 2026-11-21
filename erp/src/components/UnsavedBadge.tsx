/**
 * The amber "Unsaved changes" pill an explicit-save editor shows beside its Save (#640, P7 step 3).
 * `SaveButton` draws it for its eight grids; the editors that register with the unsaved guard
 * themselves (the quote header, the template editor, a part's Custom fields, a certification's
 * readings, a receipt batch's Apply panel) draw this same piece, so unsaved work reads one way on
 * every page. It registers nothing: registration stays with `SaveButton` or the editor's own
 * `useUnsavedSection` (tests/unsaved-registration-sweep.test.ts holds that line).
 *
 * Shown only while `dirty`, which is exactly when the difference between the two save models
 * matters. A blur-save field never shows it: its value goes to the server as focus leaves it, and
 * where a refused one stays on screen (Qty and Weight on the order hub) the box itself says Not
 * saved. So the badge's presence IS the distinction. A caller hands it the editor's own dirty flag
 * and never work its Save cannot send (`SaveButton`'s `alsoUnsaved`, the quote's started break):
 * that work is still sitting visible in its own input, and a badge beside a Save this click cannot
 * enable reads as a broken control.
 */
import { BADGE_WARNING } from "@/lib/ui-classes";
export function UnsavedBadge({ dirty }: { dirty: boolean }) {
  if (!dirty) return null;
  return (
    <span className={BADGE_WARNING}>
      Unsaved changes
    </span>
  );
}
