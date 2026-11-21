import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { all } from "./helpers/source-lift";
import { seedDemoSlice, seedPracticeDemo } from "../prisma/demo-seed";
import { orderEntryReadiness } from "@/server/order-entry-readiness";
import { CONTAINER_ITEM } from "@/server/order-internals";
import { verifyPassword } from "@/server/password";
import { ALL_PERMISSIONS } from "@/server/permissions";

// The demo seed writes through the ambient `DATABASE_URL` singleton (erp_test in this process), so
// `seedDemoSlice()` — the un-guarded internal orchestration — is exercised directly here. The
// guarded entry (`seedPracticeDemo`) can only run its happy path on `erp_practice`, so in CI its
// REFUSAL is the test (the §5.3 db-identity guard-split).
describe("demo-seed", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("seeds a login-capable, gate-passing representative slice through the services", async () => {
    await seedDemoSlice();

    // A login-capable admin: Role -> ALL_PERMISSIONS -> a user whose hash verifies "admin".
    const admin = await prisma.user.findFirst({
      where: { username: "admin" },
      include: { role: { include: { permissions: true } } },
    });
    expect(admin).not.toBeNull();
    expect(admin!.role).not.toBeNull();
    expect(await verifyPassword(admin!.passwordHash, "admin")).toBe(true);
    expect(admin!.role!.permissions.length).toBe(ALL_PERMISSIONS.length);

    // Company identity + chart of accounts + arGlAccountId all set -> the order-entry gate passes
    // with no exemption.
    const readiness = await orderEntryReadiness();
    expect(readiness.ready).toBe(true);
    expect(readiness.gaps).toEqual([]);
    expect(await prisma.glAccount.count({ where: { deletedAt: null } })).toBeGreaterThan(0);
    const billing = await prisma.billingConfig.findFirst({ where: { id: "singleton" } });
    expect(billing?.arGlAccountId).not.toBeNull();
    // #227: `financeChargeRate` is a PERCENT number (1.5 = 1.5%/month — finance-charges.ts divides
    // by 100), unlike the fraction-convention salesTaxRate beside it. The seed once wrote the
    // fraction 0.015 here — a 0.015%/month charge, wrong by 100× in the dataset the manual's
    // screenshots teach from. Pin the convention, not just "some value".
    expect(billing?.financeChargeRate?.toNumber()).toBe(1.5);

    // Orders spanning every headline state (assert the SHAPE, not brittle counts).
    const statuses = new Set<string>(
      (await prisma.order.findMany({ where: { deletedAt: null }, select: { status: true } })).map((o) => o.status),
    );
    for (const state of ["OPEN", "PARTIAL_SHIPPED", "SHIPPED", "INVOICED"]) {
      expect(statuses.has(state)).toBe(true);
    }

    // At least one FINALIZED invoice, and one POSTED payment batch with a live payment.
    expect(await prisma.invoice.count({ where: { status: "FINALIZED" } })).toBeGreaterThanOrEqual(1);
    expect(await prisma.receiptBatch.count({ where: { status: "POSTED", deletedAt: null } })).toBeGreaterThanOrEqual(1);
    expect(await prisma.payment.count({ where: { deletedAt: null } })).toBeGreaterThanOrEqual(1);

    // A parent/division customer pair (the division points at the parent).
    const parent = await prisma.customer.findFirst({ where: { code: "AERO", deletedAt: null } });
    const division = await prisma.customer.findFirst({ where: { code: "AERO-MW", deletedAt: null } });
    expect(parent).not.toBeNull();
    expect(division?.parentId).toBe(parent!.id);

    // Built through the services, so `allocateNumber` bumped the counters rather than a pre-written
    // `*_number_next` seed: the first order is #1000 (the counter's default seed).
    const firstOrder = await prisma.order.findFirst({ where: { deletedAt: null }, orderBy: { orderNumber: "asc" } });
    expect(firstOrder?.orderNumber).toBe(1000);

    // Representative depth reached the leaves: pricing rows (with a break), recipes, specs, inspections.
    expect(await prisma.partPriceBreak.count({ where: { deletedAt: null } })).toBeGreaterThan(0);
    expect(await prisma.partInspection.count({ where: { deletedAt: null } })).toBeGreaterThan(0);
    expect(await prisma.partProcessStep.count()).toBeGreaterThan(0);

    // One container type carries a default tare each and the other two carry none (the weights
    // design's §9.4, Seeds). The practice reset runs this seed, so this is what a reset practice
    // copy holds. A type missing by name reads undefined here, which is not null: it fails.
    const containerTypes = await prisma.containerType.findMany({
      where: { deletedAt: null }, select: { name: true, tareEach: true },
    });
    const tareEachOf = new Map(containerTypes.map((type): [string, number | null] =>
      [type.name, type.tareEach?.toNumber() ?? null]));
    expect(tareEachOf.get("Steel Basket")).toBe(42.5);
    expect(tareEachOf.get("Wire Basket")).toBeNull();
    expect(tareEachOf.get("Wooden Crate")).toBeNull();
  });

  it("guarded entry refuses outside the practice database (the §5.3 RED guard)", async () => {
    // current_database() is 'erp_test' in this process, never 'erp_practice', so assertPracticeDatabase
    // throws a 403 before seedDemoSlice runs.
    await expect(seedPracticeDemo()).rejects.toMatchObject({ status: 403 });
    // Nothing was written — the guard fires first.
    expect(await prisma.order.count()).toBe(0);
  });
});

// `prisma/manual-seed.ts` cannot be run here. It starts when it is imported, and it refuses any
// database but one named `erp` on this machine. No check in this repository runs it, and
// `createOrder` and `createReference` take their input untyped, so the compiler does not read its
// keys either. `createShipper` takes its input untyped too. Its container types, its order container
// rows, the PO number beside each list of them and the rows its shipments pick from an order's are
// therefore read from its source, with the TypeScript parser and never a pattern: a row written
// over several lines reads the same.
type SeedLiteral = Record<string, string | number>;
type MappedRows = { orderId: string | null; from: string; keys: string[] | null };
type StatedList = [poNumber: string | null, rows: number];

function manualSeedContainers(source: string): {
  containerTypes: SeedLiteral[];
  orderContainers: SeedLiteral[];
  /** Each `containers` whose value is a call, in source order. `orderId` is the source text of the
   *  `orderId` beside it in the same object, or null when that object holds none. For
   *  `<from>.map(<an arrow that answers one object literal>)`, `from` is the receiver's source text
   *  and `keys` the literal's key names in order. For any other call, `from` is the call's own text
   *  and `keys` is null. Nothing is refused here: the list is held by value. */
  shipmentContainers: MappedRows[];
  /** Each `containers` whose value is an array literal, in source order, as a pair: the text of
   *  the `poNumber` string beside it in the same object, and how many rows the literal holds. The
   *  first is null when that object holds no `poNumber` written as a string. Nothing is refused
   *  here: the list is held by value. */
  orderContainerCounts: StatedList[];
} {
  // Parent nodes are set, because a call's rows are read with the `orderId` beside them, and a
  // stated list with the `poNumber` beside it: each is a key of the object the `containers` key
  // stands in.
  const file = ts.createSourceFile("manual-seed.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // One object literal as { key: value }. A string or a number reads as itself. Anything else,
  // such as `env.ctSteel`, reads as its source text. A shorthand key or a spread is refused: this
  // reader never passes over a key it cannot name.
  const read = (object: ts.ObjectLiteralExpression): SeedLiteral =>
    Object.fromEntries(object.properties.map((property): [string, string | number] => {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
        throw new Error(`manual-seed.ts: cannot read "${property.getText(file)}" as a plain key`);
      }
      const value = property.initializer;
      if (ts.isStringLiteral(value)) return [property.name.text, value.text];
      if (ts.isNumericLiteral(value)) return [property.name.text, Number(value.text)];
      return [property.name.text, value.getText(file)];
    }));
  // A container type: the second argument of `ref("containerType", { … })`. `all` is the walker
  // of tests/helpers/source-lift.ts, and gives its nodes in source order.
  const containerTypes = all(file, ts.isCallExpression).flatMap((call): SeedLiteral[] => {
    if (!ts.isIdentifier(call.expression) || call.expression.text !== "ref") return [];
    const [kind, input] = call.arguments;
    if (!kind || !ts.isStringLiteral(kind) || kind.text !== "containerType") return [];
    if (!input || !ts.isObjectLiteralExpression(input)) {
      throw new Error("manual-seed.ts: a container type is not created from an object literal");
    }
    return [read(input)];
  });
  // An order's container rows: a `containers` key, plain or quoted, whose value is an array
  // literal. Two forms are passed over, and no rows are read from them. One is a `containers`
  // whose value is the result of any call: a shipment's is `….map(…)`, and its rows are picked
  // from an order's, not stated. The other is a computed key (`["containers"]: …`), which is
  // neither a name nor a string to the test below. Two forms are refused, so that rows this reader
  // cannot read stop the test and never count as no rows: any other value of a plain or quoted
  // `containers` key, and a shorthand key. The seed has no computed `containers` key today, and
  // each call it has is a shipment's: `shipmentContainers`, below, reads them.
  for (const shorthand of all(file, ts.isShorthandPropertyAssignment)) {
    if (shorthand.name.text === "containers") {
      throw new Error("manual-seed.ts: cannot read container rows written as a shorthand key");
    }
  }
  const orderContainers = all(file, ts.isPropertyAssignment).flatMap((property): SeedLiteral[] => {
    const key = property.name;
    if (!(ts.isIdentifier(key) || ts.isStringLiteral(key)) || key.text !== "containers") return [];
    const value = property.initializer;
    if (ts.isCallExpression(value)) return [];
    if (!ts.isArrayLiteralExpression(value)) {
      throw new Error(`manual-seed.ts: cannot read container rows written as "${value.getText(file)}"`);
    }
    return value.elements.map((row) => {
      if (!ts.isObjectLiteralExpression(row)) {
        throw new Error("manual-seed.ts: an order container row is not an object literal");
      }
      return read(row);
    });
  });
  // A shipment's container rows: a `containers` key, plain or quoted, whose value is a call. They
  // are picked from an order's rows and not stated, so what is read is where each call stands and
  // what it sends. An `orderId` is looked for as `orderId: …`, plain or quoted, and in no other
  // form. A property of the answered literal whose key is neither a name nor a string reads as the
  // whole property's source text, so a spread is seen and never passed over.
  const keyName = (property: ts.ObjectLiteralElementLike): string | null =>
    property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      ? property.name.text : null;
  const shipmentContainers = all(file, ts.isPropertyAssignment).flatMap((property): MappedRows[] => {
    const value = property.initializer;
    if (keyName(property) !== "containers" || !ts.isCallExpression(value)) return [];
    const beside = property.parent.properties.find((other): other is ts.PropertyAssignment =>
      ts.isPropertyAssignment(other) && keyName(other) === "orderId");
    const orderId = beside ? beside.initializer.getText(file) : null;
    const callee = value.expression;
    const [arrow] = value.arguments;
    const answer = arrow && ts.isArrowFunction(arrow) && ts.isParenthesizedExpression(arrow.body)
      ? arrow.body.expression : undefined;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "map"
      && answer && ts.isObjectLiteralExpression(answer)) {
      const keys = answer.properties.map((key) => keyName(key) ?? key.getText(file));
      return [{ orderId, from: callee.expression.getText(file), keys }];
    }
    return [{ orderId, from: value.getText(file), keys: null }];
  });
  // Which order a stated list stands on: the `poNumber` beside it, looked for as `poNumber: …`,
  // plain or quoted, in the object the `containers` key stands in, and read only when it is a
  // string. A list that is a call's answer is a shipment's and is not counted here.
  const orderContainerCounts = all(file, ts.isPropertyAssignment).flatMap((property): StatedList[] => {
    const value = property.initializer;
    if (keyName(property) !== "containers" || !ts.isArrayLiteralExpression(value)) return [];
    const beside = property.parent.properties.find((other): other is ts.PropertyAssignment =>
      ts.isPropertyAssignment(other) && keyName(other) === "poNumber");
    const poNumber = beside && ts.isStringLiteral(beside.initializer) ? beside.initializer.text : null;
    return [[poNumber, value.elements.length]];
  });
  return { containerTypes, orderContainers, shipmentContainers, orderContainerCounts };
}

// The reader itself, over a line of source written here. No database and no seed file.
describe("the manual seed's source reader", () => {
  const rows = (source: string) => manualSeedContainers(source).orderContainers;

  it("reads container rows from an array literal, the key quoted or not", () => {
    expect(rows("createOrder({ containers: [{ typeId: env.ctSteel, count: 3 }] });"))
      .toEqual([{ typeId: "env.ctSteel", count: 3 }]);
    expect(rows('createOrder({ "containers": [{ count: 1 }] });')).toEqual([{ count: 1 }]);
  });

  it("passes over container rows that are the result of a call, as a shipment's are", () => {
    expect(rows("createShipper({ containers: order.containers.map((c) => ({ orderContainerId: c.id, count: c.count })) });"))
      .toEqual([]);
  });

  it.each([
    ["a name", "const built = [{ count: 1 }]; createOrder({ containers: built });"],
    ["a shorthand key", "const containers = [{ count: 1 }]; createOrder({ containers });"],
    ["an array literal under a cast", "createOrder({ containers: [{ count: 1 }] as never });"],
    ["a choice between two array literals", "createOrder({ containers: big ? [{ count: 2 }] : [] });"],
  ])("refuses container rows written as %s: rows it cannot read never count as no rows", (_form, source) => {
    expect(() => rows(source)).toThrow(/cannot read container rows/);
  });

  const picked = "(c) => ({ orderContainerId: c.id, count: c.count })";
  it.each<[string, string, MappedRows[]]>([
    ["a list mapped from an order's rows, beside its orderId",
      `createShipper({ orders: [{ orderId: orders.a.id, containers: orders.a.containers.map(${picked}) }] });`,
      [{ orderId: "orders.a.id", from: "orders.a.containers", keys: ["orderContainerId", "count"] }]],
    ["a mapped list with no orderId beside it",
      `createShipper({ containers: order.containers.map(${picked}) });`,
      [{ orderId: null, from: "order.containers", keys: ["orderContainerId", "count"] }]],
    ["a call of another method",
      `createShipper({ orderId: o.id, containers: o.containers.filter(${picked}) });`,
      [{ orderId: "o.id", from: `o.containers.filter(${picked})`, keys: null }]],
    ["a mapped list with a key that has no name",
      "createShipper({ orderId: o.id, containers: o.containers.map((c) => ({ ...c, count: 1 })) });",
      [{ orderId: "o.id", from: "o.containers", keys: ["...c", "count"] }]],
    ["a mapped list under quoted keys",
      `createShipper({ "orderId": o.id, "containers": o.containers.map(${picked}) });`,
      [{ orderId: "o.id", from: "o.containers", keys: ["orderContainerId", "count"] }]],
  ])("reads the rows of a call written as %s", (_form, source, expected) => {
    expect(manualSeedContainers(source).shipmentContainers).toEqual(expected);
  });

  it.each<[string, string, StatedList[]]>([
    ["two rows beside a poNumber",
      'createOrder({ poNumber: "PO-1", containers: [{ count: 1 }, { count: 2 }] });',
      [["PO-1", 2]]],
    ["one row with no poNumber beside it",
      "createOrder({ containers: [{ count: 1 }] });",
      [[null, 1]]],
    ["one row beside a poNumber that is a name and not a string",
      "createOrder({ poNumber: po, containers: [{ count: 1 }] });",
      [[null, 1]]],
    ["one row under quoted keys",
      'createOrder({ "poNumber": "PO-2", "containers": [{ count: 1 }] });',
      [["PO-2", 1]]],
    ["two orders, each list beside its own poNumber",
      'createOrder({ poNumber: "PO-3", containers: [{ count: 1 }] }); createOrder({ poNumber: "PO-4", containers: [] });',
      [["PO-3", 1], ["PO-4", 0]]],
    ["a call's rows, which are a shipment's and not stated",
      `createShipper({ poNumber: "PO-5", containers: o.containers.map(${picked}) });`,
      []],
  ])("reads which order a stated list stands on, for %s", (_form, source, expected) => {
    expect(manualSeedContainers(source).orderContainerCounts).toEqual(expected);
  });
});

describe("manual seed, read from its source", () => {
  // Read in a hook, not in the describe body. A reader that throws then fails this block, by its
  // name, and skips its cases, and the database-backed cases above still run. In the body it would
  // stop the whole file before any case was collected.
  let seed: ReturnType<typeof manualSeedContainers>;
  beforeAll(() => {
    seed = manualSeedContainers(readFileSync(new URL("../prisma/manual-seed.ts", import.meta.url), "utf8"));
  });

  it("gives Cardboard Gaylord a default tare each and Steel Rack none", () => {
    expect(seed.containerTypes).toEqual([
      { name: "Cardboard Gaylord", tareEach: "60.00" },
      { name: "Steel Rack" },
    ]);
  });

  it("states its four order container rows as row totals, with no scale gross", () => {
    // The blanket order: 3 baskets, 252 pieces in all, 42.50 lb each (the weights design's §9.1).
    // It follows from keeping the saved-order figure's `2 over` under the row's new meaning: 252
    // pieces against the line's 250. The aerospace order: 5 gaylords at 60.00 lb each, no Pieces.
    // The two orders of the multi-order shipment (the weights design's §15.1, answer 1): 4 baskets
    // stating 300 pieces at 42.50 lb each, and 4 gaylords stating 800 pieces at 60.00 lb each. This
    // case holds the four rows as one list, in the seed's order. Which order each stands on is the
    // next case's.
    expect(seed.orderContainers).toEqual([
      { typeId: "env.ctSteel", count: 3, pieces: 252, tareEach: "42.50" },
      { typeId: "env.ctGaylord", count: 5, tareEach: "60.00" },
      { typeId: "env.ctSteel", count: 4, pieces: 300, tareEach: "42.50" },
      { typeId: "env.ctGaylord", count: 4, pieces: 800, tareEach: "60.00" },
    ]);
  });

  it("stands each list of rows on its own order, one row on each of the four", () => {
    // By the PO number beside each list, in the seed's order: the blanket order, the aerospace
    // order, and the two orders of the multi-order shipment. The case above holds the rows as one
    // list, which can read the same when a row is moved to another order. One row on each and no
    // more: the capture tool's choice of the saved order counts an order's container rows
    // (e2e/lib/manual-ids.ts), so a row added or moved here can move the manual's picture.
    expect(seed.orderContainerCounts).toEqual([
      ["TT-9004", 1],
      ["ADSE-3312", 1],
      ["MF-5701", 1],
      ["MF-5702", 1],
    ]);
  });

  it("sends only what the order service's container shape accepts", () => {
    // The shape is strict, so a key it does not know is a refusal, and the seed would stop at its
    // first order with containers. Four rows must have been read, or the check below proves nothing.
    expect(seed.orderContainers).toHaveLength(4);
    const refusals = seed.orderContainers.map((row) => {
      const parsed = CONTAINER_ITEM.safeParse(row);
      return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
    });
    expect(refusals).toEqual([[], [], [], []]);
  });

  it("ships each order's own container rows, by id and count and with no tare each", () => {
    // The blanket order's shipment, then the two orders of the multi-order shipment. Each maps its
    // own order's rows and sends `orderContainerId` and `count`. With no `tareEach` key a row new to
    // a shipment takes its order row's figure (createShipper, src/server/shippers.ts). That service
    // refuses a row picked from another order's, but only when the seed runs, and no check runs it.
    expect(seed.shipmentContainers).toEqual([
      { orderId: "orders.titanBlanket.id", from: "orders.titanBlanket.containers", keys: ["orderContainerId", "count"] },
      { orderId: "orders.multiA.id", from: "orders.multiA.containers", keys: ["orderContainerId", "count"] },
      { orderId: "orders.multiB.id", from: "orders.multiB.containers", keys: ["orderContainerId", "count"] },
    ]);
  });
});
