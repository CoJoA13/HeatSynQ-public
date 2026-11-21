import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ShipmentOrderPanel } from "../src/app/shipping/[id]/ShipmentOrderPanel";
import { api } from "../src/lib/fetcher";
import { createDraftStore, type EditorView } from "../src/lib/draft-store";
import { createBulkRecoveryAdapter, emptyBulkDraft, transitionBulkDraft, bulkRecoveryPreviews, type BulkBaseline, type BulkDraft, type BulkRecoveryCustomization } from "../src/lib/bulk-grid-recovery";
import { shipmentBulkOptions, shipmentBulkCustomization, shipmentLinesBaseline, shipmentContainersBaseline, shipmentSerialsBaseline, type ShipmentGridKind } from "../src/lib/shipment-bulk-recovery";
import { NO_REPORTS, savedShipmentTotalsInput, shipmentTotals } from "../src/lib/shipment-totals";
import { shipmentFixture } from "./helpers/remaining-bulk-fixtures";
import { openDraftHarness } from "./helpers/draft-store";

type Fields = Record<string, string>;
const rendered = vi.hoisted(() => ({ views: [] as unknown[], index: 0 }));
// Only the SSR subscription seam is supplied. The panel, useBulkGrid composition,
// domain projection, inputs, candidates, and recovery notice are production code.
vi.mock("../src/lib/use-recoverable-draft", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/use-recoverable-draft")>(),
  useRecoverableDraft: () => rendered.views[rendered.index++],
}));
vi.mock("../src/lib/fetcher", async importOriginal => ({ ...await importOriginal<typeof import("../src/lib/fetcher")>(), api: vi.fn() }));
const kinds = ["lines", "containers", "serials"] as const;
function adapter(kind: ShipmentGridKind) {
  return createBulkRecoveryAdapter<Fields>(`shipment-${kind}`, `shipment-${kind}-v1`, shipmentBulkCustomization(kind) as BulkRecoveryCustomization<Fields>);
}
function project(kind: ShipmentGridKind, fixture = shipmentFixture()): BulkBaseline<Fields> {
  return (kind === "lines" ? shipmentLinesBaseline : kind === "containers" ? shipmentContainersBaseline : shipmentSerialsBaseline)(fixture, "so-1");
}
async function open(permissions: string[]) {
  const fixture = shipmentFixture(); fixture.permissions = permissions;
  const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "shipping-clerk")!;
  const source = { read: async () => ({ record: fixture.shipper, access: fixture.permissions }), register: vi.fn(), begin: vi.fn() };
  const entries = [];
  for (const kind of kinds) {
    const options = shipmentBulkOptions(source, "ship-1", "so-1", kind);
    const subject = adapter(kind);
    const binding = store.bind({ owner, record: options.record, editor: options.kind, childId: "so-1" }, { label: options.label, href: options.href! }, subject);
    const detach = binding.attach("initial"); const readId = binding.beginRead();
    // This is the actual shipping binding reader; failure must not be swallowed
    // into an invented authorized fixture in a clean-access regression.
    const read = await options.read(); binding.acceptRead({ kind: "authorized", readId, ...read }, emptyBulkDraft<Fields>());
    entries.push({ kind, options, binding, subject, detach, readId, read });
  }
  return { fixture, store, source, entries };
}
function render(h: Awaited<ReturnType<typeof open>>, editable: boolean) {
  rendered.views = h.entries.map(e => e.binding.getSnapshot()); rendered.index = 0;
  const gate = { allowed: editable, disabled: !editable, title: undefined };
  return renderToStaticMarkup(<ShipmentOrderPanel shipperId="ship-1" order={h.fixture.shipper.orders[0]} recoverySource={h.source}
    editGate={gate} linesGate={gate} creditHoldReason="" applyMutation={async run => { await run(); }} onRemove={() => {}}
    printGate={gate} printing={false} certsGate={gate} onPrintTicket={() => {}} totals={shipmentTotals(savedShipmentTotalsInput(h.fixture.shipper.orders, NO_REPORTS)).orders[0]} onTotalsReport={() => {}} />);
}
function control(html: string, label: string) {
  const tag = (html.match(/<(?:input|select)\b[^>]*>/g) ?? []).find(tag => tag.includes(`aria-label="${label}"`));
  expect(tag, label).toBeDefined(); return tag!;
}
function savedDisplay(html: string) {
  for (const label of ["P-10", "Shaft", "P-20", "Pin", "Box", "B-10", "Drum", "D-20", "S001", "Blue", "S002", "Red"]) expect(html).toContain(label);
  expect(control(html, "Line 1 ship-now quantity")).toContain('value="2"');
  expect(control(html, "Line 1 ship-now weight")).toContain('value="4"');
  expect(control(html, "Container 1 count")).toContain('value="2"');
  // The shipment row's own figure. The order's row in the fixture holds 55.
  expect(control(html, "Container 1 tare each")).toContain('value="42.5"');
  expect(control(html, "Serial 1 print on ticket")).toContain('checked=""');
}
function noAdds(html: string) {
  for (const label of ["Add line", "Add container", "Add serial"]) expect(control(html, label)).toContain('disabled=""');
  expect(html).not.toMatch(/<option value="(?:ol-|oc-|os-)/);
  // Every viewer in this file lacks orders.view, so each picker is empty because the order's catalog
  // was never read, and the text beside it names the permission (#472). The sentence for a catalog
  // that was read and is all on the shipment is pinned in shipment-grid-titles.test.tsx.
  // C7a (#239) still holds: the reason is TEXT beside the picker, never the empty <option> doing
  // double duty as a status sentence.
  expect(html.split('<span class="text-sm text-ink-500">Requires orders.view</span>')).toHaveLength(4);
  expect(html).not.toContain(">Requires orders.view</option>");
  expect(html).not.toContain("Every order");
}
describe("ordinary shipment access stays independent of catalog recovery", () => {
  it("shipping.view alone displays all actual saved rows and metadata, with readonly controls and no order fetch", async () => {
    vi.mocked(api).mockClear(); const h = await open(["shipping.view"]);
    const html = render(h, false); savedDisplay(html); noAdds(html);
    for (const label of ["Line 1 ship-now quantity", "Container 1 count", "Container 1 tare each", "Serial 1 print on ticket"]) expect(control(html, label)).toContain('disabled=""');
    expect(h.store.getSnapshot().count).toBe(0); expect(api).not.toHaveBeenCalled();
  });
  it("shipping.edit preserves actual existing-row edits, while removed saved rows never become Add candidates", async () => {
    vi.mocked(api).mockClear(); const h = await open(["shipping.view", "shipping.edit"]);
    const first = render(h, true); savedDisplay(first); noAdds(first);
    for (const label of ["Line 1 ship-now quantity", "Container 1 count", "Container 1 tare each", "Serial 1 print on ticket"]) expect(control(first, label)).not.toContain('disabled=""');
    for (const [index, entry] of h.entries.entries()) {
      expect(entry.binding.getSnapshot().mode).toBe("editing");
      const base = entry.binding.getSnapshot().current!.baseline;
      const patch = index === 0 ? { weight: "  invalid raw  " } : index === 1 ? { count: "3" } : { printOnShipper: "false" };
      entry.binding.change(d => transitionBulkDraft(d, base, { kind: "edit", id: base.rows[0].id, patch }));
      entry.binding.change(d => transitionBulkDraft(d, base, { kind: "remove-existing", id: base.rows[1].id }));
      expect(entry.binding.getSnapshot().current!.data.edits.get(base.rows[0].id)).toEqual(patch);
      expect(entry.binding.capture({ explicit: "ordinary save" }, `capture-${index}`).submitted.data.edits.size).toBe(1);
    }
    const edited = render(h, true); noAdds(edited);
    expect(control(edited, "Line 1 ship-now weight")).toContain('value="  invalid raw  "');
    expect(control(edited, "Container 1 count")).toContain('value="3"');
    expect(control(edited, "Serial 1 print on ticket")).not.toContain('checked=""');
    expect(h.store.getSnapshot().count).toBe(3); expect(api).not.toHaveBeenCalled();
  });
  it("a retained shipping-only copy cannot Restore even with an equal fresh baseline; Start fresh keeps it hidden and stamped Discard works", async () => {
    vi.mocked(api).mockClear(); const h = await open(["shipping.view", "shipping.edit"]);
    for (const entry of h.entries) {
      const base = entry.binding.getSnapshot().current!.baseline;
      entry.binding.change(d => transitionBulkDraft(d, base, { kind: "remove-existing", id: base.rows[0].id }));
      const stamp = entry.binding.getSnapshot().current!.stamp;
      entry.detach(); entry.binding.attach("return"); const readId = entry.binding.beginRead();
      entry.binding.acceptRead({ kind: "authorized", readId, ...await entry.options.read() }, emptyBulkDraft<Fields>());
      expect(entry.binding.getSnapshot().mode).toBe("conflict"); expect(entry.binding.getSnapshot().canRestore).toBe(false);
      expect(entry.binding.restore(stamp, readId)).toBe(false);
      expect(bulkRecoveryPreviews(entry.subject, entry.binding.getSnapshot())).toEqual({});
      expect(entry.binding.startFresh(readId, emptyBulkDraft<Fields>())).toBe(true);
      expect(entry.binding.getSnapshot().mode).toBe("editing"); expect(entry.binding.getSnapshot().reference!.stamp).toBe(stamp);
      const valid = vi.spyOn(entry.subject, "valid"); const preview = vi.spyOn(entry.subject, "preview");
      expect(bulkRecoveryPreviews(entry.subject, entry.binding.getSnapshot())).toEqual({});
      expect(valid).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled();
      entry.binding.discard(stamp); expect(entry.binding.getSnapshot().reference).toBeUndefined();
    }
    expect(h.store.getSnapshot().count).toBe(0); noAdds(render(h, true)); expect(api).not.toHaveBeenCalled();
  });
  it("revoking catalog access on return displays fresh shipping rows, hides old catalog labels, and refuses stale authorization", async () => {
    vi.mocked(api).mockClear(); const h = await open(["shipping.view", "shipping.edit"]);
    for (const entry of h.entries) {
      const full = project(entry.kind);
      const display = full.context.display as Record<string, Record<string, unknown>[]>;
      for (const row of display[entry.kind]) for (const field of ["partNumber", "partName", "typeName", "customerContainerId", "serial", "description"]) if (field in row) row[field] = "OLD CATALOG SECRET";
      entry.binding.acceptRead({ kind: "authorized", readId: entry.binding.beginRead(), baseline: full, editable: true, recoveryAllowed: true }, emptyBulkDraft<Fields>());
      entry.binding.change(d => transitionBulkDraft(d, full, { kind: "remove-existing", id: full.rows[0].id }));
      entry.detach(); entry.binding.attach("returned");
    }
    const check = h.store.beginIdentityCheck(); h.store.acceptIdentity(check, "shipping-clerk");
    for (const entry of h.entries) {
      const stale = entry.binding.beginRead(); const current = entry.binding.beginRead();
      entry.binding.acceptRead({ kind: "authorized", readId: current, ...await entry.options.read() }, emptyBulkDraft<Fields>());
      expect(entry.binding.acceptRead({ kind: "authorized", readId: stale, baseline: project(entry.kind), editable: true, recoveryAllowed: true }, emptyBulkDraft<Fields>())).toBe(false);
      expect(entry.binding.getSnapshot().canRestore).toBe(false);
      expect(bulkRecoveryPreviews(entry.subject, entry.binding.getSnapshot())).toEqual({});
    }
    const html = render(h, true); savedDisplay(html); noAdds(html);
    expect(html).not.toContain("OLD CATALOG SECRET"); expect(html).not.toContain(">Restore</button>");
    expect(control(html, "Container 1 count")).toContain('disabled=""');
    expect(h.store.getSnapshot().count).toBe(3); expect(api).not.toHaveBeenCalled();
  });
  it("a still-mounted shipping-only edit accepts a fresh native saved value without catalog permission", async () => {
    const h = await open(["shipping.view", "shipping.edit"]); const entry = h.entries[1];
    const base = entry.binding.getSnapshot().current!.baseline;
    entry.binding.change(d => transitionBulkDraft(d, base, { kind: "edit", id: base.rows[0].id, patch: { count: "3" } }));
    h.fixture.shipper.orders[0].containers[1].count = 7;
    const readId = entry.binding.beginMountedRead(); expect(readId).not.toBeNull();
    entry.binding.acceptRead({ kind: "authorized", readId: readId!, ...await entry.options.read() }, emptyBulkDraft<Fields>());
    expect(entry.binding.getSnapshot().mode).toBe("editing");
    expect(entry.binding.getSnapshot().current!.data.edits.get("sc-1")).toEqual({ count: "3" });
    expect(entry.binding.getSnapshot().current!.baseline.rows[1].fields.count).toBe("7");
  });
  it("a stamped recovery restriction preserves pending settlement and blocks unknown retry", () => {
    const subject = { ...adapter("containers"), allowUnknownRetry: true };
    const base = project("containers");
    const h = openDraftHarness(subject, emptyBulkDraft<Fields>(), base);
    h.binding.change(d => transitionBulkDraft(d, base, { kind: "edit", id: base.rows[0].id, patch: { count: "3" } }));
    const submission = h.binding.capture({ containers: [{ count: 3 }] }, "request");
    expect(h.binding.dispatched(submission)).toBe(true);
    h.detach(); h.binding.attach("returned"); const readId = h.binding.beginRead();
    h.binding.acceptRead({ kind: "authorized", readId, baseline: base, editable: true, recoveryAllowed: false }, emptyBulkDraft<Fields>());
    expect(h.binding.getSnapshot().mode).toBe("pending");
    expect(h.binding.getSnapshot().submitted).toBe(submission.submitted);
    expect(bulkRecoveryPreviews(subject, h.binding.getSnapshot())).toEqual({});
    h.binding.settle(submission, { kind: "unknown" });
    expect(h.binding.getSnapshot().mode).toBe("unknown");
    const stamp = h.binding.getSnapshot().current!.stamp;
    expect(h.binding.prepareUnknownRetry(stamp, readId, "forbidden-retry")).toBeNull();
    expect(h.binding.getSnapshot().current!.data.edits.get("sc-1")).toEqual({ count: "3" });
    h.binding.discard(stamp); expect(h.store.getSnapshot().count).toBe(0);
    expect(h.binding.getSnapshot().mode).toBe("editing");
  });
  it("forbidden retained previews stay hidden in pending and unknown views without invoking validation or presentation", () => {
    const subject = adapter("lines"); const preview = vi.spyOn(subject, "preview"); const valid = vi.spyOn(subject, "valid");
    for (const mode of ["offer", "conflict", "pending", "unknown", "blocked-two-copies", "editing"] as const) {
      const view = { mode, canRestore: false, needsRefresh: false, recoveryAllowed: false,
        current: { data: emptyBulkDraft<Fields>(), baseline: project("lines") },
        reference: { data: emptyBulkDraft<Fields>(), baseline: project("lines") },
        submitted: { data: emptyBulkDraft<Fields>(), baseline: project("lines") },
      } as EditorView<BulkDraft<Fields>, BulkBaseline<Fields>, never>;
      expect(bulkRecoveryPreviews(subject, view), mode).toEqual({});
    }
    expect(valid).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled();
  });
});
