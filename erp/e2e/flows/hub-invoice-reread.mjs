// #568 (owner rulings 2026-10-19: "Hub re-reads", proven in a browser by "New small flow"): the
// order hub's Create invoice, whose departure is cancelled while its request is still out. The
// request still lands, and the hub stays on the order, reads its Invoices list again (the new
// invoice is listed) and closes Create invoice with "This order already has an invoice — open it
// below". Before #568 the section read nothing after such a success: it listed no invoice, Create
// invoice stayed open, and a second click was refused 400 "already has an invoice".
//
// The departure is the one Create invoice captures before it sends its request
// (`createInvoice` in src/app/orders/[id]/InvoicesSection.tsx). A keystroke in the Shell's search
// box cancels it: the box's change handler (`changeQuery`, src/components/Shell.tsx) invalidates the
// pending departure before it does anything else. So the flow holds the create request in its own
// route until a keystroke has landed in that box, then lets the request go on to the server
// unchanged (`route.continue()`): the server creates the invoice and the page reads the server's
// own answer.
//
// What each wait proves:
// - Before the click, the section reads "No invoices raised against this order yet." and Create
//   invoice carries no title. The section's first read of its list has landed, empty, and nothing
//   closes the button, so an invoice listed later came from a read sent after the click.
// - The route has the request, naming this order and nothing else (the hub sends no request key,
//   ruling 2). The section captured its departure before it sent the request, so the keystroke that
//   follows cancels a departure that exists. Typed any earlier, it would have found none to cancel.
// - The search box holds "x" before the request is let go. The box is controlled, so it holds what
//   was typed only once its change handler has run, and that handler cancels the departure first.
//   Backspace then empties the box, still before the request is let go: that cancels nothing more,
//   and the box's own search, which waits 250 ms, is normally never sent (if it is, it only reads).
// - The server answers the create with a 200 that made the invoice (`deduped: false`) for this order.
// - The wait that proves the ruling: Create invoice carries "This order already has an invoice —
//   open it below". The section reaches that title only from a read of its list that landed with no
//   error and holds a live invoice, and its first read held none, so this is a read after the create.
//   With the success path's re-read deleted, busy is never cleared on that path: the button stays
//   "Creating…" and the title never comes. Had the keystroke not cancelled the departure, the page
//   would have gone on to the invoice, and there would be no button here to read.
// - Then the section lists the invoice by the document number the server answered with, linking to
//   that invoice; the address is still the hub's; and the section shows no error. The last two are
//   implied by the title (the button is the hub's own, and the title needs a read with no error);
//   they are checked as well, so a failure names them.
//
// The order belongs to the invoicing fixture customer, whose orders, shipments and invoices the run's
// clean-up removes. That order, its shipment and its draft invoice are all the flow leaves (run.mjs
// says where the flow sits and why).
import assert from "node:assert/strict";
import { assertNeverVisible, waitForTitle, waitForValue } from "../lib/ui.mjs";
import { createOrderViaUi, hubSection, orderPanel, startNewShipment, waitForShipmentPage } from "../lib/orders.mjs";
import { bounded } from "../lib/order-entry-workspace.mjs";
import { routeRequests } from "../route-keep-alive.mjs";

const ALREADY_INVOICED = "This order already has an invoice — open it below";

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;

  // --- An order of the invoicing fixture customer, shipped complete. ---
  const order = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.invCustomerCode,
    lines: [{ partNumber: fixtures.invPartNumber, qty: 10 }],
  });
  await startNewShipment(page, ctx, fixtures.invCustomerId, [order]);
  await waitForValue(orderPanel(page, `#${order.number}`).getByLabel("Line 1 ship-now quantity", { exact: true }), "10");
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  await waitForShipmentPage(page);

  // --- The hub: Shipped, no invoice yet, Create invoice open. ---
  const hubUrl = `${ctx.baseURL}/orders/${order.id}`;
  await page.goto(hubUrl);
  await page.getByRole("heading", { name: /^Order #\d+/ }).waitFor({ state: "visible", timeout: 20000 });
  // Invoices sits on the hub's Billing tab (PR 2): opened here, which puts `?tab=billing` on the URL.
  const invoices = await hubSection(page, "Invoices");
  const createInvoice = invoices.getByRole("button", { name: "Create invoice", exact: true });
  await invoices.getByText("No invoices raised against this order yet.", { exact: true })
    .waitFor({ state: "visible", timeout: 15000 });
  await waitForTitle(createInvoice, null, "Create invoice on a Shipped order with no invoice");
  assert.equal(await createInvoice.isDisabled(), false, "a Shipped order with no invoice must offer Create invoice");
  await shot("hub-shipped-no-invoice");

  // --- Create invoice, its request held here until a keystroke has cancelled its departure. ---
  //
  // The route matches the create's address alone, so the section's reads of its list (at
  // /api/orders/<id>/invoices) never reach it. It holds every create request (a POST) until the flow
  // lets them go, then sends each on unchanged; any other request to this address goes on at once.
  // Each held request's handler settles with null, or with the error that kept it from going on, so
  // a handler never rejects.
  const creates = [];
  let letGo;
  const held = new Promise((resolve) => { letGo = resolve; });
  let heard;
  const arrived = new Promise((resolve) => { heard = resolve; });
  const handlers = [];
  const holdCreate = (route) => {
    if (route.request().method() !== "POST") return route.continue();
    creates.push(route.request().postDataJSON());
    const handler = (async () => {
      heard();
      await held;
      await route.continue();
    })().then(() => null, (error) => error);
    handlers.push(handler);
    return handler;
  };
  const stopHolding = await routeRequests(page, `${ctx.baseURL}/api/invoices`, holdCreate);
  const search = page.getByRole("combobox", { name: "Global search", exact: true });

  let answered;
  try {
    await createInvoice.click();
    await bounded(arrived, "Create invoice must send its create request");
    assert.deepEqual(creates, [{ orderId: order.id }],
      "the hub's create must name this order alone, with no request key (ruling 2)");
    await search.press("x");
    await waitForValue(search, "x");
    await search.press("Backspace");
    await waitForValue(search, "");
    await shot("create-held-departure-cancelled");
    // Registered only now: the held request cannot be answered before it is let go just below.
    answered = page.waitForResponse((res) =>
      new URL(res.url()).pathname === "/api/invoices" && res.request().method() === "POST");
  } finally {
    // A check that fails above lets the held request go too, so its handler ends before the harness
    // closes the page. Once the checks pass, this is the release itself.
    letGo();
  }
  const response = await answered;
  const body = await response.json();
  assert.equal(response.status(), 200, `the create must succeed: ${JSON.stringify(body)}`);
  assert.equal(body.deduped, false, "the create must make the invoice, not find one");
  assert.equal(body.invoice.orderId, order.id, "the create must make this order's invoice");

  // The re-read: the section reads its list again, finds the invoice, and closes Create invoice.
  await waitForTitle(createInvoice, ALREADY_INVOICED,
    "Create invoice after a create whose departure was cancelled (the section must read its list again)");
  assert.equal(await createInvoice.isDisabled(), true, "Create invoice must close once the invoice is listed");
  const listed = invoices.getByRole("link", { name: body.invoice.documentNumber, exact: true });
  await listed.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await listed.getAttribute("href"), `/invoicing/${body.invoice.id}`,
    "the listed invoice must be the one the create made");
  assert.equal(new URL(page.url()).pathname, new URL(hubUrl).pathname,
    "a create whose departure was cancelled must leave the order on screen");
  // Once the section lists a row, the only paragraph it can draw is its error.
  await assertNeverVisible(invoices.locator("p"), "the section must show no error after its re-read", 500);
  assert.deepEqual((await bounded(Promise.all(handlers), "the held create's handler must end")).filter(Boolean), [],
    "the held create must have gone on to the server");
  assert.equal(creates.length, 1, "Create invoice must have sent one create");
  await shot("hub-invoice-listed");

  // The create was answered, and the section's reads go to another address, so no request to this
  // route's address is in flight when it goes (#340). A check that fails above leaves the route
  // where it is, letting every request go on, until the harness closes the page.
  await stopHolding();
}
