// The "Back up now" gate for the Backups page (#123), moved out of page.tsx (#209).

/**
 * Whether "Back up now" can be pressed, and what the tooltip says if not (#123).
 *
 * Hook-free so tests/backups-page-state.test.ts can drive it directly: this repo has no DOM test
 * environment, and the established answer is to split the DECISION out of the component
 * (BackupBanner.tsx's `advanceBannerState`, bulk-grid.ts's `computeOrphanChurn`) rather than reach
 * for one. It lives outside page.tsx because a page may export only what Next allows: Next's
 * generated dev route types reject any other value export, which fails `npx tsc --noEmit` after a
 * `next dev` run (#209).
 *
 * §5.16: a control that cannot work is visible and DISABLED with a tooltip naming why — never
 * hidden, and never enabled-but-doomed. On the practice copy the routes 403 with "Backups are
 * managed on the production copy only…", and the page used to keep an enabled button over it.
 *
 * `refusal` is the server's own sentence from ANY 403 on the view endpoint, and keying on the
 * status rather than on which CAUSE produced it is deliberate: `mustDo("manage_backups")` and
 * `assertNotPracticeDatabase()` are both reasons this page's actions cannot work, so one branch
 * handles both and the tooltip carries whichever sentence the server actually sent. Nothing here
 * reads the practice flag — §8 forbids that in a client component, which is also why `nav.ts` is
 * left alone and the nav entry stays (the ruling).
 */
export function runControlState(
  gate: { disabled: boolean; title?: string }, running: boolean, refusal: string | null,
  viewSettled: boolean,
): { disabled: boolean; title: string | undefined } {
  // The refusal wins the TOOLTIP even when the gate is also closed: it is the more specific fact,
  // and it is the one the operator can act on ("use the production copy") versus a generic
  // permission line.
  if (refusal !== null) return { disabled: true, title: refusal };
  // CLOSED WHILE THE VIEW REQUEST IS IN FLIGHT (Codex, MR !131). `/api/auth/me` and the view
  // request are independent, and on the practice copy the view one carries an EXTRA round trip
  // (`assertNotPracticeDatabase`'s database-identity query) — so permissions routinely land first,
  // leaving `gate` open with both `view` and `refusal` still null. The control flashed ENABLED in
  // that window and would fire a POST that is refused by construction. `usePermissions` solves the
  // same problem the same way (it holds controls disabled while `permissions` is undefined rather
  // than flashing them open); this is that rule applied to the second async fact this page needs.
  //
  // SETTLED, not LOADED (Codex again, MR !131 — a regression in the first version of this gate).
  // Keying on `view !== null` meant a transient non-403 failure left `view` null FOREVER, and with
  // no retry on the mounted page the control stayed disabled reading "Loading…" until the operator
  // reloaded the browser. A settled-but-failed load is not a reason to forbid the attempt: the POST
  // does its own `assertNotPracticeDatabase` and its own permission check, so it is authoritative,
  // and a brief network blip should not cost the shop its backup button. A genuine refusal is
  // already handled above, where it belongs.
  if (!viewSettled) return { disabled: true, title: "Loading…" };
  return { disabled: gate.disabled || running, title: gate.title };
}

/**
 * The line under the archive table's heading, when it shows one (#706): "Checking archives…" until
 * the first view request SETTLES, and the empty-folder sentence once a view lists no archive.
 *
 * Opening the page verifies every archive whose cached verdict has expired (a full `gzip -t` each,
 * four at a time), which can take a while on a folder of thirty nightlies, and the table showed its
 * heading and no rows meanwhile. Gated on `viewSettled`, never on `view === null`, by the rule
 * above: a refused or failed view leaves `view` null for good, and the line would read as loading
 * forever (#123). Settled with no view, the table says nothing; the refusal or error says why.
 */
export const CHECKING_ARCHIVES = "Checking archives…";
export const NO_ARCHIVES = "No backup archives in this folder yet.";
export function archiveTableNote(viewSettled: boolean, archiveCount: number | null): string | null {
  if (!viewSettled) return CHECKING_ARCHIVES;
  return archiveCount === 0 ? NO_ARCHIVES : null;
}
