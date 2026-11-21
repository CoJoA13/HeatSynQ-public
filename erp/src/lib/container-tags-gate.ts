// #743: when the order hub's Print tags is open, and the sentence it is closed with, decided here
// and never inline (the Refusals-up-front rule). The rungs are the traveler print gate's
// (DocumentsSection.tsx): a voided order prints no new paper (spec §5c); orders.view is the gate the
// route checks; the retained-draft check must have answered, since a hidden retained draft could
// become unsaved work with one click; and unsaved work in a section the tag prints from closes it,
// because the tags render from server state (every print sends no local overlay) and would show a
// quantity or a row the screen does not. Last, an order with no saved container row has no tag.
//
// A tag prints the order's lines (part number and quantity) and its container total, so the Lines
// and Containers sections block; Serials, Charges and Loads are not on a tag, and a DENY list keeps a
// section added later blocking until someone decides otherwise (`unsavedPresentExcluding`). The PO
// box is an Overview blur-save that registers no section, the same accepted residual as the
// traveler's (#518): a tag printed while a PO save is out can carry the old PO.
//
// Client-safe: imports a type only. tests/container-tags-gate.test.ts holds each rung and sentence.
import type { Gate } from "./permission-ui";

/** The hub sections whose unsaved work cannot change a tag. Module-level: a stable operand for the
 *  unsaved hook's snapshot closure. */
export const NOT_PRINTED_ON_A_TAG = ["Serials", "Charges", "Loads"] as const;

export const TAGS_VOIDED_TITLE = "Order is voided — no tags print for it";
export const TAGS_DRAFTS_TITLE = "Checking retained drafts before printing";
export const TAGS_UNSAVED_TITLE =
  "Save the changes first, restore a value marked Not saved, or press Remove again on a line marked Removal not confirmed — the tags print what the server holds";
export const TAGS_NO_ROWS_TITLE = "Add a container row and save it first";

const closed = (title: string): Gate => ({ allowed: false, disabled: true, title });

/** The gate, rung by rung; `rows` is the order's SAVED container rows, which are what print. */
export function containerTagsGate(input: {
  voided: boolean; viewGate: Gate; draftsReady: boolean; unsaved: boolean; rows: number;
}): Gate {
  if (input.voided) return closed(TAGS_VOIDED_TITLE);
  if (!input.viewGate.allowed) return input.viewGate;
  if (!input.draftsReady) return closed(TAGS_DRAFTS_TITLE);
  if (input.unsaved) return closed(TAGS_UNSAVED_TITLE);
  if (input.rows === 0) return closed(TAGS_NO_ROWS_TITLE);
  return input.viewGate;
}

/** The route the link opens: GET /api/orders/[id]/container-tags. */
export const containerTagsHref = (orderId: string): string => `/api/orders/${encodeURIComponent(orderId)}/container-tags`;
