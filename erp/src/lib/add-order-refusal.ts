// The new shipment form's Add order refusal (#695). Pure and client-safe; its only import is a type.
// A refused add shows one sentence beside Add order in the shared PanelMessage (owner ruling R1),
// never in the page-top banner, which is Save's, and never in `load()`'s slot. The page offers the
// notice's own retry beside it (`CHECK_AGAIN`, draft-recovery-words.ts), which reads the saved
// records and the order list again.
import type { AddOrderOutcome } from "./new-shipment-recovery";

/** The sentence, worded by the owner on 2026-11-02. */
export const ORDER_CAN_NO_LONGER_BE_ADDED = "This order can no longer be added. Check the saved records again, then pick an order.";

/** What Add order's outcome shows beside it: the sentence for an order that has shipped or a read the
 *  form has moved past, and nothing otherwise. A failed read says nothing here, because the editor
 *  leaves the form and the recovery notice speaks for it; an answer to an earlier page or session
 *  says nothing either. */
export function addOrderRefusalSentence(outcome: AddOrderOutcome): string | null {
  return outcome === "shipped" || outcome === "changed" ? ORDER_CAN_NO_LONGER_BE_ADDED : null;
}
