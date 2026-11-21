// Client-safe and pure: what leaving Terms' Discount % or Discount days box on an existing row does
// (owner ruling 2026-11-02 on #680, under R18). The server takes the two both or neither
// (`assertDiscountPairAfterUpdate`, src/server/reference.ts), so they cannot save one key at a time
// as the other pick-list boxes do. Leaving one box holds its text until the other is filled, one save
// then sends both, and clearing both removes the discount. Nothing here says whether a figure is
// allowed: the table checks each box when it is left, before it asks this.
import { inlineDecimalSave } from "./reference-inline-edit";

export type DiscountRow = Readonly<Record<string, unknown>>;
/** The text in each box the operator has typed in. A box left out shows its stored figure. */
export type DiscountTexts = { discountPercent?: string; discountDays?: string };

export type DiscountPairSave =
  | { kind: "none" }
  | { kind: "hold" }
  | { kind: "send"; discountPercent: string | null; discountDays: string | null };

const shown = (stored: unknown, typed: string | undefined) =>
  (typed ?? (stored === null || stored === undefined ? "" : String(stored))).trim();

/** What the pair does with these boxes over `row`'s stored figures. */
export function discountPairSave(row: DiscountRow, typed: DiscountTexts): DiscountPairSave {
  const percent = shown(row.discountPercent, typed.discountPercent);
  const days = shown(row.discountDays, typed.discountDays);
  const changed = inlineDecimalSave(row.discountPercent, percent).send
    || inlineDecimalSave(row.discountDays, days).send;
  if (!changed) return { kind: "none" };
  if ((percent === "") !== (days === "")) return { kind: "hold" };
  return { kind: "send", discountPercent: percent === "" ? null : percent, discountDays: days === "" ? null : days };
}
