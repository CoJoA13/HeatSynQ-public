/**
 * The equal share of a line (#590, the owner's "Equal share" answer of 2026-10-20). When the fields
 * of one printed line do not all fit at their own widths, each keeps its own width up to an equal
 * share of the line, and only a field longer than its share wraps inside it. render.ts's measured
 * row (`fitMeasuredRows`) asks this for the invoice's order strip; it is a pure leaf so the rule is
 * stated once and held by its own tests.
 */

/**
 * The widest a field may print, given each field's width on one line (`naturals`) and the line's
 * width (`available`), in points: `Infinity` when the fields fit, and otherwise the `c` for which
 * Σ min(nᵢ, c) = available. The shortest fields keep their widths and the rest share what they
 * leave equally (water-filling), whatever order the fields are given in.
 *
 * It throws on a line with no width, and on a width that is negative or not a finite number: an
 * internal assertion, since the renderer stacks a row with no width left, or hands it back, before
 * it asks.
 */
export function equalShareCap(naturals: number[], available: number): number {
  if (!Number.isFinite(available) || available <= 0) {
    throw new Error(`An equal share needs a line of some width, and this is a line of ${available} points`);
  }
  for (const natural of naturals) {
    if (!Number.isFinite(natural) || natural < 0) {
      throw new Error(`An equal share needs each field's width, and this is a field width of ${natural} points`);
    }
  }
  if (naturals.reduce((sum, natural) => sum + natural, 0) <= available) return Infinity;
  const ascending = [...naturals].sort((a, b) => a - b);
  let rest = available;
  for (const [i, natural] of ascending.entries()) {
    const share = rest / (ascending.length - i);
    if (natural > share) return share;
    rest -= natural;
  }
  // Every field fitted its share, so the fields fit the line after all (a rounding of the sum).
  return Infinity;
}
