// The titles a greyed control carries when there is nothing to act on yet (#487), in
// src/lib/waiting-titles.ts. The words are pinned to the literals the owner ruled, so the leaf
// cannot reword them on its own. What each control is handed is pinned by its own suite:
// tests/save-button.test.tsx renders the Save button over these,
// tests/shipment-grid-titles.test.tsx a picker's Add, tests/shipment-detail-wiring.test.ts and
// tests/new-shipment-add-order-title.test.ts the two Add order buttons,
// tests/order-invoice-gates.test.ts the hub's Link and tests/order-traveler-actions.test.tsx the
// Single load select. The last block holds that none of those screens types a sentence of its own.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Gate } from "../src/lib/permission-ui";
import * as WORDS from "../src/lib/waiting-titles";
import {
  ENTER_ORDER_NUMBER_FIRST, ENTRY_NOT_ADDED, NO_UNSAVED_CHANGES, PICK_A_CONTAINER_FIRST, PICK_A_LINE_FIRST, PICK_A_SERIAL_FIRST,
  PICK_AN_ORDER_FIRST, SAVE_A_LOAD_FIRST, addOrderButtonTitle, pickerAddTitle, saveButtonTitle, waitingTitle,
} from "../src/lib/waiting-titles";
import { literalTexts } from "./helpers/ts-parse";

const OPEN: Gate = { allowed: true, disabled: false, title: undefined };
const DENIED: Gate = { allowed: false, disabled: true, title: "Requires orders.edit" };

describe("the words", () => {
  it("a clean Save says there is nothing to save, in the sentence three Save buttons already use", () => {
    expect(NO_UNSAVED_CHANGES).toBe("No unsaved changes");
  });

  it("the hub's Serials with range text typed and nothing else changed says what to do with it (owner answer 3, 2026-10-16)", () => {
    expect(ENTRY_NOT_ADDED).toBe("Add or clear the typed serials first");
  });

  it("both Add order buttons wait for an order to be picked (owner answer 1, 2026-10-16)", () => {
    expect(PICK_AN_ORDER_FIRST).toBe("Pick an order first");
  });

  it("each picker's Add waits for its own pick (owner answer 1, 2026-10-16)", () => {
    expect([PICK_A_LINE_FIRST, PICK_A_CONTAINER_FIRST, PICK_A_SERIAL_FIRST])
      .toEqual(["Pick a line first", "Pick a container first", "Pick a serial first"]);
  });

  it("the hub's Link waits for an order number, and its Single load list for a saved load (owner answer 2, 2026-10-16)", () => {
    expect([ENTER_ORDER_NUMBER_FIRST, SAVE_A_LOAD_FIRST]).toEqual(["Enter an order # first", "Save a load first"]);
  });
});

describe("the part page's options selects", () => {
  it("a select whose options read is out says so (owner ruling 2026-11-02, #684)", () => {
    expect(WORDS.LOADING_OPTIONS).toBe("Loading options…");
  });
});

describe("saveButtonTitle: the gate first, then none while a save is in flight, then whether there is anything to save", () => {
  it.each([
    ["clean", false, false, false],
    ["dirty", true, false, false],
    ["holding an entry", false, true, false],
    ["dirty and holding an entry", true, true, false],
    ["clean and saving", false, false, true],
    ["dirty and saving", true, false, true],
  ])("a closed gate keeps its own title, %s", (_state, dirty, alsoUnsaved, saving) => {
    expect(saveButtonTitle({ gate: DENIED, dirty, alsoUnsaved, saving })).toBe("Requires orders.edit");
  });

  it("an open gate over a dirty grid gives no title: the button is enabled", () => {
    expect(saveButtonTitle({ gate: OPEN, dirty: true, alsoUnsaved: false, saving: false })).toBeUndefined();
  });

  it("an open gate over a clean grid says there is nothing to save", () => {
    expect(saveButtonTitle({ gate: OPEN, dirty: false, alsoUnsaved: false, saving: false })).toBe("No unsaved changes");
  });

  it("an open gate over a clean grid holding an entry says to add or clear it, never that nothing is unsaved", () => {
    expect(saveButtonTitle({ gate: OPEN, dirty: false, alsoUnsaved: true, saving: false })).toBe(ENTRY_NOT_ADDED);
  });

  it("an open gate over a dirty grid holding an entry gives no title: the grid's own rows can be saved", () => {
    expect(saveButtonTitle({ gate: OPEN, dirty: true, alsoUnsaved: true, saving: false })).toBeUndefined();
  });

  it.each([
    ["dirty", true, false],
    // A grid's dirty flag clears when the draft store settles its save (`binding.settle`), inside
    // the save callback and before that callback's promise settles: the label still reads
    // "Saving…" then, and the title must not say there is nothing to save.
    ["already clean", false, false],
    ["already clean, holding an entry", false, true],
  ])("an open gate while its save is in flight gives no title (owner answer 9, 2026-10-16), %s", (_state, dirty, alsoUnsaved) => {
    expect(saveButtonTitle({ gate: OPEN, dirty, alsoUnsaved, saving: true })).toBeUndefined();
  });
});

describe("waitingTitle: the gate first, then what the control waits for", () => {
  it.each([true, false])("a closed gate keeps its own title, waiting: %s", (waiting) => {
    expect(waitingTitle(DENIED, waiting, ENTER_ORDER_NUMBER_FIRST)).toBe("Requires orders.edit");
  });

  it("an open gate that is waiting gives the sentence it is handed", () => {
    expect(waitingTitle(OPEN, true, ENTER_ORDER_NUMBER_FIRST)).toBe("Enter an order # first");
  });

  it("an open gate that is not waiting gives no title", () => {
    expect(waitingTitle(OPEN, false, ENTER_ORDER_NUMBER_FIRST)).toBeUndefined();
  });
});

describe("pickerAddTitle: a picker's Add, on both shipment pages", () => {
  const NOUNS = [["line", "Pick a line first"], ["container", "Pick a container first"], ["serial", "Pick a serial first"]] as const;

  it.each(NOUNS)("%s: the picker offers something and nothing is picked, so Add says what it waits for", (noun, sentence) => {
    expect(pickerAddTitle(OPEN, 1, "", noun)).toBe(sentence);
    expect(pickerAddTitle(OPEN, 3, "", noun)).toBe(sentence);
  });

  it.each(NOUNS)("%s: the picker offers nothing, so the text beside it is the reason and Add stays untitled", (noun) => {
    expect(pickerAddTitle(OPEN, 0, "", noun)).toBeUndefined();
  });

  it.each(NOUNS)("%s: something is picked, so Add is open and untitled", (noun) => {
    expect(pickerAddTitle(OPEN, 2, "ol-1", noun)).toBeUndefined();
  });

  it.each(NOUNS)("%s: a closed gate keeps its own title, whatever the picker offers", (noun) => {
    for (const [count, pick] of [[0, ""], [2, ""], [2, "ol-1"]] as const) {
      expect(pickerAddTitle(DENIED, count, pick, noun), `${count} ${pick}`).toBe("Requires orders.edit");
    }
  });
});

describe("addOrderButtonTitle: the Add order button, on both shipment pages", () => {
  it("the list offers an order and none is picked: the button says so", () => {
    expect(addOrderButtonTitle({ gate: OPEN, listOffers: true, choice: "" })).toBe("Pick an order first");
  });

  it("the list offers nothing (loading, failed, empty or closed): the button stays untitled, and the list's own text is left to say why", () => {
    expect(addOrderButtonTitle({ gate: OPEN, listOffers: false, choice: "" })).toBeUndefined();
  });

  it("an order is picked: the button is open, or adding, and untitled", () => {
    expect(addOrderButtonTitle({ gate: OPEN, listOffers: true, choice: "order-2" })).toBeUndefined();
  });

  it("a closed gate keeps its own title, whatever the list offers", () => {
    for (const [listOffers, choice] of [[true, ""], [false, ""], [true, "order-2"]] as const) {
      expect(addOrderButtonTitle({ gate: DENIED, listOffers, choice }), `${listOffers} ${choice}`).toBe("Requires orders.edit");
    }
  });

  it("a button with no gate of its own, the new form's, answers the same from the list and the pick", () => {
    expect(addOrderButtonTitle({ listOffers: true, choice: "" })).toBe("Pick an order first");
    expect(addOrderButtonTitle({ listOffers: false, choice: "" })).toBeUndefined();
    expect(addOrderButtonTitle({ listOffers: true, choice: "order-2" })).toBeUndefined();
  });
});

// ---- stated once: the screens read the leaf's sentences and never retype them ----

const ERP = fileURLToPath(new URL("../", import.meta.url));
/** Every sentence the leaf exports, by its export name. */
const SENTENCES: [string, string][] = Object.entries(WORDS as Record<string, unknown>)
  .flatMap(([name, value]) => typeof value === "string" ? [[name, value] as [string, string]] : []);
/** The leaf's sentences that `file` (a path under `erp/`) holds in a string, a template's piece or
 *  JSX text, white space collapsed. Parsed (#188), so a comment that quotes one is not counted. A
 *  text that CONTAINS a sentence counts, which fails closed. */
function sentencesHeld(file: string): string[] {
  const texts = literalTexts(readFileSync(join(ERP, file), "utf8"), file).map((held) => held.text.replace(/\s+/g, " "));
  return SENTENCES.filter(([, sentence]) => texts.some((text) => text.includes(sentence))).map(([name]) => name).sort();
}
/** The screens a sentence of the leaf reaches through `saveButtonTitle`, `waitingTitle`,
 *  `pickerAddTitle`, `addOrderButtonTitle` or `optionsSelectTitle`, and the shared Save button itself. A hand list, not
 *  walked from src/: it holds every file that imports the leaf and every site of
 *  tests/save-button-wiring.test.ts's census, and nothing here fails when a new one appears, so a
 *  new importer or Save button site is added by hand. CertificationsSection.tsx imports nothing
 *  from the leaf; it is listed because its Create button was left untitled (owner answer 5). */
const SCREENS = [
  "src/components/SaveButton.tsx",
  "src/app/shipping/ShipmentGrids.tsx",
  "src/app/shipping/[id]/ShipmentDetail.tsx",
  "src/app/shipping/[id]/ShipmentOrderPanel.tsx",
  "src/app/shipping/new/NewShipment.tsx",
  "src/app/orders/[id]/page.tsx",
  "src/app/orders/[id]/ContainersSection.tsx",
  "src/app/orders/[id]/SerialsSection.tsx",
  "src/app/orders/[id]/ChargesSection.tsx",
  "src/app/orders/[id]/LoadsSection.tsx",
  "src/app/orders/[id]/DocumentsSection.tsx",
  "src/app/orders/[id]/CertificationsSection.tsx",
  "src/app/invoicing/[id]/InvoiceDetail.tsx",
  // The part page's options selects, which reach LOADING_OPTIONS through options-read.ts (#684).
  "src/lib/options-read.ts",
  "src/app/parts/[id]/IdentitySection.tsx",
  "src/app/parts/[id]/SpecsSection.tsx",
  "src/app/parts/[id]/InspectionsSection.tsx",
  "src/app/parts/[id]/PricingSection.tsx",
];

describe("the sentences are stated once, in the leaf", () => {
  it("the leaf exports these sentences and no other, so a new one is a decision this list moves with", () => {
    expect(SENTENCES.map(([name]) => name).sort()).toEqual([
      "ENTER_ORDER_NUMBER_FIRST", "ENTRY_NOT_ADDED", "LOADING_OPTIONS", "NO_UNSAVED_CHANGES", "PICK_AN_ORDER_FIRST",
      "PICK_A_CONTAINER_FIRST", "PICK_A_LINE_FIRST", "PICK_A_SERIAL_FIRST", "SAVE_A_LOAD_FIRST",
    ]);
  });

  it("the reader finds every sentence where it is written: in the leaf itself", () => {
    expect(sentencesHeld("src/lib/waiting-titles.ts")).toEqual(SENTENCES.map(([name]) => name).sort());
  });

  it.each(SCREENS)("%s types none of them", (file) => {
    expect(sentencesHeld(file)).toEqual([]);
  });
});
