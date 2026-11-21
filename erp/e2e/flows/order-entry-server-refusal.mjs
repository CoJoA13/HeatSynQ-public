// #494, #546: New order takes a SERVER refusal of a container's, a part line's, a serial's or a
// charge's value to the box the server names.
//
// The page's own checks refuse the same values first, so the server's refusal is reached only when
// the two disagree, or when the server knows what the page cannot. The flow stands the server's
// answer in for most of them: Save's POST is answered with a 400 in the server's own shape, and that
// request does not reach the server. One refusal is the server's own, and one is the page's.
//
//   - Two container rows, both valid. The answer refuses the second row's Cust Cont Id
//     (`containers.1.customerContainerId: …`, counted from 0). The banner shows the server's
//     sentence, the Parts & containers tab shows, and the cursor is in Container 2's Cust Cont Id
//     box, whose row has opened its optional boxes to show it. Container 1's stay closed.
//   - The answer is the refusal of a container type deleted while the page was open, which names no
//     row: the cursor is on Add container (owner ruling, 2026-10-15).
//   - The answer refuses line 2's quantity (`lines.1.qty: …`, counted from 0): the cursor is in
//     Line 2's quantity box.
//   - Line 2 holds the serials `B` and `A ` (the space typed into the serial's own box, as Add
//     serial(s) trims), and the answer is the server's sentence for a serial entered twice, which
//     quotes the trimmed `A`: the cursor is in Line 2's serial 2 box. The server would not refuse
//     these two; the answer proves the page finds the quoted serial among the line's serials
//     trimmed (#546). The last step proves the page's own duplicate check trims.
//   - Save is pressed on Parts & containers and the answer refuses charge 1's amount
//     (`charges.0.amount: …`): the Order details tab shows and the cursor is in Charge 1's amount box.
//   - The server's own refusal: line 2's part, made inactive after the load plan was shown, with
//     nothing that changes the plan's input touched after it (a new plan would be refused on Process
//     & loads, and Save would send nothing). The page read its parts once, when it opened, so it
//     still offers the part and sends the save. The server answers `Line 2 (<code> · E2E-REFUSAL-QTY):
//     that part is inactive`, and the cursor is in Line 2's Part box. Before #546 it went to Line 2's
//     quantity, because the part number holds "QTY".
//   - The page's own refusal: the lead line's serials `A` and `A ` are refused as one serial entered
//     twice, the cursor is in its serial 1 box, and nothing is sent.
//
// No order is created, and the flow changes no shared fixture state. Its two parts are its own,
// keyed against the order fixture customer, whose teardown reaps them; startEntry discards the
// draft it leaves.
import assert from "node:assert/strict";
import { entryFixture, startEntry, entryTab, waitPlan, ownedOrders, mutate } from "../lib/order-entry-workspace.mjs";
import { pickCombobox, waitForFocused, waitForValue } from "../lib/ui.mjs";
import { entryAlert, waitForAlertLines, watchRequests } from "../lib/refusal-lines.mjs";
import { routeRequests } from "../route-keep-alive.mjs";

const ROW_REFUSAL = "containers.1.customerContainerId: Too big: expected string to have <=60 characters";
const NO_ROW_REFUSAL = "That container type does not exist";
const QTY_REFUSAL = "lines.1.qty: Too small: expected number to be >=1";
const CHARGE_REFUSAL = "charges.0.amount: cannot be negative.";
const RIDER_PART_NUMBER = "E2E-REFUSAL-QTY";

/** Opens a part line's Serial numbers section, which stays closed on a line of a part that does not
 *  require serials until it holds one. */
async function openSerials(page, line) {
  await page.locator("details", { has: page.getByLabel(`Line ${line} add serial`, { exact: true }) })
    .locator("summary").click();
}

/** Adds serials through a line's Add serial(s) box, one per Enter. */
async function addSerials(page, line, serials) {
  const box = page.getByLabel(`Line ${line} add serial`, { exact: true });
  for (const serial of serials) {
    await box.fill(serial);
    await box.press("Enter");
  }
}

const partsTabShown = async (page) =>
  page.getByRole("tab", { name: "Parts & containers", exact: true }).getAttribute("aria-selected");

export async function run(page, shot, ctx) {
  const part = await entryFixture(page, ctx, "E2E-SERVER-REFUSAL");
  // Made before the page opens: New order reads the active parts once, when it opens.
  const rider = await entryFixture(page, ctx, RIDER_PART_NUMBER);
  const before = await ownedOrders(page, ctx);
  const riderLabel = `Line 2 (${ctx.fixtures.orderCustomerCode} · ${rider.partNumber})`;
  const serialRefusal = `${riderLabel}: serial "A" is entered twice`;
  const inactiveRefusal = `${riderLabel}: that part is inactive`;

  await startEntry(page, ctx, part, 30);
  await waitPlan(page, 2);
  await page.getByRole("button", { name: "Add part line", exact: true }).click();
  await pickCombobox(page, "Line 2 part", rider.partNumber, new RegExp(`^${rider.partNumber}(?:\\s|$)`));
  await page.getByLabel("Line 2 quantity", { exact: true }).fill("15");
  // The lead part's load quantity is 15 and it has no load weight, so 30 + 15 pieces are 3 loads.
  await waitPlan(page, 3);
  for (const n of [1, 2]) {
    await page.getByRole("button", { name: "Add container", exact: true }).click();
    await page.getByLabel(`Container ${n} type`, { exact: true }).selectOption(ctx.fixtures.containerTypeId);
    await page.getByLabel(`Container ${n} count`, { exact: true }).fill("2");
  }

  let answer = ROW_REFUSAL;
  const creates = watchRequests(page, "POST", "/api/orders", { exact: true });
  const stopAnswering = await routeRequests(page, `${ctx.baseURL}/api/orders`, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: answer }) })
      : route.continue());
  try {
    // The second row's refusal lands on the second row.
    await entryTab(page, "Order details");
    await page.getByRole("button", { name: "Save only", exact: true }).click();
    await waitForAlertLines(entryAlert(page), [ROW_REFUSAL]);
    assert.equal(await partsTabShown(page), "true", "a container refusal must show the Parts & containers tab");
    await waitForFocused(page.getByLabel("Container 2 customer container id", { exact: true }),
      "Container 2's Cust Cont Id box after the server refused that row's value");
    const firstRowBox = page.getByLabel("Container 1 customer container id", { exact: true });
    assert.equal(await firstRowBox.count(), 1, "the first row must draw its Cust Cont Id box");
    assert.equal(await firstRowBox.isVisible(), false,
      "the first row, which the server did not name, must keep its optional boxes closed");
    await shot("server-refusal-second-row");

    // A refusal that names no row lands on Add container.
    answer = NO_ROW_REFUSAL;
    await page.getByRole("button", { name: "Save only", exact: true }).click();
    await waitForAlertLines(entryAlert(page), [NO_ROW_REFUSAL]);
    await waitForFocused(page.getByRole("button", { name: "Add container", exact: true }),
      "Add container after the server refused a container type and named no row");
    await shot("server-refusal-no-row");

    // Line 2's quantity, counted from 0 in the path.
    answer = QTY_REFUSAL;
    await page.getByRole("button", { name: "Save only", exact: true }).click();
    await waitForAlertLines(entryAlert(page), [QTY_REFUSAL]);
    await waitForFocused(page.getByLabel("Line 2 quantity", { exact: true }),
      "Line 2's quantity box after the server refused lines.1.qty");
    await shot("server-refusal-line-qty");

    // A serial entered twice: the server quotes it trimmed, and line 2's second serial holds it
    // with a trailing space.
    await openSerials(page, 2);
    await addSerials(page, 2, ["B", "A"]);
    const secondSerial = page.getByLabel("Line 2 serial 2", { exact: true });
    await waitForValue(secondSerial, "A");
    await secondSerial.fill("A ");
    await waitForValue(secondSerial, "A ");
    await waitForValue(page.getByLabel("Line 2 serial 1", { exact: true }), "B");
    answer = serialRefusal;
    await page.getByRole("button", { name: "Save only", exact: true }).click();
    await waitForAlertLines(entryAlert(page), [serialRefusal]);
    await waitForFocused(secondSerial, "Line 2's serial 2 box after the server refused its trimmed value as entered twice");
    await shot("server-refusal-line-serial");

    // A charge's amount, refused while Parts & containers shows: the Order details tab comes back.
    await entryTab(page, "Order details");
    await page.getByRole("button", { name: "Review extra charges", exact: true }).click();
    await page.getByRole("dialog", { name: "Extra charges" }).getByRole("button", { name: "Add charge", exact: true }).click();
    await page.getByLabel("Charge 1 description", { exact: true }).fill("Server refusal charge");
    await page.getByLabel("Charge 1 amount", { exact: true }).fill("25.00");
    await entryTab(page, "Parts & containers");
    answer = CHARGE_REFUSAL;
    await page.getByRole("button", { name: "Save only", exact: true }).click();
    await waitForAlertLines(entryAlert(page), [CHARGE_REFUSAL]);
    assert.equal(await page.getByRole("tab", { name: "Order details", exact: true }).getAttribute("aria-selected"), "true",
      "a charge refusal must show the Order details tab");
    await waitForFocused(page.getByLabel("Charge 1 amount", { exact: true }),
      "Charge 1's amount box after the server refused charges.0.amount");
    await shot("server-refusal-charge");
  } finally { await stopAnswering(); }
  assert.equal(creates.count(), 5, "each answered Save must have sent its one create");

  // The server's own refusal. Line 2's part is made inactive after its load plan was shown, and
  // nothing the plan reads (the customer, a line's part, quantity or weight, the load adjustment) is
  // touched after it, so the shown plan stays current and Save sends the order.
  await mutate(page, ctx, `/api/parts/${rider.id}`, { active: false }, "PATCH");
  await waitPlan(page, 3);
  // Saved from Order details, so the Parts & containers check below can fail.
  await entryTab(page, "Order details");
  const answered = page.waitForResponse((r) => r.url() === `${ctx.baseURL}/api/orders` && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save only", exact: true }).click();
  const response = await answered;
  assert.equal(response.status(), 400, "the server must refuse the save of an inactive part");
  assert.equal((await response.json()).error, inactiveRefusal, "the server must name line 2's part as inactive");
  await waitForAlertLines(entryAlert(page), [inactiveRefusal]);
  assert.equal(await partsTabShown(page), "true", "a part line refusal must show the Parts & containers tab");
  await waitForFocused(page.getByLabel("Line 2 part", { exact: true }),
    "Line 2's Part box after the server refused its inactive part, whose number holds QTY");
  await shot("server-refusal-inactive-part");
  assert.equal(creates.count(), 6, "the unanswered Save must have sent its one create to the server");
  assert.equal((await ownedOrders(page, ctx)).length, before.length, "the server's refusal must create no order");

  // The page's own refusal: the lead line's serials `A` and `A ` are one serial entered twice.
  await openSerials(page, 1);
  await addSerials(page, 1, ["A", "A2"]);
  const leadSecondSerial = page.getByLabel("Line 1 serial 2", { exact: true });
  await waitForValue(leadSecondSerial, "A2");
  await leadSecondSerial.fill("A ");
  await waitForValue(leadSecondSerial, "A ");
  await page.getByRole("button", { name: "Save only", exact: true }).click();
  await waitForAlertLines(entryAlert(page), ['Lead line: serial "A" is entered twice.']);
  await waitForFocused(page.getByLabel("Line 1 serial 1", { exact: true }),
    "the lead line's serial 1 box after the page refused its trimmed repeat");
  await shot("server-refusal-page-duplicate");
  assert.equal(creates.count(), 6, "a Save the page refuses must send nothing");
  creates.stop();
  assert.equal((await ownedOrders(page, ctx)).length, before.length, "no order may be created by a refused Save");
}
