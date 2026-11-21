import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #239 S1 — success green is ONE ramp. Tailwind ships two adjacent greens, and the app drifted
 * into both: `emerald-*` on a handful of all-clear indicators, banners and pills, `green-*` on the
 * rest, for the same meaning on screens an operator moves between in one task. The receivables and
 * template halves were converted by hand; this sweep is what stops the third one arriving, because
 * nothing else can see it (tsc and eslint do not read class strings, and both ramps render as a
 * perfectly plausible green on their own — the defect is only visible side by side).
 *
 * Since the UX redesign's class sweep (PR 1b, 2026-10-31) the ramp is the design's own
 * `success-*` tokens (`globals.css`'s `@theme`), and `green-*` is retired beside `emerald-*`. The
 * one keeper is the board's traffic-light dot (`src/lib/traffic-light.ts`): a four-colour
 * semaphore whose red, amber, yellow and green ARE its meaning, not chrome, so it stays on
 * Tailwind's scale by this sweep's reasoned allowlist (`KEEPS_GREEN`).
 *
 * Deliberately a plain substring over the whole file rather than a class-attribute parse: a token
 * reached by template literal, by a `Record<…, string>` lookup table (`traffic-light.ts`'s dot
 * classes are exactly that shape) or named in a comment is the same drift, and this fails CLOSED
 * on all three. The escape hatch, if one is ever wanted, is a reasoned allowlist entry here — not
 * a narrower detector.
 */
const SRC = fileURLToPath(new URL("../src", import.meta.url));

function srcFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? srcFiles(join(directory, entry.name))
      : [join(directory, entry.name)]);
}

const FILES = srcFiles(SRC).filter((path) => /\.(ts|tsx|css)$/.test(path));

/** The reasoned allowlist: a file whose green is a semaphore state, not the success ramp. */
const KEEPS_GREEN = new Set(["lib/traffic-light.ts"]);

describe("colour tokens under src/ (#239 S1)", () => {
  it("walks a real tree, so a bad glob cannot pass vacuously", () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES.some((path) => path.endsWith(join("app", "globals.css")))).toBe(true);
  });

  it("carries no emerald-* or green-* token anywhere but the traffic light — success-* is the app's ramp", () => {
    const offenders = FILES
      .filter((path) => !KEEPS_GREEN.has(path.slice(SRC.length + 1)))
      .filter((path) => /emerald-|\b(?:bg|text|border)-green-\d{2,3}\b/.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });

  it("still uses the success-* ramp it standardised on, so the sweep is not green by deletion", () => {
    const greens = FILES.filter((path) => /\b(?:bg|text|border)-success-\d{2,3}\b/
      .test(readFileSync(path, "utf8")));
    expect(greens.length).toBeGreaterThan(5);
  });

  it("the keeper still holds its semaphore green, so the allowlist entry is not stale", () => {
    for (const path of KEEPS_GREEN) expect(readFileSync(join(SRC, path), "utf8")).toMatch(/\bbg-green-\d{3}\b/);
  });
});
