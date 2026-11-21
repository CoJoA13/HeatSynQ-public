// Enter commits a single-line blur-save box (owner ruling R7, 2026-10-22): the guard's
// `onEnterCommit` asks this, and so do the boxes outside the guard. Import-free, typed
// structurally so a test can hand it a plain object.

/** The part of a key event this reads. */
export type EnterKeyEvent = {
  key: string;
  nativeEvent?: { isComposing?: boolean };
  preventDefault(): void;
};

/** True for an Enter that commits, which it also claims (`preventDefault`, so a form around the
 *  box never submits). An Enter that ends an IME composition is the composition's, not a commit. */
export function isEnterCommit(e: EnterKeyEvent): boolean {
  if (e.key !== "Enter" || e.nativeEvent?.isComposing) return false;
  e.preventDefault();
  return true;
}
