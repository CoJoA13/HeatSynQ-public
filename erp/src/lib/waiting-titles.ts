// The titles a greyed control carries when nothing is wrong and there is simply nothing to act on
// yet (#487; owner ruling 2026-10-15, worded by the owner 2026-10-16). Pure and client-safe. A
// control whose reason already stands as text beside it takes none of these and stays untitled,
// except a clean Save, which says "No unsaved changes" on all eight grids even where "No unsaved
// load changes" stands beside Save loads (owner answer 6, 2026-10-16). Every function here asks
// the control's own gate first: a closed gate keeps its own reason.
import type { Gate } from "./permission-ui";

/** A clean Save: there is nothing to save. The process steps editor, the cert readings and the
 *  quote page carry the same sentence as literals of their own. */
export const NO_UNSAVED_CHANGES = "No unsaved changes";

/** A clean Save while the hub's Serials holds text typed into "Add serial(s)" that is not yet rows:
 *  "No unsaved changes" would be false, and Save has nothing to send until the text is added. */
export const ENTRY_NOT_ADDED = "Add or clear the typed serials first";

/** Add order, on the saved shipment page and the new shipment form, while its list offers an order
 *  and none is picked (owner answer 1). */
export const PICK_AN_ORDER_FIRST = "Pick an order first";

/** A picker's Add, in the grids both shipment pages draw, while its picker offers something and
 *  nothing is picked (owner answer 1). */
export const PICK_A_LINE_FIRST = "Pick a line first";
export const PICK_A_CONTAINER_FIRST = "Pick a container first";
export const PICK_A_SERIAL_FIRST = "Pick a serial first";

/** The order hub's Link while its "Order #" box is empty or holds only white space (owner answer 2). */
export const ENTER_ORDER_NUMBER_FIRST = "Enter an order # first";

/** The order hub's "Single load…" list while the order has no saved load (owner answer 2). */
export const SAVE_A_LOAD_FIRST = "Save a load first";

/** A pick-list select on the part page while its options read is out (#684; owner ruling
 *  2026-11-02). Read through `optionsSelectTitle` (options-read.ts), which keeps the failure
 *  sentence: that one is not a waiting title. */
export const LOADING_OPTIONS = "Loading options…";

/**
 * The shared Save button's title. A closed gate keeps its own reason, which on a grid with a draft
 * store includes the grid's recovery beat (`gridGate`, shipment-gates.ts). An open gate while the
 * button's own save is in flight gives none: the button keeps its "Saving…" label and carries no
 * title while its save runs (owner answer 9, 2026-10-16). An open gate over a dirty grid with no
 * save in flight gives none either: the button is enabled. A save in flight is asked apart from
 * `dirty` because a grid's dirty flag clears when its draft store settles the save, inside the save
 * callback, so the grid can read clean before the button's save is over. An open gate over a clean
 * grid with no save in flight says there is nothing to save, or, while `alsoUnsaved` holds work
 * this button cannot save, what to do with it. Only the hub's Serials passes `alsoUnsaved`
 * (tests/save-button-wiring.test.ts), which is why its sentence names serials.
 */
export function saveButtonTitle({ gate, dirty, alsoUnsaved, saving }: {
  gate: Gate; dirty: boolean; alsoUnsaved: boolean; saving: boolean;
}): string | undefined {
  if (!gate.allowed) return gate.title;
  if (dirty || saving) return undefined;
  return alsoUnsaved ? ENTRY_NOT_ADDED : NO_UNSAVED_CHANGES;
}

/**
 * The title of a control greyed while it waits for something to be chosen or typed. A closed gate
 * keeps its own reason. An open gate gives `sentence` while the control is `waiting`, and nothing
 * otherwise. The caller states the waiting condition, and it must be one that greys the control,
 * so that the sentence is never the title of an open control.
 */
export function waitingTitle(gate: Gate, waiting: boolean, sentence: string): string | undefined {
  if (!gate.allowed) return gate.title;
  return waiting ? sentence : undefined;
}

const PICK_FIRST = { line: PICK_A_LINE_FIRST, container: PICK_A_CONTAINER_FIRST, serial: PICK_A_SERIAL_FIRST } as const;

/**
 * A picker's Add, in the Lines, Containers and Serials grids both shipment pages draw
 * (ShipmentGrids.tsx). It waits only while the picker offers something (`candidateCount` above 0)
 * and nothing is picked. A picker that offers nothing has its reason as text beside it, so Add then
 * stays untitled.
 */
export function pickerAddTitle(
  gate: Gate, candidateCount: number, pick: string, noun: keyof typeof PICK_FIRST,
): string | undefined {
  return waitingTitle(gate, candidateCount > 0 && pick === "", PICK_FIRST[noun]);
}

/** The gate of a button that has none of its own: it is never closed and carries no title. */
const NO_GATE: Gate = { allowed: true, disabled: false, title: undefined };

/**
 * The Add order button, on the saved shipment page and the new shipment form. `gate` is the
 * button's own gate: the saved page's `reasonGate` (ShipmentDetail.tsx); the new form's button has
 * none. It waits only while the list offers an order (`listOffers`) and none is picked.
 * While the list offers nothing (it is loading, failed, empty or closed, or, on the new form, no
 * customer is picked) the button stays untitled and the list's own text is left to say why (owner
 * answers 1 and 5).
 */
export function addOrderButtonTitle({ gate = NO_GATE, listOffers, choice }: {
  gate?: Gate; listOffers: boolean; choice: string;
}): string | undefined {
  return waitingTitle(gate, listOffers && choice === "", PICK_AN_ORDER_FIRST);
}
