// A page's title row (spec 2026-10-30-ux-redesign-design.md §4.3): title, a one-line subtitle
// under it, the actions at the right with the primary first. Every page's <h1> moves into it in
// that page's PR. Client-safe, no state.
import type { ReactNode } from "react";
import { TEXT_MUTED } from "@/lib/ui-classes";

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex items-start gap-4">
      <div className="min-w-0">
        <h1 className="text-[28px] font-semibold leading-[39px] text-ink-800">{title}</h1>
        {subtitle !== undefined && <p className={TEXT_MUTED}>{subtitle}</p>}
      </div>
      {/* The slot may shrink and its controls wrap: the saved shipment puts five in it (PR 4). */}
      {actions !== undefined && <div className="ml-auto flex min-w-0 flex-wrap justify-end gap-2">{actions}</div>}
    </div>
  );
}
