"use client";
// When a grid's own message goes (#472). On the saved shipment page each grid of an order panel
// shows its refusals under its own Save row (design 2026-10-08 §3.4, owner ruling R-Q3), and that
// grid's successful save and its Discard clear them. The controller's ruling of 2026-10-08 adds
// one more: the message also goes when the grid has no unsaved edits left, by whatever route.
// Before it, a refused save followed by typing the saved value back left the sentence under a grid
// whose Save was disabled and whose Discard was hidden, with nothing but a reload to clear it.
//
// The two decisions are pure functions, so a vitest suite proves each without a renderer
// (tests/grid-message.test.tsx). The hook only remembers the last render's answer.
import { useState } from "react";

/**
 * Whether a grid is at rest: open for editing, with no unsaved edits.
 *
 * `dirty` and `canEdit` are `useBulkGrid`'s, and `dirty` alone would not do. A grid that is not in
 * editing mode (a save whose outcome is unknown, a draft its recovery notice holds, a read in
 * flight) shows its saved rows with no overlay, so its `dirty` reads false while what the operator
 * typed is still held unsaved. That grid is not at rest.
 */
export function gridAtRest(dirty: boolean, canEdit: boolean): boolean {
  return canEdit && !dirty;
}

/**
 * Whether a grid has just come to rest: it was not at rest the render before, and it is now.
 *
 * False while the grid stays away from rest, so a refusal is never cleared under a grid that
 * still has unsaved edits (a refused save leaves its grid dirty). False while it stays at rest,
 * so a message that arrives on a grid already at rest is shown. False when it leaves rest.
 */
export function cameToRest(wasAtRest: boolean, atRest: boolean): boolean {
  return !wasAtRest && atRest;
}

/**
 * Clears a grid's message in the render in which that grid comes to rest.
 *
 * The last render's answer is kept in state and compared during render, the way React documents
 * for adjusting state when a rendered value changes. `clear` is therefore called during render:
 * hand it a state setter of the component that calls this hook, and nothing else.
 *
 * A message set in the very render in which the grid comes to rest would be cleared with it. No
 * route on the page does that today: a refusal is reported from a save's answer or from a click,
 * and neither brings its own grid to rest.
 */
export function useMessageClearedAtRest(atRest: boolean, clear: (message: null) => void): void {
  const [wasAtRest, setWasAtRest] = useState(atRest);
  if (wasAtRest !== atRest) setWasAtRest(atRest);
  if (cameToRest(wasAtRest, atRest)) clear(null);
}
