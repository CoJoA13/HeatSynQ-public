// The Roles page's tabs and words (spec 2026-10-30-ux-redesign-design.md §4.3–§4.4; the UX redesign
// PR 12, owner 2026-11-02 on #827): Roles, Area permissions and Special actions, every panel
// mounted. Each tick saves on its own, so no section registers unsaved work and every tab's
// `sections` is empty; the ids are what the page's `open` requests name. Client-safe; the E2E
// helpers read the tabs under plain node.
import type { RecordTab } from "./record-tabs";

export const ROLE_TAB_LABEL = "Role sections";

export function roleTabs(): RecordTab[] {
  return [
    { key: "roles", label: "Roles", sections: [], ids: ["role-list", "new-role"] },
    { key: "area", label: "Area permissions", sections: [], ids: ["area-permissions"] },
    { key: "special", label: "Special actions", sections: [], ids: ["special-actions"] },
  ];
}

export const NO_ROLE_SELECTED = "Select a role to view its permissions.";

/** Why Delete unused role is closed with no role picked. */
export const NO_ROLE_DELETE = "Select a role first.";

/** The title row's Delete unused role: the permission's reason wins (the step codes' header button
 *  rule), then no role picked. */
export function deleteRoleGate(
  canDelete: { disabled: boolean; title: string | undefined }, hasRole: boolean,
): { disabled: boolean; title: string | undefined } {
  if (canDelete.disabled || hasRole) return canDelete;
  return { disabled: true, title: NO_ROLE_DELETE };
}

/** A special action's name as the app has always shown it: the key with its underscores spaced. */
export const specialActionName = (action: string): string => action.replaceAll("_", " ");
