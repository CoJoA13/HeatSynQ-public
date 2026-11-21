/**
 * The unit of a printed weight (the weights design's §13.2; owner ruling W15 of 2026-10-09).
 * `lb` and `lbEach` take a figure the caller has already formatted and add the unit, so the
 * caller keeps its own number format. A blank figure stays blank: no unit prints alone.
 * tests/printed-weight.test.ts holds both.
 */

/** A printed weight figure with its unit. A blank figure stays blank (owner ruling W15). */
export function lb(figure: string): string {
  return figure === "" ? "" : `${figure} lb`;
}

/** A tare each in the small line of a Tare cell. A blank figure stays blank. */
export function lbEach(figure: string): string {
  return figure === "" ? "" : `${figure} lb each`;
}
