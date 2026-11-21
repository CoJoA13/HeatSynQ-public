// The red line a screen shows for refused decimal boxes (decimal entry, pull request 2): one
// refusal per line in a single `whitespace-pre-line` paragraph. Playwright's getByText joins a
// paragraph's lines into one string, so a line cannot be asserted by its own exact text through
// it; the paragraph's innerText keeps the line breaks, and every line is compared whole.
import assert from "node:assert/strict";

/** The page-top red paragraph. The flows read it for page-level actions and reads only: the quote
 *  page's Save, New shipment's Save (a sticky banner, ruling R13), the part's Each weight (a header blur-save the owner kept on
 *  the banner, 2026-10-28) and the pick lists' own list read. A grid's, row's or section's refusal
 *  is a `panelMessage` beside its control (ruling R1, P6 step 5), and the flows check this line
 *  stays empty for one. */
export function redLine(page) {
  return page.locator("p.whitespace-pre-line.bg-red-50");
}

/** New order's page-top red banner: a block with the alert role, whose lines are followed by a
 *  "Review in" control. */
export function entryAlert(page) {
  return page.locator('div[role="alert"].whitespace-pre-line.bg-red-50');
}

/** An order panel's message slot on the saved shipment page: the paragraph with the alert role under
 *  a grid's Save row. Scope it to the panel (`orderPanel`), since each order panel has its own. */
export function panelMessage(panel) {
  return panel.locator('p[role="alert"].whitespace-pre-line');
}

/** Polls until `read` gives exactly `expected`, one string per line. */
async function waitForLines(locator, read, expected, timeoutMs) {
  await locator.waitFor({ state: "visible", timeout: timeoutMs });
  const deadline = Date.now() + timeoutMs;
  let last = [];
  for (;;) {
    last = (await read().catch(() => "")).split("\n");
    if (last.length === expected.length && last.every((line, i) => line === expected[i])) return;
    if (Date.now() > deadline) {
      assert.deepEqual(last, expected, "the red line must list exactly the expected refusals");
    }
    await new Promise((r) => { setTimeout(r, 100); });
  }
}

/** Waits until the red paragraph is visible and its lines are exactly `expected`, in order. */
export async function waitForRedLines(locator, expected, timeoutMs = 10000) {
  await waitForLines(locator, () => locator.innerText(), expected, timeoutMs);
}

/** The same wait for New order's banner. Its text is read without its controls, so the last line
 *  is the last refusal alone. */
export async function waitForAlertLines(locator, expected, timeoutMs = 10000) {
  await waitForLines(locator, () => locator.evaluate((element) => {
    const copy = element.cloneNode(true);
    for (const control of copy.querySelectorAll("button")) control.remove();
    return copy.textContent ?? "";
  }), expected, timeoutMs);
}

/** A whole-form Save's refusal as owner ruling R13 places it (New order, New shipment): every box
 *  it names carries `aria-invalid="true"` and the red border the shared style gives a marked box,
 *  and the banner stays inside the window when the page is scrolled to its foot, which proves it
 *  sticks rather than that the page happened to be short. The page is left scrolled there. */
export async function assertRefusalShown(page, banner, boxes, what) {
  for (const box of boxes) {
    assert.equal(await box.getAttribute("aria-invalid"), "true", `${what}: a refused box must carry aria-invalid`);
    assert.equal(await box.evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--color-red-600)";
      document.body.append(probe);
      const red = getComputedStyle(probe).color;
      probe.remove();
      return getComputedStyle(element).borderTopColor === red;
    }), true, `${what}: a refused box must show the red border`);
  }
  const tall = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 200);
  assert.equal(tall, true, `${what}: the page must be taller than the window, or the banner's place proves nothing`);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForFunction(() => window.scrollY > 0);
  const inView = await banner.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight;
  });
  assert.equal(inView, true, `${what}: the refusal banner must stay in the window with the page scrolled to its foot`);
}

/** Counts the requests a page issues to a path with a method while a block runs, so a flow can say
 *  "nothing was sent". Returns `{ count(), stop() }`. With `exact`, only the path itself counts, not
 *  the paths under it. */
export function watchRequests(page, method, pathPrefix, { exact = false } = {}) {
  let n = 0;
  const onRequest = (request) => {
    if (request.method() !== method) return;
    const { pathname } = new URL(request.url());
    if (exact ? pathname === pathPrefix : pathname.startsWith(pathPrefix)) n += 1;
  };
  page.on("request", onRequest);
  return { count: () => n, stop: () => page.off("request", onRequest) };
}
