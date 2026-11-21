// erp/tests/shipment-ship-to.test.ts
import { describe, expect, it } from "vitest";
import { shipToChoice, shipToOptionLabel, shipsToText, type ShipToAddress } from "@/lib/shipment-ship-to";

// What the saved shipment page's Ship-to select offers and what its "Ships to:" line reads (#484,
// owner ruling 2026-10-15, "Payload address after commit, select open"). The page asks the leaf and
// draws the answer, so the rule is pinned here, as text.

const DOCK_7 = { name: "Dock 7", street: "1 Main St", city: "Springfield", state: "IL", zip: "62701" };
/** Dock 7 as the customer's address list holds it, read before the address was edited. */
const LISTED_DOCK_7 = { id: "addr7", name: "Dock 7 (old)", street: "1 Main St", city: "Springfield", state: "IL", zip: "62701" };
const LISTED_DOCK_9 = { id: "addr9", name: "Dock 9", street: "9 Side Rd", city: "Shelbyville", state: "IL", zip: "62565" };

describe("the address formats", () => {
  it("the select's option reads the list's format: name, street, city and state", () => {
    expect(shipToOptionLabel(DOCK_7)).toBe("Dock 7 — 1 Main St, Springfield IL");
  });

  it("\"Ships to:\" reads the zip as well", () => {
    expect(shipsToText(DOCK_7)).toBe("Dock 7 — 1 Main St, Springfield IL 62701");
  });
});

describe("shipToChoice", () => {
  it("case 1: the list holds the set id, so the list's row is read and the select needs no option of its own, whatever the answer holds", () => {
    // The answer's text differs from the listed row's, so which one "Ships to:" reads is visible.
    expect(shipToChoice({ listed: [LISTED_DOCK_9, LISTED_DOCK_7], setId: "addr7", answered: DOCK_7 })).toEqual({
      own: null, shipsTo: "Dock 7 (old) — 1 Main St, Springfield IL 62701",
    });
    // An answer with no address, null or with its key missing, changes nothing while the list holds
    // the id: a Ship-to pick on a shipment that had no address sets the new id on screen before its
    // answer lands, and until then the answer held is null. (The missing key is kept from #547,
    // when `api()` resolved an answer it could not read as `{}`; it now rejects one.)
    const noAddress = [null, undefined as unknown as ShipToAddress | null]
      .map((answered) => shipToChoice({ listed: [LISTED_DOCK_7], setId: "addr7", answered }));
    expect(noAddress).toEqual([
      { own: null, shipsTo: "Dock 7 (old) — 1 Main St, Springfield IL 62701" },
      { own: null, shipsTo: "Dock 7 (old) — 1 Main St, Springfield IL 62701" },
    ]);
  });

  it("case 2: the list is empty (no customers.view, or its read failed), so the answer is the select's own option", () => {
    expect(shipToChoice({ listed: [], setId: "addr7", answered: DOCK_7 })).toEqual({
      own: { value: "addr7", label: "Dock 7 — 1 Main St, Springfield IL" },
      shipsTo: "Dock 7 — 1 Main St, Springfield IL 62701",
    });
  });

  it("case 3: the list lacks the set id (an address since made inactive or deleted), so the answer is the select's own option", () => {
    expect(shipToChoice({ listed: [LISTED_DOCK_9], setId: "addr7", answered: DOCK_7 })).toEqual({
      own: { value: "addr7", label: "Dock 7 — 1 Main St, Springfield IL" },
      shipsTo: "Dock 7 — 1 Main St, Springfield IL 62701",
    });
  });

  it("case 4: the address was just cleared and its answer has not landed, so the answer held still describes the old id: nothing", () => {
    expect(shipToChoice({ listed: [], setId: null, answered: DOCK_7 })).toEqual({ own: null, shipsTo: null });
    expect(shipToChoice({ listed: [LISTED_DOCK_9], setId: null, answered: DOCK_7 })).toEqual({ own: null, shipsTo: null });
  });

  it("case 5: the id is set, the list lacks it and the answer has no address: no option and no words", () => {
    expect(shipToChoice({ listed: [LISTED_DOCK_9], setId: "addr7", answered: null })).toEqual({ own: null, shipsTo: null });
  });

  // No answer the page adopts lacks the key now (the leaf's comment says why), but the leaf still
  // takes one, so this case stays.
  it("case 6: an answer that carries no address key at all reads as no address, and nothing throws: kept from #547, when `api()` could resolve `{}`", () => {
    const answered = undefined as unknown as ShipToAddress | null;
    expect(shipToChoice({ listed: [LISTED_DOCK_9], setId: "addr7", answered })).toEqual({ own: null, shipsTo: null });
  });

  it("case 7: no input offers two options for one id", () => {
    const inputs: Parameters<typeof shipToChoice>[0][] = [
      { listed: [LISTED_DOCK_9, LISTED_DOCK_7], setId: "addr7", answered: DOCK_7 },
      { listed: [], setId: "addr7", answered: DOCK_7 },
      { listed: [LISTED_DOCK_9], setId: "addr7", answered: DOCK_7 },
      { listed: [LISTED_DOCK_9], setId: null, answered: DOCK_7 },
      { listed: [LISTED_DOCK_9], setId: "addr7", answered: null },
      { listed: [LISTED_DOCK_9], setId: "addr7", answered: undefined as unknown as ShipToAddress | null },
      { listed: [LISTED_DOCK_7], setId: "addr7", answered: null },
      { listed: [LISTED_DOCK_7], setId: "addr7", answered: undefined as unknown as ShipToAddress | null },
    ];
    expect(inputs).toHaveLength(8);
    // The values the select would hold for each input: its own option's, then the list's.
    const values = inputs.map((input) => {
      const { own } = shipToChoice(input);
      return [...(own === null ? [] : [own.value]), ...input.listed.map((a) => a.id)];
    });
    expect(values).toEqual([
      ["addr9", "addr7"],
      ["addr7"],
      ["addr7", "addr9"],
      ["addr9"],
      ["addr9"],
      ["addr9"],
      ["addr7"],
      ["addr7"],
    ]);
  });
});
