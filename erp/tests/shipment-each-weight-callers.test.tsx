// The two screens that mount the shared Lines grid each build its `infoByLineId`. Here the grid is
// swapped for a recorder, so each test reads exactly what the real caller hands it; everything else is
// production code. Pure: no database.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { LineInfo } from "../src/app/shipping/ShipmentGrids";
import { ShipmentOrderPanel } from "../src/app/shipping/[id]/ShipmentOrderPanel";
import { NewShipment } from "../src/app/shipping/new/NewShipment";
import { createBulkRecoveryAdapter, emptyBulkDraft, type BulkBaseline, type BulkRecoveryCustomization } from "../src/lib/bulk-grid-recovery";
import {
  shipmentBulkCustomization, shipmentContainersBaseline, shipmentLinesBaseline, shipmentSerialsBaseline, type ShipmentBulkSnapshot,
} from "../src/lib/shipment-bulk-recovery";
import { newShipmentBaselineFrom, newShipmentDraftFrom, newShipmentRecoveryAdapter, type NewShipmentSource, type ShipmentSeed } from "../src/lib/new-shipment-recovery";
import { NO_REPORTS, savedShipmentTotalsInput, shipmentTotals } from "../src/lib/shipment-totals";
import { shipmentFixture } from "./helpers/remaining-bulk-fixtures";
import { openDraftHarness } from "./helpers/draft-store";

type Fields = Record<string, string>;
const rendered = vi.hoisted(() => ({ views: [] as unknown[], index: 0, info: [] as Map<string, LineInfo>[] }));
vi.mock("../src/app/shipping/ShipmentGrids", async importOriginal => ({
  ...await importOriginal<typeof import("../src/app/shipping/ShipmentGrids")>(),
  LinesGridView: (props: { infoByLineId: Map<string, LineInfo> }) => { rendered.info.push(props.infoByLineId); return null; },
}));
// Only the SSR subscription seam is supplied, in hook-call order (the shipment-recovery-access precedent).
vi.mock("../src/lib/use-recoverable-draft", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/use-recoverable-draft")>(),
  useRecoverableDraft: () => rendered.views[rendered.index++],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }), usePathname: () => "/shipping/ship-1", useSearchParams: () => new URLSearchParams() }));
vi.mock("../src/lib/use-permissions", () => ({ usePermissions: () => ({ permissions: ["shipping.create", "shipping.view", "customers.view", "orders.view"], error: null }) }));
afterEach(() => { rendered.views = []; rendered.index = 0; rendered.info = []; });

const adapterFor = (kind: "lines" | "containers" | "serials") => createBulkRecoveryAdapter<Fields>(
  `shipment-${kind}`, `shipment-${kind}-v1`, shipmentBulkCustomization(kind) as BulkRecoveryCustomization<Fields>);
/** Renders the saved page's panel over this fixture and returns what its Lines grid was handed.
 *  `lines` replaces the Lines grid's accepted baseline; by default it is the fixture's own projection. */
function panelInfo(fixture: ShipmentBulkSnapshot, lines: BulkBaseline<Fields> = shipmentLinesBaseline(fixture, "so-1")): Map<string, LineInfo> {
  const view = (kind: "lines" | "containers" | "serials", baseline: BulkBaseline<Fields>) =>
    openDraftHarness(adapterFor(kind), emptyBulkDraft<Fields>(), baseline).binding.getSnapshot();
  rendered.views = [view("lines", lines), view("containers", shipmentContainersBaseline(fixture, "so-1")),
    view("serials", shipmentSerialsBaseline(fixture, "so-1"))];
  const gate = { allowed: true, disabled: false, title: undefined };
  renderToStaticMarkup(<ShipmentOrderPanel shipperId="ship-1" order={fixture.shipper.orders[0]}
    recoverySource={{ read: async () => ({ record: fixture.shipper, access: fixture.permissions }), register: vi.fn(), begin: vi.fn() }}
    editGate={gate} linesGate={gate} creditHoldReason="" applyMutation={async run => { await run(); }} onRemove={() => {}}
    printGate={gate} printing={false} certsGate={gate} onPrintTicket={() => {}} totals={shipmentTotals(savedShipmentTotalsInput(fixture.shipper.orders, NO_REPORTS)).orders[0]} onTotalsReport={() => {}} />);
  expect(rendered.info).toHaveLength(1);
  return rendered.info[0];
}

const seed: ShipmentSeed = { clientRequestId: "3f6a1b2c-1111-4d22-8e33-9f0a1b2c3d4e", defaultShipDate: "2026-09-12", defaultFreightTerms: "PREPAID" };
/** One order with two lines: the first part answers with an each weight, the second without. */
function source(): NewShipmentSource {
  return { permissions: ["shipping.create", "shipping.view", "customers.view", "orders.view"],
    customer: { id: "customer", code: "C", name: "Customer", creditHold: false }, addresses: [], carriers: [],
    orders: [{ id: "order", customerId: "customer", orderNumber: 42, poNumber: "PO", customerJobNo: "JOB", status: "OPEN", voided: false,
      lines: [{ id: "line-1", position: 1, qty: 10, weight: 20, part: { partNumber: "P-1", name: "Shaft", eachWeight: 1.5 } },
        { id: "line-2", position: 2, qty: 5, weight: 15, part: { partNumber: "P-2", name: "Pin" } }],
      containers: [], serials: [], orderLineShippedToDate: [] }] };
}

describe("each weight reaches the Lines grid's line info", () => {
  it("saved shipment page: from the order catalog", () => {
    expect([...panelInfo(shipmentFixture())]).toStrictEqual([
      ["ol-1", { partNumber: "P-10", partName: "Shaft", orderedQty: 10, orderedWeight: 20, eachWeight: 2 }],
      ["ol-2", { partNumber: "P-20", partName: "Pin", orderedQty: 5, orderedWeight: 10, eachWeight: 2 }],
    ]);
  });

  it("saved shipment page: null for a shipping-only editor, whose rows come from the shipment itself", () => {
    const fixture = shipmentFixture(); fixture.permissions = ["shipping.view", "shipping.edit"];
    expect([...panelInfo(fixture)].map(([id, line]) => [id, line.eachWeight])).toStrictEqual([["ol-1", null], ["ol-2", null]]);
  });

  it("saved shipment page: null, not undefined, when an accepted baseline's display rows have no each weight key", () => {
    const fixture = shipmentFixture();
    const full = shipmentLinesBaseline(fixture, "so-1");
    const rows = (full.context.display as { lines: Record<string, unknown>[] }).lines;
    const bare = { ...full, context: { ...full.context, display: { lines: rows.map(row => {
      const { eachWeight: _eachWeight, ...rest } = row; void _eachWeight; return rest;
    }) } } } as BulkBaseline<Fields>;
    // The store accepts this baseline: `validShipment` checks the display keys it lists, and each weight is not one.
    expect(adapterFor("lines").valid(emptyBulkDraft<Fields>(), bare)).toBe(true);
    expect([...panelInfo(fixture, bare)].map(([id, line]) => [id, line.eachWeight])).toStrictEqual([["ol-1", null], ["ol-2", null]]);
  });

  it("new shipment form: from the order source, null where the part answered without one", () => {
    const clean = { ...newShipmentDraftFrom(seed), customerId: "customer" };
    const { binding } = openDraftHarness(newShipmentRecoveryAdapter, clean, newShipmentBaselineFrom(source()));
    binding.change(d => ({ ...d, selected: [{ orderId: "order", containers: [], serials: [],
      lines: [{ key: "row-1", isNew: true, orderLineId: "line-1", qty: "10", weight: "20", lineComplete: "false" }] }] }));
    rendered.views = [binding.getSnapshot()];
    renderToStaticMarkup(<NewShipment />);
    expect(rendered.info).toHaveLength(1);
    expect([...rendered.info[0]]).toStrictEqual([
      ["line-1", { partNumber: "P-1", partName: "Shaft", orderedQty: 10, orderedWeight: 20, eachWeight: 1.5 }],
      ["line-2", { partNumber: "P-2", partName: "Pin", orderedQty: 5, orderedWeight: 15, eachWeight: null }],
    ]);
  });
});
