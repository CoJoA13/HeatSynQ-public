// #646: a quote line's window reads MM/DD/YYYY on every screen that shows it. The sentence is
// stated once, in src/lib/quote-window.ts; the part page's Active quotes and the order screens'
// quote picker both read it, and neither types the sentence itself.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { quoteWindowLabel } from "../src/lib/quote-window";
import { callsBareIdentifier, literalTexts } from "./helpers/ts-parse";

describe("quoteWindowLabel", () => {
  it("states both civil dates as MM/DD/YYYY, keeping their day", () => {
    expect(quoteWindowLabel({ effectiveDate: "2026-10-01", expiryDate: "2026-12-31" }))
      .toBe("effective 10/01/2026 to 12/31/2026");
  });
});

const ERP = fileURLToPath(new URL("../", import.meta.url));
const SCREENS = ["src/app/parts/[id]/ActiveQuotesSection.tsx", "src/app/orders/new/QuoteLinkPicker.tsx"];

describe("the screens read the leaf", () => {
  it.each(SCREENS)("%s calls quoteWindowLabel and types no window sentence of its own", (file) => {
    const src = readFileSync(join(ERP, file), "utf8");
    expect(callsBareIdentifier(src, "quoteWindowLabel", file)).toBe(true);
    expect(literalTexts(src, file).filter((h) => /\beffective\b/.test(h.text))).toEqual([]);
  });
});
