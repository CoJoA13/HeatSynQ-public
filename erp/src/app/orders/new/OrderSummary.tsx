import { formatNumber } from "@/lib/format";
import type { EntryPlanPreview, LoadLimits } from "@/lib/order-entry-plan";
import { NET_WEIGHT } from "@/lib/weight-terms";

export type PlanAvailability = "incomplete" | "loading" | "error" | "ready";

/** Avoid converting an aggregate of validated cents back through a lossy floating sum. */
export function formatEntryWeightCents(value: string): string {
  const cents = BigInt(value);
  return `${(cents / BigInt(100)).toLocaleString("en-US")}.${String(cents % BigInt(100)).padStart(2, "0")}`;
}

export function loadLimitsLabel(limits: LoadLimits): string {
  const values = [limits.loadQty === null ? null : `${formatNumber(limits.loadQty)} pieces`,
    limits.loadWeight === null ? null : `${formatNumber(limits.loadWeight, 2)} lb`].filter(Boolean);
  return values.length ? `${values.join(" and ")} / load` : "No quantity or weight cap";
}

export function OrderSummary({ customerName, poNumber, customerJobNo, leadPartName,
  totalQty, totalWeight, eachWeight, containerCount, preview, availability, travelerCount }: {
  customerName: string | null; poNumber: string; customerJobNo: string; leadPartName: string | null;
  totalQty: number | null;
  /** Exact decimal pounds, already summed as integer cents by the entry coordinator. */
  totalWeight: string | null; eachWeight: number | null; containerCount: number | null;
  preview: EntryPlanPreview | null; availability: PlanAvailability; travelerCount: number | null;
}) {
  const current = availability === "ready" ? preview : null;
  const row = (label: string, value: string) => <div key={label} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] gap-3 py-1.5">
    <dt className="text-ink-500">{label}</dt><dd className="break-words">{value}</dd>
  </div>;
  return <>
    <h2 className="mb-3 text-lg font-semibold">Order & traveler plan</h2>
    <dl className="text-sm">
      {row("Customer", customerName || "—")}{row("PO number", poNumber || "—")}
      {row("Customer job", customerJobNo || "—")}
      <div className="my-3 border-t border-line" />
      {row("Lead part", leadPartName || "—")}
      {row("Quantity", totalQty === null ? "—" : `${formatNumber(totalQty)} pieces`)}
      {row("Each weight (lead)", eachWeight === null ? "—" : `${formatNumber(eachWeight, 4)} lb`)}
      {row(NET_WEIGHT, totalWeight === null ? "—" : `${totalWeight} lb`)}
      <div className="my-3 border-t border-line" />
      {row("Containers", containerCount === null ? "Incomplete" : formatNumber(containerCount))}
      {row("Process revision", current ? formatNumber(current.revisionNumber) : "—")}
      {row("Load limits", current ? loadLimitsLabel(current.effective) : "—")}
      {row("Planned loads", current ? formatNumber(current.loads.length) : "—")}
      {row("Travelers", current && travelerCount !== null ? formatNumber(travelerCount) : "—")}
    </dl>
    {availability !== "ready" && <p role="status" className="mt-3 text-xs text-ink-500">
      {availability === "loading" ? "Updating load plan…" : availability === "error"
        ? "Load plan unavailable. Review Process & loads." : "Complete the customer, part quantities and weights to see a load plan."}
    </p>}
  </>;
}
