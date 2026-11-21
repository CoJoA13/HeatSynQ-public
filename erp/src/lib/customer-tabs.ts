// The customer page's tabs, subtitle and card words (spec 2026-10-30-ux-redesign-design.md §4.3–
// §4.4; the UX redesign PR 8, owner 2026-11-01 on #823): the file's six tabs over the page's
// mounted sections. No section of this page registers unsaved work (it is blur-saves and row
// actions), so every tab's `sections` is empty; the ids are the sections a hash may target. The
// subtitle reads the code, the active flag and a division's parent ("Main account" is a #823 item).
// Client-safe; the E2E helpers read the tabs under plain node.
import type { RecordTab } from "./record-tabs";
import { formatMoney } from "./format";

export const CUSTOMER_TAB_LABEL = "Customer sections";

export function customerTabs(): RecordTab[] {
  return [
    { key: "overview", label: "Overview & notes", sections: [], ids: ["identity", "standing-notes"] },
    { key: "addresses", label: "Addresses & contacts", sections: [], ids: ["addresses", "contacts"] },
    { key: "terms", label: "Terms & billing", sections: [], ids: ["commercial", "surcharge-overrides"] },
    { key: "defaults", label: "Defaults & documents", sections: [], ids: ["order-defaults", "document-templates"] },
    { key: "receivables", label: "Receivables", sections: [], ids: ["receivables"] },
    { key: "history", label: "History", sections: [], ids: ["history"] },
  ];
}

/** The page's subtitle: the code, Active or Inactive, and "Division of <parent>" for a division. */
export function customerSubtitle(c: { code: string; active: boolean; parentCode: string | null }): string {
  return [c.code, c.active ? "Active" : "Inactive", ...(c.parentCode ? [`Division of ${c.parentCode}`] : [])].join(" · ");
}

/** The card's Open balance: the Receivables section's Net once its read has landed, "—" before. */
export function openBalanceText(net: number | null): string {
  return net === null ? "—" : formatMoney(net);
}
