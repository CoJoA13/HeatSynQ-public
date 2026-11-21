// The rail on a SHORT window, from the TOP of the page, with the banners up. Shell.tsx sticks the
// rail's inner wrapper and scrolls its links rather than growing the column; with seven headed
// groups an administrator's rail runs past 900px, so a 600px-tall window is exactly the case where
// the last entries would otherwise be clipped and unreachable.
//
// BANNERS. The root layout renders the setup, default-password and backup banners ABOVE <Shell>,
// and the e2e fixture admin sees all three. A sticky wrapper cannot see them: sized to the bare
// viewport (the old rule) its bottom sat below the window by the banners' height until the page had
// scrolled by that much, and an earlier version of this helper did that page scroll first. Now
// RailWrapper sizes the wrapper to the viewport it can actually see (src/lib/rail-fit.ts), and this
// proves it against the real Shell WITHOUT moving the document:
//   (1) on a fresh document the setup and backup bars are fetched AFTER the Shell mounts, so once
//       they are up the rail must already have re-fit under them — banners APPEARING;
//   (2) the wrapper — not the document — is the vertical scroll surface, and scrolling it alone
//       brings the LAST link fully into the window, then the FIRST back;
//   (3) scrolling the page past the banners lets the rail fill the window, and scrolling back
//       re-fits it under them;
//   (4) dismissing a banner in place (no navigation) moves the rail up and it still fits and still
//       reaches its last entry — a banner DISAPPEARING.
// Viewport, rail scroll and document scroll are restored in `finally`, so a caller can screenshot
// straight after this and see the page as it was (GitLab Duo on !344).
import assert from "node:assert/strict";

const SHORT = { width: 1280, height: 600 };
/** SetupBanner.tsx's localStorage key for the dismissed password reminder — cleared on the way out
 *  so no later document in this browser context inherits a hidden reminder. */
const PW_DISMISS_KEY = "hsq_pw_reminder_dismissed";

/** The rail's scroll wrapper: the first child of the <aside> (Shell.tsx). */
function railWrapper(page) {
  return page.locator("aside > div").first();
}

async function fullyInViewport(locator, viewport) {
  const box = await locator.boundingBox();
  assert.ok(box, "the link has a box");
  return box.y >= 0 && box.y + box.height <= viewport.height;
}

/** Where the rail sits right now, all read in one pass so the numbers agree with each other. */
function railMetrics(page) {
  return railWrapper(page).evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return {
      columnTop: el.parentElement.getBoundingClientRect().top,
      top: rect.top,
      bottom: rect.bottom,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      railScrollTop: el.scrollTop,
      overflowY: getComputedStyle(el).overflowY,
      docScrollY: window.scrollY,
      viewportHeight: window.innerHeight,
    };
  });
}

/** Wait for RailWrapper's measurement to land. The wrapper's inset variable (src/lib/rail-fit.ts's
 *  RAIL_INSET_VAR, written by the Shell's scroll/resize/body-resize listener) must match the
 *  column's CURRENT position — the listener runs after the paint that moved the column, so a read
 *  straight after a scroll or a banner change can be early, and a geometry-only check is satisfied
 *  by a stale, too-short wrapper sitting at the window's top (seen once in the full suite under
 *  load). Then the geometry: the wrapper starts where its column does (or at the window's top once
 *  the column has scrolled above it) and ends inside the window.
 *  A wait that runs out is NOT the failure: `assertFits` follows every call and reports the
 *  numbers as an assertion (which the harness never mistakes for a network failure — see
 *  flow-lint.mjs on plain errors); against the old viewport-sized wrapper the variable is never
 *  written and the bottom-inside-the-window clause never comes true. */
async function waitForFit(page) {
  await page.waitForFunction(() => {
    const el = document.querySelector("aside > div");
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const columnTop = el.parentElement.getBoundingClientRect().top;
    const expectedInset = `${Math.ceil(Math.max(0, columnTop))}px`;
    return el.style.getPropertyValue("--rail-inset") === expectedInset
      && Math.abs(rect.top - Math.max(0, columnTop)) <= 1
      && rect.bottom <= window.innerHeight + 1;
  }, null, { timeout: 5_000 }).catch(() => {});
}

/** The wrapper fits the window it can see: it starts at `expectedTop` and ends inside the window. */
function assertFits(m, label, expectedTop) {
  assert.ok(
    Math.abs(m.top - expectedTop) <= 1,
    `${label}: the rail starts where its column does (top ${m.top}px, expected ${expectedTop}px)`,
  );
  assert.ok(
    m.bottom <= m.viewportHeight + 1,
    `${label}: the rail ends inside the ${m.viewportHeight}px window (bottom ${m.bottom}px)`,
  );
}

/** The last link is reached by scrolling the RAIL WRAPPER alone — its own scroll range, with the
 *  document left where it was — and the first is brought back the same way. Scrolled
 *  programmatically rather than through `scrollIntoViewIfNeeded`, which scrolls every scrollable
 *  ancestor (the document included) and so cannot tell a rail that scrolls from a page that does. */
async function assertLastAndFirstReachable(page, nav, label) {
  const wrapper = railWrapper(page);
  const links = nav.getByRole("link");
  const count = await links.count();
  assert.ok(count > 0, `${label}: the rail has links`);
  const first = links.first();
  const last = links.nth(count - 1);

  const before = await railMetrics(page);
  assert.equal(before.overflowY, "auto", `${label}: the rail wrapper is a scroll container`);
  assert.ok(
    before.scrollHeight > before.clientHeight,
    `${label}: the rail overflows a ${SHORT.height}px window (${before.scrollHeight} > ${before.clientHeight})`,
  );
  assert.equal(
    await fullyInViewport(last, SHORT), false,
    `${label}: before scrolling, the last entry is clipped by the short window`,
  );

  await wrapper.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  assert.equal(await fullyInViewport(last, SHORT), true, `${label}: the last entry is reachable`);
  const after = await railMetrics(page);
  assert.ok(after.railScrollTop > 0, `${label}: it was the rail wrapper that scrolled`);
  assert.equal(after.docScrollY, before.docScrollY, `${label}: the document did not move`);

  await wrapper.evaluate((el) => { el.scrollTop = 0; });
  assert.equal(await fullyInViewport(first, SHORT), true, `${label}: the first entry is reachable again`);
}

/**
 * @param {import("playwright").Page} page
 * @param {string} label
 * @param {object} [options]
 * @param {import("playwright").Locator[]} [options.banners] The banners this caller's user is owed
 *   above the Shell. Each is waited for, and together they must be exactly what offsets the rail.
 * @param {import("playwright").Locator} [options.dismiss] A control that removes one of those
 *   banners in place (the password reminder's "Not now"), for the disappearing case.
 */
export async function assertRailReachableOnShortWindow(page, label = "rail", { banners = [], dismiss = null } = {}) {
  const original = page.viewportSize();
  const originalScrollY = await page.evaluate(() => window.scrollY);
  await page.setViewportSize(SHORT);
  try {
    // A fresh document at the TOP of the page: the Shell mounts and measures before the fetched
    // banners exist, so what follows proves the rail re-fit when they appeared.
    await page.reload();
    const nav = page.getByRole("navigation", { name: "Main" });
    await nav.waitFor({ state: "visible" });
    await page.evaluate(() => window.scrollTo(0, 0));
    let bannersHeight = 0;
    for (const banner of banners) {
      await banner.waitFor({ state: "visible" });
      // The strip that offsets the rail is the body-level element holding the text — the caller's
      // locator may resolve to a span inside it (the password reminder's wording is a span beside
      // its button), which is shorter than the strip.
      bannersHeight += await banner.evaluate((el) => {
        let strip = el;
        while (strip.parentElement && strip.parentElement !== document.body) strip = strip.parentElement;
        return strip.getBoundingClientRect().height;
      });
    }
    await waitForFit(page);

    // (1) under the banners, from the top.
    const atTop = await railMetrics(page);
    assert.equal(atTop.docScrollY, 0, `${label}: the page is at the top`);
    if (banners.length > 0) {
      assert.ok(atTop.columnTop > 0, `${label}: the banners sit above the Shell`);
      assert.ok(
        Math.abs(atTop.columnTop - bannersHeight) <= 1,
        `${label}: the rail's column begins below exactly the banners (${atTop.columnTop}px; banners ${bannersHeight}px)`,
      );
    }
    assertFits(atTop, `${label} under the banners`, atTop.columnTop);
    // (2)
    await assertLastAndFirstReachable(page, nav, `${label} under the banners`);

    // (3) the page scrolls past the banners: the wrapper pins to the window's top and fills it.
    if (atTop.columnTop > 0) {
      const past = Math.ceil(atTop.columnTop);
      await page.evaluate((y) => window.scrollTo(0, y), past);
      await waitForFit(page);
      const pinned = await railMetrics(page);
      assert.equal(pinned.docScrollY, past, `${label}: the page scrolled past the banners`);
      assertFits(pinned, `${label} scrolled past the banners`, 0);
      assert.ok(
        pinned.clientHeight > atTop.clientHeight,
        `${label}: the rail fills the window once the banners have scrolled away (${pinned.clientHeight}px > ${atTop.clientHeight}px)`,
      );
      await page.evaluate(() => window.scrollTo(0, 0));
      await waitForFit(page);
      const back = await railMetrics(page);
      assert.equal(back.docScrollY, 0, `${label}: the page is back at the top`);
      assertFits(back, `${label} back at the top`, back.columnTop);
      assert.equal(back.columnTop, atTop.columnTop, `${label}: the banners are where they were`);
    }

    // (4) a banner disappears in place — no navigation, no reload.
    if (dismiss) {
      const before = await railMetrics(page);
      await dismiss.click();
      await dismiss.waitFor({ state: "hidden" });
      await waitForFit(page);
      const after = await railMetrics(page);
      assert.ok(
        after.columnTop < before.columnTop,
        `${label}: dismissing a banner moves the rail up (${before.columnTop}px → ${after.columnTop}px)`,
      );
      assertFits(after, `${label} after a banner is dismissed`, after.columnTop);
      await assertLastAndFirstReachable(page, nav, `${label} after a banner is dismissed`);
    }
  } finally {
    if (original) await page.setViewportSize(original);
    await railWrapper(page).evaluate((el) => { el.scrollTop = 0; }).catch(() => {});
    if (dismiss) await page.evaluate((key) => localStorage.removeItem(key), PW_DISMISS_KEY).catch(() => {});
    await page.evaluate((y) => window.scrollTo(0, y), originalScrollY).catch(() => {});
  }
}

/** Group headings currently rendered in the rail, in order — the `<nav>`'s uppercase heading rows
 *  (never links). Reports has no heading by design (a separator instead). */
export async function railHeadings(page) {
  const nav = page.getByRole("navigation", { name: "Main" });
  return nav.evaluate((el) =>
    Array.from(el.querySelectorAll("div.uppercase")).map((h) => h.textContent?.trim() ?? ""),
  );
}
