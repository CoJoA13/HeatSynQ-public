import type { ReactNode } from "react";

/**
 * The record-level destroy action in a page's title row — Delete, Void, Discard — drawn one way
 * (#641, P7 step 5): a red bordered button. The five pages that already drew it (quote, invoice,
 * receipt batch, shipment, certification) are unchanged on screen; the customer page, the part page
 * (moved up from below History into its title row) and the three admin detail headers (step codes,
 * surcharges, templates) took it.
 *
 * It takes the page's gate as `disabled` and `title` props, never a `gate` object:
 * `tests/archival-gate-sweep.test.ts` finds a refusal only inside a `disabled={…}` attribute, so a
 * call site keeps that attribute for a future `useUnsavedPresent` verdict to stay provable.
 * `className` is for placement in the row (`ml-auto`), never colour. Since PR 2 of the redesign the
 * order's Void is one too, in its title row. `tests/danger-button.test.tsx` holds the census of sites.
 */
export function DangerButton({ onClick, disabled, title, className, children }: {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title}
            className={`rounded-md border border-danger-600 px-3 py-1.5 text-sm text-danger-600${className ? ` ${className}` : ""}`}>
      {children}
    </button>
  );
}
