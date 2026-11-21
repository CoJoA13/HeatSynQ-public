// How tall the navigation rail may be, as a pure client-safe leaf (the nav.ts precedent: the
// decision lives here so tests/rail-fit.test.ts can pin it without a DOM test environment).
//
// THE PROBLEM. Shell.tsx sticks the rail's inner wrapper (`sticky top-0`, scrolling its own links)
// while the root layout renders the practice, setup, default-password and backup banners ABOVE
// <Shell>. A sticky element cannot see what sits above it: with the page at the top the wrapper's
// top edge is the banners' height down the window, so a wrapper sized to the viewport (the old
// `max-h-screen`) ran past the window's bottom by exactly that much, and on a short window the
// rail's last entries were clipped and unreachable until the page had been scrolled by the
// banners' height. The banners come and go on their own — the setup and backup bars are fetched
// after the Shell mounts, the password reminder is dismissed in place, a backup clears the red bar
// without a navigation — so no static value can describe them.
//
// THE RULE. The wrapper's max height is the viewport minus its own current offset from the top of
// the window: `calc(100dvh - <inset>)`, where the inset is how far below the window's top edge the
// rail's column (the <aside>) currently begins — the banners' height while the page is at the top,
// shrinking to zero as the page scrolls past them (the sticky wrapper is pinned to the top by
// then, and may fill the window again). Shell measures that offset and writes it to the CSS
// variable below whenever the window scrolls or resizes, or the document's height changes (a
// banner appearing or disappearing changes it — the Shell is `min-h-screen`, so the body is always
// the banners plus at least one viewport). Before the first measurement the variable is unset and
// the fallback is the plain viewport height — the pre-existing behaviour, never worse than it.

/** The CSS custom property Shell writes the measured offset to, on the rail wrapper itself. */
export const RAIL_INSET_VAR = "--rail-inset";

/** The rail wrapper's `max-height`: the viewport less the measured inset, the viewport alone
 *  until the inset has been measured. `dvh`, not `vh`, so a mobile browser's collapsing toolbar
 *  counts as viewport (the global search dropdown's precedent). */
export const RAIL_MAX_HEIGHT = `calc(100dvh - var(${RAIL_INSET_VAR}, 0px))`;

/**
 * The inset to write, from the rail column's top edge in viewport coordinates
 * (`getBoundingClientRect().top` of the <aside>).
 *
 * Never negative — once the column's top has scrolled above the window the wrapper is pinned at
 * the top and owes the banners nothing — and rounded UP to whole pixels, so a fractional banner
 * height (a zoomed browser) never leaves the rail a fraction of a pixel too tall and clipped.
 * A non-finite reading (no layout yet) measures as zero, the fallback.
 */
export function railInset(asideTop: number): number {
  if (!Number.isFinite(asideTop) || asideTop <= 0) return 0;
  return Math.ceil(asideTop);
}
