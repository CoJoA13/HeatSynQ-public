import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { readXlsx } from "./helpers/xlsx";
import { runWithContext } from "@/server/context";
import { createOrder, replaceSerials, type OrderDetail } from "@/server/orders";
import { storeDocument } from "@/server/documents";
import type { Customer, Part } from "../prisma/generated/prisma/client";

import { GET as listRoute, POST as createRoute } from "@/app/api/shippers/route";
import { GET as exportRoute } from "@/app/api/shippers/export/route";
import { GET as getRoute, PATCH as patchRoute, DELETE as voidRoute } from "@/app/api/shippers/[id]/route";
import { POST as reverseRoute } from "@/app/api/shippers/[id]/reverse/route";
import { POST as addOrderRoute } from "@/app/api/shippers/[id]/orders/route";
import { DELETE as removeOrderRoute } from "@/app/api/shippers/[id]/orders/[shipperOrderId]/route";
import { PUT as replaceLinesRoute } from "@/app/api/shippers/[id]/orders/[shipperOrderId]/lines/route";
import { PUT as replaceContainersRoute } from "@/app/api/shippers/[id]/orders/[shipperOrderId]/containers/route";
import { PUT as replaceSerialsRoute } from "@/app/api/shippers/[id]/orders/[shipperOrderId]/serials/route";
import { GET as shipmentsForOrderRoute } from "@/app/api/orders/[id]/shipments/route";
import { GET as shipperDocumentsRoute } from "@/app/api/shippers/[id]/documents/route";
import { GET as listAddressesRoute } from "@/app/api/customers/[id]/addresses/route";

const noParams = { params: Promise.resolve({}) };
const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

function getReq(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}
function bodyReq(url: string, method: string, cookie: string | undefined, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function noBodyReq(url: string, method: string, cookie?: string): Request {
  return new Request(url, { method, headers: cookie ? { cookie } : {} });
}

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let customerSeq = 0;
async function makeCustomer(opts: { creditHold?: boolean } = {}): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({
    data: { code: `SRC${customerSeq}`, name: `Ship Route Customer ${customerSeq}`, creditHold: opts.creditHold ?? false },
  });
}

let partSeq = 0;
async function makePart(customerId: string): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({ data: { customerId, partNumber: `SRP-${partSeq}`, eachWeight: "1.0000" } });
}

/** Gives a part revision 1 with one step — the orderability precondition createOrder enforces
 *  (spec §5.3), the shippers.test.ts `giveSteps` precedent. */
async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `SRHT-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

/** A live, orderable customer + part, and the ORDER created from it — through the SERVICE, not a
 *  route under test (the order-routes.test.ts `orderFixture` precedent: a bug in some order route
 *  must never be able to mask a bug in the shipment route this file actually tests). */
async function orderFixture(opts: { creditHold?: boolean; qty?: number } = {}) {
  const customer = await makeCustomer({ creditHold: opts.creditHold });
  const part = await makePart(customer.id);
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, lines: [{ partId: part.id, qty: opts.qty ?? 10, weight: "25.00" }],
  }));
  return { customer, part, order };
}

function oneOrderInput(order: OrderDetail, qty?: number) {
  return {
    customerId: order.customerId,
    shipDate: "2026-08-04",
    orders: [{
      orderId: order.id,
      lines: [{
        orderLineId: order.lines[0].id, qty: qty ?? order.lines[0].qty, weight: order.lines[0].weight,
        lineComplete: false,
      }],
      containers: [] as { orderContainerId: string; count: number }[],
      serials: [] as { orderSerialId: string; printOnShipper?: boolean }[],
    }],
  };
}

/** A saved shipment's over-ship warning, whole, for the one line of `orderFixture({ qty: 10 })`
 *  once 999 pieces are on it. Each weight is as the server prints it, and the order's and the
 *  part's numbers are the fixture's. */
const OVER_ORDERED = /^Order #\d+ line 1 \(SRP-\d+\): shipped-to-date 999 \/ \S+ lb exceeds the 10 \/ \S+ lb ordered$/;

describe("shipper routes", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  // ---------------------------------------------------------------------------------------
  // GET /api/shippers, POST /api/shippers
  // ---------------------------------------------------------------------------------------

  it("GET /api/shippers requires shipping.view; POST requires shipping.create", async () => {
    const { order } = await orderFixture();

    expect((await listRoute(getReq("http://t/api/shippers"), noParams)).status).toBe(401);
    expect((await createRoute(bodyReq("http://t/api/shippers", "POST", undefined, {}), noParams)).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "ship-wrong-1");
    expect((await listRoute(getReq("http://t/api/shippers", wrong), noParams)).status).toBe(403);
    expect((await createRoute(
      bodyReq("http://t/api/shippers", "POST", wrong, oneOrderInput(order)), noParams,
    )).status).toBe(403);

    const viewer = await signInWith(["shipping.view"], "ship-view-1");
    expect((await listRoute(getReq("http://t/api/shippers", viewer), noParams)).status).toBe(200);

    const creator = await signInWith(["shipping.create"], "ship-create-1");
    const created = await createRoute(
      bodyReq("http://t/api/shippers", "POST", creator, oneOrderInput(order)), noParams);
    expect(created.status).toBe(200);
    const body = await created.json();
    expect(typeof body.shipper.shipperNumber).toBe("number");
    expect(body.warnings).toEqual([]);
    expect(body.deduped).toBe(false);
  });

  it("POST /api/shippers: a session without override_credit_hold is refused on a held customer even with a reason", async () => {
    const { order } = await orderFixture({ creditHold: true });
    const creator = await signInWith(["shipping.create"], "ship-hold-1");

    const withReason = await createRoute(bodyReq("http://t/api/shippers", "POST", creator, {
      ...oneOrderInput(order), creditHoldReason: "trust me",
    }), noParams);
    expect(withReason.status).toBe(400);
    expect((await withReason.json()).error).toMatch(/credit hold/i);

    const overrider = await signInWith(["shipping.create", "action.override_credit_hold"], "ship-hold-2");

    const noReason = await createRoute(
      bodyReq("http://t/api/shippers", "POST", overrider, oneOrderInput(order)), noParams);
    expect(noReason.status).toBe(400);
    expect((await noReason.json()).error).toMatch(/reason/i);

    const ok = await createRoute(bodyReq("http://t/api/shippers", "POST", overrider, {
      ...oneOrderInput(order), creditHoldReason: "owner approved",
    }), noParams);
    expect(ok.status).toBe(200);
  });

  // #612 PR C (ruling R3): the shipping list asks for the window with `?window=1` and is answered an
  // envelope; every other reader of this route (the template editor's shipment picker, E2E helpers)
  // keeps the bare, unbounded array, and so does the export.
  it("GET /api/shippers?window=1 answers the newest 200 shipments and whether it cut; showAll=1, the bare route and the export stay unbounded", async () => {
    const customer = await makeCustomer();
    await prisma.shipper.createMany({
      data: Array.from({ length: 201 }, (_, i) => ({
        shipperNumber: 800000 + i, customerId: customer.id, shipDate: new Date("2026-08-04T00:00:00Z"),
      })),
    });
    const viewer = await signInWith(["shipping.view"], "ship-window-viewer");
    const read = async (query: string) => (await listRoute(getReq(`http://t/api/shippers${query}`, viewer), noParams)).json();

    const windowed = await read("?window=1");
    expect(windowed.cut).toBe(true);
    expect(windowed.rows).toHaveLength(200);
    expect(windowed.rows[0].shipperNumber).toBe(800200); // one ship date: the packing-list number breaks the tie, newest first
    expect(windowed.rows[199].shipperNumber).toBe(800001);

    const all = await read("?window=1&showAll=1");
    expect(all).toMatchObject({ cut: false });
    expect(all.rows).toHaveLength(201);

    const narrowed = await read("?window=1&search=800007");
    expect(narrowed).toMatchObject({ cut: false });
    expect(narrowed.rows.map((r: { shipperNumber: number }) => r.shipperNumber)).toEqual([800007]);

    const bare = await read("");
    expect(Array.isArray(bare)).toBe(true);
    expect(bare).toHaveLength(201);

    const exported = await exportRoute(getReq("http://t/api/shippers/export", viewer), noParams);
    const sheet = await readXlsx(exported, 1);
    expect(sheet.rows).toHaveLength(202); // the header and all 201 shipments: exports stay unlimited
  });

  it("GET /api/shippers/export requires shipping.view and streams an xlsx", async () => {
    expect((await exportRoute(getReq("http://t/api/shippers/export"), noParams)).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "ship-export-wrong-1");
    expect((await exportRoute(getReq("http://t/api/shippers/export", wrong), noParams)).status).toBe(403);

    const viewer = await signInWith(["shipping.view"], "ship-export-view-1");
    const res = await exportRoute(getReq("http://t/api/shippers/export", viewer), noParams);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/spreadsheetml/);
  });

  // ---------------------------------------------------------------------------------------
  // GET/PATCH/DELETE /api/shippers/[id]
  // ---------------------------------------------------------------------------------------

  it("GET /api/shippers/[id] requires shipping.view; PATCH requires shipping.edit", async () => {
    const { order } = await orderFixture();
    const creator = await signInWith(["shipping.create"], "ship-detail-create-1");
    const created = await createRoute(
      bodyReq("http://t/api/shippers", "POST", creator, oneOrderInput(order)), noParams);
    const { shipper } = await created.json();

    expect((await getRoute(getReq(`http://t/api/shippers/${shipper.id}`), withParams({ id: shipper.id }))).status).toBe(401);
    expect((await patchRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}`, "PATCH", undefined, { route: "Dock 3" }),
      withParams({ id: shipper.id }))).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "ship-detail-wrong-1");
    expect((await getRoute(
      getReq(`http://t/api/shippers/${shipper.id}`, wrong), withParams({ id: shipper.id }))).status).toBe(403);
    expect((await patchRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}`, "PATCH", wrong, { route: "Dock 3" }),
      withParams({ id: shipper.id }))).status).toBe(403);

    const viewer = await signInWith(["shipping.view"], "ship-detail-view-1");
    const got = await getRoute(getReq(`http://t/api/shippers/${shipper.id}`, viewer), withParams({ id: shipper.id }));
    expect(got.status).toBe(200);
    const gotBody = await got.json();
    // GET is wrapped through `shipperResponse` too (review round 2, 2026-08-04): the shipment
    // page remounts per id and renders §5.7's warnings on a plain load, not only right after an
    // edit, so GET carries the same { shipper, warnings } shape every mutator does.
    expect(gotBody.shipper.id).toBe(shipper.id);
    expect(gotBody.warnings).toEqual([]);

    const editor = await signInWith(["shipping.edit"], "ship-detail-edit-1");
    const patched = await patchRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}`, "PATCH", editor, { route: "Dock 3" }),
      withParams({ id: shipper.id }));
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json();
    // Step 0b: PATCH wraps its response in the same { shipper, warnings } shape POST established.
    expect(patchedBody.shipper.route).toBe("Dock 3");
    expect(patchedBody.warnings).toEqual([]);
  });

  it("GET /api/shippers/[id] surfaces an over-ship warning that was created in an earlier request, with no mutation of its own", async () => {
    const { order } = await orderFixture({ qty: 10 });
    const creator = await signInWith(["shipping.create"], "ship-getwarn-create-1");
    const created = await createRoute(
      bodyReq("http://t/api/shippers", "POST", creator, oneOrderInput(order)), noParams);
    const { shipper } = await created.json();
    const shipperOrderId = shipper.orders[0].id;

    // Over-ship the line in one request (PUT .../lines) — a separate request from the GET below,
    // so the GET's warning cannot be riding on anything this test's own call just wrote.
    const editor = await signInWith(["shipping.edit"], "ship-getwarn-edit-1");
    const linesBody = [{ orderLineId: order.lines[0].id, qty: 999, weight: order.lines[0].weight, lineComplete: false }];
    const putRes = await replaceLinesRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}/orders/${shipperOrderId}/lines`, "PUT", editor, linesBody),
      withParams({ id: shipper.id, shipperOrderId }));
    expect(putRes.status).toBe(200);

    // A FRESH GET, as a plain read with no body of its own — this is the property being bought:
    // the warning is visible on load, not only in the response of the mutation that created it.
    const viewer = await signInWith(["shipping.view"], "ship-getwarn-view-1");
    const res = await getRoute(getReq(`http://t/api/shippers/${shipper.id}`, viewer), withParams({ id: shipper.id }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings).toContainEqual(expect.stringMatching(OVER_ORDERED));
  });

  // #472: the envelope also says which orders printed paper pins to the shipment, so the page can
  // grey Remove order out before the click. The GET and the PATCH below both answer through
  // `shipperResponse`. So do add order, remove order, the three grid replaces and reverse, which
  // this case does not exercise. Creating a shipment does not, and its answer carries no `printed`.
  // Nothing here tells a read made after a mutation's commit from one made before it either: no
  // mutation that answers through `shipperResponse` stores a document, so both reads would say
  // the same. The second #484 case below does tell them apart: it records where each read runs
  // against the PATCH's transaction, and finds this read's paper query after that transaction has
  // closed.
  it("a shipment's GET answer carries the printed-paper facts as they stand at that read, and a PATCH's answer carries them too", async () => {
    const { order } = await orderFixture();
    const creator = await signInWith(["shipping.create"], "ship-printed-create-1");
    const created = await createRoute(
      bodyReq("http://t/api/shippers", "POST", creator, oneOrderInput(order)), noParams);
    const { shipper } = await created.json();

    const viewer = await signInWith(["shipping.view"], "ship-printed-view-1");
    const read = async () => (await (await getRoute(
      getReq(`http://t/api/shippers/${shipper.id}`, viewer), withParams({ id: shipper.id }))).json()).printed;
    expect(await read()).toEqual({ paperOrderIds: [], certOrderIds: [] });

    await prisma.$transaction((tx) => storeDocument(tx,
      { kind: "SHIPPER", shipperId: shipper.id, orderId: order.id }, Buffer.from("%PDF-1.4 t")));
    expect(await read()).toEqual({ paperOrderIds: [order.id], certOrderIds: [] });

    // A mutation's answer carries it too.
    const editor = await signInWith(["shipping.edit"], "ship-printed-edit-1");
    const patched = await patchRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}`, "PATCH", editor, { route: "Dock 3" }),
      withParams({ id: shipper.id }));
    expect(patched.status).toBe(200);
    expect((await patched.json()).printed).toEqual({ paperOrderIds: [order.id], certOrderIds: [] });
  });

  // #484 (owner ruling 2026-10-15, "Payload address after commit, select open"): every answer that
  // comes through `shipperResponse` also carries the shipment's ship-to address, its name, street,
  // city, state and zip and nothing else, read by the address id the shipment holds
  // (`shipToAddressId`), whatever has happened to the address since, so a viewer who cannot list
  // the customer's addresses still sees it. The GET, the PATCH and reverse are exercised here.
  // Creating a shipment does not answer through `shipperResponse`, and its answer carries no
  // `shipToAddress`: the saved page's first GET does.
  it("#484: every shipment answer carries its ship-to address, read by id whatever the address book now says, also to a viewer who cannot list addresses", async () => {
    const { customer, order } = await orderFixture();
    const DOCK_7 = { name: "Dock 7", street: "1 Main St", city: "Springfield", state: "IL", zip: "62701" };
    const DOCK_9 = { name: "Dock 9", street: "9 River Rd", city: "Peoria", state: "IL", zip: "61602" };
    const dock7 = await prisma.customerAddress.create({
      data: { customerId: customer.id, kind: "SHIP_TO", ...DOCK_7, isDefault: true },
    });
    const dock9 = await prisma.customerAddress.create({ data: { customerId: customer.id, kind: "SHIP_TO", ...DOCK_9 } });

    const creator = await signInWith(["shipping.create"], "ship-shipto-create-1");
    const created = await createRoute(bodyReq("http://t/api/shippers", "POST", creator,
      { ...oneOrderInput(order), shipToAddressId: dock7.id }), noParams);
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(createdBody.shipper.shipToAddressId).toBe(dock7.id);
    expect(createdBody).not.toHaveProperty("shipToAddress");
    const { shipper } = createdBody;

    // A viewer who may not list the customer's addresses is still answered the shipment's own.
    const viewer = await signInWith(["shipping.view"], "ship-shipto-view-1");
    const addressesReq = (cookie: string) =>
      listAddressesRoute(getReq(`http://t/api/customers/${customer.id}/addresses`, cookie), withParams({ id: customer.id }));
    expect((await addressesReq(viewer)).status).toBe(403);
    const read = async () => {
      const res = await getRoute(getReq(`http://t/api/shippers/${shipper.id}`, viewer), withParams({ id: shipper.id }));
      expect(res.status).toBe(200);
      return (await res.json()).shipToAddress;
    };
    // Exactly the five fields: no id, kind, isDefault, active, customerId, deletedAt or timestamps.
    expect(await read()).toEqual(DOCK_7);

    // Made inactive, the address leaves the address list, and the answer still carries it.
    const lister = await signInWith(["customers.view"], "ship-shipto-list-1");
    const listed = async () => {
      const res = await addressesReq(lister);
      expect(res.status).toBe(200);
      return ((await res.json()) as { id: string }[]).map((a) => a.id);
    };
    expect(await listed()).toEqual([dock7.id, dock9.id]);
    await prisma.customerAddress.update({ where: { id: dock7.id }, data: { active: false } });
    expect(await listed()).toEqual([dock9.id]);
    expect(await read()).toEqual(DOCK_7);
    // Deleted, it is still the shipment's address, and still carried.
    await prisma.customerAddress.update({ where: { id: dock7.id }, data: { deletedAt: new Date() } });
    expect(await read()).toEqual(DOCK_7);

    // An editor without customers.view: the server sets an address for this session, and only the
    // screen cannot offer one. The clear answers no address: the clear the owner was told is
    // one-way for such a viewer.
    const editor = await signInWith(["shipping.edit"], "ship-shipto-edit-1");
    const patch = async (shipToAddressId: string | null) => {
      const res = await patchRoute(bodyReq(`http://t/api/shippers/${shipper.id}`, "PATCH", editor, { shipToAddressId }),
        withParams({ id: shipper.id }));
      expect(res.status).toBe(200);
      return res.json();
    };
    const set = await patch(dock9.id);
    expect(set.shipper.shipToAddressId).toBe(dock9.id);
    expect(set.shipToAddress).toEqual(DOCK_9);
    const cleared = await patch(null);
    expect(cleared.shipper.shipToAddressId).toBeNull();
    expect(cleared.shipToAddress).toBeNull();
    expect((await patch(dock9.id)).shipToAddress).toEqual(DOCK_9);

    // Last, because a shipment refuses edits while a reversal of it is live: the reversal copies
    // the original's address, and its answer carries it.
    const voider = await signInWith(["action.void_shipper"], "ship-shipto-void-1");
    const reversed = await reverseRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}/reverse`, "POST", voider, { reason: "went to the wrong dock" }),
      withParams({ id: shipper.id }));
    expect(reversed.status).toBe(200);
    const reversedBody = await reversed.json();
    expect(reversedBody.shipper.reversesShipperId).toBe(shipper.id);
    expect(reversedBody.shipper.shipToAddressId).toBe(dock9.id);
    expect(reversedBody.shipToAddress).toEqual(DOCK_9);
  });

  // #484: the address is read where `printed` is, on the top-level client once the mutation's
  // transaction has closed, never inside it. Each `$transaction`'s open and close, each top-level
  // `customerAddress` read and each top-level `storedDocument.findMany` are recorded in one ordered
  // list, each read with how many transactions were open at the time. `updateShipper` checks the address it is handed with
  // `tx.customerAddress.findFirst`, which goes through the transaction's own delegate rather than
  // the top-level one wrapped here, so it is not recorded: traveler.test.ts's top-level-client case
  // rests on the same fact. The `storedDocument` read is the control: `readPrintedOrders` already
  // reads on the top-level client after commit, so a recording that missed it would prove nothing.
  // Plain save-reassign-restore, never `vi.spyOn` (CLAUDE.md).
  it("#484: the address is read on the top-level client after the PATCH's transaction has closed", async () => {
    const { customer, order } = await orderFixture();
    const DOCK_7 = { name: "Dock 7", street: "1 Main St", city: "Springfield", state: "IL", zip: "62701" };
    const dock7 = await prisma.customerAddress.create({ data: { customerId: customer.id, kind: "SHIP_TO", ...DOCK_7 } });
    const creator = await signInWith(["shipping.create"], "ship-shipto-order-create-1");
    const { shipper } = await (await createRoute(
      bodyReq("http://t/api/shippers", "POST", creator, oneOrderInput(order)), noParams)).json();
    // Signed in before anything is wrapped: signing in opens a transaction of its own.
    const editor = await signInWith(["shipping.edit"], "ship-shipto-order-edit-1");

    let depth = 0;
    const events: string[] = [];
    const client = prisma as unknown as Record<string, unknown>;
    const realTx = client.$transaction as (...a: unknown[]) => unknown;
    const restore: (() => void)[] = [() => { client.$transaction = realTx; }];
    client.$transaction = async (...args: unknown[]) => {
      depth++;
      events.push("tx-open");
      try {
        return await realTx.apply(prisma, args);
      } finally {
        depth--;
        events.push("tx-closed");
      }
    };
    const record = (model: string, methods: readonly string[], label: string) => {
      const delegate = client[model] as Record<string, unknown>;
      for (const method of methods) {
        const real = delegate[method] as (...a: unknown[]) => unknown;
        expect(typeof real).toBe("function");
        restore.push(() => { delegate[method] = real; });
        delegate[method] = (...args: unknown[]) => {
          events.push(`${label}@${depth}`);
          return real.apply(delegate, args);
        };
      }
    };

    let res: Response;
    try {
      record("customerAddress", ["findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow", "findMany"], "address");
      record("storedDocument", ["findMany"], "paper");
      res = await patchRoute(
        bodyReq(`http://t/api/shippers/${shipper.id}`, "PATCH", editor, { shipToAddressId: dock7.id }),
        withParams({ id: shipper.id }));
    } finally {
      for (const undo of restore.reverse()) undo();
    }

    expect(res.status).toBe(200);
    expect((await res.json()).shipToAddress).toEqual(DOCK_7);
    expect(events).toContain("tx-open");
    const afterCommit = events.slice(events.lastIndexOf("tx-closed") + 1);
    expect(events.lastIndexOf("tx-closed")).toBeGreaterThan(-1);
    // The control: the paper read was recorded, on the top-level client, after the commit.
    expect(afterCommit).toContain("paper@0");
    // The claim: one address read, with no transaction open, after the last one closed.
    expect(events.filter((e) => e.startsWith("address@"))).toEqual(["address@0"]);
    expect(afterCommit).toContain("address@0");
  });

  it("DELETE /api/shippers/[id]: void_shipper is required even with all four shipping.* CRUD grants, and a reason is required", async () => {
    const { order } = await orderFixture();
    const creator = await signInWith(["shipping.create"], "ship-void-create-1");
    const created = await createRoute(
      bodyReq("http://t/api/shippers", "POST", creator, oneOrderInput(order)), noParams);
    const { shipper } = await created.json();

    expect((await voidRoute(
      noBodyReq(`http://t/api/shippers/${shipper.id}`, "DELETE"), withParams({ id: shipper.id }))).status).toBe(401);

    const fullCrud = await signInWith(
      ["shipping.view", "shipping.create", "shipping.edit", "shipping.delete"], "ship-void-fullcrud-1");
    const denied = await voidRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}`, "DELETE", fullCrud, { reason: "wrong order" }),
      withParams({ id: shipper.id }));
    expect(denied.status).toBe(403);

    const voider = await signInWith(["action.void_shipper"], "ship-void-only-1");

    const noReason = await voidRoute(
      noBodyReq(`http://t/api/shippers/${shipper.id}`, "DELETE", voider), withParams({ id: shipper.id }));
    expect(noReason.status).toBe(400);
    expect((await noReason.json()).error).toMatch(/reason/i);

    const ok = await voidRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}`, "DELETE", voider, { reason: "shipped to wrong customer" }),
      withParams({ id: shipper.id }));
    expect(ok.status).toBe(200);

    const row = await prisma.shipper.findFirst({ where: { id: shipper.id } });
    expect(row!.deletedAt).not.toBeNull();
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "shipper", entityId: shipper.id, action: "delete" },
    });
    expect(entry?.reason).toBe("shipped to wrong customer");
  });

  it("POST /api/shippers/[id]/reverse: void_shipper is required, a reason is required, and it returns the wrapped shape", async () => {
    const { order } = await orderFixture({ qty: 100 });
    const creator = await signInWith(["shipping.create"], "ship-rev-create-1");
    const created = await createRoute(
      bodyReq("http://t/api/shippers", "POST", creator, oneOrderInput(order, 100)), noParams);
    const { shipper } = await created.json();

    expect((await reverseRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}/reverse`, "POST", undefined, { reason: "x" }),
      withParams({ id: shipper.id }))).status).toBe(401);

    // Even every shipping.* CRUD grant does not substitute for the special action.
    const fullCrud = await signInWith(
      ["shipping.view", "shipping.create", "shipping.edit", "shipping.delete"], "ship-rev-fullcrud-1");
    expect((await reverseRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}/reverse`, "POST", fullCrud, { reason: "returned" }),
      withParams({ id: shipper.id }))).status).toBe(403);

    const voider = await signInWith(["action.void_shipper"], "ship-rev-only-1");
    const noReason = await reverseRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}/reverse`, "POST", voider, { reason: "  " }),
      withParams({ id: shipper.id }));
    expect(noReason.status).toBe(400);
    expect((await noReason.json()).error).toMatch(/reason/i);

    const ok = await reverseRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}/reverse`, "POST", voider, { reason: "wrong parts loaded" }),
      withParams({ id: shipper.id }));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.shipper.reversesShipperId).toBe(shipper.id);
    expect(body.shipper.orders[0].lines[0].qty).toBe(-100);
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  // ---------------------------------------------------------------------------------------
  // POST/DELETE .../orders, PUT .../lines /containers /serials
  // ---------------------------------------------------------------------------------------

  it("POST/DELETE .../orders require shipping.edit and both return the wrapped { shipper, warnings } shape", async () => {
    const { customer, order: orderA } = await orderFixture();
    const partB = await makePart(customer.id);
    await giveSteps(partB.id);
    const { order: orderB } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: partB.id, qty: 10, weight: "25.00" }],
    }));

    const creator = await signInWith(["shipping.create"], "ship-mos-create-1");
    const created = await createRoute(
      bodyReq("http://t/api/shippers", "POST", creator, oneOrderInput(orderA)), noParams);
    const { shipper } = await created.json();

    // ---- POST .../orders (add orderB) ----
    expect((await addOrderRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}/orders`, "POST", undefined, { orderId: orderB.id }),
      withParams({ id: shipper.id }))).status).toBe(401);

    const wrong = await signInWith(["shipping.view"], "ship-mos-wrong-1");
    expect((await addOrderRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}/orders`, "POST", wrong, { orderId: orderB.id }),
      withParams({ id: shipper.id }))).status).toBe(403);

    const editor = await signInWith(["shipping.edit"], "ship-mos-edit-1");
    const added = await addOrderRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}/orders`, "POST", editor, { orderId: orderB.id }),
      withParams({ id: shipper.id }));
    expect(added.status).toBe(200);
    const addedBody = await added.json();
    expect(addedBody.shipper.orders.map((o: { orderId: string }) => o.orderId)).toContain(orderB.id);
    expect(addedBody.warnings).toEqual([]);
    const shipperOrderB = addedBody.shipper.orders.find((o: { orderId: string }) => o.orderId === orderB.id).id;

    // ---- DELETE .../orders/[shipperOrderId] (remove orderB again — orderA remains, so this is legal) ----
    const removeUrl = `http://t/api/shippers/${shipper.id}/orders/${shipperOrderB}`;
    expect((await removeOrderRoute(
      noBodyReq(removeUrl, "DELETE"), withParams({ id: shipper.id, shipperOrderId: shipperOrderB }))).status).toBe(401);
    expect((await removeOrderRoute(
      noBodyReq(removeUrl, "DELETE", wrong), withParams({ id: shipper.id, shipperOrderId: shipperOrderB }))).status).toBe(403);

    const removed = await removeOrderRoute(
      noBodyReq(removeUrl, "DELETE", editor), withParams({ id: shipper.id, shipperOrderId: shipperOrderB }));
    expect(removed.status).toBe(200);
    const removedBody = await removed.json();
    expect(removedBody.shipper.orders.map((o: { orderId: string }) => o.orderId)).not.toContain(orderB.id);
    expect(removedBody.warnings).toEqual([]);
  });

  it("PUT .../lines requires shipping.edit, returns the wrapped shape, and surfaces an over-ship warning through the route", async () => {
    const { order } = await orderFixture({ qty: 10 });
    const creator = await signInWith(["shipping.create"], "ship-lines-create-1");
    const created = await createRoute(
      bodyReq("http://t/api/shippers", "POST", creator, oneOrderInput(order)), noParams);
    const { shipper } = await created.json();
    const shipperOrderId = shipper.orders[0].id;
    const url = `http://t/api/shippers/${shipper.id}/orders/${shipperOrderId}/lines`;
    const linesBody = [{ orderLineId: order.lines[0].id, qty: 999, weight: order.lines[0].weight, lineComplete: false }];

    expect((await replaceLinesRoute(
      bodyReq(url, "PUT", undefined, linesBody), withParams({ id: shipper.id, shipperOrderId }))).status).toBe(401);

    const wrong = await signInWith(["shipping.view"], "ship-lines-wrong-1");
    expect((await replaceLinesRoute(
      bodyReq(url, "PUT", wrong, linesBody), withParams({ id: shipper.id, shipperOrderId }))).status).toBe(403);

    const editor = await signInWith(["shipping.edit"], "ship-lines-edit-1");
    const res = await replaceLinesRoute(
      bodyReq(url, "PUT", editor, linesBody), withParams({ id: shipper.id, shipperOrderId }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Step 0b, the brief's own named requirement: over-shipping surfaces through the ROUTE
    // response, not only through the service's separately-exported `overshipWarnings`.
    expect(body.shipper.orders[0].lines[0].qty).toBe(999);
    expect(body.warnings).toContainEqual(expect.stringMatching(OVER_ORDERED));
  });

  it.each([
    ["a bare list", (line: object) => [line], "0.weight: use at most 2 digits after the point."],
    ["the wrapped form", (line: object) => ({ lines: [line], creditHoldReason: "ok" }),
      "lines.0.weight: use at most 2 digits after the point."],
  ])("Save lines names the refused weight in %s (#511)", async (_label, wrap, message) => {
    const { order } = await orderFixture({ qty: 10 });
    const creator = await signInWith(["shipping.create"], "ship-lines-511-create");
    const created = await createRoute(
      bodyReq("http://t/api/shippers", "POST", creator, oneOrderInput(order)), noParams);
    const { shipper } = await created.json();
    const shipperOrderId = shipper.orders[0].id;
    const editor = await signInWith(["shipping.edit"], "ship-lines-511-edit");
    const res = await replaceLinesRoute(
      bodyReq(`http://t/api/shippers/${shipper.id}/orders/${shipperOrderId}/lines`, "PUT", editor,
        wrap({ orderLineId: order.lines[0].id, qty: 1, weight: "1600.555" })),
      withParams({ id: shipper.id, shipperOrderId }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: message });
  });

  it("edit responses recompute missing-serialization warnings, not only over-ship (#54)", async () => {
    const { part, order } = await orderFixture();
    await prisma.part.update({ where: { id: part.id }, data: { serializationRequired: true } });
    const orderSerial = await prisma.orderSerial.create({
      data: { orderId: order.id, lineId: order.lines[0].id, position: 1, serial: "SR-W-1", description: "" },
    });

    const creator = await signInWith(["shipping.create"], "ship-warn-create");
    const input = oneOrderInput(order);
    input.orders[0].serials = [{ orderSerialId: orderSerial.id, printOnShipper: true }];
    const created = await createRoute(bodyReq("http://t/api/shippers", "POST", creator, input), noParams);
    const createdBody = await created.json();
    expect(createdBody.warnings.join(" ")).not.toMatch(/no serial numbers/i); // serial selected

    // Removing the LAST selected serial via the route must re-raise the §5.7 warning creation
    // would have raised — the detail page swaps its banner for exactly this array.
    const editor = await signInWith(["shipping.edit"], "ship-warn-edit");
    const shipperOrderId = createdBody.shipper.orders[0].id;
    const serialsUrl = `http://t/api/shippers/${createdBody.shipper.id}/orders/${shipperOrderId}/serials`;
    const res = await replaceSerialsRoute(
      bodyReq(serialsUrl, "PUT", editor, []), withParams({ id: createdBody.shipper.id, shipperOrderId }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings.join(" ")).toMatch(/no serial numbers/i);
  });

  it("a RELEASED serial selection still satisfies the serialization warning (!57 review)", async () => {
    const { part, order } = await orderFixture();
    await prisma.part.update({ where: { id: part.id }, data: { serializationRequired: true } });
    const orderSerial = await prisma.orderSerial.create({
      data: { orderId: order.id, lineId: order.lines[0].id, position: 1, serial: "SR-REL-1", description: "" },
    });
    const creator = await signInWith(["shipping.create"], "ship-rel-create");
    const input = oneOrderInput(order);
    input.orders[0].serials = [{ orderSerialId: orderSerial.id, printOnShipper: true }];
    const created = await createRoute(bodyReq("http://t/api/shippers", "POST", creator, input), noParams);
    const createdBody = await created.json();
    expect(createdBody.warnings.join(" ")).not.toMatch(/no serial numbers/i);

    // Order-side replacement releases the shipment's serial row (snapshot + release) — the
    // shipment still displays and prints that serial, so no false warning may appear.
    await asSystem(() => replaceSerials(order.id, order.lines[0].id, []));
    const editor = await signInWith(["shipping.edit"], "ship-rel-edit");
    const res = await patchRoute(
      bodyReq(`http://t/api/shippers/${createdBody.shipper.id}`, "PATCH", editor, { route: "x" }),
      withParams({ id: createdBody.shipper.id }));
    expect(res.status).toBe(200);
    expect((await res.json()).warnings.join(" ")).not.toMatch(/no serial numbers/i);
  });

  it("PUT .../containers and .../serials require shipping.edit and return the wrapped shape", async () => {
    const { order } = await orderFixture();
    const containerType = await prisma.containerType.create({ data: { name: "SR Basket" } });
    const orderContainer = await prisma.orderContainer.create({
      data: { orderId: order.id, typeId: containerType.id, position: 1, count: 2 },
    });
    const orderSerial = await prisma.orderSerial.create({
      data: { orderId: order.id, lineId: order.lines[0].id, position: 1, serial: "SR-SER-1", description: "" },
    });

    const creator = await signInWith(["shipping.create"], "ship-cs-create-1");
    const created = await createRoute(
      bodyReq("http://t/api/shippers", "POST", creator, oneOrderInput(order)), noParams);
    const { shipper } = await created.json();
    const shipperOrderId = shipper.orders[0].id;

    const containersUrl = `http://t/api/shippers/${shipper.id}/orders/${shipperOrderId}/containers`;
    const containersBody = [{ orderContainerId: orderContainer.id, count: 2 }];
    expect((await replaceContainersRoute(
      bodyReq(containersUrl, "PUT", undefined, containersBody),
      withParams({ id: shipper.id, shipperOrderId }))).status).toBe(401);
    const wrong = await signInWith(["shipping.view"], "ship-cs-wrong-1");
    expect((await replaceContainersRoute(
      bodyReq(containersUrl, "PUT", wrong, containersBody),
      withParams({ id: shipper.id, shipperOrderId }))).status).toBe(403);
    const editor = await signInWith(["shipping.edit"], "ship-cs-edit-1");
    const containersRes = await replaceContainersRoute(
      bodyReq(containersUrl, "PUT", editor, containersBody), withParams({ id: shipper.id, shipperOrderId }));
    expect(containersRes.status).toBe(200);
    const containersJson = await containersRes.json();
    expect(containersJson.shipper.orders[0].containers).toHaveLength(1);
    expect(containersJson.warnings).toEqual([]);

    const serialsUrl = `http://t/api/shippers/${shipper.id}/orders/${shipperOrderId}/serials`;
    const serialsBody = [{ orderSerialId: orderSerial.id, printOnShipper: true }];
    expect((await replaceSerialsRoute(
      bodyReq(serialsUrl, "PUT", undefined, serialsBody),
      withParams({ id: shipper.id, shipperOrderId }))).status).toBe(401);
    expect((await replaceSerialsRoute(
      bodyReq(serialsUrl, "PUT", wrong, serialsBody),
      withParams({ id: shipper.id, shipperOrderId }))).status).toBe(403);
    const serialsRes = await replaceSerialsRoute(
      bodyReq(serialsUrl, "PUT", editor, serialsBody), withParams({ id: shipper.id, shipperOrderId }));
    expect(serialsRes.status).toBe(200);
    const serialsJson = await serialsRes.json();
    expect(serialsJson.shipper.orders[0].serials).toHaveLength(1);
    expect(serialsJson.warnings).toEqual([]);
  });

  // ---------------------------------------------------------------------------------------
  // A container row's refusals (weights design §12.3: V7, V8, V10, and K23, which is kept). The
  // server builds each from the field's place in the body and the rule's own words, so each is
  // held whole here, where the two are joined. A bare list keeps the places it has always had.
  // ---------------------------------------------------------------------------------------

  describe("a container row's tare each and its number of containers, refused at the routes", () => {
    type Sent = (orderContainerId: string) => unknown;
    it.each<["PUT" | "POST", string, Sent, string]>([
      ["PUT", "a tare each with three decimals (V7)",
        (id) => ({ containers: [{ orderContainerId: id, count: 2, tareEach: "42.505" }] }),
        "containers.0.tareEach: use at most 2 digits after the point."],
      ["PUT", "a tare each with eleven digits before the point",
        (id) => ({ containers: [{ orderContainerId: id, count: 2, tareEach: "12345678901" }] }),
        "containers.0.tareEach: must be less than 10,000,000,000."],
      ["PUT", "a tare each below zero",
        (id) => ({ containers: [{ orderContainerId: id, count: 2, tareEach: -1 }] }),
        "containers.0.tareEach: cannot be negative."],
      ["PUT", "a kept row's tare each with three decimals (V7)",
        () => ({ containers: [], kept: [{ id: "no-such-row", tareEach: "1.005" }] }),
        "kept.0.tareEach: use at most 2 digits after the point."],
      ["PUT", "a kept row's tare each below zero",
        () => ({ containers: [], kept: [{ id: "no-such-row", tareEach: -1 }] }),
        "kept.0.tareEach: cannot be negative."],
      ["PUT", "a number of containers past the column's ceiling (V10)",
        (id) => ({ containers: [{ orderContainerId: id, count: 2147483648 }] }),
        "containers.0.count: Too big: expected number to be <=2147483647"],
      ["PUT", "a bare list's tare each with three decimals",
        (id) => [{ orderContainerId: id, count: 2, tareEach: "42.505" }],
        "0.tareEach: use at most 2 digits after the point."],
      ["PUT", "a bare list's number of containers past the ceiling",
        (id) => [{ orderContainerId: id, count: 2147483648 }],
        "0.count: Too big: expected number to be <=2147483647"],
      ["POST", "a tare each with three decimals (V8)",
        (id) => [{ orderContainerId: id, count: 2, tareEach: "42.505" }],
        "orders.0.containers.0.tareEach: use at most 2 digits after the point."],
      ["POST", "a tare each below zero",
        (id) => [{ orderContainerId: id, count: 2, tareEach: -1 }],
        "orders.0.containers.0.tareEach: cannot be negative."],
      ["POST", "a number of containers past the ceiling (K23)",
        (id) => [{ orderContainerId: id, count: 2147483648 }],
        "orders.0.containers.0.count: Too big: expected number to be <=2147483647"],
    ])("%s: %s", async (door, _what, sent, sentence) => {
      const { order } = await orderFixture();
      const containerType = await prisma.containerType.create({ data: { name: "SR Basket" } });
      const orderContainer = await prisma.orderContainer.create({
        data: { orderId: order.id, typeId: containerType.id, position: 1, count: 2 },
      });
      const session = await signInWith(["shipping.create", "shipping.edit"], "ship-tare-1");
      const input = oneOrderInput(order);
      // POST: `sent` is the one order's list of container rows. PUT: it is the whole body.
      const created = await createRoute(bodyReq("http://t/api/shippers", "POST", session, door === "PUT" ? input
        : { ...input, orders: [{ ...input.orders[0], containers: sent(orderContainer.id) }] }), noParams);
      let refused = created;
      if (door === "PUT") {
        const { shipper } = await created.json();
        const shipperOrderId = shipper.orders[0].id;
        refused = await replaceContainersRoute(
          bodyReq(`http://t/api/shippers/${shipper.id}/orders/${shipperOrderId}/containers`, "PUT", session,
            sent(orderContainer.id)),
          withParams({ id: shipper.id, shipperOrderId }));
      }
      expect([refused.status, (await refused.json()).error]).toEqual([400, sentence]);
    });
  });

  // ---------------------------------------------------------------------------------------
  // GET /api/orders/[id]/shipments
  // ---------------------------------------------------------------------------------------

  it("GET /api/orders/[id]/shipments requires shipping.view", async () => {
    const { order } = await orderFixture();
    const creator = await signInWith(["shipping.create"], "ship-forord-create-1");
    await createRoute(bodyReq("http://t/api/shippers", "POST", creator, oneOrderInput(order)), noParams);

    expect((await shipmentsForOrderRoute(
      getReq(`http://t/api/orders/${order.id}/shipments`), withParams({ id: order.id }))).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "ship-forord-wrong-1");
    expect((await shipmentsForOrderRoute(
      getReq(`http://t/api/orders/${order.id}/shipments`, wrong), withParams({ id: order.id }))).status).toBe(403);

    const viewer = await signInWith(["shipping.view"], "ship-forord-view-1");
    const res = await shipmentsForOrderRoute(
      getReq(`http://t/api/orders/${order.id}/shipments`, viewer), withParams({ id: order.id }));
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------------------
  // GET /api/shippers/[id]/documents (Task 14: the shipment page's stored-documents list —
  // `listDocumentsForShipper` (documents.ts, Task 3) had no HTTP caller before this route).
  // ---------------------------------------------------------------------------------------

  it("GET /api/shippers/[id]/documents requires shipping.view and lists this shipment's SHIPPER/BOL documents", async () => {
    const { order } = await orderFixture();
    const creator = await signInWith(["shipping.create"], "ship-docs-create-1");
    const created = await createRoute(bodyReq("http://t/api/shippers", "POST", creator, oneOrderInput(order)), noParams);
    const { shipper } = await created.json();

    const url = `http://t/api/shippers/${shipper.id}/documents`;
    expect((await shipperDocumentsRoute(getReq(url), withParams({ id: shipper.id }))).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "ship-docs-wrong-1");
    expect((await shipperDocumentsRoute(getReq(url, wrong), withParams({ id: shipper.id }))).status).toBe(403);

    const viewer = await signInWith(["shipping.view"], "ship-docs-view-1");
    const empty = await shipperDocumentsRoute(getReq(url, viewer), withParams({ id: shipper.id }));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);

    const bol = await prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "BOL", shipperId: shipper.id, coveredOrderIds: [order.id] }, Buffer.from("%PDF-1.4 bol")));

    const withDoc = await shipperDocumentsRoute(getReq(url, viewer), withParams({ id: shipper.id }));
    expect(withDoc.status).toBe(200);
    const docs = await withDoc.json();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ id: bol.id, kind: "BOL", shipperId: shipper.id, orderId: null, certId: null });
    // Metadata only, never the bytes — the cert sibling's own assertion (cert-routes.test.ts),
    // mirrored here (fix-wave 2026-08-06): a route that started selecting `fileData` would ship
    // every stored PDF's bytes with every list render.
    expect("fileData" in docs[0]).toBe(false);

    // An unknown shipper is a 404, not an empty list (the cert sibling's case, mirrored).
    expect((await shipperDocumentsRoute(
      getReq("http://t/api/shippers/nope/documents", viewer), withParams({ id: "nope" }))).status).toBe(404);
  });
});
