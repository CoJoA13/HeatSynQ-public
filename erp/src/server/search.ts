import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { can } from "./permissions";
import type { SessionUser } from "./sessions";

export type SearchResults = {
  exactOrderId: string | null;
  exactLoadNumber?: number;
  scanError?: string;
  orders: { id: string; orderNumber: number; customerCode: string; poNumber: string; leadPartNumber: string }[];
  parts: { id: string; partNumber: string; customerCode: string; name: string }[];
  customers: { id: string; code: string; name: string }[];
};

/** Every group's cap, brief: "≤10 rows per group, ordered by recency". */
const MAX_ROWS = 10;

/**
 * `Order.orderNumber` is a plain Int4 column (schema.prisma) — a digit string wider than that is
 * not "no match", it is a value Prisma refuses to serialize at all (a validation error, not an
 * empty result). Mirrors the guard `searchWhere` uses for the board in orders.ts:
 * `Number.isSafeInteger` first, since a long digit string can parse past a safe integer (or even
 * to `Infinity`) before the range check would otherwise catch it.
 */
function parsedOrderNumber(term: string): number | null {
  if (!/^\d+$/.test(term)) return null;
  const n = Number(term);
  return Number.isSafeInteger(n) && n <= 2_147_483_647 ? n : null;
}

/**
 * The digit-only short-circuit (task-8-brief: "input is all digits AND matches a live order's
 * number"). Deliberately NOT gated on `orders.view`, unlike the `orders` group below — the brief
 * states its two conditions (digits, live order) with no permission clause, and
 * phase-3-orders-design.md §8 (Services) lists it as a capability distinct from the
 * permission-filtered groups: "grouped global search ..., permission-filtered per group,
 * exact-order-number short-circuit" — two clauses, not one. An order NUMBER is also the legacy barcode
 * payload (and remains the payload for an order without loads) (the approved spec §4: "scanning it into the global search
 * opens the order"; §6: "traveler barcode scans land here and open the order directly") —
 * confirming a bare number is live is not the same disclosure as the `orders` group's
 * PO/VS#/customer-bearing rows. The Shell's landing on `/orders/[id]` still goes through that
 * route's own `requireUser` + `mustCan`, which is the real gate on the order's contents
 * (CLAUDE.md: "Real authorization is `requireUser` + `mustCan` in every route").
 */
async function findExactOrderId(term: string): Promise<string | null> {
  const orderNumber = parsedOrderNumber(term);
  if (orderNumber === null) return null;
  const row = await prisma.order.findFirst({ where: { orderNumber, deletedAt: null }, select: { id: true } });
  return row?.id ?? null;
}

/**
 * Number / PO / VS# / serial / lead-part-number. Mirrors `searchWhere`'s (orders.ts) Int4
 * overflow guard, but deliberately does NOT also match on customer code/name the way that
 * board-search where-clause does — the `customers` group below already covers that surface, and
 * letting every group cascade through the customer relation would just triple up the same hits
 * across all three groups. Voided orders excluded (`deletedAt: null`, global-constraints: voided
 * orders are excluded everywhere in this service). Only the LEAD (position 1) line's part number
 * counts — same reasoning as the board: a rider match would surface an order under a part number
 * that appears nowhere in the row shown for it.
 */
async function searchOrders(term: string, exactId?: string): Promise<SearchResults["orders"]> {
  const clauses: Prisma.OrderWhereInput[] = [
    { poNumber: { contains: term, mode: "insensitive" } },
    { vsOrderNumber: { contains: term, mode: "insensitive" } },
    { serials: { some: { serial: { contains: term, mode: "insensitive" } } } },
    { lines: { some: { position: 1, part: { partNumber: { contains: term, mode: "insensitive" } } } } },
  ];
  const orderNumber = parsedOrderNumber(term);
  if (orderNumber !== null) clauses.push({ orderNumber });

  // JIT off for this read alone (#888; owner ruling 2026-11-04: per search transaction, never for
  // the database or Compose). Its plan's estimated cost passes `jit_above_cost`, so Postgres
  // compiled it on every debounced keystroke. Measured 2026-11-04 by EXPLAIN (ANALYZE) on a scratch
  // `postgres:18` holding 20,000 orders, 200,000 serials and 3,000 parts, median of five: a term
  // that matches nothing 157 → 11.5 ms, a lead part number prefix 212 → 20 ms, JIT itself
  // taking 134 and 188 ms of one run each. `SET LOCAL` lasts only to the end of its transaction, so the
  // read runs inside one, on `tx`; outside a transaction it would be a no-op with a warning, and a
  // plain `SET` would stay on the pooled connection for every later query.
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL jit = off`;
    return tx.order.findMany({
      where: { id: exactId, deletedAt: null, OR: clauses },
      select: {
        id: true, orderNumber: true, poNumber: true,
        customer: { select: { code: true } },
        lines: { where: { position: 1 }, select: { part: { select: { partNumber: true } } }, take: 1 },
      },
      orderBy: { createdAt: "desc" },
      take: MAX_ROWS,
    });
  });
  return rows.map((r) => ({
    id: r.id, orderNumber: r.orderNumber, customerCode: r.customer.code,
    poNumber: r.poNumber, leadPartNumber: r.lines[0]?.part.partNumber ?? "",
  }));
}

/**
 * partNumber or name, case-insensitive. Soft-deleted parts excluded; inactive ones are NOT — this
 * is a lookup surface (find the record), not `listParts`'s picker (choose a record to assign),
 * so there is no reason to hide it the way the picker does by default. Per-customer duplicate
 * part numbers both come back, each carrying its own customer code (Phase 2 kickoff §2 / spec
 * §15 heritage: "a part number alone must never identify a part").
 */
async function searchParts(term: string): Promise<SearchResults["parts"]> {
  const rows = await prisma.part.findMany({
    where: {
      deletedAt: null,
      OR: [
        { partNumber: { contains: term, mode: "insensitive" } },
        { name: { contains: term, mode: "insensitive" } },
      ],
    },
    select: { id: true, partNumber: true, name: true, customer: { select: { code: true } } },
    orderBy: { createdAt: "desc" },
    take: MAX_ROWS,
  });
  return rows.map((r) => ({ id: r.id, partNumber: r.partNumber, customerCode: r.customer.code, name: r.name }));
}

/** code or name, case-insensitive. Soft-deleted customers excluded, inactive ones not — same
 *  lookup-vs-picker reasoning as `searchParts`. */
async function searchCustomers(term: string): Promise<SearchResults["customers"]> {
  return prisma.customer.findMany({
    where: {
      deletedAt: null,
      OR: [
        { code: { contains: term, mode: "insensitive" } },
        { name: { contains: term, mode: "insensitive" } },
      ],
    },
    select: { id: true, code: true, name: true },
    orderBy: { createdAt: "desc" },
    take: MAX_ROWS,
  });
}

/**
 * Grouped global search (the approved spec §6: "Global search box on every screen"; Phase 3
 * design phase-3-orders-design.md §1/§8/§11). Purely read-only: no audit trail, plain prisma
 * queries (task-8-brief), and no transaction but the orders group's, which exists only to scope
 * its `SET LOCAL jit = off` (#888, `searchOrders`). Each group is independently permission-filtered: a caller
 * lacking `{area}.view` gets an EMPTY array for that group — never omitted from the object, never
 * a 403, so the Shell dropdown can render whatever it is given without every caller special-casing
 * a missing key. `exactOrderId` fills alongside the groups unconditionally; see
 * `findExactOrderId`'s comment for why it is not itself permission-gated.
 *
 * `q.trim()` shorter than 1 character means "nothing to search": every group empty, no exact
 * match — never the first `MAX_ROWS` rows of everything.
 */
export async function globalSearch(user: SessionUser, q: string): Promise<SearchResults> {
  const term = q.trim();
  if (term.length < 1) return { exactOrderId: null, orders: [], parts: [], customers: [] };

  // A digit-dash prefix also occurs in part/PO searches and unfinished manual input.
  // Diagnose malformed scans only when both sides look numeric (including invalid signs,
  // decimals or zeroes); letters and missing load numbers keep ordinary search feedback.
  const malformedScan = /^[+-]?\d+\s*-\s*[+-]?\d+(?:\.\d+)?$/.test(term)
    && !/^([1-9]\d*)-([1-9]\d*)$/.test(term);
  // Only a canonical numeric pair is reserved for exact traveler lookup. Alphanumeric part,
  // PO and customer identifiers retain grouped search, without automatic scan navigation.
  const pair = /^([1-9]\d*)-([1-9]\d*)$/.exec(term);
  const invalidScanMessage = "Invalid traveler barcode. Use work order-load, for example 91246-2.";
  if (pair) {
    const empty = { exactOrderId: null, orders: [], parts: [], customers: [] };
    const orderNumber = parsedOrderNumber(pair[1]);
    const loadNumber = parsedOrderNumber(pair[2]);
    if (orderNumber === null || loadNumber === null) return { ...empty, scanError: invalidScanMessage };
    const order = await prisma.order.findFirst({
      where: { orderNumber, deletedAt: null, loads: { some: { loadNumber } } },
      select: { id: true },
    });
    if (!order) return { ...empty, scanError: `No current load matches traveler ${term}. Check the traveler and load numbers.` };
    return {
      ...empty, exactOrderId: order.id, exactLoadNumber: loadNumber,
      orders: can(user, "orders", "view") ? await searchOrders(String(orderNumber), order.id) : [],
    };
  }

  const [exactOrderId, orders, parts, customers] = await Promise.all([
    findExactOrderId(term),
    can(user, "orders", "view") ? searchOrders(term) : Promise.resolve([]),
    can(user, "parts", "view") ? searchParts(term) : Promise.resolve([]),
    can(user, "customers", "view") ? searchCustomers(term) : Promise.resolve([]),
  ]);

  return {
    exactOrderId, orders, parts, customers,
    ...(malformedScan && orders.length + parts.length + customers.length === 0 ? { scanError: invalidScanMessage } : {}),
  };
}
