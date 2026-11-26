"use client";
import { useId } from "react";
import type { Gate } from "@/lib/permission-ui";
import { ORDER_STATUSES, ORDER_STATUS_LABELS, type OrderStatusValue } from "@/lib/order-constants";
import type { BoardFilters } from "@/lib/board-columns";
import { INPUT_COMPACT, LINK } from "@/lib/ui-classes";
import { Combobox } from "@/components/Combobox";
import { customerOptions } from "@/lib/menu-options";

// Presentational only (#33's bounded slice): filter state and its update handlers stay in the
// board page (src/app/page.tsx) — this file renders the filter row, the Export link (built from
// the SAME queryString the board's own fetch uses, so the file can never disagree with the table),
// and the Columns toggle button.

// The parts/page.tsx precedent: only the slice the customer filter picker needs.
export type CustomerOption = { id: string; code: string; name: string; active: boolean };

type Props = {
  filters: BoardFilters;
  customers: CustomerOption[];
  customersGate: Gate;
  queryString: string;
  columnsOpen: boolean;
  onUpdateFilters: (patch: Partial<BoardFilters>) => void;
  onToggleStatus: (s: OrderStatusValue) => void;
  onToggleColumnsOpen: () => void;
};

export function FilterBar({
  filters, customers, customersGate, queryString, columnsOpen,
  onUpdateFilters, onToggleStatus, onToggleColumnsOpen,
}: Props) {
  const id = useId();
  return (
    <div className="mb-3 flex flex-wrap items-end gap-4 rounded border bg-surface-0 p-2 text-sm">
      <div>
        <label htmlFor={`${id}-search`} className="block text-xs text-ink-500">Search</label>
        <input id={`${id}-search`} value={filters.search} onChange={(e) => onUpdateFilters({ search: e.target.value })}
               placeholder="Order #, PO, VS #, lead part, customer"
               className={`${INPUT_COMPACT} w-64`} />
      </div>

      <fieldset>
        <legend className="block text-xs text-ink-500">Status</legend>
        <div className="flex flex-wrap gap-2">
          {ORDER_STATUSES.map((s) => (
            <label key={s} className="flex items-center gap-1">
              <input type="checkbox" checked={filters.status.includes(s)} onChange={() => onToggleStatus(s)} />
              {ORDER_STATUS_LABELS[s]}
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label htmlFor={`${id}-customer`} className="block text-xs text-ink-500">Customer</label>
        <Combobox id={`${id}-customer`} value={filters.customerId} options={customerOptions(customers, { blank: "All customers", markInactive: true })}
                onSelect={(v) => onUpdateFilters({ customerId: v })}
                disabled={!customersGate.allowed} title={customersGate.allowed ? undefined : customersGate.title} ariaLabel="Customer" className="w-64" />
      </div>

      <div>
        <label className="block text-xs text-ink-500">Received</label>
        <div className="flex items-center gap-1">
          <input type="date" aria-label="Received from" value={filters.receivedFrom} onChange={(e) => onUpdateFilters({ receivedFrom: e.target.value })}
                 className={INPUT_COMPACT} />
          <span>&ndash;</span>
          <input type="date" aria-label="Received to" value={filters.receivedTo} onChange={(e) => onUpdateFilters({ receivedTo: e.target.value })}
                 className={INPUT_COMPACT} />
        </div>
      </div>

      <div>
        <label className="block text-xs text-ink-500">Request</label>
        <div className="flex items-center gap-1">
          <input type="date" aria-label="Request from" value={filters.requestFrom} onChange={(e) => onUpdateFilters({ requestFrom: e.target.value })}
                 className={INPUT_COMPACT} />
          <span>&ndash;</span>
          <input type="date" aria-label="Request to" value={filters.requestTo} onChange={(e) => onUpdateFilters({ requestTo: e.target.value })}
                 className={INPUT_COMPACT} />
        </div>
      </div>

      <label className="flex items-center gap-1">
        <input type="checkbox" checked={filters.includeVoided}
               onChange={(e) => onUpdateFilters({ includeVoided: e.target.checked })} />
        Include voided
      </label>

      <a href={`/api/orders/export${queryString ? `?${queryString}` : ""}`} className={LINK}>
        Export to Excel
      </a>

      <button type="button" aria-expanded={columnsOpen} onClick={onToggleColumnsOpen}
              className={LINK}>
        {columnsOpen ? "Hide columns" : "Columns"}
      </button>
    </div>
  );
}
