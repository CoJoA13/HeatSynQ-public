"use client";
// The hub's "At a glance" card (spec 2026-10-30-ux-redesign-design.md §4.4; PR 2): what the sticky
// summary used to hold beside the title — the all-loads print button, the traveler notice, the
// print messages and the reconciliation strip — now in the card at the right of the tabs, with
// Lead part, PO and Status as its rows. The customer is the title row's link (PageHeader), never
// drawn here too, so a link locator on the hub finds it once. The strip's links are plain
// anchors: RecordTabs opens the tab a hash names and scrolls to it.
import { AtAGlance } from "@/components/AtAGlance";
import { ORDER_STATUS_LABELS } from "@/lib/order-constants";
import { LIGHT_DOT_CLASS, LIGHT_LABELS } from "@/lib/traffic-light";
import type { OrderDetail } from "./page";
import { TravelerFeedback, TravelerNotice, TravelerPrintButton } from "./DocumentsSection";
import { ReconciliationStrip } from "./ReconciliationStrip";

export function OrderAtAGlance({ order }: { order: OrderDetail }) {
  const lead = order.lines.find((line) => line.position === 1);
  return (
    <AtAGlance rows={[
      { label: "Lead part", value: lead ? `${lead.part.partNumber} · ${lead.part.name}` : "No lead part" },
      { label: "PO", value: order.poNumber || "—" },
      { label: "Status", value: (
        <span className="flex flex-wrap items-center gap-1">
          <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-full ${LIGHT_DOT_CLASS[order.light]}`} />
          {LIGHT_LABELS[order.light]} · {ORDER_STATUS_LABELS[order.status]}
          {order.voided && <span className="font-medium text-red-700"> · Voided</span>}
        </span>
      ) },
    ]}>
      <div className="mt-4 flex flex-col gap-2">
        <TravelerPrintButton />
        <TravelerNotice order={order} />
        <TravelerFeedback />
        <ReconciliationStrip order={order} />
      </div>
    </AtAGlance>
  );
}
