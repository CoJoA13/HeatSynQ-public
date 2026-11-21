// The one shared panel message (owner ruling R1 of the 2026-10-22 review: a section's or row's
// refusal shows beside its control, app-wide; the page-top banner is for page-level actions).
// Lifted from the saved shipment page's order panel (#472), which re-exports it, so a message
// rendered beside a Close row, a Close button or a shipment grid is the same element:
// `<p role="alert">`, pre-line, red. `null` draws nothing.
export function PanelMessage({ message }: { message: string | null }) {
  if (message === null) return null;
  return <p role="alert" className="mt-1 whitespace-pre-line text-sm text-red-700">{message}</p>;
}
