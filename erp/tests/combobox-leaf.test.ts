import { describe, expect, it } from "vitest";
import { enterPick, filterOptions, listPlacement, openHighlight, pickAction, stepHighlight, type ComboboxOption } from "@/lib/combobox";

const options: ComboboxOption[] = [
  { value: "", label: "All customers" },
  { value: "c1", label: "ACM01 · Acme Steel" },
  { value: "c2", label: "BOL · Bolt Works" },
  { value: "c3", label: "ZED · Zed Forge", disabled: true, disabledReason: "Inactive" },
];

describe("filterOptions", () => {
  it("lists every option, in the order given, while nothing is typed", () => {
    expect(filterOptions(options, "")).toEqual(options);
    expect(filterOptions(options, "   ")).toEqual(options);
  });

  it("keeps the options whose label holds the typed text anywhere, ignoring case (a name finds its customer)", () => {
    expect(filterOptions(options, "acme").map((o) => o.value)).toEqual(["c1"]);
    expect(filterOptions(options, "  WORKS ").map((o) => o.value)).toEqual(["c2"]);
    expect(filterOptions(options, "o").map((o) => o.value)).toEqual(["", "c2", "c3"]);
  });
});

describe("openHighlight", () => {
  it("starts on the current value, so Enter on a freshly opened list re-picks it rather than the top row", () => {
    expect(openHighlight(options, "c2")).toBe(2);
    expect(openHighlight(options, "")).toBe(0);
  });

  it("highlights no row while the value is not listed (the list not read yet, or no pick made), so Enter saves nothing", () => {
    expect(openHighlight(options, null)).toBe(-1);
    expect(openHighlight(options, "gone")).toBe(-1);
    expect(openHighlight([], "")).toBe(-1);
    expect(openHighlight(options.slice(1), "")).toBe(-1);
  });
});

describe("stepHighlight", () => {
  it("moves one row and stops at either end", () => {
    expect(stepHighlight(1, 1, 4)).toBe(2);
    expect(stepHighlight(3, 1, 4)).toBe(3);
    expect(stepHighlight(1, -1, 4)).toBe(0);
    expect(stepHighlight(0, -1, 4)).toBe(0);
  });

  it("goes to the first row from no row, either way, and to none in an empty list", () => {
    expect(stepHighlight(-1, 1, 4)).toBe(0);
    expect(stepHighlight(-1, -1, 4)).toBe(0);
    expect(stepHighlight(-1, 1, 0)).toBe(-1);
  });
});

describe("enterPick", () => {
  it("picks the highlighted row of the list on screen", () => {
    expect(enterPick(true, options, 2)).toBe(options[2]);
  });

  it("picks nothing while the list is closed, so a second Enter after a pick cannot save a row no one sees (Codex on #1062)", () => {
    // After a filtered pick the list closes with the highlight still on row 0 of the unfiltered
    // options, which is the blank on a save-on-change menu.
    expect(enterPick(false, options, 0)).toBeNull();
  });

  it("picks nothing with no row highlighted", () => {
    expect(enterPick(true, options, -1)).toBeNull();
    expect(enterPick(true, [], 0)).toBeNull();
  });
});

describe("pickAction", () => {
  it("commits a different, enabled option", () => {
    expect(pickAction(options[2], "c1")).toBe("commit");
    expect(pickAction(options[1], null)).toBe("commit");
  });

  it("only closes the list on a pick of the value already held, so a save-on-change menu sends nothing", () => {
    expect(pickAction(options[0], "")).toBe("close");
    expect(pickAction(options[1], "c1")).toBe("close");
  });

  it("ignores a disabled option", () => {
    expect(pickAction(options[3], "c1")).toBe("ignore");
  });
});

describe("listPlacement", () => {
  const box = { top: 100, bottom: 130, left: 40, width: 220 };

  it("opens below the box, its width, when the list fits there", () => {
    expect(listPlacement(box, 900)).toEqual({ left: 40, width: 220, top: 134, maxHeight: 224 });
  });

  it("opens above when the room below is short and the room above is larger", () => {
    const low = { top: 800, bottom: 830, left: 40, width: 220 };
    expect(listPlacement(low, 900)).toEqual({ left: 40, width: 220, bottom: 104, maxHeight: 224 });
  });

  it("shrinks to the room it has, never below a few rows", () => {
    const low = { top: 160, bottom: 190, left: 0, width: 100 };
    expect(listPlacement(low, 300)).toEqual({ left: 0, width: 100, bottom: 144, maxHeight: 156 });
    expect(listPlacement({ top: 10, bottom: 40, left: 0, width: 100 }, 60)).toEqual({ left: 0, width: 100, top: 44, maxHeight: 96 });
  });
});
