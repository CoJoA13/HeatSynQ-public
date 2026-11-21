import { describe, expect, it } from "vitest";
import { jsxTags, jsxTexts } from "./helpers/jsx-source";

// The saved order's Shipments section: its heading row (the weights design §11.3, O11), and the
// padding on its net weight column (the owner's choice of 2026-10-10).
//
// The section draws "Nothing shipped yet." until its read lands, and a static render runs no
// effect, so no render reaches its table. The row is read from the source: what each <th> holds
// as it is written, a heading that reads a name as `{NAME}`. The first case holds that the weight
// heading is the expression NET_WEIGHT_LB and no text of its own. It does not hold where that
// name comes from: `tsc` refuses a name that is neither declared nor imported, and
// tests/weight-words-sweep.test.ts holds the leaf's texts by value and fails the same words
// written in the section as text. Only a browser shows the words on the screen.
// The list is written out, so a reader that finds nothing fails.
//
// The second case reads two cells' classes from the source: the <th> that reads NET_WEIGHT_LB and
// the <td> that prints the order's net weight on a shipment. It holds `pr-3` among the classes of
// each. A cell that is not found answers no class, which fails. It does not hold the gap the
// padding draws: only a browser shows that.
const FILE = "src/app/orders/[id]/ShipmentsSection.tsx";

describe("ShipmentsSection: the heading row", () => {
  it("heads its seven columns in order, the weight column by NET_WEIGHT_LB", () => {
    expect(jsxTexts(FILE, "th")).toEqual(
      ["Shipment", "Packing List No", "Ship date", "Qty", "{NET_WEIGHT_LB}", "Complete", "Carrier"]);
  });
});

describe("ShipmentsSection: the net weight column", () => {
  it("carries pr-3 on its heading cell and on its figure cell", () => {
    // jsxTexts and jsxTags each answer the file's elements in source order, so the <th> or <td>
    // that jsxTexts finds at a place is the one jsxTags has at that place among its own.
    const classes = (tag: "th" | "td", holds: string): string[] =>
      jsxTags(FILE).filter((one) => one.name === tag)[jsxTexts(FILE, tag).indexOf(holds)]
        ?.attr("className")?.split(" ") ?? [];
    expect(classes("th", "{NET_WEIGHT_LB}")).toContain("pr-3");
    expect(classes("td", '{mine ? formatNumber(mine.weight, 2) : "—"}')).toContain("pr-3");
  });
});
