import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RAIL_INSET_VAR, RAIL_MAX_HEIGHT, railInset } from "@/lib/rail-fit";

// The rail wrapper's height rule (src/lib/rail-fit.ts), pulled into a pure client-safe leaf so it
// can be pinned without a DOM test environment (the nav.ts precedent). The root layout stacks the
// practice, setup, default-password and backup banners ABOVE <Shell>; a sticky wrapper sized to the
// bare viewport ran past a short window's bottom by exactly their height, so the last entries were
// clipped until the page had scrolled. e2e/lib/rail.mjs proves the fit on the real Shell; this
// pins the arithmetic and that Shell.tsx applies it.

describe("railInset (how far the rail's column sits below the window's top)", () => {
  it("is the banners' height while the page is at the top", () => {
    expect(railInset(96)).toBe(96);
    expect(railInset(32)).toBe(32);
  });

  it("is zero once the column has scrolled up to or past the window's top edge", () => {
    expect(railInset(0)).toBe(0);
    expect(railInset(-40)).toBe(0);
    expect(railInset(-0.5)).toBe(0);
  });

  it("rounds a fractional offset UP, so the rail is never a fraction of a pixel too tall", () => {
    expect(railInset(31.25)).toBe(32);
    expect(railInset(0.1)).toBe(1);
  });

  it("reads an unmeasurable offset as zero — the pre-existing viewport-only fallback", () => {
    expect(railInset(Number.NaN)).toBe(0);
    expect(railInset(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("RAIL_MAX_HEIGHT", () => {
  it("is the viewport less the measured inset, the viewport alone before the first measurement", () => {
    expect(RAIL_INSET_VAR).toBe("--rail-inset");
    expect(RAIL_MAX_HEIGHT).toBe("calc(100dvh - var(--rail-inset, 0px))");
  });
});

describe("Shell.tsx applies the rule to the sticky rail wrapper (source pin)", () => {
  const src = readFileSync(join(process.cwd(), "src/components/Shell.tsx"), "utf8");

  it("imports the rule and writes the measured inset to the wrapper", () => {
    expect(src).toContain('from "@/lib/rail-fit"');
    expect(src).toContain("maxHeight: RAIL_MAX_HEIGHT");
    expect(src).toContain("railInset(");
    expect(src).toContain("setProperty(RAIL_INSET_VAR");
  });

  it("no longer sizes the wrapper to the bare viewport", () => {
    expect(src).not.toContain("max-h-screen");
  });

  it("re-measures on scroll, on resize, and when the document's height changes (a banner)", () => {
    expect(src).toContain('addEventListener("scroll", scheduleMeasure');
    expect(src).toContain('addEventListener("resize", scheduleMeasure');
    expect(src).toContain("new ResizeObserver(scheduleMeasure)");
    expect(src).toContain("observer.observe(document.body)");
  });

  it("coalesces those to one layout read per frame, and measures before the first paint", () => {
    expect(src).toContain("requestAnimationFrame(() => {");
    expect(src).toContain("cancelAnimationFrame(frame)");
    expect(src).toMatch(/useLayoutEffect\(\(\) => \{\s*const wrapper = ref\.current;/);
  });

  it("keeps the wrapper sticky and self-scrolling, on the inner wrapper rather than the aside", () => {
    expect(src).toMatch(/<RailWrapper>/);
    expect(src).toMatch(/className="sticky top-0 overflow-y-auto"/);
    expect(src).toMatch(/<aside className="[^"]*">\s*<RailWrapper>/);
  });
});
