// erp/src/lib/shipment-ship-to.ts
// Client-safe: it imports nothing. The shipment's ship-to address as each shipment answer carries
// it (#484, owner ruling 2026-10-15, "Payload address after commit, select open"):
// `readShipToAddress` (src/server/shippers.ts) reads it, and `shipperResponse`
// (src/app/api/shippers/response.ts) puts it beside `shipper` in the answer.
//
// What the saved shipment page's Ship-to select offers and what its "Ships to:" line reads are
// decided here (`shipToChoice`), and the page only draws them. The customer's address list can
// lack the address the shipment names for any reason, among them: the viewer lacks customers.view,
// so the page never reads the list; the list's read failed; the address has since been made
// inactive or deleted, or its kind changed from Ship to, and the list holds live Ship to addresses
// only; or a later load brought in an id set after the list was read. Whatever the reason, the
// select offers the address the answer carries as its own option, after "— none —" and before the
// list, where the Carrier select offers a carrier its pick-list lacks.
//
// The own option reads the list's own format (`shipToOptionLabel`), with no word of its own. A
// customers.view holder's list is empty until the address read answers: for that moment the own
// option is drawn from the answer, and then the listed option with the same value replaces it. Both
// are written in this one format, so they read the same unless the address was edited between the
// two reads.
//
// The new shipment form (src/app/shipping/new/NewShipment.tsx) writes the list's option format
// inline too; #484 left it there.

/** A shipment's ship-to address: the five fields the ruling names, and no id. The answer it rides
 *  in carries the address's id as `shipper.shipToAddressId`. */
export type ShipToAddress = { name: string; street: string; city: string; state: string; zip: string };

/** An address as the customer's address list holds it. */
export type ListedShipTo = ShipToAddress & { id: string };

/** What the Ship-to select offers beside the list, and what "Ships to:" reads. `own` is the
 *  select's own option, null when it needs none. `shipsTo` is null when there is nothing to show. */
export type ShipToChoice = { own: { value: string; label: string } | null; shipsTo: string | null };

/** An address as the Ship-to select's options show it. */
export function shipToOptionLabel(a: ShipToAddress): string {
  return `${a.name} — ${a.street}, ${a.city} ${a.state}`;
}

/** An address as the "Ships to:" line shows it. */
export function shipsToText(a: ShipToAddress): string {
  return `${a.name} — ${a.street}, ${a.city} ${a.state} ${a.zip}`;
}

/**
 * `listed` is the customer's address list as the page holds it, `setId` the shipment's
 * `shipToAddressId` as the page shows it, and `answered` the address the newest adopted answer
 * carries.
 *
 * Keyed on `setId`, never on whether there is an answer: a Ship-to change sets the new id on screen
 * before its answer lands, and until then `answered` still describes the previous id.
 *
 * The list wins when it holds the id: the answer is read only when the list lacks it. An id the
 * answer has no address for (a hard delete landing between the commit and the read) gets no option
 * and no words, so the select shows what it shows for an id none of its options holds.
 *
 * `answered == null`, not `=== null`, so an answer that omits the key (the value `undefined`) reads
 * as no address too. No answer the page adopts omits it now: each is a `shipperResponse`
 * (src/app/api/shippers/response.ts), which always sets the key, and since #547 `api()`
 * (src/lib/fetcher.ts) rejects an answer whose body it could not read (`UnreadableAnswerError`)
 * where it used to resolve it as `{}`. The `==` stays so the leaf answers for any input.
 */
export function shipToChoice({ listed, setId, answered }: {
  listed: ListedShipTo[]; setId: string | null; answered: ShipToAddress | null;
}): ShipToChoice {
  if (setId === null) return { own: null, shipsTo: null };
  const row = listed.find((a) => a.id === setId);
  if (row !== undefined) return { own: null, shipsTo: shipsToText(row) };
  if (answered == null) return { own: null, shipsTo: null };
  return { own: { value: setId, label: shipToOptionLabel(answered) }, shipsTo: shipsToText(answered) };
}
