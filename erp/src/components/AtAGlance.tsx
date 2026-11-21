// The "At a glance" card beside a record's tab panels (spec 2026-10-30-ux-redesign-design.md
// §4.4; owner ruling 7 of 2026-10-30): label/value rows the page supplies from its own loaded
// record, and whatever the page keeps beside them (on the hub: the reconciliation strip, the
// traveler notice and the print button). Sticky at the right from 1360px; under that it is full
// width under the tab row (spec §3). Client-safe, no state.
import type { ReactNode } from "react";
import { CARD, LABEL } from "@/lib/ui-classes";

export function AtAGlance({ title = "At a glance", rows, children }: {
  title?: string;
  rows: { label: string; value: ReactNode }[];
  children?: ReactNode;
}) {
  return (
    <aside role="region" aria-label={title} className={`${CARD} w-full min-[1360px]:sticky min-[1360px]:top-4 min-[1360px]:w-[292px] min-[1360px]:shrink-0`}>
      <h2 className="mb-3 text-[17px] font-semibold text-ink-800">{title}</h2>
      <dl className="flex flex-col gap-3">
        {rows.map((row) => (
          <div key={row.label}>
            <dt className={LABEL}>{row.label}</dt>
            <dd><div className="text-[15px] font-medium text-ink-800">{row.value}</div></dd>
          </div>
        ))}
      </dl>
      {children}
    </aside>
  );
}
