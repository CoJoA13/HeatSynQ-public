import { describe, expect, it } from "vitest";
import { code, declared, jsxTags, jsxTexts } from "./helpers/jsx-source";

// The each weight and load limit words on the parts list, on a part's Identity and on a quote's
// free-text line (the weights design's §11.3: M1 to M4, and K39, whose text does not change).
//
// Read from the source. No test renders the parts list, a part's Identity or the quote page's line
// form (the design's §11.7, point 25). So each case holds what the file writes: a heading or a
// label that reads the leaf answers `{EACH_WEIGHT_LB}`, a name. The text behind that name is held
// by value in tests/weight-words-sweep.test.ts. What the operator sees is proven only in a browser.
//
// The four cases that read a file each compare against a list written out here, so a reader that
// finds nothing fails them. The three rows after them expect `declared` to find nothing.

const PARTS_LIST = "src/app/parts/page.tsx";
const PART_IDENTITY = "src/app/parts/[id]/IdentitySection.tsx";
const QUOTE_PAGE = "src/app/quotes/[id]/QuoteDetail.tsx";

/**
 * Does a label, as `jsxTexts` gives it, name a weight or a load limit? Yes when it opens with a
 * read of one of the leaf's three names, or when its words before its first expression or child
 * element say "weight" or "load" as a whole word, in any capitals. An expression or a child
 * element after those words is not looked at.
 */
const namesWeightOrLoad = (label: string): boolean =>
  /^(?:\{(?:EACH_WEIGHT_LB|NET_WEIGHT_LB|NET_WEIGHT)\}|[^{<]*\b(?:weight|load)\b)/i.test(label);

/** The labels of `file` that `namesWeightOrLoad` takes, each as `jsxTexts` gives it. */
const weightLabels = (file: string): string[] => jsxTexts(file, "label").filter(namesWeightOrLoad);

describe("which labels the cases below take (namesWeightOrLoad)", () => {
  it.each<[label: string, taken: boolean]>([
    ["{EACH_WEIGHT_LB} <input>", true],
    ["{NET_WEIGHT_LB} <input>", true],
    ["{NET_WEIGHT} <input>", true],
    ["Load quantity <input>", true],
    ["Load weight (lb) <input>", true],
    // A label that says "weight" with no unit is taken too.
    ["Each weight <input>", true],
    ["Upload <input>", false],
    ["Notes {uploading ? \"Uploading\" : \"\"} <input>", false],
    ["Request days {part.loadWeight} <input>", false],
    ["<input> Active", false],
  ])("answers for the label %s: %s", (label, taken) => {
    expect(namesWeightOrLoad(label)).toBe(taken);
  });
});

describe("weight words on the parts list, a part's Identity and a quote's free-text line (weights design §11.3)", () => {
  it("heads the parts list's weight column with the leaf's each weight heading (M1)", () => {
    expect(jsxTexts(PARTS_LIST, "th")).toEqual(["Customer", "Part number", "Name", "Material", "{EACH_WEIGHT_LB}", "Active"]);
  });

  it("hints the add row's each weight box with the same heading (M2)", () => {
    const boxes = jsxTags(PARTS_LIST).filter((tag) => tag.name === "input" && tag.attr("value") === "draft.eachWeight");
    // `attr` answers an expression's source without its braces and a string's text alike, so the
    // bare name alone could be either. `code` gives the tag's tokens run together, a string with
    // its quotes: the second answer is true while the tag writes `placeholder={EACH_WEIGHT_LB}`.
    expect(boxes.map((tag) => [tag.attr("placeholder"), code(tag.text).includes("placeholder={EACH_WEIGHT_LB}")]))
      .toEqual([["EACH_WEIGHT_LB", true]]);
  });

  it("labels a part's each weight and its load limit with their units, and Load quantity (M3, M4, K52; the owner's rename of Load qty, PR 9)", () => {
    // Each box's Saved mark (R7) follows its input inside the label.
    expect(weightLabels(PART_IDENTITY)).toEqual([
      "{EACH_WEIGHT_LB} <input> <SavedMark>", "Load quantity <input> <SavedMark>", "Load weight (lb) <input> <SavedMark>",
    ]);
  });

  it("labels a quote's free-text each weight box from the leaf (K39)", () => {
    expect(weightLabels(QUOTE_PAGE)).toEqual(["{EACH_WEIGHT_LB} <input>"]);
  });

  it.each([PARTS_LIST, PART_IDENTITY, QUOTE_PAGE])("%s declares no each weight heading of its own", (file) => {
    // `{EACH_WEIGHT_LB}` in the cases above is a name as written. This holds that no variable
    // declaration with an initializer in the file binds that name. It does not hold where an
    // imported name comes from.
    expect(declared(file, "EACH_WEIGHT_LB")).toEqual([]);
  });
});
