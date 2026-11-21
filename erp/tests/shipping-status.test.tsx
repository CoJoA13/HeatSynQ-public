import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ShippingStatus } from "@/app/shipping/ShippingList";

// Exercise rendered operator text. The reverse-shipment browser flow verifies this cell is
// wired to the API's live reversal relationships in the real shipping table.
function render(over: Partial<{ deletedAt: string; reversesShipperNumber: number; reversedByShipperNumber: number }> = {}) {
  const row = { deletedAt: null, reversesShipperNumber: null, reversedByShipperNumber: null, ...over };
  return renderToStaticMarkup(<ShippingStatus {...row} />).replace(/<[^>]+>/g, "");
}

describe("shipping list status (#232)", () => {
  it("uses a neutral placeholder for a normal shipment", () => {
    expect(render()).toBe("—");
  });

  it("names the original on a reversal", () => {
    expect(render({ reversesShipperNumber: 1015 })).toBe("Reversal of 1015");
  });

  it("names the live reversal on an original", () => {
    expect(render({ reversedByShipperNumber: 1027 })).toBe("Reversed by 1027");
  });

  it("keeps the voided label on an ordinary withdrawn shipment", () => {
    expect(render({ deletedAt: "2026-09-08T12:00:00.000Z" })).toBe("voided");
  });

  it("keeps both the void and the reversal's original document identity", () => {
    const text = render({ deletedAt: "2026-09-08T12:00:00.000Z", reversesShipperNumber: 1015 });
    expect(text).toContain("voided");
    expect(text).toContain("Reversal of 1015");
    expect(text).not.toContain("—");
  });
});
