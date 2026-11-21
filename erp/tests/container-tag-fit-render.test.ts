import { describe, it, expect } from "vitest";
import { buildContainerTags, type ContainerTagData } from "@/server/pdf/container-tags";
import { DEFAULT_CONFIG, assertTagFits } from "@/lib/template-contracts/container-tag";
import type { TemplateConfig } from "@/lib/template-contracts/types";
import { renderPdf } from "@/server/pdf/render";
import { pageCount } from "./helpers/pdf";

// Container tag PR 1, final review I2: R11 promises one tag is one label. These cases count the
// pages of the RENDERED pdf (never a definition), at the tallest tag the flow can print (the parts
// at their cap, seven parts) and two tags, so a spill onto a second page shows as a third page.

const tag = (orderNumber: string): ContainerTagData => ({
  orderNumber, customer: "Acme Steel Inc", poNumber: "4500123", containersTotal: "5",
  received: "10/23/2026, 9:02 AM", parts: Array.from({ length: 7 }, (_, i) => `PART-${i + 1} × 10`),
});
const withFonts = (patch: Partial<TemplateConfig["fonts"]>): TemplateConfig => ({
  ...structuredClone(DEFAULT_CONFIG), fonts: { ...DEFAULT_CONFIG.fonts, ...patch },
});
const pagesOf = async (config: TemplateConfig) =>
  pageCount(await renderPdf(buildContainerTags([tag("1234567"), tag("7654321")], config)));
const fits = (c: TemplateConfig) => { try { assertTagFits(c); return true; } catch { return false; } };

/** The largest base size, in 0.5 pt steps, R10 and R11 accept at heading 20. */
function largestAccepted(family: TemplateConfig["fonts"]["family"]): number {
  let best = 0;
  for (let base = 4; base <= 20; base += 0.5) if (fits(withFonts({ family, baseSize: base, headingSize: 20 }))) best = base;
  return best;
}

describe("R11's fit rule against rendered paper", () => {
  it("the Standard in Roboto Mono prints 2 tags on exactly 2 pages", async () => {
    const config = withFonts({ family: "Roboto Mono" });
    expect(fits(config)).toBe(true);
    expect(await pagesOf(config)).toBe(2);
  });
  it("Roboto, and the largest base size R11 accepts at heading 20, still print on 2 pages", async () => {
    const roboto = withFonts({ family: "Roboto" });
    expect(await pagesOf(roboto)).toBe(2);
    for (const family of ["Roboto", "Roboto Mono"] as const) {
      const base = largestAccepted(family);
      expect(base, family).toBeGreaterThan(0);
      expect(fits(withFonts({ family, baseSize: base + 0.5, headingSize: 20 })), `${family} ${base + 0.5}`).toBe(false);
      expect(await pagesOf(withFonts({ family, baseSize: base, headingSize: 20 })), `${family} ${base}`).toBe(2);
    }
  });
  it("a config R11 refuses, built past the validator, spills onto more than 2 pages", async () => {
    const config = withFonts({ family: "Roboto Mono", baseSize: 12 });
    expect(() => assertTagFits(config)).toThrow(/text sizes do not fit/);
    expect(await pagesOf(config)).toBeGreaterThan(2);
  });
});
