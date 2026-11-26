// The quote page's free-text Material drop-down (#541; owner rulings 2026-10-15), decided in
// quote-form.ts's pure leaves so it can be proved without a renderer: the options and the
// select's value, what a pick writes, Switch to free text, and the form's round trip.
import { describe, expect, it } from "vitest";
import {
  BLANK_PART_DISPLAY, freeTextFromPart, lineFormsFrom, linesComparable, linesPayload, materialOptions, partDisplayFor, pickMaterial,
  TYPED_MATERIAL, UNAVAILABLE_MATERIAL, type LineForm, type QuoteDetailData, type QuoteLineData,
} from "../src/app/quotes/quote-form";

const materials = [
  { id: "m-4140", name: "4140", active: true },
  { id: "m-old", name: "1018", active: false },
  { id: "m-8620", name: "8620", active: true },
];

describe("materialOptions", () => {
  it("a line holding only typed text shows it first as `(typed)`, selected until a pick; inactive materials are not offered", () => {
    const { value, options } = materialOptions(materials, { materialId: null, materialText: "4140 annealed" });
    expect(value).toBe(TYPED_MATERIAL);
    expect(options).toEqual([
      { value: TYPED_MATERIAL, label: "4140 annealed (typed)" },
      { value: "", label: "— none —" },
      { value: "m-4140", label: "4140" },
      { value: "m-8620", label: "8620" },
    ]);
  });

  it("a line holding an inactive material keeps it, labelled `(inactive)`", () => {
    const { value, options } = materialOptions(materials, { materialId: "m-old", materialText: "" });
    expect(value).toBe("m-old");
    // By name, each digit run by value, the inactive one mixed in (#1056 ruling 6).
    expect(options.map((o) => o.label)).toEqual(["— none —", "1018 (inactive)", "4140", "8620"]);
  });

  it("a line holding a material the list does not hold shows `Unavailable selection`", () => {
    const { value, options } = materialOptions(materials, { materialId: "m-gone", materialText: "" });
    expect(value).toBe("m-gone");
    expect(options.at(-1)).toEqual({ value: "m-gone", label: UNAVAILABLE_MATERIAL });
    expect(options.filter((o) => o.value === "m-gone")).toHaveLength(1);
  });

  it("a line with no material selects `— none —`, and no typed option is offered", () => {
    const { value, options } = materialOptions(materials, { materialId: null, materialText: "" });
    expect(value).toBe("");
    expect(options.map((o) => o.value)).toEqual(["", "m-4140", "m-8620"]);
  });

  it("when the list failed to load, the current pick is named from the loaded detail", () => {
    expect(materialOptions(null, { materialId: "m-4140", materialText: "" }, "4140").options)
      .toEqual([{ value: "", label: "— none —" }, { value: "m-4140", label: "4140" }]);
    expect(materialOptions(null, { materialId: "m-4140", materialText: "" }).options.at(-1)?.label).toBe(UNAVAILABLE_MATERIAL);
    expect(materialOptions(null, { materialId: null, materialText: "1045" }).value).toBe(TYPED_MATERIAL);
  });
});

describe("pickMaterial", () => {
  it("a material sets the id and clears the typed text; `— none —` clears both; the typed option writes nothing", () => {
    expect(pickMaterial("m-4140")).toEqual({ materialId: "m-4140", materialText: "" });
    expect(pickMaterial("")).toEqual({ materialId: null, materialText: "" });
    expect(pickMaterial(TYPED_MATERIAL)).toBeNull();
  });
});

describe("freeTextFromPart (Switch to free text, ruling 5)", () => {
  it("carries the part's material id into the drop-down, with blank text", () => {
    expect(freeTextFromPart({ partNumber: "P-1", name: "Gear", materialId: "m-4140", eachWeight: "2.5" }))
      .toEqual({ partId: null, partNumberText: "P-1", partNameText: "Gear", materialId: "m-4140", materialText: "", eachWeight: "2.5" });
  });
  it("with no material id in hand, starts blank and never types the name (ruling 2, list only)", () => {
    expect(freeTextFromPart({ partNumber: "P-1", name: "Gear", materialId: null, eachWeight: "" }))
      .toMatchObject({ materialId: null, materialText: "" });
  });
});

function line(over: Partial<QuoteLineData>): QuoteLineData {
  return {
    id: "line", position: 1, partId: null, partNumber: "FT-1", partName: "", partDescription: "",
    material: "", materialId: null, materialText: "", partMaterialId: null, eachWeight: null, quotedQty: null, quotedUnlimited: false,
    linkedOrderCount: 0, linkedOrders: [], prices: [], ...over,
  };
}
function detail(lines: QuoteLineData[]): QuoteDetailData {
  return {
    id: "q", quoteNumber: 1, status: "OPEN", expired: false, customerId: "c", customerCode: "C", customerName: "C",
    contactId: null, contactName: "", quoteDate: "2026-10-15", effectiveDate: "2026-10-15", expiryDate: "2026-11-15",
    followUpDate: null, rfqNumber: "", quotedById: "u", quotedByName: "U", endingStatementId: null, endingStatementName: "",
    endingStatementText: "", closeReason: "", closedAt: null, closedByName: "", notes: "", internalNotes: "", deletedAt: null, lines,
  };
}

describe("Switch to free text without the parts catalog (ruling 5)", () => {
  const linked = line({ id: "linked", partId: "part-1", partNumber: "P-1", partName: "Gear", material: "4140", partMaterialId: "m-4140", eachWeight: 2.5 });

  it("the catalog lacking the part: the loaded line's part material id starts the drop-down on that pick", () => {
    const display = partDisplayFor("part-1", undefined, linked);
    const form = freeTextFromPart(display);
    expect(form).toMatchObject({ partId: null, materialId: "m-4140", materialText: "" });
    expect(materialOptions(materials, form).value).toBe("m-4140");
  });

  it("no id known at all (part without a material, or no loaded line): Material starts blank, never typed text", () => {
    for (const display of [
      partDisplayFor("part-1", undefined, { ...linked, partMaterialId: null }), // the name is on paper, no id known
      partDisplayFor("part-1", undefined, undefined),
    ]) {
      const form = freeTextFromPart(display);
      expect(form).toMatchObject({ materialId: null, materialText: "" });
      expect(materialOptions(materials, form).value).toBe("");
    }
  });

  it("the catalog row wins when it has the part", () => {
    const display = partDisplayFor("part-1", { partNumber: "P-9", name: "Cam", materialId: "m-8620", materialName: "8620", eachWeight: 1 }, linked);
    expect(display).toMatchObject({ partNumber: "P-9", materialId: "m-8620" });
  });

  it("a loaded line of a different part is not borrowed", () => {
    expect(partDisplayFor("part-2", undefined, linked)).toEqual(BLANK_PART_DISPLAY);
  });
});

describe("the form's material round trip", () => {
  it("reads the raw columns, never the resolved name, and sends them back unchanged (typed-only and picked)", () => {
    const d = detail([
      line({ id: "typed", position: 1, material: "1045", materialText: "1045" }),
      line({ id: "picked", position: 2, material: "4140", materialId: "m-4140", materialText: "" }),
      line({ id: "linked", position: 3, partId: "part-1", material: "8620", materialId: "m-8620", materialText: "dormant" }),
    ]);
    const forms = lineFormsFrom(d);
    expect(forms.map((l) => [l.materialId, l.materialText])).toEqual([[null, "1045"], ["m-4140", ""], [null, ""]]);
    const result = linesPayload(forms);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines.map((l) => [l.materialId, l.materialText])).toEqual([[null, "1045"], ["m-4140", ""], [null, ""]]);
  });

  it("a pick changes the tree; a recovered line without the key compares as no material", () => {
    const forms = lineFormsFrom(detail([line({ id: "typed", material: "1045", materialText: "1045" })]));
    const picked = forms.map((l) => ({ ...l, ...pickMaterial("m-4140") }));
    expect(linesComparable(picked)).not.toBe(linesComparable(forms));
    const result = linesPayload(picked);
    expect(result.ok && result.lines[0]).toMatchObject({ materialId: "m-4140", materialText: "" });
    const { materialId: _drop, ...older } = forms[0]; void _drop;
    expect(linesComparable([older as LineForm])).toBe(linesComparable(forms));
  });
});
