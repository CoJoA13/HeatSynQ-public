import { describe, it, expect } from "vitest";
import { oneLineAddress } from "@/lib/line-break";

// The bill of lading's Ship-from sentence prints the Company address on one line (owner ruling R2,
// 2026-11-24, design docs/superpowers/specs/2026-11-24-bol-captions-ship-from-design.md).
describe("oneLineAddress", () => {
  it("joins the address's lines with a comma and a space", () => {
    expect(oneLineAddress("1450 Furnace Road\nCleveland, OH 44101")).toBe("1450 Furnace Road, Cleveland, OH 44101");
  });

  it("adds no second comma after a line that already ends in one", () => {
    expect(oneLineAddress("A St,\nTown")).toBe("A St, Town");
  });

  it("reads a CR LF pair, a blank line and the spaces around a break as one break, and trims the ends", () => {
    expect(oneLineAddress("A St\r\n\r\nTown  ")).toBe("A St, Town");
    expect(oneLineAddress("A St     Town")).toBe("A St, Town");
    expect(oneLineAddress("\nA St\u0085Town\n")).toBe("A St, Town");
  });

  it("leaves an address with no line break as it is, double spaces included", () => {
    expect(oneLineAddress("100 Example Way  Anniston  AL  36207")).toBe("100 Example Way  Anniston  AL  36207");
  });
});
