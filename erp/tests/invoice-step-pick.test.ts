import { describe, expect, it } from "vitest";
import {
  matchingSuggestions, offersStepSuggestions, pickPatch, suggestionLabel, suggestionsFor, typedPatch,
} from "../src/lib/invoice-step-pick";
import type { InvoiceStepSuggestions, StepSuggestion } from "../src/lib/invoice-step-suggestions";

// #587 T5: the pure half of an invoice operation line's description box (Amendments 15, 16, 22, 23).
// The box itself (StepWordsBox.tsx) only draws the list and reports a keystroke or a pick; what a
// keystroke or a pick writes onto the row, which suggestions a row offers and in what order, what
// typed text keeps, and which invoices ask for the list at all are decided here, where vitest can
// run them without a component renderer.

const ageHarden: StepSuggestion = { id: "code-ah", code: "AH", name: "Age Harden" };
const temper: StepSuggestion = { id: "code-temp", code: "TEMP", name: "Temper" };
const anneal: StepSuggestion = { id: "code-ann", code: "ANN", name: "Anneal" };
const nitride: StepSuggestion = { id: "code-nit", code: "NIT", name: "Gas Nitride" };
// A step the line's revision lists whose code is now inactive: it is in the line's own list only.
const retired: StepSuggestion = { id: "code-old", code: "OLD", name: "Old Quench" };

const data: InvoiceStepSuggestions = {
  // The line's steps in step order, which is not code order (TEMP before AH).
  byOrderLine: { "ol-1": [temper, retired, ageHarden], "ol-2": [] },
  // Every live active code, ordered by code, the line's own included (the route says so).
  others: [ageHarden, anneal, nitride, temper],
};

describe("pickPatch: what a pick writes onto the row (Amendment 16)", () => {
  it("on a row with no price row (a Needs price line): the words, the step code, a cleared GL account, the mark", () => {
    expect(pickPatch({ pricePer: "" }, ageHarden)).toEqual({
      description: "Age Harden", processStepCodeId: "code-ah", glAccountId: "", glAccountName: "", wordsChosen: "true",
    });
  });
  it("on a priced row: the words and the mark only, never its step code or its GL account", () => {
    expect(pickPatch({ pricePer: "POUND" }, ageHarden)).toEqual({ description: "Age Harden", wordsChosen: "true" });
    expect(pickPatch({ pricePer: "EACH" }, temper)).toEqual({ description: "Temper", wordsChosen: "true" });
  });
  it("writes the name the list shows, never the code", () => {
    expect(pickPatch({ pricePer: "" }, nitride).description).toBe("Gas Nitride");
  });
  // #587 fix wave (F5): on a priced row, a pick of the saved line's own words is no choice, so it
  // takes the saved line's mark and the grid's overlay drops both fields; any other name marks.
  it("on a priced row, a pick of the saved line's own words takes the saved line's mark", () => {
    expect(pickPatch({ pricePer: "EACH" }, ageHarden, { description: "Age Harden", wordsChosen: false }))
      .toEqual({ description: "Age Harden", wordsChosen: "false" });
    expect(pickPatch({ pricePer: "EACH" }, ageHarden, { description: "Age Harden", wordsChosen: true }))
      .toEqual({ description: "Age Harden", wordsChosen: "true" });
    expect(pickPatch({ pricePer: "EACH" }, ageHarden, { description: "Op A", wordsChosen: false }))
      .toEqual({ description: "Age Harden", wordsChosen: "true" });
  });
  it("on a Needs price row, a pick always marks: it sets the step code too", () => {
    expect(pickPatch({ pricePer: "" }, ageHarden, { description: "Age Harden", wordsChosen: false })).toEqual({
      description: "Age Harden", processStepCodeId: "code-ah", glAccountId: "", glAccountName: "", wordsChosen: "true",
    });
  });
});

describe("typedPatch: a keystroke in the box writes the text and the mark", () => {
  it("marks the words chosen", () => {
    expect(typedPatch("Age harden, special")).toEqual({ description: "Age harden, special", wordsChosen: "true" });
  });
  it("keeps the text exactly as typed, an emptied box included", () => {
    expect(typedPatch("  Temper  ")).toEqual({ description: "  Temper  ", wordsChosen: "true" });
    expect(typedPatch("")).toEqual({ description: "", wordsChosen: "true" });
  });
  // #587 fix wave (F5): words typed back to the saved line's own take its own mark, so a row typed
  // away and back holds no hidden mark that would have Recalculate keep the saved words.
  it("marks words that differ from the saved line's", () => {
    expect(typedPatch("Needs price, rush", { description: "Needs price", wordsChosen: false }))
      .toEqual({ description: "Needs price, rush", wordsChosen: "true" });
    // Exactly the saved words, never a trimmed or case-folded match.
    expect(typedPatch("needs price", { description: "Needs price", wordsChosen: false }))
      .toEqual({ description: "needs price", wordsChosen: "true" });
  });
  it("takes the saved line's mark for its own words typed back: false where it was not chosen", () => {
    expect(typedPatch("Needs price", { description: "Needs price", wordsChosen: false }))
      .toEqual({ description: "Needs price", wordsChosen: "false" });
  });
  it("takes the saved line's mark for its own words typed back: true where it was chosen", () => {
    expect(typedPatch("Age Harden", { description: "Age Harden", wordsChosen: true }))
      .toEqual({ description: "Age Harden", wordsChosen: "true" });
  });
});

describe("suggestionsFor: the line's steps first, then every other step code (Amendments 13, 22)", () => {
  it("lists the line's own steps in their order, then the others less the line's own, in theirs", () => {
    expect(suggestionsFor("ol-1", data)).toEqual([temper, retired, ageHarden, anneal, nitride]);
  });
  it("lists every code for a line with no steps, and for a line the answer does not name", () => {
    expect(suggestionsFor("ol-2", data)).toEqual(data.others);
    expect(suggestionsFor("ol-unknown", data)).toEqual(data.others);
    expect(suggestionsFor("", data)).toEqual(data.others);
  });
  it("never reads a line id off the object's prototype", () => {
    expect(suggestionsFor("constructor", data)).toEqual(data.others);
    expect(suggestionsFor("__proto__", data)).toEqual(data.others);
  });
  it("lists nothing while there is no answer (not read yet, or the read failed)", () => {
    expect(suggestionsFor("ol-1", null)).toEqual([]);
  });
});

describe("matchingSuggestions: what typed text keeps", () => {
  const list = suggestionsFor("ol-1", data);
  it("keeps the whole list, in its order, while nothing has been typed since the list opened", () => {
    expect(matchingSuggestions(list, null)).toEqual(list);
  });
  it("keeps the whole list for blank text", () => {
    expect(matchingSuggestions(list, "")).toEqual(list);
    expect(matchingSuggestions(list, "   ")).toEqual(list);
  });
  it("matches the code or the name anywhere, ignoring case and the text's edge spaces", () => {
    expect(matchingSuggestions(list, "ah")).toEqual([ageHarden]);
    expect(matchingSuggestions(list, " TEM ")).toEqual([temper]);
    expect(matchingSuggestions(list, "nitr")).toEqual([nitride]);
    expect(matchingSuggestions(list, "en")).toEqual([retired, ageHarden]);
  });
  it("matches across the code and the name as the option reads them", () => {
    expect(matchingSuggestions(list, "ah — age")).toEqual([ageHarden]);
  });
  it("keeps the line's own steps first, never re-sorting what matches", () => {
    // Every one of these holds an "e"; AH sorts before TEMP by code, and the line lists TEMP first.
    expect(matchingSuggestions(list, "e")).toEqual([temper, retired, ageHarden, anneal, nitride]);
  });
  it("keeps nothing when nothing matches, so the list closes and the text stands", () => {
    expect(matchingSuggestions(list, "Needs price")).toEqual([]);
  });
});

describe("suggestionLabel: an option reads `CODE — Name` (Amendment 23)", () => {
  it("joins the code and the name with an em dash", () => {
    expect(suggestionLabel(ageHarden)).toBe("AH — Age Harden");
  });
});

describe("offersStepSuggestions: only a draft invoice asks for the list (587-12, Amendment 22)", () => {
  it("asks for a live draft invoice", () => {
    expect(offersStepSuggestions({ kind: "INVOICE", status: "DRAFT", deletedAt: null })).toBe(true);
  });
  it("never for a credit memo, a finalized invoice or a discarded draft", () => {
    expect(offersStepSuggestions({ kind: "CREDIT", status: "DRAFT", deletedAt: null })).toBe(false);
    expect(offersStepSuggestions({ kind: "INVOICE", status: "FINALIZED", deletedAt: null })).toBe(false);
    expect(offersStepSuggestions({ kind: "INVOICE", status: "DRAFT", deletedAt: "2026-10-21T10:00:00.000Z" })).toBe(false);
  });
});
