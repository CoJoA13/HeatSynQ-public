import { describe, it, expect } from "vitest";
import { equalShareCap } from "@/server/pdf/equal-share";

/**
 * The equal share of a line (#590, the owner's "Equal share" answer of 2026-10-20): the widest a
 * field may print on one line of fields when they do not all fit at their own widths. Pure, no
 * database. render.ts's measured row reads it; render-primitives.test.ts holds what the paper shows.
 */

/** Σ min(nᵢ, cap): the width the fields take on the line once each is held to the cap. */
const taken = (naturals: number[], cap: number): number =>
  naturals.reduce((sum, natural) => sum + Math.min(natural, cap), 0);

describe("equalShareCap — no cap where the fields fit", () => {
  it("is Infinity when the fields' widths add up to less than the line", () => {
    expect(equalShareCap([72, 84, 83, 81], 470)).toBe(Infinity);
  });

  it("is Infinity when they add up to exactly the line", () => {
    expect(equalShareCap([100, 120, 130, 120], 470)).toBe(Infinity);
  });
});

describe("equalShareCap — the shortest fields keep their width, and the rest share what is left", () => {
  it.each<[what: string, naturals: number[], cap: number]>([
    // 470 less the three that fit.
    ["one long field", [72, 1026, 83, 81], 470 - 72 - 83 - 81],
    // What the two short ones leave, halved.
    ["two long fields", [72, 600, 83, 600], (470 - 72 - 83) / 2],
    // What the one short one leaves, in thirds.
    ["three long fields and one short", [72, 600, 500, 400], (470 - 72) / 3],
    // No field fits: an equal quarter each.
    ["four long fields", [300, 400, 500, 600], 470 / 4],
  ])("%s", (_what, naturals, cap) => {
    expect(equalShareCap(naturals, 470)).toBeCloseTo(cap, 9);
  });

  // The cap is the c for which Σ min(nᵢ, c) is the line: the fields held to it fill the line.
  it.each<[naturals: number[], available: number]>([
    [[72, 1026, 83, 81], 470],
    [[72, 600, 83, 600], 470],
    [[72, 600, 500, 400], 470],
    [[300, 400, 500, 600], 470],
    [[71.50341796875, 406.43701171875, 83.1884765625, 1026.1], 412],
    [[10.5, 10.25, 999, 3.125, 47, 250], 300.75],
  ])("the fields held to the cap of %j fill a line of %d", (naturals, available) => {
    const cap = equalShareCap(naturals, available);
    expect(Number.isFinite(cap)).toBe(true);
    expect(Math.abs(taken(naturals, cap) - available)).toBeLessThan(1e-9);
  });

  it("does not depend on the order the fields are given in", () => {
    const naturals = [72, 600, 83, 500, 41];
    const cap = equalShareCap(naturals, 470);
    for (const order of [[...naturals].reverse(), [600, 41, 500, 72, 83], [83, 72, 41, 500, 600]]) {
      expect(equalShareCap(order, 470)).toBe(cap);
    }
    // And it leaves the caller's array as it was given.
    expect(naturals).toEqual([72, 600, 83, 500, 41]);
  });
});

describe("equalShareCap — refusals (an internal assertion the renderer never reaches)", () => {
  it.each<[what: string, naturals: number[], available: number, refusal: RegExp]>([
    ["a line of no width", [72, 84], 0, /line of 0 points/],
    ["a line of negative width", [72, 84], -12, /line of -12 points/],
    ["a line of no finite width", [72, 84], Number.NaN, /line of NaN points/],
    ["a negative width", [72, -1, 83], 470, /field width of -1 points/],
    ["a width that is not a number", [72, Number.NaN, 83], 470, /field width of NaN points/],
    ["an infinite width", [72, Infinity, 83], 470, /field width of Infinity points/],
  ])("throws on %s", (_what, naturals, available, refusal) => {
    expect(() => equalShareCap(naturals, available)).toThrow(refusal);
  });
});
