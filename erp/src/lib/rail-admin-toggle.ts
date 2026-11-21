// The rail's "Settings & administration" toggle (spec 2026-10-30-ux-redesign-design.md §4.2;
// owner ruling 6): the admin groups (nav.ts's ADMIN_HEADINGS) fold under it. Expanded by default,
// so a flow or a new browser sees every entry; collapsed only by the user's own click, and that is
// remembered per browser. This leaf decides what a stored value means and what to store, so the
// Shell's storage code is one guarded read and one guarded write. Import-free.

export const RAIL_ADMIN_KEY = "heatsynq.rail.admin";

/** What a stored value means: only the literal "collapsed" collapses; absence or anything else is
 *  the default, expanded. */
export function readAdminExpanded(stored: string | null): boolean {
  return stored !== "collapsed";
}

/** What to store for a state: "collapsed", or `null` meaning remove the key (expanded is the
 *  default and needs no record). */
export function storeAdminExpanded(expanded: boolean): string | null {
  return expanded ? null : "collapsed";
}
