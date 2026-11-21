// The shipping list's two presets (spec 2026-10-30-ux-redesign-design.md §4.5; PR 4, owner
// 2026-10-31): Shipments and Shipment history are the two states of the Include voided box,
// derived from the filters the page holds, so a hand tick of the box lights Shipment history and
// an un-tick lights Shipments; every other filter narrows within a preset.
import { describe, expect, it } from "vitest";
import { SHIPPING_PRESETS, applyPreset, presetFor } from "@/lib/shipping-presets";

const base = { search: "x", customerId: "c1", from: "2026-10-01", to: "", includeVoided: false };

describe("shipping presets", () => {
  it("names the two presets in order", () => {
    expect(SHIPPING_PRESETS).toEqual([{ key: "shipments", label: "Shipments" }, { key: "history", label: "Shipment history" }]);
  });

  it("applies each preset to the Include voided box alone", () => {
    expect(applyPreset(base, "history")).toEqual({ ...base, includeVoided: true });
    expect(applyPreset({ ...base, includeVoided: true }, "shipments")).toEqual({ ...base, includeVoided: false });
  });

  it("names the preset the box equals, always one of the two (review focus 4)", () => {
    expect(presetFor(base)).toBe("shipments");
    expect(presetFor({ ...base, includeVoided: true })).toBe("history");
    expect(presetFor({ ...base, includeVoided: true, search: "", customerId: "" })).toBe("history");
  });

  it("round-trips both presets", () => {
    for (const { key } of SHIPPING_PRESETS) expect(presetFor(applyPreset(base, key))).toBe(key);
  });
});
