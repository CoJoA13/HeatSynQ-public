import { describe, expect, it } from "vitest";
import { templatePlacesLogo } from "@/lib/template-contracts/template-logo";
import { barcode, layoutOf, logo } from "./helpers/canvas-fixtures";

const LOGO_CONFIG = { placement: "header-left", width: 80 } as const;

describe("templatePlacesLogo", () => {
  it("is false for a null logo and a null layout", () => {
    expect(templatePlacesLogo({ logo: null, layout: null })).toBe(false);
  });
  it("is true for a logo config", () => {
    expect(templatePlacesLogo({ logo: LOGO_CONFIG, layout: null })).toBe(true);
  });
  it("is true for a canvas with a logo item and a null logo config", () => {
    expect(templatePlacesLogo({ logo: null, layout: layoutOf([barcode(), logo()]) })).toBe(true);
  });
  it("is false for a canvas with no logo item", () => {
    expect(templatePlacesLogo({ logo: null, layout: layoutOf([barcode()]) })).toBe(false);
  });
});
