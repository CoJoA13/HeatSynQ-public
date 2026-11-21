// The new shipment form's Add order button and the list beside it (#487, owner answers 1 and 5 of
// 2026-10-16). The button says "Pick an order first" only while the list offers an order and none
// is picked. While the list is closed the button stays untitled, the no-customer case included
// (owner answer 5), and the list gives the reason: with no customer picked, its first option and
// the paragraph above it; otherwise the first option and title `addOrderSelect` gives
// (shipment-gates.ts, the saved shipment page's words): without orders.view, its own title; while
// the customer's orders are being read, "Loading orders…"; after a failed read, "Orders could not be
// loaded"; and with no order to add, "No unshipped orders for this customer" (#699). The list's read
// is keyed on the customer, the permission, the read authorization and the editor's mode (a full
// read leaves editing until it lands), never on the orders on the form, which are filtered out at
// render: Add order and
// Remove order neither empty the list nor read it again. While the form is not editing the read
// does not run and the list reads "Loading orders…" (the fieldset around it is disabled then).
//
// The candidates arrive in an effect, which a static render never runs, so no static render of this
// form shows the list offering an order. What the button answers is addOrderButtonTitle's, proven
// in tests/waiting-titles.test.ts; this file pins, from the parsed source, that the button and the
// list read one condition, so the button cannot say "Pick an order first" beside a closed list.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { declared, jsxTags, type JsxTag } from "./helpers/jsx-source";

const NS = "src/app/shipping/new/NewShipment.tsx";
const tags = jsxTags(NS);
/** An expression as one line: every run of whitespace collapsed, so a pin survives re-wrapping. */
const oneLine = (source: string | undefined) => source?.replace(/\s+/g, " ").trim();
function only(what: string, pick: (tag: JsxTag) => boolean): JsxTag {
  const found = tags.filter(pick);
  expect(found.map((tag) => tag.text), what).toHaveLength(1);
  return found[0];
}

describe("the new form's Add order: the button and its list read one condition", () => {
  it("the list is closed with no customer, or whenever addOrderSelect closes it", () => {
    expect(declared(NS, "addListClosed")).toEqual(["!customerId || addSelect.disabled"]);
    // The form has no lines gate, so the leaf is handed an open one; the list's state and the count
    // of orders not already on the form are what it reads.
    expect(declared(NS, "addSelect").map(oneLine)).toEqual(["addOrderSelect({ gate: NO_LINES_GATE, ordersGate, state: candidatesState, count: addable.length })"]);
    expect(declared(NS, "addable")).toEqual(["candidates.filter(o => !selectedOrderIds.has(o.id))"]);
  });

  it("the list's first option and title are the leaf's, with no customer named first", () => {
    const select = only("the Add order select", (t) => t.name === "select" && t.attr("aria-label") === "Add order");
    expect(select.attr("title")).toBe("addSelect.title");
    expect(oneLine(readFileSync(NS, "utf8"))).toContain('<option value="">{!customerId ? "Pick a customer first" : addSelect.placeholder}</option>');
  });

  it("the list's select is closed by it", () => {
    expect(only("the Add order select", (t) => t.name === "select" && t.attr("aria-label") === "Add order").attr("disabled"))
      .toBe("addListClosed");
  });

  it("the button says what it waits for only while the list is open, and closes as before", () => {
    const button = only("the Add order button", (t) => t.name === "button" && t.attr("onClick") === "() => void addOrder()");
    expect(oneLine(button.attr("title"))).toBe("addOrderButtonTitle({ listOffers: !addListClosed, choice: addChoice })");
    expect(button.attr("disabled")).toBe("!addChoice || addingOrder");
  });
});
