import { describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { createOrderViaUi } from "../e2e/lib/orders.mjs";

// `createOrderViaUi` (e2e/lib/orders.mjs) keys the order of every flow that calls it, so a slip in
// it fails those flows together, and only a whole browser run shows that. What can be held with no
// browser is held here, over a stand-in for a Playwright page that keeps one line for each call
// the helper makes, in the order made. With neither `containers` nor `beforeSave` it touches no
// container control. Container rows are keyed after the last part line, with Pieces only where a
// figure is given and no other box of the row. `beforeSave` is awaited once, between the rows and
// the tab change, and what it fails with is what the helper fails with. That order entry in a
// browser answers these calls is not held here.

type Row = { typeId: string; count: number; pieces?: number | null };
/** The helper's options, as its docblock gives them. Read from a .mjs file, TypeScript types them
 *  from the parameter's defaults alone: `beforeSave` comes out required and `containers` a list of
 *  nothing. So the cases call the helper through this shape. */
type Options = {
  customerCode: string; lines: { partNumber: string; qty: number }[]; expectWarnings?: boolean;
  containers?: Row[]; beforeSave?: () => Promise<void>;
};
const createOrder = createOrderViaUi as unknown as
  (page: unknown, ctx: { baseURL: string }, options: Options) => Promise<{ id: string; number: number }>;

/** A call's arguments as a line of the record spells them: a pattern by its source, anything else
 *  as JSON. */
const spell = (args: unknown[]) =>
  args.map((arg) => JSON.stringify(arg, (_key, part) => (part instanceof RegExp ? String(part) : part))).join(", ");

/**
 * A stand-in for a Playwright page. `calls` gets one line for each action the helper takes on the
 * page (it is opened at an address, its address is read) or on a locator of it (a wait, a click, a
 * fill, a pick, a read of its text), in the order taken: how the element was found, then what was
 * done to it. Finding an element leaves no line, so a locator that is built and never acted on is
 * not in the record. No draft banner is offered: the wait for the Discard button rejects, as a
 * locator's wait does when its element never shows. The order it answers with is #1234, at
 * /orders/order-77.
 */
function standIn() {
  const calls: string[] = [];
  const locator = (found: string) => {
    const act = (method: string, answer?: string) => async (...args: unknown[]) => {
      calls.push(`${found}.${method}(${spell(args)})`);
      if (method === "waitFor" && found.includes('"Discard"')) {
        throw Object.assign(new Error("locator.waitFor: Timeout 2000ms exceeded."), { name: "TimeoutError" });
      }
      return answer;
    };
    return { waitFor: act("waitFor"), click: act("click"), fill: act("fill"), selectOption: act("selectOption"),
      textContent: act("textContent", "Order #1234") };
  };
  const find = (how: string) => (...args: unknown[]) => locator(`${how}(${spell(args)})`);
  const page = {
    goto: async (...args: unknown[]) => { calls.push(`goto(${spell(args)})`); },
    url: () => { calls.push("url()"); return "http://stand-in.invalid/orders/order-77"; },
    getByRole: find("getByRole"), getByLabel: find("getByLabel"), getByText: find("getByText"),
  };
  return { page, calls, ctx: { baseURL: "http://stand-in.invalid" } };
}

/** A customer and two part lines. The names are this file's own. */
const ORDER = { customerCode: "STANDCUST", lines: [{ partNumber: "STAND-A", qty: 30 }, { partNumber: "STAND-B", qty: 40 }] };

/** Every call for ORDER up to and including the last part line's quantity. */
const THROUGH_THE_LAST_LINE = [
  'goto("http://stand-in.invalid/orders/new")',
  'getByRole("heading", {"name":"New order"}).waitFor({"state":"visible"})',
  'getByRole("button", {"name":"Discard","exact":true}).waitFor({"state":"visible","timeout":2000})',
  'getByLabel("Customer", {"exact":true}).click()',
  'getByLabel("Customer", {"exact":true}).fill("STANDCUST")',
  'getByRole("option", {"name":"/^STANDCUST/"}).click()',
  'getByRole("tab", {"name":"Parts & containers","exact":true}).click()',
  'getByLabel("Line 1 part", {"exact":true}).click()',
  'getByLabel("Line 1 part", {"exact":true}).fill("STAND-A")',
  'getByRole("option", {"name":"/^STAND-A/"}).click()',
  'getByLabel("Line 1 quantity", {"exact":true}).fill("30")',
  'getByRole("button", {"name":"Add part line"}).click()',
  'getByLabel("Line 2 part", {"exact":true}).click()',
  'getByLabel("Line 2 part", {"exact":true}).fill("STAND-B")',
  'getByRole("option", {"name":"/^STAND-B/"}).click()',
  'getByLabel("Line 2 quantity", {"exact":true}).fill("40")',
];
/** Every call from the change of tab to the saved order's address. */
const FROM_THE_TAB_CHANGE = [
  'getByRole("tab", {"name":"Process & loads","exact":true}).click()',
  'getByText("Fully allocated · 0 pieces remaining", {"exact":true}).waitFor()',
  'getByRole("button", {"name":"Save only","exact":true}).click()',
  String.raw`getByRole("heading", {"name":"/^Order #\\d+/"}).waitFor({"state":"visible","timeout":20000})`,
  String.raw`getByRole("heading", {"name":"/^Order #\\d+/"}).textContent()`,
  "url()",
];

/** Four rows, one for each thing Pieces can be: null, a figure, left out, and 0, which is a figure. */
const ROWS: Row[] = [
  { typeId: "type-1", count: 14, pieces: null },
  { typeId: "type-2", count: 3, pieces: 15 },
  { typeId: "type-3", count: 1 },
  { typeId: "type-4", count: 2, pieces: 0 },
];
/** Every call that keys ROWS. */
const THE_ROWS = [
  'getByRole("button", {"name":"Add container","exact":true}).click()',
  'getByLabel("Container 1 type", {"exact":true}).selectOption("type-1")',
  'getByLabel("Container 1 count", {"exact":true}).fill("14")',
  'getByRole("button", {"name":"Add container","exact":true}).click()',
  'getByLabel("Container 2 type", {"exact":true}).selectOption("type-2")',
  'getByLabel("Container 2 count", {"exact":true}).fill("3")',
  'getByLabel("Container 2 pieces", {"exact":true}).fill("15")',
  'getByRole("button", {"name":"Add container","exact":true}).click()',
  'getByLabel("Container 3 type", {"exact":true}).selectOption("type-3")',
  'getByLabel("Container 3 count", {"exact":true}).fill("1")',
  'getByRole("button", {"name":"Add container","exact":true}).click()',
  'getByLabel("Container 4 type", {"exact":true}).selectOption("type-4")',
  'getByLabel("Container 4 count", {"exact":true}).fill("2")',
  'getByLabel("Container 4 pieces", {"exact":true}).fill("0")',
];

describe("createOrderViaUi (e2e/lib/orders.mjs)", () => {
  it("with neither containers nor beforeSave, keys the customer and the part lines, changes tab and saves, and takes no other action on the page", async () => {
    const { page, calls, ctx } = standIn();
    await createOrder(page, ctx, ORDER);
    expect(calls).toEqual([...THROUGH_THE_LAST_LINE, ...FROM_THE_TAB_CHANGE]);
  });

  it("keys each container row after the last part line: Add container, the type, the count, and Pieces only where a figure is given", async () => {
    const { page, calls, ctx } = standIn();
    await createOrder(page, ctx, { ...ORDER, containers: ROWS });
    expect(calls).toEqual([...THROUGH_THE_LAST_LINE, ...THE_ROWS, ...FROM_THE_TAB_CHANGE]);
  });

  it("awaits beforeSave once, with no argument, after the container rows and before the tab changes", async () => {
    const { page, calls, ctx } = standIn();
    // The line is kept a turn late, so a helper that does not wait for it has changed tab by then.
    const beforeSave = async (...args: unknown[]) => {
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      calls.push(`beforeSave(${spell(args)})`);
    };
    await createOrder(page, ctx, { ...ORDER, containers: ROWS, beforeSave });
    expect(calls).toEqual([...THROUGH_THE_LAST_LINE, ...THE_ROWS, "beforeSave()", ...FROM_THE_TAB_CHANGE]);
  });

  it("fails with what beforeSave failed with", async () => {
    const { page, ctx } = standIn();
    const failure = new assert.AssertionError({ message: "order entry did not read what the table holds" });
    await expect(createOrder(page, ctx, { ...ORDER, beforeSave: async () => { throw failure; } })).rejects.toBe(failure);
  });
});
