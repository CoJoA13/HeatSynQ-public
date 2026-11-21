import { describe, expect, it } from "vitest";
import {
  entryTareEach, tareEachAfterTypeChange, tareEachText, typeDefaultTare, type ContainerTypeTare,
} from "@/lib/container-tare-prefill";
import type { ContainerTypeOption as SavedOrderType } from "@/app/orders/[id]/page";
import type { ContainerTypeOption as OrderEntryType } from "@/app/orders/new/order-draft";

// What a container row's Tare each box shows, and what a change of the row's type does to it (the
// weights design §9.4, "The prefill rule"; owner rulings W3 and W4 of 2026-10-09). Hand-built pick
// lists, every answer by value. No server, no database and no renderer: order entry and the saved
// order's Containers grid call these functions and show what they return.

/** A pick list as both order screens hold it: each type's id, its name and its default tare each. */
const TYPES = [
  { id: "basket", name: "Steel Basket", tareEach: 42.5 },
  { id: "gaylord", name: "Cardboard Gaylord", tareEach: 60 },
  { id: "bin", name: "Bin", tareEach: 310 },
  { id: "skid", name: "Skid", tareEach: null },
  { id: "bag", name: "Bag", tareEach: 0 },
];
/** The same list under each order screen's own `ContainerTypeOption`. `retype` and the order entry
 *  case that follows a change of type hand these to the leaf as they are. That is the proof that
 *  each screen's type fits the leaf's `ContainerTypeTare`, and `tsc` holds it, not a case: vitest
 *  checks no types. The two annotations bind the other way too, TYPES against each screen's type,
 *  so a screen type that gains a required key needs it in TYPES. */
const SAVED_ORDER_TYPES: readonly SavedOrderType[] = TYPES;
const ORDER_ENTRY_TYPES: readonly OrderEntryType[] = TYPES;

/** The saved order's grid changing a row's type from one of TYPES to another: the text the row's
 *  Tare each box holds afterwards. The grid leaves the box alone when the rule answers null. */
function retype(current: string, from: string | null, to: string | null): string {
  const next = tareEachAfterTypeChange({
    current, oldDefault: typeDefaultTare(SAVED_ORDER_TYPES, from), newDefault: typeDefaultTare(SAVED_ORDER_TYPES, to),
  });
  return next === null ? current : next;
}

describe("a tare each as text in a box", () => {
  it.each<[number, string]>([
    [42.5, "42.5"], [310, "310"], [60, "60"], [0, "0"], [0.1, "0.1"], [9_999_999_999.99, "9999999999.99"],
  ])("spells %d as %j, as the saved order's grid spells a stored figure", (value, text) => {
    expect(tareEachText(value)).toBe(text);
  });

  it("is the empty string for no figure", () => {
    expect(tareEachText(null)).toBe("");
  });
});

describe("a type's default tare each", () => {
  it("is the figure of the type the row names", () => {
    expect(typeDefaultTare(TYPES, "bin")).toBe(310);
    expect(typeDefaultTare(TYPES, "basket")).toBe(42.5);
    expect(typeDefaultTare(TYPES, "gaylord")).toBe(60);
  });

  it("is 0 for a type whose default is 0: a default of 0 is a default", () => {
    expect(typeDefaultTare(TYPES, "bag")).toBe(0);
  });

  it("is null for a type with no default", () => {
    expect(typeDefaultTare(TYPES, "skid")).toBeNull();
  });

  it.each<[string, string | null | undefined]>([
    ["null, as order entry holds a row with no type", null],
    ["undefined", undefined],
    ["the empty string, as the saved order's grid holds a row with no type", ""],
  ])("is null for no type: %s", (_name, typeId) => {
    expect(typeDefaultTare(TYPES, typeId)).toBeNull();
  });

  it("is null for a type that is not in the list", () => {
    expect(typeDefaultTare(TYPES, "retired")).toBeNull();
    expect(typeDefaultTare([], "bin")).toBeNull();
  });

  it("reads a list that holds an id and a figure and nothing else", () => {
    const bare: readonly ContainerTypeTare[] = [{ id: "bin", tareEach: 310 }];
    expect(typeDefaultTare(bare, "bin")).toBe(310);
  });
});

describe("order entry's Tare each box", () => {
  it("shows the type's default while the box was never typed in", () => {
    expect(entryTareEach(null, 42.5)).toBe("42.5");
    expect(entryTareEach(null, 310)).toBe("310");
    expect(entryTareEach(null, 0)).toBe("0");
  });

  it("shows nothing while the box was never typed in and the type has no default", () => {
    expect(entryTareEach(null, null)).toBe("");
  });

  it("follows a change of type while the box was never typed in", () => {
    const shown = (typeId: string | null) => entryTareEach(null, typeDefaultTare(ORDER_ENTRY_TYPES, typeId));
    expect(shown(null)).toBe("");
    expect(shown("basket")).toBe("42.5");
    expect(shown("gaylord")).toBe("60");
    expect(shown("skid")).toBe("");
    expect(shown("basket")).toBe("42.5");
  });

  it("shows the operator's own text once the box was typed in, whatever the type's default", () => {
    for (const typeDefault of [42.5, 60, 0, null]) expect(entryTareEach("61", typeDefault)).toBe("61");
  });

  it("keeps a cleared box cleared: an empty string is the operator's text, not a box never typed in", () => {
    for (const typeDefault of [42.5, 60, 0]) expect(entryTareEach("", typeDefault)).toBe("");
  });

  it("returns the operator's text as it was typed, not trimmed and not spelled again", () => {
    expect(entryTareEach(" 42.50 ", 60)).toBe(" 42.50 ");
    expect(entryTareEach("4.", 60)).toBe("4.");
    expect(entryTareEach("abc", 60)).toBe("abc");
  });
});

describe("the saved order's grid, when a row's type is changed", () => {
  const after = tareEachAfterTypeChange;

  describe("the box holds nothing (W4)", () => {
    it("takes the new type's default", () => {
      expect(after({ current: "", oldDefault: 42.5, newDefault: 60 })).toBe("60");
      expect(after({ current: "", oldDefault: 60, newDefault: 42.5 })).toBe("42.5");
      expect(after({ current: "", oldDefault: null, newDefault: 310 })).toBe("310");
    });

    it("takes a default of 0", () => {
      expect(after({ current: "", oldDefault: 42.5, newDefault: 0 })).toBe("0");
    });

    it("takes its own type's default, were the same type picked again (W4's own words)", () => {
      // A list reports nothing when the type it already shows is picked, so no screen asks this
      // today (the design's §9.9, point 4). The rule answers it all the same.
      expect(after({ current: "", oldDefault: 42.5, newDefault: 42.5 })).toBe("42.5");
    });

    it("reads a box of spaces as a box that holds nothing", () => {
      expect(after({ current: "   ", oldDefault: null, newDefault: 310 })).toBe("310");
    });

    it("is left alone when the new type has no default", () => {
      expect(after({ current: "", oldDefault: 42.5, newDefault: null })).toBeNull();
      expect(after({ current: "", oldDefault: null, newDefault: null })).toBeNull();
      expect(after({ current: "   ", oldDefault: 42.5, newDefault: null })).toBeNull();
    });
  });

  describe("the box holds a figure equal to the old type's default (W3)", () => {
    it("is replaced by the new type's default", () => {
      expect(after({ current: "42.5", oldDefault: 42.5, newDefault: 60 })).toBe("60");
      expect(after({ current: "310", oldDefault: 310, newDefault: 42.5 })).toBe("42.5");
    });

    it.each(["42.50", " 42.5 ", "042.5"])("compares amounts, not text: %j equals a default of 42.5", (current) => {
      expect(after({ current, oldDefault: 42.5, newDefault: 60 })).toBe("60");
    });

    it("is cleared when the new type has no default (the design's §9.9, point 3)", () => {
      expect(after({ current: "42.5", oldDefault: 42.5, newDefault: null })).toBe("");
    });

    it("treats a default of 0 as a default, on either side", () => {
      expect(after({ current: "0", oldDefault: 0, newDefault: 60 })).toBe("60");
      expect(after({ current: "0.00", oldDefault: 0, newDefault: 60 })).toBe("60");
      expect(after({ current: "42.5", oldDefault: 42.5, newDefault: 0 })).toBe("0");
    });
  });

  describe("the box holds any other figure, or the old type had no default (W3)", () => {
    it("leaves a figure that differs from the old type's default", () => {
      expect(after({ current: "44", oldDefault: 42.5, newDefault: 60 })).toBeNull();
      expect(after({ current: "44", oldDefault: 42.5, newDefault: null })).toBeNull();
    });

    it("leaves a figure one cent away from the old type's default", () => {
      expect(after({ current: "42.51", oldDefault: 42.5, newDefault: 60 })).toBeNull();
      expect(after({ current: "42.49", oldDefault: 42.5, newDefault: 60 })).toBeNull();
    });

    it("leaves every figure when the old type had no default, one equal to the new default included", () => {
      expect(after({ current: "44", oldDefault: null, newDefault: 60 })).toBeNull();
      expect(after({ current: "60", oldDefault: null, newDefault: 60 })).toBeNull();
      expect(after({ current: "0", oldDefault: null, newDefault: 60 })).toBeNull();
    });

    it("reads a zero at the end after the point as no digit (O2): 42.500 is the old default 42.5", () => {
      expect(after({ current: "42.500", oldDefault: 42.5, newDefault: 60 })).toBe("60");
    });

    it.each<[string, string, number]>([
      ["letters", "abc", 42.5],
      ["a partly typed figure", "42.", 42],
      ["a negative figure", "-42.5", 42.5],
      ["three decimals", "42.501", 42.5],
      ["an exponent", "1e2", 100],
    ])("leaves text that is not a tare each: %s", (_name, current, oldDefault) => {
      // Each is paired with the default a looser reading would call equal: Number("1e2") is 100.
      expect(after({ current, oldDefault, newDefault: 60 })).toBeNull();
    });

    it("leaves text that is not a tare each when the old type had no default: no figure equals no default", () => {
      expect(after({ current: "abc", oldDefault: null, newDefault: 60 })).toBeNull();
      expect(after({ current: "42.", oldDefault: null, newDefault: 60 })).toBeNull();
    });
  });

  describe("a type changed and changed back", () => {
    it("returns a row that followed its type to the text it started with", () => {
      const start = tareEachText(42.5);
      const there = retype(start, "basket", "gaylord");
      expect(there).toBe("60");
      expect(retype(there, "gaylord", "basket")).toBe(start);
    });

    it("does so through a type with no default", () => {
      const there = retype("42.5", "basket", "skid");
      expect(there).toBe("");
      expect(retype(there, "skid", "basket")).toBe("42.5");
    });

    it("does so through a row with no type picked", () => {
      const there = retype("310", "bin", "");
      expect(there).toBe("");
      expect(retype(there, "", "bin")).toBe("310");
    });

    it("leaves a typed figure where it was, both ways", () => {
      expect(retype("50", "basket", "gaylord")).toBe("50");
      expect(retype("50", "gaylord", "basket")).toBe("50");
      expect(retype("50", "skid", "basket")).toBe("50");
    });

    it("fills a blank box on the way: it stays blank only until a type is picked (W4; §9.9, point 4)", () => {
      const there = retype("", "basket", "gaylord");
      expect(there).toBe("60");
      expect(retype(there, "gaylord", "basket")).toBe("42.5");
    });

    it("replaces a typed figure that equals the default of the type it was moved to (W3)", () => {
      // 60 was typed on a basket row. Moved to gaylords, whose default is 60, the figure now equals
      // its type's default, and the rule cannot know who typed it. Moved back, it follows the type.
      const there = retype("60", "basket", "gaylord");
      expect(there).toBe("60");
      expect(retype(there, "gaylord", "basket")).toBe("42.5");
    });
  });
});
