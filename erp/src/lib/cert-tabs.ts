// The certification page's tabs and the requirement block's headings (spec
// 2026-10-30-ux-redesign-design.md §4.4; the UX redesign PR 5, owner 2026-10-31 on #820).
// Inspection results (the pass/fail summary and the requirement blocks, whose readings register
// under "Cert results", so that tab badges their unsaved work), Wording & signature (the two notes,
// blur-saved), Documents & history (the stored prints and the History panel). The block's frozen
// range reads as one line, "Required 38–42 HRC", the scale's name its unit, and its Value heading
// carries that name; a half-open range and a missing scale each read sensibly. Client-safe, and the
// E2E helpers read the tabs under plain node.
import type { RecordTab } from "./record-tabs";

export const CERT_TAB_LABEL = "Certification sections";

export type CertTabKey = "results" | "wording" | "documents";

export function certTabs(): RecordTab[] {
  return [
    { key: "results", label: "Inspection results", sections: ["Cert results"], ids: ["results"] },
    { key: "wording", label: "Wording & signature", sections: [], ids: ["notes"] },
    { key: "documents", label: "Documents & history", sections: [], ids: ["documents", "history"] },
  ];
}

/** The frozen range as one line: both bounds, one, or none, the scale's name as the unit. */
export function requiredText(r: { min: number | null; max: number | null; scaleName: string | null }): string {
  const unit = r.scaleName ? ` ${r.scaleName}` : "";
  if (r.min !== null && r.max !== null) return `Required ${r.min}–${r.max}${unit}`;
  if (r.min !== null) return `Required at least ${r.min}${unit}`;
  if (r.max !== null) return `Required at most ${r.max}${unit}`;
  return "No required range";
}

/** The readings grid's Value heading, carrying the scale's name where there is one. */
export function valueHeading(scaleName: string | null): string {
  return scaleName ? `Value (${scaleName})` : "Value";
}
