import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrderTotalsTable } from "@/components/OrderTotalsTable";
import { ShipmentTotalsTable } from "@/components/ShipmentTotalsTable";
import { orderTotals } from "@/lib/order-totals";
import type { TotalsTableView } from "@/lib/shipment-totals";
import { totalsOf } from "./helpers/order-totals-markup";
import { shipmentTotalsIn } from "./helpers/shipment-totals-markup";

// The markup of one totals table of a shipment (the weights design §12.2 and §12.5).
//
// What each cell and each sentence says is the leaf's, and shipment-totals.test.ts holds every one
// by value. This file holds what the component adds: the root with its mark, the table's name and
// caption, the headings' scope, the line under the table, the tag, and that nothing else is drawn.
//
// vitest has no DOM. The component has no hook and no state, so it is rendered to static markup,
// and called once as a plain function. `shipmentTotalsIn` (tests/helpers/shipment-totals-markup.ts)
// reads the values out of that markup and refuses a heading that is not a `th` and a figure that
// is not a `td`. Its own refusals are held at the foot of this file. Only a browser proves the
// layout and what is announced.

/** A view no shipment gives: every cell holds text of its own, so a cell drawn in another's
 *  column shows. */
const MARKED: TotalsTableView = { caption: "Totals for 1031-1", net: "n1", tare: "t1", gross: "g1", note: null, unsaved: false };
/** The design's T11 with T12. */
const NOTE = "1 row has no Tare each · 1 order has no containers";
/** A table with everything it can draw: the tag and the line under it. */
const FULL: TotalsTableView = { ...MARKED, note: NOTE, unsaved: true };

const render = (totals: TotalsTableView) => renderToStaticMarkup(<ShipmentTotalsTable totals={totals} />);
/** The order totals table while unsaved: its tag is the element this table's tag is held to. */
const orderTable = renderToStaticMarkup(
  <OrderTotalsTable totals={orderTotals({ lines: [{ qty: 1, weight: 1 }], lineParts: [], containers: [] })} unsaved />);

describe("a shipment's totals table", () => {
  it("opens with the box marked data-shipment-totals: the mark is on the root", () => {
    // That the box holds no other div is the reader's to refuse, in every case that reads it.
    expect(render(FULL)).toMatch(/^<div\b[^>]*\sdata-shipment-totals(?=[\s=>])/);
  });

  it("is named by its caption, and reads as three headings, each scoped to its column, over one row of three figures", () => {
    const html = render(MARKED);
    expect(shipmentTotalsIn(html)).toEqual([{
      name: "Totals for 1031-1", caption: "Totals for 1031-1", tag: null,
      columns: ["Net (lb)", "Tare (lb)", "Gross (lb)"], cells: ["n1", "t1", "g1"], note: null,
    }]);
    expect(html.match(/<th\b[^>]*\sscope="col"/g)).toHaveLength(3);
  });

  it("draws the line under the table as one status paragraph, and no paragraph without one", () => {
    expect(shipmentTotalsIn(render({ ...MARKED, note: NOTE }))[0].note).toBe(NOTE);
    expect(render(MARKED)).not.toContain("<p");
  });

  it("carries the order totals table's own tag in its caption while unsaved, outside the table's name, and none otherwise", () => {
    const [tagged] = shipmentTotalsIn(render({ ...MARKED, unsaved: true }));
    expect(tagged.tag).toBe(totalsOf(orderTable).tag);
    expect([tagged.name, tagged.caption]).toEqual(["Totals for 1031-1", "Totals for 1031-1"]);
    expect(render(MARKED)).not.toContain("Unsaved");
  });

  it("holds no control, link, heading, label, section or form", () => {
    expect(render(FULL)).not.toMatch(/<(button|input|select|textarea|a|label|h[1-6]|section|nav|form)\b/);
  });

  it("has no hook and no state: called as a plain function it answers its root", () => {
    // A hook called outside a render throws. A static render would run one without complaint.
    expect(ShipmentTotalsTable({ totals: FULL }).type).toBe("div");
  });
});

describe("the reader of a shipment's totals tables", () => {
  const good = () => render(FULL);

  it("answers no reading for markup that holds no such table, the order totals table included", () => {
    expect(shipmentTotalsIn(orderTable)).toEqual([]);
  });

  it("reads every table in the order drawn, each where it stands among other markup", () => {
    const page = `<section><h3>1031-1</h3>${render(MARKED)}<div class="mt-2"><button>Save serials</button></div></section>`
      + `<section>${render({ ...FULL, caption: "Shipment totals" })}</section>`;
    expect(shipmentTotalsIn(page).map((one) => [one.caption, one.note])).toEqual([["Totals for 1031-1", null], ["Shipment totals", NOTE]]);
  });

  it.each<[string, (html: string) => string, RegExp]>([
    ["a root that is never closed", (html) => html.slice(0, -"</div>".length), /never closed/],
    ["another div inside the root", (html) => html.replace("<table", "<div><table").replace("</table>", "</table></div>"), /holds another div/],
    ["text before the table", (html) => html.replace("<table", "Totals<table"), /does not open with its table/],
    ["a table with no caption", (html) => html.replace(/<caption\b[\s\S]*?<\/caption>/, ""), /a caption, a head and a body/],
    ["text loose in the caption", (html) => html.replace("</caption>", " tag</caption>"), /caption holds markup/],
    ["a caption that holds no span", (html) => html.replace(/(<caption\b[^>]*>)[\s\S]*?<\/caption>/, "$1</caption>"), /one or two spans in the caption, found 0/],
    ["a third span in the caption", (html) => html.replace("</caption>", "<span>more</span></caption>"), /one or two spans in the caption, found 3/],
    ["text loose in the head", (html) => html.replace("<thead>", "<thead>loose"), /totals head holds markup/],
    ["a second row of column headings", (html) => html.replace("</thead>", "<tr><th>More</th></tr></thead>"), /one row of column headings, found 2/],
    ["markup inside a column heading", (html) => html.replace(">Tare (lb)<", "><b>Tare (lb)</b><"), /head row holds markup/],
    ["a td among the column headings", (html) => html.replace("</tr></thead>", "<td>extra</td></tr></thead>"), /not a column heading/],
    ["text loose in the body", (html) => html.replace("<tbody>", "<tbody>loose"), /totals body holds markup/],
    ["a second row of figures", (html) => html.replace("</tbody>", "<tr><td>1</td><td>2</td><td>3</td></tr></tbody>"), /one row of figures, found 2/],
    ["a th among the figures", (html) => html.replace(/<td\b([^>]*)>t1<\/td>/, "<th$1>t1</th>"), /row of figures is not a td/],
    ["markup inside a figure's cell", (html) => html.replace(">t1<", "><b>t1</b><"), /body row holds markup/],
    ["a fourth figure under three headings", (html) => html.replace("</tr></tbody>", "<td>extra</td></tr></tbody>"), /3 headings and 4 figures/],
    ["text loose under the table", (html) => html.replace("</table>", "</table>loose"), /paragraphs holds markup/],
    ["a paragraph with no role", (html) => html.replace(' role="status"', ""), /has no role/],
    ["a paragraph of another role", (html) => html.replace('role="status"', 'role="alert"'), /the role alert/],
    ["two paragraphs under the table", (html) => html.replace(/<p\b[^>]*>[^<]*<\/p>/, (note) => note + note), /at most one paragraph/],
  ])("refuses %s", (_name, broken, message) => {
    expect(() => shipmentTotalsIn(broken(good()))).toThrow(message);
  });
});
