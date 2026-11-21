// #743: the order hub's Print tags. One 4 in × 3 in tag per saved container row, downloaded from the
// Containers grid and never stored; the tag carries the order number and customer, the PO, each line's
// part number and quantity, the order's container total and the received line (the Received date with
// the time of day the order was created, on the plant's clock).
//
//   - On a saved order with two container rows the grid shows Print tags as a link to the order's
//     tags route. Typing into a container box closes it: a span with the unsaved sentence, because the
//     tags print what the server holds. Discard opens it again.
//   - Clicking it downloads `container-tags-<order>.pdf`: two pages, each page the whole tag with the
//     same text, the container total the two rows' counts added up (2 + 3 = 5), the received line the
//     order's stored Received date and a creation minute between the moments either side of the save.
//
//   - Container tag PR 3: the customer's template, its v2 draft seeded on a canvas from this order, the
//     Order # item narrowed and dragged about 100 pt across (the stage's px per pt is its width over the
//     label's 288 pt), saved and published, prints each tag with the order number that far from where
//     the flow printed it.
//
// The PDF is read from the download's bytes by e2e/lib/printed-page.mjs's `printedPages`, as the
// Invoice register is (#592): a printed figure is never taken from a screen. What the order stores is
// read from the API (a GET is a read, which the harness allows). The flow keys its own parts and order
// against the order fixture customer, whose teardown reaps them, and ends with nothing unsaved.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { entryFixture, mutate, readJson, bounded } from "../lib/order-entry-workspace.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { assertNeverVisible, waitForState, waitForTitle, waitForValue } from "../lib/ui.mjs";
import { assertRun, printedPages, printedRuns } from "../lib/printed-page.mjs";
import { hubSection } from "../lib/orders.mjs";
import { openRecordTab } from "../lib/record-tabs.mjs";

// The Container tag template this flow makes: reaped by name in e2e/lib/db-fixtures.ts
// (deleteDocumentTemplatesByName, whose list tests/e2e-fixture-lists.test.ts holds to this constant).
// The seeded Standard is never edited.
const CONTAINER_TAG_TEMPLATE_NAME = "E2E Container Tag Template";

// The 4 in x 3 in label's width in points (`TAG_LABEL_SIZES`, src/lib/template-contracts/canvas.ts, which
// plain node cannot load), restated. The designer's stage is this wide, never the Letter page's 612:
// a drag's grab point scales by the stage's width over it.
const TAG_PAGE_WIDTH = 288;
// The canvas's grid step in points (`CANVAS_GRID`, same module), restated: a drop snaps to it.
const CANVAS_GRID = 4.5;

/** Waits until `locator`'s value is no longer `previous`, and answers the new one. */
async function changedFrom(locator, previous, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await locator.inputValue();
    if (value !== previous) return value;
    assert.ok(Date.now() < deadline, `${what}: the box still reads ${JSON.stringify(previous)}`);
    await delay(50);
  }
}

// The unsaved sentence and the route, as src/lib/container-tags-gate.ts states them.
const UNSAVED_TITLE =
  "Save the changes first, restore a value marked Not saved, or press Remove again on a line marked Removal not confirmed — the tags print what the server holds";

// The plant's clock (`PLANT_TIME_ZONE`, src/lib/build-version.ts), whatever zone this host runs in:
// the mapping's `plantClock` (src/server/plant-clock.ts) written out, each part read by its type.
const PLANT_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", hour12: true,
});
function plantTime(at) {
  const parts = PLANT_CLOCK.formatToParts(at);
  const part = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("hour")}:${part("minute")} ${part("dayPeriod")}`;
}
/** A `yyyy-mm-dd` date, as the order's read answers its Received date, as MM/DD/YYYY. */
function civilDate(isoDate) {
  const [year, month, day] = isoDate.split("-");
  return `${month}/${day}/${year}`;
}
/** Every plant-clock minute from `from` to `to`, as `h:mm AM`, both ends included. */
function minutesBetween(from, to) {
  const times = [];
  for (let at = new Date(from); at <= to; at = new Date(at.getTime() + 60_000)) times.push(plantTime(at));
  times.push(plantTime(to));
  return [...new Set(times)];
}
/** A wait armed before a click, as an outcome: it never rejects unhandled while an earlier step
 *  fails, and the step that reads it fails by `node:assert`. */
function settled(promise) {
  return promise.then((value) => ({ value }), (error) => ({ error }));
}
/** The page's runs that begin the Order # line, one per page: the first word of the line, as the
 *  printed runs give it (a run holds a word and the space after it). Fails unless each page has one. */
function orderRunsOf(bytes, what) {
  const runs = printedRuns(bytes, { pages: 2, what });
  return runs.map((pageRuns, index) => {
    const found = pageRuns.filter((run) => run.text.trim().startsWith("Order"));
    assert.equal(found.length, 1, `${what}: page ${index + 1} prints the Order # line once: ${JSON.stringify(pageRuns.map((run) => run.text))}`);
    return found[0];
  });
}

/** Opens the template's draft v2 in the editor, designs it on a canvas from the order, narrows and
 *  drags the Order # item, saves and publishes, and reads the two printed tags back. */
async function designTagOnCanvas({ page, shot, ctx, order, orderId, flowOrder }) {
  const listName = "Container tag";
  const rowOf = async () => {
    await page.goto(`${ctx.baseURL}/admin/templates`);
    await page.getByRole("heading", { name: "Document templates" }).waitFor({ state: "visible" });
    const typeList = page.getByRole("list", { name: listName, exact: true });
    await typeList.getByRole("button", { name: new RegExp(`^${CONTAINER_TAG_TEMPLATE_NAME}`) }).click();
    return typeList.getByRole("listitem").filter({ hasText: CONTAINER_TAG_TEMPLATE_NAME });
  };
  const row = await rowOf();
  await row.getByText("Published v1").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Open draft", exact: true }).click();
  await page.getByText("Open draft: v2").waitFor({ state: "visible" });
  await page.getByRole("link", { name: "Edit draft" }).click();
  await page.waitForURL(new RegExp(`${ctx.baseURL}/admin/templates/[^/]+/edit`));
  await page.getByText("Container tag · editing draft v2").waitFor({ state: "visible" });

  // The live page sits beside the stage only at a wide window, as the other canvas sections' do.
  await page.setViewportSize({ width: 1440, height: 900 });
  const designOnCanvas = page.getByRole("button", { name: "Design on a canvas", exact: true });
  await openRecordTab(page, "Sections");
  await designOnCanvas.waitFor({ state: "visible" });
  assert.equal(await designOnCanvas.isDisabled(), true, "Design on a canvas waits for an order picked in Preview");
  assert.equal(await designOnCanvas.getAttribute("title"), "Pick an order in Preview first");
  await openRecordTab(page, "Preview");
  const record = page.getByRole("combobox", { name: "Preview record" });
  const option = record.locator("option").filter({ hasText: new RegExp(`^#${order.orderNumber} — `) }).first();
  await option.waitFor({ state: "attached", timeout: 15000 });
  await record.selectOption(await option.getAttribute("value"));
  await openRecordTab(page, "Sections");
  await designOnCanvas.click();
  const confirm = page.getByRole("dialog");
  await confirm.waitFor({ state: "visible" });
  const confirmText = (await confirm.textContent()) ?? "";
  assert.ok(confirmText.includes(`order #${order.orderNumber}'s first tag`),
    `the confirm names the order's first tag as the seed: ${JSON.stringify(confirmText)}`);
  await confirm.getByRole("button", { name: "Design on a canvas", exact: true }).click();
  await confirm.waitFor({ state: "hidden" });
  const designPanel = page.getByRole("tabpanel", { name: /^Design(\s*Unsaved changes)?$/ });
  await designPanel.waitFor({ state: "visible" });
  assert.equal(await page.getByRole("tab", { name: /^Sections/ }).count(), 0, "a canvas tag shows Design in place of Sections");
  const canvasItems = page.getByRole("list", { name: "Canvas items", exact: true });
  const canvasItem = (name) => canvasItems.getByRole("listitem", { name, exact: true });
  const orderItem = canvasItem("Order number");
  await orderItem.waitFor({ state: "visible" });
  await assertNeverVisible(canvasItem("Barcode"), "a tag's canvas holds no barcode", 500);
  await page.getByTitle("Live page").waitFor({ state: "visible" });
  await shot("container-tag-canvas-seeded");

  const xBox = designPanel.getByLabel("X (in)", { exact: true });
  const widthBox = designPanel.getByLabel("Width (in)", { exact: true });
  // Select the item (a focus selects it) and read its X as the box shows it, in inches.
  await orderItem.focus();
  await designPanel.getByRole("heading", { name: "Order number", exact: true, level: 3 }).waitFor({ state: "visible" });
  // One label, page top only: the inspector offers no Repeat box (the profile's oneLabel).
  assert.equal(await designPanel.getByLabel("Repeat on every page", { exact: true }).count(), 0,
    "a tag's inspector shows no Repeat box (pin)");
  const xFrom = await xBox.inputValue();
  // The seed puts the item at the label's left margin, 14 pt = 0.19 in; its 260 pt width leaves no room
  // to move across (a move is clamped by the margins), so it is narrowed to 2 in (144 pt) first.
  assert.equal(xFrom, "0.19", "the seeded Order # item stands at the label's left margin");
  await widthBox.fill("2");
  await widthBox.press("Tab");
  await waitForValue(widthBox, "2.00");

  // The drag: the grab point is a quarter in from the item's left edge at its middle height, and the
  // stage's px per pt is its width over the LABEL's 288 pt, never the Letter page's 612.
  await orderItem.scrollIntoViewIfNeeded();
  const box = await orderItem.boundingBox();
  const stage = await canvasItems.boundingBox();
  assert.ok(box && stage, "the Order # item and the stage are on screen");
  const scale = stage.width / TAG_PAGE_WIDTH;
  const x0 = box.x + box.width / 4;
  const y0 = box.y + box.height / 2;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x0 + 100 * scale, y0, { steps: 8 });
  await page.mouse.up();
  const xTo = await changedFrom(xBox, xFrom, "the Order # item's X after the drag");
  const moved = (Number(xTo) - Number(xFrom)) * 72;
  assert.ok(Math.abs(moved - 100) <= CANVAS_GRID / 2 + 2, `the drag moved the Order # item about 100 pt across: ${moved.toFixed(2)} pt`);
  assert.equal(await designPanel.getByLabel("Anchor", { exact: true }).inputValue(), "page-top", "the moved item is still anchored at the label's top");
  await shot("container-tag-canvas-moved");

  const saveDraft = page.getByRole("button", { name: "Save draft", exact: true });
  assert.equal(await saveDraft.isDisabled(), false,
    `the moved canvas tag saves; Save draft's title reads ${JSON.stringify(await saveDraft.getAttribute("title"))}`);
  await saveDraft.click();
  await page.getByRole("region", { name: "Template status" }).getByText("Saved", { exact: true }).waitFor({ state: "visible" });

  const published = await rowOf();
  await page.getByText("Open draft: v2").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Publish saved draft", exact: true }).click();
  await published.getByText("Published v2").waitFor({ state: "visible" });

  // Print tags again, from the hub's Containers grid: the published canvas prints, one label a row.
  await page.goto(`${ctx.baseURL}/orders/${orderId}`);
  const containers = await hubSection(page, "Containers");
  await containers.waitFor({ state: "visible" });
  await containers.getByLabel("Container 1 type", { exact: true }).waitFor();
  const canvasLink = containers.getByRole("link", { name: "Print tags", exact: true });
  await waitForState(canvasLink, "visible", "Print tags must be open on the saved order", 15000);
  const download = settled(page.waitForEvent("download", { timeout: 30000 }));
  await canvasLink.click();
  const canvasDownload = await download;
  assert.ok(canvasDownload.value, `the canvas tags must download: ${canvasDownload.error?.message}`);
  const canvasPath = await bounded(canvasDownload.value.path(), "the canvas tags must finish downloading");
  const canvasBytes = await readFile(canvasPath);
  const canvasPages = printedPages(canvasBytes, { pages: 2, what: "the canvas container tags" });
  for (const [index, lines] of canvasPages.entries()) {
    for (const line of [`Order #${order.orderNumber}`, order.customer.name, "Cust PO TAGS-PO-77", "Containers: 5"]) {
      assert.ok(lines.includes(line), `the canvas tag ${index + 1} prints ${JSON.stringify(line)}: ${JSON.stringify(lines)}`);
    }
  }
  for (const [index, run] of orderRunsOf(canvasBytes, "the canvas tags").entries()) {
    const delta = run.x - flowOrder.x;
    assert.ok(Math.abs(delta - moved) <= 2,
      `the canvas tag ${index + 1}'s Order # starts ${delta.toFixed(2)} pt from where the flow printed it, where the designer's move of ${moved.toFixed(2)} pt ± 2 was expected`);
  }
}

export async function run(page, shot, ctx) {
  const lead = await entryFixture(page, ctx, "E2E-TAGS-LEAD");
  const rider = await entryFixture(page, ctx, "E2E-TAGS-RIDER");
  const savedFrom = new Date();
  const saved = await mutate(page, ctx, "/api/orders", {
    clientRequestId: crypto.randomUUID(), customerId: ctx.fixtures.orderCustomerId, poNumber: "TAGS-PO-77",
    lines: [{ partId: lead.id, qty: 1000, weight: 1270 }, { partId: rider.id, qty: 20, weight: 25 }],
    containers: [{ typeId: ctx.fixtures.containerTypeId, count: 2 }, { typeId: ctx.fixtures.containerTypeId, count: 3 }],
  });
  const savedBy = new Date();
  const orderId = saved.order.id;
  const order = await readJson(page, ctx, `/api/orders/${orderId}`);
  assert.deepEqual(order.containers.map((row) => row.count), [2, 3], "the order's saved container rows");
  const href = `/api/orders/${orderId}/container-tags`;

  await page.goto(`${ctx.baseURL}/orders/${orderId}`);
  // Containers, Print tags included, sits on the hub's Parts & containers tab (PR 2).
  const containers = await hubSection(page, "Containers");
  await containers.waitFor({ state: "visible" });
  await containers.getByLabel("Container 1 type", { exact: true }).waitFor();

  // 1. Open on a saved order with rows: a link to the route, beside Save containers.
  const link = containers.getByRole("link", { name: "Print tags", exact: true });
  await waitForState(link, "visible", "#743: Print tags must be a link on a saved order with container rows", 15000);
  assert.equal(await link.getAttribute("href"), href, "#743: Print tags must link to the order's tags route");
  await shot("hub-print-tags-open");

  // 2. Closed over unsaved work in this grid, with the unsaved sentence; open again after Discard.
  const closed = containers.locator("span[aria-disabled='true']", { hasText: "Print tags" });
  await containers.getByLabel("Container 1 count", { exact: true }).fill("4");
  await waitForState(closed, "visible", "#743: Print tags must close while a container box holds unsaved work", 15000);
  await waitForTitle(closed, UNSAVED_TITLE, "#743: the closed Print tags");
  await shot("hub-print-tags-closed");
  await containers.getByRole("button", { name: "Discard changes to containers", exact: true }).click();
  await waitForState(link, "visible", "#743: Print tags must open again once the grid's edits are discarded", 15000);

  // 3. The download: two pages, each the whole tag.
  const download = settled(page.waitForEvent("download", { timeout: 30000 }));
  await link.click();
  const downloaded = await download;
  assert.ok(downloaded.value, `#743: Print tags must download the tags: ${downloaded.error?.message}`);
  assert.equal(downloaded.value.suggestedFilename(), `container-tags-${order.orderNumber}.pdf`,
    "#743: the tags must be named for the order");
  const path = await bounded(downloaded.value.path(), "#743: the tags must finish downloading");
  const pages = printedPages(await readFile(path), { pages: 2, what: "#743: the container tags" });
  const receivedLines = minutesBetween(savedFrom, savedBy).map((time) => `Received ${civilDate(order.receivedDate)}, ${time}`);
  for (const [index, lines] of pages.entries()) {
    const received = receivedLines.find((line) => lines.includes(line));
    assert.ok(received,
      `#743: tag ${index + 1} must say when the order was received, on the plant's clock, one of ${JSON.stringify(receivedLines)}; it drew ${JSON.stringify(lines)}`);
    assertRun(lines, [
      `Order #${order.orderNumber}`, order.customer.name, "PO TAGS-PO-77", "Containers: 5", received,
      "E2E-TAGS-LEAD × 1,000", "E2E-TAGS-RIDER × 20",
    ], `#743: tag ${index + 1}`);
  }
  // The page stayed where it was, with nothing unsaved: the link is still open.
  await waitForState(link, "visible", "#743: Print tags must stay open after the download", 5000);

  // 4. The customer's own Container tag template (container tag PR 1): a new template, its PO label
  // typed as "Cust PO" and published, assigned to the order's customer, prints on the tags. The
  // Standard is never edited, and the assignment is cleared again whatever happens after it is made.
  const made = await mutate(page, ctx, "/api/templates", { docType: "CONTAINER_TAG", name: CONTAINER_TAG_TEMPLATE_NAME });
  const templateId = made.id;
  const detail = await readJson(page, ctx, `/api/templates/${templateId}`);
  const config = structuredClone(detail.draft.config);
  const poField = config.sections.find((section) => section.key === "tag")?.fields.find((field) => field.key === "po_number");
  assert.ok(poField, "the Container tag's draft holds the PO number field");
  poField.label = "Cust PO";
  await mutate(page, ctx, `/api/templates/${templateId}/draft`, { config, updatedAt: detail.draft.updatedAt }, "PATCH");
  await mutate(page, ctx, `/api/templates/${templateId}/publish`);
  const assignmentsUrl = `/api/customers/${ctx.fixtures.orderCustomerId}/template-assignments`;
  const tagAssignments = async () =>
    (await readJson(page, ctx, assignmentsUrl)).filter((row) => row.docType === "CONTAINER_TAG");
  assert.deepEqual(await tagAssignments(), [], "the order customer holds no Container tag assignment before the flow assigns one");
  try {
    await mutate(page, ctx, assignmentsUrl, { docType: "CONTAINER_TAG", templateId }, "PUT");
    const assigned = await tagAssignments();
    assert.deepEqual(assigned.map((row) => row.templateId), [templateId], "the customer's Container tag is the flow's template");

    const customDownload = settled(page.waitForEvent("download", { timeout: 30000 }));
    await link.click();
    const custom = await customDownload;
    assert.ok(custom.value, `the customer's tag template must print: ${custom.error?.message}`);
    const customPath = await bounded(custom.value.path(), "the customer's tags must finish downloading");
    const customBytes = await readFile(customPath);
    const customPages = printedPages(customBytes, { pages: 2, what: "the customer's container tags" });
    for (const [index, lines] of customPages.entries()) {
      assertRun(lines, [`Order #${order.orderNumber}`, order.customer.name, "Cust PO TAGS-PO-77", "Containers: 5"],
        `the customer's tag ${index + 1}`);
      assert.ok(!lines.includes("PO TAGS-PO-77"), `the customer's tag ${index + 1} prints the typed PO label, never the Standard's`);
    }

    // 5. The same template designed on a canvas (container tag PR 3): its v2 draft is seeded from this
    // order's first tag, the Order # item is narrowed and dragged about 100 pt across, and the saved,
    // published layout prints each tag with the order number that far from where the flow printed it.
    const flowOrder = orderRunsOf(customBytes, "the flow's tags")[0];
    const viewport = page.viewportSize();
    try {
      await designTagOnCanvas({ page, shot, ctx, order, orderId, flowOrder });
    } finally {
      await page.setViewportSize(viewport);
    }
  } finally {
    await ctx.apiMutate(page, `${ctx.baseURL}${assignmentsUrl}?docType=CONTAINER_TAG`, { method: "DELETE" });
  }
  assert.deepEqual(await tagAssignments(), [], "the flow's Container tag assignment is cleared again");
}
