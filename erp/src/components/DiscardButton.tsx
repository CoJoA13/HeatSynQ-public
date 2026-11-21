"use client";

/** Local reset only (#309), independent of permission to WRITE the saved rows. A grid's own
 * pending save is the exception: resetting the overlay cannot unsend that request. The caller
 * supplies its own pending state, never the app-wide request count, so siblings remain usable. */
export function DiscardButton({ section, dirty, pending = false, onDiscard }: {
  section: string;
  dirty: boolean;
  pending?: boolean;
  onDiscard: () => void;
}) {
  if (!dirty) return null;
  return (
    <button type="button" onClick={onDiscard} disabled={pending}
            // Keep focus until the click: serial-entry blur otherwise adds rows above this
            // control between pointer-down and pointer-up, moving it out from under the pointer.
            // Keyboard activation still follows the normal button behavior.
            onPointerDown={(event) => event.preventDefault()}
            aria-label={`Discard changes to ${section.toLowerCase()}`}
            title={pending ? "Wait for this save to finish before discarding" : undefined}
            className="text-sm text-ink-500 underline">
      Discard
    </button>
  );
}
