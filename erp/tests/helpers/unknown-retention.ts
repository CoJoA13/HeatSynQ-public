import { createDraftStore, type Submission } from "../../src/lib/draft-store";
import { createDraftSession } from "../../src/lib/draft-session";
import { newShipmentBaselineFrom, newShipmentDraftFrom, newShipmentRecoveryAdapter, type ShipmentSeed, type NewShipmentSource, type NewShipmentDraft, type NewShipmentBaseline, type ShipmentBody } from "../../src/lib/new-shipment-recovery";
const seed: ShipmentSeed = { clientRequestId: "3f6a1b2c-1111-4d22-8e33-9f0a1b2c3d4e", defaultShipDate: "2026-09-12", defaultFreightTerms: "PREPAID" };
function source() {
  return {
    permissions: ["shipping.create", "shipping.view", "customers.view", "orders.view", "action.override_credit_hold"],
    customer: { id: "c1", code: "ACME", name: "Example customer", creditHold: false as boolean },
    addresses: [{ id: "address-1", kind: "SHIP_TO", name: "Dock" }], carriers: [{ id: "carrier-1", name: "Freight carrier" }],
    orders: [{ id: "order-1", customerId: "c1", orderNumber: 701, poNumber: "PO-1", customerJobNo: "JOB-1", status: "OPEN", voided: false as boolean,
      lines: [{ id: "line-1", position: 1, qty: 10, weight: 50, part: { partNumber: "P-1", name: "Shaft" } }, { id: "line-2", position: 2, qty: 5, weight: 15, part: { partNumber: "P-2", name: "Pin" } }],
      containers: [{ id: "container-1", count: 2, customerContainerId: "BOX-1", type: { name: "Box" } }],
      serials: [{ id: "serial-1", lineId: "line-1", serial: "S001", description: "Blue" }],
      orderLineShippedToDate: [{ orderLineId: "line-1", shippedToDateQty: 2, shippedToDateWeight: 10 }],
    }],
  } satisfies NewShipmentSource;
}
function selected(): NewShipmentDraft["selected"] {
  return [{ orderId: "order-1", lines: [{ key: "uuid-line-1", isNew: true, orderLineId: "line-1", qty: "08", weight: " 40.00 ", lineComplete: "false" }],
    containers: [{ key: "uuid-container-1", isNew: true, orderContainerId: "container-1", count: "02", tareEach: "" }],
    serials: [{ key: "uuid-serial-1", isNew: true, orderSerialId: "serial-1", printOnShipper: "true" }] }];
}
export function unknownFixture(observe: (submission: Submission<NewShipmentDraft, NewShipmentBaseline, ShipmentBody>) => void = () => {}) {
  const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
  const key = { owner, record: { kind: "new-shipment", id: "new" }, editor: newShipmentRecoveryAdapter.kind };
  const wrappedAdapter: typeof newShipmentRecoveryAdapter = {
    ...newShipmentRecoveryAdapter, settle: args => { observe(args.submission); return newShipmentRecoveryAdapter.settle(args); },
  };
  const binding = store.bind(key, { label: "New shipment", href: "/shipping/new" }, wrappedAdapter);
  const detach = binding.attach("first"); const baseline = newShipmentBaselineFrom(source()); const clean = { ...newShipmentDraftFrom(seed), customerId: "c1" };
  const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
  binding.change(d => ({ ...d, selected: selected(), comments: "  original raw notes  " }));
  const session = createDraftSession(store);
  function refresh() {
    const ticket = session.readAuthorizationTicket();
    const readId = binding.beginRead();
    if (!session.isReadAuthorized(ticket)) throw new Error("Fixture read lost authorization");
    if (!binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean)) throw new Error("Fixture read refused");
    return readId;
  }
  return { store, session, owner, key, binding, baseline, clean, detach, readId, refresh };
}
