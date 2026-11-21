import { describe, expect, it } from "vitest";
import { jsxTags, jsxTexts } from "./helpers/jsx-source";

// The shipping list's column headings (the weights design §11.3, S1), and the class on its net
// weight heading (#527: the owner's ruling of 2026-10-15 and answer at the browser look of
// 2026-10-17). The list is a page that reads in effects
// and calls `useRouter`, and no test renders it, so its heading row is read from the source: what
// each `<th>` holds as written, an expression as `{its source}`. The first case holds that the
// weight column's heading is the expression `NET_WEIGHT_LB` and no text of its own. It does not
// hold where that name comes from: `tsc` refuses a name that is neither declared nor imported, and
// tests/weight-words-sweep.test.ts holds the leaf's texts by value and fails the same words written
// in the list as text. Only a browser shows the words on the screen.
//
// The second case reads the classes of the `<th>` that reads NET_WEIGHT_LB from the source. It
// holds `xl:whitespace-nowrap` among them, and neither `lg:whitespace-nowrap` nor a bare
// `whitespace-nowrap`. The invoice page's rule of 2026-10-10 is the `lg` class
// (tests/operational-formatting.test.tsx holds it there), and the board takes it; here it made the
// list 23 px wider than a 1024 px window, so the owner took `xl` for this list at the look. A cell
// that is not found answers no class, which fails the first of the three. It does not hold the
// lines the heading takes, the page's width, or that no other class (another breakpoint's nowrap,
// `text-nowrap`) keeps it from wrapping below 1280 px: only a browser shows those.
const FILE = "src/app/shipping/ShippingList.tsx";

describe("the shipping list's headings", () => {
  it("heads its ten columns in order, the weight column by NET_WEIGHT_LB", () => {
    expect(jsxTexts(FILE, "th")).toEqual([
      "Packing List No", "Customer", "Ship Date", "Orders", "Carrier", "Pieces", "{NET_WEIGHT_LB}", "Freight", "BOL No", "Status",
    ]);
  });
});

describe("the shipping list: the net weight heading's cell", () => {
  it("carries xl:whitespace-nowrap, and neither lg:whitespace-nowrap nor a bare whitespace-nowrap", () => {
    // jsxTexts and jsxTags each answer the file's elements in source order, so the <th> that
    // jsxTexts finds at a place is the one jsxTags has at that place among its own.
    // `xl:whitespace-nowrap` is Tailwind's one-line class from its `xl` breakpoint up, 80rem by
    // Tailwind's default, which is 1280 px. `lg:whitespace-nowrap` is the same class from 1024 px
    // up, and a bare `whitespace-nowrap` at every width: each is refused.
    const classes = jsxTags(FILE).filter((one) => one.name === "th")[jsxTexts(FILE, "th").indexOf("{NET_WEIGHT_LB}")]
      ?.attr("className")?.split(" ") ?? [];
    expect(classes).toContain("xl:whitespace-nowrap");
    expect(classes).not.toContain("lg:whitespace-nowrap");
    expect(classes).not.toContain("whitespace-nowrap");
  });
});
