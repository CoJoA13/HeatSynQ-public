import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDraftStore, type DraftStore } from "@/lib/draft-store";
import { EMPTY_DRAFT_SUMMARY } from "@/lib/draft-session";
import { scalarAdapter } from "./helpers/draft-store";
import { renderToStaticMarkup } from "react-dom/server";
import { DocumentsSection, TravelerProvider, TravelerPrintButton } from "@/app/orders/[id]/DocumentsSection";

vi.mock("next/navigation", () => ({
  usePathname: () => "/orders/order-1", useRouter: () => ({ replace: () => {} }),
}));
// Supply only the hook's browser-store binding for SSR; retained state and path/label
// selection use the real DraftStore. Task7 owns passive-effect and pre-POST lifecycle proof.
const drafts = vi.hoisted(() => ({ store: null as DraftStore | null }));
vi.mock("@/lib/use-recoverable-draft", async original => ({
  ...await original<typeof import("@/lib/use-recoverable-draft")>(),
  useDraftIdentity: () => { const s = drafts.store?.getSnapshot() ?? EMPTY_DRAFT_SUMMARY; return { store: drafts.store, owner: s.owner, identityReady: s.identityReady }; },
  useDraftStoreAnswer: <T,>(answer: (store: DraftStore) => T, fallback: T) => (drafts.store ? answer(drafts.store) : fallback),
}));
beforeEach(() => {
  drafts.store = createDraftStore();
  drafts.store.acceptIdentity(drafts.store.beginIdentityCheck(), "traveler-user");
});

function retain(label: string, id = "order-1") {
  const store = drafts.store!;
  const owner = store.getSnapshot().owner!;
  const binding = store.bind({ owner, record: { kind: "order", id }, editor: scalarAdapter.kind },
    { label, href: `/orders/${id}` }, scalarAdapter);
  const detach = binding.attach("leaving-view");
  const readId = binding.beginRead();
  binding.acceptRead({ kind: "authorized", readId, baseline: { value: "1905" }, editable: true }, { value: "1905" });
  binding.change(() => ({ value: "1888" }));
  detach();
}

const allowed = { allowed: true, disabled: false, title: undefined };
const loads = [
  { id: "load-1", loadNumber: 1, qty: 10, weight: 1 },
  { id: "load-2", loadNumber: 2, qty: 15, weight: 1.5 },
];
function render(voided = false) {
  return renderToStaticMarkup(<TravelerProvider orderId="order-1" loads={loads}
    voided={voided} viewGate={allowed} autoPrint={false}><DocumentsSection /></TravelerProvider>);
}
describe("traveler action scope", () => {
  it("names the entire set in the all-load action itself", () => {
    expect(render()).toMatch(/<button[^>]*>Print 2 travelers<\/button>/);
  });
  it("keeps archived history available but disables new printing on voided orders", () => {
    const html = render(true);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Print 2 travelers<\/button>/);
    // A static render runs no effect, so no archive read has landed: the list says "Loading…",
    // never "Nothing printed yet." (P6 step 3, #632 bug a).
    expect(html).toContain("Loading…");
    expect(html).not.toContain("Nothing printed yet.");
  });
  it("names saved-load targets and disables a target absent from the saved order", () => {
    const html = renderToStaticMarkup(<TravelerProvider orderId="order-1" loads={loads}
      voided={false} viewGate={allowed} autoPrint={false}>
      <TravelerPrintButton loadNumber={2} /><TravelerPrintButton loadNumber={99} />
    </TravelerProvider>);
    expect(html).toMatch(/<button(?![^>]* disabled="")[^>]*>Print Load 2 traveler<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Print Load 99 traveler<\/button>/);
  });
  it("applies denied viewing permission to both all-load and row actions", () => {
    const html = renderToStaticMarkup(<TravelerProvider orderId="order-1" loads={loads}
      voided={false} viewGate={{allowed:false,disabled:true,title:"Requires orders.view"}} autoPrint={false}>
      <TravelerPrintButton /><TravelerPrintButton loadNumber={1} />
    </TravelerProvider>);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain("Requires orders.view");
  });
  it.each([
    { voided: true, viewGate: allowed, reason: "Order is voided — stored prints stay available" },
    { voided: false, viewGate: { allowed: false, disabled: true, title: "Requires orders.view" }, reason: "Requires orders.view" },
  ])("prioritizes the order gate over an unsaved row: $reason", ({ voided, viewGate, reason }) => {
    const html = renderToStaticMarkup(<TravelerProvider orderId="order-1" loads={loads}
      voided={voided} viewGate={viewGate} autoPrint={false}>
      <TravelerPrintButton loadNumber={2} disabledReason="Save load changes first" />
    </TravelerProvider>);
    expect(html).toContain(`title="${reason}"`);
    expect(html).not.toContain('title="Save load changes first"');
    expect(html).toContain('disabled=""');
  });
  it("does not enable an unsaved row or empty load selection", () => {
    const html = renderToStaticMarkup(<TravelerProvider orderId="order-1" loads={loads}
      voided={false} viewGate={allowed} autoPrint={false}>
      <TravelerPrintButton loadNumber={2} disabledReason="Save load changes first" />
      <TravelerPrintButton loadNumber={null} />
    </TravelerProvider>);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });

  it("keeps saved-load manual actions available while a handoff awaits client-side resolution", () => {
    // SSR proves the manual recovery affordance only; it does not execute the print effect.
    const html = renderToStaticMarkup(<TravelerProvider orderId="order-1" loads={loads}
      voided={false} viewGate={allowed} autoPrint printIntentKey="missing-intent">
      <DocumentsSection /><TravelerPrintButton loadNumber={2} />
    </TravelerProvider>);
    expect(html).toMatch(/<button(?![^>]* disabled="")[^>]*>Print 2 travelers<\/button>/);
    expect(html).toMatch(/<button(?![^>]* disabled="")[^>]*>Print Load 2 traveler<\/button>/);
    expect(html).toContain('id="documents"');
  });

  it("keeps manual print controls disabled while permission readiness is unresolved", () => {
    const html = renderToStaticMarkup(<TravelerProvider orderId="order-1" loads={loads}
      voided={false} viewGate={{ allowed: false, disabled: true, title: "Requires orders.view" }}
      permissionsReady={false} autoPrint printIntentKey="pending-intent">
      <TravelerPrintButton /><TravelerPrintButton loadNumber={1} />
    </TravelerProvider>);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain("Requires orders.view");
  });

  it("disables both header and per-load printing before the browser draft store is bound", () => {
    drafts.store = null;
    const html = renderToStaticMarkup(<TravelerProvider orderId="order-1" loads={loads}
      voided={false} viewGate={allowed} autoPrint printIntentKey="pending-intent">
      <TravelerPrintButton /><TravelerPrintButton loadNumber={1} />
    </TravelerProvider>);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain("Checking retained drafts before printing");
  });

  it("does not treat identity-hidden retained loads as a clean print state", () => {
    retain("Loads");
    drafts.store!.beginIdentityCheck();
    expect(drafts.store!.getSnapshot().count).toBe(1);
    expect(drafts.store!.labelsForPath("/orders/order-1")).toEqual([]);
    const html = render();
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Print 2 travelers<\/button>/);
    expect(html).toContain("Checking retained drafts before printing");
  });

  it("blocks printing from a retained load draft before that editor is restored", () => {
    retain("Loads");
    const html = render();
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Print 2 travelers<\/button>/);
    // The whole sentence, one for every cause: a Not saved Qty or Weight and a removal the server
    // did not answer have no Save control, so the reason must also name their ways out, Restore and
    // Remove again.
    expect(html).toContain(
      'title="Save the changes first, restore a value marked Not saved, or press Remove again on a line marked Removal not confirmed — a print archives what the server holds"');
  });

  it("counts unsaved work labelled Lines against the print: a traveler carries the lines", () => {
    // The Lines section registers under this label while a Qty or Weight is marked Not saved or a
    // removal the server did not answer is marked Removal not confirmed. SSR reads the live registry
    // as empty (its server snapshot), so the retained-draft store carries the label here; both
    // readers are handed the same ignore list, which is what this pins.
    retain("Lines");
    const html = render();
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Print 2 travelers<\/button>/);
    expect(html).toContain("restore a value marked Not saved");
    expect(html).toContain("or press Remove again on a line marked Removal not confirmed");
  });

  it.each(["Serials", "Charges"])("keeps excluded retained %s outside print admission", label => {
    retain(label);
    expect(render()).toMatch(/<button(?![^>]* disabled="")[^>]*>Print 2 travelers<\/button>/);
  });

  it("does not block this order's print because another order has retained loads", () => {
    retain("Loads", "other-order");
    expect(render()).toMatch(/<button(?![^>]* disabled="")[^>]*>Print 2 travelers<\/button>/);
  });

});

// #487 (owner answer 2, 2026-10-16): the Single load list with no saved load to offer.
describe("the Single load list", () => {
  /** DocumentsSection over `given` loads. `drafts.store` is bound by `beforeEach`, so the print gate
   *  is the order's own unless the case says otherwise. */
  function documents(given: typeof loads, voided = false): string {
    return renderToStaticMarkup(<TravelerProvider orderId="order-1" loads={given}
      voided={voided} viewGate={allowed} autoPrint={false}><DocumentsSection /></TravelerProvider>);
  }
  /** The one select DocumentsSection draws: its opening tag. */
  function list(html: string): string {
    const found = html.match(/<select\b[^>]*>/g) ?? [];
    expect(found).toHaveLength(1);
    const tag = found[0] ?? "";
    expect(tag).toContain('aria-label="Load to print"');
    return tag;
  }

  it("with no saved load it is closed, and says to save one first", () => {
    const select = list(documents([]));
    expect(select).toContain('disabled=""');
    expect(select).toContain('title="Save a load first"');
  });

  it("with saved loads it is open, and untitled", () => {
    const select = list(documents(loads));
    expect(select).not.toContain('disabled=""');
    expect(select).not.toContain("title=");
  });

  it.each([{ saved: 0, given: [] }, { saved: 2, given: loads }])("on a voided order it keeps the order's reason, with $saved loads saved", ({ given }) => {
    const select = list(documents(given, true));
    expect(select).toContain('disabled=""');
    expect(select).toContain('title="Order is voided — stored prints stay available"');
  });

  it("before the browser draft store is bound it keeps the print gate's reason, with no load saved too", () => {
    drafts.store = null;
    expect(list(documents([]))).toContain('title="Checking retained drafts before printing"');
  });
});
