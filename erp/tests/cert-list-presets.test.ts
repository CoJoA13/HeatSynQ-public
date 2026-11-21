// The certifications list's two presets and its Scope cell (spec 2026-10-30-ux-redesign-design.md
// §4.5; PR 5, owner 2026-10-31 on #820): Not printed and All certifications are two of the three
// states of the Printed select, derived from the filters the page holds, so choosing "Printed" by
// hand lights neither (review focus 3); the Scope cell holds the subject the row carries, falling
// back to the scope's label when it carries none (review focus 4).
import { describe, expect, it } from "vitest";
import { CERT_PRESETS, applyPreset, presetFor, scopeCell } from "@/lib/cert-list";

const base = { search: "x", customerId: "c1", scope: "LOAD" as const, printed: "" as const, includeVoided: true };

describe("certification presets", () => {
  it("names the two presets in order", () => {
    expect(CERT_PRESETS).toEqual([{ key: "notPrinted", label: "Not printed" }, { key: "all", label: "All certifications" }]);
  });

  it("applies each preset to the Printed select alone", () => {
    expect(applyPreset(base, "notPrinted")).toEqual({ ...base, printed: "0" });
    expect(applyPreset({ ...base, printed: "0" }, "all")).toEqual({ ...base, printed: "" });
    expect(applyPreset({ ...base, printed: "1" }, "all")).toEqual({ ...base, printed: "" });
  });

  it("names the preset the select equals, or none for Printed (review focus 3)", () => {
    expect(presetFor({ printed: "0" })).toBe("notPrinted");
    expect(presetFor({ printed: "" })).toBe("all");
    expect(presetFor({ printed: "1" })).toBeNull();
  });

  it("round-trips both presets", () => {
    for (const { key } of CERT_PRESETS) expect(presetFor(applyPreset(base, key))).toBe(key);
  });
});

describe("the Scope cell", () => {
  it("holds the subject, or the scope's label when the row carries none (review focus 4)", () => {
    expect(scopeCell({ scope: "ORDER", loadNumber: null, shipperNumber: null })).toBe("By order");
    expect(scopeCell({ scope: "LOAD", loadNumber: 3, shipperNumber: null })).toBe("Load 3");
    expect(scopeCell({ scope: "LOAD", loadNumber: null, shipperNumber: null })).toBe("By load");
    expect(scopeCell({ scope: "SHIPMENT", loadNumber: null, shipperNumber: 1042 })).toBe("Shipper #1042");
    expect(scopeCell({ scope: "SHIPMENT", loadNumber: null, shipperNumber: null })).toBe("By shipment");
    // A subject the scope does not own is never read.
    expect(scopeCell({ scope: "ORDER", loadNumber: 3, shipperNumber: 1042 })).toBe("By order");
  });
});
