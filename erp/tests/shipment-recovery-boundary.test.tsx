import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DraftRecoveryNotice } from "../src/components/DraftRecoveryNotice";
import { bulkRecoveryPreviews, createBulkRecoveryAdapter, emptyBulkDraft, type BulkBaseline, type BulkRecoveryCustomization } from "../src/lib/bulk-grid-recovery";
import { shipmentBulkCustomization, shipmentLinesBaseline, shipmentContainersBaseline, shipmentSerialsBaseline, type ShipmentGridKind } from "../src/lib/shipment-bulk-recovery";
import { openDraftHarness } from "./helpers/draft-store";
import { shipmentFixture } from "./helpers/remaining-bulk-fixtures";

type Fields = Record<string, string>;
const cases = [
  { kind: "lines", project: shipmentLinesBaseline, field: "weight", raw: "  invalid weight  ", displayField: "partNumber" },
  { kind: "containers", project: shipmentContainersBaseline, field: "count", raw: "  invalid count  ", displayField: "typeName" },
  { kind: "serials", project: shipmentSerialsBaseline, field: "printOnShipper", raw: "false", displayField: "serial" },
] as const;
function adapter(kind: ShipmentGridKind) {
  return createBulkRecoveryAdapter<Fields>(`shipment-${kind}`, `shipment-${kind}-v1`, shipmentBulkCustomization(kind) as BulkRecoveryCustomization<Fields>);
}
function corrupt(base: BulkBaseline<Fields>, kind: ShipmentGridKind, damage: string) {
  // Runtime malformed input is intentional; ordinary production types cannot express it.
  const writable = base as unknown as { rows: { fields: Fields }[]; context: { display: Record<string, unknown>; catalog: unknown } };
  if (damage === "array") writable.context.display[kind] = "invalid";
  else if (damage === "item") writable.context.display[kind] = [null];
  else if (damage === "field") writable.context.display[kind] = [{ id: "parent", partNumber: 7, typeName: false, serial: null }];
  else if (damage === "writer-catalog") writable.context.catalog = "invalid";
  else writable.rows[0].fields = {};
}
describe("shipment domain validation at store transitions", () => {
  for (const scenario of cases) {
    for (const damage of ["array", "item", "field", "writer-catalog", "writer-fields"]) it(`${scenario.kind}: malformed retained ${damage} becomes error and remains stamp-discardable`, () => {
      const base: BulkBaseline<Fields> = scenario.project(shipmentFixture(), "so-1");
      const subject = adapter(scenario.kind);
      const h = openDraftHarness(subject, emptyBulkDraft<Fields>(), base);
      h.binding.change(d => ({ ...d, edits: new Map([[base.rows[0].id, { [scenario.field]: scenario.raw }]]) }));
      const stamp = h.binding.getSnapshot().current!.stamp;
      h.detach(); corrupt(base, scenario.kind, damage);
      h.binding.attach("returned"); const readId = h.binding.beginRead();
      const fresh = scenario.project(shipmentFixture(), "so-1");
      h.binding.acceptRead({ kind: "authorized", readId, baseline: fresh, editable: true }, emptyBulkDraft<Fields>());
      const view = h.binding.getSnapshot();
      expect(view.mode).toBe("error"); expect(view.canRestore).toBe(false);
      expect(view.current!.stamp).toBe(stamp); expect(h.binding.restore(stamp, readId)).toBe(false);
      const valid = vi.spyOn(subject, "valid"); const preview = vi.spyOn(subject, "preview");
      expect(bulkRecoveryPreviews(subject, view)).toEqual({});
      expect(valid).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled();
      const discard = () => h.binding.discard(stamp);
      const html = renderToStaticMarkup(<DraftRecoveryNotice mode={view.mode} canRestore={view.canRestore}
        hasCurrent={!!view.current} hasReference={!!view.reference} discard={discard} restore={() => {}} retryRead={() => {}} />);
      expect(html).toContain("This editor could not be loaded"); expect(html).toContain("Discard retained changes");
      expect(html).not.toContain(">Restore</button>");
      discard(); expect(h.store.getSnapshot().count).toBe(0);
      expect(h.binding.getSnapshot().mode).toBe("editing"); expect(h.binding.getSnapshot().current!.baseline).toBe(fresh);
      expect(h.binding.getSnapshot().current!.stamp.generation).not.toBe(stamp.generation);
    });
    it(`${scenario.kind}: rejected incoming baseline cannot be republished by Discard, including readonly access`, () => {
      for (const editable of [true, false]) {
        const subject = adapter(scenario.kind); const base = scenario.project(shipmentFixture(), "so-1");
        const h = openDraftHarness(subject, emptyBulkDraft<Fields>(), base);
        h.binding.change(d => ({ ...d, edits: new Map([[base.rows[0].id, { [scenario.field]: scenario.raw }]]) }));
        const stamp = h.binding.getSnapshot().current!.stamp;
        const malformed = scenario.project(shipmentFixture(), "so-1"); corrupt(malformed, scenario.kind, "array");
        const readId = h.binding.beginRead();
        h.binding.acceptRead({ kind: "authorized", readId, baseline: malformed, editable }, emptyBulkDraft<Fields>());
        expect(h.binding.getSnapshot().mode).toBe("error"); expect(h.binding.getSnapshot().savedBaseline).toBeUndefined();
        h.binding.discard(stamp);
        expect(h.store.getSnapshot().count).toBe(0); expect(h.binding.getSnapshot().mode).toBe("error");
        expect(h.binding.getSnapshot().current).toBeUndefined(); expect(h.binding.getSnapshot().savedBaseline).toBeUndefined();
        expect(bulkRecoveryPreviews(subject, h.binding.getSnapshot())).toEqual({});
        h.binding.acceptRead({ kind: "authorized", readId: h.binding.beginRead(), baseline: base, editable: true }, emptyBulkDraft<Fields>());
        expect(h.binding.getSnapshot().mode).toBe("editing");
      }
    });
    it(`${scenario.kind}: Restore rechecks domain validity without render-time validation`, () => {
      const subject = adapter(scenario.kind); const base = scenario.project(shipmentFixture(), "so-1");
      const h = openDraftHarness(subject, emptyBulkDraft<Fields>(), base);
      h.binding.change(d => ({ ...d, edits: new Map([[base.rows[0].id, { [scenario.field]: scenario.raw }]]) }));
      h.detach(); h.binding.attach("return"); const readId = h.binding.beginRead();
      h.binding.acceptRead({ kind: "authorized", readId, baseline: scenario.project(shipmentFixture(), "so-1"), editable: true }, emptyBulkDraft<Fields>());
      expect(h.binding.getSnapshot().canRestore).toBe(true);
      const stamp = h.binding.getSnapshot().current!.stamp; corrupt(base, scenario.kind, "array");
      expect(h.binding.restore(stamp, readId)).toBe(false); expect(h.binding.getSnapshot().mode).toBe("error");
      h.binding.discard(stamp); expect(h.store.getSnapshot().count).toBe(0);
    });
    it(`${scenario.kind}: complete raw writer values remain valid; unknown and incomplete fields do not`, () => {
      const subject = adapter(scenario.kind); const base = scenario.project(shipmentFixture(), "so-1");
      const clean = emptyBulkDraft<Fields>();
      expect(subject.valid({ ...clean, edits: new Map([[base.rows[0].id, { [scenario.field]: scenario.raw }]]) }, base)).toBe(true);
      expect(subject.valid({ ...clean, added: [{ ...base.rows[0].fields, [scenario.field]: scenario.raw, clientId: "new" }] }, base)).toBe(true);
      expect(subject.valid({ ...clean, edits: new Map([[base.rows[0].id, { unexpected: "value" }]]) }, base)).toBe(false);
      expect(subject.valid({ ...clean, added: [{ clientId: "new" }] }, base)).toBe(false);
    });
  }
});
