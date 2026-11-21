// The three readers a test of a heading or a label is built on, each held by value.
//
// `headingRowsOf` and `labelOf` (tests/helpers/markup.ts) read a static render. `jsxTexts`
// (tests/helpers/jsx-source.ts) reads the source of a component no test renders. A case built on
// one of them compares against a list written out, so these cases are what shows that a reader
// which found nothing, or read the wrong element, would be seen.
//
// The markup is written here, as React's static renderer writes it, and the first case holds
// that renderer to what the two markup readers count on. `jsxTexts` takes a file, so its cases
// read two small components that hold no weight word: the board's Columns panel and the file
// chooser.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { jsxTexts } from "./helpers/jsx-source";
import { headingRowsOf, labelOf } from "./helpers/markup";

// A Lines table as it renders: the first heading cell holds a no-break space, the last is empty.
const LINES = '<table class="w-full"><thead><tr class="text-left"><th class="py-1">\u00a0</th><th>Part</th>'
  + "<th>Qty</th><th>Net weight (lb)</th><th>Quote</th><th></th></tr></thead>"
  + '<tbody><tr class="border-t"><td>1</td><td>P-100</td><td>250</td><td>1600</td><td></td><td></td></tr></tbody></table>';
// A second table, whose body row has a row heading.
const TOTALS = '<table aria-label="Order totals"><thead><tr><th>Type</th><th>Count</th><th></th></tr></thead>'
  + '<tbody><tr><th scope="row">Parts</th><td>1</td><td></td></tr></tbody></table>';

describe("what the two markup readers stand on", () => {
  it("React's static renderer closes each element, quotes each attribute value and writes five entities", () => {
    const html = renderToStaticMarkup(createElement("div", null,
      createElement("table", null, createElement("thead", null, createElement("tr", null,
        createElement("th", { title: 'a "b" > c' }, "R & D <x> \"y\" 'z'"), createElement("th", null, "\u00a0")))),
      createElement("label", null, "Net weight (lb)", createElement("input", { "aria-label": "Tom & Co's weight" }))));
    expect(html).toBe('<div><table><thead><tr><th title="a &quot;b&quot; &gt; c">R &amp; D &lt;x&gt; &quot;y&quot; &#x27;z&#x27;</th>'
      + '<th>\u00a0</th></tr></thead></table><label>Net weight (lb)<input aria-label="Tom &amp; Co&#x27;s weight"/></label></div>');
    expect(headingRowsOf(html)).toEqual([["R & D <x> \"y\" 'z'", ""]]);
    expect(labelOf(html, "Tom & Co's weight")).toBe("Net weight (lb)");
  });
});

describe("headingRowsOf", () => {
  it("answers a row of headings whole, an empty cell and a no-break space as \"\", and no row without a heading", () => {
    expect(headingRowsOf(LINES)).toEqual([["", "Part", "Qty", "Net weight (lb)", "Quote", ""]]);
  });

  it("answers every table's heading row in order, and a body row's row heading as its one cell", () => {
    expect(headingRowsOf(`<section>${LINES}<p>None.</p>${TOTALS}</section>`)).toEqual([
      ["", "Part", "Qty", "Net weight (lb)", "Quote", ""],
      ["Type", "Count", ""],
      ["Parts"],
    ]);
  });

  it("answers no row for markup with no heading cell", () => {
    expect(headingRowsOf("<p>None.</p><table><tbody><tr><td>1</td></tr></tbody></table>")).toEqual([]);
  });

  it("drops tags, decodes the five entities React writes, and collapses white space", () => {
    const row = '<tr><th class="p-2">R &amp; D <span aria-hidden="true">▲</span></th>'
      + "<th>&lt;a&gt; &quot;b&quot; &#x27;c&#x27;</th><th>Net\n      weight (lb)</th></tr>";
    expect(headingRowsOf(row)).toEqual([["R & D ▲", "<a> \"b\" 'c'", "Net weight (lb)"]]);
  });

  it("decodes in one pass, so a heading that shows an entity's own spelling keeps it", () => {
    expect(headingRowsOf("<tr><th>&amp;lt;b&amp;gt;</th></tr>")).toEqual([["&lt;b&gt;"]]);
  });
});

describe("labelOf", () => {
  const RIDER = '<label class="block">Qty<input value="1" aria-label="Add rider quantity" class="w-24"/></label>'
    + '<label class="block">Net weight (lb)<input aria-label="Add rider weight"/></label>';

  it("answers the text of the label that holds the control of that name", () => {
    expect(labelOf(RIDER, "Add rider weight")).toBe("Net weight (lb)");
    expect(labelOf(RIDER, "Add rider quantity")).toBe("Qty");
  });

  it("answers everything the label shows, the text of an element inside it included", () => {
    const html = '<label class="block text-sm">Each weight (lb)\n  <input aria-label="Part each weight"/>'
      + '<span class="text-xs"> per piece</span></label>';
    expect(labelOf(html, "Part each weight")).toBe("Each weight (lb) per piece");
  });

  it("matches the name whole, as the browser reads it, and only on an attribute of that name", () => {
    const html = '<label>A<input aria-label="Load 1 weight"/></label><label>B<input aria-label="Load 1 weight unit"/></label>'
      + '<label>C<input aria-label="Tom &amp; Co&#x27;s weight"/></label><label>D<input data-aria-label="Load 1 weight"/></label>';
    expect(labelOf(html, "Load 1 weight")).toBe("A");
    expect(labelOf(html, "Tom & Co's weight")).toBe("C");
  });

  it("throws when no label holds a control of that name, though a control has it and a label carries it", () => {
    const html = '<label aria-label="Lead weight">Weight</label><input aria-label="Lead weight"/>';
    expect(() => labelOf(html, "Lead weight")).toThrow(/^0 labels hold a control named "Lead weight"$/);
  });

  it("throws when two labels hold a control of that name", () => {
    const html = '<label>A<input aria-label="Line 1 weight"/></label><label>B<input aria-label="Line 1 weight"/></label>';
    expect(() => labelOf(html, "Line 1 weight")).toThrow(/^2 labels hold a control named "Line 1 weight"$/);
  });
});

describe("jsxTexts", () => {
  const PICKER = "src/app/board-parts/ColumnPicker.tsx";
  const CHOOSER = "src/components/FileChooser.tsx";

  it.each<[tag: string, held: string[]]>([
    ["span", ["{def.label}"]],
    ["button", ["↑", "↓"]],
    ["label", ["<input> <span>"]],
    ["input", [""]],
    ["th", []],
  ])("answers what each <%s> of the Columns panel holds, as written", (tag, held) => {
    expect(jsxTexts(PICKER, tag)).toEqual(held);
  });

  it("answers an outer element before one inside it, and nothing for a JSX comment", () => {
    expect(jsxTexts(CHOOSER, "span")).toEqual(["<label> <span>", '{chosen ?? "No file chosen"}']);
  });

  it("answers a label that reads a name before its box as that name and the box", () => {
    expect(jsxTexts(CHOOSER, "label")).toEqual(["{label} <input>"]);
  });
});
