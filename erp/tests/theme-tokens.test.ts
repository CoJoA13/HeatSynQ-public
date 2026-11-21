import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The redesign's colour tokens (docs/execution/2026-10-30-figma-redesign/design-system.md §7,
 * spec 2026-10-30-ux-redesign-design.md §4.1), pinned at their values: the Figma file defines no
 * variables of its own, so these names are the app's and a changed hex is a decision, not a drift.
 * `--color-background` and `--color-foreground` stay `var()` references and are outside the count.
 */
const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

const TOKENS: Record<string, string> = {
  "ink-900": "#14232d", "ink-800": "#20333f", "ink-700": "#2b3d48", "ink-500": "#647680",
  "ink-300": "#a8bac4", "ink-200": "#c6d2d8", "surface-0": "#ffffff", "surface-50": "#f3f5f6",
  "line": "#dce3e6", "accent-600": "#ad430d", "accent-400": "#f78c43", "accent-50": "#fff0e5",
  "accent-25": "#fff6ef", "link-700": "#2c617b", "link-50": "#eaf2f7", "success-700": "#27694e",
  "success-50": "#eaf5ef", "danger-600": "#a53732",
};

describe("the redesign's theme tokens (2026-10-30)", () => {
  it("declares each token once, at its value, inside @theme", () => {
    const start = css.indexOf("@theme inline {");
    expect(start).toBeGreaterThan(-1);
    const theme = css.slice(start, css.indexOf("}", start));
    for (const [name, hex] of Object.entries(TOKENS)) expect(theme).toContain(`--color-${name}: ${hex};`);
    expect(css.match(/--color-[a-z]+-?\d*: #/g)!.length).toBe(Object.keys(TOKENS).length);
  });

  it("the page background and foreground are surface-50 and ink-800", () => {
    expect(css).toMatch(/--background: #f3f5f6;/);
    expect(css).toMatch(/--foreground: #20333f;/);
  });
});
