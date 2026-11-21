// The month-end close page's tabs and subtitle (spec 2026-10-30-ux-redesign-design.md §4.4; the UX
// redesign PR 7, owner 2026-11-01 on #822): Reconcile holds the Period picker, the Continuity
// schedule and the GL-export readiness, Closed periods the period cards with their Reopen and
// Export. The file's GL export tab draws a journal preview the app has no read for (#822, §1.5),
// so readiness stays on Reconcile. Import-free, client-safe; the E2E helper reads the tabs under
// plain node.
import type { RecordTab } from "./record-tabs";

export const CLOSE_TAB_LABEL = "Close sections";

export function closeTabs(): RecordTab[] {
  return [
    { key: "reconcile", label: "Reconcile", sections: [], ids: ["period", "continuity", "readiness"] },
    { key: "closed", label: "Closed periods", sections: [], ids: ["closed-periods"] },
  ];
}

/** The page's subtitle: the committed period's label before the file's sentence, or the sentence alone. */
export function closeSubtitle(periodLabel: string | null): string {
  const sentence = "Review, reconcile, close, export.";
  return periodLabel === null ? sentence : `${periodLabel} · ${sentence}`;
}
