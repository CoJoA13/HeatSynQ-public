import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, READ_ANSWER_UNREADABLE, UnreadableAnswerError } from "@/lib/fetcher";
import { saveDecision } from "@/lib/entry-save-wait";
import { submitWithConflictRetry } from "@/lib/idempotent-save";
import { prepareOrderPrintIntent } from "@/lib/order-print-intent";
import { runQuoteDelete } from "@/lib/quote-recovery";
import { createOrderAutosaveController, entryContainerBody, type EntryTab } from "../src/app/orders/new/entry-state";
import { blankDraft, blankLine, type OrderDraftState } from "../src/app/orders/new/order-draft";
import { computeLineWeight } from "../src/app/orders/new/OrderLineCard";
import { orderDraftTransport } from "../src/app/orders/new/use-order-autosave";
import { jsxTags, renderedFrom } from "./helpers/jsx-source";
import { callback, source } from "./helpers/lift-callback";
import { all, run } from "./helpers/source-lift";
import { reasonPromptText } from "@/lib/reason-prompt";

// #547 — an answer the app cannot read counts as no answer, and the record pages still tell History.
// Since #547 `api()` rejects a 2xx whose body could not be read with `UnreadableAnswerError`, so a
// page takes its existing no-answer path. Owner ruling 2026-10-18: a 2xx proves the write committed,
// so each record page's `applyMutation` still runs its success seam's invalidations for this error
// kind (History, and the hub's Shipments section), applies nothing, does not read its record
// again, and rethrows. New order does not send its draft again (createOrder has already cleared it), and a
// retried Save dedupes into the order. The eight voids, discards and deletes take their existing
// success branch for this error kind (the owner's answer of 2026-10-18 to the plan's question 4).
// Three surfaces whose words were false say what happened (the answer to question 5): New order's
// load-plan preview, a POST that only reads, shows the read sentence; Back up now shows the error's
// own sentence, not "The backup failed."; and the spreadsheet import shows it with no count and
// reloads its list. The customer page's `call()` (its addresses and contacts) treats this error kind
// as landed (the owner's answer after the whole-branch review): the sentence, History, a reload and
// true. The order-draft autosave's transport resolves a PUT or DELETE whose answer could not be read
// (the answer to question 8), so the autosave reads saved and Discard clears its prompt.
//
// vitest has no DOM, so nothing here renders. Each case lifts production code out of its file's
// syntax tree and runs it closed over the environment given and nothing else: each record page's
// `applyMutation`, the way order-shipments-invalidation.test.ts runs the hub's, New order's
// `handleSave` with its real `buildCreateBody`, the way order-entry-containers.test.tsx runs the
// page's functions, each void, discard and delete handler, the three surfaces' handlers and the
// customer page's `call()`. Each `applyMutation` seam is given the page's readers as recording spies
// (`load`, the hub's `refreshOrder`, `api`, `trackedFetch` and a `fetch` that shadows the global),
// and its cases assert none was called, so a read added to the lost-answer branch fails them even
// when a try/catch swallows what the read does. The voids and `call()` are given a `load`, which
// their success branch calls. The autosave transport's cases are the exception: they call the real
// module over a stubbed `fetch`, the way fetcher.test.ts does, and pin the hook's use of it by its
// text.

const WRITE_SENTENCE = "The change was saved, but the answer could not be read. Reload the page to see it.";

type Seam = {
  name: string;
  path: string;
  /** What the page's success seam tells, in order. Cert's callers tell on a landed save, so its
   *  seam tells nothing then. */
  landedTells: string[];
  /** What a lost answer tells: the success seam's invalidations, cert's included. */
  lostTells: string[];
  /** The page's recovery read, begun before the request (cert has none). */
  recovery: boolean;
  setters: string[];
  /** An answer of the shape this page's mutations return. */
  answer: unknown;
};

const SEAMS: Seam[] = [
  { name: "order hub", path: "app/orders/[id]/page.tsx", landedTells: ["history", "shipments"], lostTells: ["history", "shipments"],
    recovery: true, setters: ["setOrder"], answer: { id: "order-1", travelerPrinted: false, lines: [], loads: [] } },
  { name: "saved shipment", path: "app/shipping/[id]/ShipmentDetail.tsx", landedTells: ["history"], lostTells: ["history"],
    recovery: true, setters: ["setShipper", "setWarnings", "setPrintedOrders", "setShipToAddress"],
    answer: { shipper: { id: "shipper-1" }, warnings: [], printed: [], shipToAddress: null } },
  { name: "invoice", path: "app/invoicing/[id]/InvoiceDetail.tsx", landedTells: ["history"], lostTells: ["history"],
    recovery: true, setters: ["setInvoice", "setWarnings"], answer: { invoice: { id: "invoice-1" }, warnings: [] } },
  { name: "cert", path: "app/certs/[id]/CertDetail.tsx", landedTells: [], lostTells: ["history"],
    recovery: false, setters: ["setCert"], answer: { id: "cert-1", requirements: [] } },
  { name: "receipt batch", path: "app/receivables/batches/[id]/BatchDetail.tsx", landedTells: ["history"], lostTells: ["history"],
    recovery: true, setters: ["setBatch"], answer: { id: "batch-1", payments: [] } },
];

/** The page's own `applyMutation`, closed over a recording environment and nothing else. `log`
 *  holds each invalidation and the accept gate's call, in the order they ran. */
function seam(spec: Seam) {
  const file = source(spec.path);
  const found = all(file, ts.isVariableDeclaration)
    .filter((d) => ts.isIdentifier(d.name) && d.name.text === "applyMutation");
  expect(found, spec.path).toHaveLength(1);
  const wrapped = found[0].initializer;
  if (!wrapped || !ts.isCallExpression(wrapped) || wrapped.expression.getText(file) !== "useCallback") {
    throw new Error(`applyMutation is no longer a useCallback in ${spec.path}`);
  }
  const log: string[] = [];
  const accept = vi.fn(() => { log.push("accept"); return true; });
  const unavailable = vi.fn();
  const acceptRead = vi.fn(async () => true);
  const setters = Object.fromEntries(spec.setters.map((name) => [name, vi.fn()]));
  const editGuard = {
    applyPayload: vi.fn((payload: unknown) => payload),
    capturePayload: vi.fn(() => ({ merge: (_prev: unknown, next: unknown) => next })),
  };
  /** The page's readers. None is called on any path through a seam: the seam reads nothing. */
  const readers = {
    load: vi.fn(async () => {}), refreshOrder: vi.fn(async () => {}),
    api: vi.fn(async () => ({})), trackedFetch: vi.fn(async () => new Response("{}")), fetch: vi.fn(async () => new Response("{}")),
  };
  const environment: Record<string, unknown> = {
    mutations: { next: () => 1, accept },
    ApiError, UnreadableAnswerError, editGuard, ...setters, ...readers,
    // The page's registry of writes in flight, which `applyMutation` registers each dispatch in: the
    // hub's (#550; order-hub-reads.test.ts) and, since #573, the saved shipment's, the invoice's and
    // the cert's (shipment-reads, invoice-reads and cert-reads.test.ts). The receipt batch reads none.
    writes: { dispatched: () => {} },
    invalidateHistory: () => { log.push("history"); },
    invalidateOrderShipments: () => { log.push("shipments"); },
    mergePrinted: vi.fn(),
    // #653: the saved shipment's note of the last adopted Package count (shipment-package-count.test.ts).
    storedPackageCount: { current: null },
  };
  if (spec.recovery) environment.recoverySource = { begin: () => ({ unavailable, accept: acceptRead }) };
  const applyMutation = run<(work: () => Promise<unknown>) => Promise<void>>(wrapped.arguments[0].getText(file), environment);
  const told = () => log.filter((entry) => entry !== "accept");
  /** Nothing past the accept gate ran, and the recovery read was neither refused nor accepted. */
  const appliedNothing = () => {
    expect(accept).not.toHaveBeenCalled();
    for (const name of spec.setters) expect(setters[name], name).not.toHaveBeenCalled();
    expect(editGuard.applyPayload).not.toHaveBeenCalled();
    expect(editGuard.capturePayload).not.toHaveBeenCalled();
    expect(acceptRead).not.toHaveBeenCalled();
  };
  /** No reader was called. */
  const readNothing = () => {
    for (const [name, reader] of Object.entries(readers)) expect(reader, name).not.toHaveBeenCalled();
  };
  return { applyMutation, log, told, accept, unavailable, setters, appliedNothing, readNothing };
}

describe("each record page's applyMutation (#547)", () => {
  describe.each(SEAMS)("$name", (spec) => {
    it("the answer could not be read: tells what a landed write tells, applies nothing, calls none of the page's readers and rethrows", async () => {
      const s = seam(spec);
      const lost = new UnreadableAnswerError(WRITE_SENTENCE, { cause: new SyntaxError("Unexpected end of JSON input") });
      await expect(s.applyMutation(() => Promise.reject(lost))).rejects.toBe(lost);
      expect(s.told()).toEqual(spec.lostTells);
      s.appliedNothing();
      s.readNothing();
      expect(s.unavailable).not.toHaveBeenCalled();
    });

    it("a 5xx tells nothing and its rejection reaches the caller", async () => {
      const s = seam(spec);
      const failure = new ApiError("Request failed (500)", 500);
      await expect(s.applyMutation(() => Promise.reject(failure))).rejects.toBe(failure);
      expect(s.told()).toEqual([]);
      s.appliedNothing();
      s.readNothing();
    });

    it("no response at all tells nothing and its rejection reaches the caller", async () => {
      const s = seam(spec);
      const failure = new TypeError("Failed to fetch");
      await expect(s.applyMutation(() => Promise.reject(failure))).rejects.toBe(failure);
      expect(s.told()).toEqual([]);
      s.appliedNothing();
      s.readNothing();
    });

    if (spec.recovery) it("a 403 still makes the recovery read unavailable, and tells nothing", async () => {
      const s = seam(spec);
      const refusal = new ApiError("Requires permission", 403);
      await expect(s.applyMutation(() => Promise.reject(refusal))).rejects.toBe(refusal);
      expect(s.unavailable).toHaveBeenCalledTimes(1);
      expect(s.told()).toEqual([]);
      s.readNothing();
    });

    it(spec.landedTells.length > 0
      ? "a landed answer tells once, before the accept gate, and is applied"
      : "a landed answer is applied, and the seam tells nothing", async () => {
      const s = seam(spec);
      await s.applyMutation(() => Promise.resolve(spec.answer));
      expect(s.log).toEqual([...spec.landedTells, "accept"]);
      expect(s.accept).toHaveBeenCalledTimes(1);
      expect(s.setters[spec.setters[0]]).toHaveBeenCalledTimes(1);
      s.readNothing();
    });
  });
});

// ---- New order's Save ----

/** The owner's sentence for New order (amendment 2 of the #547 plan), typed out: a changed word
 *  fails this suite. */
const NEW_ORDER_SENTENCE = "The order was saved, but the answer could not be read. Click Save only again to open it. Its travelers"
  + " will not print automatically, and save warnings were not shown: check the customer's credit hold on the customer page"
  + " and the order's Serials.";
const PAGE = "app/orders/new/page.tsx";
/** The draft's own nonce, which every create body built from it carries. */
const REQUEST_ID = "3f2b8c1e-5d4a-4e6b-9c7d-0a1b2c3d4e5f";

/** The page's own `handleSave`, closed over spies and the real leaves it calls, and its real
 *  `buildCreateBody` over a draft whose nonce is known, on the tab `activeTab` names. Nothing of the
 *  page's module is in reach. */
function newOrderSave(activeTab: EntryTab = "parts") {
  const draft: OrderDraftState = { ...blankDraft(), clientRequestId: REQUEST_ID, customerId: "cust-1",
    lines: [{ ...blankLine(), id: "line-1", partId: "part-1", qty: "30" }] };
  const preview = { loads: [], fingerprint: "f" };
  const buildCreateBody = callback<() => { clientRequestId: string }>(PAGE, "NewOrderPage", "buildCreateBody", {
    draft, adjustmentResult: { adjustment: null }, preview, displayedPo: "", customerParts: [], computeLineWeight,
    containerTypes: [], entryContainerBody,
  });
  const spies = {
    refuse: vi.fn(), setError: vi.fn(), setSaving: vi.fn(), setSavedOrder: vi.fn(), setRefreshPlan: vi.fn(),
    reveal: vi.fn(), openSavedOrder: vi.fn(), saveSucceeded: vi.fn(), saveFailed: vi.fn(),
    submitOnce: vi.fn<(body: { clientRequestId: string }) => Promise<unknown>>(),
  };
  const serverProblem = vi.fn((message: string) => ({ message, tab: "process", fieldId: "entry-refresh-plan" }));
  const handleSave = callback<(print?: boolean) => Promise<void>>(PAGE, "NewOrderPage", "handleSave", {
    validate: () => [], saving: false, saveGate: { disabled: false }, savePrintGate: { disabled: false }, printProblem: null,
    // R12 (#662): the wait leaf and the pending-save state handleSave consults; the plan is ready here.
    saveDecision, planAvailability: "ready", previewIdentity: {}, pendingSave: null, setPendingSave: vi.fn(),
    sentFor: { current: null }, setRushPlan: vi.fn(),
    beginSave: () => Promise.resolve(), buildCreateBody, submitWithConflictRetry, prepareOrderPrintIntent,
    preview, selection: { mode: "all" }, ApiError, UnreadableAnswerError, serverProblem, activeTab, ...spies,
  });
  return { handleSave, serverProblem, ...spies };
}
const lostCreate = () => new UnreadableAnswerError(WRITE_SENTENCE, { cause: new SyntaxError("Unexpected end of JSON input") });

describe("New order's Save (#547)", () => {
  // The tab the cursor goes to is the one the operator is on: Save sits in the header on every tab.
  it.each([["Save", false, "parts"], ["Save & Print", true, "parts"], ["Save on Order details", false, "details"],
    ["Save & Print on Process & loads", true, "process"]] as const)(
    "%s whose answer could not be read freezes the draft as a landed save does, shows the owner's sentence and takes the cursor to Save",
    async (_label, print, activeTab) => {
      const s = newOrderSave(activeTab);
      s.submitOnce.mockRejectedValueOnce(lostCreate());
      await s.handleSave(print);
      expect(s.submitOnce).toHaveBeenCalledTimes(1);
      expect(s.saveSucceeded).toHaveBeenCalledTimes(1);
      expect(s.saveFailed).not.toHaveBeenCalled();
      expect(s.reveal.mock.calls).toEqual([[{ message: NEW_ORDER_SENTENCE, tab: activeTab, fieldId: "entry-save", fieldIds: [] }]]);
      expect(s.refuse).not.toHaveBeenCalled();
      expect(s.serverProblem).not.toHaveBeenCalled();
      expect(s.openSavedOrder).not.toHaveBeenCalled();
      expect(s.setSavedOrder).not.toHaveBeenCalled();
      expect(s.setRefreshPlan).not.toHaveBeenCalled();
      expect(s.setSaving).toHaveBeenLastCalledWith(false);
    });

  // A regression pin: on 6e42469 the retried Save already dedupes, so this cannot fail first.
  it("the retried Save sends the draft's own nonce again, and the deduped answer opens the order without printing", async () => {
    const s = newOrderSave();
    s.submitOnce.mockRejectedValueOnce(lostCreate())
      .mockResolvedValueOnce({ order: { id: "o1", orderNumber: 7, loads: [] }, warnings: [], deduped: true });
    await s.handleSave(true);
    await s.handleSave(true);
    expect(s.submitOnce.mock.calls.map(([body]) => body.clientRequestId)).toEqual([REQUEST_ID, REQUEST_ID]);
    expect(s.openSavedOrder.mock.calls).toEqual([["o1", false, null]]);
    expect(s.setSavedOrder).not.toHaveBeenCalled();
  });

  it("no response at all still re-arms the autosave and is refused through serverProblem, as before", async () => {
    const s = newOrderSave();
    s.submitOnce.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await s.handleSave();
    expect(s.saveFailed).toHaveBeenCalledTimes(1);
    expect(s.saveSucceeded).not.toHaveBeenCalled();
    expect(s.refuse.mock.calls).toEqual([[[{ message: "Failed to fetch", tab: "process", fieldId: "entry-refresh-plan" }]]]);
    expect(s.reveal).not.toHaveBeenCalled();
    expect(s.setSaving).toHaveBeenLastCalledWith(false);
  });

  it("a 412 still re-arms the autosave, refreshes the plan and asks for review, as before", async () => {
    const s = newOrderSave();
    const stale = "The load plan changed since it was previewed.";
    s.submitOnce.mockRejectedValueOnce(new ApiError(stale, 412));
    await s.handleSave();
    expect(s.saveFailed).toHaveBeenCalledTimes(1);
    expect(s.saveSucceeded).not.toHaveBeenCalled();
    expect(s.setRefreshPlan).toHaveBeenCalledTimes(1);
    expect(s.refuse.mock.calls).toEqual([[[{
      message: `${stale} Review the refreshed process and load plan, then click Save only again.`, tab: "process", fieldId: "entry-refresh-plan",
    }]]]);
    expect(s.serverProblem).not.toHaveBeenCalled();
    expect(s.reveal).not.toHaveBeenCalled();
  });

  it("the Save button carries the id the lost answer's cursor goes to, and nothing else on the page does", () => {
    const tags = jsxTags(`src/${PAGE}`);
    expect(tags.filter((tag) => tag.attr("id") === "entry-save").map((tag) => [tag.name, tag.attr("onClick")]))
      .toEqual([["button", "() => void handleSave()"]]);
  });
});

// ---- Voids, discards and deletes ----
//
// Each one's DELETE answers `{ ok: true }`, not a fresh record, so a lost answer loses nothing the
// page would have applied. Owner's answer of 2026-10-18 (the plan's question 4, option (a)): on this
// error kind each handler takes its existing success branch. A void or discard tells History, clears
// the error and reads its page again, with its own "… voided, but the page could not be refreshed"
// words if that read fails; a part or customer delete goes on to its list; a quote delete retires
// the quote's drafts and goes on to the quote list, through `runQuoteDelete`. Any other failure
// still shows its message and stops, as before.

const lostWrite = () => new UnreadableAnswerError(WRITE_SENTENCE, { cause: new SyntaxError("Unexpected end of JSON input") });
const REASON = "Entered twice";
/** Failures that are not this error kind, each still shown and the handler stopped. */
const NOT_LOST: [string, () => Error][] = [
  ["no response at all", () => new TypeError("Failed to fetch")],
  ["a 5xx", () => new ApiError("Request failed (500)", 500)],
];

type Void = {
  name: string; path: string; owner: string; handler: string;
  /** The loaded record the handler's prompt names, and anything else the prompt reads. */
  record: Record<string, unknown>;
  /** How the handler's own refresh-failure sentence begins. */
  landed: string;
};

const VOIDS: Void[] = [
  { name: "order hub void", path: "app/orders/[id]/page.tsx", owner: "OrderHub", handler: "voidAction",
    record: { order: { orderNumber: 7 } }, landed: "Order voided" },
  { name: "saved shipment void", path: "app/shipping/[id]/ShipmentDetail.tsx", owner: "ShipmentDetail", handler: "voidAction",
    record: { shipper: { shipperNumber: 12 } }, landed: "Shipment voided" },
  { name: "receipt batch void", path: "app/receivables/batches/[id]/BatchDetail.tsx", owner: "BatchDetail", handler: "voidBatchAction",
    record: { batch: { batchNumber: 3 } }, landed: "Batch voided" },
  { name: "cert void", path: "app/certs/[id]/CertDetail.tsx", owner: "CertDetail", handler: "voidAction",
    record: { cert: { id: "cert-1" }, certLabel: () => "#7 lead" }, landed: "Certification voided" },
  { name: "invoice discard", path: "app/invoicing/[id]/InvoiceDetail.tsx", owner: "InvoiceDetail", handler: "discard",
    record: { invoice: { kind: "INVOICE", documentNumber: "INV-1001" }, INVOICE_KIND_LABELS: { INVOICE: "Invoice" } },
    landed: "Invoice discarded" },
];

/** The page's own handler, closed over its record, a DELETE that settles as `answer` does and a
 *  `load` that rejects with `loadFails` when it is given. `log` holds History's tell, each
 *  `setError` and the load, in the order they ran. */
function voidHandler(spec: Void, answer: () => Promise<unknown>, loadFails?: Error, ask: () => string | null = () => REASON) {
  const log: string[] = [];
  const api = vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>(() => answer());
  const handler = callback<() => Promise<void>>(spec.path, spec.owner, spec.handler, {
    ...spec.record, id: "record-1", prompt: () => REASON, reasonPromptText, api, ApiError, UnreadableAnswerError,
    // The hub (PR 2), the cert (PR 5), the invoice (PR 6) and the receipt batch (PR 7) ask through the modal (`askReason`); the others still through `prompt()`.
    // The batch's blank sentence is pinned by tests/receivables-shape.test.ts; the hub's below.
    askReason: async () => ask(), setError: (message: string | null) => { log.push(`error: ${message}`); },
    invalidateHistory: () => { log.push("history"); },
    load: async () => { log.push("load"); if (loadFails) throw loadFails; },
  });
  return { handler, api, log };
}

describe("the order hub's Void asks through the modal (PR 2)", () => {
  const hub = VOIDS[0];
  it("a cancelled dialog voids nothing and says nothing", async () => {
    const v = voidHandler(hub, () => Promise.resolve({ ok: true }), undefined, () => null);
    await v.handler();
    expect(v.api).not.toHaveBeenCalled();
    expect(v.log).toEqual([]);
  });
  it("a typed reason voids, through the DELETE with that reason", async () => {
    const v = voidHandler(hub, () => Promise.resolve({ ok: true }));
    await v.handler();
    expect(v.api.mock.calls[0][1]).toMatchObject({ method: "DELETE", body: JSON.stringify({ reason: REASON }) });
  });
  it("the lifted source asks askReason with the owner's blank sentence, never prompt()", () => {
    const src = readFileSync(new URL("../src/app/orders/[id]/page.tsx", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("async function voidAction("), src.indexOf("async function linkAction("));
    expect(body).toContain('blankRefusal: "A reason is required to void an order."');
    expect(body).not.toMatch(/\bprompt\(/);
  });
});

type Delete = { name: string; path: string; owner: string; handler: string; record: Record<string, unknown>; list: string;
  /** A refusal of the kind the handler turns into its blockers panel. */
  refusal: string };

const DELETES: Delete[] = [
  { name: "part delete", path: "app/parts/[id]/page.tsx", owner: "PartDetail", handler: "removePart",
    record: { part: { customerCode: "ACME", partNumber: "P-10" } }, list: "/parts",
    refusal: "This part is on 2 live order(s)." },
  { name: "customer delete", path: "app/customers/[id]/page.tsx", owner: "CustomerDetail", handler: "removeCustomer",
    record: { c: { code: "ACME", name: "Example Company" } }, list: "/customers",
    refusal: "This customer still has 2 live order(s)." },
];

/** The page's own handler, closed over its record and a DELETE that settles as `answer` does (the
 *  blockers read after a refusal gets `blockers`). `log` holds each `setError` and the navigation. */
function deleteHandler(spec: Delete, answer: () => Promise<unknown>, blockers: unknown[] = []) {
  const log: string[] = [];
  const api = vi.fn((_url: string, init?: RequestInit) => init?.method === "DELETE" ? answer() : Promise.resolve(blockers));
  const setBlocked = vi.fn();
  const handler = callback<() => Promise<void>>(spec.path, spec.owner, spec.handler, {
    ...spec.record, id: "record-1", prompt: () => REASON, reasonPromptText, api, ApiError, UnreadableAnswerError, setBlocked,
    // The customer page (PR 8) and the part page (PR 9) ask through the modal (`askReason`).
    askReason: async () => REASON,
    setError: (message: string | null) => { log.push(`error: ${message}`); },
    router: { push: (href: string) => { log.push(`push ${href}`); } },
  });
  return { handler, api, log, setBlocked };
}

describe("voids, discards and deletes take their success branch when the answer could not be read (#547)", () => {
  describe.each(VOIDS)("$name", (spec) => {
    it("the answer could not be read: History is told, the error is cleared and the page reads itself again", async () => {
      const v = voidHandler(spec, () => Promise.reject(lostWrite()));
      await v.handler();
      expect(v.api).toHaveBeenCalledTimes(1);
      expect(v.api.mock.calls[0][1]).toMatchObject({ method: "DELETE", body: JSON.stringify({ reason: REASON }) });
      expect(v.log).toEqual(["history", "error: null", "load"]);
    });

    it("the answer could not be read and the read after it failed: the handler's own words say it landed", async () => {
      const v = voidHandler(spec, () => Promise.reject(lostWrite()), new TypeError("Failed to fetch"));
      await v.handler();
      expect(v.log).toEqual(["history", "error: null", "load",
        `error: ${spec.landed}, but the page could not be refreshed — reload to see the current state. (Failed to fetch)`]);
    });

    // A regression pin: the path a lost answer now joins, unchanged.
    it("a landed answer takes the same path", async () => {
      const v = voidHandler(spec, () => Promise.resolve({ ok: true }));
      await v.handler();
      expect(v.log).toEqual(["history", "error: null", "load"]);
    });

    it.each(NOT_LOST)("%s still shows its message and stops: nothing is told and nothing is read", async (_label, failure) => {
      const error = failure();
      const v = voidHandler(spec, () => Promise.reject(error));
      await v.handler();
      expect(v.log).toEqual([`error: ${error.message}`]);
    });
  });

  describe.each(DELETES)("$name", (spec) => {
    it("the answer could not be read: the page goes on to the list, as after a landed delete, and reads nothing", async () => {
      const d = deleteHandler(spec, () => Promise.reject(lostWrite()));
      await d.handler();
      expect(d.api).toHaveBeenCalledTimes(1);
      expect(d.api.mock.calls[0][1]).toMatchObject({ method: "DELETE", body: JSON.stringify({ reason: REASON }) });
      expect(d.log).toEqual([`push ${spec.list}`]);
      expect(d.setBlocked).not.toHaveBeenCalled();
    });

    // A regression pin: the path a lost answer now joins, unchanged.
    it("a landed answer goes on to the list", async () => {
      const d = deleteHandler(spec, () => Promise.resolve({ ok: true }));
      await d.handler();
      expect(d.log).toEqual([`push ${spec.list}`]);
    });

    it.each(NOT_LOST)("%s still shows its message and stays on the page", async (_label, failure) => {
      const error = failure();
      const d = deleteHandler(spec, () => Promise.reject(error));
      await d.handler();
      expect(d.log).toEqual([`error: ${error.message}`]);
      expect(d.api).toHaveBeenCalledTimes(1);
    });

    it("a refusal naming what uses the record still opens the blockers panel and stays on the page", async () => {
      const blocker = { entityLabel: "Order", name: "#201", id: "order-1", href: "/orders/order-1" };
      const d = deleteHandler(spec, () => Promise.reject(new ApiError(spec.refusal, 400)), [blocker]);
      await d.handler();
      expect(d.api).toHaveBeenCalledTimes(2);
      expect(d.setBlocked.mock.calls).toEqual([[{ list: [blocker] }]]);
      expect(d.log).toEqual(["error: null"]);
    });
  });

  describe("quote delete, through runQuoteDelete", () => {
    /** `runQuoteDelete` over a DELETE that settles as `answer` does. `log` holds the request, the
     *  drafts' retirement and the page's `deleted`, in order. */
    function quoteDelete(answer: () => Promise<unknown>) {
      const log: string[] = [];
      const go = () => runQuoteDelete({
        retire: () => { log.push("retire"); return true; },
        remove: () => { log.push("remove"); return answer(); },
        deleted: () => { log.push("deleted"); },
      });
      return { go, log };
    }

    it("the answer could not be read: the quote's drafts are retired and the page goes on, as after a landed delete", async () => {
      const q = quoteDelete(() => Promise.reject(lostWrite()));
      await expect(q.go()).resolves.toBeUndefined();
      expect(q.log).toEqual(["remove", "retire", "deleted"]);
    });

    // A regression pin: the path a lost answer now joins, unchanged.
    it("a landed answer takes the same path", async () => {
      const q = quoteDelete(() => Promise.resolve({ ok: true }));
      await q.go();
      expect(q.log).toEqual(["remove", "retire", "deleted"]);
    });

    it.each(NOT_LOST)("%s still reaches the page as its rejection, and nothing is retired", async (_label, failure) => {
      const error = failure();
      const q = quoteDelete(() => Promise.reject(error));
      await expect(q.go()).rejects.toBe(error);
      expect(q.log).toEqual(["remove"]);
    });

    /** The page's `deleteQuote`, lifted, its reason dialog answered by `askReason` (the modal
     *  form since PR 3 of the UX redesign; `reason` is what the dialog resolves). */
    function liftedDeleteQuote(reason: string | null) {
      const log: string[] = [];
      const deleteQuote = callback<() => Promise<void>>("app/quotes/[id]/QuoteDetail.tsx", "QuoteDetail", "deleteQuote", {
        detail: { quoteNumber: 101 }, deleteGate: { disabled: false }, askReason: async () => reason, id: "quote-1",
        getBrowserDraftSession: () => ({ readAuthorizationTicket: () => ({}), isReadAuthorized: () => true }),
        store: {}, binding: { captureRetirement: () => () => { log.push("retire"); return true; } }, mounted: { current: true },
        runQuoteDelete, api: () => { log.push("delete"); return Promise.reject(lostWrite()); }, ApiError,
        router: { push: (href: string) => { log.push(`push ${href}`); } },
        setError: (message: string | null) => { log.push(`error: ${message}`); }, setBlocked: vi.fn(), blockersFrom: () => [],
      });
      return { deleteQuote, log };
    }

    it("the quote page's deleteQuote retires the drafts and goes on to the quote list, and shows nothing", async () => {
      const { deleteQuote, log } = liftedDeleteQuote(REASON);
      await deleteQuote();
      expect(log).toEqual(["delete", "retire", "push /quotes"]);
    });

    it("a cancelled reason dialog deletes nothing (the modal form, PR 3)", async () => {
      const { deleteQuote, log } = liftedDeleteQuote(null);
      await deleteQuote();
      expect(log).toEqual([]);
    });
  });
});

// ---- Surfaces whose words were false ----
//
// Owner's answer of 2026-10-18 to the plan's question 5, parts (a) to (c). Create invoice, Reverse,
// Sign out, Login and Close export keep their words: recorded residuals.

const READ_SENTENCE = "The answer could not be read. Reload the page to try again.";

describe("surfaces that say what an answer they could not read means (#547)", () => {
  describe("New order's load-plan preview", () => {
    /** The preview request's own `.catch` handler, closed over a current ticket and a recording
     *  `setPlanState`. */
    function previewCatch() {
      const file = source(PAGE);
      const found = all(file, ts.isCallExpression).filter((call) => ts.isPropertyAccessExpression(call.expression)
        && call.expression.name.text === "catch" && call.getText(file).includes('"/api/orders/preview"'));
      expect(found).toHaveLength(1);
      const identity = { inputKey: "{}" };
      const setPlanState = vi.fn();
      const handler = run<(reason: unknown) => void>(found[0].arguments[0].getText(file), {
        previewLatest: { isCurrent: () => true }, ticket: 1, previewIdentity: identity, setPlanState,
        UnreadableAnswerError, READ_ANSWER_UNREADABLE,
      });
      return { handler, setPlanState, identity };
    }

    // The preview is a POST, so `api()` words its lost answer as a committed write. Nothing was
    // written: the page shows the read sentence in its place.
    it("an answer that could not be read shows the read sentence, not the write sentence api() gave it", () => {
      const p = previewCatch();
      p.handler(lostWrite());
      expect(p.setPlanState.mock.calls).toEqual([[{ identity: p.identity, preview: null, error: READ_SENTENCE }]]);
    });

    it.each([
      ["no response at all", new TypeError("Failed to fetch"), "Failed to fetch"],
      ["a refusal", new ApiError("Customer not found", 404), "Customer not found"],
      ["a rejection that is not an Error", "gone", "Could not preview the load plan."],
    ])("%s keeps its words, as before", (_label, reason, words) => {
      const p = previewCatch();
      p.handler(reason);
      expect(p.setPlanState.mock.calls).toEqual([[{ identity: p.identity, preview: null, error: words }]]);
    });
  });

  describe("Back up now", () => {
    /** The page's own `backUpNow`, over a POST that settles as `answer` does. `log` holds the
     *  banner's invalidation, the view's read and each `setError`, in order. */
    function backUpNow(answer: () => Promise<unknown>) {
      const log: string[] = [];
      const handler = callback<() => Promise<void>>("app/admin/backups/page.tsx", "BackupsPage", "backUpNow", {
        setRunning: vi.fn(), api: vi.fn(() => answer()), ApiError, UnreadableAnswerError,
        setError: (message: string | null) => { log.push(`error: ${message}`); },
        invalidateBackupBanner: () => { log.push("banner"); },
        load: async () => { log.push("load"); },
      });
      return { handler, log };
    }

    it("an answer that could not be read shows its own sentence after the view is read again, not \"The backup failed.\"", async () => {
      const b = backUpNow(() => Promise.reject(lostWrite()));
      await b.handler();
      expect(b.log).toEqual(["error: null", "banner", "load", `error: ${WRITE_SENTENCE}`]);
    });

    it("no response at all still says \"The backup failed.\"", async () => {
      const b = backUpNow(() => Promise.reject(new TypeError("Failed to fetch")));
      await b.handler();
      expect(b.log).toEqual(["error: null", "banner", "load", "error: The backup failed."]);
    });

    it("a refusal still shows the server's sentence", async () => {
      const b = backUpNow(() => Promise.reject(new ApiError("pg_dump exited with code 1", 500)));
      await b.handler();
      expect(b.log).toEqual(["error: null", "banner", "load", "error: pg_dump exited with code 1"]);
    });

    // A regression pin: a landed backup is unchanged.
    it("a landed backup reads the view again and shows nothing", async () => {
      const b = backUpNow(() => Promise.resolve({ archive: { name: "erp_manual_x.sql.gz" } }));
      await b.handler();
      expect(b.log).toEqual(["error: null", "banner", "load"]);
    });
  });

  describe("the spreadsheet import (PasteGrid)", () => {
    const GRID = "src/components/PasteGrid.tsx";
    /** The grid's own `submit`, over a POST that settles as `answer` does. `log` holds each result
     *  shown and each call of the parent's `onDone`, in order. */
    function submit(answer: () => Promise<unknown>) {
      const log: unknown[] = [];
      const api = vi.fn(() => answer());
      const handler = callback<() => Promise<void>>("components/PasteGrid.tsx", "PasteGrid", "submit", {
        endpoint: "/api/parts/paste", text: "P-10\tGear", api, UnreadableAnswerError, setBusy: vi.fn(),
        setResult: (result: unknown) => { log.push(result); },
        onDone: () => { log.push("onDone"); },
      });
      return { handler, log, api };
    }

    it("an answer that could not be read shows its sentence with no count, and the list reads itself again", async () => {
      const g = submit(() => Promise.reject(lostWrite()));
      await g.handler();
      expect(g.api).toHaveBeenCalledTimes(1);
      expect(g.log).toEqual([{ created: null, errors: [{ row: 0, message: WRITE_SENTENCE }] }, "onDone"]);
    });

    it("no response at all keeps today's result and does not reload the list", async () => {
      const g = submit(() => Promise.reject(new TypeError("Failed to fetch")));
      await g.handler();
      expect(g.log).toEqual([{ created: 0, errors: [{ row: 0, message: "Failed to fetch" }] }]);
    });

    // A regression pin: a landed import is unchanged.
    it("a landed import shows the server's answer and reloads the list", async () => {
      const answer = { created: 2, errors: [{ row: 3, message: "Part number is required" }] };
      const g = submit(() => Promise.resolve(answer));
      await g.handler();
      expect(g.log).toEqual([answer, "onDone"]);
    });

    it("the count is shown only when the result carries one", () => {
      const counts = renderedFrom(GRID, "p").map((text) => text.replace(/\s+/g, " "))
        .filter((text) => text.includes("row(s) created."));
      expect(counts).toEqual(['result.created !== null && <p className="text-success-700">{result.created} row(s) created.</p>']);
    });
  });
});

// The customer page's `call()`, which Add address, Add contact, an address's or contact's Delete,
// and an address's Make default go through. Owner's answer of 2026-10-18, after the whole-branch review:
// an answer that could not be read counts as landed, as the spreadsheet import's does. The write
// sentence shows, History is told, the lists are read again, and `call()` returns true, so an Add
// clears its form. Every other failure keeps its path: false, nothing told and nothing read.
describe("the customer page's call() (#547)", () => {
  /** The page's own `call()`, over a request that settles as `answer` does and a `load` that
   *  rejects with `loadFails` when it is given. A `load` that lands clears the banner, as the
   *  page's does (its apply is `applyDetail(data); setError(null)`), so a sentence set before the
   *  read would be wiped. `log` holds History's tell, each `setError` and the read, in order. */
  function call(answer: () => Promise<unknown>, loadFails?: Error) {
    const log: string[] = [];
    const inFlight = { current: new Set<string>() };
    const api = vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>(() => answer());
    const setError = (message: string | null) => { log.push(`error: ${message}`); };
    const handler = callback<(path: string, init: RequestInit) => Promise<boolean>>(
      "app/customers/[id]/page.tsx", "CustomerDetail", "call", {
        api, ApiError, UnreadableAnswerError, inFlight, setError,
        invalidateHistory: () => { log.push("history"); },
        load: async () => { log.push("load"); if (loadFails) throw loadFails; setError(null); },
      });
    const add = () => handler("/api/customers/c-1/addresses", { method: "POST", body: "{}" });
    return { add, api, log, inFlight };
  }

  it("an answer that could not be read: History is told, the lists are read again, the sentence shows after the read, and true", async () => {
    const c = call(() => Promise.reject(lostWrite()));
    await expect(c.add()).resolves.toBe(true);
    expect(c.api).toHaveBeenCalledTimes(1);
    expect(c.log).toEqual(["history", "error: null", "load", "error: null", `error: ${WRITE_SENTENCE}`]);
    expect(c.inFlight.current.size).toBe(0);
  });

  // The owner's answer names the write sentence and says nothing of a read after it that fails. The
  // sentence already asks for a reload, so it shows either way, as Back up now's does.
  it("an answer that could not be read and a failed read after it: still the sentence, and true", async () => {
    const c = call(() => Promise.reject(lostWrite()), new TypeError("Failed to fetch"));
    await expect(c.add()).resolves.toBe(true);
    expect(c.log).toEqual(["history", "error: null", "load", `error: ${WRITE_SENTENCE}`]);
    expect(c.inFlight.current.size).toBe(0);
  });

  it.each(NOT_LOST)("%s still shows its message and returns false: nothing is told and nothing is read", async (_label, failure) => {
    const error = failure();
    const c = call(() => Promise.reject(error));
    await expect(c.add()).resolves.toBe(false);
    expect(c.log).toEqual([`error: ${error.message}`]);
    expect(c.inFlight.current.size).toBe(0);
  });

  // The landed path a lost answer now joins, pinned unchanged; and the double-click guard, whose
  // case also pins that a lost answer settles true and frees its key (it failed first, before the customer-page change).
  it("a landed answer tells History, reads the lists again, and returns true", async () => {
    const c = call(() => Promise.resolve({ ok: true }));
    await expect(c.add()).resolves.toBe(true);
    expect(c.log).toEqual(["history", "error: null", "load", "error: null"]);
    expect(c.inFlight.current.size).toBe(0);
  });

  it("a landed answer and a failed read after it: the save worked and the screen is stale", async () => {
    const c = call(() => Promise.resolve({ ok: true }), new TypeError("Failed to fetch"));
    await expect(c.add()).resolves.toBe(true);
    expect(c.log).toEqual(["history", "error: null", "load",
      "error: Saved, but the page could not be refreshed — reload to see the current data. (Failed to fetch)"]);
  });

  it("a second click while the first is in flight sends nothing, and the key is free once a lost answer settles", async () => {
    let settle!: (error: Error) => void;
    const c = call(() => new Promise((_resolve, reject) => { settle = reject; }));
    const first = c.add();
    await expect(c.add()).resolves.toBe(false);
    expect(c.api).toHaveBeenCalledTimes(1);
    settle(lostWrite());
    await expect(first).resolves.toBe(true);
    void c.add();
    expect(c.api).toHaveBeenCalledTimes(2);
  });
});

// The order-draft autosave's transport (the owner's answer of 2026-10-18 to the plan's question 8):
// its PUT and DELETE answer only `{ ok: true }`, so a 2xx whose body could not be read stored or
// cleared the draft, and resolves. Anything else still rejects, and the read is unchanged. These
// cases call the real transport over a stubbed `fetch`, the way fetcher.test.ts does, and run the
// real controller over it: the autosave and Discard both go through the transport.
describe("the order-draft autosave's transport (#547)", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  type Method = "GET" | "PUT" | "DELETE";
  /** Stubs `fetch` to answer each method with a fresh `Response` from `answers`. */
  function stubFetch(answers: Partial<Record<Method, () => Response>>) {
    const transport = vi.fn(async (_path: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET") as Method;
      const answer = answers[method];
      if (!answer) throw new Error(`No answer is stubbed for ${method}.`);
      return answer();
    });
    vi.stubGlobal("fetch", transport);
    return transport;
  }
  const cutShort = () => new Response('{"ok":', { status: 200 });
  const landed = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });
  const refused = () => new Response(JSON.stringify({ error: "Database unavailable" }), { status: 500 });

  it("a PUT whose answer could not be read resolves, and sends the draft as it always has", async () => {
    const fetch = stubFetch({ PUT: cutShort });
    const draft = { ...blankDraft(), notes: "typed" };
    await expect(orderDraftTransport().put(draft)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![0]).toBe("/api/order-drafts");
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "PUT", body: JSON.stringify({ payload: draft }) });
  });

  it("a DELETE whose answer could not be read resolves, and sends no body", async () => {
    const fetch = stubFetch({ DELETE: cutShort });
    await expect(orderDraftTransport().clear()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![0]).toBe("/api/order-drafts");
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "DELETE" });
    expect(fetch.mock.calls[0]![1]).not.toHaveProperty("body");
  });

  it.each(["put", "clear"] as const)("%s: a 5xx still rejects as the ApiError it is", async (write) => {
    stubFetch({ PUT: refused, DELETE: refused });
    const transport = orderDraftTransport();
    const error = await (write === "put" ? transport.put(blankDraft()) : transport.clear()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ message: "Database unavailable", status: 500 });
  });

  it.each(["put", "clear"] as const)("%s: no response still rejects with the error fetch gave", async (write) => {
    const offline = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", vi.fn(async () => { throw offline; }));
    const transport = orderDraftTransport();
    await expect(write === "put" ? transport.put(blankDraft()) : transport.clear()).rejects.toBe(offline);
  });

  // A regression pin: a landed write is unchanged.
  it.each(["put", "clear"] as const)("%s: a landed answer resolves", async (write) => {
    stubFetch({ PUT: landed({ ok: true }), DELETE: landed({ ok: true }) });
    const transport = orderDraftTransport();
    await expect(write === "put" ? transport.put(blankDraft()) : transport.clear()).resolves.toEqual({ ok: true });
  });

  it("the draft read is unchanged: an answer it could not read rejects with the read sentence", async () => {
    stubFetch({ GET: cutShort });
    const error = await orderDraftTransport().read().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnreadableAnswerError);
    expect((error as Error).message).toBe(READ_ANSWER_UNREADABLE);
  });

  it("the draft read still answers what it reads", async () => {
    const row = { payload: { notes: "old work" }, updatedAt: "2026-10-18T12:00:00Z" };
    const fetch = stubFetch({ GET: landed(row) });
    await expect(orderDraftTransport().read()).resolves.toEqual(row);
    expect(fetch.mock.calls[0]![0]).toBe("/api/order-drafts");
  });

  it("through the controller, an autosave whose answer could not be read reads saved and acknowledges its generation", async () => {
    vi.useFakeTimers();
    const fetch = stubFetch({ GET: landed(null), PUT: cutShort, DELETE: cutShort });
    const controller = createOrderAutosaveController(blankDraft(), orderDraftTransport());
    await controller.start();
    expect(controller.getSnapshot()).toMatchObject({ draftReady: true, draftPrompt: null, draftPromptError: null });
    controller.setDraft((draft) => ({ ...draft, notes: "typed" }));
    await vi.advanceTimersByTimeAsync(2000);
    await controller.settled();
    expect(controller.getSnapshot().saveState).toEqual({ status: "saved", acknowledgedGeneration: 1 });
    // Typed back to blank, the autosave clears the draft, and that answer is lost too.
    controller.setDraft((draft) => ({ ...draft, notes: "" }));
    await vi.advanceTimersByTimeAsync(2000);
    await controller.settled();
    expect(controller.getSnapshot().saveState).toEqual({ status: "saved", acknowledgedGeneration: 2 });
    expect(fetch.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "PUT", "DELETE"]);
    controller.stop();
  });

  it("through the controller, an autosave refused 5xx still reads as failed", async () => {
    vi.useFakeTimers();
    stubFetch({ GET: landed(null), PUT: refused });
    const controller = createOrderAutosaveController(blankDraft(), orderDraftTransport());
    await controller.start();
    controller.setDraft((draft) => ({ ...draft, notes: "typed" }));
    await vi.advanceTimersByTimeAsync(2000);
    await controller.settled();
    expect(controller.getSnapshot().saveState).toEqual({ status: "error", acknowledgedGeneration: 0,
      message: "Draft autosave failed: Database unavailable" });
    controller.stop();
  });

  it("through the controller, a Discard whose answer could not be read clears the prompt with no error", async () => {
    const row = { payload: { ...blankDraft(), notes: "old work" }, updatedAt: "2026-10-18T12:00:00Z" };
    stubFetch({ GET: landed(row), DELETE: cutShort });
    const controller = createOrderAutosaveController(blankDraft(), orderDraftTransport());
    await controller.start();
    expect(controller.getSnapshot().draftPrompt).toEqual(row);
    await controller.discardDraft();
    expect(controller.getSnapshot()).toMatchObject({ draftReady: true, draftPrompt: null,
      draftPromptError: null, draftPromptBusy: false });
    controller.stop();
  });

  // Nothing here renders the hook, so the page's use of this transport is pinned by its text: the
  // hook builds its one controller over `orderDraftTransport()`.
  it("the page's autosave hook builds its controller over this transport", () => {
    const file = source("app/orders/new/use-order-autosave.ts");
    const calls = all(file, ts.isCallExpression)
      .filter((call) => call.expression.getText(file) === "createOrderAutosaveController");
    // The transport only: the starting draft, the first argument, is not this test's.
    expect(calls.map((call) => call.arguments[1]?.getText(file))).toEqual(["orderDraftTransport()"]);
  });
});
