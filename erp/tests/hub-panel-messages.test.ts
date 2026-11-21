// P6 step 5a: ruling R1 (owner, 2026-10-22) on the order hub. Each grid section reports its
// refusals under its own Save row through the shared `PanelMessage`, the shipment page's shape
// (#472): a message slot of its own, cleared when its grid comes to rest (`useMessageClearedAtRest`,
// src/lib/grid-message.ts). The Lines section holds one slot of its own for its boxes, Remove, Add
// rider and the quote re-pick, with no at-rest clearing (it has no bulk grid, and a Not saved box
// keeps its registration). Link and Unlink report under the Link row. The page banner keeps the
// page-level actions (Void) and the Overview and Notes blur-saves.
//
// vitest has no renderer for these sections, so the wiring is read from each component's parsed
// source: the slot is the component's own state, not a prop, and it is drawn.
import { describe, expect, it } from "vitest";
import { clearedAtRest, component, nestedFunction, panelMessages, propNames, stateSlots } from "./helpers/panel-slots";

const GRIDS = [
  ["app/orders/[id]/ChargesSection.tsx", "ChargesSection"],
  ["app/orders/[id]/ContainersSection.tsx", "ContainersSection"],
  ["app/orders/[id]/LoadsSection.tsx", "LoadsSection"],
  ["app/orders/[id]/SerialsSection.tsx", "LineSerialsEditor"],
] as const;

describe("the hub's grid sections report under their own Save row (R1, P6 step 5a)", () => {
  for (const [path, name] of GRIDS) {
    it(`${name}: its own slot, drawn, and cleared when its grid comes to rest`, () => {
      const { file, fn } = component(path, name);
      expect(propNames(fn)).not.toContain("onError");
      // The setter keeps the name `onError`, as the shipment page's grids do, so every call in the
      // section and every test that lifts one of its handlers reads it unchanged.
      expect(stateSlots(fn, file)).toContainEqual(["saveMessage", "onError"]);
      expect(panelMessages(fn, file)).toEqual(["saveMessage"]);
      expect(clearedAtRest(fn, file)).toEqual([["gridAtRest(grid.dirty, grid.canEdit)", "onError"]]);
    });
  }
  it("SerialsSection hands no message setter to its line editors", () => {
    const { fn } = component("app/orders/[id]/SerialsSection.tsx", "SerialsSection");
    expect(propNames(fn)).not.toContain("onError");
  });
});

describe("the Lines section holds its own slot (R1, P6 step 5a)", () => {
  const { file, fn } = component("app/orders/[id]/LinesSection.tsx", "LinesSection");
  it("the slot is the section's state, drawn once, and never cleared at rest", () => {
    expect(propNames(fn)).not.toContain("onError");
    expect(stateSlots(fn, file)).toContainEqual(["linesMessage", "onError"]);
    expect(panelMessages(fn, file)).toEqual(["linesMessage"]);
    expect(clearedAtRest(fn, file)).toEqual([]);
  });
});

describe("the hub page keeps its banner for page-level actions (R1, P6 step 5a)", () => {
  const { file, fn } = component("app/orders/[id]/page.tsx", "OrderHub");
  const body = fn.getText(file);
  it("Link and Unlink report under the Link row, never the banner", () => {
    expect(stateSlots(fn, file)).toContainEqual(["linkMessage", "setLinkMessage"]);
    expect(panelMessages(fn, file)).toEqual(["linkMessage"]);
    for (const action of ["linkAction", "unlinkAction"]) {
      const text = nestedFunction(fn, file, action);
      expect(text, action).toContain("setLinkMessage(");
      expect(text, action).not.toContain("setError(");
    }
  });
  it("Void still writes the banner", () => {
    expect(body).toMatch(/function voidAction[\s\S]*setError\(/);
  });
});
