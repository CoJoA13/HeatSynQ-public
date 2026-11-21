import { describe, expect, it } from "vitest";
import { pickListKind } from "@/lib/reference-constants";
import { inlineDecimalSave, inlineNameSave, inlineTextSave, rowsWithStoredFigure } from "@/lib/reference-inline-edit";

// What leaving the edit box of an existing pick-list row sends (the weights design §9.4, "Pick
// lists"). The box has no button: it saves when it is left and when Enter is pressed, so this
// leaf is what keeps a box nobody changed from writing a history entry. `stored` is the figure as
// the admin read gives it: a decimal as text ("42.5"), or null. Whether a figure is ALLOWED is the
// server's to say (tests/reference-tables.test.ts); nothing here refuses one. And
// `rowsWithStoredFigure`, the table's rows once the server has answered a save 2xx: that row holds
// the figure sent, which the box then compares against (#495 item 2).

const NOTHING = { send: false };
const sends = (value: string | null) => ({ send: true, value });

describe("inlineDecimalSave", () => {
  it.each<[string, unknown]>([["null", null], ["undefined", undefined]])(
    "a blank box over nothing stored (%s) sends nothing", (_name, stored) => {
      expect(inlineDecimalSave(stored, "")).toEqual(NOTHING);
      expect(inlineDecimalSave(stored, "   ")).toEqual(NOTHING);
    });

  it.each<[string, unknown]>([
    ["a decimal as text", "42.5"], ["a number", 42.5], ["a whole figure", "310"],
  ])("a blank box over a stored figure (%s) sends null, which clears it", (_name, stored) => {
    expect(inlineDecimalSave(stored, "")).toEqual(sends(null));
    expect(inlineDecimalSave(stored, "   ")).toEqual(sends(null));
  });

  it("a stored 0 is a figure: a blank box clears it", () => {
    expect(inlineDecimalSave("0", "")).toEqual(sends(null));
    expect(inlineDecimalSave(0, "")).toEqual(sends(null));
  });

  it.each<[unknown, string]>([
    ["42.5", "42.5"], ["42.5", "42.50"], ["42.5", "042.5"], [42.5, "42.50"],
    ["310", "310.00"], ["0", "0.00"], [0, "0"], ["0", "-0"],
  ])("the stored figure %j typed as %j sends nothing", (stored, typed) => {
    expect(inlineDecimalSave(stored, typed)).toEqual(NOTHING);
  });

  it.each<[unknown, string]>([
    ["42.5", "60"], ["42.5", "42.51"], ["42.5", "42.505"], [null, "42.50"], [undefined, "310"],
  ])("a different figure is sent as typed: %j, then %j", (stored, typed) => {
    expect(inlineDecimalSave(stored, typed)).toEqual(sends(typed));
  });

  it("a typed 0 over nothing stored is a figure, not a blank", () => {
    expect(inlineDecimalSave(null, "0")).toEqual(sends("0"));
  });

  it("reads and sends the text without the spaces around it", () => {
    expect(inlineDecimalSave("42.5", " 42.50 ")).toEqual(NOTHING);
    expect(inlineDecimalSave("42.5", "  60 ")).toEqual(sends("60"));
  });

  it.each(["abc", "-", "42,50", "4 2", "-5"])(
    "text that does not read as the stored figure is sent as typed, so the server says why: %j", (typed) => {
      expect(inlineDecimalSave("42.5", typed)).toEqual(sends(typed));
      expect(inlineDecimalSave(null, typed)).toEqual(sends(typed));
    });

  it.each([["42.", "42"], [".5", "0.5"], ["-.5", "-0.5"]])("%j over %j sends nothing", (typed, stored) => {
    expect(inlineDecimalSave(stored, typed)).toEqual(NOTHING);
  });

  it.each([["4.", "42.5", "4."], [".5", "42.5", ".5"], ["42.", null, "42."]])(
    "%j over %j is a figure that differs, so it is sent as typed", (typed, stored, sent) => {
      expect(inlineDecimalSave(stored, typed)).toEqual(sends(sent));
    });

  it("text that is no figure is still sent for the server to refuse", () => {
    expect(inlineDecimalSave("42.5", "1e2")).toEqual(sends("1e2"));
  });

  it("only a plain decimal reads as the stored figure: an exponent or a hex spelling of it is sent", () => {
    expect(inlineDecimalSave("42.5", "4.25e1")).toEqual(sends("4.25e1"));
    expect(inlineDecimalSave("42", "0x2A")).toEqual(sends("0x2A"));
  });
});

describe("rowsWithStoredFigure", () => {
  // Fresh rows for each case, so a case that changed them could not hide it from the next.
  const baskets = () => [
    { id: "ct-1", name: "Steel Basket", active: true, tareEach: "42.5" },
    { id: "ct-2", name: "Wire Basket", active: true, tareEach: null as string | null },
    { id: "ct-3", name: "Tote", active: false, tareEach: "3" },
  ];

  it("puts the figure into the row with that id, and hands every other row back as it was", () => {
    const rows = baskets();
    const next = rowsWithStoredFigure(rows, "ct-2", "tareEach", "60");
    expect(next).toEqual([baskets()[0], { ...baskets()[1], tareEach: "60" }, baskets()[2]]);
    expect(next[0]).toBe(rows[0]);
    expect(next[2]).toBe(rows[2]);
  });

  it("keeps a cleared figure as null", () => {
    expect(rowsWithStoredFigure(baskets(), "ct-1", "tareEach", null)[0]).toEqual({ ...baskets()[0], tareEach: null });
  });

  it("with no row of that id, the rows are the same", () => {
    const rows = baskets();
    const next = rowsWithStoredFigure(rows, "ct-9", "tareEach", "60");
    expect(next).toEqual(baskets());
    next.forEach((row, i) => expect(row).toBe(rows[i]));
  });

  it("changes neither the rows it is handed nor any row in them", () => {
    const rows = baskets();
    const before = structuredClone(rows);
    rowsWithStoredFigure(rows, "ct-1", "tareEach", "60");
    expect(rows).toEqual(before);
  });
});

describe("pickListKind: the list a link names (#708)", () => {
  it("reads a kind the screen has", () => {
    expect(pickListKind("paymentType")).toBe("paymentType");
    expect(pickListKind("glAccount")).toBe("glAccount");
  });
  it.each<[string | null]>([[null], [""], ["nonsense"], ["__proto__"], ["GLACCOUNT"]])(
    "%j names no list, so the screen keeps its default", (query) => {
      expect(pickListKind(query)).toBeNull();
    });
});

describe("inlineNameSave: an existing row's Name", () => {
  it("sends a new name, without the spaces around it, as the server stores it", () => {
    expect(inlineNameSave("Steel Basket", " Wire Basket ")).toEqual({ send: true, value: "Wire Basket" });
  });
  it("sends nothing for the stored name, however it is spaced", () => {
    expect(inlineNameSave("Steel Basket", "  Steel Basket ")).toEqual({ send: false });
  });
  it("sends nothing for a blank box: a row keeps a name, and the box takes it back", () => {
    expect(inlineNameSave("Steel Basket", "   ")).toEqual({ send: false });
  });
});

describe("inlineTextSave: an existing row's text column", () => {
  it("sends what was typed as typed: free text keeps its spaces and line breaks", () => {
    expect(inlineTextSave("Old", " two\nlines ")).toEqual({ send: true, value: " two\nlines " });
  });
  it("a cleared box is a value: it sends the empty text", () => {
    expect(inlineTextSave("Old", "")).toEqual({ send: true, value: "" });
  });
  it("sends nothing for the stored text, and nothing for a blank box over no text", () => {
    expect(inlineTextSave("Old", "Old")).toEqual({ send: false });
    expect(inlineTextSave(null, "")).toEqual({ send: false });
    expect(inlineTextSave(undefined, "")).toEqual({ send: false });
  });
});

describe("rowsWithStoredFigure: a whole number", () => {
  it("holds the number sent", () => {
    expect(rowsWithStoredFigure([{ id: "t", netDays: 30 }], "t", "netDays", 45)).toEqual([{ id: "t", netDays: 45 }]);
  });
});
