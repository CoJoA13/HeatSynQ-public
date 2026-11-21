// The Users page's tabs and words (spec 2026-10-30-ux-redesign-design.md §4.3–§4.4; the UX redesign
// PR 12, owner 2026-11-02 on #827): User list and Selected user, every panel mounted. The page
// registers no unsaved work (it is blur-saves and row actions), so every tab's `sections` is empty;
// the ids are what the page's `open` requests name. Client-safe; the E2E helpers read the tabs
// under plain node.
import type { RecordTab } from "./record-tabs";

export const USER_TAB_LABEL = "User sections";

export function userTabs(): RecordTab[] {
  return [
    { key: "list", label: "User list", sections: [], ids: ["user-list", "new-user"] },
    { key: "selected", label: "Selected user", sections: [], ids: ["selected-user"] },
  ];
}

export const NO_USER_SELECTED = "Select a user to view their details.";

/** The list's Signature cell: the flag only, never the bytes (#160). */
export const signatureText = (hasSignature: boolean): string => (hasSignature ? "Present" : "Not set");
