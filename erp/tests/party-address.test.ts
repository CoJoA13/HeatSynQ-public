import { describe, it, expect } from "vitest";
import { billToLines, cityLine, pickDefaultAddress } from "@/server/party-address";

/**
 * #671, owner ruling R14 (2026-10-22): when a customer's default BILL_TO address row carries a
 * Name, every document stacks it above the customer's name, the quote's form. The rule is stated
 * once, in `src/server/party-address.ts`, and the five documents and the traveler's received-from
 * pick read it. Pure: no database.
 */

const row = (over: Partial<{ kind: string; isDefault: boolean; name: string; street: string; city: string; state: string; zip: string }> = {}) => ({
  kind: "BILL_TO", isDefault: false, name: "", street: "300 Example Way", city: "Anniston", state: "AL", zip: "36201",
  ...over,
});

describe("pickDefaultAddress", () => {
  it("takes the default row of the kind over an earlier non-default one", () => {
    const first = row({ name: "AAA Not Default" }), dflt = row({ isDefault: true, name: "Accounts payable" });
    expect(pickDefaultAddress([first, dflt], "BILL_TO")).toBe(dflt);
  });

  it("takes the first row of the kind when none is the default", () => {
    const first = row({ name: "First" }), second = row({ name: "Second" });
    expect(pickDefaultAddress([first, second], "BILL_TO")).toBe(first);
  });

  it("answers null when the kind has no row, whatever the other kinds hold", () => {
    expect(pickDefaultAddress([row({ kind: "SHIP_TO", isDefault: true })], "BILL_TO")).toBeNull();
    const none: ReturnType<typeof row>[] = [];
    expect(pickDefaultAddress(none, "BILL_TO")).toBeNull();
  });

  it("never crosses kinds: a SHIP_TO default is not a BILL_TO answer", () => {
    const ship = row({ kind: "SHIP_TO", isDefault: true }), bill = row({ kind: "BILL_TO" });
    expect(pickDefaultAddress([ship, bill], "BILL_TO")).toBe(bill);
    expect(pickDefaultAddress([ship, bill], "SHIP_TO")).toBe(ship);
  });
});

describe("cityLine", () => {
  it("is 'city, ST zip', dropping what is blank", () => {
    expect(cityLine(row())).toBe("Anniston, AL 36201");
    expect(cityLine(row({ zip: "" }))).toBe("Anniston, AL");
    expect(cityLine(row({ city: "" }))).toBe("AL 36201");
    expect(cityLine(row({ city: "", state: "", zip: "" }))).toBe("");
  });
});

describe("billToLines (R14)", () => {
  it("stacks the row's name above the customer's, then the street and the city line", () => {
    expect(billToLines("Titan Tool & Die", row({ name: "Accounts payable" })))
      .toEqual(["Accounts payable", "Titan Tool & Die", "300 Example Way", "Anniston, AL 36201"]);
  });

  it("prints the customer's name alone when the row has no name", () => {
    expect(billToLines("Titan Tool & Die", row()))
      .toEqual(["Titan Tool & Die", "300 Example Way", "Anniston, AL 36201"]);
  });

  it("does not stack a row name equal to the customer's (the quote's de-duplication)", () => {
    expect(billToLines("Titan Tool & Die", row({ name: "Titan Tool & Die" })))
      .toEqual(["Titan Tool & Die", "300 Example Way", "Anniston, AL 36201"]);
  });

  it("with no row at all, the customer's name is the whole block", () => {
    expect(billToLines("Titan Tool & Die", null)).toEqual(["Titan Tool & Die"]);
  });

  it("drops blank lines, never printing an empty one", () => {
    expect(billToLines("Titan Tool & Die", row({ name: "AP", street: "", city: "", state: "", zip: "" })))
      .toEqual(["AP", "Titan Tool & Die"]);
  });
});
