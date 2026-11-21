import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { cameToRest, gridAtRest, useMessageClearedAtRest } from "@/lib/grid-message";

// When a grid's own message goes (#472; src/lib/grid-message.ts). The two decisions are pure and
// are proven directly. The hook that applies them keeps one render's answer for the next, so it
// needs a component that renders more than once, and vitest has no DOM. React's server renderer
// does re-render a component that sets its own state while rendering, with the state it has just
// set. `Grid` below uses that: each pass plays the next step of a script and then asks for
// another pass, so one static render walks a grid through a whole sequence under React's own
// `useState`, and the markup is what the last step shows.

type Step = {
  dirty: boolean;
  /** Open for editing. True when left out. */
  canEdit?: boolean;
  /** A message `save` reports after this render, as it does between renders. */
  report?: string;
};

/** One grid, as ShipmentOrderPanel.tsx writes each of its three: the message's state first, then
 *  the hook, handed that state's setter. */
function Grid({ steps }: { steps: Step[] }) {
  const [message, setMessage] = useState<string | null>(null);
  const [at, setAt] = useState(0);
  const step = steps[at];
  useMessageClearedAtRest(gridAtRest(step.dirty, step.canEdit ?? true), setMessage);
  // Written after the hook's call, so it lands after anything the hook cleared in this pass.
  if (step.report !== undefined && at < steps.length - 1) setMessage(step.report);
  if (at < steps.length - 1) setAt(at + 1);
  return <output>{message}</output>;
}

/** The message under the grid after the last step, or null for none. */
function shown(...steps: Step[]): string | null {
  const html = renderToStaticMarkup(<Grid steps={steps} />);
  const text = /^<output>(.*)<\/output>$/.exec(html)?.[1];
  if (text === undefined) throw new Error(`Unexpected markup: ${html}`);
  return text === "" ? null : text;
}

const REFUSED = "Line 1: ship-now quantity must be a whole number of at least 0.";
const GONE = "This draft is no longer available to save.";
const DIRTY: Step = { dirty: true };
const CLEAN: Step = { dirty: false };
/** Not in editing mode: saved rows, no overlay, so `dirty` reads false. */
const SET_ASIDE: Step = { dirty: false, canEdit: false };

describe("gridAtRest", () => {
  it("is a grid open for editing with no unsaved edits, and nothing else", () => {
    expect(gridAtRest(false, true)).toBe(true);
    // Unsaved edits on screen.
    expect(gridAtRest(true, true)).toBe(false);
    // Not open for editing: the grid shows its saved rows with no overlay, so `dirty` reads false
    // while a recovery notice still holds what the operator typed.
    expect(gridAtRest(false, false)).toBe(false);
    expect(gridAtRest(true, false)).toBe(false);
  });
});

describe("cameToRest", () => {
  it("is true only for a grid that was not at rest and now is", () => {
    expect(cameToRest(false, true)).toBe(true);
    // Still away from rest: a refused save leaves the grid dirty.
    expect(cameToRest(false, false)).toBe(false);
    // Still at rest: a message that arrives now is not cleared.
    expect(cameToRest(true, true)).toBe(false);
    // Leaving rest: the first keystroke after a message clears nothing.
    expect(cameToRest(true, false)).toBe(false);
  });
});

describe("useMessageClearedAtRest, under React's own state", () => {
  it("the script reaches the screen: a reported message is what the next render shows", () => {
    expect(shown(DIRTY)).toBeNull();
    expect(shown({ ...DIRTY, report: REFUSED }, DIRTY)).toBe(REFUSED);
  });

  it("leaves a refusal alone while the grid still has unsaved edits", () => {
    // A refused save leaves its grid dirty. Two more keystrokes, two more renders: still shown.
    expect(shown({ ...DIRTY, report: REFUSED }, DIRTY, DIRTY, DIRTY)).toBe(REFUSED);
  });

  it("clears it when the saved value is typed back, and the grid has no unsaved edits left", () => {
    expect(shown({ ...DIRTY, report: REFUSED }, DIRTY, CLEAN)).toBeNull();
    expect(shown({ ...DIRTY, report: REFUSED }, DIRTY, CLEAN, CLEAN)).toBeNull();
  });

  it("shows a message that arrives on a grid already at rest, and keeps it there", () => {
    expect(shown({ ...CLEAN, report: GONE }, CLEAN)).toBe(GONE);
    expect(shown({ ...CLEAN, report: GONE }, CLEAN, CLEAN)).toBe(GONE);
  });

  it("clears once per arrival at rest: a message that comes after the clear shows", () => {
    expect(shown({ ...DIRTY, report: REFUSED }, DIRTY, { ...CLEAN, report: GONE }, CLEAN)).toBe(GONE);
    expect(shown({ ...DIRTY, report: REFUSED }, DIRTY, { ...CLEAN, report: GONE }, CLEAN, CLEAN)).toBe(GONE);
  });

  it("clears nothing when the grid becomes dirty, and clears when it is clean again", () => {
    expect(shown({ ...CLEAN, report: GONE }, CLEAN, DIRTY)).toBe(GONE);
    expect(shown({ ...CLEAN, report: GONE }, CLEAN, DIRTY, CLEAN)).toBeNull();
  });

  it("a save whose outcome is unknown: the failure shows though the grid has left editing, and stays while the draft is kept", () => {
    // The grid leaves editing before `save` reports the failure, and its recovery notice holds the edits.
    expect(shown(DIRTY, { ...SET_ASIDE, report: "Failed to fetch" }, SET_ASIDE)).toBe("Failed to fetch");
    // The notice is answered and the draft kept: editing again, still unsaved.
    expect(shown(DIRTY, { ...SET_ASIDE, report: "Failed to fetch" }, SET_ASIDE, DIRTY)).toBe("Failed to fetch");
    // Then saved, discarded or typed back.
    expect(shown(DIRTY, { ...SET_ASIDE, report: "Failed to fetch" }, SET_ASIDE, DIRTY, CLEAN)).toBeNull();
  });

  it("a save whose outcome is unknown: the failure goes when the notice is answered and nothing unsaved is left", () => {
    // Open for editing again with no overlay: `dirty` was false throughout, and only `canEdit` moved.
    expect(shown(DIRTY, { ...SET_ASIDE, report: "Failed to fetch" }, SET_ASIDE, CLEAN)).toBeNull();
  });
});
