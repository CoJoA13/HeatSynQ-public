// P6 step 5b: ruling R1 (owner, 2026-10-22) on the invoice and the receipt batch. A grid's, a row's
// and a section's refusals show beside their control through the shared `PanelMessage`; the page
// banner keeps the page-level actions (Print, Unlock, Discard, Post, Void) and the page's reads.
//
//   - The invoice lines grid reports under its Save row, cleared when the grid comes to rest.
//   - Recalculate and Finalize report under their own buttons.
//   - The receipt batch's Apply panel reports inside its expanded row, cleared at rest.
//   - Add payment reports under its form.
//
// The header blur-saves stay on the banner: their placement is the question 5c takes to the owner.
// The Close screen's rows already report through `PanelMessage` (#649).
import { describe, expect, it } from "vitest";
import { clearedAtRest, component, nestedFunction, panelMessages, propNames, stateSlots } from "./helpers/panel-slots";

const INVOICE = "app/invoicing/[id]/InvoiceDetail.tsx";
const BATCH = "app/receivables/batches/[id]/BatchDetail.tsx";

describe("the invoice (R1, P6 step 5b)", () => {
  it("the lines grid: its own slot, drawn, and cleared when its grid comes to rest", () => {
    const { file, fn } = component(INVOICE, "InvoiceLinesGrid");
    expect(propNames(fn)).not.toContain("onError");
    expect(stateSlots(fn, file)).toContainEqual(["saveMessage", "onError"]);
    expect(panelMessages(fn, file)).toEqual(["saveMessage"]);
    expect(clearedAtRest(fn, file)).toEqual([["gridAtRest(grid.dirty, grid.canEdit)", "onError"]]);
  });
  it("Recalculate and Finalize report under their buttons, never the banner", () => {
    const { file, fn } = component(INVOICE, "InvoiceDetail");
    expect(stateSlots(fn, file)).toContainEqual(["totalsMessage", "setTotalsMessage"]);
    expect(panelMessages(fn, file)).toEqual(["totalsMessage"]);
    for (const action of ["recalculate", "finalize"]) {
      const text = nestedFunction(fn, file, action);
      expect(text, action).toContain("setTotalsMessage(");
      expect(text, action).not.toContain("setError(");
    }
  });
  it("Unlock and Discard still write the banner", () => {
    const { file, fn } = component(INVOICE, "InvoiceDetail");
    for (const action of ["unlock", "discard"]) expect(nestedFunction(fn, file, action), action).toContain("setError(");
  });
});

describe("the receipt batch (R1, P6 step 5b)", () => {
  it("the Apply panel: its own slot, drawn, and cleared when its grid comes to rest", () => {
    const { file, fn } = component(BATCH, "ApplyPanel");
    expect(propNames(fn)).not.toContain("onError");
    expect(stateSlots(fn, file)).toContainEqual(["applyMessage", "onError"]);
    expect(panelMessages(fn, file)).toEqual(["applyMessage"]);
    expect(clearedAtRest(fn, file)).toEqual([["gridAtRest(grid.dirty, grid.canEdit)", "onError"]]);
  });
  it("Add payment reports under its form, never the banner", () => {
    const { file, fn } = component(BATCH, "BatchDetail");
    expect(stateSlots(fn, file)).toContainEqual(["addPaymentMessage", "setAddPaymentMessage"]);
    expect(panelMessages(fn, file)).toEqual(["addPaymentMessage"]);
    const text = nestedFunction(fn, file, "addPayment");
    expect(text).toContain("setAddPaymentMessage(");
    expect(text).not.toContain("setError(");
  });
  it("Post, Reopen and Void batch still write the banner", () => {
    const { file, fn } = component(BATCH, "BatchDetail");
    for (const action of ["postBatchAction", "reopenBatchAction", "voidBatchAction"]) {
      expect(nestedFunction(fn, file, action), action).toContain("setError(");
    }
  });
});
