import { describe, expect, it } from "vitest";
import { addSuggestionRefusal, suggestionNameKey } from "@/lib/suggestion-names";

// #406: what makes two suggested-parameter names the same, and why the Add row refuses one. The
// server's save asks `suggestionNameKey` too (`tests/process-step-codes.test.ts`).
describe("suggestionNameKey", () => {
  it("ignores surrounding spaces and letter case", () => {
    for (const label of ["Soak", " Soak", "Soak  ", "soak", "SOAK", "\tsOAk "]) {
      expect(suggestionNameKey(label), JSON.stringify(label)).toBe("soak");
    }
  });

  it("keeps inner spacing: two names that differ there are two names", () => {
    expect(suggestionNameKey("Soak time")).not.toBe(suggestionNameKey("Soak  time"));
    expect(suggestionNameKey("Soaktime")).not.toBe(suggestionNameKey("Soak time"));
  });
});

describe("addSuggestionRefusal", () => {
  const names = ["Soak time", "Hold"];

  it("asks for a name while it is empty or only whitespace", () => {
    for (const label of ["", " ", " \t "]) {
      expect(addSuggestionRefusal(label, names), JSON.stringify(label)).toBe("Enter a parameter name");
      expect(addSuggestionRefusal(label, []), JSON.stringify(label)).toBe("Enter a parameter name");
    }
  });

  it("refuses a name the code already has, naming the existing suggestion as it is saved", () => {
    for (const label of ["Hold", "hold", " HOLD ", "Hold "]) {
      expect(addSuggestionRefusal(label, names), JSON.stringify(label)).toBe('A suggested parameter named "Hold" already exists');
    }
    expect(addSuggestionRefusal("soak TIME", names)).toBe('A suggested parameter named "Soak time" already exists');
  });

  it("reads a saved name the way the server does, padded or blank ones (storable until #406) included", () => {
    expect(addSuggestionRefusal("soak", [" Soak "])).toBe('A suggested parameter named " Soak " already exists');
    expect(addSuggestionRefusal(" ", [" ", "Hold"])).toBe("Enter a parameter name");
  });

  it("lets a new name through, one that differs only by inner spacing included", () => {
    for (const label of ["Quench", " Quench ", "Soak  time", "Holding"]) {
      expect(addSuggestionRefusal(label, names), JSON.stringify(label)).toBeUndefined();
    }
    expect(addSuggestionRefusal("Hold", [])).toBeUndefined();
  });
});
