"use client";
// The `/reports` sub-nav (#303) — the Receivables tab bar, applied to the reports section so a
// reader can move between sibling reports instead of detouring through the index. It replaces the
// "← All reports" back-link that each report used to render twice.
//
// The tabs are DERIVED from `report-registry.ts`, the one source of truth for what reports exist
// (the nav.ts discipline), rather than a second hand-written list that could drift from the
// catalog. Only entries whose `area` is `reports` become tabs: the two HOMED cross-area entries
// (Invoice register → /invoicing, A/R aging → /receivables/aging) live on other sections' pages,
// carry those areas' own view grants, and are not part of this section's bar. They remain listed on
// the index.
//
// "All reports" is the section root, matched exactly (TabNav's rule). Keep that label verbatim:
// `e2e/flows/reports.mjs` reaches the index by it.
import { TabNav, type Tab } from "@/components/TabNav";
import { REPORTS } from "@/lib/report-registry";

const TABS: Tab[] = [
  { label: "All reports", href: "/reports" },
  ...REPORTS.filter((r) => r.area === "reports").map(({ label, href }) => ({ label, href })),
];

export function ReportsNav() {
  return <TabNav label="Reports" tabs={TABS} />;
}
