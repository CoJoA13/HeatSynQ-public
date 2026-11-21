/**
 * The one green "Saved" beside a blur-save box (owner ruling R7, 2026-10-22; owner answer
 * 2026-10-29: every single-line blur-save box). Shown while the box still shows the value its
 * newest landed save carried; whether it does is `savedShows` (src/lib/saved-mark.ts), which the
 * page asks and hands here as `show`. The order hub Lines boxes' `FieldMark` draws this same span.
 * `label` is the box's own name ("PO number"), read as "<label> saved".
 */
export function SavedMark({ label, show }: { label: string; show: boolean }) {
  if (!show) return null;
  return <span role="status" aria-label={`${label} saved`} className="ml-2 text-xs text-success-700">Saved</span>;
}
