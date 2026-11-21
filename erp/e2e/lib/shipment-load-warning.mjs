import assert from "node:assert/strict";
import { assertNeverVisible, waitForChecked } from "./ui.mjs";
import { openRecordTab } from "./record-tabs.mjs";
import { orderPanel } from "./orders.mjs";
import { routeRequests } from "../route-keep-alive.mjs";

/** A late INITIAL read must not clear or replace a newer action refusal (ab2e5a5). That race
 * exists only under React StrictMode, which the dev-mode suite runs: it mounts twice, so the
 * first mount's read can populate the page while the replay's read is still in flight. Do not
 * release that first response until the second mount read is intercepted: no child recovery read
 * can then take that second slot. Hold the second response until an action refusal is visible,
 * then prove that success AND failure leave that newer action alone.
 * The refusal is the page's own package-count check: a count that is not a whole number is
 * refused when the field loses focus, in the action banner, and nothing is sent. Until #472 this
 * probe used Remove order's click-time refusal. That button is now greyed while its order's grids
 * hold unsaved work, so no click can reach that refusal. The unsaved serial stays in the probe:
 * a late read must not take a grid's unsaved work either.
 * A production build mounts once, and that single read is what renders the panel, once the
 * permission read has answered or failed too (#483): holding it leaves the page at "Loading…"
 * with no control to act on, and releasing it first leaves no later initial read to race. The
 * check therefore runs in dev mode only; production logs that it is skipping the probe and
 * returns immediately, without the dev-mode-only trailing `page.reload()` below (that reload
 * exists to leave the page clean for whatever the flow does next, after this function's own two
 * dev-mode passes left it mid-probe).
 * Only the response in this browser is changed; no fixture data is written by this check. */
export async function assertShipmentLoadPreservesWarning(page, baseURL, shipmentId, orderLabel, serverMode) {
  assert.ok(serverMode === "dev" || serverMode === "production", "serverMode is required");
  if (serverMode === "production") {
    console.log("  (skipping the late-initial-read shipment probe: it pins a React StrictMode " +
      "double-mount race that cannot occur under a production server's single mount; the nightly " +
      "dev-mode run carries this coverage)");
    return;
  }
  const routeUrl = `${baseURL}/api/shippers/${shipmentId}`;
  const refusal = page.getByText("Package count must be a whole number of at least 0.", { exact: true });
  for (const outcome of ["success", "failure"]) {
    await assertNeverVisible(page.getByText("Unsaved changes", { exact: true }),
      "the shipment warning probe must leave only a clean editor", 300);
    // Retire the previous document before arming interception: its late recovery reads
    // must not occupy either initial-read slot for the new shipment document.
    await page.goto("about:blank");
    let reads = 0;
    let releaseFirst;
    const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let ready;
    const responseReady = new Promise((resolve) => { ready = resolve; });
    const marker = `E2E delayed shipment ${outcome}`;
    const writes = [];
    const trackWrite = (request) => {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) writes.push(request.url());
    };
    const routeHandler = async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      const read = ++reads;
      if (read > 2) {
        await route.continue();
        return;
      }
      if (read === 2) releaseFirst();
      try {
        const response = await route.fetch();
        const body = await response.json();
        if (read === 1) {
          assert.equal(response.status(), 200, "the first shipment mount read must succeed");
          assert.equal(body.shipper?.id, shipmentId, "the first read must load this shipment");
          // Until slot 2 is captured, no parent payload can mount the child editors whose
          // recovery reads use this same endpoint but do not render its warnings.
          await firstHeld;
          await route.fulfill({ response, json: body });
          return;
        }
        ready(response.status());
        await held;
        await route.fulfill(outcome === "success"
          ? { response, json: { ...body, warnings: [...body.warnings, marker] } }
          : { status: 503, json: { error: marker } });
      } catch (error) {
        ready(error);
        // Already handled when fulfill itself threw; a second throw here escapes the handler.
        await route.abort().catch(() => {});
      }
    };
    page.on("request", trackWrite);
    const stopRouteHandler = await routeRequests(page, routeUrl, routeHandler);
    try {
      await page.goto(`${baseURL}/shipping/${shipmentId}`);
      // A missing second request is a failed precondition, never an unbounded promise wait.
      let timer;
      try {
        const status = await Promise.race([responseReady,
          new Promise((resolve) => { timer = setTimeout(() => resolve(null), 10000); })]);
        assert.equal(status, 200, "the overlapping shipment read must reach a successful response");
      } finally { clearTimeout(timer); }
      const panel = orderPanel(page, orderLabel);
      const serial = panel.getByLabel("Serial 1 print on ticket", { exact: true });
      await waitForChecked(serial, true);
      await serial.uncheck();
      // The newer action: 1.5 is not a whole number, so leaving the field refuses it in the
      // action banner and sends nothing. `fill` waits until the field is editable.
      await openRecordTab(page, "Header & freight"); // the Package count box's tab (PR 4)
      const packageCount = page.getByLabel("Package count", { exact: true });
      const storedPackageCount = await packageCount.inputValue();
      await packageCount.fill("1.5");
      await packageCount.press("Tab");
      await refusal.waitFor({ state: "visible" });
      // #653: the refused value does not stay in the box; it shows the stored count again (the
      // container sum while the count is null), as the bill of lading would print it.
      assert.equal(await packageCount.inputValue(), storedPackageCount, "a refused Package count must go back to the stored figure");
      release();
      // A response event is too early: this marker proves React has rendered its result.
      await page.getByText(marker, { exact: true }).waitFor({ state: "visible" });
      assert.equal(await refusal.isVisible(), true, `${outcome} must preserve the package-count refusal`);
      // Back to the serial's tab BEFORE reading it: `orderPanel` finds the panel by its order
      // link through a role locator, which skips a hidden tab's content, so read from Header &
      // freight it waits out its timeout (the nightly failed on it from PR 4, #837, on).
      await openRecordTab(page, "Orders & quantities");
      assert.equal(await serial.isChecked(), false, "the serial draft must survive the response");
      assert.equal(await panel.getByRole("button", { name: "Save serials", exact: true }).isEnabled(), true);
      // Leave a clean editor for the next pass. Nothing is asserted about the banner here: it is
      // not this grid's message, and the next pass starts from a fresh document.
      await panel.getByRole("button", { name: "Discard changes to serials", exact: true }).click();
      await waitForChecked(serial, true);
      assert.equal(writes.length, 0, "a refused package count and a discarded serial edit must not write any records");
    } finally {
      releaseFirst();
      release();
      await stopRouteHandler();
      page.off("request", trackWrite);
    }
  }
  await page.reload();
}
