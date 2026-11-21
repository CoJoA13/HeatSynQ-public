/**
 * The owner's example figures (the weights design §13.2), as plain numbers. No builder's data
 * type is used here. Read them and spread a copy. Each example is frozen with everything it
 * holds, so a case that writes to one throws where it would have changed it for every case after.
 */

/** Freezes a value and every object and array it holds, and hands it back. */
function frozen<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const held of Object.values(value)) frozen(held);
    Object.freeze(value);
  }
  return value;
}

/** The owner's example: net 1,600.00, tare 127.50, gross 1,727.50. */
export const ORDER_1031: {
  number: 1031;
  lines: { qty: number; eachWeight: number; weight: number }[];
  containers: { typeName: string; count: number; pieces: number | null; tareEach: number | null }[];
} = frozen({
  number: 1031,
  lines: [
    { qty: 200, eachWeight: 6.4, weight: 1280 },
    { qty: 100, eachWeight: 3.2, weight: 320 },
  ],
  containers: [{ typeName: "Steel Basket", count: 3, pieces: 252, tareEach: 42.5 }],
});

/** Ships 450.00 lb with no containers listed. The approved document gives only that figure: the
 *  two lines are this file's. */
export const ORDER_1032: {
  number: 1032;
  lines: { qty: number; eachWeight: number; weight: number }[];
  containers: [];
} = frozen({
  number: 1032,
  lines: [
    { qty: 100, eachWeight: 3, weight: 300 },
    { qty: 60, eachWeight: 2.5, weight: 150 },
  ],
  containers: [],
});

/** Fourteen bins at 310: tare 4,340. On 4,128.00 lb of parts, gross 8,468.00. */
export const BINS_14: { typeName: string; count: 14; pieces: null; tareEach: 310 } =
  frozen({ typeName: "Bin", count: 14, pieces: null, tareEach: 310 });

/** The largest weight the calculation holds, in pounds. */
export const CEILING_LB = 9_999_999_999.99;
