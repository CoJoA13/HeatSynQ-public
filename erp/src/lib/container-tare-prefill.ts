// Client-safe and pure: what a container row's Tare each box shows, and what a change of the row's
// type does to it. The weights design §9.4 ("The prefill rule") and the owner's rulings W3 and W4
// of 2026-10-09.
//
// A container type carries a default tare each. It is a prefill and nothing more. The server stores
// the tare each it is sent and applies no default, so every decision about the default is made
// here. vitest has no component renderer, so the two order screens call these functions and show
// what they return (tests/container-tare-prefill.test.ts).
//
// The two screens hold different things, so they ask different questions.
//
// Order entry holds the operator's own text for the box, or null while the box was never typed in.
// The type's default is never stored in the draft. `entryTareEach` puts the two together wherever
// the box's text is read, which is when the row is drawn, checked and saved: the default shows, and
// follows the type, until the box is typed in. From then on the text wins, a cleared box included.
//
// The saved order's grid holds one string per box, and cannot know who put a stored figure there.
// So `tareEachAfterTypeChange` decides a change of type from the figures alone. One rule serves a
// saved row and a row just added (the design's §9.9, point 21). Nothing is filled when the grid
// loads: a stored blank shows blank (W4).
//
// A default is written into a box as `tareEachText` spells it, which is how the grid spells a
// stored figure. The grid compares its strings exactly. So a row that followed its type, changed
// and changed back, holds the server's own text again, and the section reads clean.
import { tareEachCents } from "./net-weight";

/** A container type as far as the rule reads it. Each order screen's `ContainerTypeOption`
 *  satisfies this as it is. */
export type ContainerTypeTare = { id: string; tareEach: number | null };

/** A tare each as text in a box: "42.5", "310", "0", and "" for none. It is `String` of the
 *  number, with no padding and no grouping, as the saved order's grid spells a stored figure. */
export function tareEachText(value: number | null): string {
  return value === null ? "" : String(value);
}

/** The default tare each of the type a row names. null for no type, for a type that is not in the
 *  list, and for a type with no default. A default of 0 is a default: `??`, never `||`. */
export function typeDefaultTare(
  types: readonly ContainerTypeTare[], typeId: string | null | undefined,
): number | null {
  return types.find((type) => type.id === typeId)?.tareEach ?? null;
}

/** Order entry: the text the Tare each box shows. `override` is what the draft holds for the box:
 *  null until it is typed in, then the operator's own text, returned exactly as typed. An empty
 *  string is a cleared box and stays cleared: `??`, never `||`. */
export function entryTareEach(override: string | null, typeDefault: number | null): string {
  return override ?? tareEachText(typeDefault);
}

/**
 * The saved order's grid: what a change of a row's type does to its Tare each box. It returns the
 * text to put in the box, or null to leave the box alone.
 *
 *   The box holds                               Then
 *   Nothing                                     the new type's default, if it has one (W4)
 *   A figure equal to the old type's default    the new type's default, or "" if it has none (W3;
 *                                               the design's §9.9, point 3)
 *   Any other figure, or the old type had none  it stays (W3)
 *
 * Figures are compared as amounts, in whole cents: "42.50" equals a default of 42.5. Text that is
 * not a tare each equals no default, and stays for the save to refuse.
 */
export function tareEachAfterTypeChange(input: {
  current: string; oldDefault: number | null; newDefault: number | null;
}): string | null {
  if (input.current.trim() === "") return input.newDefault === null ? null : tareEachText(input.newDefault);
  const typedCents = tareEachCents(input.current);
  // `typedCents !== null` carries both halves of the last row. Text that cannot be read, and an old
  // type with no default, each read as null here, and null must never count as equal to null.
  const followedOldType = typedCents !== null && typedCents === tareEachCents(input.oldDefault);
  return followedOldType ? tareEachText(input.newDefault) : null;
}
