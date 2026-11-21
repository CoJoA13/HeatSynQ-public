import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createDraftStore, type Adapter } from "../src/lib/draft-store";
import { DraftRecoveryNotice } from "../src/components/DraftRecoveryNotice";
const adapter: Adapter<string, string, string, string> = {
  kind: "readonly-notice", schema: "1", valid: (d, b) => typeof d === "string" && typeof b === "string",
  dirty: (d, b) => d !== b, baselineEqual: (a, b) => a === b,
  reconcileRead: ({ current }) => ({ data: current.data, baseline: current.baseline }),
  preview: d => [{ label: "Raw value", value: d }], settle: ({ current }) => ({ kind: "keep", data: current.data, baseline: current.baseline, needsRefresh: false }),
};
function fixture(dirty: boolean, readonly = true) {
  let failValidation = false;
  const localAdapter = { ...adapter, valid: (d: string, b: string) => !failValidation && adapter.valid(d, b) };
  const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
  const binding = store.bind({ owner, record: { kind: "readonly-test", id: "one" }, editor: adapter.kind }, { label: "Section", href: "/one" }, localAdapter);
  binding.attach("view"); binding.acceptRead({ kind: "authorized", readId: binding.beginRead(), baseline: "Saved value", editable: true }, "Saved value");
  if (dirty) binding.change(() => "  Retained raw value  ");
  if (readonly) binding.acceptRead({ kind: "authorized", readId: binding.beginRead(), baseline: "Saved value", editable: false }, "Saved value");
  function render() {
    const v = binding.getSnapshot();
    return renderToStaticMarkup(<><output aria-label="Saved value">{v.savedBaseline}</output><DraftRecoveryNotice mode={v.mode} canRestore={v.canRestore}
      hasCurrent={!!v.current} hasReference={!!v.reference}
      submittedPreview={v.submitted ? adapter.preview(v.submitted.data, v.submitted.baseline) : undefined}
      currentPreview={v.current ? adapter.preview(v.current.data, v.current.baseline) : undefined}
      referencePreview={v.reference ? adapter.preview(v.reference.data, v.reference.baseline) : undefined}
      restore={() => {}} discard={() => { if (v.current) binding.discard(v.current.stamp); }}
      discardReference={() => { if (v.reference) binding.discard(v.reference.stamp); }} retryRead={() => {}} /></>);
  }
  return { store, binding, render, failValidation: () => { failValidation = true; } };
}
describe("readonly presentation distinguishes saved state from retained work", () => {
  it("clean readonly saved data does not claim a conflict or an earlier unsaved copy", () => {
    const h = fixture(false); expect(h.store.getSnapshot().count).toBe(0);
    expect(h.binding.getSnapshot().savedBaseline).toBe("Saved value");
    const html = h.render(); expect(html).toContain("Saved value");
    expect(html).not.toContain("Earlier copy"); expect(html).not.toContain("Retained changes");
    expect(html).not.toContain("The saved record changed"); expect(html).not.toContain("Dismiss earlier copy");
    expect(html).not.toContain("Discard retained changes");
  });
  it("genuinely retained readonly work remains selectable and stamped-discardable without Restore", () => {
    const h = fixture(true); expect(h.store.getSnapshot().count).toBe(1);
    const view = h.binding.getSnapshot(); expect(view.savedBaseline).toBe("Saved value"); expect(view.canRestore).toBe(false);
    const html = h.render(); expect(html).toContain("  Retained raw value  "); expect(html).toContain("Saved value");
    expect(html).not.toContain(">Restore</button>");
    const retained = view.reference ?? view.current; expect(retained).toBeDefined();
    expect(html).toMatch(/Dismiss earlier copy|Discard retained changes/);
    h.binding.discard(retained!.stamp); expect(h.store.getSnapshot().count).toBe(0);
    expect(h.binding.getSnapshot().savedBaseline).toBe("Saved value");
  });
});

for (const outcome of ["pending", "unknown"] as const) it(`readonly ${outcome} keeps the captured submission when current input is clean again`, () => {
  const h = fixture(true, false); const submitted = h.binding.capture("  Retained raw value  ", "request");
  expect(h.binding.dispatched(submitted)).toBe(true); h.binding.change(() => "Saved value");
  if (outcome === "unknown") h.binding.settle(submitted, { kind: "unknown" });
  h.binding.acceptRead({ kind: "authorized", readId: h.binding.beginRead(), baseline: "Saved value", editable: false }, "Saved value");
  const view = h.binding.getSnapshot(); expect(view.mode).not.toBe("editing"); expect(view.canRestore).toBe(false);
  expect(view.submitted?.data).toBe("  Retained raw value  "); expect(view.reference ?? view.current).toBeDefined();
  expect(h.render()).toContain("Originally submitted"); expect(h.render()).toContain("  Retained raw value  ");
});
it("readonly invalid-snapshot error keeps original copy metadata without exposing invalid preview", () => {
  const h = fixture(false); const before = h.binding.getSnapshot(); h.failValidation();
  h.binding.acceptRead({ kind: "authorized", readId: h.binding.beginRead(), baseline: "Saved value", editable: false }, "Saved value");
  const view = h.binding.getSnapshot(); expect(view.mode).toBe("error");
  expect(view.reference ?? view.current).toBeDefined(); expect((view.reference ?? view.current)?.data).toBe("Saved value");
  expect(view.canRestore).toBe(false); expect(h.render()).not.toContain("Earlier copy");
  expect(view.savedBaseline).not.toBe(before.savedBaseline);
});
it("clean readonly remains noneditable and never exposes current or reference stamps", () => {
  const h = fixture(false); const view = h.binding.getSnapshot();
  expect(view.mode).toBe("conflict"); expect(view.current).toBeUndefined(); expect(view.reference).toBeUndefined();
  expect(() => h.binding.capture("Saved value", "forbidden")).toThrow();
});
it("a readonly completed receipt remains completed and leaves presentation to its owning editor", () => {
  const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
  const receiptAdapter: Adapter<string, string, string, string, string> = {
    ...adapter, settle: ({ outcome }) => outcome.kind === "persisted" ? { kind: "retire", completed: outcome.response } : { kind: "retire" },
  };
  const binding = store.bind({ owner, record: { kind: "receipt", id: "one" }, editor: receiptAdapter.kind }, { label: "Creation", href: "/new" }, receiptAdapter);
  binding.attach("view"); binding.acceptRead({ kind: "authorized", readId: binding.beginRead(), baseline: "saved", editable: true }, "saved");
  binding.change(() => "creation"); const submitted = binding.capture("creation", "request"); expect(binding.dispatched(submitted)).toBe(true);
  binding.settle(submitted, { kind: "persisted", response: "Created shipment 101" });
  binding.acceptRead({ kind: "authorized", readId: binding.beginRead(), baseline: "saved", editable: false }, "saved");
  const view = binding.getSnapshot(); expect(view.mode).toBe("completed"); expect(view.completed).toBe("Created shipment 101"); expect(view.completedStamp).toBeDefined();
  expect(renderToStaticMarkup(<DraftRecoveryNotice mode={view.mode} canRestore={false} hasCurrent={!!view.current} hasReference={!!view.reference} restore={() => {}} discard={() => {}} retryRead={() => {}} />)).toBe("");
});
