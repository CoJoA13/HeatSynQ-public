import { describe, it, expect } from "vitest";
import {
  containerTagsGate, containerTagsHref, NOT_PRINTED_ON_A_TAG,
  TAGS_DRAFTS_TITLE, TAGS_NO_ROWS_TITLE, TAGS_UNSAVED_TITLE, TAGS_VOIDED_TITLE,
} from "@/lib/container-tags-gate";
import type { Gate } from "@/lib/permission-ui";

// #743: when the order hub's Print tags is open, and the sentence it is closed with. The rungs are
// the traveler print gate's (DocumentsSection.tsx): a voided order, orders.view, the retained-draft
// check, then unsaved work in a section the tag prints from; and last, an order with no saved
// container row has no tag. The tags render from server state, so unsaved Lines (a quantity marked
// Not saved) and Containers block; Serials, Charges and Loads are not on a tag and do not.

const OPEN: Gate = { allowed: true, disabled: false, title: undefined };
const NO_VIEW: Gate = { allowed: false, disabled: true, title: "Requires orders.view" };
const open = { voided: false, viewGate: OPEN, draftsReady: true, unsaved: false, rows: 2 };

describe("containerTagsGate", () => {
  it("is open, untitled, on a saved order with rows, orders.view, drafts checked and nothing unsaved", () => {
    expect(containerTagsGate(open)).toEqual(OPEN);
  });
  it("closes on a voided order first", () => {
    expect(containerTagsGate({ ...open, voided: true, viewGate: NO_VIEW, rows: 0 }))
      .toEqual({ allowed: false, disabled: true, title: TAGS_VOIDED_TITLE });
  });
  it("then on the view gate, with its own title", () => {
    expect(containerTagsGate({ ...open, viewGate: NO_VIEW, draftsReady: false })).toEqual(NO_VIEW);
  });
  it("then while the retained drafts are not yet known", () => {
    expect(containerTagsGate({ ...open, draftsReady: false, unsaved: true }))
      .toEqual({ allowed: false, disabled: true, title: TAGS_DRAFTS_TITLE });
  });
  it("then over unsaved work, ahead of a missing row: an added row that is not saved is unsaved work", () => {
    expect(containerTagsGate({ ...open, unsaved: true, rows: 0 }))
      .toEqual({ allowed: false, disabled: true, title: TAGS_UNSAVED_TITLE });
  });
  it("last, on an order with no saved container row", () => {
    expect(containerTagsGate({ ...open, rows: 0 })).toEqual({ allowed: false, disabled: true, title: TAGS_NO_ROWS_TITLE });
  });
  it("ignores the sections a tag does not print from, and no others", () => {
    expect([...NOT_PRINTED_ON_A_TAG]).toEqual(["Serials", "Charges", "Loads"]);
  });
  it("names the route by the order's id", () => {
    expect(containerTagsHref("order-1")).toBe("/api/orders/order-1/container-tags");
  });
  it("says what each closed state is, in the words the hub shows", () => {
    expect(TAGS_VOIDED_TITLE).toBe("Order is voided — no tags print for it");
    expect(TAGS_DRAFTS_TITLE).toBe("Checking retained drafts before printing");
    expect(TAGS_UNSAVED_TITLE).toBe("Save the changes first, restore a value marked Not saved, or press Remove again on a line marked Removal not confirmed — the tags print what the server holds");
    expect(TAGS_NO_ROWS_TITLE).toBe("Add a container row and save it first");
  });
});
