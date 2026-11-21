import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoadAllocationSummary } from "@/app/orders/[id]/LoadAllocationSummary";
import { OrderTotalsTable } from "@/components/OrderTotalsTable";
import { orderTotals, type OrderTotalsView } from "@/lib/order-totals";
import { totalsOf } from "./helpers/order-totals-markup";

// The order totals table's markup (the weights design §10.2, §10.3 and §10.5).
//
// What each cell and each sentence says is the leaf's, and order-totals.test.ts holds every one by
// value. This file holds what the component adds: the root with its mark and its own space, the
// table's name and caption, which element draws each heading, cell, note and weighed line, the tag
// and the gap before it, that the root has no tab stop, name or role and the table no role or live
// region, and that nothing else is drawn.
//
// vitest has no DOM. The component has no hook and no state, so it is rendered to static markup,
// and called once as a plain function. `totalsOf` (tests/helpers/order-totals-markup.ts) reads the
// values out of that markup, and its own refusals are held at the foot of this file. Which element
// holds a value is read here, by this file's own patterns. Only a browser proves the layout, the
// scroll and what is announced.

/** Order 1004 of the demonstration dataset, weighed: one line of 250 pieces and 1,600.00 lb on a
 *  part of 6.4 lb each, and one row of 3 baskets at 42.50 lb each that holds 252 pieces and
 *  weighed 1,740.00 lb. */
const WEIGHED = orderTotals({
  lines: [{ qty: 250, weight: 1600 }],
  lineParts: [{ partId: "part-1", eachWeight: 6.4 }],
  containers: [{ count: "3", pieces: "252", tareEach: "42.5", scaleGross: "1740" }],
});
/** A view no order gives: every cell holds text of its own, so a cell drawn in another's column
 *  or another's row shows. */
const MARKED: OrderTotalsView = {
  rows: [
    { heading: "Parts", pieces: "p1", net: "p2", tare: "p3", gross: "p4" },
    { heading: "Containers", pieces: "c1", net: "c2", tare: "c3", gross: "c4" },
    { heading: "Order", pieces: "o1", net: "o2", tare: "o3", gross: "o4" },
  ],
  note: null,
  weighed: [],
};
/** The design's N3. */
const NOTE = "1 row has no Pieces · 1 row has no Tare each";
/** The design's G1 and G4. */
const WEIGHED_LINES = ["Weighed net 1,612.50 lb · 12.50 lb over", "Implied pieces 252 · 2 over"];

const render = (totals: OrderTotalsView, unsaved?: boolean) =>
  renderToStaticMarkup(<OrderTotalsTable totals={totals} unsaved={unsaved} />);

/** Each row of the table's head or body, each cell written as its element, its scope when it has
 *  one, and its text: "th[col]:Pieces", "td:250", and "td:" for an empty cell. */
function cellsIn(html: string, part: "thead" | "tbody"): string[][] {
  const inner = new RegExp(`<${part}\\b[^>]*>([\\s\\S]*?)</${part}>`).exec(html)?.[1] ?? "";
  return [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(([, row]) =>
    [...row.matchAll(/<(th|td)\b([^>]*)>([^<]*)<\/\1>/g)].map(([, element, attributes, text]) => {
      const scope = /\sscope="([^"]*)"/.exec(attributes)?.[1];
      return `${element}${scope === undefined ? "" : `[${scope}]`}:${text}`;
    }));
}
/** Each paragraph, in order, written as its role and its text: "status:…", and "plain:…" for a
 *  paragraph with no role. */
function paragraphs(html: string): string[] {
  const found = [...html.matchAll(/<p\b([^>]*)>([^<]*)<\/p>/g)]
    .map(([, attributes, text]) => `${/\srole="([^"]*)"/.exec(attributes)?.[1] ?? "plain"}:${text}`);
  // A paragraph this pattern cannot read (one with markup inside it) fails here, never passes unseen.
  expect(html.match(/<p\b/g) ?? []).toHaveLength(found.length);
  return found;
}
// The two readers below take a pattern that finds one opening tag and captures what stands between
// the element's name and its `>`. Each answers undefined when the pattern finds no tag.
/** The classes of the tag `opening` finds in `html`. Undefined, too, for a tag with no class. */
const classesIn = (html: string, opening: RegExp) =>
  /\sclass="([^"]*)"/.exec(opening.exec(html)?.[1] ?? "")?.[1].split(" ");
/** What is left of the tag's attributes once those named in `own` are taken out: "" for a tag that
 *  carries no other. */
const otherAttributes = (html: string, opening: RegExp, ...own: string[]) =>
  opening.exec(html)?.[1].replace(new RegExp(`\\s(?:${own.join("|")})="[^"]*"`, "g"), "");

describe("the order totals table", () => {
  it("is one box marked data-order-totals that holds one table, named and captioned Order totals", () => {
    const html = render(WEIGHED);
    // The root is the box the flows find the table by, and the markup's only `div`.
    expect(html).toMatch(/^<div\b[^>]*\sdata-order-totals(?=[\s=>])/);
    expect(html.endsWith("</div>")).toBe(true);
    expect(html.match(/<div\b/g)).toHaveLength(1);
    expect(/^<div\b[^>]*\sclass="([^"]*)"/.exec(html)?.[1].split(" ")).toContain("overflow-x-auto");
    expect(html.match(/<table\b/g)).toHaveLength(1);
    const read = totalsOf(html);
    expect(read.name).toBe("Order totals");
    expect(read.caption).toBe("Order totals");
    expect(read.tag).toBeNull();
  });

  it("carries its own space above and below: my-3 among the root's classes", () => {
    expect(classesIn(render(WEIGHED), /^<div\b([^>]*)>/)).toContain("my-3");
  });

  it("gives the box it scrolls in no tab stop, no name and no role: the root carries no attribute but its mark and its classes", () => {
    // Point 11 of the design's §10.7. A tab stop, a name and a role are each an attribute.
    for (const html of [render(MARKED), render({ ...WEIGHED, note: NOTE }, true)]) {
      expect(otherAttributes(html, /^<div\b([^>]*)>/, "data-order-totals", "class")).toBe("");
    }
  });

  it("heads its columns Pieces, Net (lb), Tare (lb) and Gross (lb), after an empty corner cell", () => {
    const html = render(WEIGHED);
    expect(cellsIn(html, "thead")).toEqual([["td:", "th[col]:Pieces", "th[col]:Net (lb)", "th[col]:Tare (lb)", "th[col]:Gross (lb)"]]);
    expect(totalsOf(html).columns).toEqual(["Pieces", "Net (lb)", "Tare (lb)", "Gross (lb)"]);
  });

  it("draws three rows, each a row heading and four cells, every cell in its own row and column", () => {
    const html = render(MARKED);
    expect(cellsIn(html, "tbody")).toEqual([
      ["th[row]:Parts", "td:p1", "td:p2", "td:p3", "td:p4"],
      ["th[row]:Containers", "td:c1", "td:c2", "td:c3", "td:c4"],
      ["th[row]:Order", "td:o1", "td:o2", "td:o3", "td:o4"],
    ]);
    const { rows } = totalsOf(html);
    expect(rows).toEqual({ Parts: ["p1", "p2", "p3", "p4"], Containers: ["c1", "c2", "c3", "c4"], Order: ["o1", "o2", "o3", "o4"] });
    expect(Object.keys(rows)).toEqual(["Parts", "Containers", "Order"]);
  });

  it("shows order 1004's figures as the leaf gives them, and an empty cell as an empty td", () => {
    const html = render(WEIGHED);
    const read = totalsOf(html);
    expect(read.rows).toEqual({
      Parts: ["250", "1,600.00", "", ""],
      Containers: ["252", "", "127.50", ""],
      Order: ["", "1,600.00", "127.50", "1,727.50"],
    });
    expect(read.note).toBeNull();
    expect(read.weighed).toEqual(WEIGHED_LINES);
    // The five cells the design's §4.2 leaves empty, and the corner of the head.
    expect(html.match(/<td\b[^>]*><\/td>/g)).toHaveLength(6);
    expect(html.match(/<td\b/g)).toHaveLength(13);
  });

  it("draws the note as one status paragraph under the table, and each weighed line as a plain paragraph after it", () => {
    const html = render({ ...MARKED, note: NOTE, weighed: WEIGHED_LINES });
    expect(paragraphs(html)).toEqual([`status:${NOTE}`, `plain:${WEIGHED_LINES[0]}`, `plain:${WEIGHED_LINES[1]}`]);
    expect(html.search(/<p\b/)).toBeGreaterThan(html.indexOf("</table>"));
    const read = totalsOf(html);
    expect(read.note).toBe(NOTE);
    expect(read.weighed).toEqual(WEIGHED_LINES);
  });

  it("draws no status paragraph without a note, and no paragraph at all with neither", () => {
    expect(paragraphs(render(WEIGHED))).toEqual(WEIGHED_LINES.map((line) => `plain:${line}`));
    expect(paragraphs(render({ ...MARKED, note: NOTE }))).toEqual([`status:${NOTE}`]);
    expect(render(MARKED).endsWith("</table></div>")).toBe(true);
  });

  it("is no live region and has no role as a table: the table carries no attribute but its name and its classes, and nothing is marked aria-live", () => {
    // Point 10 of the design's §10.7. A live region is made by a role or by `aria-live`.
    for (const html of [render(MARKED), render({ ...WEIGHED, note: NOTE }, true)]) {
      expect(otherAttributes(html, /<table\b([^>]*)>/, "aria-label", "class")).toBe("");
      expect(html).not.toContain("aria-live");
    }
  });

  it("carries the Loads card's own tag in its caption while unsaved, and none otherwise", () => {
    // The Loads card while its grid is unsaved: the element owner answer P5 names.
    const card = renderToStaticMarkup(
      <LoadAllocationSummary rows={[{ qty: "30", weight: "2.10" }]} lines={[{ qty: 30, weight: 2.1 }]} dirty={true} ready={true} />);
    const cardTags = card.match(/<span\b[^>]*>Unsaved totals<\/span>/g) ?? [];
    expect(cardTags).toHaveLength(1);
    const unsaved = totalsOf(render(WEIGHED, true));
    expect(unsaved.tag).toBe(cardTags[0]);
    // The tag is in the caption, after its text, and is no part of the table's name.
    expect(unsaved.caption).toBe("Order totals");
    expect(unsaved.name).toBe("Order totals");
    for (const html of [render(WEIGHED), render(WEIGHED, false)]) {
      expect(totalsOf(html).tag).toBeNull();
      expect(html).not.toContain("Unsaved");
    }
  });

  it("sets the gap between the caption's text and the tag as a margin on the first span: mr-3", () => {
    // The tag's classes are the Loads card's and no more, so the gap cannot be the tag's.
    expect(classesIn(render(WEIGHED, true), /<caption\b[^>]*><span\b([^>]*)>Order totals<\/span><span\b/)).toContain("mr-3");
  });

  it("is plain but for the tag: no amber on a cell, the note or a weighed line", () => {
    const html = render({ ...WEIGHED, note: NOTE }, true);
    const { tag } = totalsOf(html);
    expect(tag).toContain("accent");
    expect(html.split(tag ?? "").join("")).not.toContain("accent");
    expect(render({ ...WEIGHED, note: NOTE })).not.toContain("accent");
  });

  it("holds no control, link, heading, label or form, nothing the section test reads as a cell label, and never Net:", () => {
    for (const html of [render(MARKED), render({ ...WEIGHED, note: NOTE }, true)]) {
      expect(html).not.toMatch(/<(button|input|select|textarea|a|label|h[1-6]|section|nav|form)\b/);
      // tests/containers-section.test.tsx reads every `div` or `label` that opens with text as a
      // container row's cell label. This is its pattern.
      expect([...html.matchAll(/<(?:label|div)\b[^>]*>([^<]+)</g)]).toEqual([]);
      expect(html).not.toContain("Net:");
    }
  });

  it("has no hook and no state: called as a plain function it answers its root", () => {
    // A hook called outside a render throws. A static render would run one without complaint.
    const element = OrderTotalsTable({ totals: WEIGHED, unsaved: true });
    expect(isValidElement(element)).toBe(true);
    expect(element.type).toBe("div");
  });
});

describe("the reader of the order totals table's markup", () => {
  /** A table with everything a reader can meet: the tag, a note and two weighed lines. */
  const good = () => render({ ...WEIGHED, note: NOTE }, true);

  it("reads the table where it stands inside a section, other boxes before and after it", () => {
    const inSection = `<section><div>Type</div>${good()}<div class="mt-2"><button>Add container</button></div></section>`;
    expect(totalsOf(inSection)).toEqual(totalsOf(good()));
    expect(totalsOf(inSection).rows.Order).toEqual(["", "1,600.00", "127.50", "1,727.50"]);
  });

  it.each<[string, (html: string) => string, RegExp]>([
    ["markup with no table root", () => "<table></table>", /found 0/],
    ["two table roots", (html) => html + html, /found 2/],
    ["a root that is never closed", (html) => html.slice(0, -"</div>".length), /never closed/],
    ["another div inside the root", (html) => html.replace("<table", "<div><table").replace("</table>", "</table></div>"), /holds another div/],
    ["text before the table", (html) => html.replace("<table", "Totals<table"), /does not open with its table/],
    ["a table with no caption", (html) => html.replace(/<caption\b[\s\S]*?<\/caption>/, ""), /a caption, a head and a body/],
    ["text loose in the caption", (html) => html.replace("</caption>", " tag</caption>"), /caption holds markup/],
    ["a caption that holds no span", (html) => html.replace(/(<caption\b[^>]*>)[\s\S]*?<\/caption>/, "$1</caption>"), /one or two spans in the caption, found 0/],
    ["a third span in the caption", (html) => html.replace("</caption>", "<span>more</span></caption>"), /one or two spans in the caption, found 3/],
    ["a second row of column headings", (html) => html.replace("</thead>", "<tr><td></td></tr></thead>"), /one row of column headings/],
    // The head row is the first row of the markup, and the only one that opens with a `td`.
    ["a head row with no corner cell", (html) => html.replace("<tr><td></td>", "<tr>"), /does not open with a corner cell/],
    ["a corner cell that holds text", (html) => html.replace("<tr><td></td>", "<tr><td>Totals</td>"), /corner cell of the order totals holds text/],
    ["a corner cell that holds an element", (html) => html.replace("<tr><td></td>", "<tr><td><span></span></td>"), /head row holds markup/],
    ["a td after the column headings", (html) => html.replace("</tr></thead>", "<td>extra</td></tr></thead>"), /not a column heading/],
    ["text between two rows", (html) => html.replace("</tr><tr", "</tr>loose<tr"), /body holds markup/],
    ["markup inside a cell", (html) => html.replace(">252<", "><b>252</b><"), /body row holds markup/],
    ["a row with no heading", (html) => html.replace(/<th\b[^>]*>Order<\/th>/, ""), /a heading and then cells/],
    ["a th among a row's cells", (html) => html.replace(/<td\b([^>]*)>252<\/td>/, "<th$1>252</th>"), /a heading and then cells/],
    ["two rows under one heading", (html) => html.replace(">Order</th>", ">Parts</th>"), /headed Parts/],
    ["text loose under the table", (html) => html.replace("</table>", "</table>loose"), /paragraphs holds markup/],
    ["a paragraph of another role", (html) => html.replace(/<p(?=[^>]*>Weighed)/, '<p role="alert"'), /the role alert/],
    ["two status paragraphs", (html) => html.replace(/<p role="status"[^>]*>[^<]*<\/p>/, (note) => note + note), /at most one status paragraph/],
  ])("refuses %s", (_, broken, message) => {
    expect(() => totalsOf(broken(good()))).toThrow(message);
  });
});
