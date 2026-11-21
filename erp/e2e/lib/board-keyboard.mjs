import assert from "node:assert/strict";
import { clickOpensNewTab } from "./new-tab.mjs";
import { boardRow } from "./orders.mjs";

const headerLabel = (text) => text.replace(/[▲▼]/g, "").trim();

function luminance(channels) {
  const linear = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

async function computedRgb(locator, property) {
  return locator.evaluate((element, cssProperty) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.fillStyle = getComputedStyle(element)[cssProperty];
    context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  }, property);
}

async function assertBoardLegibility(page, row) {
  const headers = page.getByRole("columnheader");
  const labels = (await headers.allInnerTexts()).map(headerLabel);
  for (const label of ["Order #", "PO", "Received", "Request", "Target", "VS #"]) {
    const index = labels.indexOf(label);
    assert.ok(index >= 0, `the default board should show the ${label} column`);
    const whiteSpace = await row.locator(`td:nth-child(${index + 1})`).evaluate(
      (cell) => getComputedStyle(cell).whiteSpace,
    );
    assert.equal(whiteSpace, "nowrap", `${label} should remain together within its cell`);
  }

  const lifecycle = row.locator("span").filter({ hasText: /^· / });
  const table = row.locator("xpath=ancestor::table");
  const foreground = await computedRgb(lifecycle, "color");
  const background = await computedRgb(table, "backgroundColor");
  assert.ok(foreground && background, "board colors should be convertible to sRGB in Chromium");
  assert.ok(contrastRatio(foreground, background) >= 4.5,
    "lifecycle text should meet normal-text contrast against the board background");

  const viewport = page.viewportSize();
  assert.ok(viewport, "board keyboard coverage requires a sized browser viewport");
  const initialScroll = await row.evaluate((boardRow) => ({
    windowX: window.scrollX,
    windowY: window.scrollY,
    wrapperX: boardRow.closest("table")?.parentElement?.scrollLeft ?? 0,
  }));
  try {
    await page.setViewportSize({ width: 480, height: viewport.height });
    const reachability = await row.evaluate((boardRow) => {
      const board = boardRow.closest("table");
      const wrapper = board?.parentElement;
      const documentScroller = document.scrollingElement;
      const doesNotClipHorizontalOverflow = (element) => {
        const overflow = getComputedStyle(element).overflowX;
        return overflow !== "hidden" && overflow !== "clip";
      };
      const createsHorizontalScroller = (element) => {
        const overflow = getComputedStyle(element).overflowX;
        return overflow === "auto" || overflow === "scroll";
      };
      const wrapperScrollable = Boolean(
        wrapper && wrapper.scrollWidth > wrapper.clientWidth && createsHorizontalScroller(wrapper),
      );
      const documentScrollable = Boolean(
        documentScroller
        && documentScroller.scrollWidth > documentScroller.clientWidth
        && doesNotClipHorizontalOverflow(document.documentElement)
        && doesNotClipHorizontalOverflow(document.body),
      );
      const cells = [...boardRow.querySelectorAll("td")];
      const leading = cells[0];
      const trailing = cells.at(-1);
      if (!leading || !trailing) return { wrapperScrollable, documentScrollable, leading: false, trailing: false };

      trailing.scrollIntoView({ block: "nearest", inline: "end" });
      const trailingRect = trailing.getBoundingClientRect();
      const trailingReachable = trailingRect.left >= -1 && trailingRect.right <= window.innerWidth + 1;
      leading.scrollIntoView({ block: "nearest", inline: "start" });
      const leadingRect = leading.getBoundingClientRect();
      const leadingReachable = leadingRect.left >= -1 && leadingRect.right <= window.innerWidth + 1;
      return {
        wrapperScrollable,
        documentScrollable,
        leading: leadingReachable,
        trailing: trailingReachable,
      };
    });
    assert.ok(reachability.wrapperScrollable || reachability.documentScrollable,
      "the full board should have a visible horizontal scroll surface at narrow widths");
    assert.equal(reachability.trailing, true, "the trailing board cell should be horizontally reachable");
    assert.equal(reachability.leading, true, "the leading board cell should remain horizontally reachable");
  } finally {
    await page.setViewportSize(viewport);
    await row.evaluate((boardRow, scroll) => {
      const wrapper = boardRow.closest("table")?.parentElement;
      if (wrapper) wrapper.scrollLeft = scroll.wrapperX;
      window.scrollTo(scroll.windowX, scroll.windowY);
    }, initialScroll);
  }
}

/**
 * Exercises the order board's native keyboard controls against a real row. The checks use
 * accessible roles/names and states, so an adjacent visual label cannot make an unlabelled control
 * pass. All changes here are page-local view state; reload restores the user's configured default
 * view before the flow continues.
 */
export async function exerciseBoardKeyboard(page, orderNumber, orderId) {
  const view = page.getByRole("combobox", { name: "View:", exact: true });
  const originalView = await view.inputValue();
  await view.selectOption("");

  for (const name of ["Search", "Customer", "Received from", "Received to", "Request from", "Request to"]) {
    await page.getByLabel(name, { exact: true }).waitFor({ state: "visible" });
  }

  const defaultRow = await boardRow(page, orderNumber);
  await defaultRow.waitFor({ state: "visible", timeout: 10000 });
  await assertBoardLegibility(page, defaultRow);

  const customerHeader = page.getByRole("columnheader", { name: /^Customer/ });
  const customerSort = customerHeader.getByRole("button", { name: /^Customer/ });
  assert.equal(await customerHeader.getAttribute("aria-sort"), "none", "Customer starts unsorted in the default board");
  await customerSort.focus();
  await customerSort.press("Enter");
  assert.equal(await customerHeader.getAttribute("aria-sort"), "ascending", "Enter sorts Customer ascending");
  await customerSort.press("Enter");
  assert.equal(await customerHeader.getAttribute("aria-sort"), "descending", "a second Enter sorts Customer descending");

  const columnsButton = page.getByRole("button", { name: "Columns", exact: true });
  await columnsButton.focus();
  await columnsButton.press("Enter");
  const orderVisible = page.getByLabel("Order #", { exact: true });
  assert.equal(await orderVisible.isChecked(), true, "Order # starts visible in the default board");
  await orderVisible.focus();
  await orderVisible.press("Space");
  assert.equal(await orderVisible.isChecked(), false, "Space hides the labelled Order # column");
  await orderVisible.press("Space");
  assert.equal(await orderVisible.isChecked(), true, "Space restores the labelled Order # column");

  const moveDown = page.getByRole("button", { name: "Move Order # down", exact: true });
  await moveDown.focus();
  await moveDown.press("Enter");
  let labels = (await page.getByRole("columnheader").allInnerTexts()).map(headerLabel);
  assert.deepEqual(labels.slice(0, 2), ["Customer", "Order #"], "Enter moves Order # down one position");
  await page.getByRole("button", { name: "Move Order # up", exact: true }).press("Enter");
  labels = (await page.getByRole("columnheader").allInnerTexts()).map(headerLabel);
  assert.deepEqual(labels.slice(0, 2), ["Order #", "Customer"], "Enter restores Order # to its first position");

  await page.reload();
  await page.getByRole("heading", { name: "Orders" }).waitFor({ state: "visible" });
  assert.equal(await page.getByRole("combobox", { name: "View:", exact: true }).inputValue(), originalView,
    "reload restores the user's selected default view");

  const row = await boardRow(page, orderNumber);
  await row.waitFor({ state: "visible", timeout: 10000 });
  const orderLink = row.getByRole("link", { name: String(orderNumber), exact: true });
  const boardUrl = page.url();
  // #345: confirmed through the browser's target list, not Playwright's context page event, which
  // intermittently never fires for a modifier-click tab on the headless shell (see new-tab.mjs).
  await clickOpensNewTab(page, () => orderLink.click({ modifiers: ["Control"] }), {
    pathPattern: new RegExp(`^/orders/${orderId}$`),
  });
  assert.equal(page.url(), boardUrl, "a modified order-link click keeps the board in its original tab");

  await orderLink.focus();
  await orderLink.press("Enter");
  await page.waitForURL(new RegExp(`/orders/${orderId}$`), { timeout: 10000 });
  assert.equal(page.url().split("/").pop(), orderId, "the numeric order link opens its own order from the keyboard");

  await page.goBack();
  await page.getByRole("heading", { name: "Orders" }).waitFor({ state: "visible" });
}
