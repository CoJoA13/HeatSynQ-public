// Client-safe and pure: where New order takes the operator when the SERVER refuses a charge's
// value (#546, owner ruling 2026-10-18). The page's own checks refuse the same values first, so this
// is reached only when the two disagree. The refusal keeps the server's own sentence; this decides
// only which box takes the cursor, and on which tab: a charge's boxes are on Order details. vitest
// has no component renderer, so the page asks this and shows what it answers
// (tests/charge-refusal-field.test.ts).
//
// The server names a refused charge value by its path (`readableMessage`,
// src/server/error-message.ts): `charges.<index>.<key>: <sentence>`, the index counting from 0 as
// the charges stand in the body the page sent. A key the create schema does not know is refused
// one level up, as `charges.<index>: Unrecognized key: "<key>"`. Its words are not read: no charge
// key was renamed, so an unknown key is no old name (owner answer 2, 2026-10-18; #494's container
// leaf reads them because some container keys were).

/** The last part of each charge box's id on New order. */
export type ChargeBox = "description" | "amount";

/** Each key of the server's charge (`CHARGE_ITEM`, src/server/order-internals.ts) and the box that
 *  holds it. */
export const CHARGE_KEY_BOXES = {
  description: "description",
  amount: "amount",
} as const satisfies Record<string, ChargeBox>;

/** The tab and the id of the box a refusal is about. */
export type ChargeRefusal = { tab: "details" | "parts"; fieldId: string };

/** The tab and box a server refusal is about, or null when it is not about a charge. `chargeIds`
 *  are the page's charges, in the order it sent them; `leadLineId` is the page's lead part line. */
export function chargeRefusalField(
  message: string, chargeIds: readonly string[], leadLineId: string,
): ChargeRefusal | null {
  const path = message.match(/^charges(?:\.(\d+)(?:\.([^.:\s]+))?)?: /);
  if (!path) return null;
  // A charge refusal on a page that holds no charge: the lead line's Part box, on the Parts tab
  // (owner answer 4, 2026-10-18).
  if (chargeIds.length === 0) return { tab: "parts", fieldId: `entry-line-${leadLineId}-part` };
  const chargeId = path[1] === undefined ? undefined : chargeIds[Number(path[1])];
  // The charge list itself, or a charge past the page's charges: the first charge's Description
  // (owner ruling, 2026-10-18). The page sends every charge it holds, so neither is expected.
  if (chargeId === undefined) return { tab: "details", fieldId: `entry-charge-${chargeIds[0]}-description` };
  const key = path[2];
  // A held charge with no key, or a key the schema does not know: its Description (owner answer 2,
  // 2026-10-18).
  const box = key !== undefined && Object.hasOwn(CHARGE_KEY_BOXES, key)
    ? CHARGE_KEY_BOXES[key as keyof typeof CHARGE_KEY_BOXES]
    : "description";
  return { tab: "details", fieldId: `entry-charge-${chargeId}-${box}` };
}
