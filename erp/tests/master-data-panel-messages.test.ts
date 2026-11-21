// P6 step 5c: ruling R1 (owner, 2026-10-22) on the part and customer pages. Each section below
// holds its own message, drawn through the shared `PanelMessage` inside the section, where it used
// to write the page banner: its own reads, its saves and its row actions alike. None of them is a
// bulk grid, so none clears at rest; a section's success clears its own message.
//
// The part's Identity section is not here: its boxes are the header's blur-saves, which the owner
// ruled on 2026-10-28 stay on the page banner (as do the hub's Overview and Notes, the invoice
// header and the customer header). It is the census's one standing entry.
import { describe, expect, it } from "vitest";
import { clearedAtRest, component, panelMessages, propNames, stateSlots } from "./helpers/panel-slots";

const SECTIONS = [
  ["app/parts/[id]/SpecsSection.tsx", "SpecsSection"],
  ["app/parts/[id]/InspectionsSection.tsx", "InspectionsSection"],
  ["app/parts/[id]/PricingSection.tsx", "PricingSection"],
  ["app/parts/[id]/CustomFieldsSection.tsx", "CustomFieldsSection"],
  ["app/parts/[id]/ProcessStepsSection.tsx", "ProcessStepsSection"],
  ["app/customers/[id]/SurchargeOverridesSection.tsx", "SurchargeOverridesSection"],
  ["app/customers/[id]/TemplateAssignmentsSection.tsx", "TemplateAssignmentsSection"],
] as const;

describe("the part's and the customer's sections report inside themselves (R1, P6 step 5c)", () => {
  for (const [path, name] of SECTIONS) {
    it(`${name}: its own slot, drawn, never cleared at rest`, () => {
      const { file, fn } = component(path, name);
      expect(propNames(fn)).not.toContain("onError");
      // The setter keeps the name `onError` the section's handlers and the tests that lift them read.
      expect(stateSlots(fn, file)).toContainEqual(["sectionMessage", "onError"]);
      expect(panelMessages(fn, file)).toEqual(["sectionMessage"]);
      expect(clearedAtRest(fn, file)).toEqual([]);
    });
  }
});
