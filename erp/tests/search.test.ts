import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { globalSearch } from "@/server/search";
import type { SessionUser } from "@/server/sessions";

/**
 * A `SessionUser`-shaped fixture built directly (this is a SERVICE test, not a route test — no
 * `signInWith`/login round trip needed). Mirrors permissions.test.ts's `user()` helper, fleshed
 * out to the full `SessionUser` shape `getSessionUser` returns (`sessions.ts`): the scalar User
 * columns plus `role` (with its `permissions`) and `overrides`, both of which is all `can()`
 * (permissions.ts) ever actually reads. No overrides needed for this file's cases — every test
 * here is a pure role-grant question — so `overrides` is always empty.
 *
 * `SessionUser` narrowed to an explicit `select` (sessions.ts, the sibling-sweep fix that also
 * trimmed `activeManageUsersHolders`/`authenticateUser`/`createUser`'s dupe check in users.ts and
 * auth.ts): it no longer carries `passwordHash`/`roleId`/`signatureImage`/`signatureMimeType`/
 * `createdAt`/`updatedAt`, and `role`/`overrides` themselves are narrowed to exactly the fields
 * `can()` reads. This fixture is narrowed to match.
 */
let nextUserSeq = 0;
function sessionUser(rolePermissions: string[]): SessionUser {
  const n = nextUserSeq++;
  return {
    id: `search-user-${n}`, username: `search-user-${n}`,
    displayName: "Test User", active: true, deletedAt: null, lastSeenVersion: null,
    role: { permissions: rolePermissions.map((permission) => ({ permission })) },
    overrides: [],
  };
}

/** ACME/BETA plus one part on ACME ("DEMO-RG-1001") most tests key their order's lead line to. */
async function baseFixture() {
  const acme = await prisma.customer.create({ data: { code: "ACME", name: "Acme Gear" } });
  const beta = await prisma.customer.create({ data: { code: "BETA", name: "Beta Co" } });
  const leadPart = await prisma.part.create({
    data: { customerId: acme.id, partNumber: "DEMO-RG-1001", name: "Ring gear", eachWeight: "1.0000" },
  });
  return { acme, beta, leadPart };
}

/** Raw `prisma.order.create` (the orders-schema.test.ts precedent) — search.ts never touches
 *  orderability/loads/containers, so there is no reason to route fixtures through the full
 *  `createOrder` service and its process-revision preconditions. */
async function makeOrder(opts: {
  orderNumber: number; customerId: string; partId: string;
  poNumber?: string; vsOrderNumber?: string; voided?: boolean;
}) {
  return prisma.order.create({
    data: {
      orderNumber: opts.orderNumber, customerId: opts.customerId,
      poNumber: opts.poNumber ?? "", vsOrderNumber: opts.vsOrderNumber ?? "",
      receivedDate: new Date("2026-08-01"), requestDate: new Date("2026-08-05"),
      deletedAt: opts.voided ? new Date() : null,
      lines: { create: [{ position: 1, partId: opts.partId, qty: 1, weight: "1.00" }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  });
}

describe("globalSearch", () => {
  beforeEach(truncateAll);

  it.each(["123-ABC", "123-4ABC", "123-456-REV-A"])("#318 preserves ordinary numeric-prefix part and PO search %s", async term => {
    const { acme, leadPart } = await baseFixture();
    await prisma.part.update({ where: { id: leadPart.id }, data: { partNumber: term } });
    const order = await makeOrder({ orderNumber: 91246, customerId: acme.id, partId: leadPart.id, poNumber: term });
    const result = await globalSearch(sessionUser(["orders.view", "parts.view"]), term);
    expect(result.exactOrderId).toBeNull();
    expect(result.orders.map(row => row.id)).toEqual([order.id]);
    expect(result.parts.map(row => row.id)).toEqual([leadPart.id]);
    expect(result).not.toHaveProperty("scanError");
  });

  it.each(["1001-A", "123-4ABC", "123-456-REV-A", "91246-", "91246-1-extra"])(
    "#318 shows normal empty results for unmatched or incomplete search %s", async term => {
      const { acme, leadPart } = await baseFixture();
      const order = await makeOrder({ orderNumber: 91246, customerId: acme.id, partId: leadPart.id });
      await prisma.load.create({ data: { orderId: order.id, loadNumber: 1, qty: 1 } });
      // No PO/part substring matches: an existing valid order/load must not turn these
      // ordinary or incomplete queries into either a barcode error or automatic navigation.
      expect(await globalSearch(sessionUser(["orders.view", "parts.view", "customers.view"]), term))
        .toEqual({ exactOrderId: null, orders: [], parts: [], customers: [] });
    },
  );

  it("#318 resolves each combined barcode to its exact order and load", async () => {
    const { acme, leadPart } = await baseFixture();
    const order = await makeOrder({ orderNumber: 91246, customerId: acme.id, partId: leadPart.id });
    await prisma.load.createMany({ data: [1, 2, 3, 4, 5].map(loadNumber => ({ orderId: order.id, loadNumber, qty: 1 })) });
    const user = sessionUser(["orders.view"]);
    for (const [index, payload] of ["91246-1", "91246-2", "91246-3", "91246-4", "91246-5"].entries()) {
      const result = await globalSearch(user, payload);
      expect(result).toMatchObject({ exactOrderId: order.id, exactLoadNumber: index + 1 });
      expect(result.orders.map(row => row.id)).toEqual([order.id]);
    }
    const legacy = await globalSearch(user, "91246");
    expect(legacy.exactOrderId).toBe(order.id);
    expect(legacy).not.toHaveProperty("exactLoadNumber");
    expect(await globalSearch(sessionUser([]), "91246-2")).toMatchObject({
      exactOrderId: order.id, exactLoadNumber: 2, orders: [], parts: [], customers: [],
    });
  });

  it("#318 refuses missing, voided and malformed order-load pairs without falling back to a different result", async () => {
    const { acme, leadPart } = await baseFixture();
    const live = await makeOrder({ orderNumber: 91246, customerId: acme.id, partId: leadPart.id });
    const voided = await makeOrder({ orderNumber: 91247, customerId: acme.id, partId: leadPart.id, voided: true });
    await prisma.load.createMany({ data: [live, voided].map(order => ({ orderId: order.id, loadNumber: 1, qty: 1 })) });
    // Even a literal PO match must never hijack a scan of a nonexistent load.
    await makeOrder({ orderNumber: 91248, customerId: acme.id, partId: leadPart.id, poNumber: "91246-2" });
    // An incomplete typed prefix can still offer explicit grouped search results. Enter
    // must not automatically navigate to that unrelated PO as if it were a decoded load.
    const partial = await globalSearch(sessionUser(["orders.view"]), "91246-");
    expect(partial.exactOrderId).toBeNull();
    expect(partial).not.toHaveProperty("exactLoadNumber");
    for (const payload of ["91246-2", "91247-1", "99999-1", "91246-0", "91246--1", "91246-1.5", "91246-2147483648", "2147483648-1", "91246-01", "091246-1"]) {
      expect(await globalSearch(sessionUser(["orders.view"]), payload)).toMatchObject({
        exactOrderId: null, orders: [], parts: [], customers: [], scanError: expect.any(String),
      });
    }
  });

  it("resolves exactOrderId from a live order's number and still fills the orders group", async () => {
    const { acme, leadPart } = await baseFixture();
    const order = await makeOrder({
      orderNumber: 1042, customerId: acme.id, partId: leadPart.id, poNumber: "PO-8891",
    });
    const user = sessionUser(["orders.view", "parts.view", "customers.view"]);

    const result = await globalSearch(user, "1042");

    expect(result.exactOrderId).toBe(order.id);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]).toMatchObject({
      id: order.id, orderNumber: 1042, customerCode: "ACME",
      poNumber: "PO-8891", leadPartNumber: "DEMO-RG-1001",
    });
  });

  it("exactOrderId resolves even without orders.view — only the group array is permission-gated", async () => {
    const { acme, leadPart } = await baseFixture();
    const order = await makeOrder({ orderNumber: 1090, customerId: acme.id, partId: leadPart.id });
    const user = sessionUser([]); // no permissions at all

    const result = await globalSearch(user, "1090");

    expect(result.exactOrderId).toBe(order.id);
    expect(result.orders).toEqual([]);
  });

  it("a serial hit surfaces the order that owns it", async () => {
    const { acme, leadPart } = await baseFixture();
    const order = await makeOrder({ orderNumber: 1050, customerId: acme.id, partId: leadPart.id });
    await prisma.orderSerial.create({
      data: { orderId: order.id, lineId: order.lines[0].id, position: 1, serial: "EC-9001" },
    });
    const user = sessionUser(["orders.view"]);

    const result = await globalSearch(user, "ec-9001"); // case-insensitive

    expect(result.orders.map((o) => o.id)).toEqual([order.id]);
  });

  it("matches PO number and VS order number, case-insensitively", async () => {
    const { acme, leadPart } = await baseFixture();
    const order = await makeOrder({
      orderNumber: 1060, customerId: acme.id, partId: leadPart.id,
      poNumber: "PO-8891", vsOrderNumber: "VS-4410",
    });
    const user = sessionUser(["orders.view"]);

    expect((await globalSearch(user, "po-8891")).orders.map((o) => o.id)).toEqual([order.id]);
    expect((await globalSearch(user, "vs-4410")).orders.map((o) => o.id)).toEqual([order.id]);
  });

  it("a lead-part-number hit surfaces the order, but a rider's part number does not", async () => {
    const { acme, leadPart } = await baseFixture();
    const rider = await prisma.part.create({
      data: { customerId: acme.id, partNumber: "RIDER-9", eachWeight: "1.0000" },
    });
    const order = await makeOrder({ orderNumber: 1065, customerId: acme.id, partId: leadPart.id });
    await prisma.orderLine.create({
      data: { orderId: order.id, position: 2, partId: rider.id, qty: 1, weight: "1.00" },
    });
    const user = sessionUser(["orders.view"]);

    expect((await globalSearch(user, "DEMO-RG-1001")).orders.map((o) => o.id)).toEqual([order.id]);
    expect(await globalSearch(user, "RIDER-9")).toMatchObject({ orders: [] });
  });

  it("returns per-customer duplicate part numbers as separate rows with their own customer codes", async () => {
    const { acme, beta } = await baseFixture();
    const acmePart = await prisma.part.create({
      data: { customerId: acme.id, partNumber: "DUP-1", name: "Acme dup", eachWeight: "1.0000" },
    });
    const betaPart = await prisma.part.create({
      data: { customerId: beta.id, partNumber: "DUP-1", name: "Beta dup", eachWeight: "1.0000" },
    });
    const user = sessionUser(["parts.view"]);

    const result = await globalSearch(user, "DUP-1");

    expect(result.parts).toHaveLength(2);
    expect(result.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: acmePart.id, partNumber: "DUP-1", customerCode: "ACME" }),
      expect.objectContaining({ id: betaPart.id, partNumber: "DUP-1", customerCode: "BETA" }),
    ]));
  });

  it("matches customers by code or name, case-insensitively", async () => {
    const { acme } = await baseFixture();
    const user = sessionUser(["customers.view"]);

    expect((await globalSearch(user, "acme")).customers.map((c) => c.id)).toEqual([acme.id]);
    expect((await globalSearch(user, "GEAR")).customers.map((c) => c.id)).toEqual([acme.id]);
  });

  it("permission filtering empties exactly the groups the caller cannot view", async () => {
    const customer = await prisma.customer.create({ data: { code: "MATCHX", name: "Match Co" } });
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "MATCHX", name: "Match part", eachWeight: "1.0000" },
    });
    await makeOrder({ orderNumber: 1070, customerId: customer.id, partId: part.id });

    const full = await globalSearch(
      sessionUser(["orders.view", "parts.view", "customers.view"]), "MATCHX",
    );
    expect(full.orders.length).toBeGreaterThan(0);
    expect(full.parts.length).toBeGreaterThan(0);
    expect(full.customers.length).toBeGreaterThan(0);

    const partsOnly = await globalSearch(sessionUser(["parts.view"]), "MATCHX");
    expect(partsOnly.orders).toEqual([]);
    expect(partsOnly.customers).toEqual([]);
    expect(partsOnly.parts.length).toBeGreaterThan(0);

    const ordersOnly = await globalSearch(sessionUser(["orders.view"]), "MATCHX");
    expect(ordersOnly.parts).toEqual([]);
    expect(ordersOnly.customers).toEqual([]);
    expect(ordersOnly.orders.length).toBeGreaterThan(0);

    const customersOnly = await globalSearch(sessionUser(["customers.view"]), "MATCHX");
    expect(customersOnly.orders).toEqual([]);
    expect(customersOnly.parts).toEqual([]);
    expect(customersOnly.customers.length).toBeGreaterThan(0);

    const none = await globalSearch(sessionUser([]), "MATCHX");
    expect(none).toEqual({ exactOrderId: null, orders: [], parts: [], customers: [] });
  });

  it("excludes voided orders from both the orders group and exactOrderId", async () => {
    const { acme, leadPart } = await baseFixture();
    await makeOrder({
      orderNumber: 1080, customerId: acme.id, partId: leadPart.id, poNumber: "PO-VOID", voided: true,
    });
    const user = sessionUser(["orders.view"]);

    expect((await globalSearch(user, "PO-VOID")).orders).toEqual([]);

    const byNumber = await globalSearch(user, "1080");
    expect(byNumber.exactOrderId).toBeNull();
    expect(byNumber.orders).toEqual([]);
  });

  it("excludes soft-deleted parts and customers", async () => {
    const { acme } = await baseFixture();
    await prisma.part.create({
      data: { customerId: acme.id, partNumber: "GONE-1", eachWeight: "1.0000", deletedAt: new Date() },
    });
    await prisma.customer.create({ data: { code: "GONE-C", name: "Gone Co", deletedAt: new Date() } });
    const user = sessionUser(["parts.view", "customers.view"]);

    expect((await globalSearch(user, "GONE-1")).parts).toEqual([]);
    expect((await globalSearch(user, "GONE-C")).customers).toEqual([]);
  });

  it("survives a search term too large for an Int order number", async () => {
    const user = sessionUser(["orders.view"]);

    const result = await globalSearch(user, "99999999999999");

    expect(result.exactOrderId).toBeNull();
    expect(result.orders).toEqual([]);
  });

  it("a query shorter than 1 trimmed character returns every group empty and a null exact match", async () => {
    const user = sessionUser(["orders.view", "parts.view", "customers.view"]);

    expect(await globalSearch(user, "")).toEqual({ exactOrderId: null, orders: [], parts: [], customers: [] });
    expect(await globalSearch(user, "   ")).toEqual({ exactOrderId: null, orders: [], parts: [], customers: [] });
  });

  it("caps each group at 10 rows", async () => {
    const { acme } = await baseFixture();
    for (let i = 0; i < 12; i++) {
      await prisma.part.create({
        data: { customerId: acme.id, partNumber: `CAP-${i}`, eachWeight: "1.0000" },
      });
    }
    const user = sessionUser(["parts.view"]);

    expect((await globalSearch(user, "CAP-")).parts).toHaveLength(10);
  });
});
