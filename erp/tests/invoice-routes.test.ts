import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { readXlsx } from "./helpers/xlsx";
import { runWithContext } from "@/server/context";
import { createOrder, getOrder, type OrderDetail } from "@/server/orders";
import { createShipper } from "@/server/shippers";
import {
  createInvoice, replaceInvoiceLines, finalizeInvoice, getInvoice, type InvoiceDetail,
} from "@/server/invoices";
import type { Customer, Part } from "../prisma/generated/prisma/client";

import { GET as listRoute, POST as createRoute } from "@/app/api/invoices/route";
import { GET as exportRoute } from "@/app/api/invoices/export/route";
import { GET as registerRoute } from "@/app/api/invoices/register/route";
import { GET as getRoute, PATCH as patchRoute, DELETE as deleteRoute } from "@/app/api/invoices/[id]/route";
import { PUT as linesRoute } from "@/app/api/invoices/[id]/lines/route";
import { POST as recalculateRoute } from "@/app/api/invoices/[id]/recalculate/route";
import { POST as finalizeRoute } from "@/app/api/invoices/[id]/finalize/route";
import { POST as unlockRoute } from "@/app/api/invoices/[id]/unlock/route";
import { POST as creditRoute } from "@/app/api/invoices/[id]/credit/route";
import { GET as ordersInvoicesRoute } from "@/app/api/orders/[id]/invoices/route";
import { GET as stepSuggestionsRoute } from "@/app/api/invoices/[id]/step-suggestions/route";

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

// -------------------------------------------------------------------------------------------
// Fixtures — through the SERVICE, not a route under test (the shipper-routes.test.ts
// `orderFixture` precedent: a bug in some other route must never be able to mask a bug in the
// invoice routes this file actually tests).
// -------------------------------------------------------------------------------------------

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({ data: { code: `IRC${customerSeq}`, name: `Invoice Route Customer ${customerSeq}` } });
}

let partSeq = 0;
async function makePart(customerId: string): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({ data: { customerId, partNumber: `IRP-${partSeq}`, eachWeight: "1.0000" } });
}

async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `IRHT-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

async function savedOrder(): Promise<{ order: OrderDetail; customer: Customer }> {
  const customer = await makeCustomer();
  const part = await makePart(customer.id);
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, lines: [{ partId: part.id, qty: 10, weight: "25.00" }],
  }));
  return { order, customer };
}

function oneOrderInput(order: OrderDetail) {
  return {
    customerId: order.customerId,
    shipDate: "2026-08-04",
    orders: [{
      orderId: order.id,
      lines: [{
        orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight,
        lineComplete: true,
      }],
      containers: [] as { orderContainerId: string; count: number }[],
      serials: [] as { orderSerialId: string; printOnShipper?: boolean }[],
    }],
  };
}

/** An order shipped complete on every line -> SHIPPED, ready to invoice. */
async function shippedOrder(): Promise<{ order: OrderDetail; customer: Customer }> {
  const { order, customer } = await savedOrder();
  await asSystem(() => createShipper(oneOrderInput(order), { canOverrideCreditHold: false }));
  return { order: await getOrder(order.id), customer };
}

/** A DRAFT invoice for a freshly shipped order, created through the service. */
async function draftInvoice(): Promise<{ invoice: InvoiceDetail; order: OrderDetail; customer: Customer }> {
  const { order, customer } = await shippedOrder();
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  return { invoice, order, customer };
}

/** A DRAFT invoice carrying ONE hand-typed line — no part price is set up anywhere in this file, so
 *  the derived operation always carries `needsPrice`; replacing the lines with a manual charge
 *  clears that without dragging pricing setup into every finalize/unlock/credit test.
 *
 *  This used to replace them with an EMPTY array. #63 now refuses to finalize an invoice with no
 *  lines at all — an emptied invoice finalized into a $0 INVOICED order that could never be
 *  re-billed — so the fixture does what an operator would actually do instead. */
async function finalizableInvoice() {
  const fixture = await draftInvoice();
  const invoice = await asSystem(() => replaceInvoiceLines(fixture.invoice.id, [
    { kind: "CHARGE", description: "Heat treat", amount: "100.00", priceSource: "MANUAL" },
  ]));
  return { ...fixture, invoice };
}

/** A FINALIZED invoice, ready to unlock or credit. */
async function finalizedInvoice() {
  const fixture = await finalizableInvoice();
  const invoice = await asSystem(() => finalizeInvoice(fixture.invoice.id));
  return { ...fixture, invoice };
}

describe("invoice routes", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  // ---------------------------------------------------------------------------------------
  // GET /api/invoices, GET /api/invoices?candidates=1, POST /api/invoices
  // ---------------------------------------------------------------------------------------

  it("GET /api/invoices requires invoicing.view", async () => {
    await draftInvoice();
    expect((await listRoute(getReq("http://t/api/invoices"), noParams)).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "inv-list-wrong");
    expect((await listRoute(getReq("http://t/api/invoices", wrong), noParams)).status).toBe(403);

    const viewer = await signInWith(["invoicing.view"], "inv-list-viewer");
    const res = await listRoute(getReq("http://t/api/invoices", viewer), noParams);
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("INVOICE");
  });

  // #612 PR D (ruling R3): the Invoicing list asks for the window with `?window=1` and is answered
  // an envelope; every other reader of this route (the template editor's invoice picker) keeps the
  // bare, unbounded array, and so do the Excel and the register PDF.
  it("GET /api/invoices?window=1 answers the newest 200 invoices and whether it cut; showAll=1, the bare route and both exports stay unbounded", async () => {
    const customer = await prisma.customer.create({ data: { code: "IWIN", name: "Invoice Window Customer" } });
    const day = new Date("2026-08-04T00:00:00Z");
    await prisma.order.createMany({
      data: Array.from({ length: 201 }, (_, i) => ({
        orderNumber: 900000 + i, customerId: customer.id, status: "SHIPPED" as const, receivedDate: day, requestDate: day,
      })),
    });
    const orders = await prisma.order.findMany({ where: { customerId: customer.id }, select: { id: true, orderNumber: true } });
    await prisma.invoice.createMany({
      data: orders.map((o) => ({
        orderId: o.id, customerId: customer.id,
        invoiceDate: new Date(Date.UTC(2026, 0, 1) + (o.orderNumber - 900000) * 86_400_000),
      })),
    });
    const viewer = await signInWith(["invoicing.view"], "invoice-window-viewer");
    const read = async (query: string) => (await listRoute(getReq(`http://t/api/invoices${query}`, viewer), noParams)).json();

    const windowed = await read("?window=1");
    expect(windowed.cut).toBe(true);
    expect(windowed.rows).toHaveLength(200);
    expect(windowed.rows[0].orderNumber).toBe(900200); // newest invoice date first
    expect(windowed.rows[199].orderNumber).toBe(900001);

    const all = await read("?window=1&showAll=1");
    expect(all).toMatchObject({ cut: false });
    expect(all.rows).toHaveLength(201);

    const narrowed = await read("?window=1&from=2026-01-01&to=2026-01-01");
    expect(narrowed).toMatchObject({ cut: false });
    expect(narrowed.rows.map((r: { orderNumber: number }) => r.orderNumber)).toEqual([900000]);

    const bare = await read("");
    expect(Array.isArray(bare)).toBe(true);
    expect(bare).toHaveLength(201);

    const exported = await exportRoute(getReq("http://t/api/invoices/export", viewer), noParams);
    const sheet = await readXlsx(exported, 1);
    expect(sheet.rows.length).toBeGreaterThanOrEqual(202); // the header and all 201 invoices (and the summary row): exports stay unlimited
    const register = await registerRoute(getReq("http://t/api/invoices/register", viewer), noParams);
    expect(register.status).toBe(200);
  });

  it("GET /api/invoices answers a malformed date with a 400 naming its box", async () => {
    // #591 moved the list's read, and with it `parseDate`, inside a RepeatableRead transaction;
    // the refusal still reaches the caller as the field-anchored 400, not as a failed transaction.
    const viewer = await signInWith(["invoicing.view"], "inv-list-bad-date");
    const res = await listRoute(getReq("http://t/api/invoices?from=notadate", viewer), noParams);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '"notadate" is not a valid date (yyyy-mm-dd) for Invoice date from' });
  });

  it("GET /api/invoices?candidates=1 requires invoicing.view", async () => {
    const { order } = await shippedOrder(); // not yet invoiced -> a candidate

    expect((await listRoute(getReq("http://t/api/invoices?candidates=1"), noParams)).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "inv-cand-wrong");
    expect((await listRoute(getReq("http://t/api/invoices?candidates=1", wrong), noParams)).status).toBe(403);

    const viewer = await signInWith(["invoicing.view"], "inv-cand-viewer");
    const res = await listRoute(getReq("http://t/api/invoices?candidates=1", viewer), noParams);
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows.map((r: { orderNumber: number }) => r.orderNumber)).toEqual([order.orderNumber]);
  });

  it("POST /api/invoices requires invoicing.create", async () => {
    const { order } = await shippedOrder();

    expect((await createRoute(bodyReq("http://t/api/invoices", "POST", undefined, { orderId: order.id }), noParams)).status).toBe(401);

    const wrong = await signInWith(["invoicing.view"], "inv-create-wrong");
    expect((await createRoute(bodyReq("http://t/api/invoices", "POST", wrong, { orderId: order.id }), noParams)).status).toBe(403);

    const creator = await signInWith(["invoicing.create"], "inv-create-ok");
    const res = await createRoute(bodyReq("http://t/api/invoices", "POST", creator, { orderId: order.id }), noParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.invoice.orderId).toBe(order.id);
    expect(body.deduped).toBe(false);
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  // ---------------------------------------------------------------------------------------
  // GET/PATCH/DELETE /api/invoices/[id]
  // ---------------------------------------------------------------------------------------

  it("GET /api/invoices/[id] requires invoicing.view", async () => {
    const { invoice } = await draftInvoice();

    expect((await getRoute(getReq("http://t/api/invoices/x"), withParams({ id: invoice.id }))).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "inv-get-wrong");
    expect((await getRoute(getReq("http://t/api/invoices/x", wrong), withParams({ id: invoice.id }))).status).toBe(403);

    const viewer = await signInWith(["invoicing.view"], "inv-get-viewer");
    const res = await getRoute(getReq("http://t/api/invoices/x", viewer), withParams({ id: invoice.id }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.invoice.id).toBe(invoice.id);
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  // #587 (ruling 587-9): the step suggestions an operation line's description box offers are
  // visible to anyone with invoicing view.
  it("GET /api/invoices/[id]/step-suggestions requires invoicing.view (#587)", async () => {
    const { invoice, order } = await draftInvoice();
    const url = "http://t/api/invoices/x/step-suggestions";

    expect((await stepSuggestionsRoute(getReq(url), withParams({ id: invoice.id }))).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "inv-steps-wrong");
    expect((await stepSuggestionsRoute(getReq(url, wrong), withParams({ id: invoice.id }))).status).toBe(403);

    const viewer = await signInWith(["invoicing.view"], "inv-steps-viewer");
    const res = await stepSuggestionsRoute(getReq(url, viewer), withParams({ id: invoice.id }));
    expect(res.status).toBe(200);
    // `giveSteps` gives the lead part one step, under its own `IRHT-` code named "Austenitize".
    const code = await prisma.processStepCode.findFirstOrThrow({ where: { code: { startsWith: "IRHT-" } } });
    const step = { id: code.id, code: code.code, name: "Austenitize" };
    expect(await res.json()).toEqual({ byOrderLine: { [order.lines[0].id]: [step] }, others: [step] });
  });

  it("PATCH /api/invoices/[id] requires invoicing.edit (header-only, no change_prices needed)", async () => {
    const { invoice } = await draftInvoice();
    const patch = { poNumber: "PO-ROUTE-1" };

    expect((await patchRoute(bodyReq("http://t/api/invoices/x", "PATCH", undefined, patch), withParams({ id: invoice.id }))).status).toBe(401);

    const wrong = await signInWith(["invoicing.view"], "inv-patch-wrong");
    expect((await patchRoute(bodyReq("http://t/api/invoices/x", "PATCH", wrong, patch), withParams({ id: invoice.id }))).status).toBe(403);

    // Holding invoicing.edit but explicitly NOT change_prices still succeeds — a header PATCH
    // does not change money, so it must not require change_prices (task-16-brief.md's binding
    // requirement: "A header-only updateInvoice ... does not change money and takes
    // invoicing.edit alone").
    const editor = await signInWith(["invoicing.edit"], "inv-patch-ok");
    const res = await patchRoute(bodyReq("http://t/api/invoices/x", "PATCH", editor, patch), withParams({ id: invoice.id }));
    expect(res.status).toBe(200);
    expect((await res.json()).invoice.poNumber).toBe("PO-ROUTE-1");
  });

  it("DELETE /api/invoices/[id] requires invoicing.delete and a reason", async () => {
    const { invoice } = await draftInvoice();

    expect((await deleteRoute(noBodyReq("http://t/api/invoices/x", "DELETE"), withParams({ id: invoice.id }))).status).toBe(401);

    const wrong = await signInWith(["invoicing.edit"], "inv-del-wrong");
    expect((await deleteRoute(
      bodyReq("http://t/api/invoices/x", "DELETE", wrong, { reason: "test" }), withParams({ id: invoice.id }),
    )).status).toBe(403);

    const deleter = await signInWith(["invoicing.delete"], "inv-del-ok");
    const noReason = await deleteRoute(noBodyReq("http://t/api/invoices/x", "DELETE", deleter), withParams({ id: invoice.id }));
    expect(noReason.status).toBe(400);
    expect((await noReason.json()).error).toMatch(/reason/i);

    const ok = await deleteRoute(
      bodyReq("http://t/api/invoices/x", "DELETE", deleter, { reason: "discarding for test" }), withParams({ id: invoice.id }),
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()).ok).toBe(true);
  });

  // ---------------------------------------------------------------------------------------
  // PUT /api/invoices/[id]/lines — the primary discrimination proof: invoicing.edit alone
  // refuses; adding change_prices passes. Also proves the mirror case (change_prices alone,
  // without invoicing.edit, also refuses), so BOTH halves of the AND are load-bearing.
  // ---------------------------------------------------------------------------------------

  it("PUT /api/invoices/[id]/lines requires invoicing.edit AND change_prices", async () => {
    const { invoice } = await draftInvoice();
    const body: unknown[] = [];

    expect((await linesRoute(bodyReq("http://t/api/invoices/x/lines", "PUT", undefined, body), withParams({ id: invoice.id }))).status).toBe(401);

    // Neither permission at all.
    const neither = await signInWith(["orders.view"], "inv-lines-neither");
    expect((await linesRoute(
      bodyReq("http://t/api/invoices/x/lines", "PUT", neither, body), withParams({ id: invoice.id }),
    )).status).toBe(403);

    // DISCRIMINATION PROOF: invoicing.edit alone, no change_prices -> refused. If the route's
    // `mustDo(user, "change_prices")` line were deleted, this assertion would flip 403 -> 200 and
    // the test would fail — that is the point of holding invoicing.edit here rather than nothing.
    const editOnly = await signInWith(["invoicing.edit"], "inv-lines-edit-only");
    const editOnlyRes = await linesRoute(
      bodyReq("http://t/api/invoices/x/lines", "PUT", editOnly, body), withParams({ id: invoice.id }));
    expect(editOnlyRes.status).toBe(403);

    // Mirror: change_prices alone, no invoicing.edit -> also refused (proves mustCan is not
    // bypassed by holding the special action).
    const pricesOnly = await signInWith(["action.change_prices"], "inv-lines-prices-only");
    expect((await linesRoute(
      bodyReq("http://t/api/invoices/x/lines", "PUT", pricesOnly, body), withParams({ id: invoice.id }),
    )).status).toBe(403);

    // Both together -> succeeds. Same subject as `editOnly` plus change_prices, so this is the
    // exact pair the discrimination proof needs: 403 with invoicing.edit only, 200 once
    // change_prices is added.
    const both = await signInWith(["invoicing.edit", "action.change_prices"], "inv-lines-both");
    const res = await linesRoute(bodyReq("http://t/api/invoices/x/lines", "PUT", both, body), withParams({ id: invoice.id }));
    expect(res.status).toBe(200);
    expect((await res.json()).invoice.lines).toEqual([]);
  });

  // ---------------------------------------------------------------------------------------
  // POST /api/invoices/[id]/recalculate — same AND gate.
  // ---------------------------------------------------------------------------------------

  it("POST /api/invoices/[id]/recalculate requires invoicing.edit AND change_prices", async () => {
    const { invoice } = await draftInvoice();

    expect((await recalculateRoute(noBodyReq("http://t/api/invoices/x/recalculate", "POST"), withParams({ id: invoice.id }))).status).toBe(401);

    // DISCRIMINATION PROOF for this route: invoicing.edit only -> 403; add change_prices -> 200.
    const editOnly = await signInWith(["invoicing.edit"], "inv-recalc-edit-only");
    expect((await recalculateRoute(
      noBodyReq("http://t/api/invoices/x/recalculate", "POST", editOnly), withParams({ id: invoice.id }),
    )).status).toBe(403);

    const pricesOnly = await signInWith(["action.change_prices"], "inv-recalc-prices-only");
    expect((await recalculateRoute(
      noBodyReq("http://t/api/invoices/x/recalculate", "POST", pricesOnly), withParams({ id: invoice.id }),
    )).status).toBe(403);

    const both = await signInWith(["invoicing.edit", "action.change_prices"], "inv-recalc-both");
    const res = await recalculateRoute(noBodyReq("http://t/api/invoices/x/recalculate", "POST", both), withParams({ id: invoice.id }));
    expect(res.status).toBe(200);
    expect((await res.json()).invoice.id).toBe(invoice.id);
  });

  // ---------------------------------------------------------------------------------------
  // POST /api/invoices/[id]/finalize — lifecycle only, invoicing.edit alone (no change_prices).
  // ---------------------------------------------------------------------------------------

  it("POST /api/invoices/[id]/finalize requires invoicing.edit alone (no change_prices needed)", async () => {
    const { invoice } = await finalizableInvoice();

    expect((await finalizeRoute(noBodyReq("http://t/api/invoices/x/finalize", "POST"), withParams({ id: invoice.id }))).status).toBe(401);

    const wrong = await signInWith(["invoicing.view"], "inv-finalize-wrong");
    expect((await finalizeRoute(
      noBodyReq("http://t/api/invoices/x/finalize", "POST", wrong), withParams({ id: invoice.id }),
    )).status).toBe(403);

    // invoicing.edit WITHOUT change_prices still succeeds — finalize freezes the current lines
    // and re-prices nothing, so it is lifecycle, not money (unlike lines/recalculate/credit).
    const editor = await signInWith(["invoicing.edit"], "inv-finalize-ok");
    const res = await finalizeRoute(noBodyReq("http://t/api/invoices/x/finalize", "POST", editor), withParams({ id: invoice.id }));
    expect(res.status).toBe(200);
    expect((await res.json()).invoice.status).toBe("FINALIZED");
  });

  // #587 (ruling 587-13): a typed price on an operation line with no step picked is refused at
  // Finalize, a 400 naming the line. Its own typed OPERATION fixture: no part is priced in this
  // file, so the derived operation is the tier-3 Needs price line, typed here at $100.
  it("POST /api/invoices/[id]/finalize refuses a typed operation price with no step picked (#587)", async () => {
    const { invoice, order } = await draftInvoice();
    const typed = await asSystem(() => replaceInvoiceLines(invoice.id, invoice.lines.map((l) => ({
      key: l.id, parentKey: l.parentLineId, kind: l.kind, orderLineId: l.orderLineId,
      partNumber: l.partNumber, description: l.description,
      ...(l.kind === "OPERATION" ? { priceSource: "MANUAL" as const, amount: "100.00" } : { amount: l.amount }),
    }))));
    const line = typed.lines.find((l) => l.kind === "OPERATION")!;
    expect([line.position, line.description, line.processStepCodeId, line.needsPrice])
      .toEqual([2, "Needs price", null, false]);

    const editor = await signInWith(["invoicing.edit"], "inv-finalize-unpicked");
    const res = await finalizeRoute(
      noBodyReq("http://t/api/invoices/x/finalize", "POST", editor), withParams({ id: invoice.id }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      `Line 2 · ${line.partNumber} — Needs price is a typed price with no step picked — pick its step `
      + "in the description box, then Save lines and Recalculate before finalizing");
    expect((await asSystem(() => getInvoice(invoice.id))).status).toBe("DRAFT");
    expect((await getOrder(order.id)).status).toBe("SHIPPED");
  });

  // ---------------------------------------------------------------------------------------
  // POST /api/invoices/[id]/unlock — action.unlock_invoice ALONE, the void_shipper shape: no
  // CRUD permission (even the full invoicing set plus change_prices) substitutes for it.
  // ---------------------------------------------------------------------------------------

  it("POST /api/invoices/[id]/unlock requires action.unlock_invoice alone — no CRUD substitute", async () => {
    const { invoice } = await finalizedInvoice();
    const body = { reason: "unlock for test" };

    expect((await unlockRoute(bodyReq("http://t/api/invoices/x/unlock", "POST", undefined, body), withParams({ id: invoice.id }))).status).toBe(401);

    // The FULL invoicing CRUD set plus change_prices — still refused, proving no CRUD grant
    // substitutes for the named action (the table's explicit "void_shipper shape" callout).
    const fullCrud = await signInWith(
      ["invoicing.view", "invoicing.create", "invoicing.edit", "invoicing.delete", "action.change_prices"],
      "inv-unlock-crud",
    );
    expect((await unlockRoute(
      bodyReq("http://t/api/invoices/x/unlock", "POST", fullCrud, body), withParams({ id: invoice.id }),
    )).status).toBe(403);

    // action.unlock_invoice ALONE — no CRUD permission at all — succeeds.
    const unlocker = await signInWith(["action.unlock_invoice"], "inv-unlock-ok");
    const noReason = await unlockRoute(
      noBodyReq("http://t/api/invoices/x/unlock", "POST", unlocker), withParams({ id: invoice.id }));
    expect(noReason.status).toBe(400);
    expect((await noReason.json()).error).toMatch(/reason/i);

    const res = await unlockRoute(bodyReq("http://t/api/invoices/x/unlock", "POST", unlocker, body), withParams({ id: invoice.id }));
    expect(res.status).toBe(200);
    expect((await res.json()).invoice.status).toBe("DRAFT");
  });

  // ---------------------------------------------------------------------------------------
  // POST /api/invoices/[id]/credit — invoicing.create ALONE (§5.6: "Its lifecycle is the
  // invoice's; its permissions are the invoice's" — same shape as POST /api/invoices).
  // ---------------------------------------------------------------------------------------

  it("POST /api/invoices/[id]/credit requires invoicing.create", async () => {
    const { invoice } = await finalizedInvoice();

    expect((await creditRoute(noBodyReq("http://t/api/invoices/x/credit", "POST"), withParams({ id: invoice.id }))).status).toBe(401);

    // DISCRIMINATION PROOF: a subject WITHOUT invoicing.create -> 403, even holding an unrelated
    // permission. Proves the create gate is still enforced.
    const noCreate = await signInWith(["action.change_prices"], "inv-credit-no-create");
    expect((await creditRoute(
      noBodyReq("http://t/api/invoices/x/credit", "POST", noCreate), withParams({ id: invoice.id }),
    )).status).toBe(403);

    // invoicing.create ALONE, no change_prices -> succeeds. A credit's lines are derived (copied
    // from the finalized source with the sign flipped), just like a fresh invoice's are derived
    // from prices — no change_prices needed to raise it.
    const createOnly = await signInWith(["invoicing.create"], "inv-credit-create-only");
    const res = await creditRoute(noBodyReq("http://t/api/invoices/x/credit", "POST", createOnly), withParams({ id: invoice.id }));
    expect(res.status).toBe(200);
    const created = await res.json();
    expect(created.invoice.kind).toBe("CREDIT");
    expect(created.invoice.sourceInvoiceId).toBe(invoice.id);
  });

  // ---------------------------------------------------------------------------------------
  // GET /api/orders/[id]/invoices
  // ---------------------------------------------------------------------------------------

  it("GET /api/orders/[id]/invoices requires invoicing.view", async () => {
    const { invoice, order } = await draftInvoice();

    expect((await ordersInvoicesRoute(getReq("http://t/api/orders/x/invoices"), withParams({ id: order.id }))).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "inv-order-wrong");
    expect((await ordersInvoicesRoute(getReq("http://t/api/orders/x/invoices", wrong), withParams({ id: order.id }))).status).toBe(403);

    const viewer = await signInWith(["invoicing.view"], "inv-order-viewer");
    const res = await ordersInvoicesRoute(getReq("http://t/api/orders/x/invoices", viewer), withParams({ id: order.id }));
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows.map((r: { id: string }) => r.id)).toEqual([invoice.id]);
  });
});
