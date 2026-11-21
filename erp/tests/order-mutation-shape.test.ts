import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { code, declared, jsxTags, mentions } from "./helpers/jsx-source";
import { runWithContext } from "@/server/context";
import { addLine, createOrder, getOrder } from "@/server/orders";
import { replaceLoads } from "@/server/order-loads";

import { PATCH as patchRoute } from "@/app/api/orders/[id]/route";
import { POST as addLineRoute } from "@/app/api/orders/[id]/lines/route";
import { PATCH as patchLineRoute, DELETE as removeLineRoute } from "@/app/api/orders/[id]/lines/[lineId]/route";
import { PUT as replaceLoadsRoute } from "@/app/api/orders/[id]/loads/route";
import { POST as resplitRoute } from "@/app/api/orders/[id]/loads/resplit/route";

// The six order edits that used to answer `{ order, warnings }` answer the bare order, as the
// other five do, and the order page holds no banner for a save's warnings (the design's §10.2 and
// §10.3, 2026-10-08). What a save leaves out of step is read from the order: the summary's
// quantities line and the Loads section's standing sentence.
//
// The first half calls the six routes, one case each, so a route that fails does not hide the
// others. Each call is made where the old code answered a warning: the loads do not sum to the
// lines before the call (and after it too, except for the re-split, which makes them agree), and
// a traveler has printed. The second half reads the page
// and the bulk grids' recovery leaf as source, because vitest has no DOM and nothing renders the
// hub whole (the tests/order-invoice-gates.test.ts precedent).
//
// The other five edit routes (containers, serials, charges, link and unlink) are not called here.
// tests/order-routes.test.ts reads a top-level key of the order off each one's answer.
//
// Order entry's `POST /api/orders` is another route. It still answers
// `{ order, warnings, printExpectation }`, pinned in tests/orders.test.ts and
// tests/order-routes.test.ts.

const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

function bodyReq(url: string, method: string, cookie: string, body: unknown): Request {
  return new Request(url, {
    method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
function noBodyReq(url: string, method: string, cookie: string): Request {
  return new Request(url, { method, headers: { cookie } });
}

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

/** ACME, a lead part with revision 1 and one step (the orderability precondition, spec §5.3), and
 *  two rider parts. Raw prisma, the tests/order-routes.test.ts precedent. */
async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme Gear" } });
  const stepCode = await prisma.processStepCode.create({ data: { code: "HT-01", name: "Austenitize" } });
  const lead = await prisma.part.create({
    data: { customerId: customer.id, partNumber: "DEMO-RG-1001", name: "Ring gear", eachWeight: "13.5000" },
  });
  const rider = await prisma.part.create({
    data: { customerId: customer.id, partNumber: "DEMO-RG-1002", name: "Ring gear B", eachWeight: "13.5000" },
  });
  const second = await prisma.part.create({
    data: { customerId: customer.id, partNumber: "DEMO-RG-1003", name: "Ring gear C", eachWeight: "13.5000" },
  });
  const rev = await prisma.partProcessRevision.create({ data: { partId: lead.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: stepCode.id, instruction: "Austenitize at 1650F." },
  });
  return { customer, lead, rider, second };
}

/**
 * An order where the old code answered a warning to every one of the six edits: a lead of 10
 * pieces and a rider of 5 against one load of 3, with a traveler printed. No single edit below
 * brings the load back to the lines' total but the re-split, which answered for the printed
 * traveler. Built through the services, so each case below calls one route and no other.
 */
async function scene() {
  const { customer, lead, rider, second } = await fixture();
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, lines: [{ partId: lead.id, qty: 10, weight: "135.00" }],
  }));
  const id = order.id;
  const withRider = await asSystem(() => addLine(id, { partId: rider.id, qty: 5, weight: "67.50" }));
  await asSystem(() => replaceLoads(id, [{ loadNumber: 1, qty: 3, weight: "40.50" }]));
  await prisma.storedDocument.create({
    data: { orderId: id, kind: "TRAVELER", fileData: Buffer.from("pdf-bytes") },
  });
  const editor = await signInWith(["orders.edit"], "shape-edit-1");
  return {
    id, editor, riderLineId: withRider.lines[1].id, secondPartId: second.id,
    at: (tail: string) => `http://t/api/orders/${id}${tail}`,
  };
}
type Scene = Awaited<ReturnType<typeof scene>>;

/** The six routes, each as one call on the scene's order. */
const SIX: [string, (s: Scene) => Promise<Response>][] = [
  ["PATCH /api/orders/[id]", (s) => patchRoute(
    bodyReq(s.at(""), "PATCH", s.editor, { notes: "rush" }), withParams({ id: s.id }))],
  ["POST /api/orders/[id]/lines", (s) => addLineRoute(
    bodyReq(s.at("/lines"), "POST", s.editor, { partId: s.secondPartId, qty: 2, weight: "27.00" }), withParams({ id: s.id }))],
  ["PATCH /api/orders/[id]/lines/[lineId]", (s) => patchLineRoute(
    bodyReq(s.at(`/lines/${s.riderLineId}`), "PATCH", s.editor, { qty: 6 }), withParams({ id: s.id, lineId: s.riderLineId }))],
  ["DELETE /api/orders/[id]/lines/[lineId]", (s) => removeLineRoute(
    noBodyReq(s.at(`/lines/${s.riderLineId}`), "DELETE", s.editor), withParams({ id: s.id, lineId: s.riderLineId }))],
  ["PUT /api/orders/[id]/loads", (s) => replaceLoadsRoute(
    bodyReq(s.at("/loads"), "PUT", s.editor, [{ loadNumber: 1, qty: 4, weight: "54.00" }]), withParams({ id: s.id }))],
  ["POST /api/orders/[id]/loads/resplit", (s) => resplitRoute(
    noBodyReq(s.at("/loads/resplit"), "POST", s.editor), withParams({ id: s.id }))],
];

describe("the six order edit routes answer the bare order", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("the scene is one the old code warned about: 15 pieces on the lines, 3 in the one load, a traveler printed", async () => {
    const { id } = await scene();
    const order = await getOrder(id);
    expect(order.lines.map((line) => line.qty)).toEqual([10, 5]);
    expect(order.loads.map((load) => load.qty)).toEqual([3]);
    expect(order.travelerPrinted).toBe(true);
  });

  it.each(SIX)("%s answers the order itself: no `order` wrapper and no `warnings` key", async (_name, call) => {
    const s = await scene();
    // A bare order's keys: the full read's, less the one field only that read carries.
    const bareKeys = Object.keys(await getOrder(s.id)).filter((key) => key !== "finalizedInvoiceId").sort();
    expect(bareKeys).toContain("loads");
    expect(bareKeys).not.toContain("warnings");
    expect(bareKeys).not.toContain("order");

    const res = await call(s);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(bareKeys);
    expect(body.id).toBe(s.id);
  });
});

describe("the order hub holds no warnings banner", () => {
  const PAGE = "src/app/orders/[id]/page.tsx";
  const LEAF = "src/lib/order-bulk-recovery.ts";

  it("the page names no warnings state, no setter for one and no unwrapper", () => {
    // The reader finds what is written: both of these names are in the page.
    expect(mentions(PAGE, "applyMutation")).toBeGreaterThan(1);
    expect(mentions(PAGE, "setError")).toBeGreaterThan(1);
    for (const name of ["warnings", "setWarnings", "unwrapMutation"]) expect(mentions(PAGE, name), name).toBe(0);
  });

  it("the one amber element the page renders itself is a paragraph: the list of warnings is gone", () => {
    // The warning colour is `NOTICE.warning` since commit 1d5e9be9 (the page spells no `bg-accent-50` of its own).
    const amber = jsxTags(PAGE).filter((tag) => (tag.attr("className") ?? "").includes("NOTICE.warning"));
    expect(amber.map((tag) => tag.name)).toEqual(["p"]);
  });

  it("applyMutation applies the response itself as the order, once the gate accepts it", () => {
    const found = declared(PAGE, "applyMutation");
    expect(found).toHaveLength(1);
    expect(code(found[0])).toContain(
      "if(!mutations.accept(ticket))return;constfresh=res;voidrecoveryRead.accept(fresh);");
  });

  it("the bulk grids take the answer as the order: their recovery leaf has no unwrapper", () => {
    expect(mentions(LEAF, "orderAckSnapshot")).toBe(1);
    expect(mentions(LEAF, "mutationOrder")).toBe(0);
  });
});
