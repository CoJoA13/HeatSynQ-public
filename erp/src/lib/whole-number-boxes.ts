// The whole-number boxes ruling 19 (2026-10-22 review, G5-4) covers, each stated once: its label as
// the screen shows it and the server's own bounds (`parts.ts`, `customers.ts`, `reference.ts`), so
// the sentence a screen or a paste refuses with is true of what the server would refuse. Read
// through `src/lib/whole-number-entry.ts`. Client-safe: no server imports.
import type { WholeNumberBox } from "./whole-number-entry";

/** A part's Load quantity: `parts.ts` `loadQty: z.number().int().min(1)`. */
export const LOAD_QTY: WholeNumberBox = { label: "Load quantity", min: 1 };
/** A part's and a customer's Request days override: `min(0).max(3650)`, the ceiling
 *  `addBusinessDays`' own guard (`business-days.ts`). One box for both screens. */
export const REQUEST_DAYS_OVERRIDE: WholeNumberBox = { label: "Request days override", min: 0, max: 3650 };
/** Terms' Net days: `reference.ts` `netDays: z.number().int().min(0)`. */
export const NET_DAYS: WholeNumberBox = { label: "Net days", min: 0 };
/** Terms' Discount days: `reference.ts` `discountDays: z.number().int().min(1)`. */
export const DISCOUNT_DAYS: WholeNumberBox = { label: "Discount days", min: 1 };
