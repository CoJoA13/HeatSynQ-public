// The Process step codes page's tabs and words (spec 2026-10-30-ux-redesign-design.md §4.3–§4.4; the
// UX redesign PR 9, owner 2026-11-01 on #824): Codes, Selected code and History, every panel
// mounted. No section of this page registers unsaved work (it is blur-saves and row actions), so
// every tab's `sections` is empty; the ids are what the page's `open` requests name. Client-safe;
// the E2E helpers read the tabs under plain node.
import type { RecordTab } from "./record-tabs";

export const STEP_CODE_TAB_LABEL = "Step code sections";

export function stepCodeTabs(): RecordTab[] {
  return [
    { key: "codes", label: "Codes", sections: [], ids: ["step-codes-list", "new-step-code"] },
    { key: "selected", label: "Selected code", sections: [], ids: ["selected-code", "add-suggestion"] },
    { key: "history", label: "History", sections: [], ids: ["step-code-history"] },
  ];
}

/** Why the header's Add parameter suggestion is closed with no code picked (owner, 2026-11-01). */
export const ADD_SUGGESTION_NO_CODE = "Select a process step code first.";

/** The header's Add parameter suggestion: the permission's reason wins (the page's row button rule),
 *  then no code picked. */
export function addSuggestionGate(
  canEdit: { disabled: boolean; title: string | undefined }, hasCode: boolean,
): { disabled: boolean; title: string | undefined } {
  if (canEdit.disabled || hasCode) return canEdit;
  return { disabled: true, title: ADD_SUGGESTION_NO_CODE };
}

/** A code's GL account in the Codes table, as the GL account select's option reads; "" for an
 *  account the list does not hold. */
export function glAccountText(id: string | null, gls: { id: string; name: string; description?: string }[]): string {
  const account = gls.find((g) => g.id === id);
  return account ? `${account.name} ${account.description ?? ""}`.trim() : "";
}
