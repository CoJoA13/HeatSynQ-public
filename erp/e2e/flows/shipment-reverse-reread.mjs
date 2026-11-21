// #581 (owner rulings 2026-10-19: "Yes, re-read", proven in a browser by "New small flow"): the
// saved shipment's Reverse, whose departure is cancelled while its request is still out. The
// request still lands, and the page stays on the original, reads it again and shows it frozen as a
// pair: Reverse closes with "This shipment has already been reversed by Packing List N — void that
// reversal first", Void closes, and the amber banner says to void the reversal first. Before #581 the
// page read nothing after such a success: it kept the pre-reversal shipment, Reverse stayed open,
// and a second click was refused 400 "already been reversed".
//
// The departure is the one Reverse captures before it sends its request (`reverseAction` in
// src/app/shipping/[id]/ShipmentDetail.tsx). A keystroke in the Shell's search box cancels it: the
// box's change handler (`changeQuery`, src/components/Shell.tsx) invalidates the pending departure
// before it does anything else. So the flow holds the reverse request in its own route until a
// keystroke has landed in that box, then lets the request go on to the server unchanged
// (`route.continue()`): the server makes the reversal and the page reads the original again.
//
// What each wait proves:
// - Before the click, Reverse is enabled and carries no title. The page's first read of the
//   shipment and its permission read have both landed (the page renders no control until they do,
//   #483), and nothing closes the button, so a title read later came from a read sent after the
//   click.
// - The route has the request. The page captured its departure before it sent the request, so the
//   keystroke that follows cancels a departure that exists. Typed any earlier, it would have found
//   none to cancel. The prompt's message, awaited first, names this packing list: the one dialog
//   the click opens is the reason prompt (nothing is dirty, so `confirmDiscard` asks nothing).
// - The search box holds "x" before the request is let go. The box is controlled, so it holds what
//   was typed only once its change handler has run, and that handler cancels the departure first.
//   Backspace then empties the box, still before the request is let go: that cancels nothing more,
//   and the box's own search, which waits 250 ms, is normally never sent (if it is, it only reads).
// - The server answers the reverse with a 200 whose shipper is a reversal of this shipment
//   (`reversesShipperId` is this shipment's id) under its own, new packing-list number.
// - The wait that proves the ruling: Reverse carries "This shipment has already been reversed by
//   Packing List N2 — void that reversal first". `reverseGate` reaches that title only from
//   `reversedByShipperNumber`, which only a read of the shipment after the reversal sets, and the
//   reversal's own answer is never adopted as this page's state, so this is a read after the
//   reverse. With the success path's re-read deleted and its `return` kept, busy is never cleared
//   on that path and the button stays "Reversing…"; with the whole cancelled-attempt branch
//   deleted, busy clears and Reverse re-opens with no title over the pre-reversal state. The title
//   never comes either way. While busy the button reads "Reversing…", which the "Reverse shipment"
//   exact-name locator does not match, so reads reported as "the element could not be read" until
//   busy clears are expected, not a flake. Had the keystroke not cancelled the departure, the page
//   would have gone on to the reversal, whose own Reverse is titled "This shipment is itself a
//   reversal of Packing List N — reverse the original shipment instead", never this title; the
//   address check below names that departure.
// - Then Reverse is disabled; the un-invoiced pair sentence is up ("This shipment has been reversed
//   by Packing List N2 — void the reversal first, then edit, then re-reverse": no invoice, so the
//   banner leads with the reversal step, not the invoice sentence); the address is still the
//   original's; Void is disabled with its own reversal title; and the page shows no red line. The
//   last four follow from the title (the button is the original's own, and the title needs a read
//   with no error); they are checked as well, so a failure names them.
//
// The order belongs to the invoicing fixture customer, whose orders and shipments the run's
// clean-up removes. That order, its shipment and the reversal are all the flow leaves; it never
// invoices (run.mjs says where the flow sits and why).
import assert from "node:assert/strict";
import { assertNeverVisible, waitForEnabled, waitForTitle, waitForValue } from "../lib/ui.mjs";
import { answerModal, modalTitle } from "../lib/modal.mjs";
import { createOrderViaUi, orderPanel, startNewShipment, waitForShipmentPage } from "../lib/orders.mjs";
import { bounded } from "../lib/order-entry-workspace.mjs";
import { routeRequests } from "../route-keep-alive.mjs";

const REVERSE_REASON =
  "E2E shipment-reverse-reread flow: reversing while a search keystroke cancels the departure, " +
  "demonstrating the re-read after a cancelled departure (#581).";

// The three sentences, as the page states them (`reverseGate`, `voidGate` and `pairFreeze` in
// ShipmentDetail.tsx); each names the reversal's packing-list number.
const alreadyReversed = (n) =>
  `This shipment has already been reversed by Packing List ${n} — void that reversal first`;
const voidTheReversal = (n) =>
  `This shipment has been reversed by Packing List ${n} — void the reversal first`;
const pairSentence = (n) =>
  `This shipment has been reversed by Packing List ${n} — void the reversal first, then edit, then re-reverse`;

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;

  // --- An order of the invoicing fixture customer, shipped complete, never invoiced. ---
  const order = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.invCustomerCode,
    lines: [{ partNumber: fixtures.invPartNumber, qty: 10 }],
  });
  await startNewShipment(page, ctx, fixtures.invCustomerId, [order]);
  await waitForValue(orderPanel(page, `#${order.number}`).getByLabel("Line 1 ship-now quantity", { exact: true }), "10");
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  const { id, shipperNumber } = await waitForShipmentPage(page);
  const shipmentUrl = `${ctx.baseURL}/shipping/${id}`;

  // --- The saved shipment: live, un-reversed, Reverse open. ---
  const reverseButton = page.getByRole("button", { name: "Reverse shipment", exact: true });
  const voidButton = page.getByRole("button", { name: "Void shipment", exact: true });
  await waitForEnabled(reverseButton, "Reverse on a live, un-reversed shipment");
  await waitForTitle(reverseButton, null, "Reverse on a live, un-reversed shipment");
  assert.equal(await reverseButton.isDisabled(), false, "a live, un-reversed shipment must offer Reverse");
  await shot("shipment-reverse-open");

  // --- Reverse, its request held here until a keystroke has cancelled its departure. ---
  //
  // The route matches the reverse's address alone, so the page's reads of the shipment (at
  // /api/shippers/<id>) never reach it. It holds every reverse request (a POST) until the flow lets
  // them go, then sends each on unchanged; any other request to this address goes on at once. Each
  // held request's handler settles with null, or with the error that kept it from going on, so a
  // handler never rejects.
  const reverses = [];
  let letGo;
  const held = new Promise((resolve) => { letGo = resolve; });
  let heard;
  const arrived = new Promise((resolve) => { heard = resolve; });
  const handlers = [];
  const holdReverse = (route) => {
    if (route.request().method() !== "POST") return route.continue();
    reverses.push(route.request().postDataJSON());
    const handler = (async () => {
      heard();
      await held;
      await route.continue();
    })().then(() => null, (error) => error);
    handlers.push(handler);
    return handler;
  };
  const reversePath = `/api/shippers/${id}/reverse`;
  const stopHolding = await routeRequests(page, `${ctx.baseURL}${reversePath}`, holdReverse);
  const search = page.getByRole("combobox", { name: "Global search", exact: true });

  let answered;
  try {
    await reverseButton.click();
    const message = await bounded(modalTitle(page), "Reverse must ask for its reason");
    assert.match(message, new RegExp(`^Reverse shipment \\(Packing list #${shipperNumber}\\)\\?`));
    await answerModal(page, { reason: REVERSE_REASON });
    await bounded(arrived, "Reverse must send its reverse request");
    assert.deepEqual(reverses, [{ reason: REVERSE_REASON }], "the reverse must carry the reason typed and nothing else");
    await search.press("x");
    await waitForValue(search, "x");
    await search.press("Backspace");
    await waitForValue(search, "");
    await shot("reverse-held-departure-cancelled");
    // Registered only now: the held request cannot be answered before it is let go just below.
    answered = page.waitForResponse((res) =>
      new URL(res.url()).pathname === reversePath && res.request().method() === "POST");
  } finally {
    // A check that fails above lets the held request go too, so its handler ends before the harness
    // closes the page. Once the checks pass, this is the release itself.
    letGo();
  }
  const response = await answered;
  const body = await response.json();
  assert.equal(response.status(), 200, `the reverse must succeed: ${JSON.stringify(body)}`);
  assert.equal(body.shipper.reversesShipperId, id, "the reverse must make a reversal of this shipment");
  const reversalNumber = body.shipper.shipperNumber;
  assert.notEqual(reversalNumber, shipperNumber, "the reversal must carry its own packing-list number");

  // The re-read: the page reads the original again, finds it reversed, and closes Reverse.
  await waitForTitle(reverseButton, alreadyReversed(reversalNumber),
    "Reverse after a reverse whose departure was cancelled (the page must read the shipment again)");
  assert.equal(await reverseButton.isDisabled(), true, "Reverse must close once the original reads as reversed");
  await page.getByText(pairSentence(reversalNumber), { exact: true }).waitFor({ state: "visible", timeout: 5000 });
  assert.equal(page.url(), shipmentUrl, "a reverse whose departure was cancelled must leave the original on screen");
  await waitForTitle(voidButton, voidTheReversal(reversalNumber), "Void on a reversed, un-invoiced original", 5000);
  assert.equal(await voidButton.isDisabled(), true, "Void must close on an original carrying a live reversal");
  // The page-level red lines are its `bg-red-50` paragraphs (the action error, the mount read's
  // error, the voided and credit-hold notices); an order panel's own red line (`PanelMessage`, a
  // `p[role="alert"]`) is outside this check, and the pair banner just checked is amber.
  await assertNeverVisible(page.locator("p.bg-red-50"), "the page must show no error after its re-read", 500);
  assert.deepEqual((await bounded(Promise.all(handlers), "the held reverse's handler must end")).filter(Boolean), [],
    "the held reverse must have gone on to the server");
  assert.equal(reverses.length, 1, "Reverse must have sent one reverse request");
  await shot("shipment-reversed-pair-frozen");

  // The reverse was answered, and the page's reads go to another address, so no request to this
  // route's address is in flight when it goes (#340). A check that fails above leaves the route
  // where it is, letting every request go on, until the harness closes the page.
  await stopHolding();
}
