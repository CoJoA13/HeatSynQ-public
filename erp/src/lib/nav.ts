// The Shell's nav model + gating, as a pure client-safe module (no server imports — the
// permission-ui.ts precedent; a "use client" file pulling from src/server/** drags Prisma into
// the browser bundle). Lifting the groups and the permission → visible-entries decision out of
// Shell.tsx is what makes the gating unit-testable (tests/nav.test.ts) rather than only
// reachable through a rendered component.
//
// THE RAIL (2026-09-13, the first navigation batch of the UI/UX proposal that answered #303):
// seven headed groups replaced the old two flat lists (ten work entries, then an "Admin" group of
// twelve). Groups follow how the shop works rather than when each screen was built. Every entry
// keeps EXACTLY the route and the ONE permission gate it declared before the regrouping; only
// labels, order and grouping changed. A group heading renders only when at least one of its
// entries is visible, which is the rule the old Admin heading already used, so no user is ever
// left with a page they can use but cannot find (the spec §5.15 silent-dead-end rule).
//
// REGROUPED AGAIN on 2026-10-30 for the Figma redesign (spec 2026-10-30-ux-redesign-design.md
// §4.2, labels accepted by the owner that day): Daily work, Billing and Reference are the groups
// the rail always shows; Configuration, People and System are the ADMIN groups (`ADMIN_HEADINGS`),
// which the Shell folds under a "Settings & administration" toggle. Reports joins Reference rather
// than standing alone as a separator, Parts reads "Parts & processes", and Process step codes
// moves to Configuration where the file's landing tiles put it. Again no route or gate moved.
//
// THE NAV DECISION (Task 16, spec §5.5 "One admin surface … under the existing admin area UI,
// gated on the `templates` area"): Document templates sits with the other configuration screens
// but — unlike every other admin screen — it is gated on `templates.view` SPECIFICALLY, not on
// `admin.view`. So a `templates.view`-only user (no `admin.view`) still sees a Configuration group
// containing just Document templates, and so reaches /admin/templates; an `admin.view`-only user
// without `templates` sees the rest of Configuration but NOT Document templates (it is a different
// area). The page itself still enforces the gate: /api/templates does
// `mustCan(requireUser(), "templates", "view")` — the nav is never the authorization.
//
// PHASE 8C ADDENDUM — gating on a special ACTION, not just an area: Backups (Task 6) has no
// `backups.view` and never will — `manage_backups` is one of the named special actions
// (permission-constants.ts), not one of the 12 permission areas. Gating the Backups entry on
// `admin.view` instead would repeat the exact §5.15 silent-dead-end mistake the Document templates
// entry above exists to avoid: a user granted `manage_backups` but not `admin.view` could use the
// page but never see a link to it. So `NavEntry` is a discriminated union — an entry declares
// EXACTLY ONE gate, either an `area` (checked as `<area>.view`) or an `action` (checked as
// `action.<name>`) — and `visibleGroups` resolves every entry through the single `canSeeEntry`
// below rather than re-implementing the check per group.
//
// AUDIT LOG stays on `admin.view`. The proposal floats a named `read_audit` action for it; that is
// a permission-model change with its own seed, roles screenshot and manual table, and is
// deliberately NOT part of this batch.

export type NavEntry =
  | { label: string; href: string; area: string; action?: never }
  | { label: string; href: string; action: string; area?: never };

/** A headed group of rail entries. `heading: null` is the one separator-only group (Reports): a
 *  lone entry under a heading is noise, so it renders as a rule rather than a title. */
export type NavGroup = { heading: string | null; entries: NavEntry[] };

/** The groups the Shell folds under "Settings & administration" (2026-10-30). */
export const ADMIN_HEADINGS: ReadonlySet<string> = new Set(["Configuration", "People", "System"]);
export const isAdminGroup = (g: NavGroup): boolean => g.heading !== null && ADMIN_HEADINGS.has(g.heading);

export const NAV_GROUPS: NavGroup[] = [
  // Daily work, in the order the work moves: Shipping precedes Certifications, because saving a
  // shipment is what creates shipment-scope certificates and the cert list labels them by packing
  // list — the order the manual's own chapters already use.
  {
    heading: "Daily work",
    entries: [
      { label: "Orders", href: "/", area: "orders" },
      { label: "Quotes", href: "/quotes", area: "quotes" },
      { label: "Shipping", href: "/shipping", area: "shipping" },
      { label: "Certifications", href: "/certs", area: "certs" },
    ],
  },
  {
    heading: "Billing",
    entries: [
      { label: "Invoicing", href: "/invoicing", area: "invoicing" },
      { label: "Receivables", href: "/receivables", area: "receivables" },
    ],
  },
  // Reference: the master data and, since 2026-10-30, Reports. A reports.view-only user sees a
  // one-entry Reference group — a decision, not a defect.
  {
    heading: "Reference",
    entries: [
      { label: "Customers", href: "/customers", area: "customers" },
      { label: "Parts & processes", href: "/parts", area: "parts" },
      { label: "Reports", href: "/reports", area: "reports" },
    ],
  },
  // Configuration: the typed-settings screens, the money defaults, and the pick-lists, kept
  // adjacent. "Accounting" was "Billing" (it collided with Invoicing; the page holds tax, GL and
  // finance-charge defaults). "Pick lists" was "Reference data" (named for its use, not its
  // table). Routes are untouched by the renames.
  {
    heading: "Configuration",
    entries: [
      { label: "Settings", href: "/admin/settings", area: "admin" },
      { label: "Accounting", href: "/admin/billing", area: "admin" },
      { label: "Surcharges", href: "/admin/surcharges", area: "admin" },
      { label: "Pick lists", href: "/admin/reference", area: "admin" },
      // Process step codes sat under Master data from 2026-09-13 (beside the parts whose process
      // steps it is the vocabulary for); the redesign's landing tiles put it here, among the other
      // admin.view screens. Its gate is unchanged.
      { label: "Process step codes", href: "/admin/step-codes", area: "admin" },
      { label: "Part fields", href: "/admin/part-fields", area: "admin" },
      { label: "Document templates", href: "/admin/templates", area: "templates" },
    ],
  },
  {
    heading: "People",
    entries: [
      { label: "Users", href: "/admin/users", area: "admin" },
      { label: "Roles", href: "/admin/roles", area: "admin" },
    ],
  },
  {
    heading: "System",
    entries: [
      // The running version, the pending update and its hold (release-updates PR 3).
      { label: "System", href: "/admin/system", area: "admin" },
      { label: "Audit log", href: "/admin/audit", area: "admin" },
      // Gated on the `manage_backups` ACTION rather than an area — see the Phase 8C addendum.
      { label: "Backups", href: "/admin/backups", action: "manage_backups" },
      // The practice-data page already exists at /practice; until this entry it was reachable only
      // from the practice-copy banner, which production never shows. The page reads no user data
      // and its one action (the reset) is enforced by its own route (admin.edit + the practice
      // db-identity guard), so an `admin.view` gate here advertises nothing the holder cannot open.
      { label: "Practice data", href: "/practice", area: "admin" },
      // The first-run checklist screen, last in the rail because it is used once. It is in the nav
      // because it would otherwise be UNREACHABLE: SetupBanner surfaces it only while
      // `!complete && !dismissed`, and the dismissal is permanent (SetupState.checklistDismissedAt),
      // so an admin who dismisses the checklist with setup still incomplete had no link to /setup at
      // all — the §5.15 silent-dead-end the Document templates and Backups entries above are both
      // shaped by. That stranded a real ACTION, not just a summary: the "Confirm starting document
      // numbers" button in SetupChecklist.tsx is the only writer of `numbersConfirmedAt` anywhere in
      // the app. Gated on the `admin` AREA, which is what the page's own APIs enforce (readiness →
      // admin.view, state → admin.edit), so the nav never advertises a page the caller would be
      // 403ed by. "Setup checklist" rather than "Setup", which sat five letters from "Settings".
      { label: "Setup checklist", href: "/setup", area: "admin" },
    ],
  },
];

/** Every rail entry in rail order, for the callers that do not care about grouping. */
export const NAV_ENTRIES: NavEntry[] = NAV_GROUPS.flatMap((g) => g.entries);

/** True iff the permission set grants `<area>.view`. An absent array (permissions still loading)
 *  is treated as "no grants", so entries stay hidden until /api/auth/me resolves. */
export function canViewArea(perms: string[] | undefined, area: string): boolean {
  return (perms ?? []).includes(`${area}.view`);
}

/** True iff the permission set grants the ONE gate this entry declares — `<area>.view` for an
 *  area entry, `action.<name>` for an action entry. An absent array (permissions still loading)
 *  is treated as "no grants", so entries stay hidden until /api/auth/me resolves. */
export function canSeeEntry(perms: string[] | undefined, entry: NavEntry): boolean {
  return entry.action !== undefined
    ? (perms ?? []).includes(`action.${entry.action}`)
    : canViewArea(perms, entry.area);
}

/** The groups this permission set can see, each reduced to its visible entries, with groups that
 *  have no visible entry dropped entirely — so a heading (or the Reports separator) is never
 *  rendered over nothing. While permissions load every entry fails its gate and this is `[]`. */
export function visibleGroups(perms: string[] | undefined): NavGroup[] {
  return NAV_GROUPS
    .map((g) => ({ heading: g.heading, entries: g.entries.filter((n) => canSeeEntry(perms, n)) }))
    .filter((g) => g.entries.length > 0);
}

/** Which rail entry the current path lights up. "Orders" lands on "/" (the board), and every other
 *  entry highlights on a path-prefix match — but "/".startsWith is true for EVERY pathname, so the
 *  plain `pathname.startsWith(href)` rule would light "Orders" up on every single page. "/" needs
 *  an exact match; every other href keeps the prefix match (so "/customers/abc123" still
 *  highlights "Customers", and "/admin/templates/x/edit" still highlights "Document templates"). */
export function navIsActive(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}
