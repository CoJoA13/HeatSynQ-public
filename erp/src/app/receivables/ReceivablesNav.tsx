"use client";
// The `/receivables` sub-nav (Task 15 Step 3, closing Task 14's flagged gap: nothing linked to
// `/receivables/aging` or `/receivables/statements` before this). Shared across the
// `/receivables*` screens — the worklist, aging, statements, and (P5C Task 8) the month-end
// close/GL-export screen.
//
// #303 turned the bar itself into `components/TabNav.tsx`, shared with the Reports section; this
// file is now just the Receivables tab list. The export name and signature are unchanged, so its
// four consumers are untouched.
import { TabNav, type Tab } from "@/components/TabNav";

const TABS: Tab[] = [
  { label: "Batches", href: "/receivables" },
  { label: "Aging", href: "/receivables/aging" },
  { label: "Statements", href: "/receivables/statements" },
  { label: "Close", href: "/receivables/close" },
];

export function ReceivablesNav() {
  return <TabNav label="Receivables" tabs={TABS} />;
}
