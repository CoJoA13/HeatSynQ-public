// The quote page's tabs (spec 2026-10-30-ux-redesign-design.md §4.4; the UX redesign PR 3,
// 2026-10-31): three RecordTabs over the sections QuoteDetail.tsx mounts, Parts & pricing first
// (the design's order, so the default), Details & wording (the header grid), Documents & history.
// The page is a SINGLE-SAVE form with one Save for header and lines alike, so it registers its
// unsaved work as two sections, one per half, under the two labels here: a tab badges only the
// half that is dirty, and the Shell's navigation prompt names that half. Import-free but for the
// tab type; client-safe, and the E2E helpers read it under plain node.
import type { RecordTab } from "./record-tabs";

export const QUOTE_TAB_LABEL = "Quote sections";

/** The unsaved-work registry labels of the form's two halves. */
export const QUOTE_LINES_SECTION = "Quote lines";
export const QUOTE_DETAILS_SECTION = "Quote details";

export type QuoteTabKey = "parts" | "details" | "documents";

export function quoteTabs(): RecordTab[] {
  return [
    { key: "parts", label: "Parts & pricing", sections: [QUOTE_LINES_SECTION], ids: ["lines"] },
    { key: "details", label: "Details & wording", sections: [QUOTE_DETAILS_SECTION], ids: ["header"] },
    { key: "documents", label: "Documents & history", sections: [], ids: ["documents", "history"] },
  ];
}
