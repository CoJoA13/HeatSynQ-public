"use client";

import { formatNumber } from "@/lib/format";
import { summarizeLoadAllocation, type AllocationLine, type AllocationMetric, type AllocationRow } from "@/lib/load-allocation";
import { BADGE_WARNING } from "@/lib/ui-classes";
import { NET_WEIGHT } from "@/lib/weight-terms";

const ZERO = BigInt(0);
const HUNDRED = BigInt(100);

function whole(value: bigint): string {
  // Use the shared screen formatter wherever Number can represent the integer exactly.
  return Number.isSafeInteger(Number(value)) ? formatNumber(String(value)) : value.toLocaleString("en-US");
}

function display(value: bigint | null, weight: boolean): string {
  if (value === null) return "—";
  // Format the exact integer and fractional portions independently: converting a large cents
  // sum to floating pounds can lose the last cent before formatNumber ever sees it.
  return weight ? `${whole(value / HUNDRED)}.${String(value % HUNDRED).padStart(2, "0")}` : whole(value);
}

function Metric({ label, value, weight = false }: { label: string; value: AllocationMetric; weight?: boolean }) {
  const unavailable = value.difference === null;
  const mismatch = value.difference !== null && value.difference !== ZERO;
  const warning = unavailable || value.incomplete || mismatch;
  const unit = weight ? " lb" : " pcs";
  let message: string;
  if (unavailable) {
    message = value.allocated === null ? "Invalid entry — check load values" : "Order total unavailable";
  } else if (value.difference === ZERO) {
    message = value.incomplete ? "Incomplete — blank values count as zero" : "Matches order";
  } else {
    const difference = value.difference!;
    const amount = display(difference < ZERO ? -difference : difference, weight);
    message = `${amount}${unit} ${difference < ZERO ? "remaining" : "over"}`;
    if (value.incomplete) message = `Incomplete — ${message}; blank values count as zero`;
  }
  return (
    <div className={`rounded border px-3 py-2 ${warning ? "border-accent-400 bg-accent-50" : "border-line bg-surface-50"}`}>
      <dt className="text-xs font-medium text-ink-500">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums text-ink-800">{`${display(value.allocated, weight)} / ${display(value.ordered, weight)}${unit}`}</dd>
      <dd className={`mt-1 text-xs ${warning ? "text-accent-600" : "text-ink-500"}`}>{message}</dd>
    </div>
  );
}

export function LoadAllocationSummary({ rows, lines, dirty, ready }: {
  rows: readonly AllocationRow[];
  lines: readonly AllocationLine[];
  dirty: boolean;
  ready: boolean;
}) {
  if (!ready) return <p className="mb-3 text-sm text-ink-500">Load totals will be available when the editor is ready.</p>;
  const summary = summarizeLoadAllocation(rows, lines);
  return (
    <div className="mb-3" role="group" aria-label="Load allocation">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="text-sm font-medium text-ink-800">{rows.length} load{rows.length === 1 ? "" : "s"} · Allocated / order total</p>
        {dirty && <span className={BADGE_WARNING}>Unsaved totals</span>}
      </div>
      <dl className="grid gap-2 sm:grid-cols-2">
        <Metric label="Quantity" value={summary.quantity} />
        <Metric label={NET_WEIGHT} value={summary.weight} weight />
      </dl>
      <p className="mt-2 text-xs text-ink-500">Includes all order parts. Allocation differences are warnings.</p>
    </div>
  );
}
